//! Restore in the shell (spec §6.8): the one restore that may be alive at a time, recovery of a half-done one at
//! launch, and the `.before-restore` folders a swap leaves beside a vault. The engine does the work (`PreparedRestore`,
//! `recover_restore`); this module makes it reachable, keeps the user in charge of each step and keeps a lock's rules
//! (§7.4) around it.
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
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::thread;
use std::time::{Duration, Instant};

use lockbox_core::blob::CancelToken;
use lockbox_core::fsio::{is_destination_taken, remove_dir_all_retry};
use lockbox_core::{
    CoreError, JournalStep, JournalView, PreparedRestore, ReadOnlyVault, Recovery,
    RestoreDestination, dismiss_restore_journal, folder_name, inspect_restore_journal,
    read_vault_id, read_vault_name, recover_restore,
};
use serde::ser::Serializer;
use serde::{Deserialize, Serialize};

use crate::commands::backup::{CredentialArg, FILTER, Typed};
use crate::error::{Confirm, Outcome, ShellError, ShellResult, VAULT_NOT_LISTED};
use crate::lock;
use crate::os::{same_name, same_path};
use crate::outputs::is_real_folder_in;
use crate::paths::default_vault_parent;
use crate::pending::{PendingChoice, Token};
#[cfg(test)]
use crate::session::SessionId;
use crate::session::{
    Location, LockHook, LockReason, Notice, OpenStep, Opened, SessionInfo, Sessions, Tagged,
};
use crate::shell::Shell;

/// The long operation's name in `lockbox://busy`, with no session.
const RESTORE: &str = "restore";

const BUSY_RESTORE: ShellError = ShellError::Busy { what: "restore" };

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
    Recovered(Recovered),
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

