//! Restore in the shell (spec §6.8): the one restore that may be alive at a time, recovery of a half-done one at
//! launch, and the `.before-restore` folders a swap leaves beside a vault. The engine does the work (`PreparedRestore`,
//! `recover_restore`); this module makes it reachable, keeps the user in charge of each step and keeps a lock's rules
//! (§7.4) around it.
//!
//! **Five steps on one held pick**, none taking a path from the page: `restore_pick` holds the backup (and `Busy` while
//! a restore lives), `restore_check` opens it read-only with the typed password or key and keeps the credential that
//! worked, in Rust, in the pick, `restore_choose_folder` moves the pick's folder, `restore_prepare` copies (a
//! launch-scoped job with progress and a Stop), `restore_commit` swaps (a job with no Stop). A finished restore survives
//! an idle lock and no other lock of all vaults ([`Restores::lock_hook`]).
//!
//! **One state mutex** ([`Restores`]), held only briefly: never across `prepare`, `commit`, a dialog or a session call,
//! and never while calling a [`Sessions`] lock method. A [`PreparedRestore`] is dropped (its staging folder removed,
//! which can take a while) outside it, and a lock's hook drops it on a worker, never on the hook thread.
//!
//! The folder paths in [`RestoreNotice`] and [`Leaves`] are the user's own: they need them to act. They never appear in
//! an error, a log or `Debug`.

use std::ffi::OsStr;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

use lockbox_core::blob::{CancelToken, NoProgress};
use lockbox_core::fsio::{is_destination_taken, remove_dir_all_retry};
use lockbox_core::ids::VaultId;
use lockbox_core::{
    CoreError, Credential, JournalStep, JournalView, PreparedRestore, ReadOnlyVault, Recovery,
    RestoreDestination, dismiss_restore_journal, folder_name, inspect_restore_journal,
    read_vault_id, read_vault_name, recover_restore,
};
use serde::Serialize;
use serde::ser::Serializer;

use crate::commands::backup::{CredentialArg, FILTER, Typed, display_name};
use crate::dates;
use crate::error::{Confirm, Outcome, ShellError, ShellResult, VAULT_NOT_LISTED};
use crate::jobs::JobKind;
use crate::lock;
use crate::os::{same_name, same_path};
use crate::outputs::is_real_folder_in;
use crate::paths::default_vault_parent;
use crate::pending::{PendingChoice, RestorePickUse, Token};
#[cfg(test)]
use crate::session::SessionId;
use crate::session::{
    Location, LockHook, LockReason, Notice, OpenStep, Opened, SessionInfo, Sessions, Tagged,
};
use crate::shell::Shell;

const BUSY_RESTORE: ShellError = ShellError::Busy { what: "restore" };
/// The backup the copy opened is another vault's than the check saw (the file was replaced between them): the answer
/// of the copy, with the pick forgotten.
const BACKUP_CHANGED: ShellError = ShellError::InvalidInput {
    what: "backup changed",
};

/// A healthy copy of the vault is in the folder already, so a restore beside a damaged vault makes no second one (the
/// engine's own refusal of a new folder beside a readable copy; nothing is written, nothing replaced).
const ALREADY_HERE: ShellError = ShellError::InvalidInput {
    what: "vault already here",
};

/// How long a commit waits for the destination's last command to let go of the vault it was closed with.
const RELEASE_WAIT: Duration = if cfg!(test) {
    Duration::from_millis(300)
} else {
    Duration::from_secs(10)
};

/// How many restore IDs a lock ended are remembered, so a late answer to one can say "cancelled".
const REMEMBERED: usize = 32;

/// What `.before-restore` adds to a vault folder's name (spec §6.8), and the numbered copies it can have.
const PRE_RESTORE: &str = ".before-restore";

/// The titles of the two pickers of "Restore a backup": the backup file's, and the folder's.
const RESTORE_PICK_TITLE: &str = "Restore a backup";
const RESTORE_FOLDER_TITLE: &str = "Restore into this folder";

// ---------------------------------------------------------------------------------------------------------------
// What a half-done restore left, as the page is told.
// ---------------------------------------------------------------------------------------------------------------

/// What recovery did, when it found a journal ([`Recovery`] has no `Clone` or `Serialize` of its own).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Recovered {
    /// A restore that had not started swapping: its staging folder and journal are gone.
    StagingRemoved,
    /// An unfinished swap is undone: the old vault is at its place again.
    RolledBack,
    /// The swap had finished except for the clean-up, which is now done.
    Finished,
}

/// The folders a restore journal names, shown to the user as plain text (spec §6.8).
#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct JournalPaths {
    pub step: JournalStep,
    /// The hidden `.restore-<hex>` folder the backup was extracted into.
    pub staging: String,
    /// The folder the restored vault takes.
    pub target: String,
    /// Where the vault that was there went, once the swap had begun.
    pub before_restore: Option<String>,
}

impl JournalPaths {
    fn of(view: &JournalView) -> JournalPaths {
        JournalPaths {
            step: view.step,
            staging: shown(&view.staging),
            target: shown(&view.target),
            before_restore: view.before_restore.as_deref().map(shown),
        }
    }
}

/// Never shows a path (R5).
impl fmt::Debug for JournalPaths {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("JournalPaths")
            .field("step", &self.step)
            .finish_non_exhaustive()
    }
}

/// The vault a settled restore is about, as the vault list has it. The name is the one the lock screen shows.
#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct NoticeVault {
    pub id: u32,
    pub name: String,
}

/// Never shows the name (R5).
impl fmt::Debug for NoticeVault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NoticeVault")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

/// A path as the user knows it: Lockbox spells a drive path `\\?\C:\..`, which Explorer does not.
pub(crate) fn shown(path: &Path) -> String {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(plain) if !plain.starts_with(r"UNC\") => plain.to_owned(),
        _ => text.into_owned(),
    }
}

/// What restore recovery found, at launch and whenever a restore ends in a state the user must hear about. Sent as
/// `lockbox://notice` `{ kind: "restore", state, .. }` (only when it is not `None`) and read again with
/// `restore_notice`.
#[derive(Clone, PartialEq, Eq)]
pub enum RestoreNotice {
    /// No journal, or nothing to tell.
    None,
    /// The restore was settled. `vault`: the vault on the list at the restore's folder once it was, to say which one
    /// (`None` when none is listed there or its name cannot be read).
    Recovered {
        how: Recovered,
        vault: Option<NoticeVault>,
    },
    /// The folder that holds the journal's folders is not there (its drive is not plugged in): nothing was decided.
    /// Reconnect it and try again, or dismiss.
    DriveMissing(JournalPaths),
    /// A rename or the staging removal failed: the journal stays. Try again, or dismiss.
    Pending(JournalPaths),
    /// The disk is in a state the table does not cover, or the journal is damaged: nothing was touched. `journal` is
    /// the journal file; `paths` what it names, when it can be read.
    Unclear {
        journal: String,
        paths: Option<JournalPaths>,
    },
}

impl RestoreNotice {
    /// A settled restore, its vault not named yet.
    fn recovered(how: Recovered) -> RestoreNotice {
        RestoreNotice::Recovered { how, vault: None }
    }
}

impl fmt::Debug for RestoreNotice {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            RestoreNotice::None => "RestoreNotice::None",
            RestoreNotice::Recovered { .. } => "RestoreNotice::Recovered(..)",
            RestoreNotice::DriveMissing(_) => "RestoreNotice::DriveMissing(..)",
            RestoreNotice::Pending(_) => "RestoreNotice::Pending(..)",
            RestoreNotice::Unclear { .. } => "RestoreNotice::Unclear { .. }",
        })
    }
}

/// How a notice reaches the page: one flat object, tagged `state`.
#[derive(Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum NoticeView<'a> {
    None,
    Recovered {
        how: Recovered,
        vault: &'a Option<NoticeVault>,
    },
    DriveMissing {
        paths: &'a JournalPaths,
        /// The folder that holds the restore's folders, as text: what the notice names.
        folder: String,
    },
    Pending {
        paths: &'a JournalPaths,
    },
    Unclear {
        journal: &'a str,
        paths: &'a Option<JournalPaths>,
    },
}

impl Serialize for RestoreNotice {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            RestoreNotice::None => NoticeView::None,
            RestoreNotice::Recovered { how, vault } => NoticeView::Recovered { how: *how, vault },
            RestoreNotice::DriveMissing(paths) => NoticeView::DriveMissing {
                paths,
                folder: parent_shown(&paths.target),
            },
            RestoreNotice::Pending(paths) => NoticeView::Pending { paths },
            RestoreNotice::Unclear { journal, paths } => NoticeView::Unclear { journal, paths },
        }
        .serialize(serializer)
    }
}

/// The folder that holds `target` (a folder as [`shown`] spells it), as text; `target` itself when it has no parent.
fn parent_shown(target: &str) -> String {
    Path::new(target)
        .parent()
        .map_or_else(|| target.to_owned(), shown)
}

/// What dismissing a journal leaves behind (`Confirm::Dismissal`), for the user to act on.
#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct Leaves {
    /// The staging folder, when dismissing does not remove it (its drive is not connected).
    pub staging: Option<String>,
    /// The old vault's folder after a half-done swap: rename it back to the vault's name to keep that vault.
    pub before_restore: Option<String>,
}

impl fmt::Debug for Leaves {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Leaves(..)")
    }
}

impl Leaves {
    fn of(view: &JournalView) -> Leaves {
        Leaves {
            staging: (!view.parent_present).then(|| shown(&view.staging)),
            before_restore: view.before_restore.as_deref().map(shown),
        }
    }

    fn nothing_known() -> Leaves {
        Leaves {
            staging: None,
            before_restore: None,
        }
    }
}

/// The folder the restore journal names as the restored vault's, or `None` when there is no journal or it cannot be read.
/// Like [`recovery_notice`] it creates nothing when there is no journal (not the state folder, not a lock file).
fn journal_target(journal: &Path) -> Option<PathBuf> {
    if matches!(fs::symlink_metadata(journal), Err(e) if e.kind() == io::ErrorKind::NotFound) {
        return None;
    }
    inspect_restore_journal(journal)
        .ok()
        .flatten()
        .map(|view| view.target)
}

/// Runs the engine's recovery on `journal` and says what it found. Never creates the state folder or a lock file when
/// there is no journal.
fn recovery_notice(journal: &Path) -> RestoreNotice {
    // A missing state folder is a missing journal too: nothing to recover, and nothing is made.
    if matches!(fs::symlink_metadata(journal), Err(e) if e.kind() == io::ErrorKind::NotFound) {
        return RestoreNotice::None;
    }
    let paths = || {
        inspect_restore_journal(journal)
            .ok()
            .flatten()
            .map(|view| (JournalPaths::of(&view), view.parent_present))
    };
    match recover_restore(journal) {
        Ok(Recovery::NothingToDo) => RestoreNotice::None,
        // The vault is named by the shell, which has the vault list ([`Shell::recover`]).
        Ok(Recovery::StagingRemoved) => RestoreNotice::recovered(Recovered::StagingRemoved),
        Ok(Recovery::RolledBack) => RestoreNotice::recovered(Recovered::RolledBack),
        Ok(Recovery::Finished) => RestoreNotice::recovered(Recovered::Finished),
        // A rename or the staging removal failed, or the disk would not answer yet (the journal could not be locked or
        // read): the journal stays and trying again may work.
        Err(CoreError::RestorePending | CoreError::Io(_)) => match paths() {
            Some((paths, true)) => RestoreNotice::Pending(paths),
            Some((paths, false)) => RestoreNotice::DriveMissing(paths),
            // The journal went (or cannot be read) since: nothing to tell, or nothing that can be told.
            None => match fs::symlink_metadata(journal) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => RestoreNotice::None,
                _ => RestoreNotice::Unclear {
                    journal: shown(journal),
                    paths: None,
                },
            },
        },
        // The state is unclear, or the journal damaged, too large or too new: nothing was touched.
        Err(_) => RestoreNotice::Unclear {
            journal: shown(journal),
            paths: paths().map(|(paths, _)| paths),
        },
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The one restore alive at a time.
// ---------------------------------------------------------------------------------------------------------------

/// Where the one restore stands. One cancel token for its whole life; a lock ends it as the hook says.
pub enum RestoreState {
    Idle,
    /// Recovery or a dismissal is running: no restore starts meanwhile, and none runs recovery under a live one.
    Recovering,
    /// The backup is being unlocked and extracted: a long operation, a job of the page's with progress and a Stop. `cancel`
    /// is the job's token (the lock hook cancels it, as a Stop and a lock of every vault do). `locked` lists the places
    /// of the sessions a user locked meanwhile, since which one is the destination is known only when `prepare` ends.
    Preparing {
        id: u32,
        cancel: CancelToken,
        locked: Vec<Location>,
    },
    /// Extracted and checked, waiting for the user's yes. Not a long operation (spec §7.4 pauses the idle timer while
    /// one is running): and no idle lock ends it, since it holds no credential and no unlocked vault (its staging folder
    /// is encrypted) and the person must still answer and then unlock; any other lock of all vaults does (Lock all, the
    /// window's close, Windows locking, sleep, closing). `epoch` is the sessions' lock count when it was asked for.
    /// `destination` is the folder it replaces: a lock of any session at that place ends it, whenever that session was
    /// unlocked. `was_open`: a session was open there when it became `Prepared` (and none is known to have been closed
    /// by the restore itself, or by an idle lock, since), so a commit that finds none knows the user locked it, whatever
    /// the hook has done.
    Prepared {
        id: u32,
        prepared: Box<PreparedRestore>,
        destination: Option<Location>,
        was_open: bool,
        epoch: u64,
    },
    /// The swap is being made: a long operation, a job of the page's with no Stop. Once the engine writes `swapping`
    /// nothing cancels it. `cancel` is the job's token. `swapping` is the engine's flag for exactly that point
    /// ([`PreparedRestore::swap_flag`]), the one thing readable while the engine holds the restore.
    Committing {
        id: u32,
        cancel: CancelToken,
        destination: Option<Location>,
        swapping: Arc<AtomicBool>,
    },
}

struct Inner {
    state: RestoreState,
    last_id: u32,
    /// The restore IDs a lock ended, most recent last.
    lock_ended: Vec<u32>,
}

impl Inner {
    fn note_ended(&mut self, id: u32) {
        self.lock_ended.push(id);
        if self.lock_ended.len() > REMEMBERED {
            self.lock_ended.remove(0);
        }
    }

    /// The refusal for a restore `id` that is not the prepared one.
    fn not_prepared(&self, id: u32) -> ShellError {
        match &self.state {
            RestoreState::Preparing { id: ours, .. }
            | RestoreState::Committing { id: ours, .. }
                if *ours == id =>
            {
                BUSY_RESTORE
            }
            _ if self.lock_ended.contains(&id) => ShellError::Cancelled,
            _ => ShellError::NotFound,
        }
    }
}

/// A listed pre-restore folder.
struct Listed {
    id: u32,
    /// The registry ID of the vault it belongs to.
    vault: u32,
    folder: PathBuf,
}

#[derive(Default)]
struct PreRestoreList {
    last_id: u32,
    listed: Vec<Listed>,
}

/// The restore state of the shell.
pub struct Restores {
    inner: Mutex<Inner>,
    /// What recovery last found ([`Shell::restore_notice`]).
    notice: Mutex<RestoreNotice>,
    pre_restore: Mutex<PreRestoreList>,
    /// Workers dropping a [`PreparedRestore`] for a lock's hook, and their end ([`wait_idle`](Self::wait_idle)).
    workers: Mutex<usize>,
    idle: Condvar,
    /// Tests only: how many times [`Shell::recover`] has run.
    recoveries: AtomicUsize,
    #[cfg(test)]
    test_hook: Mutex<Option<TestHook>>,
}

/// A cleanup worker, counted from before its thread runs until dropped: after its work, or unrun when its thread
/// could not start.
struct WorkerDone(Arc<Restores>);

impl Drop for WorkerDone {
    fn drop(&mut self) {
        *lock(&self.0.workers) -= 1;
        self.0.idle.notify_all();
    }
}

/// The restore taken by a command, put back to `Idle` when dropped (also after a panic or an early return), unless
/// the command settled the state itself.
struct Claim<'a> {
    restores: &'a Restores,
    /// `0`: a recovery claim.
    id: u32,
    live: bool,
}

impl Claim<'_> {
    /// The state was settled by the command.
    fn settled(&mut self) {
        self.live = false;
    }
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        if !self.live {
            return;
        }
        let mut inner = lock(&self.restores.inner);
        let ours = match &inner.state {
            RestoreState::Preparing { id, .. } => *id == self.id,
            RestoreState::Recovering => self.id == 0,
            _ => false,
        };
        if ours {
            inner.state = RestoreState::Idle;
        }
    }
}

impl Default for Restores {
    fn default() -> Self {
        Restores::new()
    }
}

impl Restores {
    pub fn new() -> Restores {
        Restores {
            inner: Mutex::new(Inner {
                state: RestoreState::Idle,
                last_id: 0,
                lock_ended: Vec::new(),
            }),
            notice: Mutex::new(RestoreNotice::None),
            pre_restore: Mutex::default(),
            workers: Mutex::default(),
            idle: Condvar::new(),
            recoveries: AtomicUsize::new(0),
            #[cfg(test)]
            test_hook: Mutex::default(),
        }
    }

    /// Takes the restore for recovery or a dismissal: `Busy` unless nothing is alive. Checked and held in one step.
    fn claim_recovery(&self) -> ShellResult<Claim<'_>> {
        let mut inner = lock(&self.inner);
        if !matches!(inner.state, RestoreState::Idle) {
            return Err(BUSY_RESTORE);
        }
        inner.state = RestoreState::Recovering;
        Ok(Claim {
            restores: self,
            id: 0,
            live: true,
        })
    }

    /// Takes the restore for a new one: `Busy` unless nothing is alive. Its ID comes with the claim. The token the state
    /// holds is a placeholder until the job begins ([`adopt`](Self::adopt)).
    fn claim_preparing(&self) -> ShellResult<(u32, Claim<'_>)> {
        let mut inner = lock(&self.inner);
        if !matches!(inner.state, RestoreState::Idle) {
            return Err(BUSY_RESTORE);
        }
        inner.last_id += 1;
        let id = inner.last_id;
        inner.state = RestoreState::Preparing {
            id,
            cancel: CancelToken::new(),
            locked: Vec::new(),
        };
        Ok((
            id,
            Claim {
                restores: self,
                id,
                live: true,
            },
        ))
    }

    /// The job of the restore `id` has begun (its copy, or its swap): its token takes the placeholder's place in the
    /// state, so the lock hook and the page's Stop reach the one token. A lock that cancelled the placeholder before this
    /// (the hook runs under the same mutex) cancels the job's token now.
    fn adopt(&self, id: u32, job: &CancelToken) {
        let mut inner = lock(&self.inner);
        let cancel = match &mut inner.state {
            RestoreState::Preparing {
                id: ours, cancel, ..
            }
            | RestoreState::Committing {
                id: ours, cancel, ..
            } if *ours == id => cancel,
            _ => return,
        };
        if cancel.is_cancelled() {
            job.cancel();
        }
        *cancel = job.clone();
    }

    /// Whether nothing is alive.
    fn is_idle(&self) -> bool {
        matches!(lock(&self.inner).state, RestoreState::Idle)
    }

    /// Whether a restore is committing and past the point of cancelling: the engine has written `swapping`, so a close
    /// or Quit now leaves a swap that finishes, or is undone by recovery at the next launch, whatever is asked. Never
    /// true while a restore waits for its yes, prepares, or has ended.
    pub fn past_swap(&self) -> bool {
        match &lock(&self.inner).state {
            RestoreState::Committing { swapping, .. } => swapping.load(Ordering::SeqCst),
            _ => false,
        }
    }

    /// The prepared restore `id`, taken out of the state, which becomes `Committing`. `NotFound`, `Cancelled` or `Busy`
    /// as [`Inner::not_prepared`] says.
    fn begin_commit(&self, id: u32) -> ShellResult<Commit> {
        let mut inner = lock(&self.inner);
        if !matches!(&inner.state, RestoreState::Prepared { id: ours, .. } if *ours == id) {
            return Err(inner.not_prepared(id));
        }
        match std::mem::replace(
            &mut inner.state,
            RestoreState::Idle, // replaced just below
        ) {
            RestoreState::Prepared {
                prepared,
                destination,
                was_open,
                epoch,
                ..
            } => {
                inner.state = RestoreState::Committing {
                    id,
                    cancel: CancelToken::new(),
                    destination: destination.clone(),
                    swapping: prepared.swap_flag(),
                };
                Ok(Commit {
                    prepared: *prepared,
                    destination,
                    was_open,
                    epoch,
                })
            }
            other => {
                inner.state = other;
                Err(BUSY_RESTORE)
            }
        }
    }

    /// The commit `id` failed in a way its recovery must settle: `Committing` goes straight to `Recovering` in this one
    /// step, so no restore starts, and no other recovery or dismissal runs, between the failure and the end of the
    /// recovery. The returned claim puts `Idle` back when it is dropped, after the recovery.
    fn recovering_after_commit(&self, id: u32) -> Claim<'_> {
        let mut inner = lock(&self.inner);
        if matches!(&inner.state, RestoreState::Committing { id: ours, .. } if *ours == id) {
            inner.state = RestoreState::Recovering;
        }
        Claim {
            restores: self,
            id: 0,
            live: true,
        }
    }

    /// The prepared restore `id`, taken out; the state is `Idle`.
    fn take_prepared(&self, id: u32) -> ShellResult<PreparedRestore> {
        let mut inner = lock(&self.inner);
        if !matches!(&inner.state, RestoreState::Prepared { id: ours, .. } if *ours == id) {
            return Err(inner.not_prepared(id));
        }
        match std::mem::replace(&mut inner.state, RestoreState::Idle) {
            RestoreState::Prepared { prepared, .. } => Ok(*prepared),
            other => {
                inner.state = other;
                Err(BUSY_RESTORE)
            }
        }
    }

    /// The commit `id` is over: `Idle`. With `lock_ended`, a late answer to this ID says "cancelled".
    fn end_commit(&self, id: u32, lock_ended: bool) {
        let mut inner = lock(&self.inner);
        if matches!(&inner.state, RestoreState::Committing { id: ours, .. } if *ours == id) {
            inner.state = RestoreState::Idle;
            if lock_ended {
                inner.note_ended(id);
            }
        }
    }

    /// The commit `id` stopped before the swap began and the staged restore is intact: `Prepared` again, same ID and
    /// same destination (the place, whoever is unlocked there when the next lock comes). No session is recorded as open
    /// there: if there was one, this commit closed it itself, which is not the user's lock.
    fn back_to_prepared(&self, id: u32, commit: Commit) {
        let Commit {
            prepared,
            destination,
            was_open: _,
            epoch,
        } = commit;
        let mut inner = lock(&self.inner);
        inner.state = RestoreState::Prepared {
            id,
            prepared: Box::new(prepared),
            destination,
            was_open: false,
            epoch,
        };
    }

    /// The lock hook (added in `Shell::new`, after the "Open" cleanup's): a restore that is not swapping ends with
    /// the lock. `sessions` is weak because the sessions hold this hook; it tells where a locked session was.
    /// - A lock of all vaults (`None`) cancels the token, for every reason but one: **an idle lock leaves every restore
    ///   as it is**, and a finished restore waiting for its answer (`Prepared`) survives it, with its staging folder and
    ///   journal (spec §7.4; `SECURITY.md` says why that is safe). Any other reason (Lock all, the window's close,
    ///   Windows locking, sleep, closing) also ends a `Prepared` restore: the staged restore is taken out and dropped on
    ///   a worker.
    /// - A lock of a session at the destination (a place: whenever that session was unlocked) does the same, unless it
    ///   is the restore's own (`LockReason::Restore`). While `Preparing`, the destination is known only at the end: the
    ///   place is noted.
    /// - In `Committing` the hook only cancels the token: the engine ignores it once the swap starts.
    pub fn lock_hook(self: &Arc<Self>, sessions: Weak<Sessions>) -> LockHook {
        let restores = Arc::clone(self);
        Box::new(move |session, reason| {
            #[cfg(test)]
            restores.run_test_hook(session, reason);
            // Before the state mutex: a session call never runs while it is held.
            let at = session.and_then(|session| sessions.upgrade()?.location_of(session));
            restores.locked(session.map(|_| at), reason);
        })
    }

    /// `session`: `None` for a lock of all vaults, else the place of the session locked (itself `None` when the session
    /// is not known).
    fn locked(self: &Arc<Self>, session: Option<Option<Location>>, reason: LockReason) {
        // An idle lock of all vaults ends nothing here: the idle timer is paused while a restore copies or swaps, and a
        // finished one waits for the person's answer through it.
        let idle = session.is_none() && reason == LockReason::Idle;
        let ends = |destination: &Option<Location>| match &session {
            None => !idle,
            Some(at) => reason != LockReason::Restore && at.is_some() && at == destination,
        };
        let dropped = {
            let mut inner = lock(&self.inner);
            let id = match &mut inner.state {
                RestoreState::Idle | RestoreState::Recovering => return,
                RestoreState::Preparing { cancel, locked, .. } => {
                    match &session {
                        None if !idle => cancel.cancel(),
                        Some(Some(at)) if reason != LockReason::Restore => locked.push(at.clone()),
                        _ => {}
                    }
                    return;
                }
                RestoreState::Committing {
                    cancel,
                    destination,
                    ..
                } => {
                    if ends(destination) {
                        cancel.cancel();
                    }
                    return;
                }
                RestoreState::Prepared {
                    id,
                    destination,
                    was_open,
                    ..
                } => {
                    if idle {
                        // The idle lock locked the vault being replaced too, if it was open: that is not the person's
                        // lock of it, so the answer is not refused for it.
                        *was_open = false;
                        return;
                    }
                    if !ends(destination) {
                        return;
                    }
                    *id
                }
            };
            match std::mem::replace(&mut inner.state, RestoreState::Idle) {
                RestoreState::Prepared { prepared, .. } => {
                    inner.note_ended(id);
                    Some(*prepared)
                }
                other => {
                    inner.state = other;
                    None
                }
            }
        };
        if let Some(prepared) = dropped {
            self.drop_on_worker(prepared);
        }
    }

    /// Drops `prepared` (removing its staging folder and journal, which can take seconds and must not hold the hook
    /// thread up) on a thread of its own. A thread that cannot start drops it here: slower, never skipped.
    fn drop_on_worker(self: &Arc<Self>, prepared: PreparedRestore) {
        *lock(&self.workers) += 1;
        let done = WorkerDone(Arc::clone(self));
        let _ = thread::Builder::new()
            .name("lockbox-restore-cleanup".into())
            .spawn(move || {
                let _done = done;
                drop(prepared);
            });
    }

    /// Waits for the cleanup workers under way until `until`: whether none is left.
    pub fn wait_idle(&self, until: Instant) -> bool {
        let workers = lock(&self.workers);
        let left = until.saturating_duration_since(Instant::now());
        let (workers, _) = self
            .idle
            .wait_timeout_while(workers, left, |workers| *workers > 0)
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *workers == 0
    }

    /// Tests only: how many times recovery has run.
    #[cfg(test)]
    pub(crate) fn recoveries(&self) -> usize {
        self.recoveries.load(Ordering::SeqCst)
    }

    /// Tests only: `hook` runs at the start of this hook for every lock, so a test can hold one lock's restore hook back
    /// (the hooks of the locks that follow queue behind it).
    #[cfg(test)]
    pub(crate) fn before_hook(&self, hook: TestHook) {
        *lock(&self.test_hook) = Some(hook);
    }

    #[cfg(test)]
    fn run_test_hook(&self, session: Option<SessionId>, reason: LockReason) {
        let hook = lock(&self.test_hook).clone();
        if let Some(hook) = hook {
            hook(session, reason);
        }
    }
}

/// Tests only: a step run at the start of the restore's lock hook.
#[cfg(test)]
pub(crate) type TestHook = Arc<dyn Fn(Option<SessionId>, LockReason) + Send + Sync>;

/// A prepared restore taken out of the state to be committed, with what the commit needs of it.
struct Commit {
    prepared: PreparedRestore,
    destination: Option<Location>,
    was_open: bool,
    epoch: u64,
}

// ---------------------------------------------------------------------------------------------------------------
// What restore_prepare keeps while it waits for a yes.
// ---------------------------------------------------------------------------------------------------------------

/// Which question a parked [`RestoreChoice`] was parked for.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Asked {
    Cloud,
    NewFolder,
}

/// `restore_prepare` waiting for a yes: the held pick it was asked for, by its token (the backup, the credential and the
/// folder stay in the pick, which a refusal of the copy leaves held), and what the yes decides. So
/// `restore_prepare_confirm` neither asks for files again nor lets another backup in. No `Debug`: the token confirms
/// what the pick holds.
pub struct RestoreChoice {
    pick: Token,
    /// The destination asked for: the same vault's folder, or a new one once the page has named it.
    destination: RestoreDestination,
    /// The parent's cloud question was answered yes.
    cloud_confirmed: bool,
    asked: Asked,
}