impl fmt::Debug for RestoreNotice {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            RestoreNotice::None => "RestoreNotice::None",
            RestoreNotice::Recovered(_) => "RestoreNotice::Recovered(..)",
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
    },
    DriveMissing {
        paths: &'a JournalPaths,
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
            RestoreNotice::Recovered(how) => NoticeView::Recovered { how: *how },
            RestoreNotice::DriveMissing(paths) => NoticeView::DriveMissing { paths },
            RestoreNotice::Pending(paths) => NoticeView::Pending { paths },
            RestoreNotice::Unclear { journal, paths } => NoticeView::Unclear { journal, paths },
        }
        .serialize(serializer)
    }
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
        Ok(Recovery::StagingRemoved) => RestoreNotice::Recovered(Recovered::StagingRemoved),
        Ok(Recovery::RolledBack) => RestoreNotice::Recovered(Recovered::RolledBack),
        Ok(Recovery::Finished) => RestoreNotice::Recovered(Recovered::Finished),
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
    /// The pickers are done and the backup is being unlocked and extracted: a long operation. `locked` lists the places
    /// of the sessions a user locked meanwhile, since which one is the destination is known only when `prepare` ends.
    Preparing {
        id: u32,
        cancel: CancelToken,
        locked: Vec<Location>,
    },
    /// Extracted and checked, waiting for the user's yes. Not a long operation (spec §7.4 pauses the idle timer while
    /// one is running): an idle lock ends it like any lock of all vaults. `epoch` is the sessions' lock count then.
    /// `destination` is the folder it replaces: a lock of any session at that place ends it, whenever that session was
    /// unlocked. `was_open`: a session was open there when it became `Prepared` (and none is known to have been closed
    /// by the restore itself since), so a commit that finds none knows the user locked it, whatever the hook has done.
    Prepared {
        id: u32,
        prepared: Box<PreparedRestore>,
        cancel: CancelToken,
        destination: Option<Location>,
        was_open: bool,
        epoch: u64,
    },
    /// The swap is being made: a long operation. Once the engine writes `swapping` nothing cancels it.
    Committing {
        id: u32,
        cancel: CancelToken,
        destination: Option<Location>,
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

    /// Takes the restore for a new one: `Busy` unless nothing is alive. Its ID and cancel token (one for its whole
    /// life) come with the claim.
    fn claim_preparing(&self) -> ShellResult<(u32, CancelToken, Claim<'_>)> {
        let mut inner = lock(&self.inner);
        if !matches!(inner.state, RestoreState::Idle) {
            return Err(BUSY_RESTORE);
        }
        inner.last_id += 1;
        let id = inner.last_id;
        let cancel = CancelToken::new();
        inner.state = RestoreState::Preparing {
            id,
            cancel: cancel.clone(),
            locked: Vec::new(),
        };
        Ok((
            id,
            cancel,
            Claim {
                restores: self,
                id,
                live: true,
            },
        ))
    }

    /// Whether nothing is alive.
    fn is_idle(&self) -> bool {
        matches!(lock(&self.inner).state, RestoreState::Idle)
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
                cancel,
                destination,
                was_open,
                epoch,
                ..
            } => {
                inner.state = RestoreState::Committing {
                    id,
                    cancel: cancel.clone(),
                    destination: destination.clone(),
                };
                Ok(Commit {
                    prepared: *prepared,
                    cancel,
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
            cancel,
            destination,
            was_open: _,
            epoch,
        } = commit;
        let mut inner = lock(&self.inner);
        inner.state = RestoreState::Prepared {
            id,
            prepared: Box::new(prepared),
            cancel,
            destination,
            was_open: false,
            epoch,
        };
    }

    /// The lock hook (added in `Shell::new`, after the "Open" cleanup's): a restore that is not swapping ends with
    /// the lock. `sessions` is weak because the sessions hold this hook; it tells where a locked session was.
    /// - A lock of all vaults (`None`, any reason) cancels the token. In `Prepared` the restore also ends: the staged
    ///   restore is taken out and dropped on a worker.
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
        let ends = |destination: &Option<Location>| match &session {
            None => true,
            Some(at) => reason != LockReason::Restore && at.is_some() && at == destination,
        };
        let dropped = {
            let mut inner = lock(&self.inner);
            let id = match &mut inner.state {
                RestoreState::Idle | RestoreState::Recovering => return,
                RestoreState::Preparing { cancel, locked, .. } => {
                    match &session {
                        None => cancel.cancel(),
                        Some(Some(at)) if reason != LockReason::Restore => locked.push(at.clone()),
                        Some(_) => {}
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
                    cancel,
                    destination,
                    ..
                } => {
                    if !ends(destination) {
                        return;
                    }
                    cancel.cancel();
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
    cancel: CancelToken,
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

/// `restore_prepare` waiting for a yes: the backup and parent picked, the credential typed and the destination asked
/// for, so `restore_prepare_confirm` neither asks for files again nor lets another backup in. No `Debug`: it holds a
/// credential and paths.
pub struct RestoreChoice {
    backup: PathBuf,
    /// The parent folder as checked (canonical).
    parent: PathBuf,
    credential: Typed,
    destination: RestoreDestination,
    /// The parent's cloud question was answered yes.
    cloud_confirmed: bool,
    asked: Asked,
}

/// The destination a restore is asked for, as the page sends it: `"same_vault"` or `{ "new_folder": "<name>" }`.
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DestinationArg {
    SameVault,
    NewFolder(String),
}

impl From<DestinationArg> for RestoreDestination {
    fn from(destination: DestinationArg) -> Self {
        match destination {
            DestinationArg::SameVault => RestoreDestination::SameVault,
            DestinationArg::NewFolder(name) => RestoreDestination::NewFolder(name),
        }
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
        let notice = recovery_notice(&self.paths.journal);
        *lock(&self.restore.notice) = notice.clone();
        notice
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

    /// Restores a backup the user picks (spec §6.8). Both pickers open first, outside every lock (a closed one answers
    /// `Dismissed`; a lock of all vaults while they were open answers `Locked`): the backup file, and the parent
    /// folder the vault goes in. The parent is checked like any vault location (a cloud folder asks first); then the
    /// backup is unlocked, checked and extracted beside its destination, which replaces the vault of the same ID there
    /// or is a new folder. Nothing is swapped: the page asks the user, then sends `restore_commit`.
    ///
    /// Answers `Busy { restore }` while a restore of ours is alive. When a restore journal is there and none of ours
    /// is alive (a crash, or a failed recovery), recovery runs and the answer is [`Confirm::Recovery`] with what it
    /// found. When the vault folder at the destination cannot be recognised (both headers unreadable) and the default
    /// folder name is taken by it, the answer is [`Confirm::NewFolder`].
    pub fn restore_prepare(
        &self,
        credential: CredentialArg,
        destination: DestinationArg,
    ) -> ShellResult<Outcome<RestorePreparedView>> {
        if !self.restore.is_idle() {
            return Err(BUSY_RESTORE);
        }
        let epoch = self.sessions.epoch();
        let Some(backup) = self.os.dialogs.pick_file("Restore a backup", Some(FILTER)) else {
            return Ok(Outcome::Dismissed);
        };
        // The folder dialog opens in the vaults folder when there is one (`<Profile>\Lockbox Vaults`).
        let vaults = default_vault_parent(self.os.env.as_ref())
            .ok()
            .filter(|dir| dir.is_dir());
        let Some(parent) = self
            .os
            .dialogs
            .pick_folder("Restore into this folder", vaults.as_deref())
        else {
            return Ok(Outcome::Dismissed);
        };
        if self.locked_since(epoch) {
            return Err(ShellError::Locked);
        }
        let credential = credential.typed()?;
        self.restore_start(
            RestoreChoice {
                backup,
                parent,
                credential,
                destination: destination.into(),
                cloud_confirmed: false,
                asked: Asked::Cloud,
            },
            epoch,
        )
    }

    /// The user's answer to [`Confirm::CloudFolder`] (`name` absent: go on with the destination as first asked) or to
    /// [`Confirm::NewFolder`] (`name` present: restore into a new folder of that name). The backup, parent and
    /// credential come from what was kept, never from a new pick. The token is used up whatever happens; an answer of
    /// the wrong kind for the question is refused.
    pub fn restore_prepare_confirm(
        &self,
        token: &Token,
        name: Option<String>,
    ) -> ShellResult<Outcome<RestorePreparedView>> {
        let epoch = self.sessions.epoch();
        let PendingChoice::Restore(choice) = self.sessions.pending().take(token)? else {
            // A token for another question: used up, and its choice dropped.
            return Err(ShellError::NotFound);
        };
        let RestoreChoice {
            backup,
            parent,
            credential,
            destination,
            cloud_confirmed,
            asked,
        } = *choice;
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
        self.restore_start(
            RestoreChoice {
                backup,
                parent,
                credential,
                destination,
                cloud_confirmed,
                asked: Asked::Cloud,
            },
            epoch,
        )
    }

    /// The parent's location check (again after a yes: it may have changed since), then the cloud question, then the
    /// restore itself.
    fn restore_start(
        &self,
        choice: RestoreChoice,
        epoch: u64,
    ) -> ShellResult<Outcome<RestorePreparedView>> {
        let check = self.check_location(&choice.parent)?;
        let choice = RestoreChoice {
            parent: check.path,
            ..choice
        };
        if check.cloud.is_some() && !choice.cloud_confirmed {
            let choice = RestoreChoice {
                asked: Asked::Cloud,
                ..choice
            };
            return self.park(choice, epoch, |token| Confirm::CloudFolder { token });
        }
        self.restore_run(choice, epoch)
    }

    /// Parks `choice` for the user's yes. A lock of all vaults between the epoch read and the parking has already
    /// emptied [`Pending`](crate::pending::Pending): the choice, which holds the credential, is taken back.
    fn park(
        &self,
        choice: RestoreChoice,
        epoch: u64,
        question: impl FnOnce(Token) -> Confirm,
    ) -> ShellResult<Outcome<RestorePreparedView>> {
        let token = self
            .sessions
            .pending()
            .put(PendingChoice::Restore(Box::new(choice)));
        if self.locked_since(epoch) {
            drop(self.sessions.pending().take(&token));
            return Err(ShellError::Locked);
        }
        Ok(Outcome::Confirm(question(token)))
    }

    /// `Preparing` to `Prepared`: a long operation (idle time paused, the PC kept awake) from the claim to the end of
    /// the extraction. A changed epoch is looked for after the claim is registered, so a lock of all vaults either
    /// comes before it (seen here) or finds it and cancels it.
    fn restore_run(
        &self,
        choice: RestoreChoice,
        epoch: u64,
    ) -> ShellResult<Outcome<RestorePreparedView>> {
        let (id, cancel, mut claim) = self.restore.claim_preparing()?;
        let operation = self.autolock.begin(None, RESTORE, cancel.clone());
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

        let prepared = PreparedRestore::prepare(
            &choice.backup,
            &choice.parent,
            choice.credential.credential(),
            choice.destination.clone(),
            &self.paths.journal,
            &cancel,
        );
        let prepared = match prepared {
            Ok(prepared) => prepared,
            // A journal is there and no restore of ours is alive (this claim is the only one): settle it first.
            Err(CoreError::InvalidInput {
                what: "restore in progress",
            }) => {
                let notice = self.recover();
                drop(operation);
                self.announce_restore(&notice);
                return Ok(Outcome::Confirm(Confirm::Recovery { notice }));
            }
            Err(e)
                if is_destination_taken(&e)
                    && choice.destination == RestoreDestination::SameVault =>
            {
                // The engine says only that the name is taken. The suggestion needs the vault's name and ID: the one
                // second of unlocking is accepted on this rare path.
                let backup = ReadOnlyVault::open_backup(
                    &choice.backup,
                    choice.credential.credential(),
                    &cancel,
                )?;
                let suggested = format!("{} (restored)", folder_name(backup.name(), &backup.id()));
                drop(backup);
                drop(operation);
                let choice = RestoreChoice {
                    asked: Asked::NewFolder,
                    ..choice
                };
                return self.park(choice, epoch, |token| Confirm::NewFolder {
                    suggested,
                    token,
                });
            }
            Err(e) => return Err(e.into()),
        };

        let name = prepared.name().to_owned();
        let existing = prepared.existing().map(Path::to_path_buf);
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
                        // A lock ended it while it ran (its hook cancelled the token, or the destination was locked).
                        inner.note_ended(id);
                        Err(prepared)
                    } else {
                        inner.state = RestoreState::Prepared {
                            id,
                            prepared: Box::new(prepared),
                            cancel: cancel.clone(),
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
        // Ending the operation announces on `lockbox://busy`, where a lock can land: the last check comes after it.
        drop(operation);
        if self.locked_since(epoch) {
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
        }))
    }

    /// Swaps the prepared restore `restore` into place (spec §6.8 step 5), after the user's yes. The session open at
    /// the destination (looked up again: it may have been unlocked since `prepare`) is locked with
    /// [`LockReason::Restore`], waited for up to 10 s (else `Busy { "vault still finishing an operation" }`, the
    /// staged restore kept), then the engine commits. A long operation until it ends; a lock before the swap starts
    /// answers `Cancelled` (and the staged restore is gone); once the engine writes `swapping` nothing cancels it.
    ///
    /// By the engine's contract: `RestorePending` runs recovery at once (the notice is kept and sent; the answer is
    /// that error). Any other failure is asked of the engine: a restore it kept as it was
    /// ([`PreparedRestore::can_retry`]: the vault is open elsewhere, a cancel, a refused first rename) goes back to
    /// `Prepared` with the same ID for a retry, unless a lock came meanwhile; otherwise the engine settled it, the
    /// restore is dropped, and recovery runs for any journal left. From a failed commit the state goes straight to
    /// `Recovering` and stays there until recovery is over, so no other restore starts in between. After a swap the
    /// vault is put on the vault list (`VAULT_NOT_LISTED` if that fails).
    pub fn restore_commit(&self, restore: u32) -> ShellResult<RestoredView> {
        let Commit {
            mut prepared,
            cancel,
            destination,
            was_open,
            epoch,
        } = self.restore.begin_commit(restore)?;
        // The session open there now, whenever it was unlocked.
        let session = destination
            .as_ref()
            .and_then(|place| self.sessions.find(place));

        let operation = self.autolock.begin(None, RESTORE, cancel.clone());
        // A lock of all vaults whose hook has not run yet; or the one session that was open at the destination locked by
        // the user, whose hook is still queued (the token is not cancelled, and one session's lock leaves the epoch).
        if cancel.is_cancelled() || self.locked_since(epoch) || (was_open && session.is_none()) {
            self.restore.end_commit(restore, true);
            drop(operation);
            drop(prepared);
            return Err(ShellError::Cancelled);
        }
        if let Some(session) = session {
            self.sessions.lock(session, LockReason::Restore);
            if !self.sessions.release_wait(session, RELEASE_WAIT) {
                // A lock that came meanwhile ends the restore; else it waits for another try.
                if cancel.is_cancelled() || self.locked_since(epoch) {
                    self.restore.end_commit(restore, true);
                    drop(operation);
                    drop(prepared);
                    return Err(ShellError::Cancelled);
                }
                let kept = Commit {
                    prepared,
                    cancel,
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
        if cancel.is_cancelled() || self.locked_since(epoch) {
            self.restore.end_commit(restore, true);
            drop(operation);
            drop(prepared);
            return Err(ShellError::Cancelled);
        }

        let committed = prepared.commit(&cancel);
        match committed {
            Ok(outcome) => {
                self.restore.end_commit(restore, false);
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
                    if !cancel.is_cancelled() && !self.locked_since(epoch) {
                        let kept = Commit {
                            prepared,
                            cancel,
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
        let mut list = lock(&self.restore.pre_restore);
        list.listed.clear();
        let mut entries = Vec::new();
        for (vault, folder) in found {
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
        let credential = credential.typed()?;
        let answer = self.sessions.open(Some(location.clone()), None, |cancel| {
            let opened =
                ReadOnlyVault::open_folder(location.path(), credential.credential(), cancel)?;
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

/// Whether `candidate` is `folder` followed by `.before-restore` or `.before-restore-<2..=99>`, the names the engine
/// gives a replaced vault (spec §6.8), compared as Windows compares names (any letter case).
fn is_pre_restore_name(candidate: &str, folder: &str) -> bool {
    let lower = candidate.to_ascii_lowercase();
    // ASCII lowercasing keeps every byte offset, and the marker is ASCII, so the split is on a character boundary.
    let Some(at) = lower.rfind(PRE_RESTORE) else {
        return false;
    };
    let (head, tail) = candidate.split_at(at);
    let numbered = &tail[PRE_RESTORE.len()..];
    let number_ok = numbered.is_empty()
        || numbered.strip_prefix('-').is_some_and(|number| {
            !number.starts_with('0')
                && number.bytes().all(|b| b.is_ascii_digit())
                && matches!(number.parse::<u8>(), Ok(2..=99))
        });
    number_ok && same_name(OsStr::new(head), OsStr::new(folder))
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;
    use std::sync::mpsc;

    use lockbox_core::Vault;
    use lockbox_core::internals::fsio::failpoint;
    use lockbox_core::internals::fsio::testutil::{make_dir_link, names};
    use serde_json::{Value, json};
    use zeroize::Zeroizing;

    use super::*;
    use crate::os::{ClipboardSteps, Clock, DriveType, KnownFolder, Os, OsSignal, PrintSteps};
    use crate::session::SessionState;
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
        done(ts.shell.backup_vault(s, g).unwrap().data);
        dest
    }

    /// Answers the two pickers and starts a restore of `backup` into `parent`, same vault.
    fn prepare(
        ts: &TestShell,
        backup: &Path,
        parent: &Path,
    ) -> ShellResult<Outcome<RestorePreparedView>> {
        ts.dialogs.answer(Some(backup.to_path_buf()));
        ts.dialogs.answer(Some(parent.to_path_buf()));
        heavy(|| {
            ts.shell
                .restore_prepare(password(), DestinationArg::SameVault)
        })
    }

    fn prepared(ts: &TestShell, backup: &Path, parent: &Path) -> RestorePreparedView {
        done(prepare(ts, backup, parent).unwrap())
    }

    /// A restore from start to finish.
    fn restore_once(ts: &TestShell, backup: &Path, parent: &Path) -> RestoredView {
        let view = prepared(ts, backup, parent);
        ts.shell.restore_commit(view.restore).unwrap()
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
        let error = ts.shell.restore_commit(view.restore).unwrap_err();
        failpoint::disarm_all();
        assert_eq!(error, restore_pending());
    }

    /// A second shell over the same state folder and vaults: the app after a restart. The first one is locked, as a
    /// closed app's vaults are.
    fn restarted(ts: &TestShell) -> Arc<Shell> {
        ts.shell.sessions.lock_all(LockReason::AppClosing);
        let os = Os {
            volumes: ts.volumes.clone(),
            env: ts.env.clone(),
            dialogs: ts.dialogs.clone(),
            launcher: ts.launcher.clone(),
            idle: ts.idle.clone(),
            power: ts.power.clone(),
            clock: ts.clock.clone(),
            clipboard: Arc::new(ClipboardSteps::new(ts.clipboard.clone(), ts.clock.clone())),
            timer: ts.timer.clone(),
            printer: Arc::new(PrintSteps::new(ts.print.clone())),
        };
        Arc::new(Shell::new(ts.events.clone(), os, ts.app_dirs.clone()).unwrap())
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
            restarted.restore_notice(),
            RestoreNotice::Recovered(Recovered::RolledBack)
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
            ts.shell.retry_restore_recovery().unwrap(),
            RestoreNotice::Recovered(Recovered::RolledBack)
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

        let error = ts.shell.restore_commit(view.restore).unwrap_err();
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
            ts.shell.restore_commit(view.restore).unwrap_err(),
            ShellError::NotFound
        );
        assert!(!dir.exists(), "the journal waits for the retry");

        assert_eq!(
            ts.shell.retry_restore_recovery().unwrap(),
            RestoreNotice::Recovered(Recovered::RolledBack)
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
        assert_eq!(notice, RestoreNotice::Recovered(Recovered::RolledBack));
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
                ts.shell
                    .restore_prepare(password(), DestinationArg::SameVault)
                    .err(),
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
                        shell
                            .restore_prepare(password(), DestinationArg::SameVault)
                            .err(),
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
        ts.shell.restore_commit(view.restore).unwrap();

        let all_busy = vec![BUSY; 4];
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
        let wrong = heavy(|| ts.shell.restore_prepare_confirm(&token, None)).err();
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
                    .restore_prepare_confirm(&token, Some(suggested.clone()))
            })
            .unwrap(),
        );
        assert_eq!(ts.dialogs.opened(), pickers_again, "no new pick");
        assert!(pickers < pickers_again);
        assert_eq!(
            (view.name.as_str(), view.replaces_existing),
            ("Clients", false)
        );
        let again = heavy(|| ts.shell.restore_prepare_confirm(&token, Some("x".into()))).err();
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
                    .restore_prepare_confirm(&token, Some(suggested.clone()))
            })
            .unwrap(),
        );
        let restored = ts.shell.restore_commit(view.restore).unwrap();
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
        let parent = vaults_folder(&ts);
        let before = names(&parent);
        for name in ["", "a\\b", "..", "Clients.before-restore"] {
            ts.dialogs.answer(Some(backup.clone()));
            ts.dialogs.answer(Some(parent.clone()));
            let refused = heavy(|| {
                ts.shell
                    .restore_prepare(password(), DestinationArg::NewFolder(name.into()))
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
        let name_for_cloud = heavy(|| ts.shell.restore_prepare_confirm(&token, Some("x".into())));
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

        let view = done(heavy(|| ts.shell.restore_prepare_confirm(&token, None)).unwrap());
        assert_eq!(ts.dialogs.opened(), pickers, "no new pick");
        assert!(!view.replaces_existing);
        let restored = ts.shell.restore_commit(view.restore).unwrap();
        assert_eq!(restored.vault, 2);
        assert_eq!(names(&cloud).len(), 1, "restored in the cloud folder");
        let again = heavy(|| ts.shell.restore_prepare_confirm(&token, None)).err();
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
        lock_in_picker();
        assert_eq!(prepare(&ts, &backup, &parent).err(), LOCKED);
        assert!(!ts.shell.paths.journal.exists() && staging_in(&parent).is_empty());
        assert!(ts.shell.restore.is_idle());

        // A closed picker shows nothing: dismissed, locked or not.
        lock_in_picker();
        assert!(matches!(
            ts.shell
                .restore_prepare(password(), DestinationArg::SameVault),
            Ok(Outcome::Dismissed)
        ));
        ts.dialogs.answer(Some(backup.clone()));
        assert!(matches!(
            ts.shell
                .restore_prepare(password(), DestinationArg::SameVault),
            Ok(Outcome::Dismissed)
        ));

        // A question waits in Pending; a lock of all vaults drops it.
        let cloud = ts.folder("Cloud");
        ts.volumes.add_sync_root(&cloud);
        let Outcome::Confirm(Confirm::CloudFolder { token }) =
            prepare(&ts, &backup, &cloud).unwrap()
        else {
            panic!("not asked");
        };
        ts.shell.sessions.lock_all(LockReason::Manual);
        let answer = heavy(|| ts.shell.restore_prepare_confirm(&token, None)).err();
        assert_eq!(answer, Some(ShellError::NotFound));
        assert!(names(&cloud).is_empty());
    }

    /// A wrong password is the engine's refusal, before anything is written, and leaves no restore alive.
    #[test]
    fn wrong_password_starts_nothing() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let parent = vaults_folder(&ts);
        let before = names(&parent);
        ts.dialogs.answer(Some(backup));
        ts.dialogs.answer(Some(parent.clone()));
        let wrong = CredentialArg::Password(Zeroizing::new("another long password".into()));
        let refused = heavy(|| ts.shell.restore_prepare(wrong, DestinationArg::SameVault)).err();
        assert_eq!(refused, Some(CoreError::WrongPassword.into()));
        assert_eq!(names(&parent), before);
        assert!(!ts.shell.paths.journal.exists() && ts.shell.restore.is_idle());
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

        assert_eq!(ts.shell.restore_commit(view.restore).err(), CANCELLED);
        assert_eq!(ts.shell.restore_discard(view.restore).err(), CANCELLED);
        assert_eq!(
            ts.shell.restore_commit(view.restore + 100).err(),
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
            )
            .unwrap();
        let (dir, parent) = (vault_dir(&ts), vaults_folder(&ts));
        let view = prepared(&ts, &backup, &parent);
        assert!(view.replaces_existing);

        let restored = ts.shell.restore_commit(view.restore).unwrap();

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
        assert_eq!(ts.shell.restore_commit(view.restore).err(), CANCELLED);
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
        let restored = ts.shell.restore_commit(view.restore).unwrap();
        failpoint::disarm_all();
        assert!(restored.before_restore);
        assert!(dir.is_dir() && !ts.shell.paths.journal.exists());
        assert!(staging_in(&parent).is_empty());
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
        ts.shell.restore_commit(view.restore).unwrap();

        assert_eq!(*states.borrow(), [SessionState::Locked]);
        assert_eq!(ts.events.locked(), [(s, g + 1, LockReason::Restore)]);
    }

    /// Spec 7.4: the idle timer is paused while the restore prepares and commits, but not while it waits for the
    /// user's yes: an idle lock ends it like any lock of all vaults.
    #[test]
    fn prepared_restore_does_not_stop_idle_lock() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let backup = backup_of(&ts, s, g, "family.lockbox-backup");
        let parent = vaults_folder(&ts);
        let idle_for = Duration::from_secs(6 * 60);

        // Preparing: a long operation, so a tick finds no idle time.
        let (shell, clock, idle) = (
            Arc::clone(&ts.shell),
            Arc::clone(&ts.clock),
            Arc::clone(&ts.idle),
        );
        let locks_during = Rc::new(Cell::new(usize::MAX));
        let (counted, events) = (Rc::clone(&locks_during), Arc::clone(&ts.events));
        failpoint::observe(
            "restore.after_entry",
            Box::new(move || {
                idle.set(idle_for);
                shell.autolock.tick(clock.now() + idle_for);
                counted.set(events.locked().len());
            }),
        );
        let view = prepared(&ts, &backup, &parent);
        failpoint::disarm_all();
        assert_eq!(locks_during.get(), 0, "paused while preparing");

        // Prepared: not a long operation.
        ts.idle.set(idle_for);
        ts.shell.autolock.tick(ts.clock.now() + idle_for);
        ended(&ts);
        assert_eq!(
            ts.shell.sessions.list()[0].state,
            SessionState::Locked,
            "the vault locked"
        );
        assert_eq!(ts.shell.restore_commit(view.restore).err(), CANCELLED);
        assert!(staging_in(&parent).is_empty());
        let _ = (s, g);
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

        let refused = ts.shell.restore_commit(view.restore).err();
        assert_eq!(refused, Some(CoreError::VaultInUse.into()));
        assert_eq!(staging_in(&parent).len(), 1, "the staged restore is kept");
        assert!(ts.shell.paths.journal.exists());
        assert!(!ts.shell.restore.is_idle());
        drop(outside);

        let restored = ts.shell.restore_commit(view.restore).unwrap();
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
            *answer.borrow_mut() = Some(ts.shell.restore_commit(view.restore));
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
                .restore_commit(view.restore)
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

        let error = ts.shell.restore_commit(view.restore).unwrap_err();

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
            ts.shell.restore_commit(view.restore + 1).err(),
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
            assert_eq!(keys, ["folder", "id", "name", "vault"]);
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

    /// The folder dialog of a restore opens in the vaults folder when there is one; the others give it no start.
    #[test]
    fn restore_folder_picker_opens_in_the_vaults_folder() {
        let ts = TestShell::new();
        let vaults = ts.env.folder(KnownFolder::Profile).join("Lockbox Vaults");
        let a_backup = ts.folder("Backups").join("x.lockbox-backup");
        let ask = || {
            ts.dialogs.answer(Some(a_backup.clone()));
            // The folder picker is closed: dismissed, after it was opened.
            assert!(matches!(
                ts.shell
                    .restore_prepare(password(), DestinationArg::SameVault),
                Ok(Outcome::Dismissed)
            ));
        };
        ask();
        assert!(!vaults.exists());
        fs::create_dir_all(&vaults).unwrap();
        ask();
        assert_eq!(ts.dialogs.folder_starts(), [None, Some(vaults)]);

        assert!(matches!(
            ts.shell.add_existing_vault(),
            Ok(Outcome::Dismissed)
        ));
        let created =
            ts.shell
                .create_vault("Family".into(), Zeroizing::new(TEST_PASSWORD.into()), true);
        assert!(matches!(created, Ok(Outcome::Dismissed)));
        assert_eq!(
            ts.dialogs.folder_starts()[2..],
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
                        shell
                            .restore_prepare(password(), DestinationArg::SameVault)
                            .err(),
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
        let error = ts.shell.restore_commit(view.restore).unwrap_err();
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

        let refused = ts.shell.restore_commit(view.restore).err();
        assert_eq!(refused, Some(CoreError::VaultInUse.into()));
        assert!(!ts.shell.restore.is_idle(), "still prepared");
        assert_eq!(staging_in(&parent).len(), 1, "the staged restore is kept");

        // The same ID commits once the vault is closed and the journal is as it was.
        drop(outside);
        fs::write(&journal, written).unwrap();
        assert!(
            ts.shell
                .restore_commit(view.restore)
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
        assert_eq!(ts.shell.restore_commit(view.restore).err(), CANCELLED);
        assert!(staging_in(&parent).is_empty() && !ts.shell.paths.journal.exists());

        // Open when prepared; a command holds it past the wait (`Busy`); unlocked again, then locked by the user.
        let (open, open_generation) = unlock(&ts, 1);
        let view = prepared(&ts, &backup, &parent);
        let answer = RefCell::new(None);
        let _ = ts.shell.sessions.read(open, open_generation, |_, _| {
            *answer.borrow_mut() = Some(ts.shell.restore_commit(view.restore));
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
        assert_eq!(ts.shell.restore_commit(view.restore).err(), CANCELLED);
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

        let answer = ts.shell.restore_commit(view.restore).err();
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
            let answer = ts.shell.restore_commit(view.restore).err();
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
                notice: RestoreNotice::Recovered(Recovered::Finished)
            })
            .unwrap(),
            json!({ "Recovery": { "notice": { "state": "recovered", "how": "finished" } } })
        );
        assert_eq!(
            serde_json::to_value(RestorePreparedView {
                restore: 3,
                name: "Family".into(),
                replaces_existing: true
            })
            .unwrap(),
            json!({ "restore": 3, "name": "Family", "replaces_existing": true })
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
                }
            })
        );
        assert_eq!(
            serde_json::to_value(Notice::Restore(RestoreNotice::Recovered(
                Recovered::RolledBack
            )))
            .unwrap(),
            json!({ "kind": "restore", "state": "recovered", "how": "rolled_back" })
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