/// What a check of the pick found and keeps in Rust ([`PendingChoice::RestorePick`]): the credential that worked
/// (shared, wiped when the last holder drops it, never logged or sent), the vault's name and ID and the day the backup
/// was made, and where the restore goes, the usual folder until the person chooses another. No `Debug`: it holds a
/// credential and a path.
#[derive(Clone)]
pub struct Checked {
    credential: Arc<Typed>,
    name: String,
    id: VaultId,
    /// The day the backup was made in the PC's own zone, `YYYY-MM-DD`, when the backup says.
    made: Option<String>,
    /// The folder the vault goes in, as the person chose it (checked as a vault location only when the copy asks).
    parent: PathBuf,
    /// The parent is the usual vaults folder.
    usual: bool,
}

impl Checked {
    pub(crate) fn new(
        credential: Typed,
        name: String,
        id: VaultId,
        made: Option<String>,
        parent: PathBuf,
        usual: bool,
    ) -> Checked {
        Checked {
            credential: Arc::new(credential),
            name,
            id,
            made,
            parent,
            usual,
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn parent(&self) -> &Path {
        &self.parent
    }

    pub fn usual(&self) -> bool {
        self.usual
    }

    pub fn credential(&self) -> Credential<'_> {
        self.credential.credential()
    }

    /// The folder moves; the credential and what the check found stay.
    pub(crate) fn move_to(&mut self, parent: PathBuf, usual: bool) {
        self.parent = parent;
        self.usual = usual;
    }
}

/// A backup picked to be restored: the token the page sends back, and what it shows as text (never the path).
#[derive(Debug, Serialize)]
pub struct RestorePick {
    pub choice: Token,
    pub file_name: String,
    pub size: u64,
}

/// What a check of the pick found, and where the vault would go.
#[derive(Serialize)]
pub struct RestoreChecked {
    /// The vault's name inside the backup.
    pub name: String,
    /// The day the backup was made, `YYYY-MM-DD` in the PC's zone; `None` when the backup does not say.
    pub made: Option<String>,
    /// Where it goes, for display: `<parent>\<name>`, or the folder of the vault it replaces.
    pub folder_shown: String,
    /// The parent is the usual vaults folder.
    pub usual: bool,
    /// A vault with this vault's ID is already in the parent: it is the one replaced.
    pub replaces_existing: bool,
}

/// Never shows the vault's name or where it goes (R5).
impl fmt::Debug for RestoreChecked {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RestoreChecked")
            .field("usual", &self.usual)
            .field("replaces_existing", &self.replaces_existing)
            .finish_non_exhaustive()
    }
}

/// A restore extracted and checked, waiting for the user's yes.
#[derive(Debug, Serialize)]
pub struct RestorePreparedView {
    /// Sent back to `restore_commit` or `restore_discard`.
    pub restore: u32,
    /// The vault's name, from the backup.
    pub name: String,
    /// The vault already there is replaced (its old copy kept beside it as `.before-restore`).
    pub replaces_existing: bool,
    /// The folder the older copy will be kept in, told before the yes: the first of `<folder>.before-restore` and `-2` to
    /// `-99` that is free. `Some` only when a vault is replaced, and `None` then when all ninety-nine are taken (the
    /// swap refuses, as it always did).
    pub kept_as: Option<String>,
    /// The vault the swap replaces, as its ID on the vault list: `Some` exactly when `replaces_existing`, unless that
    /// vault is not on the list. The page lists that vault's older copies from it.
    pub replaces: Option<u32>,
}

/// A pre-restore copy, open read-only.
#[derive(Serialize)]
pub struct PreRestoreOpened {
    #[serde(flatten)]
    pub info: SessionInfo,
    /// Its header's stamp does not match: its name or date was changed outside Lockbox (spec §5.2). The copy still
    /// opens, since it may be the only one left; the screen warns.
    pub header_changed: bool,
}

/// A restore done.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct RestoredView {
    /// The vault's ID on the vault list.
    pub vault: u32,
    /// A `.before-restore` folder was made: list it with `list_pre_restore`.
    pub before_restore: bool,
}

/// A pre-restore folder, as `list_pre_restore` lists it.
#[derive(Serialize)]
pub struct PreRestoreEntry {
    /// For `delete_pre_restore` and `open_pre_restore_read_only`: valid until the next listing.
    pub id: u32,
    /// The registry ID of the vault it belongs to.
    pub vault: u32,
    /// The vault's name, read from the folder's header without the key.
    pub name: Option<String>,
    /// The folder's name only, never its path.
    pub folder: String,
    /// The local day (`YYYY-MM-DD`) that vault was last written: the newest modified time of the copy's header files.
    /// `None` when neither can be read.
    pub last_written: Option<String>,
    /// Bytes of every regular file under the folder, links not followed. `None` on any read error.
    pub size: Option<u64>,
}

/// Never shows the name or the folder (R5).
impl fmt::Debug for PreRestoreEntry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PreRestoreEntry")
            .field("id", &self.id)
            .field("vault", &self.vault)
            .finish_non_exhaustive()
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The shell's restore commands.
// ---------------------------------------------------------------------------------------------------------------

impl Shell {
    /// Launch work, in the app's `.setup` (never in a second copy of the app): restore recovery first, then the
    /// output sweep and the "Open" sweep (spec §6.8, §7.2), all before the shell is managed and the window exists, so
    /// no command can answer before a half-done restore is settled. Recovery never stops the app: a restore that
    /// could not be settled becomes a [`RestoreNotice`], kept for the page and sent as `lockbox://notice` (only when it
    /// is not `None`). A state folder that does not exist yet means `None` and nothing is created.
    pub fn launch_work(&self) {
        let notice = self.recover();
        if notice != RestoreNotice::None {
            self.tell(Notice::Restore(notice));
        }
        self.sweep_outputs();
    }

    /// Runs the engine's recovery on the restore journal and keeps what it found for [`restore_notice`]
    /// (Self::restore_notice). The caller holds the restore (a [`Claim`]) or is the launch: recovery removes a staging
    /// folder, so it never runs under a live restore of ours.
    pub fn recover(&self) -> RestoreNotice {
        self.restore.recoveries.fetch_add(1, Ordering::SeqCst);
        // The journal goes with the recovery, so the folder it names is read first, to say which vault was settled.
        let target = journal_target(&self.paths.journal);
        let mut notice = recovery_notice(&self.paths.journal);
        if let RestoreNotice::Recovered { how, vault } = &mut notice {
            *vault = target.and_then(|target| self.settled_vault(*how, &target));
        }
        *lock(&self.restore.notice) = notice.clone();
        notice
    }

    /// The vault of the list at `target`, the folder a settled restore was about. A swap that had finished
    /// ([`Recovered::Finished`]) may have ended before [`restore_commit`](Self::restore_commit) listed the vault: it is
    /// listed here, as that does, so the lock screen shows it. `None` when none is listed there (the list is full or
    /// damaged, the restore went to a new folder that was never made, ..) or its name cannot be read.
    fn settled_vault(&self, how: Recovered, target: &Path) -> Option<NoticeVault> {
        let listed = |target: &Path| {
            self.registry
                .entries()
                .into_iter()
                .find(|(_, dir)| same_path(dir, target))
        };
        let (id, dir) = match (listed(target), how) {
            (Some(found), _) => found,
            (None, Recovered::Finished) => {
                let dir = fs::canonicalize(target).ok()?;
                (self.registry.add(&dir).ok()?, dir)
            }
            (None, _) => return None,
        };
        Some(NoticeVault {
            id,
            name: read_vault_name(&dir).ok()?,
        })
    }

    /// Tells the page what a restore found, when it is not `None`.
    fn announce_restore(&self, notice: &RestoreNotice) {
        if *notice != RestoreNotice::None {
            self.notify(&Notice::Restore(notice.clone()));
        }
    }

    /// What recovery last found: kept, not used up, so a reloaded page shows it again.
    pub fn restore_notice(&self) -> RestoreNotice {
        lock(&self.restore.notice).clone()
    }

    /// Runs recovery again (the user reconnected the drive, or freed a name). `Busy` unless nothing of ours is alive.
    pub fn retry_restore_recovery(&self) -> ShellResult<RestoreNotice> {
        let _claim = self.restore.claim_recovery()?;
        let notice = self.recover();
        self.announce_restore(&notice);
        Ok(notice)
    }

    /// Dismisses a restore journal recovery could not act on (spec §6.8): it removes a validated staging folder and
    /// the journal, never the vault or a pre-restore copy. Without `confirm` it answers [`Confirm::Dismissal`] with
    /// what the dismissal leaves behind. `Busy` unless nothing of ours is alive.
    pub fn dismiss_restore(&self, confirm: bool) -> ShellResult<Outcome<()>> {
        let _claim = self.restore.claim_recovery()?;
        let journal = &self.paths.journal;
        if matches!(fs::symlink_metadata(journal), Err(e) if e.kind() == io::ErrorKind::NotFound) {
            *lock(&self.restore.notice) = RestoreNotice::None;
            return Ok(Outcome::Done(()));
        }
        if !confirm {
            let leaves = match inspect_restore_journal(journal) {
                Ok(Some(view)) => Leaves::of(&view),
                Ok(None) => return Ok(Outcome::Done(())),
                // A journal that cannot be read names nothing that dismissing would leave.
                Err(_) => Leaves::nothing_known(),
            };
            return Ok(Outcome::Confirm(Confirm::Dismissal { leaves }));
        }
        dismiss_restore_journal(journal)?;
        *lock(&self.restore.notice) = RestoreNotice::None;
        Ok(Outcome::Done(()))
    }

    /// 24a, first step: opens the picker "Restore a backup" (outside every lock) and holds the backup picked in Rust, as
    /// a choice that lives until it is forgotten ([`forget_restore_pick`](Self::forget_restore_pick)), the copy
    /// finishes, a lock of all vaults (any kind, an idle one too), closing, a new pick or five minutes without a use. The
    /// answer is the token, the file's name and its size, never the path; a closed picker answers `Dismissed` and leaves
    /// the old pick as it was, and `choice` (the pick being replaced, Pick another) is forgotten once the new one is held.
    /// The lock epoch is read before the picker, so a lock of all vaults while it is open is `Locked`, with nothing held.
    /// `Busy { restore }` while a restore of ours is preparing, finished or committing (one at a time).
    ///
    /// `vault`: the vault of the list the backup is for (Ask 4 and Ask 8). The check then makes the folder that holds that
    /// vault the restore's folder (not the usual one), so the restore finds the vault there and replaces it, or, when its
    /// headers cannot be read, unpacks into a new folder beside it and leaves it alone. A vault that is not on the list is
    /// `NotFound`, before a picker opens and with nothing held.
    pub fn restore_pick(
        &self,
        choice: Option<&Token>,
        vault: Option<u32>,
    ) -> ShellResult<Outcome<RestorePick>> {
        if !self.restore.is_idle() {
            return Err(BUSY_RESTORE);
        }
        // A vault that is not on the list is refused before a picker opens (the check looks again: it may be forgotten
        // by then).
        if let Some(vault) = vault {
            self.registry.path(vault).ok_or(ShellError::NotFound)?;
        }
        let epoch = self.sessions.epoch();
        let Some(path) = self.os.dialogs.pick_file(RESTORE_PICK_TITLE, Some(FILTER)) else {
            return Ok(Outcome::Dismissed);
        };
        let size = fs::metadata(&path)?.len();
        let file_name = display_name(&path);
        let pending = self.sessions.pending();
        let held = pending.put_at(
            PendingChoice::RestorePick {
                path,
                epoch,
                vault,
                checked: None,
            },
            self.os.clock.now(),
        );
        // A lock of all vaults came while the picker was open (or the app is closing): what was just held is no one's.
        if self.locked_since(epoch) {
            pending.forget_restore_pick(&held);
            return Err(ShellError::Locked);
        }
        if let Some(old) = choice {
            pending.forget_restore_pick(old);
        }
        Ok(Outcome::Done(RestorePick {
            choice: held,
            file_name,
            size,
        }))
    }

    /// 24a's Continue: opens the held backup with what was typed, in the one box (a recovery key that reads as a
    /// well-formed one is tried as the key, then as a password; anything else as a password), without unpacking it, and
    /// keeps the credential that worked in Rust, in the pick, with the vault's name, its ID, the day it was made and the
    /// usual folder as where it goes (the folder that holds the vault the pick was made for, when it was made for one:
    /// `usual` is then false; `NotFound` if that vault has left the list). A second check replaces the first. A wrong password or key, a damaged backup and
    /// every other refusal leave the pick held, so the person tries again without picking the file again.
    ///
    /// `ChoiceExpired` (before anything else) for a pick that is not held. Not a job: about a second, like unlocking, so
    /// it pauses nothing; a lock of all vaults while it runs cancels it and answers `Locked`, with nothing held.
    pub fn restore_check(
        &self,
        choice: &Token,
        credential: CredentialArg,
    ) -> ShellResult<RestoreChecked> {
        let epoch = self.sessions.epoch();
        let now = || self.os.clock.now();
        let held = self
            .sessions
            .pending()
            .use_restore_pick(choice, epoch, &now)?;
        // A pick made for a vault of the list goes beside that vault, where the engine finds it (or, if its headers are
        // damaged, finds a folder it cannot read and unpacks into a new one beside it). It is looked up again here: the
        // vault may have left the list since the pick.
        let (parent, usual) = match held.vault() {
            Some(vault) => {
                let dir = self.registry.path(vault).ok_or(ShellError::NotFound)?;
                let beside = dir.parent().ok_or(ShellError::NotFound)?;
                (beside.to_path_buf(), false)
            }
            None => (default_vault_parent(self.os.env.as_ref())?, true),
        };
        let attempts = credential.attempts()?;
        let (launch_epoch, launch) = self.sessions.launch_scope();
        if launch_epoch != epoch {
            return Err(ShellError::Locked);
        }
        let opened = attempts.run_keeping(|credential| {
            ReadOnlyVault::open_backup(held.path(), credential, &launch, &NoProgress)
        });
        let (vault, credential) = match opened {
            Ok(found) => found,
            Err(refusal) if self.locked_since(epoch) => {
                drop(refusal);
                return Err(ShellError::Locked);
            }
            Err(refusal) => return Err(refusal.into()),
        };
        let offset = self.os.clock.utc_offset_secs();
        let made = vault
            .backup_created_at()
            .and_then(dates::parse_utc)
            .map(|secs| dates::local_date_of(secs, offset));
        let checked = Checked::new(
            credential,
            vault.name().to_owned(),
            vault.id(),
            made,
            parent,
            usual,
        );
        drop(vault);
        // A lock that came while the backup was opened has dropped the pick: nothing is kept.
        if self.locked_since(epoch) {
            return Err(ShellError::Locked);
        }
        // Beside a vault whose details are damaged the restore makes a new folder, so it replaces nothing there.
        let beside = self.beside_damaged_vault(held.vault(), &checked, &checked.parent)?;
        let view = self.checked_view(&checked, beside.is_some());
        match held.set_checked(checked) {
            true => Ok(view),
            false => Err(ShellError::ChoiceExpired),
        }
    }

    /// 24b's "Choose another": opens the picker "Restore into this folder", starting in the folder the pick is in now when
    /// it exists, and moves the pick there. What the check found, the credential included, stays: nothing is typed again.
    /// A closed picker answers `Dismissed` and keeps the folder. `ChoiceExpired` (before the picker opens) for a pick
    /// that is not held or not checked; `Locked` for a lock of all vaults while the picker was open. The folder is
    /// checked as a vault location only when the copy asks.
    pub fn restore_choose_folder(&self, choice: &Token) -> ShellResult<Outcome<RestoreChecked>> {
        let epoch = self.sessions.epoch();
        let now = || self.os.clock.now();
        let pending = self.sessions.pending();
        let mut held = pending.use_restore_pick(choice, epoch, &now)?;
        // Across the dialog, which may stay open as long as the person likes, only the folder it starts in (not a
        // secret) and the use guard are kept: the credential stays in the pending table alone, where a lock wipes it
        // at once. The pick is taken again when the dialog returns.
        let start = held
            .checked()
            .ok_or(ShellError::ChoiceExpired)?
            .parent()
            .to_path_buf();
        held.release_checked();
        let start = Some(start.as_path()).filter(|dir| dir.is_dir());
        let Some(picked) = self.os.dialogs.pick_folder(RESTORE_FOLDER_TITLE, start) else {
            return Ok(Outcome::Dismissed);
        };
        if self.locked_since(epoch) {
            return Err(ShellError::Locked);
        }
        // A pick forgotten, replaced or drained meanwhile, or of another epoch, is gone: nothing is moved or kept.
        let held_again = pending.use_restore_pick(choice, epoch, &now)?;
        let mut checked = held_again
            .checked()
            .ok_or(ShellError::ChoiceExpired)?
            .clone();
        let usual = default_vault_parent(self.os.env.as_ref())
            .ok()
            .is_some_and(|usual| same_folder(&usual, &picked));
        checked.move_to(picked.clone(), usual);
        if !held_again.set_parent(picked, usual) {
            return Err(ShellError::ChoiceExpired);
        }
        Ok(Outcome::Done(self.checked_view(&checked, false)))
    }

    /// Drops the held pick `choice` (the flow was cancelled, or went back to the first screen). Idempotent: a token that
    /// is unknown, dropped already or another kind of choice's is nothing to forget, and answers without error.
    pub fn forget_restore_pick(&self, choice: &Token) -> ShellResult<()> {
        self.sessions.pending().forget_restore_pick(choice);
        Ok(())
    }

    /// What the page is told of a checked pick: the vault's name, the day it was made, and where it goes, which is the
    /// folder of the vault already in the parent with this vault's ID (then it is replaced), else `<parent>\<name>`.
    /// `new_folder`: the restore goes to a new folder whatever is in the parent (Ask 8, beside a damaged vault).
    fn checked_view(&self, checked: &Checked, new_folder: bool) -> RestoreChecked {
        let existing = match new_folder {
            true => None,
            false => existing_vault_in(&checked.parent, &checked.id),
        };
        let folder = match &existing {
            Some(dir) => dir.clone(),
            None => checked.parent.join(folder_name(&checked.name, &checked.id)),
        };
        RestoreChecked {
            name: checked.name.clone(),
            made: checked.made.clone(),
            folder_shown: shown(&folder),
            usual: checked.usual,
            replaces_existing: existing.is_some(),
        }
    }

    /// 24c: the copy of the held pick, in the folder it is in, into a hidden staging folder beside the destination (spec
    /// §6.8 steps 3 and 4). The usual folder is made first when it is not there; the folder is checked like any vault
    /// location (a cloud folder asks first); then the copy runs as a launch-scoped job the page's `request` names
    /// (progress, and a Stop through `cancel_operation`): the backup is unlocked again, checked and extracted, replacing
    /// the vault of the same ID in the folder or in a new folder. The engine's own checks come first inside the job (the
    /// credential, free space, the destination), so a refusal of them arrives as the job's answer. Nothing is swapped:
    /// the page asks the user (only when a vault is replaced), then sends `restore_commit`.
    ///
    /// The pick stays held through every refusal (so the person can choose another folder) and goes when the copy has
    /// finished, and on a Stop. `Busy { restore }` while a restore of ours is alive, before anything else; then
    /// `ChoiceExpired` for a pick that is not held or was not checked. When a restore journal is there and none of ours
    /// is alive (a crash, or a failed recovery), recovery runs and the answer is [`Confirm::Recovery`] with what it
    /// found. When the vault folder at the destination cannot be recognised (both headers unreadable) and the default
    /// folder name is taken by it, the answer is [`Confirm::NewFolder`].
    pub fn restore_prepare(
        &self,
        choice: &Token,
        request: u32,
    ) -> ShellResult<Outcome<RestorePreparedView>> {
        let epoch = self.sessions.epoch();
        self.restore_with_pick(choice, RestoreDestination::SameVault, false, epoch, request)
    }

    /// The user's answer to [`Confirm::CloudFolder`] (`name` absent: go on with the destination as first asked) or to
    /// [`Confirm::NewFolder`] (`name` present: restore into a new folder of that name). The pick stays where it is: its
    /// backup, credential and folder are used, never a new pick (a pick that has gone is `ChoiceExpired`). The token is
    /// used up whatever happens; an answer of the wrong kind for the question is refused.
    pub fn restore_prepare_confirm(
        &self,
        token: &Token,
        name: Option<String>,
        request: u32,
    ) -> ShellResult<Outcome<RestorePreparedView>> {
        let epoch = self.sessions.epoch();
        let PendingChoice::Restore(question) = self.sessions.pending().take(token)? else {
            // A token for another question: used up, and its choice dropped.
            return Err(ShellError::NotFound);
        };
        let RestoreChoice {
            pick,
            destination,
            cloud_confirmed,
            asked,
        } = question;
        let (destination, cloud_confirmed) = match (asked, name) {
            (Asked::Cloud, None) => (destination, true),
            (Asked::NewFolder, Some(name)) => {
                (RestoreDestination::NewFolder(name), cloud_confirmed)
            }
            _ => {
                return Err(ShellError::InvalidInput {
                    what: "restore answer",
                });
            }
        };
        self.restore_with_pick(&pick, destination, cloud_confirmed, epoch, request)
    }

    /// The copy for the held pick `pick`, and what becomes of the pick: forgotten when the copy finished or a Stop ended
    /// it, kept through every other answer.
    fn restore_with_pick(
        &self,
        pick: &Token,
        destination: RestoreDestination,
        cloud_confirmed: bool,
        epoch: u64,
        request: u32,
    ) -> ShellResult<Outcome<RestorePreparedView>> {
        if !self.restore.is_idle() {
            return Err(BUSY_RESTORE);
        }
        let pending = self.sessions.pending();
        let now = || self.os.clock.now();
        let held = pending.use_restore_pick(pick, epoch, &now)?;
        let answer = self.restore_start(&held, pick, destination, cloud_confirmed, epoch, request);
        drop(held);
        if matches!(answer, Ok(Outcome::Done(_)) | Err(ShellError::Cancelled))
            || matches!(&answer, Err(refusal) if *refusal == BACKUP_CHANGED)
        {
            pending.forget_restore_pick(pick);
        }
        answer
    }

    /// The folder (made when it is the usual one and missing), its location check (again after a yes: it may have
    /// changed since), then the cloud question, then the copy itself.
    fn restore_start(
        &self,
        held: &RestorePickUse<'_>,
        pick: &Token,
        destination: RestoreDestination,
        cloud_confirmed: bool,
        epoch: u64,
        request: u32,
    ) -> ShellResult<Outcome<RestorePreparedView>> {
        let checked = held.checked().ok_or(ShellError::ChoiceExpired)?;
        let wanted = checked.parent();
        if checked.usual() {
            fs::create_dir_all(wanted)?;
        }
        let check = self.check_location(wanted)?;
        if check.cloud.is_some() && !cloud_confirmed {
            let question = RestoreChoice {
                pick: pick.clone(),
                destination,
                cloud_confirmed: false,
                asked: Asked::Cloud,
            };
            return self.park(question, epoch, |token| Confirm::CloudFolder { token });
        }
        // Ask 8's restore, still beside the damaged vault it was started from, makes a new folder and nothing else: the
        // engine's same-vault rule would find a healthy vault of the backup's ID there (the sibling an earlier restore
        // made) and replace it.
        let beside = match destination {
            RestoreDestination::SameVault => {
                self.beside_damaged_vault(held.vault(), checked, &check.path)?
            }
            RestoreDestination::NewFolder(_) => None,
        };
        let destination = match beside {
            Some(Beside::Sibling) => return Err(ALREADY_HERE),
            Some(Beside::Into(name)) => RestoreDestination::NewFolder(name),
            Some(Beside::Taken(suggested)) => {
                let question = RestoreChoice {
                    pick: pick.clone(),
                    destination,
                    cloud_confirmed,
                    asked: Asked::NewFolder,
                };
                return self.park(question, epoch, |token| Confirm::NewFolder {
                    suggested,
                    token,
                });
            }
            None => destination,
        };
        self.restore_run(
            held,
            pick,
            check.path,
            destination,
            cloud_confirmed,
            epoch,
            request,
        )
    }

    /// Whether the pick was made for a vault whose details are damaged (Ask 8) and its folder is still the one beside that
    /// vault (Choose another has not moved it): then where the restore goes. `None` for every other pick, a readable vault
    /// (Ask 4) included, which keeps the engine's same-vault rule. `NotFound` when the vault has left the list.
    fn beside_damaged_vault(
        &self,
        vault: Option<u32>,
        checked: &Checked,
        parent: &Path,
    ) -> ShellResult<Option<Beside>> {
        let Some(vault) = vault else {
            return Ok(None);
        };
        let dir = self.registry.path(vault).ok_or(ShellError::NotFound)?;
        let beside = dir
            .parent()
            .is_some_and(|beside| same_folder(beside, parent));
        if !beside || !self.registry.entry(vault, &dir).details_damaged {
            return Ok(None);
        }
        // A readable copy of this vault is beside it already (a sibling an earlier restore made): the engine keeps one
        // writable copy of a vault in a folder, so it would not make another.
        if existing_vault_in(parent, &checked.id).is_some() {
            return Ok(Some(Beside::Sibling));
        }
        let default = folder_name(&checked.name, &checked.id);
        Ok(Some(match is_free(&parent.join(&default)) {
            true => Beside::Into(default),
            false => Beside::Taken(restored_name(&default)),
        }))
    }

    /// Parks `question` for the user's yes. A lock of all vaults between the epoch read and the parking has already
    /// emptied [`Pending`](crate::pending::Pending): the question is taken back.
    fn park(
        &self,
        question: RestoreChoice,
        epoch: u64,
        ask: impl FnOnce(Token) -> Confirm,
    ) -> ShellResult<Outcome<RestorePreparedView>> {
        let token = self
            .sessions
            .pending()
            .put(PendingChoice::Restore(question));
        if self.locked_since(epoch) {
            drop(self.sessions.pending().take(&token));
            return Err(ShellError::Locked);
        }
        Ok(Outcome::Confirm(ask(token)))
    }

    /// `Preparing` to `Prepared`: a long operation (idle time paused, the PC kept awake) from the claim to the end of
    /// the extraction, and a launch-scoped job the page's `request` names: progress as the engine writes, and a Stop. A
    /// changed epoch is looked for after the claim and the job are registered, so a lock of all vaults either comes
    /// before it (seen here) or finds it and cancels it. `parent` is the folder as checked (canonical).
    #[allow(clippy::too_many_arguments)]
    fn restore_run(
        &self,
        held: &RestorePickUse<'_>,
        pick: &Token,
        parent: PathBuf,
        destination: RestoreDestination,
        cloud_confirmed: bool,
        epoch: u64,
        request: u32,
    ) -> ShellResult<Outcome<RestorePreparedView>> {
        let checked = held.checked().ok_or(ShellError::ChoiceExpired)?;
        let (id, mut claim) = self.restore.claim_preparing()?;
        let operation = self.begin_launch_job(JobKind::Restore, Some(request));
        let cancel = operation.token().clone();
        self.restore.adopt(id, &cancel);
        if self.locked_since(epoch) {
            return Err(ShellError::Locked);
        }
        // A full or damaged vault list is told before the long work; a full one still lets a vault that is already on
        // it be replaced, which is known only once the destination is (below).
        let room = match self.registry.check_room() {
            Ok(()) => None,
            Err(full @ ShellError::TooLarge { .. }) => Some(full),
            Err(e) => return Err(e),
        };
        // The journal is written in the state folder, which a first-ever restore may find missing.
        fs::create_dir_all(&self.paths.root)?;

        // The engine compares the vault ID of the archive it opens with the one the check saw, before it copies: the
        // file may have been replaced since, and the screens name the vault the check found.
        let prepared = PreparedRestore::prepare_expecting(
            held.path(),
            &parent,
            checked.credential(),
            destination.clone(),
            &self.paths.journal,
            &cancel,
            operation.progress(),
            Some(checked.id),
        );
        let prepared = match prepared {
            Ok(prepared) => prepared,
            // Another vault's backup is in the file now: nothing was written, and the pick goes (see
            // `restore_with_pick`).
            Err(CoreError::InvalidInput {
                what: "backup changed",
            }) => return Err(BACKUP_CHANGED),
            // A journal is there and no restore of ours is alive (this claim is the only one): settle it first.
            Err(CoreError::InvalidInput {
                what: "restore in progress",
            }) => {
                let notice = self.recover();
                drop(operation);
                self.announce_restore(&notice);
                return Ok(Outcome::Confirm(Confirm::Recovery { notice }));
            }
            Err(e) if is_destination_taken(&e) && destination == RestoreDestination::SameVault => {
                // The engine says only that the name is taken. The check already knows the vault's name and ID, so the
                // suggestion needs no second unlocking.
                let suggested = restored_name(&folder_name(&checked.name, &checked.id));
                drop(operation);
                let question = RestoreChoice {
                    pick: pick.clone(),
                    destination,
                    cloud_confirmed,
                    asked: Asked::NewFolder,
                };
                return self.park(question, epoch, |token| Confirm::NewFolder {
                    suggested,
                    token,
                });
            }
            Err(e) => return Err(e.into()),
        };

        let name = prepared.name().to_owned();
        let existing = prepared.existing().map(Path::to_path_buf);
        let kept_as = existing.as_deref().and_then(kept_as_name);
        let replaces = existing.as_deref().and_then(|dir| {
            self.registry
                .entries()
                .into_iter()
                .find(|(_, listed)| same_path(listed, dir))
                .map(|(id, _)| id)
        });
        let location = existing
            .as_deref()
            .and_then(|dir| Location::folder(dir).ok());
        // A full vault list still lets a vault that is on it be replaced, but takes no new one.
        if let Some(full) = room {
            let listed = existing.as_ref().is_some_and(|dir| {
                self.registry
                    .entries()
                    .iter()
                    .any(|(_, other)| same_path(other, dir))
            });
            if !listed {
                return Err(full);
            }
        }
        // The destination is the folder it replaces, whoever is unlocked there.
        let destination = location;
        // Whether a session is open there now: a commit that finds none then knows the user locked it.
        let was_open = destination
            .as_ref()
            .is_some_and(|place| self.sessions.find(place).is_some());

        let registered = {
            let mut inner = lock(&self.restore.inner);
            match std::mem::replace(&mut inner.state, RestoreState::Idle) {
                RestoreState::Preparing {
                    id: ours, locked, ..
                } if ours == id => {
                    // A session at the destination that a user locked while the backup was extracted ends it.
                    let destination_locked = destination
                        .as_ref()
                        .is_some_and(|place| locked.contains(place));
                    if cancel.is_cancelled() || destination_locked {
                        // A lock or a Stop ended it while it ran (its hook cancelled the token, or the destination was
                        // locked).
                        inner.note_ended(id);
                        Err(prepared)
                    } else {
                        inner.state = RestoreState::Prepared {
                            id,
                            prepared: Box::new(prepared),
                            destination,
                            was_open,
                            epoch,
                        };
                        Ok(())
                    }
                }
                other => {
                    inner.state = other;
                    Err(prepared)
                }
            }
        };
        claim.settled();
        // The staged restore is dropped (its staging folder removed) outside the state mutex.
        if let Err(prepared) = registered {
            drop(prepared);
            drop(operation);
            return Err(ShellError::Cancelled);
        }
        // Ending the operation announces on `lockbox://busy`, where a lock can land: the last check comes after it. An idle
        // lock that lands here leaves the finished restore be, as it does later; every other lock ends it.
        drop(operation);
        if self.sessions.non_idle_lock_since(epoch) {
            // The lock's hook may not have run yet: take our own staged restore back.
            if let Ok(prepared) = self.restore.take_prepared(id) {
                lock(&self.restore.inner).note_ended(id);
                drop(prepared);
            }
            return Err(ShellError::Cancelled);
        }
        Ok(Outcome::Done(RestorePreparedView {
            restore: id,
            name,
            replaces_existing: existing.is_some(),
            kept_as,
            replaces,
        }))
    }

    /// Swaps the prepared restore `restore` into place (spec §6.8 step 5), after the user's yes. The session open at
    /// the destination (looked up again: it may have been unlocked since `prepare`) is locked with
    /// [`LockReason::Restore`], waited for up to 10 s (else `Busy { "vault still finishing an operation" }`, the
    /// staged restore kept), then the engine commits. A long operation until it ends, and a launch-scoped job the
    /// page's `request` names, with progress but no Stop (`done` 0 of 1 until it ends at 1 of 1, only when the swap went
    /// through). A lock before the swap starts answers `Cancelled` (and the staged restore is gone); once the engine
    /// writes `swapping` nothing cancels it.
    ///
    /// The restore is refused as `Cancelled` when it was ended by a lock of all vaults of any kind but the idle one (the
    /// lock hook discards it, and the sessions' own count says so before the hook has run), by the app closing, or by
    /// the person's lock of the destination: never for an idle lock, which the finished restore survives (§7.4),
    /// however many came, and which may itself have locked the destination.
    ///
    /// By the engine's contract: `RestorePending` runs recovery at once (the notice is kept and sent; the answer is
    /// that error). Any other failure is asked of the engine: a restore it kept as it was
    /// ([`PreparedRestore::can_retry`]: the vault is open elsewhere, a cancel, a refused first rename) goes back to
    /// `Prepared` with the same ID for a retry, unless a lock came meanwhile; otherwise the engine settled it, the
    /// restore is dropped, and recovery runs for any journal left. From a failed commit the state goes straight to
    /// `Recovering` and stays there until recovery is over, so no other restore starts in between. After a swap the
    /// vault is put on the vault list (`VAULT_NOT_LISTED` if that fails).
    pub fn restore_commit(&self, restore: u32, request: u32) -> ShellResult<RestoredView> {
        let Commit {
            mut prepared,
            destination,
            was_open,
            epoch,
        } = self.restore.begin_commit(restore)?;
        // The session open there now, whenever it was unlocked.
        let session = destination
            .as_ref()
            .and_then(|place| self.sessions.find(place));

        let operation = self.begin_launch_job_without_stop(JobKind::Restore, Some(request));
        let cancel = operation.token().clone();
        self.restore.adopt(restore, &cancel);
        // The page's bar has no percentage to show here: nought of one until the swap went through.
        operation.progress().advance(0, 1);
        // A lock of all vaults of a kind that ends the restore, whose hook has not run yet (the token is not cancelled
        // then): the sessions' own count says it from the moment of the lock.
        let ended = || cancel.is_cancelled() || self.sessions.non_idle_lock_since(epoch);
        // The destination found locked, though it was open when the restore became finished: the person's lock of it
        // (its hook still queued; one session's lock leaves the epoch), unless an idle lock of all vaults came since,
        // which locked it as well and ends nothing.
        let idle_locked_it = || self.sessions.epoch() != epoch;
        if ended() || (was_open && session.is_none() && !idle_locked_it()) {
            self.restore.end_commit(restore, true);
            drop(operation);
            drop(prepared);
            return Err(ShellError::Cancelled);
        }
        if let Some(session) = session {
            self.sessions.lock(session, LockReason::Restore);
            if !self.sessions.release_wait(session, RELEASE_WAIT) {
                // A lock that came meanwhile ends the restore; else it waits for another try.
                if ended() {
                    self.restore.end_commit(restore, true);
                    drop(operation);
                    drop(prepared);
                    return Err(ShellError::Cancelled);
                }
                let kept = Commit {
                    prepared,
                    destination,
                    was_open: false,
                    epoch,
                };
                self.restore.back_to_prepared(restore, kept);
                return Err(ShellError::Busy {
                    what: "vault still finishing an operation",
                });
            }
        }
        // A lock of all vaults that landed while the destination was released, whose hooks are still queued (so the
        // token is not cancelled yet), must not slip through to the swap.
        if ended() {
            self.restore.end_commit(restore, true);
            drop(operation);
            drop(prepared);
            return Err(ShellError::Cancelled);
        }

        let committed = prepared.commit(&cancel);
        match committed {
            Ok(outcome) => {
                self.restore.end_commit(restore, false);
                operation.progress().advance(1, 1);
                drop(operation);
                let dir = fs::canonicalize(&outcome.dir).unwrap_or(outcome.dir);
                let vault = self.registry.add(&dir).map_err(|_| VAULT_NOT_LISTED)?;
                Ok(RestoredView {
                    vault,
                    before_restore: outcome.before_restore.is_some(),
                })
            }
            Err(CoreError::Cancelled) => {
                self.restore.end_commit(restore, true);
                drop(operation);
                drop(prepared);
                Err(ShellError::Cancelled)
            }
            Err(error) => {
                // The engine says whether it kept the restore as it was; a lock that came during the commit ends it.
                if prepared.can_retry() {
                    if !ended() {
                        let kept = Commit {
                            prepared,
                            destination,
                            was_open: false,
                            epoch,
                        };
                        self.restore.back_to_prepared(restore, kept);
                        drop(operation);
                    } else {
                        self.restore.end_commit(restore, true);
                        drop(operation);
                        drop(prepared);
                    }
                    return Err(error.into());
                }
                // Settled by the engine, or left for recovery (`RestorePending`): `Committing` goes straight to
                // `Recovering`, held until the recovery is over.
                let _recovering = self.restore.recovering_after_commit(restore);
                drop(operation);
                drop(prepared);
                let notice = self.recover();
                self.announce_restore(&notice);
                Err(error.into())
            }
        }
    }

    /// Throws away the prepared restore `restore`: its staging folder and journal go. A restore a lock ended answers
    /// `Cancelled`; one never issued, `NotFound`.
    pub fn restore_discard(&self, restore: u32) -> ShellResult<()> {
        let prepared = self.restore.take_prepared(restore)?;
        // Outside the state mutex: removing a big staging folder takes a while.
        drop(prepared);
        Ok(())
    }

    // -----------------------------------------------------------------------------------------------------------
    // Pre-restore folders (spec §6.8 step 5).
    // -----------------------------------------------------------------------------------------------------------

    /// The `<folder>.before-restore` and `<folder>.before-restore-<2..=99>` folders beside each registered vault's
    /// folder that are real folders (not links) holding the same vault ID (by `read_vault_id`, either header copy,
    /// no key needed: it prevents mistakes, nothing more). Found again at any time, a restart included. The IDs are
    /// valid until the next listing, which replaces them.
    pub fn list_pre_restore(&self) -> Vec<PreRestoreEntry> {
        let mut found = Vec::new();
        let registered = self.registry.entries();
        for (vault, dir) in &registered {
            for folder in pre_restore_folders(dir, &registered) {
                if !found
                    .iter()
                    .any(|(_, other): &(u32, PathBuf)| same_path(other, &folder))
                {
                    found.push((*vault, folder));
                }
            }
        }
        // Read before the list is locked: a big folder takes a while to measure.
        let offset = self.os.clock.utc_offset_secs();
        let found: Vec<_> = found
            .into_iter()
            .map(|(vault, folder)| {
                let (day, size) = (last_written_day(&folder, offset), folder_size(&folder));
                (vault, folder, day, size)
            })
            .collect();
        let mut list = lock(&self.restore.pre_restore);
        list.listed.clear();
        let mut entries = Vec::new();
        for (vault, folder, last_written, size) in found {
            list.last_id += 1;
            let id = list.last_id;
            entries.push(PreRestoreEntry {
                id,
                vault,
                name: read_vault_name(&folder).ok(),
                folder: folder
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                last_written,
                size,
            });
            list.listed.push(Listed { id, vault, folder });
        }
        entries
    }

    /// The listed folder `id`, as the last listing had it.
    fn listed_pre_restore(&self, id: u32) -> ShellResult<(u32, PathBuf)> {
        lock(&self.restore.pre_restore)
            .listed
            .iter()
            .find(|listed| listed.id == id)
            .map(|listed| (listed.vault, listed.folder.clone()))
            .ok_or(ShellError::NotFound)
    }

    /// Checks again that `folder` is what it was listed as: a vault on the list that still has this parent, a name that
    /// is that vault folder's plus `.before-restore` (or `-2..=99`, any letter case), a real folder (not a link), and
    /// the same vault ID. `NotFound` otherwise. The folder's session location when it holds.
    fn check_pre_restore(&self, vault: u32, folder: &Path) -> ShellResult<Location> {
        let gone = ShellError::NotFound;
        let dir = self.registry.path(vault).ok_or(gone)?;
        let (Some(parent), Some(name), Some(folder_name)) = (
            dir.parent(),
            dir.file_name().and_then(OsStr::to_str),
            folder.file_name().and_then(OsStr::to_str),
        ) else {
            return Err(gone);
        };
        let beside = folder
            .parent()
            .is_some_and(|other| same_path(other, parent));
        // A folder on the vault list is a live vault, not a pre-restore copy.
        let live = self
            .registry
            .entries()
            .iter()
            .any(|(_, listed)| same_path(listed, folder));
        if live
            || !beside
            || !is_pre_restore_name(folder_name, name)
            || !is_real_folder_in(parent, folder)
        {
            return Err(gone);
        }
        match (read_vault_id(folder), read_vault_id(&dir)) {
            (Ok(copy), Ok(live)) if copy == live => {}
            _ => return Err(gone),
        }
        Location::folder(folder).map_err(|_| gone)
    }

    /// Deletes the pre-restore folder `id`, for good. Checked again first (see `check_pre_restore`) and refused with
    /// `Busy` while a session is open on it or an open of it is under way. Without `confirm` the answer is
    /// [`Confirm::DeletePreRestore`] and nothing is touched; the check runs once more right before the delete.
    pub fn delete_pre_restore(&self, id: u32, confirm: bool) -> ShellResult<Outcome<()>> {
        let (vault, folder) = self.listed_pre_restore(id)?;
        self.check_deletable(vault, &folder)?;
        if !confirm {
            return Ok(Outcome::Confirm(Confirm::DeletePreRestore));
        }
        self.check_deletable(vault, &folder)?;
        remove_dir_all_retry(&folder)?;
        lock(&self.restore.pre_restore)
            .listed
            .retain(|listed| listed.id != id);
        Ok(Outcome::Done(()))
    }

    fn check_deletable(&self, vault: u32, folder: &Path) -> ShellResult<()> {
        let location = self.check_pre_restore(vault, folder)?;
        match self.sessions.in_use(&location) {
            true => Err(ShellError::Busy {
                what: "folder is open",
            }),
            false => Ok(()),
        }
    }

    /// Opens the pre-restore folder `id` as a read-only session keyed by its location, next to the live vault
    /// (spec §6.9). A live vault folder is never opened through this: only a folder listed by `list_pre_restore` and
    /// checked again. Writes nothing in the folder.
    pub fn open_pre_restore_read_only(
        &self,
        id: u32,
        credential: CredentialArg,
    ) -> ShellResult<Tagged<PreRestoreOpened>> {
        let (vault, folder) = self.listed_pre_restore(id)?;
        let location = self.check_pre_restore(vault, &folder)?;
        // The one box of every backup field: a well-formed recovery key is tried as a key, then as a password.
        let credential = credential.attempts()?;
        let answer = self.sessions.open(Some(location.clone()), None, |cancel| {
            let opened = credential.run(|credential| {
                ReadOnlyVault::open_folder(location.path(), credential, cancel, &NoProgress)
            })?;
            let header_changed = !opened.header_mac_ok();
            Ok(OpenStep::Session(
                location.clone(),
                Opened::ReadOnly(opened),
                header_changed,
            ))
        })?;
        match answer {
            Outcome::Done(Tagged {
                session,
                generation,
                data: (info, header_changed),
            }) => match info.read_only {
                true => Ok(Tagged {
                    session,
                    generation,
                    data: PreRestoreOpened {
                        info,
                        // `None`: open already, and the page heard it then.
                        header_changed: header_changed.unwrap_or(false),
                    },
                }),
                // A writable session already at that place is a live vault, never handed out here.
                false => Err(ShellError::InvalidInput {
                    what: "not a pre-restore copy",
                }),
            },
            // The opening closure never asks.
            Outcome::Confirm(_) | Outcome::Dismissed => Err(ShellError::Cancelled),
        }
    }
}

/// The pre-restore folders of the vault folder `dir`, sorted: real folders beside it, named for it, holding its vault
/// ID. None when `dir`'s own header cannot be read (the ID to match is unknown).
fn pre_restore_folders(dir: &Path, registered: &[(u32, PathBuf)]) -> Vec<PathBuf> {
    let (Some(parent), Some(name)) = (dir.parent(), dir.file_name().and_then(OsStr::to_str)) else {
        return Vec::new();
    };
    let Ok(live) = read_vault_id(dir) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(parent) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|candidate| is_pre_restore_name(candidate, name))
        })
        .map(|entry| entry.path())
        // A folder on the vault list is a live vault (the user added it), whatever its name.
        .filter(|path| !registered.iter().any(|(_, listed)| same_path(listed, path)))
        .filter(|path| {
            is_real_folder_in(parent, path) && read_vault_id(path).is_ok_and(|id| id == live)
        })
        .collect();
    found.sort();
    found
}

/// The two files that hold a vault's header, and so the last time the vault was written to.
const HEADER_FILES: [&str; 2] = ["vault.json", "vault.json.bak"];

/// The local day (`YYYY-MM-DD`, the zone `offset_secs` east of UTC) of the newest modified time among the header files
/// in `folder`: the last day that vault was written. `None` when neither can be read, or the time is before 1970.
fn last_written_day(folder: &Path, offset_secs: i64) -> Option<String> {
    let newest = HEADER_FILES
        .iter()
        .filter_map(|file| fs::metadata(folder.join(file)).ok()?.modified().ok())
        .max()?;
    let secs = newest.duration_since(UNIX_EPOCH).ok()?.as_secs();
    Some(dates::local_date_of(secs, offset_secs))
}

/// The bytes of every regular file under `folder`, folders walked and links not followed. `None` on any read error:
/// a size is never a guess.
fn folder_size(folder: &Path) -> Option<u64> {
    let mut total = 0u64;
    let mut pending = vec![folder.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(&dir).ok()? {
            let entry = entry.ok()?;
            let kind = entry.file_type().ok()?;
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() {
                total = total.saturating_add(entry.metadata().ok()?.len());
            }
        }
    }
    Some(total)
}

/// What comes before `.before-restore` or `.before-restore-<2..=99>` at the end of `candidate` (any letter case), the names
/// the engine gives a replaced vault (spec §6.8): `None` for a name that does not end so.
fn pre_restore_head(candidate: &str) -> Option<&str> {
    let lower = candidate.to_ascii_lowercase();
    // ASCII lowercasing keeps every byte offset, and the marker is ASCII, so the split is on a character boundary.
    let at = lower.rfind(PRE_RESTORE)?;
    let (head, tail) = candidate.split_at(at);
    let numbered = &tail[PRE_RESTORE.len()..];
    let number_ok = numbered.is_empty()
        || numbered.strip_prefix('-').is_some_and(|number| {
            !number.starts_with('0')
                && number.bytes().all(|b| b.is_ascii_digit())
                && matches!(number.parse::<u8>(), Ok(2..=99))
        });
    number_ok.then_some(head)
}

/// Whether `candidate` is `folder` followed by `.before-restore` or `.before-restore-<2..=99>`, the names the engine
/// gives a replaced vault (spec §6.8), compared as Windows compares names (any letter case).
fn is_pre_restore_name(candidate: &str, folder: &str) -> bool {
    pre_restore_head(candidate).is_some_and(|head| same_name(OsStr::new(head), OsStr::new(folder)))
}

/// The name the swap will give the older copy of the vault at `existing`, told before the person says yes: the first of
/// `<folder>.before-restore` and `<folder>.before-restore-2` to `-99` with nothing at it, which is the engine's own rule
/// (anything at the name counts, a file or a dangling link too, by `symlink_metadata`). `None` when all ninety-nine are
/// taken (the swap then refuses, as it always did), or when the folder has no name that is text. A name that cannot be
/// looked at counts as taken: the answer is never a name the swap might not use.
fn kept_as_name(existing: &Path) -> Option<String> {
    let name = existing.file_name()?.to_str()?;
    let parent = existing.parent()?;
    (1..=99)
        .map(|n| match n {
            1 => format!("{name}{PRE_RESTORE}"),
            n => format!("{name}{PRE_RESTORE}-{n}"),
        })
        .find(|candidate| {
            matches!(
                fs::symlink_metadata(parent.join(candidate)),
                Err(e) if e.kind() == io::ErrorKind::NotFound
            )
        })
}

/// Where an Ask 8 restore goes: a new folder of the default name, or, when something is at that name (the damaged vault's
/// own folder), the new-folder question with a name that is free.
enum Beside {
    Into(String),
    Taken(String),
    /// A readable copy of the vault is in the folder already: refused, as the engine refuses a new folder there.
    Sibling,
}

/// Nothing at all is at `path` (a dangling link counts, and so does a letter case that differs: `symlink_metadata`).
fn is_free(path: &Path) -> bool {
    matches!(fs::symlink_metadata(path), Err(e) if e.kind() == io::ErrorKind::NotFound)
}

/// The name suggested for a new folder when the default one is taken.
fn restored_name(default: &str) -> String {
    format!("{default} (restored)")
}

/// The one folder directly inside `parent` that holds the vault `id` (either header copy, no key needed), as the engine
/// looks for the vault a restore replaces: hidden folders (a staging folder among them) and older copies are not it, nor
/// a link. For what the page is told before the copy; the engine's own look decides what is replaced.
fn existing_vault_in(parent: &Path, id: &VaultId) -> Option<PathBuf> {
    fs::read_dir(parent)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            !name.starts_with('.')
                && pre_restore_head(&name).is_none()
                && entry.file_type().is_ok_and(|kind| kind.is_dir())
        })
        .map(|entry| entry.path())
        .find(|dir| read_vault_id(dir).is_ok_and(|found| found == *id))
}

/// Whether `a` and `b` are one folder, however each is spelled (a `\\?\` form or not, any letter case).
fn same_folder(a: &Path, b: &Path) -> bool {
    let canonical = |path: &Path| fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    same_path(&canonical(a), &canonical(b))
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;
    use std::sync::mpsc;

    use lockbox_core::Vault;
    use lockbox_core::internals::fsio::testutil::{make_dir_link, names};
    use lockbox_core::internals::fsio::{VolumeInfo, failpoint, set_volume_override};
    use serde_json::{Value, json};
    use zeroize::Zeroizing;

    use super::*;
    use crate::jobs::{CloseReason, JobScope, OperationId};
    use crate::os::{Clock, DriveType, KnownFolder, OsSignal};
    use crate::session::{SessionState, VaultRef};
    use crate::testing::{FakeVolume, TEST_PASSWORD, TestShell, heavy};

    /// Always disarms, so a failing test cannot leak a failpoint into the next one on this thread.
    struct Cleanup;
    impl Drop for Cleanup {
        fn drop(&mut self) {
            failpoint::disarm_all();
        }
    }

    const LOCKED: Option<ShellError> = Some(ShellError::Locked);
    const CANCELLED: Option<ShellError> = Some(ShellError::Cancelled);
    const BUSY: Option<ShellError> = Some(BUSY_RESTORE);
    const PATIENCE: Duration = Duration::from_secs(20);

    fn password() -> CredentialArg {
        CredentialArg::Password(Zeroizing::new(TEST_PASSWORD.to_owned()))
    }

    fn done<T>(outcome: Outcome<T>) -> T {
        match outcome {
            Outcome::Done(value) => value,
            Outcome::Confirm(_) => panic!("asked first"),
            Outcome::Dismissed => panic!("dismissed"),
        }
    }

    fn restore_pending() -> ShellError {
        CoreError::RestorePending.into()
    }

    /// The folder of the first vault the shell lists, and the folder that holds the shell's vaults.
    fn vault_dir(ts: &TestShell) -> PathBuf {
        ts.shell.registry.entries()[0].1.clone()
    }

    fn vaults_folder(ts: &TestShell) -> PathBuf {
        vault_dir(ts).parent().unwrap().to_path_buf()
    }

    /// A backup of the session's vault in the test's `Backups` folder.
    fn backup_of(ts: &TestShell, s: SessionId, g: u64, file: &str) -> PathBuf {
        let dest = ts.folder("Backups").join(file);
        ts.dialogs.answer(Some(dest.clone()));
        done(ts.shell.backup_vault(s, g, 1).unwrap().data);
        dest
    }

    /// The page's number for the call under test.
    const REQUEST: u32 = 7;

    /// What is typed in the one box of "Restore a backup".
    fn typed(text: &str) -> CredentialArg {
        CredentialArg::PasswordOrKey(Zeroizing::new(text.to_owned()))
    }

    fn working() -> CredentialArg {
        typed(TEST_PASSWORD)
    }

    fn wrong() -> CredentialArg {
        typed("another long password")
    }

    /// A token as the page would send one back.
    fn token(hex: &str) -> Token {
        serde_json::from_value(json!(hex)).unwrap()
    }

    /// A well-formed token nothing holds.
    fn unheld() -> Token {
        token(&"0123456789abcdef".repeat(2))
    }

    /// Picks `backup` in the picker (answered for it).
    fn pick(ts: &TestShell, backup: &Path) -> RestorePick {
        ts.dialogs.answer(Some(backup.to_path_buf()));
        done(ts.shell.restore_pick(None, None).unwrap())
    }

    /// The pick's password check, with the right password.
    fn check(ts: &TestShell, choice: &Token) -> RestoreChecked {
        heavy(|| ts.shell.restore_check(choice, working())).unwrap()
    }

    /// The folder picker answered for `parent` and the pick moved there.
    fn choose(ts: &TestShell, choice: &Token, parent: &Path) -> RestoreChecked {
        ts.dialogs.answer(Some(parent.to_path_buf()));
        done(ts.shell.restore_choose_folder(choice).unwrap())
    }

    /// A pick of `backup`, checked with the right password, in `parent`: what the page holds before it asks for the copy.
    fn chosen(ts: &TestShell, backup: &Path, parent: &Path) -> Token {
        let held = pick(ts, backup);
        check(ts, &held.choice);
        choose(ts, &held.choice, parent);
        held.choice
    }

    /// Asks for the copy of the held pick.
    fn copy(ts: &TestShell, choice: &Token) -> ShellResult<Outcome<RestorePreparedView>> {
        heavy(|| ts.shell.restore_prepare(choice, REQUEST))
    }

    /// The whole of 24a and 24b, then the copy of `backup` into `parent`.
    fn prepare(
        ts: &TestShell,
        backup: &Path,
        parent: &Path,
    ) -> ShellResult<Outcome<RestorePreparedView>> {
        let choice = chosen(ts, backup, parent);
        copy(ts, &choice)
    }

    fn prepared(ts: &TestShell, backup: &Path, parent: &Path) -> RestorePreparedView {
        done(prepare(ts, backup, parent).unwrap())
    }

    /// A restore from start to finish.
    fn restore_once(ts: &TestShell, backup: &Path, parent: &Path) -> RestoredView {
        let view = prepared(ts, backup, parent);
        ts.shell.restore_commit(view.restore, REQUEST).unwrap()
    }

    /// The usual vaults folder, where a restore goes until the person picks another.
    fn usual_folder(ts: &TestShell) -> PathBuf {
        ts.env.folder(KnownFolder::Profile).join("Lockbox Vaults")
    }

    /// A vault the engine makes in a folder of its own (`Source`), open as a session but not on the shell's vault list:
    /// its session, generation and recovery key. A backup of it restores into a folder with nothing of its ID in it.
    fn source_vault(
        ts: &TestShell,
        name: &str,
    ) -> (SessionId, u64, lockbox_core::recovery::RecoverySecret) {
        let created = heavy(|| Vault::create(&ts.folder("Source"), name, TEST_PASSWORD).unwrap());
        let location = Location::folder(created.vault.dir()).unwrap();
        let (recovery, vault) = (created.recovery, created.vault);
        let opened = ts.shell.sessions.open(Some(location.clone()), None, |_| {
            Ok(OpenStep::Session(location, Opened::Writable(vault), ()))
        });
        let Ok(Outcome::Done(tagged)) = opened else {
            panic!("the session did not open");
        };
        (tagged.session, tagged.generation, recovery)
    }

    /// Makes the engine see `free` bytes free on every drive (`None`: unknown), on this thread only.
    fn pretend_free(free: Option<u64>) {
        set_volume_override(Some(VolumeInfo {
            free_bytes: free,
            max_file_bytes: None,
        }));
    }

    /// Always ends the pretence, so a failing test cannot leak it into the next one on this thread.
    struct Volume;
    impl Drop for Volume {
        fn drop(&mut self) {
            set_volume_override(None);
        }
    }

    /// The restore jobs' events: (the page's number, the operation) of each `job-started` of kind `restore`.
    fn restore_jobs(ts: &TestShell) -> Vec<(u64, u64)> {
        ts.events
            .started()
            .iter()
            .filter(|event| event["kind"] == json!("restore"))
            .map(|event| {
                (
                    event["request"].as_u64().unwrap(),
                    event["operation"].as_u64().unwrap(),
                )
            })
            .collect()
    }

    /// The progress events of the job `operation`.
    fn progress_of(ts: &TestShell, operation: u64) -> Vec<Value> {
        ts.events
            .progress()
            .into_iter()
            .filter(|event| event["operation"] == json!(operation))
            .collect()
    }

    /// The staging folders in `parent`.
    fn staging_in(parent: &Path) -> Vec<String> {
        names(parent)
            .into_iter()
            .filter(|name| name.starts_with(".restore-"))
            .collect()
    }

    /// Waits until a lock has ended the restore, and its cleanup worker is done.
    fn ended(ts: &TestShell) {
        let start = Instant::now();
        while !ts.shell.restore.is_idle() {
            assert!(start.elapsed() < PATIENCE, "the restore did not end");
            thread::sleep(Duration::from_millis(2));
        }
        assert!(ts.shell.restore.wait_idle(Instant::now() + PATIENCE));
    }

    fn titles(ts: &TestShell, s: SessionId, g: u64) -> Vec<String> {
        let list = ts.shell.list_items(s, g).unwrap().data;
        let mut titles: Vec<String> = list.items.into_iter().map(|item| item.title).collect();
        titles.sort();
        titles
    }

    /// The vault `id` of the vault list unlocked with the test password: its session and generation.
    fn unlock(ts: &TestShell, id: u32) -> (SessionId, u64) {
        let unlocked = heavy(|| {
            ts.shell
                .unlock_vault(id, Zeroizing::new(TEST_PASSWORD.to_owned()))
        })
        .unwrap();
        (unlocked.session, unlocked.generation)
    }

    /// A restore that died with the old vault moved aside and the new one not yet in place: the journal says
    /// `swapping`, the old vault is in its `.before-restore` folder, and its own place is empty. The engine's recovery
    /// is made to fail, inside the commit and in the shell's retry right after it.
    fn crash_mid_swap(ts: &TestShell, backup: &Path, parent: &Path) {
        let view = prepared(ts, backup, parent);
        failpoint::arm("restore.after_move_existing");
        failpoint::arm("recover.under_lock");
        let error = ts.shell.restore_commit(view.restore, REQUEST).unwrap_err();
        failpoint::disarm_all();
        assert_eq!(error, restore_pending());
    }

    /// A second shell over the same state folder and vaults: the app after a restart ([`TestShell::restarted`]).
    fn restarted(ts: &TestShell) -> Arc<Shell> {
        ts.restarted()
    }

    /// How recovery settled a restore, when the notice says it did.
    fn how_of(notice: &RestoreNotice) -> Option<Recovered> {
        match notice {
            RestoreNotice::Recovered { how, .. } => Some(*how),
            _ => None,
        }
    }

    /// The `kind` and `state` of each notice the page was sent, in order.
    fn sent(ts: &TestShell) -> Vec<(String, String)> {
        ts.events
            .notices()
            .iter()
            .map(|n| {
                let text = |key: &str| n[key].as_str().unwrap_or_default().to_owned();
                (text("kind"), text("state"))
            })
            .collect()
    }

    // ------------------------------------------------------------------------------------------------------------
    // Launch and recovery.
    // ------------------------------------------------------------------------------------------------------------

    /// A crash mid-swap is rolled back by the launch work, before the shell answers anything, and told first of what
    /// launch found.
    #[test]
    fn launch_runs_recovery_before_anything() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "report.pdf", b"report");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        crash_mid_swap(&ts, &backup, &parent);
        assert!(!dir.exists(), "the old vault is aside");

        let restarted = restarted(&ts);
        // What a command would see before the launch work: the vault is gone from its place.
        assert!(!restarted.registry.list().unwrap()[0].available);
        // Another finding of the launch, which comes after the restore's.
        fs::create_dir_all(
            restarted
                .paths
                .open
                .join("0123456789abcdef0123456789abcdef"),
        )
        .unwrap();
        let sent_before = sent(&ts).len();

        restarted.launch_work();

        assert_eq!(
            how_of(&restarted.restore_notice()),
            Some(Recovered::RolledBack)
        );
        assert_eq!(restarted.restore.recoveries(), 1);
        let kept: Vec<Value> = restarted
            .launch_notices()
            .iter()
            .map(|n| serde_json::to_value(n).unwrap())
            .collect();
        let kinds: Vec<&str> = kept.iter().map(|n| n["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["restore", "open_cleanup"], "recovery first");
        assert_eq!(kept[0]["state"], "recovered");
        assert_eq!(kept[0]["how"], "rolled_back");
        let told = &sent(&ts)[sent_before..];
        assert_eq!(told[0], ("restore".to_owned(), "recovered".to_owned()));
        // The vault is back, the staging folder and the journal are gone.
        let listed = restarted.registry.list().unwrap();
        assert!(listed[0].available);
        assert_eq!(listed[0].name.as_deref(), Some("Family"));
        assert!(dir.exists());
        assert!(staging_in(&parent).is_empty());
        assert!(!restarted.paths.journal.exists());
        let only = dir.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(names(&parent), [only]);
    }

    /// A first-ever launch has no state folder: nothing to recover, nothing created, nothing told.
    #[test]
    fn launch_with_no_state_folder_does_nothing() {
        let ts = TestShell::new();
        assert!(!ts.shell.paths.root.exists());
        ts.shell.launch_work();
        assert_eq!(ts.shell.restore_notice(), RestoreNotice::None);
        assert!(ts.shell.launch_notices().is_empty());
        assert!(!ts.shell.paths.root.exists(), "nothing was created");
        assert_eq!(ts.shell.dismiss_restore(true).ok().map(|_| ()), Some(()));
        assert!(!ts.shell.paths.root.exists(), "nor by a dismissal");
    }

    /// A journal whose parent folder is gone (its drive is not plugged in) is told apart from one that is stuck: the
    /// paths are shown, nothing is decided, and reconnecting lets a retry finish the job.
    #[test]
    fn drive_missing_is_told_apart() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        crash_mid_swap(&ts, &backup, &parent);
        assert!(matches!(
            ts.shell.restore_notice(),
            RestoreNotice::Pending(_)
        ));

        let unplugged = parent.with_file_name("Lockbox Vaults (unplugged)");
        fs::rename(&parent, &unplugged).unwrap();
        let RestoreNotice::DriveMissing(paths) = ts.shell.retry_restore_recovery().unwrap() else {
            panic!("not told apart");
        };
        assert_eq!(paths.step, JournalStep::Swapping);
        let folder = dir.file_name().unwrap().to_string_lossy().into_owned();
        assert!(paths.staging.contains(r"\.restore-"), "{}", paths.staging);
        assert!(paths.target.ends_with(&folder), "{}", paths.target);
        assert_eq!(
            paths
                .before_restore
                .as_deref()
                .map(|b| b.ends_with(".before-restore")),
            Some(true)
        );
        assert!(
            !paths.target.starts_with(r"\\?\"),
            "shown as the user knows it"
        );
        assert!(ts.shell.paths.journal.exists(), "nothing was decided");
        assert_eq!(sent(&ts).last().unwrap().1, "drive_missing");

        fs::rename(&unplugged, &parent).unwrap();
        assert_eq!(
            how_of(&ts.shell.retry_restore_recovery().unwrap()),
            Some(Recovered::RolledBack)
        );
        assert!(dir.exists());
        assert!(!ts.shell.paths.journal.exists());
    }

    /// A journal recovery cannot act on is shown, and dismissing it is a question first; the answer removes the
    /// journal (and a validated staging folder) and touches nothing else.
    #[test]
    fn unclear_journal_shown_and_dismissable() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        ts.shell.sessions.lock(s, LockReason::Manual);
        let journal = ts.shell.paths.journal.clone();

        // A damaged journal.
        fs::write(&journal, b"not a journal").unwrap();
        let before = names(&parent);
        ts.shell.launch_work();
        let RestoreNotice::Unclear {
            journal: shown_at,
            paths,
        } = ts.shell.restore_notice()
        else {
            panic!("not unclear");
        };
        assert_eq!(shown_at, shown(&journal));
        assert!(paths.is_none());
        assert_eq!(ts.shell.launch_notices().len(), 1);
        let Outcome::Confirm(Confirm::Dismissal { leaves }) =
            ts.shell.dismiss_restore(false).unwrap()
        else {
            panic!("not asked");
        };
        assert_eq!(leaves, Leaves::nothing_known());
        assert!(journal.exists(), "asking dismisses nothing");
        done(ts.shell.dismiss_restore(true).unwrap());
        assert!(!journal.exists());
        assert_eq!(ts.shell.restore_notice(), RestoreNotice::None);
        assert_eq!(names(&parent), before, "nothing else touched");
        let _ = g;

        // A valid journal over a disk the recovery table does not cover: the target, the pre-restore folder and the
        // staging folder all there.
        let staging = parent.join(".restore-0123456789abcdef0123456789abcdef");
        let target = parent.join("Zed-00000000");
        let aside = parent.join("Zed-00000000.before-restore");
        for folder in [&staging, &target, &aside] {
            fs::create_dir(folder).unwrap();
            fs::write(folder.join("marker.txt"), b"mine").unwrap();
        }
        let entry = json!({
            "version": 1, "step": "swapping",
            "staging": staging, "target": target, "before_restore": aside,
        });
        fs::write(&journal, serde_json::to_vec(&entry).unwrap()).unwrap();
        let RestoreNotice::Unclear {
            paths: Some(paths), ..
        } = ts.shell.recover()
        else {
            panic!("not unclear");
        };
        assert_eq!(paths.step, JournalStep::Swapping);
        assert_eq!(paths.before_restore, Some(shown(&aside)));
        let Outcome::Confirm(Confirm::Dismissal { leaves }) =
            ts.shell.dismiss_restore(false).unwrap()
        else {
            panic!("not asked");
        };
        assert_eq!(
            leaves,
            Leaves {
                staging: None,
                before_restore: Some(shown(&aside)),
            }
        );
        done(ts.shell.dismiss_restore(true).unwrap());
        assert!(!journal.exists());
        assert!(!staging.exists(), "the validated staging folder goes");
        for folder in [&target, &aside, &dir] {
            assert!(folder.exists(), "{folder:?}");
        }
        assert!(aside.join("marker.txt").exists() && target.join("marker.txt").exists());
    }

    /// The engine's `RestorePending` at a commit runs recovery once more at once, tells the page, and answers the
    /// error; a retry settles it.
    #[test]
    fn restore_pending_runs_recovery_at_once() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        let view = prepared(&ts, &backup, &parent);
        failpoint::arm("restore.after_move_existing");
        failpoint::arm("recover.under_lock");
        assert_eq!(ts.shell.restore.recoveries(), 0);

        let error = ts.shell.restore_commit(view.restore, REQUEST).unwrap_err();
        failpoint::disarm_all();

        assert_eq!(error, restore_pending());
        assert_eq!(ts.shell.restore.recoveries(), 1, "once, at once");
        let RestoreNotice::Pending(paths) = ts.shell.restore_notice() else {
            panic!("not pending");
        };
        assert_eq!(paths.step, JournalStep::Swapping);
        assert_eq!(sent(&ts).last().unwrap().1, "pending");
        assert!(ts.shell.restore.is_idle(), "the restore is over");
        assert_eq!(
            ts.shell.restore_commit(view.restore, REQUEST).unwrap_err(),
            ShellError::NotFound
        );
        assert!(!dir.exists(), "the journal waits for the retry");

        assert_eq!(
            how_of(&ts.shell.retry_restore_recovery().unwrap()),
            Some(Recovered::RolledBack)
        );
        assert!(dir.exists());
    }

    /// A journal found when no restore of ours is alive (a crash, or a recovery that failed): `restore_prepare` runs
    /// recovery and answers with what it found, instead of starting.
    #[test]
    fn in_progress_with_no_restore_of_ours_recovers() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        crash_mid_swap(&ts, &backup, &parent);
        let recoveries = ts.shell.restore.recoveries();

        let answer = prepare(&ts, &backup, &parent).unwrap();
        let Outcome::Confirm(Confirm::Recovery { notice }) = answer else {
            panic!("not answered with the notice");
        };
        assert_eq!(how_of(&notice), Some(Recovered::RolledBack));
        assert_eq!(ts.shell.restore.recoveries(), recoveries + 1);
        assert!(dir.exists(), "the old vault is back");
        assert!(!ts.shell.paths.journal.exists());
        assert!(ts.shell.restore.is_idle());
        assert_eq!(sent(&ts).last().unwrap().1, "recovered");

        // And the restore can now be started.
        let view = prepared(&ts, &backup, &parent);
        assert!(view.replaces_existing);
    }

    /// While a restore of ours is alive, recovery (which removes a staging folder) and a dismissal are refused, and
    /// no second restore starts: while preparing, prepared and committing.
    #[test]
    fn recovery_refused_while_our_restore_lives() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        let _ = dir;

        let probe = |ts: &TestShell| -> Vec<Option<ShellError>> {
            vec![
                ts.shell.retry_restore_recovery().err(),
                ts.shell.dismiss_restore(false).err(),
                ts.shell.dismiss_restore(true).err(),
                ts.shell.restore_prepare(&unheld(), REQUEST).err(),
                ts.shell.restore_pick(None, None).err(),
            ]
        };
        let seen = Rc::new(RefCell::new(Vec::new()));
        let observe = |step: &'static str| {
            let (shell, seen) = (Arc::clone(&ts.shell), Rc::clone(&seen));
            let (dialogs, journal) = (Arc::clone(&ts.dialogs), ts.shell.paths.journal.clone());
            let staging = parent.clone();
            failpoint::observe(
                step,
                Box::new(move || {
                    let opened = dialogs.opened();
                    let refused = vec![
                        shell.retry_restore_recovery().err(),
                        shell.dismiss_restore(false).err(),
                        shell.dismiss_restore(true).err(),
                        shell.restore_prepare(&unheld(), REQUEST).err(),
                        shell.restore_pick(None, None).err(),
                    ];
                    // The journal and the staging folder are as the restore left them, and no picker opened.
                    let intact = journal.exists() && !staging_in(&staging).is_empty();
                    seen.borrow_mut()
                        .push((step, refused, intact, dialogs.opened() == opened));
                }),
            );
        };
        observe("restore.after_entry");
        observe("restore.after_journal");

        let view = prepared(&ts, &backup, &parent);
        let in_prepared = probe(&ts);
        assert!(!staging_in(&parent).is_empty());
        ts.shell.restore_commit(view.restore, REQUEST).unwrap();

        let all_busy = vec![BUSY; 5];
        assert_eq!(in_prepared, all_busy, "prepared");
        let seen = seen.borrow();
        assert_eq!(seen.len(), 2, "preparing, then committing");
        assert_eq!(seen[0].0, "restore.after_entry");
        assert_eq!(seen[1].0, "restore.after_journal");
        for (step, refused, intact, no_picker) in seen.iter() {
            assert_eq!(*refused, all_busy, "{step}");
            assert!(intact, "{step}: recovery must not have touched the restore");
            assert!(no_picker, "{step}");
        }
        drop(seen);

        // Nothing alive: recovery may run again (nothing to do).
        assert_eq!(
            ts.shell.retry_restore_recovery().unwrap(),
            RestoreNotice::None
        );
    }

    // ------------------------------------------------------------------------------------------------------------
    // Starting a restore.
    // ------------------------------------------------------------------------------------------------------------

    /// A vault folder whose headers are both unreadable cannot be told to be the same vault: the default name is
    /// taken by it, and the answer is a question with `<folder name> (restored)`. The backup, parent and credential
    /// are kept: confirming restores beside it without asking for files again, and the damaged folder is untouched.
    #[test]
    fn unreadable_vault_offers_new_folder() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Clients");
        ts.stored_file(s, g, "report.pdf", b"report");
        let backup = backup_of(&ts, s, g, "clients.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        let short = read_vault_id(&dir).unwrap().to_hex()[..8].to_owned();
        ts.shell.sessions.lock(s, LockReason::Manual);
        for header in ["vault.json", "vault.json.bak"] {
            fs::write(dir.join(header), b"damaged").unwrap();
        }
        let damaged_before = names(&dir);

        let Outcome::Confirm(Confirm::NewFolder { suggested, token }) =
            prepare(&ts, &backup, &parent).unwrap()
        else {
            panic!("not asked for a new folder");
        };
        assert_eq!(suggested, format!("Clients-{short} (restored)"));
        assert!(staging_in(&parent).is_empty() && !ts.shell.paths.journal.exists());
        assert!(ts.shell.restore.is_idle());

        // Only the new folder's name may answer this question (and the token is used up either way).
        let pickers = ts.dialogs.opened();
        let wrong = heavy(|| ts.shell.restore_prepare_confirm(&token, None, REQUEST)).err();
        assert_eq!(
            wrong,
            Some(ShellError::InvalidInput {
                what: "restore answer"
            })
        );
        let Outcome::Confirm(Confirm::NewFolder { token, .. }) =
            prepare(&ts, &backup, &parent).unwrap()
        else {
            panic!("not asked again");
        };
        let pickers_again = ts.dialogs.opened();

        let view = done(
            heavy(|| {
                ts.shell
                    .restore_prepare_confirm(&token, Some(suggested.clone()), REQUEST)
            })
            .unwrap(),
        );
        assert_eq!(ts.dialogs.opened(), pickers_again, "no new pick");
        assert!(pickers < pickers_again);
        assert_eq!(
            (view.name.as_str(), view.replaces_existing),
            ("Clients", false)
        );
        let again = heavy(|| {
            ts.shell
                .restore_prepare_confirm(&token, Some("x".into()), REQUEST)
        })
        .err();
        assert_eq!(again, Some(ShellError::NotFound), "one answer per question");
        ts.shell.restore_discard(view.restore).unwrap();

        // Once more, to the end.
        let Outcome::Confirm(Confirm::NewFolder { token, suggested }) =
            prepare(&ts, &backup, &parent).unwrap()
        else {
            panic!("not asked a third time");
        };
        let view = done(
            heavy(|| {
                ts.shell
                    .restore_prepare_confirm(&token, Some(suggested.clone()), REQUEST)
            })
            .unwrap(),
        );
        let restored = ts.shell.restore_commit(view.restore, REQUEST).unwrap();
        assert_eq!(
            restored,
            RestoredView {
                vault: 2,
                before_restore: false
            }
        );
        assert!(parent.join(&suggested).is_dir());
        assert_eq!(
            names(&dir),
            damaged_before,
            "the damaged folder is untouched"
        );
        assert_eq!(fs::read(dir.join("vault.json")).unwrap(), b"damaged");
        let (s2, g2) = unlock(&ts, restored.vault);
        assert_eq!(titles(&ts, s2, g2), ["report.pdf"]);
    }

    /// A name that cannot be a vault's folder, and one already taken, are the engine's refusals and come with no
    /// path.
    #[test]
    fn new_folder_name_is_checked_by_the_engine() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Clients");
        let backup = backup_of(&ts, s, g, "clients.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        ts.shell.sessions.lock(s, LockReason::Manual);
        for header in ["vault.json", "vault.json.bak"] {
            fs::write(dir.join(header), b"damaged").unwrap();
        }
        let before = names(&parent);
        // One pick for every try: a refused name keeps it, and the question comes again.
        let choice = chosen(&ts, &backup, &parent);
        for name in ["", "a\\b", "..", "Clients.before-restore"] {
            let Outcome::Confirm(Confirm::NewFolder { token, .. }) = copy(&ts, &choice).unwrap()
            else {
                panic!("not asked for a new folder");
            };
            let refused = heavy(|| {
                ts.shell
                    .restore_prepare_confirm(&token, Some(name.into()), REQUEST)
            })
            .err();
            assert!(
                matches!(refused, Some(ShellError::Core(view)) if view.kind == "invalid_input"),
                "{name:?}: {refused:?}"
            );
        }
        assert_eq!(names(&parent), before, "nothing written");
        assert!(ts.shell.restore.is_idle());
    }

    /// A parent folder is checked like any vault location, before anything is written.
    #[test]
    fn restore_parent_location_checked() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let refused = |what: &'static str, parent: &Path| {
            let answer = prepare(&ts, &backup, parent).err();
            assert_eq!(answer, Some(ShellError::InvalidInput { what }), "{what}");
            assert!(names(parent).is_empty(), "{what}: nothing written");
            assert!(!ts.shell.paths.journal.exists(), "{what}");
            assert!(ts.shell.restore.is_idle(), "{what}");
        };
        let roaming = ts.env.folder(KnownFolder::RoamingAppData).join("Elsewhere");
        fs::create_dir_all(&roaming).unwrap();
        refused("app data folder", &roaming);
        let usb = ts.folder("Usb");
        ts.volumes.mount(
            &usb,
            FakeVolume {
                drive: DriveType::Removable,
                file_system: "NTFS",
                label: "USB",
            },
        );
        refused("removable drive", &usb);
        let fat = ts.folder("Fat");
        ts.volumes.mount(
            &fat,
            FakeVolume {
                drive: DriveType::Fixed,
                file_system: "FAT32",
                label: "OLD",
            },
        );
        refused("file system not supported", &fat);
    }

    /// A parent under a sync root asks first, writing nothing; the yes goes on with the picks kept.
    #[test]
    fn cloud_restore_parent_asks_first() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let cloud = ts.folder("Cloud");
        ts.volumes.add_sync_root(&cloud);

        let Outcome::Confirm(Confirm::CloudFolder { token }) =
            prepare(&ts, &backup, &cloud).unwrap()
        else {
            panic!("not asked");
        };
        assert!(names(&cloud).is_empty(), "nothing written");
        assert!(!ts.shell.paths.journal.exists());
        let pickers = ts.dialogs.opened();

        // A new folder's name does not answer the cloud question.
        let name_for_cloud = heavy(|| {
            ts.shell
                .restore_prepare_confirm(&token, Some("x".into()), REQUEST)
        });
        assert_eq!(
            name_for_cloud.err(),
            Some(ShellError::InvalidInput {
                what: "restore answer"
            })
        );
        let Outcome::Confirm(Confirm::CloudFolder { token }) =
            prepare(&ts, &backup, &cloud).unwrap()
        else {
            panic!("not asked again");
        };
        let pickers = pickers + 2;

        let view = done(heavy(|| ts.shell.restore_prepare_confirm(&token, None, REQUEST)).unwrap());
        assert_eq!(ts.dialogs.opened(), pickers, "no new pick");
        assert!(!view.replaces_existing);
        let restored = ts.shell.restore_commit(view.restore, REQUEST).unwrap();
        assert_eq!(restored.vault, 2);
        assert_eq!(names(&cloud).len(), 1, "restored in the cloud folder");
        let again = heavy(|| ts.shell.restore_prepare_confirm(&token, None, REQUEST)).err();
        assert_eq!(again, Some(ShellError::NotFound));
    }

    /// A lock of all vaults while the pickers are open: `Locked`, nothing started; a closed picker still `Dismissed`;
    /// a question waiting for its yes is dropped by a lock.
    #[test]
    fn lock_during_the_pickers_answers_locked() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let parent = vaults_folder(&ts);
        let lock_in_picker = || {
            let shell = Arc::clone(&ts.shell);
            ts.dialogs.during_next_dialog(Box::new(move || {
                shell.sessions.lock_all(LockReason::Manual)
            }));
        };
        // The backup's picker: a lock while it is open is `Locked`, and nothing is held (the finished backup's own offer
        // to test it is one more choice, which the lock dropped).
        lock_in_picker();
        ts.dialogs.answer(Some(backup.clone()));
        assert_eq!(ts.shell.restore_pick(None, None).err(), LOCKED);
        assert!(!ts.shell.paths.journal.exists() && staging_in(&parent).is_empty());
        assert!(ts.shell.restore.is_idle());
        assert_eq!(ts.shell.sessions.pending().len(), 0, "nothing was held");

        // A closed picker shows nothing: dismissed, locked or not.
        lock_in_picker();
        assert!(matches!(
            ts.shell.restore_pick(None, None),
            Ok(Outcome::Dismissed)
        ));
        assert!(matches!(
            ts.shell.restore_pick(None, None),
            Ok(Outcome::Dismissed)
        ));
        assert_eq!(ts.shell.sessions.pending().len(), 0);

        // The folder's picker: a lock while it is open is `Locked` (the pick is gone with it); closed, it is
        // `Dismissed` and the pick stays as it was.
        let held = pick(&ts, &backup);
        check(&ts, &held.choice);
        assert!(matches!(
            ts.shell.restore_choose_folder(&held.choice),
            Ok(Outcome::Dismissed)
        ));
        assert_eq!(ts.shell.sessions.pending().len(), 1, "the pick stays");
        lock_in_picker();
        ts.dialogs.answer(Some(parent.clone()));
        assert_eq!(ts.shell.restore_choose_folder(&held.choice).err(), LOCKED);
        assert_eq!(ts.shell.sessions.pending().len(), 0);

        // A question waits in Pending; a lock of all vaults drops it.
        let cloud = ts.folder("Cloud");
        ts.volumes.add_sync_root(&cloud);
        let Outcome::Confirm(Confirm::CloudFolder { token }) =
            prepare(&ts, &backup, &cloud).unwrap()
        else {
            panic!("not asked");
        };
        ts.shell.sessions.lock_all(LockReason::Manual);
        let answer = heavy(|| ts.shell.restore_prepare_confirm(&token, None, REQUEST)).err();
        assert_eq!(answer, Some(ShellError::NotFound));
        assert!(names(&cloud).is_empty());
    }

    /// A wrong password is the engine's refusal, before anything is written, and leaves no restore alive; the pick
    /// stays, with nothing checked, so nothing can be copied until a password has worked.
    #[test]
    fn wrong_password_starts_nothing() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let parent = vaults_folder(&ts);
        let before = names(&parent);
        let held = pick(&ts, &backup);
        let refused = heavy(|| ts.shell.restore_check(&held.choice, wrong())).err();
        assert_eq!(refused, Some(CoreError::WrongPassword.into()));
        assert_eq!(names(&parent), before);
        assert!(!ts.shell.paths.journal.exists() && ts.shell.restore.is_idle());
        assert_eq!(
            ts.shell.restore_prepare(&held.choice, REQUEST).err(),
            Some(ShellError::ChoiceExpired),
            "nothing checked, nothing to copy"
        );
        assert!(
            ts.events
                .started()
                .iter()
                .all(|e| e["kind"] != json!("restore"))
        );
        assert_eq!(names(&parent), before);
    }

    /// A damaged vault list is told before the long work. A full one still lets a vault on it be replaced, and takes
    /// no new one.
    #[test]
    fn restore_checks_room_in_the_vault_list() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        ts.shell.sessions.lock(s, LockReason::Manual);
        let registry = ts.shell.paths.registry.clone();
        let listed = fs::read(&registry).unwrap();

        // Damaged.
        fs::write(&registry, b"junk").unwrap();
        let before = names(&parent);
        assert!(matches!(
            prepare(&ts, &backup, &parent).err(),
            Some(ShellError::Core(view)) if view.kind == "damaged"
        ));
        assert_eq!(names(&parent), before);
        assert!(!ts.shell.paths.journal.exists());
        fs::write(&registry, listed).unwrap();

        // Full: a thousand vaults, this one among them.
        let mut vaults: Vec<Value> = (2..=crate::registry::MAX_VAULTS)
            .map(|n| json!({ "id": n, "path": format!(r"\\?\C:\lockbox-test-fake\v{n}") }))
            .collect();
        vaults.push(json!({ "id": 1, "path": dir }));
        fs::write(
            &registry,
            serde_json::to_vec(&json!({ "version": 1, "vaults": vaults })).unwrap(),
        )
        .unwrap();
        let view = prepared(&ts, &backup, &parent);
        assert!(view.replaces_existing, "a vault on the list is replaced");
        ts.shell.restore_discard(view.restore).unwrap();
        let elsewhere = ts.folder("Elsewhere");
        let refused = prepare(&ts, &backup, &elsewhere).err();
        assert_eq!(refused, Some(ShellError::TooLarge { what: "vault list" }));
        assert!(names(&elsewhere).is_empty(), "no new vault without a place");
        assert!(!ts.shell.paths.journal.exists() && ts.shell.restore.is_idle());
    }

    // ------------------------------------------------------------------------------------------------------------
    // The five steps: the pick, the password check, the folder, the copy and the swap.
    // ------------------------------------------------------------------------------------------------------------

    /// 24a: the backup is picked first, and only its name and size come back, never its path. The password is asked for
    /// after, with no other picker; a closed picker leaves the pick as it was; picking another forgets the first; and
    /// there is one restore at a time.
    #[test]
    fn restore_picks_the_backup_before_the_password() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let size = fs::metadata(&backup).unwrap().len();
        let parent = vaults_folder(&ts);
        let before = names(&parent);
        let dialogs = ts.dialogs.opened();
        // The backup just made is held to be tested, too: not this flow's, and left alone by it.
        let others = ts.shell.sessions.pending().len();

        let held = pick(&ts, &backup);
        assert_eq!(held.file_name, "family.lockbox-backup");
        assert_eq!(held.size, size);
        let wire = serde_json::to_string(&held).unwrap();
        assert!(!wire.contains("Backups"), "the folder crossed: {wire}");
        assert_eq!(ts.dialogs.opened(), dialogs + 1, "one picker");
        assert!(ts.dialogs.folder_starts().is_empty(), "no folder dialog");
        assert_eq!(names(&parent), before, "nothing was written");
        assert_eq!(ts.shell.sessions.pending().len(), others + 1);

        // The password after the pick: no picker.
        assert_eq!(check(&ts, &held.choice).name, "Family");
        assert_eq!(ts.dialogs.opened(), dialogs + 1);

        // A closed picker leaves the pick as it was.
        assert!(matches!(
            ts.shell.restore_pick(Some(&held.choice), None),
            Ok(Outcome::Dismissed)
        ));
        check(&ts, &held.choice);

        // Another pick: the first is forgotten only once the new one is held.
        ts.dialogs.answer(Some(backup.clone()));
        let second = done(ts.shell.restore_pick(Some(&held.choice), None).unwrap());
        assert_ne!(
            serde_json::to_value(&second.choice).unwrap(),
            serde_json::to_value(&held.choice).unwrap(),
            "a new token for the new pick"
        );
        assert_eq!(ts.shell.sessions.pending().len(), others + 1);
        assert_eq!(
            heavy(|| ts.shell.restore_check(&held.choice, working())).err(),
            Some(ShellError::ChoiceExpired)
        );
        check(&ts, &second.choice);

        // One restore at a time: while one is alive no pick is made, and no picker opens.
        let view = prepared(&ts, &backup, &parent);
        let opened = ts.dialogs.opened();
        assert_eq!(ts.shell.restore_pick(None, None).err(), BUSY);
        assert_eq!(ts.dialogs.opened(), opened);
        ts.shell.restore_discard(view.restore).unwrap();
        pick(&ts, &backup);
    }

    /// A wrong password, or a file that is no backup, is told and the pick stays, so the person tries again without
    /// picking the file again: no picker opens, nothing is checked, and the right password then works.
    #[test]
    fn restore_pick_kept_through_a_wrong_password() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let others = ts.shell.sessions.pending().len();
        let held = pick(&ts, &backup);
        let dialogs = ts.dialogs.opened();

        for _ in 0..3 {
            let refused = heavy(|| ts.shell.restore_check(&held.choice, wrong())).err();
            assert_eq!(refused, Some(CoreError::WrongPassword.into()));
            assert_eq!(
                ts.shell.sessions.pending().len(),
                others + 1,
                "the pick stays"
            );
        }
        // Nothing was checked: the folder cannot be chosen and the copy cannot start, and neither opens a picker.
        assert_eq!(
            ts.shell.restore_choose_folder(&held.choice).err(),
            Some(ShellError::ChoiceExpired)
        );
        assert_eq!(
            ts.shell.restore_prepare(&held.choice, REQUEST).err(),
            Some(ShellError::ChoiceExpired)
        );
        assert_eq!(ts.dialogs.opened(), dialogs, "no picker");
        let right = check(&ts, &held.choice);
        assert_eq!(right.name, "Family");
        assert_eq!(ts.dialogs.opened(), dialogs, "no picker for the password");

        // A file that is no backup is refused the same way, and the pick stays.
        let junk = ts.folder("Backups").join("junk.lockbox-backup");
        fs::write(&junk, b"not a backup").unwrap();
        let bad = pick(&ts, &junk);
        let first = heavy(|| ts.shell.restore_check(&bad.choice, working())).err();
        assert!(matches!(first, Some(ShellError::Core(_))), "{first:?}");
        let again = heavy(|| ts.shell.restore_check(&bad.choice, working())).err();
        assert_eq!(first, again);
        assert_eq!(ts.shell.sessions.pending().len(), others + 2);
    }

    /// 24a's Continue: the backup is opened (not unpacked) to say what it holds: the vault's name, the day it was made in
    /// the PC's own time zone, and where it would go, in the usual folder to begin with (which is not made yet).
    #[test]
    fn restore_check_answers_the_name_and_the_usual_folder() {
        let ts = TestShell::new();
        let (s, g, _) = source_vault(&ts, "Clients");
        let backup = backup_of(&ts, s, g, "clients.lockbox-backup");
        let usual = usual_folder(&ts);
        let held = pick(&ts, &backup);

        let view = check(&ts, &held.choice);
        assert_eq!(view.name, "Clients");
        assert!(view.usual && !view.replaces_existing);
        let id = ts
            .shell
            .sessions
            .read(s, g, |vault, _| match vault {
                VaultRef::Writable(vault) => Ok(vault.id()),
                VaultRef::ReadOnly(_) => unreachable!("a writable session"),
            })
            .unwrap()
            .data;
        assert_eq!(
            view.folder_shown,
            shown(&usual.join(folder_name("Clients", &id)))
        );
        assert!(!usual.exists(), "nothing is made by a check");

        // The day it was made, as the PC's zone names it: the same moment is another day on the other side of the date
        // line. A second check says the same again.
        let made_at = |hours: i64| -> String {
            ts.clock.set_utc_offset_hours(hours);
            check(&ts, &held.choice).made.expect("the backup says when")
        };
        let signed = heavy(|| {
            lockbox_core::verify_backup(
                &backup,
                lockbox_core::Credential::Password(TEST_PASSWORD),
                &CancelToken::new(),
                &NoProgress,
            )
        })
        .unwrap()
        .created_at;
        let (west, east) = (made_at(-12), made_at(14));
        let secs = crate::dates::parse_utc(&signed).unwrap();
        assert_eq!(west, crate::dates::local_date_of(secs, -12 * 3600));
        assert_eq!(east, crate::dates::local_date_of(secs, 14 * 3600));
        assert_ne!(west, east, "26 hours apart is another day");
        assert_eq!(west.len(), 10);

        // Another folder: where it would go, and not the usual one.
        let elsewhere = ts.folder("Elsewhere");
        let moved = choose(&ts, &held.choice, &elsewhere);
        assert!(!moved.usual && !moved.replaces_existing);
        assert_eq!(
            moved.folder_shown,
            shown(&elsewhere.join(folder_name("Clients", &id)))
        );
        assert_eq!((moved.name.as_str(), moved.made), ("Clients", Some(east)));

        // The folder holding a vault of this ID (the usual one, here): the answer names that vault's folder and says it
        // is the one replaced, though it is called by another name there.
        let (other, other_generation) = ts.open_vault("Family");
        let backup = backup_of(&ts, other, other_generation, "family.lockbox-backup");
        let held = pick(&ts, &backup);
        let view = check(&ts, &held.choice);
        assert!(view.usual && view.replaces_existing);
        // The same folder, compared as a folder: GitHub's Windows runner spells its temp folder with a short name
        // (RUNNER~1) in the test's profile and the long one in the vault list (CI, 2026-11-17).
        assert_eq!(
            fs::canonicalize(&view.folder_shown).unwrap(),
            fs::canonicalize(vault_dir(&ts)).unwrap()
        );
        assert_eq!(view.name, "Family");
        assert!(usual.is_dir(), "the vault made there made the folder");
        assert_eq!(
            staging_in(&usual),
            Vec::<String>::new(),
            "a check writes nothing"
        );
    }

    /// 24b: choosing another folder keeps what the check found, the password included: the copy that follows asks for
    /// nothing again. A closed picker keeps the folder as it was; the folder cannot be chosen before the check.
    #[test]
    fn restore_choose_folder_keeps_the_credential() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "report.pdf", b"report");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let parent = vaults_folder(&ts);

        let held = pick(&ts, &backup);
        let dialogs = ts.dialogs.opened();
        assert_eq!(
            ts.shell.restore_choose_folder(&held.choice).err(),
            Some(ShellError::ChoiceExpired),
            "not before the check"
        );
        assert_eq!(ts.dialogs.opened(), dialogs, "and then no picker opens");
        check(&ts, &held.choice);

        let elsewhere = ts.folder("Elsewhere");
        let moved = choose(&ts, &held.choice, &elsewhere);
        assert!(!moved.usual && !moved.replaces_existing);
        assert_eq!(
            moved.folder_shown,
            shown(&elsewhere.join(folder_name(
                "Family",
                &read_vault_id(&vault_dir(&ts)).unwrap()
            )))
        );
        // Closed: still there.
        assert!(matches!(
            ts.shell.restore_choose_folder(&held.choice),
            Ok(Outcome::Dismissed)
        ));
        // Another folder again, then the copy, which has no password to be given.
        let back = choose(&ts, &held.choice, &parent);
        assert!(back.replaces_existing);
        let view = done(copy(&ts, &held.choice).unwrap());
        assert!(view.replaces_existing);
        assert_eq!(staging_in(&parent).len(), 1, "copied where it was moved");
        assert!(staging_in(&elsewhere).is_empty());
        let restored = ts.shell.restore_commit(view.restore, REQUEST).unwrap();
        let (s2, g2) = unlock(&ts, restored.vault);
        assert_eq!(titles(&ts, s2, g2), ["report.pdf"]);
    }

    /// The one box takes a recovery key as well: a well-formed key is tried as a key, and the credential that worked (the
    /// key) is what the copy uses.
    #[test]
    fn restore_check_takes_a_recovery_key_and_keeps_the_one_that_worked() {
        let ts = TestShell::new();
        let (s, g, recovery) = source_vault(&ts, "Family");
        let key = recovery.to_display().to_string();
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let parent = ts.folder("Elsewhere");

        let held = pick(&ts, &backup);
        // Words that are no key and no password of this vault: wrong, and the pick stays.
        let wrong_key = heavy(|| {
            ts.shell
                .restore_check(&held.choice, typed(&"abandon ".repeat(24)))
        });
        assert!(wrong_key.is_err());
        let view = heavy(|| ts.shell.restore_check(&held.choice, typed(&key))).unwrap();
        assert_eq!(view.name, "Family");
        choose(&ts, &held.choice, &parent);
        let prepared = done(copy(&ts, &held.choice).unwrap());
        assert_eq!(prepared.name, "Family");
        ts.shell.restore_discard(prepared.restore).unwrap();
    }

    /// 24c: a Stop during the copy ends it and leaves everything as it was: no staging folder, no journal, the vault
    /// as it was and still unlocked (a Stop does not lock), the pick forgotten, and the job's last event sent.
    #[test]
    fn cancel_before_swap_leaves_the_vault_as_it_was() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "report.pdf", b"report");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        let (in_vault, in_parent) = (names(&dir), names(&parent));
        let choice = chosen(&ts, &backup, &parent);

        let (shell, events, once) = (
            Arc::clone(&ts.shell),
            Arc::clone(&ts.events),
            Cell::new(true),
        );
        failpoint::observe(
            "restore.after_entry",
            Box::new(move || {
                if once.replace(false) {
                    let started = events.started();
                    let job = started
                        .iter()
                        .rev()
                        .find(|event| event["kind"] == json!("restore"))
                        .expect("the copy is a job the page was told of");
                    let operation = OperationId(job["operation"].as_u64().unwrap());
                    let scope: JobScope = serde_json::from_value(job["scope"].clone()).unwrap();
                    shell.autolock.cancel_operation(operation, scope).unwrap();
                }
            }),
        );
        assert_eq!(copy(&ts, &choice).err(), CANCELLED);
        failpoint::disarm_all();

        assert!(staging_in(&parent).is_empty() && !ts.shell.paths.journal.exists());
        assert_eq!(names(&dir), in_vault, "the vault was not touched");
        assert_eq!(names(&parent), in_parent, "nothing else was written");
        assert!(ts.shell.restore.is_idle());
        assert_eq!(ts.shell.sessions.list()[0].state, SessionState::Unlocked);
        assert_eq!(
            heavy(|| ts.shell.restore_check(&choice, working())).err(),
            Some(ShellError::ChoiceExpired),
            "a Stop forgets the pick"
        );
        let jobs = restore_jobs(&ts);
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].0, u64::from(REQUEST));
        let sent = progress_of(&ts, jobs[0].1);
        assert_eq!(sent.last().unwrap()["finished"], json!(true));
        let busy = ts.events.busy();
        assert_eq!(busy.last(), Some(&(None, vec![])), "the job ended");
        // A restore can be started again at once.
        pick(&ts, &backup);
    }

    /// 24c and 24d: the copy reports its bytes and then ends with a last event; the swap that follows is a job of its own
    /// that the page is told of, from 0 to 1 of 1, and no Stop of the page reaches it.
    #[test]
    fn restore_jobs_report_progress_and_only_the_copy_stops() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "big.bin", &vec![9u8; 3 << 20]);
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let parent = vaults_folder(&ts);
        let choice = chosen(&ts, &backup, &parent);
        let view = done(copy(&ts, &choice).unwrap());

        let jobs = restore_jobs(&ts);
        assert_eq!(jobs.len(), 1);
        let (request, copying) = jobs[0];
        assert_eq!(request, u64::from(REQUEST));
        let sent = progress_of(&ts, copying);
        assert!(!sent.is_empty());
        for event in &sent {
            assert_eq!(event["kind"], json!("restore"));
            assert_eq!(event["scope"]["type"], json!("launch"));
            assert!(event["done"].as_u64() <= event["total"].as_u64());
        }
        let (last, earlier) = sent.split_last().unwrap();
        assert!(
            earlier
                .iter()
                .all(|event| event["finished"] == json!(false))
        );
        assert_eq!(last["finished"], json!(true));
        assert_eq!(last["done"], last["total"]);
        assert!(
            last["total"].as_u64().unwrap() > 3 << 20,
            "the whole backup"
        );
        let order: Vec<&str> = ts
            .events
            .job_events()
            .iter()
            .map(|(event, _)| *event)
            .skip_while(|event| *event != crate::shell::JOB_STARTED_EVENT)
            .collect();
        assert_eq!(order[0], crate::shell::JOB_STARTED_EVENT, "told first");
        assert!(order.len() > 1, "and then its progress");

        // The swap: its own job, told with its own number; a Stop of the page finds nothing to stop.
        let (shell, events, tried) = (
            Arc::clone(&ts.shell),
            Arc::clone(&ts.events),
            Rc::new(RefCell::new(None)),
        );
        let attempt = Rc::clone(&tried);
        failpoint::observe(
            "restore.before_swapping",
            Box::new(move || {
                let started = events.started();
                let job = started.last().unwrap().clone();
                assert_eq!(job["kind"], json!("restore"));
                let operation = OperationId(job["operation"].as_u64().unwrap());
                let scope: JobScope = serde_json::from_value(job["scope"].clone()).unwrap();
                *attempt.borrow_mut() = Some(shell.autolock.cancel_operation(operation, scope));
            }),
        );
        let restored = ts.shell.restore_commit(view.restore, REQUEST + 2).unwrap();
        failpoint::disarm_all();
        assert!(restored.before_restore, "the swap went through");
        assert_eq!(tried.borrow_mut().take(), Some(Err(ShellError::NotFound)));

        let jobs = restore_jobs(&ts);
        assert_eq!(jobs.len(), 2);
        let (request, swapping) = jobs[1];
        assert_eq!(request, u64::from(REQUEST + 2));
        assert_ne!(swapping, copying);
        let sent = progress_of(&ts, swapping);
        assert!(sent.iter().all(|event| event["kind"] == json!("restore")));
        assert_eq!(
            (
                sent[0]["done"].clone(),
                sent[0]["total"].clone(),
                sent[0]["finished"].clone()
            ),
            (json!(0), json!(1), json!(false)),
            "begun at nought of one"
        );
        let last = sent.last().unwrap();
        assert_eq!(
            (
                last["done"].clone(),
                last["total"].clone(),
                last["finished"].clone()
            ),
            (json!(1), json!(1), json!(true)),
            "ended at one of one"
        );
    }

    /// A swap that does not go through says so without a full bar: it ends at nought of one.
    #[test]
    fn a_swap_that_is_refused_never_reaches_one_of_one() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        ts.shell.sessions.lock(s, LockReason::Manual);
        let (outside, _) = heavy(|| Vault::unlock_with_password(&dir, TEST_PASSWORD)).unwrap();
        let view = prepared(&ts, &backup, &parent);

        assert_eq!(
            ts.shell.restore_commit(view.restore, REQUEST).err(),
            Some(CoreError::VaultInUse.into())
        );
        let (_, swapping) = *restore_jobs(&ts).last().unwrap();
        let last = progress_of(&ts, swapping).pop().unwrap();
        assert_eq!(
            (
                last["done"].clone(),
                last["total"].clone(),
                last["finished"].clone()
            ),
            (json!(0), json!(1), json!(true))
        );
        drop(outside);
    }

    /// 24d: the older copy's name is told before the person says yes, by the engine's own rule: `<folder>.before-restore`,
    /// then `-2` upward for the first name not taken, and it is the folder the swap then makes, beside the vault, holding
    /// the vault that was replaced. A restore that replaces nothing names none.
    #[test]
    fn replace_keeps_the_current_vault_as_an_older_copy() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "report.pdf", b"report");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        ts.shell
            .new_item(
                s,
                g,
                crate::commands::items::NewKind::Note,
                "Later".into(),
                None,
                None,
            )
            .unwrap();
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        let folder = dir.file_name().unwrap().to_string_lossy().into_owned();
        let in_the_older_copy = |kept: &str| -> Vec<String> {
            let opened = ReadOnlyVault::open_folder(
                &parent.join(kept),
                lockbox_core::Credential::Password(TEST_PASSWORD),
                &CancelToken::new(),
                &NoProgress,
            )
            .unwrap();
            let mut titles: Vec<String> = opened.items().map(|item| item.title.clone()).collect();
            titles.sort();
            titles
        };

        let view = prepared(&ts, &backup, &parent);
        let first = format!("{folder}.before-restore");
        assert!(view.replaces_existing);
        assert_eq!(view.kept_as.as_deref(), Some(first.as_str()));
        assert!(!parent.join(&first).exists(), "told before it is made");
        let restored = ts.shell.restore_commit(view.restore, REQUEST).unwrap();
        assert!(restored.before_restore);
        assert!(
            parent.join(&first).is_dir(),
            "the folder told is the folder made"
        );
        assert_eq!(in_the_older_copy(&first), ["Later", "report.pdf"]);
        let listed: Vec<String> = ts
            .shell
            .list_pre_restore()
            .into_iter()
            .map(|entry| entry.folder)
            .collect();
        assert_eq!(listed, std::slice::from_ref(&first));

        // Again: the name taken is skipped.
        let view = prepared(&ts, &backup, &parent);
        let second = format!("{folder}.before-restore-2");
        assert_eq!(view.kept_as.as_deref(), Some(second.as_str()));
        ts.shell.restore_commit(view.restore, REQUEST).unwrap();
        assert!(parent.join(&second).is_dir());
        assert_eq!(in_the_older_copy(&second), ["report.pdf"]);

        // Nothing to replace, nothing to keep.
        let fresh = ts.folder("Fresh");
        let view = prepared(&ts, &backup, &fresh);
        assert!(!view.replaces_existing);
        assert_eq!(view.kept_as, None);
    }

    /// The name is the first one the swap would find free, a gap included, so it is right however the older copies were
    /// made or deleted; and it is looked for as the engine looks: anything at the name counts, a file included.
    #[test]
    fn the_older_copys_name_is_the_first_free_one() {
        let ts = TestShell::new();
        let parent = ts.folder("Parent");
        let vault = parent.join("Family-1a2b3c4d");
        fs::create_dir(&vault).unwrap();
        let kept = |at: &Path| kept_as_name(at);
        assert_eq!(
            kept(&vault).as_deref(),
            Some("Family-1a2b3c4d.before-restore")
        );
        fs::create_dir(parent.join("Family-1a2b3c4d.before-restore")).unwrap();
        fs::write(parent.join("Family-1a2b3c4d.before-restore-2"), b"a file").unwrap();
        assert_eq!(
            kept(&vault).as_deref(),
            Some("Family-1a2b3c4d.before-restore-3")
        );
        fs::remove_file(parent.join("Family-1a2b3c4d.before-restore-2")).unwrap();
        assert_eq!(
            kept(&vault).as_deref(),
            Some("Family-1a2b3c4d.before-restore-2"),
            "a gap is used"
        );
        for n in 2..=99 {
            fs::create_dir(parent.join(format!("Family-1a2b3c4d.before-restore-{n}"))).ok();
        }
        assert_eq!(kept(&vault), None, "all ninety-nine taken");
        // A vault with a name that has no UTF-8 form has no name to give.
        assert_eq!(kept(Path::new("")), None);
    }

    /// All ninety-nine names taken: the copy is still made and 24d is shown, with no name to give; the swap then refuses
    /// before any rename with the engine's words, and the staged restore stays for the person to cancel (Cancel
    /// discards it). Nothing is replaced or made.
    #[test]
    fn all_old_copy_names_used_refused() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        let folder = dir.file_name().unwrap().to_string_lossy().into_owned();
        ts.shell.sessions.lock(s, LockReason::Manual);
        fs::create_dir(parent.join(format!("{folder}.before-restore"))).unwrap();
        for n in 2..=99 {
            fs::create_dir(parent.join(format!("{folder}.before-restore-{n}"))).unwrap();
        }
        let (in_vault, in_parent) = (names(&dir), names(&parent));

        let view = prepared(&ts, &backup, &parent);
        assert!(view.replaces_existing);
        assert_eq!(view.kept_as, None, "no name is free");
        assert_eq!(staging_in(&parent).len(), 1);

        let refused = ts.shell.restore_commit(view.restore, REQUEST).err();
        assert!(
            matches!(&refused, Some(ShellError::Core(found))
                if found.kind == "invalid_input" && found.what == Some("too many before-restore copies")),
            "{refused:?}"
        );
        assert!(!ts.shell.restore.is_idle(), "still staged, for Cancel");
        assert_eq!(names(&dir), in_vault, "the vault was not touched");
        ts.shell.restore_discard(view.restore).unwrap();
        assert!(staging_in(&parent).is_empty() && !ts.shell.paths.journal.exists());
        assert_eq!(names(&parent), in_parent, "no folder was made or moved");
    }

    /// A drive known to have too little room is refused before a byte is written, with the numbers 24b shows; the refusal
    /// comes as the job's answer (the checks are the engine's, inside the copy), the pick stays so the person can choose
    /// another folder, and the same pick then goes through.
    #[test]
    fn restore_no_space_refused_with_numbers() {
        let ts = TestShell::new();
        let _volume = Volume;
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "report.pdf", &vec![7u8; 300_000]);
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let parent = vaults_folder(&ts);
        let before = names(&parent);
        let choice = chosen(&ts, &backup, &parent);

        pretend_free(Some(0));
        let Some(ShellError::Core(view)) = copy(&ts, &choice).err() else {
            panic!("not refused for space");
        };
        assert_eq!(view.kind, "not_enough_space");
        let needed = view.needed.unwrap();
        assert_eq!(view.available, Some(0));
        assert!(needed > 64 * 1024 * 1024, "the margin is in it: {needed}");
        assert_eq!(
            serde_json::to_value(ShellError::Core(view)).unwrap(),
            json!({ "code": "core", "kind": "not_enough_space", "needed": needed, "available": 0 })
        );
        assert_eq!(names(&parent), before, "nothing was written");
        assert!(!ts.shell.paths.journal.exists() && ts.shell.restore.is_idle());
        let jobs = restore_jobs(&ts);
        assert_eq!(jobs.len(), 1, "the refusal is the job's answer");
        assert_eq!(
            progress_of(&ts, jobs[0].1).last().unwrap()["finished"],
            json!(true)
        );

        // One byte short, with the same pick: refused again; exactly enough, the same pick goes ahead.
        pretend_free(Some(needed - 1));
        let again = copy(&ts, &choice).err();
        assert!(matches!(again, Some(ShellError::Core(ref v)) if v.kind == "not_enough_space"));
        pretend_free(Some(needed));
        let view = done(copy(&ts, &choice).unwrap());
        assert_eq!(view.name, "Family");
    }

    /// The file picked is replaced, after the check and before the copy, by another vault's backup made with the same
    /// password: the copy opens that one, finds another vault's ID than the check saw, and refuses before anything is
    /// written (the job's own answer). The pick goes with its credential, so nothing of the other vault is ever named
    /// under the first one's name and the person picks again.
    #[test]
    fn a_backup_replaced_after_the_check_is_refused_before_any_copy() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (other_s, other_g, _recovery) = source_vault(&ts, "Other");
        let other = backup_of(&ts, other_s, other_g, "other.lockbox-backup");
        let parent = vaults_folder(&ts);
        let before = names(&parent);
        let others = ts.shell.sessions.pending().len();

        let held = pick(&ts, &backup);
        assert_eq!(check(&ts, &held.choice).name, "Family");
        fs::copy(&other, &backup).unwrap();

        let refused = copy(&ts, &held.choice).err();
        assert_eq!(refused, Some(BACKUP_CHANGED));
        assert_eq!(
            serde_json::to_value(BACKUP_CHANGED).unwrap(),
            json!({ "code": "invalid_input", "what": "backup changed" })
        );
        assert_eq!(names(&parent), before, "nothing was written");
        assert!(staging_in(&parent).is_empty() && !ts.shell.paths.journal.exists());
        assert!(ts.shell.restore.is_idle());
        let jobs = restore_jobs(&ts);
        assert_eq!(jobs.len(), 1, "the refusal is the job's answer");
        assert_eq!(
            progress_of(&ts, jobs[0].1).last().unwrap()["finished"],
            json!(true)
        );
        // The pick is forgotten with its credential: another copy, or another check, is told to pick again.
        assert_eq!(ts.shell.sessions.pending().len(), others);
        assert_eq!(
            copy(&ts, &held.choice).err(),
            Some(ShellError::ChoiceExpired)
        );
        assert_eq!(
            heavy(|| ts.shell.restore_check(&held.choice, working())).err(),
            Some(ShellError::ChoiceExpired)
        );
    }

    /// The same, after the cloud question: the yes finds another vault's backup in the file and is refused, and the
    /// pick goes.
    #[test]
    fn a_backup_replaced_before_the_yes_is_refused_too() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (other_s, other_g, _recovery) = source_vault(&ts, "Other");
        let other = backup_of(&ts, other_s, other_g, "other.lockbox-backup");
        let cloud = ts.folder("Cloud");
        ts.volumes.add_sync_root(&cloud);
        let others = ts.shell.sessions.pending().len();

        let choice = chosen(&ts, &backup, &cloud);
        let Outcome::Confirm(Confirm::CloudFolder { token: asked }) = copy(&ts, &choice).unwrap()
        else {
            panic!("not asked");
        };
        fs::copy(&other, &backup).unwrap();

        let answer = heavy(|| ts.shell.restore_prepare_confirm(&asked, None, REQUEST));
        assert_eq!(answer.err(), Some(BACKUP_CHANGED));
        assert!(names(&cloud).is_empty() && !ts.shell.paths.journal.exists());
        assert!(ts.shell.restore.is_idle());
        assert_eq!(ts.shell.sessions.pending().len(), others, "the pick went");
    }

    /// The folder picker is open and Windows locks: the credential is gone from memory at that moment, not when the
    /// picker returns. The pick lives through the dialog only as a use guard and what is not secret.
    #[test]
    fn the_folder_picker_does_not_hold_the_credential_through_a_lock() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let parent = vaults_folder(&ts);
        let held = pick(&ts, &backup);
        check(&ts, &held.choice);
        let credential = {
            let now = || ts.shell.os.clock.now();
            let epoch = ts.shell.sessions.epoch();
            let using = ts
                .shell
                .sessions
                .pending()
                .use_restore_pick(&held.choice, epoch, &now)
                .unwrap();
            Arc::downgrade(&using.checked().unwrap().credential)
        };
        assert!(credential.upgrade().is_some(), "the pick holds it");

        let gone_in_the_dialog = Arc::new(AtomicBool::new(false));
        let (shell, seen) = (Arc::clone(&ts.shell), Arc::clone(&gone_in_the_dialog));
        ts.dialogs.during_next_dialog(Box::new(move || {
            shell.sessions.lock_all(LockReason::WindowsLocked);
            seen.store(credential.upgrade().is_none(), Ordering::SeqCst);
        }));
        ts.dialogs.answer(Some(parent));
        assert_eq!(ts.shell.restore_choose_folder(&held.choice).err(), LOCKED);
        assert!(
            gone_in_the_dialog.load(Ordering::SeqCst),
            "the credential was still held while the picker was open"
        );
        assert_eq!(ts.shell.sessions.pending().len(), 0);
    }

    /// The pick is forgotten while the folder picker is open, with no lock: the answer, once the picker returns, is
    /// `ChoiceExpired`, and nothing is kept.
    #[test]
    fn a_pick_forgotten_in_the_folder_picker_answers_choice_expired() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let parent = vaults_folder(&ts);
        let others = ts.shell.sessions.pending().len();
        let held = pick(&ts, &backup);
        check(&ts, &held.choice);
        let (shell, choice) = (Arc::clone(&ts.shell), held.choice.clone());
        ts.dialogs.during_next_dialog(Box::new(move || {
            shell.forget_restore_pick(&choice).unwrap();
        }));
        ts.dialogs.answer(Some(parent));
        assert_eq!(
            ts.shell.restore_choose_folder(&held.choice).err(),
            Some(ShellError::ChoiceExpired)
        );
        assert_eq!(ts.shell.sessions.pending().len(), others);
    }

    /// A drive whose free space cannot be read is "unknown", and unknown never blocks: the copy runs.
    #[test]
    fn restore_unknown_free_space_goes_ahead() {
        let ts = TestShell::new();
        let _volume = Volume;
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let parent = vaults_folder(&ts);
        pretend_free(None);
        let view = prepared(&ts, &backup, &parent);
        assert_eq!(view.name, "Family");
        assert!(
            ts.shell
                .restore_commit(view.restore, REQUEST)
                .unwrap()
                .before_restore
        );
    }

    /// A removable, FAT32, network or unsupported drive is refused before anything is written and before a job begins
    /// (the page is told of none), the pick stays, and the same pick goes through in a folder that is allowed.
    #[test]
    fn removable_fat32_or_network_drive_refused() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let good = ts.folder("Good");
        let choice = chosen(&ts, &backup, &good);
        let drives = [
            ("Usb", DriveType::Removable, "NTFS", "removable drive"),
            (
                "Fat",
                DriveType::Fixed,
                "FAT32",
                "file system not supported",
            ),
            ("Share", DriveType::Remote, "NTFS", "network drive"),
            ("Disc", DriveType::CdRom, "NTFS", "drive type not supported"),
        ];
        for (name, drive, file_system, what) in drives {
            let folder = ts.folder(name);
            ts.volumes.mount(
                &folder,
                FakeVolume {
                    drive,
                    file_system,
                    label: "X",
                },
            );
            choose(&ts, &choice, &folder);
            let answer = copy(&ts, &choice).err();
            assert_eq!(answer, Some(ShellError::InvalidInput { what }), "{what}");
            assert!(names(&folder).is_empty(), "{what}: nothing written");
            assert!(!ts.shell.paths.journal.exists() && ts.shell.restore.is_idle());
            assert!(restore_jobs(&ts).is_empty(), "{what}: no job began");
        }
        // The pick survived every refusal.
        choose(&ts, &choice, &good);
        let view = done(copy(&ts, &choice).unwrap());
        assert!(!view.replaces_existing);
        assert_eq!(restore_jobs(&ts).len(), 1);
    }

    /// A cloud folder asks first and writes nothing until the yes; the question holds the pick, not the password, and
    /// the yes goes on with it. A pick that is gone by then (forgotten, or a lock) is told as such.
    #[test]
    fn restore_cloud_folder_warns_first() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let cloud = ts.folder("Cloud");
        ts.volumes.add_sync_root(&cloud);
        let others = ts.shell.sessions.pending().len();

        let choice = chosen(&ts, &backup, &cloud);
        let Outcome::Confirm(Confirm::CloudFolder { token: asked }) = copy(&ts, &choice).unwrap()
        else {
            panic!("not asked");
        };
        assert!(names(&cloud).is_empty() && !ts.shell.paths.journal.exists());
        assert!(restore_jobs(&ts).is_empty(), "no job before the yes");
        assert_eq!(
            ts.shell.sessions.pending().len(),
            others + 2,
            "the pick and the question"
        );

        // The yes: the copy runs on the pick, which then goes.
        let view =
            done(heavy(|| ts.shell.restore_prepare_confirm(&asked, None, REQUEST + 1)).unwrap());
        assert_eq!(restore_jobs(&ts)[0].0, u64::from(REQUEST + 1));
        assert_eq!(
            ts.shell.sessions.pending().len(),
            others,
            "the pick is gone with the copy"
        );
        ts.shell.restore_discard(view.restore).unwrap();

        // A pick forgotten between the question and the yes: the yes is told so, and nothing is written.
        let choice = chosen(&ts, &backup, &cloud);
        let Outcome::Confirm(Confirm::CloudFolder { token: asked }) = copy(&ts, &choice).unwrap()
        else {
            panic!("not asked again");
        };
        ts.shell.forget_restore_pick(&choice).unwrap();
        assert_eq!(
            heavy(|| ts.shell.restore_prepare_confirm(&asked, None, REQUEST)).err(),
            Some(ShellError::ChoiceExpired)
        );
        assert!(names(&cloud).is_empty());
        assert!(ts.shell.restore.is_idle());
    }

    /// The usual folder is made when the copy needs it, not before, and the restored vault goes in it.
    #[test]
    fn the_usual_folder_is_made_when_the_copy_needs_it() {
        let ts = TestShell::new();
        let (s, g, _) = source_vault(&ts, "Family");
        ts.stored_file(s, g, "report.pdf", b"report");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let usual = usual_folder(&ts);
        let held = pick(&ts, &backup);
        check(&ts, &held.choice);
        assert!(!usual.exists());

        let view = done(copy(&ts, &held.choice).unwrap());
        assert!(usual.is_dir());
        assert!(!view.replaces_existing);
        assert_eq!(staging_in(&usual).len(), 1);
        let restored = ts.shell.restore_commit(view.restore, REQUEST).unwrap();
        assert!(!restored.before_restore);
        assert_eq!(names(&usual).len(), 1);
        let (s2, g2) = unlock(&ts, restored.vault);
        assert_eq!(titles(&ts, s2, g2), ["report.pdf"]);
    }

    /// The pick goes when the copy finishes (the staged restore holds all it needs), and stays through every refusal.
    #[test]
    fn the_pick_goes_when_the_copy_finishes_and_stays_through_refusals() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (parent, roaming) = (
            vaults_folder(&ts),
            ts.env.folder(KnownFolder::RoamingAppData).join("Elsewhere"),
        );
        fs::create_dir_all(&roaming).unwrap();
        let others = ts.shell.sessions.pending().len();
        let choice = chosen(&ts, &backup, &roaming);
        // Built from a named constant, not a quoted literal after the field name: the page's message check reads every
        // such literal in crates/ as a refusal it must word.
        let app_data = "app data folder";
        assert_eq!(
            copy(&ts, &choice).err(),
            Some(ShellError::InvalidInput { what: app_data })
        );
        assert_eq!(
            ts.shell.sessions.pending().len(),
            others + 1,
            "kept through a refusal"
        );
        choose(&ts, &choice, &parent);
        let view = done(copy(&ts, &choice).unwrap());
        assert_eq!(
            ts.shell.sessions.pending().len(),
            others,
            "gone with the copy"
        );
        assert_eq!(
            heavy(|| ts.shell.restore_check(&choice, working())).err(),
            Some(ShellError::ChoiceExpired)
        );
        ts.shell.restore_discard(view.restore).unwrap();
    }

    /// A lock of all vaults, of any kind (the idle one included), between two tries of the password drops the pick, and
    /// the next try is told the choice has expired, with no picker opened.
    #[test]
    fn restore_lock_all_between_credential_retries_drops_the_choice() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        for reason in [
            LockReason::Manual,
            LockReason::Idle,
            LockReason::WindowsLocked,
            LockReason::Sleep,
        ] {
            let held = pick(&ts, &backup);
            let dialogs = ts.dialogs.opened();
            let refused = heavy(|| ts.shell.restore_check(&held.choice, wrong())).err();
            assert_eq!(refused, Some(CoreError::WrongPassword.into()), "{reason:?}");

            ts.shell.sessions.lock_all(reason);
            assert_eq!(ts.shell.sessions.pending().len(), 0, "{reason:?}");
            assert_eq!(
                heavy(|| ts.shell.restore_check(&held.choice, working())).err(),
                Some(ShellError::ChoiceExpired),
                "{reason:?}"
            );
            assert_eq!(ts.dialogs.opened(), dialogs, "{reason:?}: no picker");
        }
    }

    /// A lock that lands while the password is being checked: the check says `Locked`, and holds nothing.
    #[test]
    fn a_lock_during_the_check_answers_locked_and_holds_nothing() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "report.pdf", b"report");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let held = pick(&ts, &backup);

        // The lock comes as the backup's first item is read.
        let (shell, once) = (Arc::clone(&ts.shell), Cell::new(true));
        failpoint::observe(
            "source.item",
            Box::new(move || {
                if once.replace(false) {
                    shell.sessions.lock_all(LockReason::Manual);
                }
            }),
        );
        let answer = heavy(|| ts.shell.restore_check(&held.choice, working())).err();
        failpoint::disarm_all();

        assert_eq!(answer, LOCKED);
        assert_eq!(ts.shell.sessions.pending().len(), 0, "nothing is held");
        assert_eq!(
            heavy(|| ts.shell.restore_check(&held.choice, working())).err(),
            Some(ShellError::ChoiceExpired)
        );
    }

    /// Every new command answers a token it does not hold as `choice_expired`, never `not_found`: one never given, a
    /// malformed one cannot be sent at all (the parser refuses it), another kind of choice under the token, a pick that was
    /// replaced or forgotten, and a pick of an epoch a lock has ended. The numbers a restore is known by answer as before.
    #[test]
    fn restore_commands_refused_stale_foreign() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let expired = Some(ShellError::ChoiceExpired);
        let all_refused = |ts: &TestShell, choice: &Token, why: &str| {
            assert_eq!(
                heavy(|| ts.shell.restore_check(choice, working())).err(),
                expired,
                "check: {why}"
            );
            assert_eq!(
                ts.shell.restore_choose_folder(choice).err(),
                expired,
                "folder: {why}"
            );
            assert_eq!(
                ts.shell.restore_prepare(choice, REQUEST).err(),
                expired,
                "copy: {why}"
            );
            assert!(
                ts.shell.forget_restore_pick(choice).is_ok(),
                "forget: {why}"
            );
        };
        let dialogs = ts.dialogs.opened();
        let base = ts.shell.sessions.pending().len();

        all_refused(&ts, &unheld(), "never given");

        // A held test backup is no restore pick.
        ts.dialogs.answer(Some(backup.clone()));
        let test_pick = done(ts.shell.test_backup_pick(None).unwrap());
        let dialogs = dialogs + 1;
        all_refused(&ts, &test_pick.choice, "another kind of choice");
        assert_eq!(
            ts.shell.sessions.pending().len(),
            base + 1,
            "and it was left alone"
        );
        ts.shell.forget_test_backup(&test_pick.choice).unwrap();

        // A pick replaced by another, one forgotten, and one a lock has ended.
        let first = pick(&ts, &backup);
        ts.dialogs.answer(Some(backup.clone()));
        let second = done(ts.shell.restore_pick(Some(&first.choice), None).unwrap());
        all_refused(&ts, &first.choice, "replaced");
        check(&ts, &second.choice);
        ts.shell.forget_restore_pick(&second.choice).unwrap();
        all_refused(&ts, &second.choice, "forgotten");
        ts.shell.forget_restore_pick(&second.choice).unwrap();

        let third = pick(&ts, &backup);
        ts.shell.sessions.lock_all(LockReason::Manual);
        all_refused(&ts, &third.choice, "locked");
        assert_eq!(
            ts.dialogs.opened(),
            dialogs + 3,
            "only the picks opened a picker"
        );

        // The restore's own numbers: never issued, `not_found`; the restore's pick token is not one.
        assert_eq!(
            ts.shell.restore_commit(99, REQUEST).err(),
            Some(ShellError::NotFound)
        );
        assert_eq!(
            ts.shell.restore_discard(99).err(),
            Some(ShellError::NotFound)
        );
        // A question answered with a pick's token: refused, as any token that is no question.
        let fourth = pick(&ts, &backup);
        assert_eq!(
            heavy(|| ts
                .shell
                .restore_prepare_confirm(&fourth.choice, None, REQUEST))
            .err(),
            Some(ShellError::NotFound)
        );
        assert!(ts.shell.restore.is_idle());
        let _ = (s, g);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Locks around a restore.
    // ------------------------------------------------------------------------------------------------------------

    /// A prepared restore ends with a Windows lock: the commit answers `Cancelled`, the staging folder and journal
    /// are gone, and an ID never issued is not found.
    #[test]
    fn prepared_restore_cancelled_by_windows_lock() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        let view = prepared(&ts, &backup, &parent);
        assert_eq!(staging_in(&parent).len(), 1);

        ts.shell.autolock.signal(OsSignal::SessionLocked);
        ended(&ts);

        assert_eq!(
            ts.shell.restore_commit(view.restore, REQUEST).err(),
            CANCELLED
        );
        assert_eq!(ts.shell.restore_discard(view.restore).err(), CANCELLED);
        assert_eq!(
            ts.shell.restore_commit(view.restore + 100, REQUEST).err(),
            Some(ShellError::NotFound)
        );
        assert!(staging_in(&parent).is_empty());
        assert!(!ts.shell.paths.journal.exists());
        assert!(dir.exists(), "the vault was not touched");
        assert!(ts.shell.restore.is_idle());
    }

    /// The restore's own lock of its destination (`LockReason::Restore`) does not cancel it: the commit locks the
    /// open destination, and goes on.
    #[test]
    fn own_destination_lock_does_not_cancel() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "report.pdf", b"report");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        ts.shell
            .new_item(
                s,
                g,
                crate::commands::items::NewKind::Note,
                "Later".into(),
                None,
                None,
            )
            .unwrap();
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        let view = prepared(&ts, &backup, &parent);
        assert!(view.replaces_existing);

        let restored = ts.shell.restore_commit(view.restore, REQUEST).unwrap();

        assert_eq!(
            restored,
            RestoredView {
                vault: 1,
                before_restore: true
            }
        );
        let locks = ts.events.locked();
        assert!(
            locks
                .iter()
                .any(|(id, _, reason)| *id == s && *reason == LockReason::Restore)
        );
        let aside = parent.join(format!(
            "{}.before-restore",
            dir.file_name().unwrap().to_string_lossy()
        ));
        assert!(aside.is_dir());
        let (s2, g2) = unlock(&ts, restored.vault);
        assert_eq!(titles(&ts, s2, g2), ["report.pdf"], "the backup's items");
    }

    /// A lock of the destination by the user cancels the prepared restore; a lock of another vault does not.
    #[test]
    fn user_lock_of_destination_cancels_before_commit() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let (other, _) = ts.open_vault("Other");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));

        let view = prepared(&ts, &backup, &parent);
        ts.shell.sessions.lock(other, LockReason::Manual);
        assert!(
            !ts.shell.restore.is_idle(),
            "another vault's lock changes nothing"
        );
        ts.shell.restore_discard(view.restore).unwrap();
        assert!(staging_in(&parent).is_empty());

        let view = prepared(&ts, &backup, &parent);
        ts.shell.sessions.lock(s, LockReason::Manual);
        ended(&ts);
        assert_eq!(
            ts.shell.restore_commit(view.restore, REQUEST).err(),
            CANCELLED
        );
        assert!(staging_in(&parent).is_empty() && !ts.shell.paths.journal.exists());
        assert!(dir.exists());
    }

    /// A lock of the destination while the backup is being extracted (when which session is the destination is not
    /// known yet) ends the restore at the end of the extraction.
    #[test]
    fn lock_of_destination_during_prepare_cancels() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let parent = vaults_folder(&ts);
        let shell = Arc::clone(&ts.shell);
        let once = Cell::new(true);
        failpoint::observe(
            "restore.after_entry",
            Box::new(move || {
                if once.replace(false) {
                    shell.sessions.lock(s, LockReason::Manual);
                }
            }),
        );
        assert_eq!(prepare(&ts, &backup, &parent).err(), CANCELLED);
        assert!(staging_in(&parent).is_empty() && !ts.shell.paths.journal.exists());
        assert!(ts.shell.restore.is_idle());
    }

    /// A Windows lock while preparing cancels it, removes the staging folder and journal, and ends the long
    /// operation; once the swap has begun, a Windows lock lets it finish.
    #[test]
    fn lock_during_restore() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "report.pdf", b"report");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));

        let shell = Arc::clone(&ts.shell);
        let once = Cell::new(true);
        failpoint::observe(
            "restore.after_entry",
            Box::new(move || {
                if once.replace(false) {
                    shell.autolock.signal(OsSignal::SessionLocked);
                }
            }),
        );
        assert_eq!(prepare(&ts, &backup, &parent).err(), CANCELLED);
        failpoint::disarm_all();
        assert!(staging_in(&parent).is_empty() && !ts.shell.paths.journal.exists());
        assert!(ts.shell.restore.is_idle());
        let busy = ts.events.busy();
        assert!(busy.contains(&(None, vec!["restore"])), "{busy:?}");
        assert_eq!(busy.last(), Some(&(None, vec![])), "the operation ended");

        // During the swap: nothing cancels it.
        let view = prepared(&ts, &backup, &parent);
        let shell = Arc::clone(&ts.shell);
        failpoint::observe(
            "restore.after_journal",
            Box::new(move || shell.autolock.signal(OsSignal::SessionLocked)),
        );
        let restored = ts.shell.restore_commit(view.restore, REQUEST).unwrap();
        failpoint::disarm_all();
        assert!(restored.before_restore);
        assert!(dir.is_dir() && !ts.shell.paths.journal.exists());
        assert!(staging_in(&parent).is_empty());
        let (s2, g2) = unlock(&ts, restored.vault);
        assert_eq!(titles(&ts, s2, g2), ["report.pdf"]);
    }

    /// Ask 15: a close or Quit that comes once the engine has written `swapping` says the restore is past the point of
    /// cancelling (`past_swap`), so the page can say it will finish or be undone the next time Lockbox opens; one that
    /// comes while the restore is committing but before that point does not, and neither does a restore waiting for its
    /// yes. Asked from inside the commit, at each of the two points, and once while it waits. Close anyway in the swap
    /// runs the old close, which cancels and locks, and the swap finishes all the same: nothing is lost.
    #[test]
    fn close_past_the_swap_says_it_finishes_next_time() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        ts.shell.settings.mark_close_explained().unwrap();
        ts.stored_file(s, g, "report.pdf", b"report");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));

        // Waiting for the yes: no job runs, so a close does not ask at all.
        let view = prepared(&ts, &backup, &parent);
        assert!(!ts.shell.restore.past_swap());
        assert!(!ts.shell.ask_before_closing(CloseReason::Close));
        assert!(ts.events.close_asked().is_empty());

        // Committing, before the journal says `swapping`, then after it.
        let (shell, once) = (Arc::clone(&ts.shell), Cell::new(true));
        failpoint::observe(
            "restore.before_swapping",
            Box::new(move || {
                if once.replace(false) {
                    assert!(!shell.restore.past_swap());
                    assert!(shell.ask_before_closing(CloseReason::Close));
                    assert_eq!(shell.close_answer(false), Ok(()));
                }
            }),
        );
        let shell = Arc::clone(&ts.shell);
        failpoint::observe(
            "restore.after_journal",
            Box::new(move || {
                assert!(shell.restore.past_swap());
                assert!(shell.ask_before_closing(CloseReason::Quit));
            }),
        );
        let restored = ts.shell.restore_commit(view.restore, REQUEST).unwrap();
        failpoint::disarm_all();

        assert_eq!(
            ts.events.close_asked(),
            [
                json!({ "reason": "close", "running": ["restore"], "past_swap": false }),
                json!({ "reason": "quit", "running": ["restore"], "past_swap": true }),
            ]
        );
        // The swap went through whatever was asked; nothing was lost, and the question outlived the commit.
        assert!(restored.before_restore);
        assert!(dir.is_dir() && !ts.shell.paths.journal.exists());
        assert!(staging_in(&parent).is_empty());
        assert!(!ts.shell.restore.past_swap(), "the restore is over");
        assert_eq!(ts.window.exits(), 0, "asking exited");
        let (s2, g2) = unlock(&ts, restored.vault);
        assert_eq!(titles(&ts, s2, g2), ["report.pdf"]);
    }

    /// The destination is locked with the restore's reason before the first rename.
    #[test]
    fn restore_closes_open_vault_first() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let parent = vaults_folder(&ts);
        let view = prepared(&ts, &backup, &parent);

        let states = Rc::new(RefCell::new(Vec::new()));
        let (shell, seen) = (Arc::clone(&ts.shell), Rc::clone(&states));
        failpoint::observe(
            "restore.after_journal",
            Box::new(move || seen.borrow_mut().push(shell.sessions.list()[0].state)),
        );
        ts.shell.restore_commit(view.restore, REQUEST).unwrap();

        assert_eq!(*states.borrow(), [SessionState::Locked]);
        assert_eq!(ts.events.locked(), [(s, g + 1, LockReason::Restore)]);
    }

    /// Spec 7.4: the idle timer is paused while the restore copies, and while it swaps: a long job the person started, so
    /// a tick that finds the person long idle locks nothing meanwhile.
    #[test]
    fn restore_copy_pauses_idle_time() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let parent = vaults_folder(&ts);
        let idle_for = Duration::from_secs(6 * 60);
        let idle_locks = |events: &crate::testing::Events| {
            events
                .locked()
                .iter()
                .filter(|(_, _, reason)| *reason == LockReason::Idle)
                .count()
        };

        let tick_at = |step: &'static str, seen: &Rc<Cell<usize>>| {
            let (shell, clock, idle) = (
                Arc::clone(&ts.shell),
                Arc::clone(&ts.clock),
                Arc::clone(&ts.idle),
            );
            let (counted, events) = (Rc::clone(seen), Arc::clone(&ts.events));
            failpoint::observe(
                step,
                Box::new(move || {
                    idle.set(idle_for);
                    shell.autolock.tick(clock.now() + idle_for);
                    counted.set(
                        events
                            .locked()
                            .iter()
                            .filter(|(_, _, reason)| *reason == LockReason::Idle)
                            .count(),
                    );
                }),
            );
        };

        // The copy: a job, so a tick finds no idle time.
        let during_copy = Rc::new(Cell::new(usize::MAX));
        tick_at("restore.after_entry", &during_copy);
        let view = prepared(&ts, &backup, &parent);
        failpoint::disarm_all();
        assert_eq!(during_copy.get(), 0, "paused while copying");
        assert_eq!(idle_locks(&ts.events), 0);
        assert!(ts.events.busy().contains(&(None, vec!["restore"])));

        // The swap: a job too.
        ts.idle.set(Duration::ZERO);
        let during_swap = Rc::new(Cell::new(usize::MAX));
        tick_at("restore.after_journal", &during_swap);
        ts.shell.restore_commit(view.restore, REQUEST).unwrap();
        failpoint::disarm_all();
        assert_eq!(during_swap.get(), 0, "paused while swapping");
        assert_eq!(idle_locks(&ts.events), 0);
        let _ = (s, g);
    }

    /// The finished restore is waiting for the person's answer (24d), and the idle time runs out: every vault locks,
    /// the restore stays, with its staging folder and journal, and the answer still goes through: the swap replaces the
    /// vault that the idle lock had just locked, with no question about a lock.
    #[test]
    fn finished_restore_survives_an_idle_lock() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "report.pdf", b"report");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        ts.shell
            .new_item(
                s,
                g,
                crate::commands::items::NewKind::Note,
                "Later".into(),
                None,
                None,
            )
            .unwrap();
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        // The vault being replaced is open when the restore is finished.
        let view = prepared(&ts, &backup, &parent);
        assert!(view.replaces_existing);

        // The real idle lock, through the timer; the second lock is the barrier that waits for the hooks of the first.
        ts.idle.set(Duration::from_secs(6 * 60));
        ts.shell
            .autolock
            .tick(ts.clock.now() + Duration::from_secs(6 * 60));
        ts.shell.sessions.lock_all(LockReason::Idle);
        assert_eq!(ts.shell.sessions.list()[0].state, SessionState::Locked);
        assert!(!ts.shell.restore.is_idle(), "the finished restore stays");
        assert_eq!(staging_in(&parent).len(), 1);
        assert!(ts.shell.paths.journal.exists());

        // And again: any number of idle locks.
        ts.shell.sessions.lock_all(LockReason::Idle);
        let restored = ts.shell.restore_commit(view.restore, REQUEST).unwrap();
        assert!(restored.before_restore);
        assert!(dir.is_dir() && !ts.shell.paths.journal.exists());
        assert!(staging_in(&parent).is_empty());
        let (s2, g2) = unlock(&ts, restored.vault);
        assert_eq!(titles(&ts, s2, g2), ["report.pdf"], "the backup's items");
    }

    /// An idle lock whose hooks have not run yet when the answer comes is the same: the vault was locked by idle time, not
    /// by the person, so the answer is not refused as a lock of the destination.
    #[test]
    fn an_idle_lock_with_its_hook_still_queued_does_not_cancel_the_swap() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        let _ = g;
        let view = prepared(&ts, &backup, &parent);

        let (open_gate, gate) = mpsc::channel::<()>();
        let gate = Mutex::new(gate);
        ts.shell
            .restore
            .before_hook(Arc::new(move |session, reason| {
                if session.is_none() && reason == LockReason::Idle {
                    let _ = lock(&gate).recv_timeout(PATIENCE);
                }
            }));

        let answer = thread::scope(|scope| {
            let locking = scope.spawn(|| ts.shell.sessions.lock_all(LockReason::Idle));
            // Revoked at once (the session is locked, the epoch moved); its hooks are what waits.
            let start = Instant::now();
            while ts.shell.sessions.list()[0].state != SessionState::Locked {
                assert!(start.elapsed() < PATIENCE);
                thread::sleep(Duration::from_millis(1));
            }
            let answer = ts.shell.restore_commit(view.restore, REQUEST);
            open_gate.send(()).unwrap();
            locking.join().unwrap();
            answer
        });

        assert!(answer.unwrap().before_restore);
        assert!(dir.is_dir() && !ts.shell.paths.journal.exists());
        assert!(ts.shell.restore.is_idle());
        let _ = s;
    }

    /// A lock of every vault of any other kind whose hooks have not run yet when the answer comes is told apart from an
    /// idle one by the sessions' own count: the swap is refused and nothing is replaced, though the restore's own state
    /// still looks finished.
    #[test]
    fn a_lock_all_with_its_hook_still_queued_cancels_the_swap() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        let _ = (s, g);
        let before = names(&dir);
        let view = prepared(&ts, &backup, &parent);

        let (open_gate, gate) = mpsc::channel::<()>();
        let gate = Mutex::new(gate);
        ts.shell
            .restore
            .before_hook(Arc::new(move |session, reason| {
                if session.is_none() && reason == LockReason::Manual {
                    let _ = lock(&gate).recv_timeout(PATIENCE);
                }
            }));

        let answer = thread::scope(|scope| {
            let locking = scope.spawn(|| ts.shell.sessions.lock_all(LockReason::Manual));
            let start = Instant::now();
            while ts.shell.sessions.list()[0].state != SessionState::Locked {
                assert!(start.elapsed() < PATIENCE);
                thread::sleep(Duration::from_millis(1));
            }
            let answer = ts.shell.restore_commit(view.restore, REQUEST);
            open_gate.send(()).unwrap();
            locking.join().unwrap();
            answer
        });

        assert_eq!(answer.err(), CANCELLED);
        ended(&ts);
        assert_eq!(names(&dir), before, "the vault was not touched");
        assert!(staging_in(&parent).is_empty() && !ts.shell.paths.journal.exists());
        assert_eq!(names(&parent).len(), 1, "no older copy was made");
    }

    /// Every other way every vault locks ends the finished restore, and the answer that comes after says it was
    /// cancelled: Lock all (the person's own, the tray's, and the window's close button), Windows locking, sleep and the
    /// app closing. Its staging folder and journal go, and the vault is as it was.
    fn finished_restore_ended_by(how: impl FnOnce(&TestShell)) {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        let before = names(&dir);
        let view = prepared(&ts, &backup, &parent);
        assert!(!ts.shell.restore.is_idle());

        how(&ts);
        ended(&ts);

        assert_eq!(
            ts.shell.restore_commit(view.restore, REQUEST).err(),
            CANCELLED
        );
        assert_eq!(ts.shell.restore_discard(view.restore).err(), CANCELLED);
        assert!(staging_in(&parent).is_empty() && !ts.shell.paths.journal.exists());
        assert_eq!(names(&dir), before, "the vault was not touched");
        assert_eq!(names(&parent).len(), 1, "no older copy was made");
        let _ = (s, g);
    }

    #[test]
    fn lock_all_discards_a_finished_restore() {
        finished_restore_ended_by(|ts| ts.shell.sessions.lock_all(LockReason::Manual));
    }

    #[test]
    fn windows_lock_discards_a_finished_restore() {
        finished_restore_ended_by(|ts| ts.shell.autolock.signal(OsSignal::SessionLocked));
    }

    #[test]
    fn sleep_discards_a_finished_restore() {
        finished_restore_ended_by(|ts| ts.shell.autolock.signal(OsSignal::Suspending));
    }

    #[test]
    fn closing_the_app_discards_a_finished_restore() {
        finished_restore_ended_by(|ts| {
            if let Some(done) = ts.shell.sessions.close() {
                done.wait();
            }
        });
    }

    /// An idle lock does not end it, but a later lock of another kind does, and one of one other vault does not.
    #[test]
    fn a_lock_after_an_idle_one_still_discards_the_finished_restore() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let (other, _) = ts.open_vault("Other");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        let view = prepared(&ts, &backup, &parent);

        ts.shell.sessions.lock_all(LockReason::Idle);
        assert!(!ts.shell.restore.is_idle());
        // A vault unlocked and locked again by the person elsewhere is not the destination.
        let (again, _) = unlock(&ts, 2);
        ts.shell.sessions.lock(again, LockReason::Manual);
        assert!(
            !ts.shell.restore.is_idle(),
            "another vault's lock changes nothing"
        );

        ts.shell.sessions.lock_all(LockReason::WindowsLocked);
        ended(&ts);
        assert_eq!(
            ts.shell.restore_commit(view.restore, REQUEST).err(),
            CANCELLED
        );
        assert!(dir.is_dir() && staging_in(&parent).is_empty());
        let _ = (s, g, other);
    }

    /// A vault the shell does not know is open (its `.lock` is taken): the commit is refused as in use, and the staged
    /// restore stays for a retry with the same ID, which goes through once the vault is closed.
    #[test]
    fn vault_in_use_keeps_the_staged_restore() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        ts.shell.sessions.lock(s, LockReason::Manual);
        let (outside, _) = heavy(|| Vault::unlock_with_password(&dir, TEST_PASSWORD)).unwrap();
        let view = prepared(&ts, &backup, &parent);

        let refused = ts.shell.restore_commit(view.restore, REQUEST).err();
        assert_eq!(refused, Some(CoreError::VaultInUse.into()));
        assert_eq!(staging_in(&parent).len(), 1, "the staged restore is kept");
        assert!(ts.shell.paths.journal.exists());
        assert!(!ts.shell.restore.is_idle());
        drop(outside);

        let restored = ts.shell.restore_commit(view.restore, REQUEST).unwrap();
        assert!(restored.before_restore);
        assert!(staging_in(&parent).is_empty());
    }

    /// A command that holds the destination past the wait: `Busy`, the staged restore kept, and a retry goes through.
    #[test]
    fn commit_waits_for_the_destination_to_release() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let parent = vaults_folder(&ts);
        let view = prepared(&ts, &backup, &parent);

        let answer = RefCell::new(None);
        let _ = ts.shell.sessions.read(s, g, |_, _| {
            *answer.borrow_mut() = Some(ts.shell.restore_commit(view.restore, REQUEST));
            Ok(())
        });
        assert_eq!(
            answer.into_inner().unwrap().err(),
            Some(ShellError::Busy {
                what: "vault still finishing an operation"
            })
        );
        assert_eq!(staging_in(&parent).len(), 1);

        assert!(
            ts.shell
                .restore_commit(view.restore, REQUEST)
                .unwrap()
                .before_restore
        );
    }

    /// A swap that finished but could not be put on the vault list says so (the user adds the vault by hand).
    #[test]
    fn restore_whose_listing_fails_reports_vault_not_listed() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        let view = prepared(&ts, &backup, &parent);
        // The list can be read no more: a folder where the file was.
        fs::remove_file(&ts.shell.paths.registry).unwrap();
        fs::create_dir(&ts.shell.paths.registry).unwrap();

        let error = ts.shell.restore_commit(view.restore, REQUEST).unwrap_err();

        assert_eq!(error, VAULT_NOT_LISTED);
        assert!(error.reports_a_leftover());
        assert!(dir.is_dir(), "the vault was restored");
        assert!(!ts.shell.paths.journal.exists() && ts.shell.restore.is_idle());
    }

    /// Throwing away a prepared restore removes its staging folder; the vault is untouched.
    #[test]
    fn discard_removes_the_staged_restore() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        let before = names(&dir);
        let view = prepared(&ts, &backup, &parent);
        assert_eq!(
            ts.shell.restore_commit(view.restore + 1, REQUEST).err(),
            Some(ShellError::NotFound)
        );
        ts.shell.restore_discard(view.restore).unwrap();
        assert!(staging_in(&parent).is_empty() && !ts.shell.paths.journal.exists());
        assert_eq!(names(&dir), before);
        assert_eq!(
            ts.shell.restore_discard(view.restore).err(),
            Some(ShellError::NotFound)
        );
        assert_eq!(ts.shell.sessions.list()[0].state, SessionState::Unlocked);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Pre-restore folders.
    // ------------------------------------------------------------------------------------------------------------

    /// What a restore leaves is found again by a new shell, with the folder's name only; a copy of another vault, a
    /// link and a bad name are not listed.
    #[test]
    fn pre_restore_folders_found_after_restart() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let (other, _) = ts.open_vault("Other");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        let folder = dir.file_name().unwrap().to_string_lossy().into_owned();
        restore_once(&ts, &backup, &parent);
        restore_once(&ts, &backup, &parent);

        // Look-alikes: another vault's copy at a good name, a link at a good name, a plain folder.
        let impostor = parent.join(format!("{folder}.before-restore-3"));
        fs::create_dir(&impostor).unwrap();
        let other_dir = ts.shell.registry.entries()[1].1.clone();
        for header in ["vault.json", "vault.json.bak"] {
            fs::copy(other_dir.join(header), impostor.join(header)).unwrap();
        }
        make_dir_link(
            &parent.join(format!("{folder}.before-restore-4")),
            &parent.join(format!("{folder}.before-restore")),
        );
        fs::create_dir(parent.join(format!("{folder}.before-restore-5"))).unwrap();
        let _ = other;

        let restarted = restarted(&ts);
        let listed = restarted.list_pre_restore();
        let shown: Vec<(u32, u32, Option<&str>, &str)> = listed
            .iter()
            .map(|e| (e.id, e.vault, e.name.as_deref(), e.folder.as_str()))
            .collect();
        let first = format!("{folder}.before-restore");
        let second = format!("{folder}.before-restore-2");
        assert_eq!(
            shown,
            [
                (1, 1, Some("Family"), first.as_str()),
                (2, 1, Some("Family"), second.as_str())
            ]
        );
        // The names only: no path in what the page is sent.
        let json = serde_json::to_value(&listed).unwrap();
        for entry in json.as_array().unwrap() {
            let keys: Vec<&str> = entry
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect();
            assert_eq!(
                keys,
                ["folder", "id", "last_written", "name", "size", "vault"]
            );
            assert!(!entry["folder"].as_str().unwrap().contains('\\'), "{entry}");
        }
        // The next listing replaces the IDs.
        let again = restarted.list_pre_restore();
        assert_eq!(again.iter().map(|e| e.id).collect::<Vec<_>>(), [3, 4]);
        assert_eq!(
            restarted.delete_pre_restore(1, false).err(),
            Some(ShellError::NotFound),
            "an ID of an earlier listing"
        );
    }

    /// Opening and deleting a pre-restore folder: refused for a link, another vault's ID, a folder a session has
    /// open or opens, and an ID not listed; the right one is deleted after the yes, and nothing else is touched.
    #[test]
    fn pre_restore_delete_checks() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let (other, _) = ts.open_vault("Other");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        let _ = other;
        for _ in 0..3 {
            restore_once(&ts, &backup, &parent);
        }
        let listed = ts.shell.list_pre_restore();
        assert_eq!(listed.len(), 3);
        let at = |n: usize| parent.join(&listed[n].folder);

        // An ID that was never listed.
        assert_eq!(
            ts.shell.delete_pre_restore(99, true).err(),
            Some(ShellError::NotFound)
        );

        // A session open on it, and an open of it under way.
        let (read_only, _) = {
            let opened = heavy(|| {
                ts.shell
                    .open_pre_restore_read_only(listed[0].id, password())
            })
            .unwrap();
            assert!(opened.data.info.read_only);
            (opened.session, opened.generation)
        };
        let busy = Some(ShellError::Busy {
            what: "folder is open",
        });
        assert_eq!(ts.shell.delete_pre_restore(listed[0].id, true).err(), busy);
        let during = RefCell::new(None);
        let location = Location::folder(&at(1)).unwrap();
        let _ = ts.shell.sessions.open::<()>(Some(location), None, |_| {
            *during.borrow_mut() = Some(ts.shell.delete_pre_restore(listed[1].id, true).err());
            Err(ShellError::Cancelled)
        });
        assert_eq!(during.into_inner(), Some(busy));
        assert!(at(0).is_dir() && at(1).is_dir());

        // A link where the folder was.
        let elsewhere = ts.folder("Elsewhere");
        fs::write(elsewhere.join("keep.txt"), b"keep").unwrap();
        fs::remove_dir_all(at(2)).unwrap();
        make_dir_link(&at(2), &elsewhere);
        assert_eq!(
            ts.shell.delete_pre_restore(listed[2].id, true).err(),
            Some(ShellError::NotFound)
        );
        assert_eq!(
            heavy(|| ts
                .shell
                .open_pre_restore_read_only(listed[2].id, password()))
            .err(),
            Some(ShellError::NotFound)
        );
        assert!(
            elsewhere.join("keep.txt").exists(),
            "what the link leads to is untouched"
        );

        // Another vault's header in the folder: not the same vault.
        let other_dir = ts.shell.registry.entries()[1].1.clone();
        for header in ["vault.json", "vault.json.bak"] {
            fs::copy(other_dir.join(header), at(1).join(header)).unwrap();
        }
        ts.shell.sessions.lock(read_only, LockReason::Manual);
        assert_eq!(
            ts.shell.delete_pre_restore(listed[1].id, true).err(),
            Some(ShellError::NotFound)
        );
        assert!(at(1).is_dir());

        // The right one: a question first, nothing touched; the yes deletes it and only it.
        let before = names(&parent);
        let asked = ts.shell.delete_pre_restore(listed[0].id, false).unwrap();
        assert!(matches!(asked, Outcome::Confirm(Confirm::DeletePreRestore)));
        assert_eq!(names(&parent), before);
        done(ts.shell.delete_pre_restore(listed[0].id, true).unwrap());
        let mut after = before.clone();
        after.retain(|name| *name != listed[0].folder);
        assert_eq!(names(&parent), after);
        assert!(dir.is_dir() && other_dir.is_dir() && at(1).is_dir());
        assert_eq!(
            ts.shell.delete_pre_restore(listed[0].id, true).err(),
            Some(ShellError::NotFound),
            "gone from the listing"
        );
    }

    /// A pre-restore folder opens read-only beside the live vault, with the backup's old password or any credential
    /// of that copy, and a wrong one is refused; nothing is written in the folder.
    #[test]
    fn pre_restore_opens_read_only_beside_the_live_vault() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "old.pdf", b"old");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        ts.shell
            .new_item(
                s,
                g,
                crate::commands::items::NewKind::Note,
                "Newer".into(),
                None,
                None,
            )
            .unwrap();
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        // The backup is of the earlier state; the vault now holds one more item, and the restore keeps that as aside.
        let restored = restore_once(&ts, &backup, &parent);
        let listed = ts.shell.list_pre_restore();
        assert_eq!(listed.len(), 1);
        let aside = parent.join(&listed[0].folder);
        let before = names(&aside);

        let wrong = CredentialArg::Password(Zeroizing::new("another long password".into()));
        assert_eq!(
            heavy(|| ts.shell.open_pre_restore_read_only(listed[0].id, wrong)).err(),
            Some(CoreError::WrongPassword.into())
        );
        let old = heavy(|| {
            ts.shell
                .open_pre_restore_read_only(listed[0].id, password())
        })
        .unwrap();
        assert!(old.data.info.read_only);
        let (live, live_generation) = unlock(&ts, restored.vault);
        assert_eq!(
            titles(&ts, old.session, old.generation),
            ["Newer", "old.pdf"]
        );
        assert_eq!(titles(&ts, live, live_generation), ["old.pdf"]);
        assert_eq!(names(&aside), before, "nothing written in the folder");
        assert!(dir.is_dir());
        // An ID never listed does not open.
        assert_eq!(
            heavy(|| ts.shell.open_pre_restore_read_only(77, password())).err(),
            Some(ShellError::NotFound)
        );
    }

    /// A pre-restore copy whose name was edited still opens (it may be the only copy left), and says so (R2).
    #[test]
    fn pre_restore_copy_with_a_changed_header_says_so() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let parent = vaults_folder(&ts);
        restore_once(&ts, &backup, &parent);
        let listed = ts.shell.list_pre_restore();
        let open = |id| heavy(|| ts.shell.open_pre_restore_read_only(id, password())).unwrap();
        let clean = open(listed[0].id);
        assert!(!clean.data.header_changed);
        ts.shell.sessions.lock(clean.session, LockReason::Manual);
        assert!(ts.shell.sessions.release_wait(clean.session, RELEASE_WAIT));

        let header = parent.join(&listed[0].folder).join("vault.json");
        let mut edited: serde_json::Value =
            serde_json::from_slice(&fs::read(&header).unwrap()).unwrap();
        edited["name"] = "Renamed".into();
        fs::write(&header, edited.to_string()).unwrap();
        let listed = ts.shell.list_pre_restore();
        let changed = open(listed[0].id);
        assert!(changed.data.header_changed);
        assert!(changed.data.info.read_only);
    }

    /// A `.before-restore` folder the user added to the vault list is a live vault: it is not listed any more, and an ID
    /// listed before it was added neither opens nor deletes it, so no writable session ever comes back from these
    /// commands.
    #[test]
    fn a_pre_restore_folder_on_the_vault_list_is_a_live_vault() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let parent = vaults_folder(&ts);
        restore_once(&ts, &backup, &parent);
        let listed = ts.shell.list_pre_restore();
        assert_eq!(listed.len(), 1);
        let aside = parent.join(&listed[0].folder);

        // The user adds it as a vault and unlocks it, writable.
        ts.dialogs.answer(Some(aside.clone()));
        let added = done(ts.shell.add_existing_vault().unwrap());
        let (writable, _) = unlock(&ts, added.id);

        // The ID from the listing taken before it was added, with no new listing in between: the commands themselves
        // must see that the folder is a live vault.
        let opened = heavy(|| {
            ts.shell
                .open_pre_restore_read_only(listed[0].id, password())
        });
        assert_eq!(opened.err(), Some(ShellError::NotFound));
        assert_eq!(
            ts.shell.delete_pre_restore(listed[0].id, true).err(),
            Some(ShellError::NotFound)
        );
        assert!(aside.is_dir());
        assert!(
            ts.shell.list_pre_restore().is_empty(),
            "and a new listing does not list it"
        );
        let sessions = ts.shell.sessions.list();
        assert!(
            sessions
                .iter()
                .filter(|info| info.session != writable)
                .all(|info| info.session == s || info.read_only),
            "no other session came back"
        );
    }

    /// Every regular file under `dir` (links not followed), as a test counts them.
    fn files_under(dir: &Path) -> Vec<PathBuf> {
        let mut found = Vec::new();
        for entry in fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let kind = entry.file_type().unwrap();
            if kind.is_dir() {
                found.extend(files_under(&entry.path()));
            } else if kind.is_file() {
                found.push(entry.path());
            }
        }
        found
    }

    fn bytes_under(dir: &Path) -> u64 {
        files_under(dir)
            .iter()
            .map(|file| fs::metadata(file).unwrap().len())
            .sum()
    }

    /// Sets the modified time of `path` to the UTC moment `when` (`YYYY-MM-DDTHH:MM:SSZ`).
    fn touched(path: &Path, when: &str) {
        let secs = dates::parse_utc(when).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH + Duration::from_secs(secs))
            .unwrap();
    }

    /// An older copy says the last day its vault was written (the newest modified time of its header files, as the PC's
    /// zone calls that day) and its size (every regular file under it, links not followed). A file written later that
    /// is not a header does not move the day; what cannot be read is `null`, never a guess.
    #[test]
    fn pre_restore_list_says_the_day_and_size() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "report.pdf", &vec![5u8; 5000]);
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let parent = vaults_folder(&ts);
        restore_once(&ts, &backup, &parent);
        let listed = ts.shell.list_pre_restore();
        assert_eq!(listed.len(), 1);
        let aside = parent.join(&listed[0].folder);

        touched(&aside.join("vault.json"), "2026-11-03T10:00:00Z");
        touched(&aside.join("vault.json.bak"), "2026-11-04T12:00:00Z");
        let other = files_under(&aside)
            .into_iter()
            .find(|file| !file.ends_with("vault.json") && !file.ends_with("vault.json.bak"))
            .expect("the older copy holds more than its header");
        touched(&other, "2026-12-25T12:00:00Z");

        let day = |ts: &TestShell, hours: i64| {
            ts.clock.set_utc_offset_hours(hours);
            ts.shell.list_pre_restore().remove(0).last_written
        };
        assert_eq!(day(&ts, 0).as_deref(), Some("2026-11-04"));
        assert_eq!(
            day(&ts, 14).as_deref(),
            Some("2026-11-05"),
            "the PC's zone moves the day"
        );
        assert_eq!(day(&ts, -13).as_deref(), Some("2026-11-03"));

        let expected = bytes_under(&aside);
        assert!(expected > 5000, "the stored file counts");
        let entry = ts.shell.list_pre_restore().remove(0);
        assert_eq!(entry.size, Some(expected));

        // A link inside the folder is not followed, and what it leads to is not counted.
        let elsewhere = ts.folder("Elsewhere");
        fs::write(elsewhere.join("big.bin"), vec![1u8; 100_000]).unwrap();
        make_dir_link(&aside.join("linked"), &elsewhere);
        assert_eq!(
            ts.shell.list_pre_restore().remove(0).size,
            Some(expected),
            "a link is not followed"
        );

        // The two new keys are in what the page is sent, as a day and a number.
        let json = serde_json::to_value(ts.shell.list_pre_restore()).unwrap();
        assert!(json[0]["last_written"].is_string() && json[0]["size"].is_u64());

        // Nothing readable is `null`.
        let nothing = ts.folder("Nothing");
        assert_eq!(last_written_day(&nothing, 0), None);
        assert_eq!(folder_size(&nothing.join("gone")), None);
        assert_eq!(folder_size(&nothing), Some(0));
    }

    /// 24f's Open read-only takes the one box every backup field uses: a well-formed recovery key is tried as a key, then
    /// as a password; anything else as a password. The two old forms still work, and a wrong one is refused.
    #[test]
    fn pre_restore_opens_with_the_one_box_credential() {
        let ts = TestShell::new();
        let (s, g, recovery) = source_vault(&ts, "Family");
        let key = recovery.to_display().to_string();
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        // The vault is put on the shell's list (it is in the folder `Source` holds), then restored over.
        let source = ts.folder("Source");
        let vault_folder = fs::read_dir(&source)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.is_dir())
            .unwrap();
        ts.dialogs.answer(Some(vault_folder));
        done(ts.shell.add_existing_vault().unwrap());
        restore_once(&ts, &backup, &source);
        let listed = ts.shell.list_pre_restore();
        assert_eq!(listed.len(), 1);
        let id = listed[0].id;

        let open = |credential: CredentialArg| {
            let answer = heavy(|| ts.shell.open_pre_restore_read_only(id, credential));
            if let Ok(opened) = &answer {
                ts.shell.sessions.lock(opened.session, LockReason::Manual);
                assert!(ts.shell.sessions.release_wait(opened.session, RELEASE_WAIT));
            }
            answer
        };
        assert_eq!(
            open(typed("another long password")).err(),
            Some(CoreError::WrongPassword.into())
        );
        assert!(open(typed(&"abandon ".repeat(24))).is_err());
        let by_password = open(typed(TEST_PASSWORD)).unwrap();
        assert!(by_password.data.info.read_only);
        let by_key = open(typed(&key)).unwrap();
        assert!(by_key.data.info.read_only);
        // The two forms that were there before.
        assert!(open(password()).is_ok());
        let as_key = CredentialArg::RecoveryKey(Zeroizing::new(key));
        assert!(open(as_key).is_ok());
    }

    /// 24d's answer names the vault the swap would replace, as its ID on the vault list (24f lists that vault's older
    /// copies from it); a restore into a folder with no such vault names none.
    #[test]
    fn restore_prepared_names_the_vault_it_replaces() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let (_other, _) = ts.open_vault("Other");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let parent = vaults_folder(&ts);

        let view = prepared(&ts, &backup, &parent);
        assert!(view.replaces_existing);
        let listed = ts.shell.registry.entries();
        let family = listed
            .iter()
            .find(|(_, dir)| same_folder(dir, &vault_dir(&ts)))
            .map(|(id, _)| *id);
        assert!(family.is_some());
        assert_eq!(view.replaces, family);
        assert_eq!(
            serde_json::to_value(&view).unwrap()["replaces"],
            json!(family)
        );
        ts.shell.restore_discard(view.restore).unwrap();

        let fresh = ts.folder("Fresh");
        let view = prepared(&ts, &backup, &fresh);
        assert!(!view.replaces_existing);
        assert_eq!(view.replaces, None);
        assert!(serde_json::to_value(&view).unwrap()["replaces"].is_null());
    }

    /// All ninety-nine names taken: the swap refuses, and the finished restore stays (the same number), so that once one
    /// older copy is deleted the same Replace goes through, with the copy made where the deleted one was.
    #[test]
    fn too_many_copies_keeps_the_finished_restore() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        let folder = dir.file_name().unwrap().to_string_lossy().into_owned();
        restore_once(&ts, &backup, &parent);
        // The other ninety-eight names are taken by folders that are not older copies of this vault.
        for n in 2..=99 {
            fs::create_dir(parent.join(format!("{folder}.before-restore-{n}"))).unwrap();
        }
        let view = prepared(&ts, &backup, &parent);
        assert_eq!(view.kept_as, None, "no name is free");

        let refused = ts.shell.restore_commit(view.restore, REQUEST).err();
        assert!(
            matches!(&refused, Some(ShellError::Core(found))
                if found.what == Some("too many before-restore copies")),
            "{refused:?}"
        );
        assert!(!ts.shell.restore.is_idle(), "the finished restore is kept");
        assert!(!staging_in(&parent).is_empty());

        // The one older copy is listed and deleted; the same Replace is pressed again.
        let listed = ts.shell.list_pre_restore();
        assert_eq!(listed.len(), 1, "only a real older copy is listed");
        done(ts.shell.delete_pre_restore(listed[0].id, true).unwrap());
        let again = ts.shell.restore_commit(view.restore, REQUEST).unwrap();
        assert!(again.before_restore);
        assert!(parent.join(format!("{folder}.before-restore")).is_dir());
        assert!(ts.shell.restore.is_idle() && staging_in(&parent).is_empty());
    }

    /// The folder dialog of a restore ("Restore into this folder") opens in the folder the pick is in now: the usual
    /// vaults folder to begin with when there is one, and the folder last chosen after that. The backup's own picker
    /// opens no folder dialog, and the other folder dialogs give no start.
    #[test]
    fn restore_folder_picker_starts_in_the_current_folder() {
        let ts = TestShell::new();
        let (s, g, _) = source_vault(&ts, "Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let usual = usual_folder(&ts);
        let held = pick(&ts, &backup);
        assert!(ts.dialogs.folder_starts().is_empty(), "the pick opens none");
        check(&ts, &held.choice);

        let ask = || {
            // The folder picker is closed: dismissed, after it was opened.
            assert!(matches!(
                ts.shell.restore_choose_folder(&held.choice),
                Ok(Outcome::Dismissed)
            ));
        };
        ask();
        assert!(!usual.exists());
        fs::create_dir_all(&usual).unwrap();
        ask();
        let elsewhere = ts.folder("Elsewhere");
        choose(&ts, &held.choice, &elsewhere);
        ask();
        assert_eq!(
            ts.dialogs.folder_starts(),
            [None, Some(usual.clone()), Some(usual), Some(elsewhere)]
        );
        assert!(
            ts.dialogs
                .folder_titles()
                .iter()
                .all(|title| title == "Restore into this folder")
        );

        assert!(matches!(
            ts.shell.add_existing_vault(),
            Ok(Outcome::Dismissed)
        ));
        let created =
            ts.shell
                .create_vault("Family".into(), Zeroizing::new(TEST_PASSWORD.into()), true);
        assert!(matches!(created, Ok(Outcome::Dismissed)));
        assert_eq!(
            ts.dialogs.folder_starts()[4..],
            [None, None],
            "the other folder dialogs give no start"
        );
    }

    // ------------------------------------------------------------------------------------------------------------
    // Fix round 1.
    // ------------------------------------------------------------------------------------------------------------

    /// A failed commit goes straight from committing to recovering: while its recovery runs, no restore starts and no
    /// other recovery or dismissal does (it would remove the other restore's staging folder).
    #[test]
    fn no_restore_starts_between_a_failed_commit_and_its_recovery() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let parent = vaults_folder(&ts);
        let view = prepared(&ts, &backup, &parent);

        // `recover.under_lock` is reached by the engine's own recovery inside the commit (first) and then by the
        // shell's (second): the second is the handoff.
        let seen = Rc::new(RefCell::new(None));
        let hits = Rc::new(Cell::new(0));
        let (shell, dialogs, saw, counted) = (
            Arc::clone(&ts.shell),
            Arc::clone(&ts.dialogs),
            Rc::clone(&seen),
            Rc::clone(&hits),
        );
        failpoint::observe(
            "recover.under_lock",
            Box::new(move || {
                counted.set(counted.get() + 1);
                if counted.get() != 2 {
                    return;
                }
                let opened = dialogs.opened();
                let idle = shell.restore.is_idle();
                // Without the rule the state would be Idle here and a recovery would wait for the journal lock the
                // outer recovery holds: probe only when it is not, so the test fails instead of hanging.
                let (prepare, retry, dismiss) = match idle {
                    true => (None, None, None),
                    false => (
                        shell.restore_prepare(&unheld(), REQUEST).err(),
                        shell.retry_restore_recovery().err(),
                        shell.dismiss_restore(true).err(),
                    ),
                };
                *saw.borrow_mut() =
                    Some((idle, prepare, retry, dismiss, dialogs.opened() == opened));
            }),
        );
        failpoint::arm("restore.after_move_existing");
        failpoint::arm("recover.under_lock");
        let error = ts.shell.restore_commit(view.restore, REQUEST).unwrap_err();
        failpoint::disarm_all();

        assert_eq!(error, restore_pending());
        assert_eq!(hits.get(), 2, "the engine's recovery, then the shell's");
        let (idle, prepare, retry, dismiss, no_picker) = seen.borrow_mut().take().unwrap();
        assert!(!idle, "not Idle between the commit and its recovery");
        assert_eq!((prepare, retry, dismiss), (BUSY, BUSY, BUSY));
        assert!(no_picker);
        assert!(ts.shell.restore.is_idle(), "and Idle once it is over");
    }

    /// The engine says whether a failed commit left the restore as it was, not the journal's text: with the journal
    /// unreadable, a commit the engine kept stays `Prepared` with the same ID.
    #[test]
    fn failed_commit_the_engine_kept_stays_prepared_even_when_the_journal_cannot_be_read() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        ts.shell.sessions.lock(s, LockReason::Manual);
        let (outside, _) = heavy(|| Vault::unlock_with_password(&dir, TEST_PASSWORD)).unwrap();
        let view = prepared(&ts, &backup, &parent);
        let journal = ts.shell.paths.journal.clone();
        let written = fs::read(&journal).unwrap();
        fs::write(&journal, b"not readable as a journal").unwrap();

        let refused = ts.shell.restore_commit(view.restore, REQUEST).err();
        assert_eq!(refused, Some(CoreError::VaultInUse.into()));
        assert!(!ts.shell.restore.is_idle(), "still prepared");
        assert_eq!(staging_in(&parent).len(), 1, "the staged restore is kept");

        // The same ID commits once the vault is closed and the journal is as it was.
        drop(outside);
        fs::write(&journal, written).unwrap();
        assert!(
            ts.shell
                .restore_commit(view.restore, REQUEST)
                .unwrap()
                .before_restore
        );
    }

    /// The destination is a place, not a session: a vault unlocked after `prepare` (or after a `Busy` retry) and then
    /// locked by the user ends the restore.
    #[test]
    fn destination_unlocked_after_prepare_then_locked_cancels() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));

        // Locked when prepared, unlocked, then locked by the user.
        ts.shell.sessions.lock(s, LockReason::Manual);
        let view = prepared(&ts, &backup, &parent);
        unlock(&ts, 1);
        ts.shell.sessions.lock(s, LockReason::Manual);
        ended(&ts);
        assert_eq!(
            ts.shell.restore_commit(view.restore, REQUEST).err(),
            CANCELLED
        );
        assert!(staging_in(&parent).is_empty() && !ts.shell.paths.journal.exists());

        // Open when prepared; a command holds it past the wait (`Busy`); unlocked again, then locked by the user.
        let (open, open_generation) = unlock(&ts, 1);
        let view = prepared(&ts, &backup, &parent);
        let answer = RefCell::new(None);
        let _ = ts.shell.sessions.read(open, open_generation, |_, _| {
            *answer.borrow_mut() = Some(ts.shell.restore_commit(view.restore, REQUEST));
            Ok(())
        });
        assert!(matches!(
            answer.into_inner().unwrap().err(),
            Some(ShellError::Busy { .. })
        ));
        assert!(!ts.shell.restore.is_idle(), "kept for a retry");
        unlock(&ts, 1);
        ts.shell.sessions.lock(s, LockReason::Manual);
        ended(&ts);
        assert_eq!(
            ts.shell.restore_commit(view.restore, REQUEST).err(),
            CANCELLED
        );
        assert!(staging_in(&parent).is_empty() && dir.is_dir());
    }

    /// A lock of all vaults that lands while the commit waits for the destination, with its hooks still queued (so the
    /// token is not cancelled yet), still ends the restore before the swap.
    #[test]
    fn a_lock_just_before_the_swap_cancels_it() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        let _ = g;
        let _ = s;
        let view = prepared(&ts, &backup, &parent);

        // The restore's own lock of the destination starts a lock of all vaults on another thread and waits for its
        // revocation (the epoch moves); the hooks of that lock of all vaults are held back, the restore's first.
        let weak = Arc::downgrade(&ts.shell);
        let (open_gate, gate) = mpsc::channel::<()>();
        let gate = Mutex::new(gate);
        let locker = Arc::new(Mutex::new(None));
        let held = Arc::clone(&locker);
        ts.shell
            .restore
            .before_hook(Arc::new(move |session, reason| match (session, reason) {
                (Some(_), LockReason::Restore) => {
                    let shell = weak.upgrade().unwrap();
                    let epoch = shell.sessions.epoch();
                    let other = Arc::clone(&shell);
                    *lock(&held) = Some(thread::spawn(move || {
                        other.sessions.lock_all(LockReason::Manual)
                    }));
                    let start = Instant::now();
                    while shell.sessions.epoch() == epoch {
                        assert!(start.elapsed() < PATIENCE);
                        thread::sleep(Duration::from_millis(1));
                    }
                }
                (None, LockReason::Manual) => {
                    let _ = lock(&gate).recv_timeout(PATIENCE);
                }
                _ => {}
            }));

        let answer = ts.shell.restore_commit(view.restore, REQUEST).err();
        open_gate.send(()).unwrap();
        let locker = lock(&locker).take().unwrap();
        locker.join().unwrap();

        assert_eq!(answer, CANCELLED);
        assert!(dir.is_dir(), "the vault was not swapped");
        assert!(staging_in(&parent).is_empty() && !ts.shell.paths.journal.exists());
        assert_eq!(names(&parent).len(), 1, "no pre-restore folder was made");
    }

    /// The destination was open when the restore became prepared, the user locks that one session, and its hook is still
    /// queued behind another when the commit arrives: no session is found there, the token is not cancelled and the lock
    /// of one session does not move the epoch, yet the restore must not go ahead.
    #[test]
    fn destination_lock_with_its_hook_still_queued_cancels() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        let _ = g;
        let view = prepared(&ts, &backup, &parent);

        // The restore's hook is held back for the user's lock of the destination.
        let (open_gate, gate) = mpsc::channel::<()>();
        let gate = Mutex::new(gate);
        ts.shell
            .restore
            .before_hook(Arc::new(move |session, reason| {
                if session.is_some() && reason == LockReason::Manual {
                    let _ = lock(&gate).recv_timeout(PATIENCE);
                }
            }));

        let answer = thread::scope(|scope| {
            let locking = scope.spawn(|| ts.shell.sessions.lock(s, LockReason::Manual));
            // Revoked at once (the session is locked); its hooks are what waits.
            let start = Instant::now();
            while ts.shell.sessions.list()[0].state != SessionState::Locked {
                assert!(start.elapsed() < PATIENCE);
                thread::sleep(Duration::from_millis(1));
            }
            let answer = ts.shell.restore_commit(view.restore, REQUEST).err();
            open_gate.send(()).unwrap();
            locking.join().unwrap();
            answer
        });

        assert_eq!(answer, CANCELLED);
        assert!(dir.is_dir(), "the vault was not swapped");
        assert!(staging_in(&parent).is_empty() && !ts.shell.paths.journal.exists());
        assert_eq!(names(&parent).len(), 1, "no pre-restore folder was made");
        assert!(ts.shell.restore.is_idle());
    }

    /// The pages' answers keep their shapes.
    #[test]
    fn confirm_and_view_shapes_for_the_page() {
        let token = |text: &str| serde_json::from_value::<Token>(json!(text)).unwrap();
        let hex = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            serde_json::to_value(Confirm::NewFolder {
                suggested: "Clients-1a2b3c4d (restored)".into(),
                token: token(hex)
            })
            .unwrap(),
            json!({ "NewFolder": { "suggested": "Clients-1a2b3c4d (restored)", "token": hex } })
        );
        assert_eq!(
            serde_json::to_value(Confirm::Dismissal {
                leaves: Leaves {
                    staging: None,
                    before_restore: Some(r"C:\V\Family.before-restore".into())
                }
            })
            .unwrap(),
            json!({ "Dismissal": { "leaves": { "staging": null, "before_restore": r"C:\V\Family.before-restore" } } })
        );
        assert_eq!(
            serde_json::to_value(Confirm::DeletePreRestore).unwrap(),
            json!("DeletePreRestore")
        );
        assert_eq!(
            serde_json::to_value(Confirm::Recovery {
                notice: RestoreNotice::Recovered {
                    how: Recovered::Finished,
                    vault: None
                }
            })
            .unwrap(),
            json!({ "Recovery": { "notice": { "state": "recovered", "how": "finished", "vault": null } } })
        );
        assert_eq!(
            serde_json::to_value(RestorePreparedView {
                restore: 3,
                name: "Family".into(),
                replaces_existing: true,
                kept_as: Some("Family-1a2b3c4d.before-restore".into()),
                replaces: Some(2),
            })
            .unwrap(),
            json!({
                "restore": 3, "name": "Family", "replaces_existing": true,
                "kept_as": "Family-1a2b3c4d.before-restore", "replaces": 2
            })
        );
        assert_eq!(
            serde_json::to_value(RestorePreparedView {
                restore: 4,
                name: "Family".into(),
                replaces_existing: false,
                kept_as: None,
                replaces: None,
            })
            .unwrap(),
            json!({
                "restore": 4, "name": "Family", "replaces_existing": false, "kept_as": null,
                "replaces": null
            })
        );
        assert_eq!(
            serde_json::to_value(RestorePick {
                choice: token(hex),
                file_name: "family.lockbox-backup".into(),
                size: 2048,
            })
            .unwrap(),
            json!({ "choice": hex, "file_name": "family.lockbox-backup", "size": 2048 })
        );
        assert_eq!(
            serde_json::to_value(RestoreChecked {
                name: "Family".into(),
                made: Some("2026-11-16".into()),
                folder_shown: r"C:\Users\Me\Lockbox Vaults\Family-1a2b3c4d".into(),
                usual: true,
                replaces_existing: false,
            })
            .unwrap(),
            json!({
                "name": "Family", "made": "2026-11-16",
                "folder_shown": r"C:\Users\Me\Lockbox Vaults\Family-1a2b3c4d",
                "usual": true, "replaces_existing": false
            })
        );
        assert_eq!(
            serde_json::to_value(RestoredView {
                vault: 2,
                before_restore: false
            })
            .unwrap(),
            json!({ "vault": 2, "before_restore": false })
        );
    }

    #[test]
    fn pre_restore_names_follow_the_engine_rule() {
        let yes = |candidate: &str| is_pre_restore_name(candidate, "Family-1a2b3c4d");
        for ok in [
            "Family-1a2b3c4d.before-restore",
            "Family-1a2b3c4d.before-restore-2",
            "Family-1a2b3c4d.before-restore-99",
            "FAMILY-1A2B3C4D.BEFORE-RESTORE",
            "family-1a2b3c4d.Before-Restore-17",
        ] {
            assert!(yes(ok), "{ok}");
        }
        for bad in [
            "Family-1a2b3c4d",
            "Family-1a2b3c4d.before-restore-1",
            "Family-1a2b3c4d.before-restore-02",
            "Family-1a2b3c4d.before-restore-100",
            "Family-1a2b3c4d.before-restore-0",
            "Family-1a2b3c4d.before-restore-",
            "Family-1a2b3c4d.before-restore-2x",
            "Family-1a2b3c4d.before-restore.bak",
            "Family-1a2b3c4d.before-restore-+2",
            "Other-1a2b3c4d.before-restore",
            "x.Family-1a2b3c4d.before-restore",
            "Family-1a2b3c4d .before-restore",
            ".before-restore",
        ] {
            assert!(!yes(bad), "{bad}");
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // Task 6: a restore that did not finish, and the questions that offer a backup.
    // ------------------------------------------------------------------------------------------------------------

    /// A vault the engine makes in the folder `Source`, open as a session and on the vault list: its session, generation,
    /// list ID and folder. Its folder is not the usual one.
    fn listed_in_source(ts: &TestShell, name: &str) -> (SessionId, u64, u32, PathBuf) {
        let (s, g, _) = source_vault(ts, name);
        let source = ts.folder("Source");
        let folder = names(&source).remove(0);
        let dir = fs::canonicalize(source.join(folder)).unwrap();
        let id = ts.shell.registry.add(&dir).unwrap();
        (s, g, id, dir)
    }

    /// Both header copies of the vault in `dir` damaged (its session locked first).
    fn damage_both_headers(ts: &TestShell, s: SessionId, dir: &Path) {
        ts.shell.sessions.lock(s, LockReason::Manual);
        for header in ["vault.json", "vault.json.bak"] {
            fs::write(dir.join(header), b"damaged").unwrap();
        }
    }

    /// Every file under `dir` with its bytes, by its path inside `dir`.
    fn snapshot(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        fn walk(root: &Path, at: &Path, found: &mut Vec<(PathBuf, Vec<u8>)>) {
            for entry in fs::read_dir(at).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(root, &path, found);
                } else {
                    let inside = path.strip_prefix(root).unwrap().to_path_buf();
                    found.push((inside, fs::read(&path).unwrap()));
                }
            }
        }
        let mut found = Vec::new();
        walk(dir, dir, &mut found);
        found.sort();
        found
    }

    /// Picks `backup` for the vault `vault` of the list.
    fn pick_for(ts: &TestShell, backup: &Path, vault: u32) -> RestorePick {
        ts.dialogs.answer(Some(backup.to_path_buf()));
        done(ts.shell.restore_pick(None, Some(vault)).unwrap())
    }

    /// Ask 8's start: a vault whose two header copies are damaged, in a folder that is not the usual one, and a good
    /// backup of it. The held pick is made for that vault and checked.
    struct Damaged {
        ts: TestShell,
        dir: PathBuf,
        parent: PathBuf,
        choice: Token,
        before: Vec<(PathBuf, Vec<u8>)>,
    }

    fn damaged_vault_picked() -> Damaged {
        let ts = TestShell::new();
        let (s, g, id, dir) = listed_in_source(&ts, "Clients");
        ts.stored_file(s, g, "report.pdf", b"report");
        let backup = backup_of(&ts, s, g, "clients.lockbox-backup");
        damage_both_headers(&ts, s, &dir);
        let before = snapshot(&dir);
        let held = pick_for(&ts, &backup, id);
        let view = check(&ts, &held.choice);
        assert!(!view.usual && !view.replaces_existing);
        Damaged {
            parent: dir.parent().unwrap().to_path_buf(),
            ts,
            dir,
            choice: held.choice,
            before,
        }
    }

    /// Ask 4's case (the vault opens, some of its items cannot be read): the pick made for the vault goes to the folder that
    /// holds it, not the usual one, finds the vault there and replaces it, keeping it as an older copy.
    #[test]
    fn restore_pick_starts_in_the_given_vaults_folder() {
        let ts = TestShell::new();
        let (s, g, id, dir) = listed_in_source(&ts, "Clients");
        ts.stored_file(s, g, "report.pdf", b"report");
        let backup = backup_of(&ts, s, g, "clients.lockbox-backup");
        let usual = usual_folder(&ts);

        let held = pick_for(&ts, &backup, id);
        let view = check(&ts, &held.choice);
        assert!(!view.usual, "not the usual folder");
        assert!(view.replaces_existing);
        assert_eq!(
            fs::canonicalize(&view.folder_shown).unwrap(),
            dir,
            "it names the open vault's own folder"
        );
        assert!(!usual.exists(), "nothing was made in the usual folder");

        // Choose another still replaces the folder.
        let elsewhere = ts.folder("Elsewhere");
        let moved = choose(&ts, &held.choice, &elsewhere);
        assert!(!moved.usual && !moved.replaces_existing);
        let back = choose(&ts, &held.choice, dir.parent().unwrap());
        assert!(back.replaces_existing);

        let prepared = done(copy(&ts, &held.choice).unwrap());
        assert!(prepared.replaces_existing);
        assert!(prepared.kept_as.is_some(), "the open vault is kept");
        let restored = ts.shell.restore_commit(prepared.restore, REQUEST).unwrap();
        assert_eq!(restored.vault, id, "the same vault on the list");
        assert!(restored.before_restore);
        assert!(!usual.exists());
        let (s2, g2) = unlock(&ts, restored.vault);
        assert_eq!(titles(&ts, s2, g2), ["report.pdf"]);
    }

    /// A vault that is not on the list is refused before a picker opens and nothing is held; one forgotten after the pick
    /// is refused by the check.
    #[test]
    fn restore_pick_refuses_a_vault_not_listed() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dialogs, held) = (ts.dialogs.opened(), ts.shell.sessions.pending().len());

        assert_eq!(
            ts.shell.restore_pick(None, Some(99)).err(),
            Some(ShellError::NotFound)
        );
        assert_eq!(ts.dialogs.opened(), dialogs, "no picker opened");
        assert_eq!(ts.shell.sessions.pending().len(), held, "nothing held");

        let first = pick_for(&ts, &backup, 1);
        ts.shell.registry.forget(1).unwrap();
        assert_eq!(
            heavy(|| ts.shell.restore_check(&first.choice, working())).err(),
            Some(ShellError::NotFound)
        );
        assert!(ts.shell.restore.is_idle());
    }

    /// A vault with both header copies damaged lists with no name, as available and with its details damaged: the page's
    /// trigger for Ask 8.
    #[test]
    fn both_headers_unreadable_listed_without_a_name() {
        let ts = TestShell::new();
        let (s, _) = ts.open_vault("Clients");
        let dir = vault_dir(&ts);
        let first = || ts.shell.registry.list().unwrap().remove(0);
        assert_eq!(first().name.as_deref(), Some("Clients"));
        assert!(!first().details_damaged);
        ts.shell.sessions.lock(s, LockReason::Manual);
        // One header copy is enough to name it: only the two together look like this.
        fs::write(dir.join("vault.json"), b"damaged").unwrap();
        assert_eq!(first().name.as_deref(), Some("Clients"));
        assert!(!first().details_damaged);
        damage_both_headers(&ts, s, &dir);
        let listed = first();
        assert_eq!(
            (listed.id, listed.name.as_deref(), listed.available),
            (1, None, true)
        );
        assert!(listed.details_damaged);
        assert_eq!(
            serde_json::to_value(&listed).unwrap(),
            json!({ "id": 1, "name": null, "available": true, "details_damaged": true })
        );
        // Header files that are there but unreadable count whichever copy is left, and a lost copy does not clear it.
        fs::remove_file(dir.join("vault.json")).unwrap();
        assert!(first().details_damaged, "only the other copy is there");
        // No header files at all is not "damaged": nothing says a vault was there.
        fs::remove_file(dir.join("vault.json.bak")).unwrap();
        assert!(!first().details_damaged);
    }

    /// A listed folder with no vault in it also lists with no name and as available, but its details are not damaged: it
    /// holds no header files. Nor is a folder whose drive is gone.
    #[test]
    fn a_listed_folder_with_no_vault_in_it_lists_the_same_way() {
        let ts = TestShell::new();
        let empty = ts.folder("Nothing here");
        fs::write(empty.join("notes.txt"), b"not a vault").unwrap();
        let id = ts.shell.registry.add(&empty).unwrap();
        let listed = ts.shell.registry.list().unwrap();
        assert_eq!((listed[0].id, listed[0].name.as_deref()), (id, None));
        assert!(listed[0].available);
        assert!(!listed[0].details_damaged);
        fs::remove_dir_all(&empty).unwrap();
        let gone = ts.shell.registry.list().unwrap();
        assert!(!gone[0].available && !gone[0].details_damaged);
    }

    /// Ask 8: from a vault whose headers are both damaged the backup unpacks into a new folder in the same parent
    /// (not the usual one) and the damaged folder's files are byte for byte what they were.
    #[test]
    fn ask_8_restores_beside_the_damaged_folder() {
        let Damaged {
            ts,
            dir,
            parent,
            choice,
            before,
            ..
        } = damaged_vault_picked();
        let usual = usual_folder(&ts);

        // Its default name is the damaged folder's own: the existing new-folder question comes up.
        let Outcome::Confirm(Confirm::NewFolder { suggested, token }) = copy(&ts, &choice).unwrap()
        else {
            panic!("not asked for a new folder");
        };
        assert_eq!(snapshot(&dir), before, "nothing written yet");
        let view = done(
            heavy(|| {
                ts.shell
                    .restore_prepare_confirm(&token, Some(suggested.clone()), REQUEST)
            })
            .unwrap(),
        );
        assert!(!view.replaces_existing);
        let restored = ts.shell.restore_commit(view.restore, REQUEST).unwrap();
        assert!(!restored.before_restore);
        assert_ne!(restored.vault, 1, "a vault of its own on the list");

        let fresh = parent.join(&suggested);
        assert!(fresh.is_dir(), "a new folder in the damaged one's parent");
        assert_eq!(snapshot(&dir), before, "the damaged folder is untouched");
        assert!(!usual.exists(), "nothing went to the usual folder");
        let mut folders = names(&parent);
        folders.sort();
        let mut expected = vec![
            dir.file_name().unwrap().to_string_lossy().into_owned(),
            suggested,
        ];
        expected.sort();
        assert_eq!(folders, expected);
        let (s2, g2) = unlock(&ts, restored.vault);
        assert_eq!(titles(&ts, s2, g2), ["report.pdf"]);
    }

    /// A new folder beside the damaged one never takes a name that is in use: the damaged folder's own name (in any letter
    /// case) and a sibling's are refused with nothing written, and the pick stays for a name that is free.
    #[test]
    fn destination_beside_refuses_an_existing_name() {
        let Damaged {
            ts,
            dir,
            parent,
            choice,
            before,
            ..
        } = damaged_vault_picked();
        let sibling = parent.join("Taken");
        fs::create_dir_all(&sibling).unwrap();
        let own = dir.file_name().unwrap().to_string_lossy().into_owned();
        let listing = names(&parent);

        for name in [own.clone(), own.to_uppercase(), "Taken".to_owned()] {
            let Outcome::Confirm(Confirm::NewFolder { token, .. }) = copy(&ts, &choice).unwrap()
            else {
                panic!("not asked for a new folder");
            };
            let refused = heavy(|| {
                ts.shell
                    .restore_prepare_confirm(&token, Some(name.clone()), REQUEST)
            })
            .err();
            assert!(
                matches!(&refused, Some(ShellError::Core(view)) if view.kind == "invalid_input"),
                "{name}: {refused:?}"
            );
            assert_eq!(names(&parent), listing, "{name}: nothing written");
            assert_eq!(snapshot(&dir), before, "{name}: the damaged folder");
            assert!(ts.shell.restore.is_idle() && !ts.shell.paths.journal.exists());
        }

        // The pick is still held: a free name goes through.
        let Outcome::Confirm(Confirm::NewFolder { token, .. }) = copy(&ts, &choice).unwrap() else {
            panic!("not asked once more");
        };
        let view = done(
            heavy(|| {
                ts.shell
                    .restore_prepare_confirm(&token, Some("Clients again".into()), REQUEST)
            })
            .unwrap(),
        );
        ts.shell.restore_commit(view.restore, REQUEST).unwrap();
        assert!(parent.join("Clients again").is_dir());
        assert_eq!(snapshot(&dir), before);
    }

    /// Ask 8 again, after a restore from it already made a healthy vault of the same ID beside the damaged one: the
    /// second restore is refused ("vault already here", as the engine refuses a second writable copy of a vault in one
    /// folder), never a replacement of the first, which the engine's same-vault rule would have found and replaced. The
    /// check still says the restore replaces nothing. The first sibling and the damaged folder are as they were.
    #[test]
    fn a_second_ask_8_restore_never_replaces_the_first_sibling() {
        let Damaged {
            ts,
            dir,
            parent,
            choice,
            before,
        } = damaged_vault_picked();
        let Outcome::Confirm(Confirm::NewFolder { suggested, token }) = copy(&ts, &choice).unwrap()
        else {
            panic!("not asked for a new folder");
        };
        let view = done(
            heavy(|| {
                ts.shell
                    .restore_prepare_confirm(&token, Some(suggested.clone()), REQUEST)
            })
            .unwrap(),
        );
        let first = ts.shell.restore_commit(view.restore, REQUEST).unwrap();
        let sibling = parent.join(&suggested);
        let sibling_before = snapshot(&sibling);
        let listing = names(&parent);

        // Again, from the same damaged vault.
        let backup = ts.folder("Backups").join("clients.lockbox-backup");
        let held = pick_for(&ts, &backup, 1);
        let checked = check(&ts, &held.choice);
        assert!(
            !checked.usual && !checked.replaces_existing,
            "not the sibling"
        );
        // Refused, as the engine refuses a second writable copy in a folder: not the sibling replaced (an older copy kept,
        // the swap confirmed) as the same-vault rule would have it. Nothing is written.
        assert_eq!(copy(&ts, &held.choice).err(), Some(ALREADY_HERE));
        assert_eq!(snapshot(&sibling), sibling_before, "the first sibling");
        assert_eq!(snapshot(&dir), before, "the damaged folder");
        assert_eq!(names(&parent), listing, "nothing written, no older copy");
        assert!(!ts.shell.paths.journal.exists() && ts.shell.restore.is_idle());
        assert_eq!(ts.shell.registry.entries().len(), 2);
        assert_eq!(first.vault, 2);
        // The first sibling still opens.
        let (s2, g2) = unlock(&ts, first.vault);
        assert_eq!(titles(&ts, s2, g2), ["report.pdf"]);
    }

    /// A damaged vault whose folder has another name than the default one: the restore needs no question and goes to the
    /// default-named new folder; a second one is refused with that sibling there, and the damaged folder is never written.
    #[test]
    fn ask_8_from_a_renamed_folder_goes_to_the_default_folder() {
        let ts = TestShell::new();
        let (s, g, _) = source_vault(&ts, "Clients");
        ts.stored_file(s, g, "report.pdf", b"report");
        let backup = backup_of(&ts, s, g, "clients.lockbox-backup");
        let source = ts.folder("Source");
        let own = source.join(names(&source).remove(0));
        damage_both_headers(&ts, s, &own);
        let old = source.join("Old stuff");
        fs::rename(&own, &old).unwrap();
        let id = ts
            .shell
            .registry
            .add(&fs::canonicalize(&old).unwrap())
            .unwrap();
        let before = snapshot(&old);

        let held = pick_for(&ts, &backup, id);
        check(&ts, &held.choice);
        let view = done(copy(&ts, &held.choice).unwrap());
        assert!(!view.replaces_existing);
        let first = ts.shell.restore_commit(view.restore, REQUEST).unwrap();
        assert!(!first.before_restore);
        assert_ne!(first.vault, id);

        let held = pick_for(&ts, &backup, id);
        check(&ts, &held.choice);
        // The first sibling is there: refused, never replaced.
        assert_eq!(copy(&ts, &held.choice).err(), Some(ALREADY_HERE));
        assert_eq!(snapshot(&old), before, "the damaged folder");
        assert_eq!(ts.shell.registry.entries().len(), 2);
        assert!(!ts.shell.paths.journal.exists());
    }

    /// A header another program holds (a sharing violation) is not damage: the lock screen must still ask for the
    /// password. A real sharing violation, made by opening the file with no sharing; the engine retries it for a few seconds
    /// before it gives up, so the test takes that long.
    #[cfg(windows)]
    #[test]
    fn a_header_held_by_another_program_is_not_damage() {
        use std::os::windows::fs::OpenOptionsExt;

        let ts = TestShell::new();
        let (s, _) = ts.open_vault("Clients");
        let dir = vault_dir(&ts);
        ts.shell.sessions.lock(s, LockReason::Manual);
        // The other copy is corrupt: with the first held, no copy can be read, and one of them is only busy.
        fs::write(dir.join("vault.json.bak"), b"damaged").unwrap();
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(dir.join("vault.json"))
            .unwrap();
        let listed = ts.shell.registry.list().unwrap().remove(0);
        assert_eq!(listed.name, None);
        assert!(listed.available);
        assert!(!listed.details_damaged, "busy is not damaged");
        drop(held);
        let listed = ts.shell.registry.list().unwrap().remove(0);
        assert_eq!(listed.name.as_deref(), Some("Clients"));
        assert!(!listed.details_damaged);
    }

    /// A restore undone at launch names the vault it put back, as the vault list knows it.
    #[test]
    fn recovered_notice_names_the_vault() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let parent = vaults_folder(&ts);
        crash_mid_swap(&ts, &backup, &parent);

        let restarted = restarted(&ts);
        restarted.launch_work();

        let RestoreNotice::Recovered { how, vault } = restarted.restore_notice() else {
            panic!("not recovered");
        };
        assert_eq!(how, Recovered::RolledBack);
        assert_eq!(
            vault,
            Some(NoticeVault {
                id: 1,
                name: "Family".into()
            })
        );
        let kept = serde_json::to_value(&restarted.launch_notices()[0]).unwrap();
        assert_eq!(
            kept,
            json!({
                "kind": "restore", "state": "recovered", "how": "rolled_back",
                "vault": { "id": 1, "name": "Family" }
            })
        );
    }

    /// A restore whose swap ended before the page listed the vault: recovery at launch finishes it, the vault is
    /// listed (it was not), and the notice names it.
    #[test]
    fn finished_restore_at_launch_is_listed() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g, _) = source_vault(&ts, "Clients");
        let backup = backup_of(&ts, s, g, "clients.lockbox-backup");
        let elsewhere = ts.folder("Elsewhere");
        let view = prepared(&ts, &backup, &elsewhere);
        failpoint::arm("restore.before_journal_done");
        failpoint::arm("recover.under_lock");
        let error = ts.shell.restore_commit(view.restore, REQUEST).unwrap_err();
        failpoint::disarm_all();
        assert_eq!(error, restore_pending());
        assert!(ts.shell.registry.entries().is_empty(), "not listed yet");
        assert!(ts.shell.paths.journal.exists());

        let restarted = restarted(&ts);
        restarted.launch_work();

        let RestoreNotice::Recovered { how, vault } = restarted.restore_notice() else {
            panic!("not recovered");
        };
        assert_eq!(how, Recovered::Finished);
        assert_eq!(
            vault,
            Some(NoticeVault {
                id: 1,
                name: "Clients".into()
            })
        );
        let listed = restarted.registry.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(
            (listed[0].name.as_deref(), listed[0].available),
            (Some("Clients"), true)
        );
        assert!(!restarted.paths.journal.exists());
        let listed_dir = restarted.registry.path(1).unwrap();
        assert!(same_folder(listed_dir.parent().unwrap(), &elsewhere));
        // Once listed, a later recovery of the same kind does not list it twice.
        assert_eq!(restarted.registry.entries().len(), 1);
    }

    /// The notice for a drive that is not connected names the folder that held the restore's folders, as text.
    #[test]
    fn drive_missing_names_the_parent_folder() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        crash_mid_swap(&ts, &backup, &parent);

        let unplugged = parent.with_file_name("Lockbox Vaults (unplugged)");
        fs::rename(&parent, &unplugged).unwrap();
        let notice = ts.shell.retry_restore_recovery().unwrap();
        let told = serde_json::to_value(&notice).unwrap();
        let sent_to_page = ts.events.notices().last().cloned().unwrap();
        assert_eq!(told["state"], "drive_missing");
        let folder = told["folder"].as_str().unwrap().to_owned();
        assert_eq!(sent_to_page["folder"], told["folder"]);
        assert!(!folder.starts_with(r"\\?\"), "shown as the user knows it");
        let vault_folder = dir.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            !folder.ends_with(&vault_folder),
            "the parent, not the vault"
        );
        assert!(told["paths"]["target"].as_str().unwrap().len() > folder.len());

        fs::rename(&unplugged, &parent).unwrap();
        assert!(same_folder(Path::new(&folder), &parent));
        // The other states carry no folder.
        let pending = RestoreNotice::Pending(JournalPaths {
            step: JournalStep::Swapping,
            staging: String::new(),
            target: String::new(),
            before_restore: None,
        });
        assert!(
            serde_json::to_value(&pending)
                .unwrap()
                .get("folder")
                .is_none()
        );
    }

    /// The notice reaches the page as one flat object, and never shows a path in `Debug`.
    #[test]
    fn notice_json_is_flat_and_debug_hides_paths() {
        let paths = JournalPaths {
            step: JournalStep::Swapping,
            staging: r"C:\Vaults\.restore-aa".into(),
            target: r"C:\Vaults\Family".into(),
            before_restore: Some(r"C:\Vaults\Family.before-restore".into()),
        };
        let notice = Notice::Restore(RestoreNotice::DriveMissing(paths.clone()));
        assert_eq!(
            serde_json::to_value(&notice).unwrap(),
            json!({
                "kind": "restore",
                "state": "drive_missing",
                "paths": {
                    "step": "swapping",
                    "staging": r"C:\Vaults\.restore-aa",
                    "target": r"C:\Vaults\Family",
                    "before_restore": r"C:\Vaults\Family.before-restore",
                },
                "folder": r"C:\Vaults",
            })
        );
        assert_eq!(
            serde_json::to_value(Notice::Restore(RestoreNotice::Recovered {
                how: Recovered::RolledBack,
                vault: None
            }))
            .unwrap(),
            json!({ "kind": "restore", "state": "recovered", "how": "rolled_back", "vault": null })
        );
        assert_eq!(
            serde_json::to_value(RestoreNotice::Recovered {
                how: Recovered::Finished,
                vault: Some(NoticeVault {
                    id: 3,
                    name: "Family".into()
                })
            })
            .unwrap(),
            json!({
                "state": "recovered", "how": "finished",
                "vault": { "id": 3, "name": "Family" }
            })
        );
        let unclear = RestoreNotice::Unclear {
            journal: r"C:\State\restore-journal.json".into(),
            paths: None,
        };
        assert_eq!(
            serde_json::to_value(&unclear).unwrap(),
            json!({
                "state": "unclear",
                "journal": r"C:\State\restore-journal.json",
                "paths": null
            })
        );
        for text in [
            format!("{paths:?}"),
            format!("{:?}", RestoreNotice::Pending(paths.clone())),
            format!("{unclear:?}"),
            format!(
                "{:?}",
                Leaves {
                    staging: Some(paths.staging.clone()),
                    before_restore: paths.before_restore.clone(),
                }
            ),
        ] {
            assert!(
                !text.contains("Vaults") && !text.contains("State"),
                "{text}"
            );
        }
    }
}
