//! Backups in the shell (spec §6.7, §6.9, §7.4): back up an open vault, test a backup, open a backup read-only and
//! copy an item out of one into an open vault. Every file comes from a dialog Rust opens inside the command, outside
//! every lock; the page sends IDs and the typed credential only (§4.1).
//!
//! The restore commands are here too (their logic is in [`crate::restore`]). Nothing here puts a path, a name or an
//! item's content in an error (R5): the views and [`Confirm::MissingFiles`] may carry the user's own file names, as the
//! other results do.

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use lockbox_core::blob::NoProgress;
use lockbox_core::ids::{FileId, ItemId};
use lockbox_core::recovery::RecoverySecret;
use lockbox_core::{
    BackupReport, CoreError, Credential, ReadOnlyVault, UnverifiedSlot, Vault, verify_backup,
};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Request;
use zeroize::Zeroizing;

use super::{NoArgs, args, blocking};
use crate::dates;
use crate::error::{Confirm, Outcome, ShellError, ShellResult};
use crate::jobs::{JobKind, JobScope};
use crate::open::safe_name;
use crate::pending::{PendingChoice, Token};
use crate::restore::{
    PreRestoreEntry, RestoreChecked, RestoreNotice, RestorePick, RestorePreparedView, RestoredView,
};
use crate::session::{Location, OpenStep, Opened, SessionId, SessionInfo, Tagged, VaultRef};
use crate::shell::Shell;

/// A backup file's extension, and the dialogs' filter for it (the extensions it shows, without dots).
pub(crate) const EXTENSION: &str = ".lockbox-backup";
pub(crate) const FILTER: (&str, &[&str]) = ("Lockbox backup", &["lockbox-backup"]);

/// What a finished backup holds and left out (spec §6.7: the report counts each kind), and the file's size.
#[derive(Debug, Serialize)]
pub struct BackupView {
    pub items: usize,
    pub files: usize,
    /// Items left out because their file was damaged.
    pub damaged_items: usize,
    /// Attached files left out because they failed authentication.
    pub damaged_files: usize,
    /// Attached files left out because the vault no longer held them.
    pub missing_files: usize,
    /// The backup file's size in bytes, as the file system says (`fs::metadata`), not the engine's count of content.
    pub size_on_disk: u64,
    /// The backup just written, held in Rust to be tested (22c's "Test this backup"): the page tests it with the choice
    /// and never sees the path.
    pub test: TestPick,
}

/// A backup held in Rust for `test_backup`: the token that stands for its path, which never crosses; its name, for the
/// page to show as text; and its size on disk.
#[derive(Debug, Serialize)]
pub struct TestPick {
    pub choice: Token,
    pub file_name: String,
    pub size: u64,
}

/// The title of the picker of "Test a backup".
const TEST_PICK_TITLE: &str = "Test a backup";

impl BackupView {
    fn of(report: BackupReport, size_on_disk: u64, test: TestPick) -> BackupView {
        let BackupReport {
            items,
            files,
            bytes: _,
            skipped_damaged_items,
            skipped_damaged_files,
            missing_files,
        } = report;
        BackupView {
            items,
            files,
            damaged_items: skipped_damaged_items,
            damaged_files: skipped_damaged_files,
            missing_files,
            size_on_disk,
            test,
        }
    }
}

/// A backup is due after this many whole days.
const BACKUP_DUE_DAYS: u32 = 30;

/// How long ago the vault was last backed up (or made, when it never was), once that is 30 days or more.
#[derive(Debug, Serialize)]
pub struct BackupDue {
    pub days: u32,
}

/// The engine's refusal words that a backup's refusal is told apart by.
const ACCEPT_FIRST: &str = "accept the header change first";
const STATE_UNKNOWN: &str = "header state unknown; reopen the vault";
const COPIES_DISAGREE: &str = "header copies disagree; replace the unchecked credential first";
const CHANGED_ON_DISK: &str = "header changed on disk";

/// The engine's refusal of a backup as the person must hear it: the changed header not yet accepted; the header copies
/// disagreeing on the password, or on the recovery key (which one is asked of the open vault); and "details couldn't be
/// checked", which a header state left unknown by a failed write and a `vault.json` that is no longer the header that
/// was opened both mean (lock and open the vault again). Every other refusal, and a stop, is passed on as it is.
fn backup_refusal(vault: &Vault, refusal: ShellError) -> ShellError {
    let ShellError::Core(view) = refusal else {
        return refusal;
    };
    let what = |what| ShellError::InvalidInput { what };
    match (view.kind, view.what) {
        ("invalid_input", Some(ACCEPT_FIRST)) => what("details changed"),
        ("invalid_input", Some(STATE_UNKNOWN)) | ("damaged", Some(CHANGED_ON_DISK)) => {
            what("details unchecked")
        }
        ("invalid_input", Some(COPIES_DISAGREE)) => match vault.unverified_slot() {
            Some(UnverifiedSlot::Password) => what("password copies disagree"),
            Some(UnverifiedSlot::Recovery) => what("recovery key copies disagree"),
            None => what("details unchecked"),
        },
        _ => refusal,
    }
}

/// What testing a backup found (spec §6.7).
#[derive(Debug, Serialize)]
pub struct BackupSummaryView {
    /// When the backup was made, as its signed manifest says (RFC 3339, UTC).
    pub created_at: String,
    pub items: usize,
    pub files: usize,
    /// Attached files the backup does not hold.
    pub missing_files: usize,
    /// The backup file's size in bytes, as the file system says.
    pub size_on_disk: u64,
}

/// The new copy of an item: its ID, and the names of the attachments left out because the backup lacks them.
#[derive(Serialize)]
pub struct CopiedItemView {
    pub id: String,
    pub left_out: Vec<String>,
}

/// What the user typed to open a backup, in the three shapes the page sends: `{ "password": ".." }`,
/// `{ "recovery_key": ".." }` or `{ "password_or_key": ".." }` (the one box of "Test a backup", which cannot know which
/// the person typed). Anything else (two, none, another field, another type) fails to parse, and the command answers
/// the fixed malformed-request refusal without quoting the input. No `Debug`: it holds a secret.
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialArg {
    Password(Zeroizing<String>),
    RecoveryKey(Zeroizing<String>),
    /// Text that is either. Only [`CredentialArg::attempts`] reads it (`test_backup`, `restore_check` and
    /// `open_pre_restore_read_only` are the commands that do): [`CredentialArg::typed`] refuses it, so a command that
    /// has not been taught the two tries never takes it for one.
    PasswordOrKey(Zeroizing<String>),
}

/// A [`CredentialArg`] checked: the recovery key parsed (a typo or a wrong format is refused here).
pub(crate) enum Typed {
    Password(Zeroizing<String>),
    Recovery(RecoverySecret),
}

/// A typed credential read as one or two tries, in order: the second is made only when the first is a wrong password.
/// Wiped when dropped.
pub(crate) struct Attempts {
    first: Typed,
    then: Option<Typed>,
}

impl CredentialArg {
    /// For the commands that take one meaning only. The one-box form is refused (`InvalidInput`, fixed text).
    pub(crate) fn typed(self) -> ShellResult<Typed> {
        match self {
            CredentialArg::Password(password) => Ok(Typed::Password(password)),
            CredentialArg::RecoveryKey(key) => Ok(Typed::Recovery(RecoverySecret::parse(&key)?)),
            CredentialArg::PasswordOrKey(_) => Err(ShellError::InvalidInput { what: "credential" }),
        }
    }

    /// The tries to make. The one box's text that reads as a well-formed recovery key is tried as the key first and, if
    /// that is a wrong password, as a password too; text that does not read as one (a near miss included: no typo words
    /// in this box) is tried as a password only. The other two forms are one try, as [`typed`](Self::typed) reads them.
    pub(crate) fn attempts(self) -> ShellResult<Attempts> {
        match self {
            CredentialArg::PasswordOrKey(text) => Ok(match RecoverySecret::parse(&text) {
                Ok(key) => Attempts {
                    first: Typed::Recovery(key),
                    then: Some(Typed::Password(text)),
                },
                Err(_) => Attempts {
                    first: Typed::Password(text),
                    then: None,
                },
            }),
            one => Ok(Attempts {
                first: one.typed()?,
                then: None,
            }),
        }
    }
}

impl Attempts {
    /// Runs `try_with` on the first try, and on the second when the first answers a wrong password. Any other answer,
    /// a stop included, is final.
    pub(crate) fn run<T>(
        &self,
        mut try_with: impl FnMut(Credential<'_>) -> Result<T, CoreError>,
    ) -> Result<T, CoreError> {
        match (try_with(self.first.credential()), &self.then) {
            (Err(CoreError::WrongPassword), Some(then)) => try_with(then.credential()),
            (answer, _) => answer,
        }
    }
}

impl Attempts {
    /// [`run`](Self::run), keeping the credential that worked: the answer and that try, which a restore holds in Rust for
    /// the copy so the person types it once. Nothing is kept for an answer that is not good (the tries are wiped).
    pub(crate) fn run_keeping<T>(
        self,
        mut try_with: impl FnMut(Credential<'_>) -> Result<T, CoreError>,
    ) -> Result<(T, Typed), CoreError> {
        let Attempts { first, then } = self;
        match (try_with(first.credential()), then) {
            (Ok(answer), _) => Ok((answer, first)),
            (Err(CoreError::WrongPassword), Some(then)) => {
                try_with(then.credential()).map(|answer| (answer, then))
            }
            (Err(refusal), _) => Err(refusal),
        }
    }
}

impl Typed {
    pub(crate) fn credential(&self) -> Credential<'_> {
        match self {
            Typed::Password(password) => Credential::Password(password),
            Typed::Recovery(secret) => Credential::Recovery(secret),
        }
    }
}

/// The file's name, for the page to show as text (the user's own data; the folder never goes with it).
pub(crate) fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Whether `dest`'s file name ends in `.lockbox-backup`, in any case.
fn has_backup_extension(dest: &Path) -> bool {
    let name = dest.file_name().unwrap_or_default().to_string_lossy();
    let name = name.as_bytes();
    name.len() >= EXTENSION.len()
        && name[name.len() - EXTENSION.len()..].eq_ignore_ascii_case(EXTENSION.as_bytes())
}

impl Shell {
    /// Writes a backup of the open vault where the user picks (spec §6.7). Refused first, in this order: while the
    /// output journal is damaged (the backup's temp must be recorded in it), and for a read-only session. Then the
    /// save dialog, outside every lock, suggesting the vault's name and today's date (`Dismissed` when closed); a name
    /// that does not end in `.lockbox-backup` (any case) is refused as `"backup extension"`, a place inside the state
    /// folder as `"state folder"`, both before anything is written. Then the engine's check, which refuses everything
    /// that can be refused before a byte is written (below), with no job begun and nothing sent to the page. Then, in
    /// a long job the page's `request` names
    /// (progress, and a Stop through `cancel_operation`; writes answer `Busy` meanwhile): the engine's backup, its temp
    /// recorded in the output journal first and each rename attempt only while the session is still unlocked in
    /// `generation`. An existing backup file is touched only by the rename of a backup that has verified. A lock at any
    /// point answers `Locked`; a Stop answers `Cancelled`, with nothing half-made left.
    ///
    /// The engine refuses a backup in four cases the person must act on differently ([`backup_refusal`]): each is
    /// answered with its own fixed `what`. Only a backup that was published notes the date, as `vault_state`'s
    /// `last_backup` (UTC, the shell's wall clock); a note that cannot be saved does not fail a backup that is on disk.
    pub fn backup_vault(
        &self,
        session: SessionId,
        generation: u64,
        request: u32,
    ) -> ShellResult<Tagged<Outcome<BackupView>>> {
        self.outputs.usable()?;
        // Read as `import` reads it: a read-only session has no backup of its own to make, and is refused before the
        // dialog. The vault's name suggests the file's.
        let name = self
            .sessions
            .read(session, generation, |vault, _| match vault {
                VaultRef::Writable(vault) => Ok(vault.name().to_owned()),
                VaultRef::ReadOnly(_) => Err(ShellError::ReadOnly),
            })?;
        let today = self.os.clock.local_date();
        let suggested = safe_name(&format!("{} {today}{EXTENSION}", name.data));
        let Some(dest) = self
            .os
            .dialogs
            .save_file("Back up this vault", &suggested, Some(FILTER))
        else {
            return self.still_current(session, generation, Outcome::Dismissed);
        };
        if !has_backup_extension(&dest) {
            return Err(ShellError::InvalidInput {
                what: "backup extension",
            });
        }
        let dest = self.output_destination(&dest)?;
        self.sessions
            .read_long(session, generation, |vault, cancel| {
                let VaultRef::Writable(vault) = vault else {
                    return Err(ShellError::ReadOnly);
                };
                // Everything the engine refuses before it writes (the header cases, a destination it cannot take, too
                // many entries, too little space) is answered here, before the job begins: the page takes
                // `job-started` for "the work began", and a refusal must reach it as the refusal it is. The session's
                // own token is the stop meanwhile (a lock); the page has no operation to stop yet.
                let plan = vault
                    .backup_check(&dest, cancel)
                    .map_err(|refusal| backup_refusal(vault, refusal.into()))?;
                let scope = JobScope::Session {
                    session,
                    generation,
                };
                let job = self
                    .autolock
                    .begin_job(scope, JobKind::Backup, cancel, Some(request));
                let journal = self.outputs.for_call(&self.sessions, session, generation);
                let made = plan.write(&journal, job.token(), job.progress());
                let report = journal
                    .finish(made)
                    .map_err(|refusal| backup_refusal(vault, refusal))?;
                // The backup is on disk: the date is noted before anything else can fail, and a note that cannot be
                // saved does not make a finished backup a failed one (the reminder just shows again).
                let finished = dates::rfc3339_utc(self.os.clock.wall());
                let _ = self.vault_state.set_last_backup(vault.dir(), &finished);
                let size_on_disk = fs::metadata(&dest)?.len();
                // The new backup is held to be tested (22c's "Test this backup"), by its own token and never its path.
                let test = self.hold_backup(&dest, size_on_disk)?;
                Ok(Outcome::Done(BackupView::of(report, size_on_disk, test)))
            })
    }

    /// Whether a backup of the open vault is due: 30 or more whole days since the last backup, or since the vault was
    /// made when there is none (spec §6.7's reminder). `None` otherwise, and always `None` for a read-only session
    /// (a backup or an older copy has nothing of its own to back up). A note that cannot be read as a date counts as no
    /// backup, so the reminder shows rather than hides; a date in the future (a clock set back) is not due.
    pub fn vault_backup_due(
        &self,
        session: SessionId,
        generation: u64,
    ) -> ShellResult<Tagged<Option<BackupDue>>> {
        self.sessions.read(session, generation, |vault, _| {
            let VaultRef::Writable(vault) = vault else {
                return Ok(None);
            };
            let since = self
                .vault_state
                .last_backup(vault.dir())
                .and_then(|noted| dates::parse_utc(&noted))
                .or_else(|| dates::parse_utc(vault.created_at()));
            let now = dates::unix_secs(self.os.clock.wall());
            let days = since.map_or(0, |since| dates::whole_days_since(since, now));
            Ok((days >= BACKUP_DUE_DAYS).then_some(BackupDue { days }))
        })
    }

    /// Holds the backup at `path` (just written, `size` bytes) as a choice for `test_backup`, and answers its token with
    /// the file's name and size. `Locked` when all vaults were locked, or the app began closing, while it was being held:
    /// nothing is left held then.
    fn hold_backup(&self, path: &Path, size: u64) -> ShellResult<TestPick> {
        let epoch = self.sessions.epoch();
        let pending = self.sessions.pending();
        let choice = pending.put_at(
            PendingChoice::TestBackup {
                path: path.to_path_buf(),
                epoch,
            },
            self.os.clock.now(),
        );
        if self.locked_since(epoch) {
            pending.forget_test_backup(&choice);
            return Err(ShellError::Locked);
        }
        Ok(TestPick {
            choice,
            file_name: display_name(path),
            size,
        })
    }

    /// Opens the picker of "Test a backup" (outside every lock) and holds the backup picked in Rust, as a choice that
    /// lives until it is forgotten ([`forget_test_backup`](Self::forget_test_backup)), a lock of all vaults, closing, a
    /// new pick or five minutes without an attempt (spec §6.7). `choice` is the one being replaced (Pick another): once
    /// the new pick is held it is forgotten; a closed picker answers `Dismissed` and leaves it as it was. The answer is
    /// the new token, the file's name and its size: never the path. The lock epoch is read before the picker, so a lock of
    /// all vaults while it is open is not forgotten: `Locked`, with nothing held. Needs no session.
    pub fn test_backup_pick(&self, choice: Option<&Token>) -> ShellResult<Outcome<TestPick>> {
        let epoch = self.sessions.epoch();
        let Some(path) = self.os.dialogs.pick_file(TEST_PICK_TITLE, Some(FILTER)) else {
            return Ok(Outcome::Dismissed);
        };
        let size = fs::metadata(&path)?.len();
        let file_name = display_name(&path);
        let pending = self.sessions.pending();
        let held = pending.put_at(
            PendingChoice::TestBackup { path, epoch },
            self.os.clock.now(),
        );
        // A lock of all vaults came while the picker was open (or the app is closing): what was just held is no one's.
        if self.locked_since(epoch) {
            pending.forget_test_backup(&held);
            return Err(ShellError::Locked);
        }
        if let Some(old) = choice {
            pending.forget_test_backup(old);
        }
        Ok(Outcome::Done(TestPick {
            choice: held,
            file_name,
            size,
        }))
    }

    /// Drops the held backup `choice` (the page's panel closed, or its vault locked). Forgetting is idempotent: a token
    /// that is unknown, dropped already or another kind of choice's is nothing to forget, and answers without error.
    pub fn forget_test_backup(&self, choice: &Token) -> ShellResult<()> {
        self.sessions.pending().forget_test_backup(choice);
        Ok(())
    }

    /// Checks the backup held under `choice`, without restoring it (spec §6.7): the credential opens it, every entry and
    /// file is read and checked. `ChoiceExpired` (before anything else) for a choice that is not held: unknown, dropped,
    /// used, five minutes old or another kind. The credential is read before the job begins, so one that cannot be read
    /// (a recovery key that is no key) starts nothing. The job is launch-scoped (progress, and a Stop through
    /// `cancel_operation`), begun with the page's `request`.
    ///
    /// A lock of all vaults, or the app closing, is looked for as the job begins (before the backup is read) and again
    /// when it ends, its announcement included (a lock can land there): `Locked`, whatever was found. Every other answer
    /// (good, a wrong password, damaged, a stop, an I/O refusal) keeps the choice, each starting its five minutes again,
    /// so the person can try another password. Writes nothing; a damaged output journal does not stop it. Needs no
    /// session.
    pub fn test_backup(
        &self,
        choice: &Token,
        credential: CredentialArg,
        request: u32,
    ) -> ShellResult<Outcome<BackupSummaryView>> {
        let pending = self.sessions.pending();
        let epoch = self.sessions.epoch();
        // In use from here to the end of the run: the timer's sweeps leave it alone however long the check takes, and its
        // five minutes start again, by the shell's clock, when `attempt` is dropped (on every way out, a refusal included).
        let now = || self.os.clock.now();
        let attempt = pending.use_test_backup(choice, epoch, &now)?;
        let backup = attempt.path();
        let attempts = credential.attempts()?;
        let job = self.begin_launch_job(JobKind::Test, Some(request));
        // A lock before the job began: nothing is read. (One after it cancels the job's token, and its answer is refused
        // by `answer_job`.)
        if self.locked_since(epoch) {
            return Err(ShellError::Locked);
        }
        let verified = attempts
            .run(|credential| verify_backup(backup, credential, job.token(), job.progress()));
        drop(attempts);
        let checked = verified.map_err(ShellError::from).and_then(|found| {
            let size_on_disk = fs::metadata(backup)?.len();
            Ok(BackupSummaryView {
                created_at: found.created_at,
                items: found.items,
                files: found.files,
                missing_files: found.missing_files,
                size_on_disk,
            })
        });
        // Kept for the next attempt, with its five minutes started again from here (nothing to do if a lock or a forget
        // has taken it).
        drop(attempt);
        // Ending the job announces on `lockbox://busy`, where a lock can land: the answer is checked after it.
        self.autolock.answer_job(job, checked).map(Outcome::Done)
    }

    /// Whether all vaults were locked since `epoch` was read, or the app is closing (spec §7.4).
    pub(crate) fn locked_since(&self, epoch: u64) -> bool {
        epoch != self.sessions.epoch() || self.sessions.closing_gate().load(Ordering::SeqCst)
    }

    /// Opens a backup the user picks as a read-only session keyed by the backup's location (spec §6.9).
    /// `Dismissed` when the dialog is closed, before anything else. A backup already open is answered as it is. The
    /// lock epoch is read before the dialog: a lock of all vaults while the picker is open, or while the backup
    /// opens, answers `Locked` and opens nothing.
    pub fn open_backup_read_only(
        &self,
        credential: CredentialArg,
    ) -> ShellResult<Outcome<Tagged<SessionInfo>>> {
        let epoch = self.sessions.epoch();
        let Some(backup) = self.os.dialogs.pick_file("Open a backup", Some(FILTER)) else {
            return Ok(Outcome::Dismissed);
        };
        let credential = credential.typed()?;
        let location = Location::backup(&backup)?;
        let answer = self
            .sessions
            .open_since(epoch, Some(location.clone()), None, |cancel| {
                let vault = ReadOnlyVault::open_backup(
                    location.path(),
                    credential.credential(),
                    cancel,
                    &NoProgress,
                )?;
                Ok(OpenStep::Session(location, Opened::ReadOnly(vault), ()))
            })?;
        match answer {
            Outcome::Done(Tagged {
                session,
                generation,
                data: (info, _),
            }) => Ok(Outcome::Done(Tagged {
                session,
                generation,
                data: info,
            })),
            // The opening closure never asks.
            Outcome::Confirm(_) | Outcome::Dismissed => Err(ShellError::Cancelled),
        }
    }

    /// Copies the item `id` of the read-only session `from` into the open vault of session `to` (spec §6.9). When
    /// the backup does not hold some of the item's files and `skip_missing` is not set, nothing is copied and the
    /// answer is [`Confirm::MissingFiles`] with their names; sending the command again with `skip_missing` copies
    /// the item without them and lists their names. A lock of either session while it runs answers `Locked`, with
    /// no blob of the copy left.
    pub fn copy_item_to(
        &self,
        from: SessionId,
        from_generation: u64,
        id: &str,
        to: SessionId,
        to_generation: u64,
        skip_missing: bool,
    ) -> ShellResult<Tagged<Outcome<CopiedItemView>>> {
        let id = ItemId::from_hex(id)?;
        self.sessions.read_write(
            from,
            from_generation,
            to,
            to_generation,
            |source, vault, cancel| {
                // The item's own record names its files; the question and the answer both list them in its order.
                let attachments = &source.get_item(&id)?.attachments;
                let names = |files: &[FileId]| -> Vec<String> {
                    let listed = attachments
                        .iter()
                        .filter(|file| files.contains(&file.file_id));
                    listed.map(|file| file.name.clone()).collect()
                };
                if !skip_missing {
                    let missing = source.missing_attachments(&id)?;
                    if !missing.is_empty() {
                        let names = names(&missing);
                        return Ok(Outcome::Confirm(Confirm::MissingFiles { names }));
                    }
                }
                let _operation = self
                    .autolock
                    .begin(Some(to), JobKind::CopyItem, cancel.clone());
                let copied = vault.copy_item_from(source, &id, skip_missing, cancel)?;
                Ok(Outcome::Done(CopiedItemView {
                    id: copied.id.to_hex(),
                    left_out: names(&copied.left_out),
                }))
            },
        )
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BackupVault {
    session: SessionId,
    generation: u64,
    /// The page's number for this job: its operation reaches the page by `lockbox://job-started` under it.
    request: u32,
}

/// `vault_backup_due`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BackupDueArgs {
    session: SessionId,
    generation: u64,
}

/// `open_backup_read_only`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialOnly {
    credential: CredentialArg,
}

/// `test_backup_pick`: the choice being replaced (Pick another), or `null` for the first pick.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TestBackupPick {
    choice: Option<Token>,
}

/// `test_backup`: the held backup, what was typed, and the page's number for this job.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TestBackupArgs {
    choice: Token,
    credential: CredentialArg,
    /// The page's number for this job: its operation reaches the page by `lockbox://job-started` under it.
    request: u32,
}

/// `forget_test_backup`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ForgetTestBackup {
    choice: Token,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CopyItemTo {
    from: SessionId,
    from_generation: u64,
    id: String,
    to: SessionId,
    to_generation: u64,
    /// The user said yes to [`Confirm::MissingFiles`].
    skip_missing: bool,
}

#[tauri::command]
pub(super) async fn backup_vault(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<Outcome<BackupView>>> {
    let BackupVault {
        session,
        generation,
        request,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.backup_vault(session, generation, request)).await
}

#[tauri::command]
pub(super) async fn vault_backup_due(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<Option<BackupDue>>> {
    let BackupDueArgs {
        session,
        generation,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.vault_backup_due(session, generation)).await
}

#[tauri::command]
pub(super) async fn test_backup_pick(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Outcome<TestPick>> {
    let TestBackupPick { choice } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.test_backup_pick(choice.as_ref())).await
}

#[tauri::command]
pub(super) async fn test_backup(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Outcome<BackupSummaryView>> {
    let TestBackupArgs {
        choice,
        credential,
        request,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.test_backup(&choice, credential, request)).await
}

#[tauri::command]
pub(super) async fn forget_test_backup(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<()> {
    let ForgetTestBackup { choice } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.forget_test_backup(&choice)).await
}

#[tauri::command]
pub(super) async fn open_backup_read_only(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Outcome<Tagged<SessionInfo>>> {
    let CredentialOnly { credential } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.open_backup_read_only(credential)).await
}

#[tauri::command]
pub(super) async fn copy_item_to(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<Outcome<CopiedItemView>>> {
    let CopyItemTo {
        from,
        from_generation,
        id,
        to,
        to_generation,
        skip_missing,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || {
        shell.copy_item_to(from, from_generation, &id, to, to_generation, skip_missing)
    })
    .await
}

/// `restore_pick`: the pick being replaced (Pick another), or `null` for the first pick.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RestorePickArgs {
    choice: Option<Token>,
}

/// `restore_check`: the held pick, and what was typed (a password or a recovery key, in the one box).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RestoreCheckArgs {
    choice: Token,
    credential: CredentialArg,
}

/// `restore_choose_folder`: the held pick, whose folder is chosen.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChooseRestoreFolder {
    choice: Token,
}

/// `forget_restore_pick`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ForgetRestorePick {
    choice: Token,
}

/// `restore_prepare`: the held pick, whose credential and folder are in Rust already, and the page's number for the job.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RestorePrepare {
    choice: Token,
    /// The page's number for this job: its operation reaches the page by `lockbox://job-started` under it.
    request: u32,
}

/// `restore_prepare_confirm`: the token of the question, for a new folder its name, and the page's number for the job.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RestorePrepareConfirm {
    token: Token,
    name: Option<String>,
    request: u32,
}

/// `restore_commit`: the finished restore, and the page's number for the swap's job.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RestoreCommit {
    restore: u32,
    request: u32,
}

/// `restore_discard`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RestoreArg {
    restore: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DismissRestore {
    confirm: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeletePreRestore {
    id: u32,
    confirm: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenPreRestore {
    id: u32,
    credential: CredentialArg,
}

#[tauri::command]
pub(super) async fn restore_pick(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Outcome<RestorePick>> {
    let RestorePickArgs { choice } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.restore_pick(choice.as_ref())).await
}

#[tauri::command]
pub(super) async fn restore_check(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<RestoreChecked> {
    let RestoreCheckArgs { choice, credential } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.restore_check(&choice, credential)).await
}

#[tauri::command]
pub(super) async fn restore_choose_folder(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Outcome<RestoreChecked>> {
    let ChooseRestoreFolder { choice } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.restore_choose_folder(&choice)).await
}

#[tauri::command]
pub(super) async fn forget_restore_pick(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<()> {
    let ForgetRestorePick { choice } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.forget_restore_pick(&choice)).await
}

#[tauri::command]
pub(super) async fn restore_prepare(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Outcome<RestorePreparedView>> {
    let RestorePrepare { choice, request } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.restore_prepare(&choice, request)).await
}

#[tauri::command]
pub(super) async fn restore_prepare_confirm(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Outcome<RestorePreparedView>> {
    let RestorePrepareConfirm {
        token,
        name,
        request,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.restore_prepare_confirm(&token, name, request)).await
}

#[tauri::command]
pub(super) async fn restore_commit(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<RestoredView> {
    let RestoreCommit { restore, request } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.restore_commit(restore, request)).await
}

#[tauri::command]
pub(super) async fn restore_discard(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<()> {
    let RestoreArg { restore } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.restore_discard(restore)).await
}

#[tauri::command]
pub(super) async fn restore_notice(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<RestoreNotice> {
    let NoArgs {} = args(&request)?;
    Ok(shell.restore_notice())
}

#[tauri::command]
pub(super) async fn retry_restore_recovery(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<RestoreNotice> {
    let NoArgs {} = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.retry_restore_recovery()).await
}

#[tauri::command]
pub(super) async fn dismiss_restore(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Outcome<()>> {
    let DismissRestore { confirm } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.dismiss_restore(confirm)).await
}

#[tauri::command]
pub(super) async fn list_pre_restore(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Vec<PreRestoreEntry>> {
    let NoArgs {} = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || Ok(shell.list_pre_restore())).await
}

#[tauri::command]
pub(super) async fn delete_pre_restore(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Outcome<()>> {
    let DeletePreRestore { id, confirm } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.delete_pre_restore(id, confirm)).await
}

#[tauri::command]
pub(super) async fn open_pre_restore_read_only(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<crate::restore::PreRestoreOpened>> {
    let OpenPreRestore { id, credential } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.open_pre_restore_read_only(id, credential)).await
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::path::PathBuf;
    use std::rc::Rc;
    use std::sync::Mutex;
    use std::time::{Duration, Instant, UNIX_EPOCH};

    use lockbox_core::blob::CancelToken;
    use lockbox_core::internals::fsio::testutil::{flip_byte, names};
    use lockbox_core::internals::fsio::{VolumeInfo, failpoint, set_volume_override};
    use lockbox_core::internals::header::{
        HEADER_FILE, VaultHeader, parse_header, serialize_header,
    };
    use serde_json::{Value, json};
    use tauri::ipc::InvokeBody;
    use zeroize::Zeroizing;

    use super::super::items::{ItemEdit, NewKind};
    use super::super::{MALFORMED, parse};
    use super::*;
    use crate::dates;
    use crate::jobs::{JobScope, OperationId};
    use crate::os::Clock;
    use crate::session::{LockReason, SessionState};
    use crate::testing::{TEST_PASSWORD, TestShell, heavy};

    /// Always disarms, so a failing test cannot leak a failpoint into the next one on this thread.
    struct Cleanup;
    impl Drop for Cleanup {
        fn drop(&mut self) {
            failpoint::disarm_all();
        }
    }

    const LOCKED: Option<ShellError> = Some(ShellError::Locked);
    const NOT_A_BACKUP: ShellError = ShellError::InvalidInput {
        what: "backup extension",
    };
    const BUSY: Option<ShellError> = Some(ShellError::Busy {
        what: "operation in progress",
    });

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

    /// The folder that holds the test's backups, and the backup file `name` in it.
    fn backup_file(ts: &TestShell, name: &str) -> PathBuf {
        ts.folder("Backups").join(name)
    }

    /// A backup of the session's vault in `dest`.
    fn back_up(ts: &TestShell, s: SessionId, g: u64, dest: &Path) -> BackupView {
        ts.dialogs.answer(Some(dest.to_path_buf()));
        done(ts.shell.backup_vault(s, g, 1).unwrap().data)
    }

    /// The backup in `dest` opened read-only: its session and generation.
    fn open_backup(ts: &TestShell, dest: &Path) -> (SessionId, u64) {
        ts.dialogs.answer(Some(dest.to_path_buf()));
        let opened = heavy(|| ts.shell.open_backup_read_only(password())).unwrap();
        let tagged = done(opened);
        assert!(tagged.data.read_only);
        (tagged.session, tagged.generation)
    }

    /// The backup in `dest` picked (the picker answers it) and tested with the vault's password.
    fn summary(ts: &TestShell, dest: &Path) -> BackupSummaryView {
        let picked = pick(ts, dest);
        done(test_with(ts, &picked, typed(TEST_PASSWORD)).unwrap())
    }

    /// The page's first pick: the picker answers `path`, no choice sent.
    fn pick(ts: &TestShell, path: &Path) -> TestPick {
        ts.dialogs.answer(Some(path.to_path_buf()));
        done(ts.shell.test_backup_pick(None).unwrap())
    }

    /// One `test_backup` attempt on the choice `picked`, as request 1.
    fn test_with(
        ts: &TestShell,
        picked: &TestPick,
        credential: CredentialArg,
    ) -> ShellResult<Outcome<BackupSummaryView>> {
        heavy(|| ts.shell.test_backup(&picked.choice, credential, 1))
    }

    /// What the page sends from the one box: a password or a recovery key.
    fn typed(text: &str) -> CredentialArg {
        CredentialArg::PasswordOrKey(Zeroizing::new(text.to_owned()))
    }

    /// The folder of the first vault the shell lists.
    fn vault_dir(ts: &TestShell) -> PathBuf {
        ts.shell.registry.entries()[0].1.clone()
    }

    fn titles(ts: &TestShell, s: SessionId, g: u64) -> Vec<String> {
        let list = ts.shell.list_items(s, g).unwrap().data;
        let mut titles: Vec<String> = list.items.into_iter().map(|item| item.title).collect();
        titles.sort();
        titles
    }

    /// Adds a file the backup tests attach to `id`, straight through the engine.
    fn attach(ts: &TestShell, s: SessionId, g: u64, id: &str, name: &str, bytes: &[u8]) -> String {
        let source = ts.temp.path().join(name);
        fs::write(&source, bytes).unwrap();
        let id = ItemId::from_hex(id).unwrap();
        let file = ts
            .shell
            .sessions
            .write(s, g, |vault, cancel| {
                Ok(vault
                    .attach_file(&id, &source, cancel, &NoProgress)?
                    .to_hex())
            })
            .unwrap()
            .data;
        fs::remove_file(source).unwrap();
        file
    }

    /// §9: while a backup runs, edits and imports are refused as busy, and the backup holds exactly the items from
    /// before them.
    #[test]
    fn backup_while_edits_and_imports_attempted() {
        let ts = TestShell::new();
        // After the shell, so it drops first: an observer holds a clone of the shell, which would keep it open.
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "report.pdf", b"report");
        let login = ts
            .shell
            .new_item(s, g, NewKind::Login, "Bank".into(), None, None)
            .unwrap()
            .data;
        let dest = backup_file(&ts, "family.lockbox-backup");
        let source = ts.temp.path().join("extra.bin");
        fs::write(&source, b"extra").unwrap();

        let refused = Rc::new(RefCell::new(Vec::new()));
        let seen = Rc::clone(&refused);
        let (shell, dialogs) = (Arc::clone(&ts.shell), Arc::clone(&ts.dialogs));
        failpoint::observe(
            "backup.before_publish",
            Box::new(move || {
                let edit = ItemEdit {
                    id: login.clone(),
                    revision: 0,
                    title: "Changed during the backup".into(),
                    notes: Zeroizing::new(String::new()),
                    collection: None,
                    username: None,
                    password: None,
                    urls: None,
                    key_value: None,
                };
                let edited = shell.update_item(s, g, edit).err();
                dialogs.answer(Some(source.clone()));
                let imported = shell.add_file(s, g, None, 1).err();
                seen.borrow_mut().extend([edited, imported]);
            }),
        );
        let view = back_up(&ts, s, g, &dest);

        assert_eq!(*refused.borrow(), [BUSY, BUSY]);
        assert_eq!((view.items, view.files), (2, 1));
        let held = heavy(|| {
            verify_backup(
                &dest,
                Credential::Password(TEST_PASSWORD),
                &CancelToken::new(),
                &NoProgress,
            )
        })
        .unwrap();
        assert_eq!((held.items, held.files), (2, 1));
        assert_eq!(titles(&ts, s, g), ["Bank", "report.pdf"]);
        let busy = ts.events.busy();
        assert!(busy.contains(&(Some(s), vec!["backup"])), "{busy:?}");
    }

    /// Only a name ending in `.lockbox-backup` (any case) is written, and never into the state folder; a read-only
    /// session and a damaged output journal are refused before the dialog; a closed dialog does nothing.
    #[test]
    fn backup_extension_enforced() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let folder = ts.folder("Backups");
        for name in ["x.zip", "x", "x.lockbox-backup.zip", "x.lockbox-backups"] {
            ts.dialogs.answer(Some(folder.join(name)));
            assert_eq!(
                ts.shell.backup_vault(s, g, 1).err(),
                Some(NOT_A_BACKUP),
                "{name}"
            );
        }
        assert!(names(&folder).is_empty(), "nothing written");
        assert!(!ts.shell.paths.outputs.exists(), "no journal change");

        fs::create_dir_all(&ts.shell.paths.root).unwrap();
        let in_state = ts.shell.paths.root.join("x.lockbox-backup");
        ts.dialogs.answer(Some(in_state.clone()));
        assert_eq!(
            ts.shell.backup_vault(s, g, 1).err(),
            Some(ShellError::InvalidInput {
                what: "state folder"
            })
        );
        assert!(!in_state.exists());

        let shouting = folder.join("FAMILY.LOCKBOX-BACKUP");
        let view = back_up(&ts, s, g, &shouting);
        assert_eq!(view.items, 0);
        assert_eq!(names(&folder), ["FAMILY.LOCKBOX-BACKUP"]);

        // A closed dialog: `Dismissed`, tagged.
        let closed = ts.shell.backup_vault(s, g, 1).unwrap();
        assert_eq!((closed.session, closed.generation), (s, g));
        assert!(matches!(closed.data, Outcome::Dismissed));

        // A damaged output journal: refused before the dialog.
        let opened = ts.dialogs.opened();
        fs::create_dir_all(&ts.shell.paths.root).unwrap();
        fs::write(&ts.shell.paths.outputs, b"not a journal").unwrap();
        assert!(matches!(
            ts.shell.backup_vault(s, g, 1).err(),
            Some(ShellError::Core(view)) if view.kind == "damaged"
        ));
        assert_eq!(ts.dialogs.opened(), opened);
    }

    // ---- Task 4: testing a backup, picked first and held in Rust ----

    const EXPIRED: Option<ShellError> = Some(ShellError::ChoiceExpired);

    /// A folder name that no answer or event may ever hold: it is found if a path leaks.
    const SECRET_FOLDER: &str = "Private-Folder-4d1c9e";

    /// A backup of a fresh vault, written into the folder [`SECRET_FOLDER`].
    fn secret_backup(ts: &TestShell, s: SessionId, g: u64) -> PathBuf {
        let dest = ts.folder(SECRET_FOLDER).join("family.lockbox-backup");
        back_up(ts, s, g, &dest);
        dest
    }

    /// Every file of `dir` with its bytes and its time of last change, by name.
    fn snapshot(dir: &Path) -> Vec<(String, Vec<u8>, std::time::SystemTime)> {
        let mut all: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                let modified = entry.metadata().unwrap().modified().unwrap();
                let name = entry.file_name().to_string_lossy().into_owned();
                (name, fs::read(entry.path()).unwrap(), modified)
            })
            .collect();
        all.sort_by(|a, b| a.0.cmp(&b.0));
        all
    }

    /// The typed credential opens the backup: the password, the recovery key, either in the one box; a wrong password
    /// is refused as one; the counts, the date and the size are the backup's.
    #[test]
    fn test_backup_needs_the_credential() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "report.pdf", b"report");
        let key = ts.shell.regenerate_recovery(s, g).unwrap().data;
        let dest = backup_file(&ts, "family.lockbox-backup");
        back_up(&ts, s, g, &dest);

        let picked = pick(&ts, &dest);
        let found = done(test_with(&ts, &picked, typed(TEST_PASSWORD)).unwrap());
        assert_eq!((found.items, found.files, found.missing_files), (1, 1, 0));
        assert!(found.created_at.starts_with("20"), "{}", found.created_at);
        assert_eq!(found.size_on_disk, fs::metadata(&dest).unwrap().len());
        // The old forms still work for the callers that use them.
        let by_key = CredentialArg::RecoveryKey(key);
        assert_eq!(done(test_with(&ts, &picked, by_key).unwrap()).items, 1);
        let by_password = password();
        assert_eq!(done(test_with(&ts, &picked, by_password).unwrap()).items, 1);

        let wrong = CredentialArg::Password(Zeroizing::new("another long password".into()));
        assert_eq!(test_with(&ts, &picked, wrong).err(), Some(wrong_password()));
        // A recovery key that is no key at all is refused as one, before any job begins.
        let started = ts.events.started().len();
        let junk = CredentialArg::RecoveryKey(Zeroizing::new("not a key".into()));
        assert!(matches!(
            test_with(&ts, &picked, junk).err(),
            Some(ShellError::Core(_))
        ));
        assert_eq!(ts.events.started().len(), started, "no job for it");
    }

    /// One box, two meanings: text that reads as a well-formed recovery key is tried as the key and, when that is wrong,
    /// as a password too; anything else (a near-miss key included, with no typo words) is tried as a password only.
    #[test]
    fn password_or_key_tries_a_well_formed_key_then_a_password() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let key = ts.shell.regenerate_recovery(s, g).unwrap().data;
        // Another vault's recovery key, which is also a well-formed key: made this vault's password, so that only the
        // fallback to a password can open the backup with it.
        let (other, og) = ts.open_vault("Other");
        let other_key = ts.shell.regenerate_recovery(other, og).unwrap().data;
        let dest = backup_file(&ts, "family.lockbox-backup");
        back_up(&ts, s, g, &dest);
        ts.shell
            .change_password(s, g, Zeroizing::new(other_key.to_string()))
            .unwrap();
        let by_new_password = backup_file(&ts, "second.lockbox-backup");
        back_up(&ts, s, g, &by_new_password);

        // The key opens the first backup as a key, though its text is a good password for no one.
        let picked = pick(&ts, &dest);
        let found = done(test_with(&ts, &picked, typed(&key)).unwrap());
        assert_eq!(found.items, 0);
        // The password that is not a key opens it as a password.
        done(test_with(&ts, &picked, typed(TEST_PASSWORD)).unwrap());

        // The second backup's password is a well-formed key: the key attempt is wrong, the password attempt opens it.
        let picked = pick(&ts, &by_new_password);
        done(test_with(&ts, &picked, typed(&other_key)).unwrap());
        // A well-formed key that is wrong as a key and as a password: the first backup's password is not that text.
        let picked_first = pick(&ts, &dest);
        assert_eq!(
            test_with(&ts, &picked_first, typed(&other_key)).err(),
            Some(wrong_password())
        );

        // A near-miss key (a word short) is no key: tried as a password, so no count or typo words, just a wrong
        // password.
        let words: Vec<&str> = key.split(' ').collect();
        assert_eq!(words.len(), 24);
        let near_miss = words[..23].join(" ");
        assert!(RecoverySecret::parse(&near_miss).is_err(), "it is no key");
        assert_eq!(
            test_with(&ts, &picked, typed(&near_miss)).err(),
            Some(wrong_password())
        );
        // Plain wrong text is a wrong password.
        assert_eq!(
            test_with(&ts, &picked, typed("another long password")).err(),
            Some(wrong_password())
        );
    }

    /// The pick is held in Rust and kept through every answer: a wrong password, a damaged backup, a missing file;
    /// the picker is not opened again, and the right password then opens it.
    #[test]
    fn test_pick_kept_through_a_wrong_password() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "report.pdf", &vec![3u8; 300_000]);
        let dest = backup_file(&ts, "family.lockbox-backup");
        back_up(&ts, s, g, &dest);
        // The backup's own offer to be tested is held too.
        let base = ts.shell.sessions.pending().len();
        let picked = pick(&ts, &dest);
        let opened = ts.dialogs.opened();

        for _ in 0..2 {
            assert_eq!(
                test_with(&ts, &picked, typed("another long password")).err(),
                Some(wrong_password())
            );
        }
        assert_eq!(
            done(test_with(&ts, &picked, typed(TEST_PASSWORD)).unwrap()).files,
            1
        );
        assert_eq!(
            ts.dialogs.opened(),
            opened,
            "the picker was not opened again"
        );
        assert_eq!(ts.shell.sessions.pending().len(), base + 1, "still held");

        // Damaged: the answer says so, and the choice stays.
        let len = fs::metadata(&dest).unwrap().len();
        let copy = backup_file(&ts, "damaged.lockbox-backup");
        fs::copy(&dest, &copy).unwrap();
        for at in len - 900..len - 10 {
            flip_byte(&copy, at).unwrap();
        }
        let damaged = pick(&ts, &copy);
        assert!(matches!(
            test_with(&ts, &damaged, typed(TEST_PASSWORD)).err(),
            Some(ShellError::Core(view)) if view.kind == "damaged"
        ));
        // The file gone: an I/O refusal, and the choice stays for a retry.
        fs::remove_file(&copy).unwrap();
        assert!(matches!(
            test_with(&ts, &damaged, typed(TEST_PASSWORD)).err(),
            Some(ShellError::Core(view)) if view.kind == "io"
        ));
        assert_eq!(ts.shell.sessions.pending().len(), base + 2);
        fs::copy(&dest, &copy).unwrap();
        assert_eq!(
            done(test_with(&ts, &damaged, typed(TEST_PASSWORD)).unwrap()).files,
            1
        );
    }

    /// A Stop answers `Cancelled` and keeps the choice too.
    #[test]
    fn a_stopped_test_keeps_the_pick() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let bytes: Vec<u8> = (0..3 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
        ts.stored_file(s, g, "report.pdf", &bytes);
        let dest = backup_file(&ts, "family.lockbox-backup");
        back_up(&ts, s, g, &dest);
        let picked = pick(&ts, &dest);
        let (shell, flag) = (
            Arc::clone(&ts.shell),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        );
        ts.events.watch(move |name, payload| {
            if name == crate::shell::PROGRESS_EVENT && !flag.swap(true, Ordering::SeqCst) {
                let operation = OperationId(payload["operation"].as_u64().unwrap());
                let scope: JobScope = serde_json::from_value(payload["scope"].clone()).unwrap();
                shell.autolock.cancel_operation(operation, scope).unwrap();
            }
        });
        let answer = test_with(&ts, &picked, typed(TEST_PASSWORD));
        ts.events.watch(|_, _| {});
        assert_eq!(answer.err(), Some(ShellError::Cancelled));
        assert_eq!(
            done(test_with(&ts, &picked, typed(TEST_PASSWORD)).unwrap()).files,
            1
        );
    }

    /// No answer and no event holds the backup's folder or path: the page sees the file's name, its size and the
    /// token, nothing else.
    #[test]
    fn backup_path_never_reaches_the_page() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "report.pdf", &vec![3u8; 300_000]);
        let dest = ts.folder(SECRET_FOLDER).join("family.lockbox-backup");
        ts.dialogs.answer(Some(dest.clone()));
        let made = ts.shell.backup_vault(s, g, 1).unwrap().data;
        let mut seen = vec![serde_json::to_string(&made).unwrap()];
        let made = done(made);
        let picked = pick(&ts, &dest);
        seen.push(serde_json::to_string(&picked).unwrap());
        assert_eq!(picked.file_name, "family.lockbox-backup");
        for credential in [typed("another long password"), typed(TEST_PASSWORD)] {
            let answer = test_with(&ts, &picked, credential);
            seen.push(match answer {
                Ok(answer) => serde_json::to_string(&answer).unwrap(),
                Err(refused) => serde_json::to_string(&refused).unwrap(),
            });
        }
        // The backup's own offer to test it, a choice made up, a dismissed picker, a forget.
        seen.push(serde_json::to_string(&made.test).unwrap());
        let made_up = ts.shell.test_backup(&made.test.choice, typed("x"), 2);
        seen.push(serde_json::to_string(&made_up.err()).unwrap());
        ts.dialogs.answer(None);
        let closed = ts.shell.test_backup_pick(Some(&picked.choice)).unwrap();
        seen.push(serde_json::to_string(&closed).unwrap());
        seen.push(
            serde_json::to_string(&ts.shell.forget_test_backup(&picked.choice).unwrap()).unwrap(),
        );
        let gone = ts.shell.test_backup(&picked.choice, typed("x"), 3).err();
        seen.push(serde_json::to_string(&gone).unwrap());
        for (name, payload) in ts.events.job_events() {
            seen.push(format!("{name} {payload}"));
        }
        seen.extend(ts.events.notices().iter().map(Value::to_string));

        let root = ts.temp.path().to_string_lossy().into_owned();
        let escaped = serde_json::to_string(&root).unwrap();
        for text in &seen {
            assert!(!text.contains(SECRET_FOLDER), "{text}");
            assert!(!text.contains(&root), "{text}");
            assert!(!text.contains(escaped.trim_matches('"')), "{text}");
        }
    }

    /// Testing writes nothing: the backup's folder holds the same files, byte for byte and time for time; no output
    /// journal is made.
    #[test]
    fn test_writes_nothing() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "report.pdf", &vec![3u8; 300_000]);
        let dest = secret_backup(&ts, s, g);
        let folder = dest.parent().unwrap().to_path_buf();
        let journal = ts.journal();
        let before = snapshot(&folder);
        let state = names(&ts.shell.paths.root);

        let picked = pick(&ts, &dest);
        for credential in [typed("another long password"), typed(TEST_PASSWORD)] {
            let _ = test_with(&ts, &picked, credential);
        }
        let _ = ts.shell.forget_test_backup(&picked.choice);

        assert_eq!(snapshot(&folder), before);
        assert_eq!(ts.journal(), journal);
        assert_eq!(names(&ts.shell.paths.root), state, "no state file written");
    }

    /// Locking one vault does not drop the held backup; a lock of all vaults, an idle lock, Windows locking, sleep and
    /// closing each drop it (every one is a revoke of all, which drains the table).
    #[test]
    fn test_choice_dropped_on_lock_all_and_on_close() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let dest = secret_backup(&ts, s, g);

        let picked = pick(&ts, &dest);
        ts.shell.sessions.lock(s, LockReason::Manual);
        assert_eq!(
            done(test_with(&ts, &picked, typed(TEST_PASSWORD)).unwrap()).items,
            0
        );
        for reason in [
            LockReason::Manual,
            LockReason::Idle,
            LockReason::WindowsLocked,
            LockReason::Sleep,
        ] {
            let picked = pick(&ts, &dest);
            ts.shell.sessions.lock_all(reason);
            assert_eq!(
                test_with(&ts, &picked, typed(TEST_PASSWORD)).err(),
                EXPIRED,
                "{reason:?}"
            );
            assert_eq!(ts.shell.sessions.pending().len(), 0);
        }
        // Closing: the same.
        let picked = pick(&ts, &dest);
        if let Some(hooks) = ts.shell.sessions.close() {
            hooks.wait();
        }
        assert_eq!(ts.shell.sessions.pending().len(), 0);
        assert_eq!(test_with(&ts, &picked, typed(TEST_PASSWORD)).err(), EXPIRED);
    }

    /// A lock of all vaults between two tries of the credential drops the held backup: the retry is refused as an
    /// expired choice, and picking again works.
    #[test]
    fn test_lock_all_between_credential_retries_drops_the_choice() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let dest = secret_backup(&ts, s, g);
        let picked = pick(&ts, &dest);
        assert_eq!(
            test_with(&ts, &picked, typed("another long password")).err(),
            Some(wrong_password())
        );
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert_eq!(test_with(&ts, &picked, typed(TEST_PASSWORD)).err(), EXPIRED);
        let again = pick(&ts, &dest);
        assert_eq!(
            done(test_with(&ts, &again, typed(TEST_PASSWORD)).unwrap()).items,
            0
        );
    }

    /// A lock of all vaults while the picker is open: `Locked`, and what the pick would have held is not held; the
    /// choice sent with it is dropped by the lock too. A closed picker still answers `Dismissed`.
    #[test]
    fn lock_all_during_a_picker_drops_the_choice() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let dest = secret_backup(&ts, s, g);
        let lock_in_picker = || {
            let shell = Arc::clone(&ts.shell);
            ts.dialogs.during_next_dialog(Box::new(move || {
                shell.sessions.lock_all(LockReason::Manual)
            }));
        };
        lock_in_picker();
        ts.dialogs.answer(Some(dest.clone()));
        assert_eq!(ts.shell.test_backup_pick(None).err(), LOCKED);
        assert_eq!(ts.shell.sessions.pending().len(), 0, "nothing held");

        // Pick another: the sent choice goes with the lock, the new one is never held.
        let first = pick(&ts, &dest);
        lock_in_picker();
        ts.dialogs.answer(Some(dest.clone()));
        assert_eq!(ts.shell.test_backup_pick(Some(&first.choice)).err(), LOCKED);
        assert_eq!(ts.shell.sessions.pending().len(), 0);
        assert_eq!(test_with(&ts, &first, typed(TEST_PASSWORD)).err(), EXPIRED);

        lock_in_picker();
        assert!(matches!(
            ts.shell.test_backup_pick(None),
            Ok(Outcome::Dismissed)
        ));
        // The app closing while the picker is open is refused the same way.
        ts.shell.sessions.shut();
        ts.dialogs.answer(Some(dest));
        assert_eq!(ts.shell.test_backup_pick(None).err(), LOCKED);
        assert_eq!(ts.shell.sessions.pending().len(), 0);
    }

    /// A lock of all vaults while the test runs (as it begins, in the middle, and in the announcement that ends it):
    /// `Locked`, whatever the check found, and the choice is gone with the lock. The app closing is the same.
    #[test]
    fn lock_all_during_a_test_refuses_its_answer() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let bytes: Vec<u8> = (0..3 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
        ts.stored_file(s, g, "report.pdf", &bytes);
        let dest = secret_backup(&ts, s, g);

        // As the operation begins.
        let picked = pick(&ts, &dest);
        let shell = Arc::clone(&ts.shell);
        ts.events.during_next_busy(Box::new(move || {
            shell.sessions.lock_all(LockReason::Manual)
        }));
        assert_eq!(test_with(&ts, &picked, typed(TEST_PASSWORD)).err(), LOCKED);
        let busy = ts.events.busy();
        assert!(busy.contains(&(None, vec!["test_backup"])), "{busy:?}");
        assert_eq!(
            test_with(&ts, &picked, typed(TEST_PASSWORD)).err(),
            EXPIRED,
            "the choice went with the lock"
        );

        // In the middle: the first progress event.
        let picked = pick(&ts, &dest);
        let (shell, flag) = (
            Arc::clone(&ts.shell),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        );
        ts.events.watch(move |name, _| {
            if name == crate::shell::PROGRESS_EVENT && !flag.swap(true, Ordering::SeqCst) {
                shell.sessions.lock_all(LockReason::Manual);
            }
        });
        let answer = test_with(&ts, &picked, typed(TEST_PASSWORD));
        ts.events.watch(|_, _| {});
        assert_eq!(answer.err(), LOCKED);

        // In the announcement that ends it: the final check comes after the operation is dropped.
        let picked = pick(&ts, &dest);
        let (events, shell) = (Arc::clone(&ts.events), Arc::clone(&ts.shell));
        // The first announcement is the start; the hook it leaves runs in the second, the end.
        ts.events.during_next_busy(Box::new(move || {
            events.during_next_busy(Box::new(move || {
                shell.sessions.lock_all(LockReason::Manual)
            }));
        }));
        assert_eq!(test_with(&ts, &picked, typed(TEST_PASSWORD)).err(), LOCKED);
        let busy = ts.events.busy();
        assert_eq!(busy.last(), Some(&(None, vec![])), "the end was announced");

        // The app closing, with the choice held: dropped even when the check itself would have passed.
        let picked = pick(&ts, &dest);
        ts.shell.sessions.shut();
        assert_eq!(test_with(&ts, &picked, typed(TEST_PASSWORD)).err(), LOCKED);
    }

    /// Forgetting drops the choice: the next attempt is refused as expired, and the picker is not opened.
    #[test]
    fn test_backup_choice_refused_after_forget() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let dest = secret_backup(&ts, s, g);
        // The backup's own offer to be tested is held too.
        let base = ts.shell.sessions.pending().len();
        let picked = pick(&ts, &dest);
        assert!(ts.shell.forget_test_backup(&picked.choice).is_ok());
        let opened = ts.dialogs.opened();
        assert_eq!(test_with(&ts, &picked, typed(TEST_PASSWORD)).err(), EXPIRED);
        assert_eq!(ts.dialogs.opened(), opened);
        assert_eq!(ts.shell.sessions.pending().len(), base);
    }

    /// Forgetting is idempotent (an unknown or already-dropped token answers nothing wrong) and drops only a held
    /// backup: a choice of any other kind under the token is left where it is.
    #[test]
    fn forget_test_backup_is_idempotent_and_drops_only_its_kind() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let dest = secret_backup(&ts, s, g);
        let base = ts.shell.sessions.pending().len();
        let picked = pick(&ts, &dest);
        assert!(ts.shell.forget_test_backup(&picked.choice).is_ok());
        assert!(ts.shell.forget_test_backup(&picked.choice).is_ok());
        let made_up = ts.shell.sessions.pending().put(PendingChoice::PickedFiles {
            session: s,
            generation: g,
            paths: vec![PathBuf::from("a")],
        });
        let other = ts.shell.sessions.pending().put(PendingChoice::PickedFiles {
            session: s,
            generation: g,
            paths: vec![PathBuf::from("b")],
        });
        assert!(ts.shell.forget_test_backup(&made_up).is_ok());
        assert_eq!(
            ts.shell.sessions.pending().len(),
            base + 2,
            "another kind stays"
        );
        assert!(
            ts.shell
                .sessions
                .pending()
                .peek_picked(&other, s, g)
                .is_ok()
        );
        assert!(
            ts.shell
                .sessions
                .pending()
                .peek_picked(&made_up, s, g)
                .is_ok()
        );
    }

    /// A token that is not there, is used, is five minutes old or holds another kind of choice answers
    /// `ChoiceExpired`, never `NotFound`; and a choice of another kind is left alone by the refusal.
    #[test]
    fn expired_choice_answers_choice_expired() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let dest = secret_backup(&ts, s, g);
        let pending = ts.shell.sessions.pending();
        let credential = || typed(TEST_PASSWORD);

        // A token that was never parked.
        let made_up = pending.put(PendingChoice::Test(None));
        let _ = pending.take(&made_up);
        assert_eq!(
            heavy(|| ts.shell.test_backup(&made_up, credential(), 1)).err(),
            EXPIRED
        );
        // A choice that was used up (taken by the generic take).
        let picked = pick(&ts, &dest);
        assert!(pending.take(&picked.choice).is_ok());
        assert_eq!(test_with(&ts, &picked, credential()).err(), EXPIRED);
        // Five minutes old.
        let picked = pick(&ts, &dest);
        pending.sweep_at(Instant::now() + Duration::from_secs(10 * 60));
        assert_eq!(test_with(&ts, &picked, credential()).err(), EXPIRED);
        // Another kind of choice under the token: refused, and it stays.
        let files = pending.put(PendingChoice::PickedFiles {
            session: s,
            generation: g,
            paths: vec![dest.clone()],
        });
        assert_eq!(
            heavy(|| ts.shell.test_backup(&files, credential(), 1)).err(),
            EXPIRED
        );
        assert!(pending.peek_picked(&files, s, g).is_ok());
        // Picking another with an expired choice sent still picks.
        let fresh = {
            ts.dialogs.answer(Some(dest.clone()));
            done(ts.shell.test_backup_pick(Some(&picked.choice)).unwrap())
        };
        assert_eq!(done(test_with(&ts, &fresh, credential()).unwrap()).items, 0);
    }

    /// Fix round 2: a test that runs longer than the choice's five minutes does not lose it. The shell's clock is moved
    /// past the five minutes while the check runs and the timer ticks (as it does every few seconds): the choice stays,
    /// the answer is given, and the next attempt needs no new pick. Its five minutes start again when the attempt ends
    /// (by the same clock). A forget during the run still drops it, and so does a Lock all (the test above).
    #[test]
    fn a_test_longer_than_five_minutes_keeps_its_choice() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let bytes: Vec<u8> = (0..3 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
        ts.stored_file(s, g, "report.pdf", &bytes);
        let dest = secret_backup(&ts, s, g);
        let t0 = ts.clock.now();
        let minutes = |m: u64| Duration::from_secs(m * 60);

        // A wrong password that ran for six minutes (it reports no progress before it fails: the clock moves as the
        // operation begins): refused as wrong, the file still picked.
        let picked = pick(&ts, &dest);
        let (shell, clock) = (Arc::clone(&ts.shell), Arc::clone(&ts.clock));
        ts.events.during_next_busy(Box::new(move || {
            clock.set(t0 + minutes(6));
            shell.autolock.tick(t0 + minutes(6));
        }));
        let answer = test_with(&ts, &picked, typed("another long password"));
        assert!(
            matches!(&answer, Err(ShellError::Core(view)) if view.kind == "wrong_password"),
            "{:?}",
            answer.as_ref().err()
        );
        assert_eq!(ts.clock.now(), t0 + minutes(6), "the run moved the clock");
        // Its five minutes began again when the attempt ended, by the shell's clock.
        let pending = ts.shell.sessions.pending();
        pending.sweep_at(t0 + minutes(6 + 4));
        assert_eq!(
            done(test_with(&ts, &picked, typed(TEST_PASSWORD)).unwrap()).files,
            1,
            "the retry needs no new pick"
        );

        // A Stop after another twenty minutes keeps it too.
        let picked = pick(&ts, &dest);
        let (shell, clock, flag) = (
            Arc::clone(&ts.shell),
            Arc::clone(&ts.clock),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        );
        ts.events.watch(move |name, payload| {
            if name == crate::shell::PROGRESS_EVENT && !flag.swap(true, Ordering::SeqCst) {
                clock.set(t0 + minutes(30));
                shell.autolock.tick(t0 + minutes(30));
                let operation = OperationId(payload["operation"].as_u64().unwrap());
                let scope: JobScope = serde_json::from_value(payload["scope"].clone()).unwrap();
                shell.autolock.cancel_operation(operation, scope).unwrap();
            }
        });
        let answer = test_with(&ts, &picked, typed(TEST_PASSWORD));
        ts.events.watch(|_, _| {});
        assert_eq!(answer.err(), Some(ShellError::Cancelled));
        assert_eq!(
            done(test_with(&ts, &picked, typed(TEST_PASSWORD)).unwrap()).files,
            1,
            "a stopped test that ran long keeps the pick"
        );

        // A forget during the run still drops it: the answer comes, and the choice is gone.
        let picked = pick(&ts, &dest);
        let (shell, clock, flag, choice) = (
            Arc::clone(&ts.shell),
            Arc::clone(&ts.clock),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            picked.choice.clone(),
        );
        ts.events.watch(move |name, _| {
            if name == crate::shell::PROGRESS_EVENT && !flag.swap(true, Ordering::SeqCst) {
                clock.set(t0 + minutes(60));
                shell.autolock.tick(t0 + minutes(60));
                shell.forget_test_backup(&choice).unwrap();
            }
        });
        let answer = test_with(&ts, &picked, typed(TEST_PASSWORD));
        ts.events.watch(|_, _| {});
        assert_eq!(done(answer.unwrap()).files, 1);
        assert_eq!(test_with(&ts, &picked, typed(TEST_PASSWORD)).err(), EXPIRED);
    }

    /// Picking another forgets the choice sent with it; a closed picker leaves it as it was.
    #[test]
    fn a_new_pick_forgets_the_old_choice() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let first = secret_backup(&ts, s, g);
        let second = backup_file(&ts, "second.lockbox-backup");
        back_up(&ts, s, g, &second);
        // Each backup's own offer to be tested is held too.
        let base = ts.shell.sessions.pending().len();
        let old = pick(&ts, &first);

        ts.dialogs.answer(None);
        assert!(matches!(
            ts.shell.test_backup_pick(Some(&old.choice)),
            Ok(Outcome::Dismissed)
        ));
        assert_eq!(
            done(test_with(&ts, &old, typed(TEST_PASSWORD)).unwrap()).items,
            0
        );

        ts.dialogs.answer(Some(second.clone()));
        let new = done(ts.shell.test_backup_pick(Some(&old.choice)).unwrap());
        assert_eq!(new.file_name, "second.lockbox-backup");
        assert_eq!(new.size, fs::metadata(&second).unwrap().len());
        assert_ne!(
            serde_json::to_value(&new.choice).unwrap(),
            serde_json::to_value(&old.choice).unwrap()
        );
        assert_eq!(test_with(&ts, &old, typed(TEST_PASSWORD)).err(), EXPIRED);
        assert_eq!(
            done(test_with(&ts, &new, typed(TEST_PASSWORD)).unwrap()).items,
            0
        );
        assert_eq!(ts.shell.sessions.pending().len(), base + 1);
    }

    /// A published backup offers its own held choice (22c's "Test this backup"): its name and size, tested with no
    /// picker. A backup that was not written holds nothing.
    #[test]
    fn a_finished_backup_offers_its_own_test_choice() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "report.pdf", b"report");
        let folder = ts.folder("Backups");
        let dest = folder.join("family.lockbox-backup");
        let opened = ts.dialogs.opened();
        let view = back_up(&ts, s, g, &dest);
        assert_eq!(view.test.file_name, "family.lockbox-backup");
        assert_eq!(view.test.size, fs::metadata(&dest).unwrap().len());
        assert_eq!(view.test.size, view.size_on_disk);
        let json = serde_json::to_value(&view).unwrap();
        assert_eq!(json["test"]["file_name"], "family.lockbox-backup");
        assert!(
            json["test"]["choice"]
                .as_str()
                .is_some_and(|t| t.len() == 32)
        );

        let opened_after_backup = ts.dialogs.opened();
        assert_eq!(opened_after_backup, opened + 1, "only the save dialog");
        let found = done(test_with(&ts, &view.test, typed(TEST_PASSWORD)).unwrap());
        assert_eq!((found.items, found.files), (1, 1));
        assert_eq!(ts.dialogs.opened(), opened_after_backup, "no picker");
        // Kept after the answer, like any pick.
        assert_eq!(
            done(test_with(&ts, &view.test, typed(TEST_PASSWORD)).unwrap()).items,
            1
        );

        // Nothing is parked for a backup that was refused, dismissed or never written.
        let before = ts.shell.sessions.pending().len();
        ts.dialogs.answer(Some(folder.join("x.zip")));
        assert!(ts.shell.backup_vault(s, g, 1).is_err());
        ts.dialogs.answer(None);
        assert!(matches!(
            ts.shell.backup_vault(s, g, 1).unwrap().data,
            Outcome::Dismissed
        ));
        assert_eq!(ts.shell.sessions.pending().len(), before);
        // A lock of all vaults drops it like any held pick.
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert_eq!(
            test_with(&ts, &view.test, typed(TEST_PASSWORD)).err(),
            EXPIRED
        );
    }

    /// Testing needs no unlocked vault: with every vault locked, with a read-only copy open, and in a shell that has
    /// no session at all, the pick and the test answer.
    #[test]
    fn test_needs_no_unlocked_vault() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let dest = secret_backup(&ts, s, g);
        // A read-only copy open beside the vault.
        let (copy, _) = open_backup(&ts, &dest);
        assert_eq!(summary(&ts, &dest).items, 0);
        // Every vault locked (the copy too).
        ts.shell.sessions.lock_all(LockReason::Manual);
        let sessions = ts.shell.sessions.list();
        assert!(sessions.iter().any(|info| info.session == copy));
        assert!(
            sessions
                .iter()
                .all(|info| info.state != SessionState::Unlocked)
        );
        assert_eq!(summary(&ts, &dest).items, 0);

        // A shell with no session at all.
        let bare = TestShell::new();
        assert!(bare.shell.sessions.list().is_empty());
        assert_eq!(summary(&bare, &dest).items, 0);
    }

    /// `test_backup`'s job: a launch-scoped one in the epoch it began in, begun only once the work starts (not for a
    /// closed picker, a forgotten choice or a credential that cannot be read), with progress that ends at the total.
    #[test]
    fn test_backup_job_events_use_the_launch_scope() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let bytes: Vec<u8> = (0..3 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
        ts.stored_file(s, g, "report.pdf", &bytes);
        let dest = secret_backup(&ts, s, g);
        let before = ts.events.started().len();

        let picked = pick(&ts, &dest);
        let junk = CredentialArg::RecoveryKey(Zeroizing::new("not a key".into()));
        assert!(test_with(&ts, &picked, junk).is_err());
        let gone = pick(&ts, &dest);
        ts.shell.forget_test_backup(&gone.choice).unwrap();
        assert_eq!(test_with(&ts, &gone, typed(TEST_PASSWORD)).err(), EXPIRED);
        assert_eq!(ts.events.started().len(), before, "nothing started");

        let epoch = ts.shell.sessions.epoch();
        let found = heavy(|| {
            ts.shell
                .test_backup(&picked.choice, typed(TEST_PASSWORD), 9)
        });
        assert!(found.is_ok());
        let started = ts.events.started();
        assert_eq!(started.len(), before + 1);
        let started = &started[before];
        assert_eq!(started["request"], json!(9));
        assert_eq!(started["kind"], json!("test"));
        assert_eq!(
            started["scope"],
            json!({ "type": "launch", "epoch": epoch })
        );
        let operation = started["operation"].as_u64().unwrap();
        let progress: Vec<Value> = ts
            .events
            .progress()
            .into_iter()
            .filter(|event| event["operation"] == json!(operation))
            .collect();
        let (last, earlier) = progress.split_last().unwrap();
        assert!(earlier.iter().all(|e| e["finished"] == json!(false)));
        assert_eq!(last["finished"], json!(true));
        assert_eq!(last["done"], last["total"]);
        assert!(progress.iter().all(|e| e["kind"] == json!("test")));
    }

    /// The three commands take a token, a credential and the page's number: never a path, and nothing they do not
    /// name. A bad shape is the fixed malformed-request answer.
    #[test]
    fn test_backup_requests_are_strict() {
        let hex = "0123456789abcdef0123456789abcdef";
        let refuses_a_path = |body: Value, parses: &dyn Fn(Value) -> bool| {
            assert!(parses(body.clone()), "{body}");
            let mut sneaked = body;
            sneaked["path"] = json!("SENTINEL-7f3a");
            assert!(!parses(sneaked));
        };
        refuses_a_path(json!({ "choice": null }), &|body| {
            parse::<TestBackupPick>(&InvokeBody::Json(body)).is_ok()
        });
        refuses_a_path(json!({ "choice": hex }), &|body| {
            parse::<TestBackupPick>(&InvokeBody::Json(body)).is_ok()
        });
        refuses_a_path(
            json!({ "choice": hex, "credential": { "password_or_key": "x" }, "request": 4 }),
            &|body| parse::<TestBackupArgs>(&InvokeBody::Json(body)).is_ok(),
        );
        refuses_a_path(json!({ "choice": hex }), &|body| {
            parse::<ForgetTestBackup>(&InvokeBody::Json(body)).is_ok()
        });
        for bad in [
            json!({ "choice": "SENTINEL-7f3a", "credential": { "password": "x" }, "request": 4 }),
            json!({ "choice": hex.to_uppercase(), "credential": { "password": "x" }, "request": 4 }),
            json!({ "choice": null, "credential": { "password": "x" }, "request": 4 }),
            json!({ "credential": { "password": "x" }, "request": 4 }),
            json!({ "choice": hex, "request": 4 }),
            json!({ "choice": hex, "credential": { "password": "x" } }),
            json!({ "choice": hex, "credential": { "password": "x" }, "request": -1 }),
            json!({ "choice": hex, "credential": { "password": "x" }, "request": "4" }),
            json!({ "choice": hex, "credential": { "password_or_key": "x", "password": "y" }, "request": 4 }),
        ] {
            let refused = parse::<TestBackupArgs>(&InvokeBody::Json(bad.clone()));
            assert_eq!(refused.err(), Some(MALFORMED), "{bad}");
        }
        for bad in [json!({ "choice": 7 }), json!({ "choice": "x" })] {
            let refused = parse::<TestBackupPick>(&InvokeBody::Json(bad.clone()));
            assert_eq!(refused.err(), Some(MALFORMED), "{bad}");
        }
        // No choice yet is `null`, or left out (the first pick); a forget always names one.
        assert!(parse::<TestBackupPick>(&InvokeBody::Json(json!({}))).is_ok());
        for bad in [
            json!({}),
            json!({ "choice": null }),
            json!({ "choice": 7 }),
            json!({ "choice": "x" }),
        ] {
            let refused = parse::<ForgetTestBackup>(&InvokeBody::Json(bad.clone()));
            assert_eq!(refused.err(), Some(MALFORMED), "{bad}");
        }
    }

    /// The new box's shape is one more form of the credential, and the other callers refuse it: only `test_backup` tries
    /// a key and then a password.
    #[test]
    fn password_or_key_is_refused_by_the_other_callers() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let dest = secret_backup(&ts, s, g);
        ts.dialogs.answer(Some(dest));
        assert_eq!(
            ts.shell.open_backup_read_only(typed(TEST_PASSWORD)).err(),
            Some(ShellError::InvalidInput { what: "credential" })
        );
    }

    /// A lock of all vaults while the picker of "Open a backup" is open: `Locked`, and no session is opened.
    #[test]
    fn lock_during_open_backup_picker() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let dest = backup_file(&ts, "family.lockbox-backup");
        back_up(&ts, s, g, &dest);
        let shell = Arc::clone(&ts.shell);
        ts.dialogs.during_next_dialog(Box::new(move || {
            shell.sessions.lock_all(LockReason::Manual)
        }));
        ts.dialogs.answer(Some(dest));
        assert_eq!(
            heavy(|| ts.shell.open_backup_read_only(password())).err(),
            LOCKED
        );
        let sessions = ts.shell.sessions.list();
        assert_eq!(sessions.len(), 1, "only the vault is listed");
        assert_eq!(sessions[0].session, s);
        assert_eq!(sessions[0].state, SessionState::Locked);
    }

    /// A lock mid-backup: `Locked`, no temp left or recorded, and the backup file that was there is intact.
    #[test]
    fn lock_during_backup() {
        let ts = TestShell::new();
        // After the shell, so it drops first: an observer holds a clone of the shell, which would keep it open.
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "report.pdf", b"report");
        let dest = backup_file(&ts, "family.lockbox-backup");
        fs::write(&dest, b"old backup").unwrap();
        let shell = Arc::clone(&ts.shell);
        // The engine's last step before the rename.
        failpoint::observe(
            "backup.before_publish",
            Box::new(move || shell.sessions.lock_all(LockReason::Manual)),
        );
        ts.dialogs.answer(Some(dest.clone()));
        assert_eq!(ts.shell.backup_vault(s, g, 1).err(), LOCKED);
        assert_eq!(fs::read(&dest).unwrap(), b"old backup");
        assert_eq!(names(dest.parent().unwrap()), ["family.lockbox-backup"]);
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    /// M4: a backup that lacks some of an item's files: copying it out asks first with their names (in the item's
    /// order), copies nothing; sent again with `skip_missing` it copies the rest and lists the names left out.
    #[test]
    fn copy_out_with_missing_files_asks_then_lists() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let (id, first) = ts.stored_file(s, g, "a-first.bin", b"first");
        let second = attach(&ts, s, g, &id, "b-second.bin", b"second");
        let third = attach(&ts, s, g, &id, "c-third.bin", b"third");
        let files = vault_dir(&ts).join("files");
        fs::remove_file(files.join(format!("{first}.blob"))).unwrap();
        fs::remove_file(files.join(format!("{third}.blob"))).unwrap();
        let dest = backup_file(&ts, "family.lockbox-backup");
        let view = back_up(&ts, s, g, &dest);
        assert_eq!((view.items, view.files, view.missing_files), (1, 1, 2));
        let (bs, bg) = open_backup(&ts, &dest);

        let before = names(&files);
        let asked = ts.shell.copy_item_to(bs, bg, &id, s, g, false).unwrap();
        assert_eq!((asked.session, asked.generation), (s, g));
        let Outcome::Confirm(Confirm::MissingFiles { names: missing }) = asked.data else {
            panic!("not asked about the missing files");
        };
        assert_eq!(missing, ["a-first.bin", "c-third.bin"]);
        assert_eq!(titles(&ts, s, g), ["a-first.bin"], "nothing copied");
        assert_eq!(names(&files), before);

        let copied = ts.shell.copy_item_to(bs, bg, &id, s, g, true).unwrap();
        assert_eq!((copied.session, copied.generation), (s, g));
        let copied = done(copied.data);
        assert_eq!(copied.left_out, ["a-first.bin", "c-third.bin"]);
        assert_ne!(copied.id, id);
        let detail = ts.shell.get_item(s, g, &copied.id).unwrap().data;
        let kept: Vec<&str> = detail
            .summary
            .attachments
            .iter()
            .map(|file| file.name.as_str())
            .collect();
        assert_eq!(kept, ["b-second.bin"]);
        assert_eq!(detail.summary.attachments[0].file_id.len(), 32);
        assert_ne!(
            detail.summary.attachments[0].file_id, second,
            "a new file ID"
        );
        let busy = ts.events.busy();
        assert!(busy.contains(&(Some(s), vec!["copy_item"])), "{busy:?}");
    }

    /// The backup's session locks while the copy runs: `Locked`, no blob of the copy left, no item added, and the
    /// destination vault itself still open.
    #[test]
    fn copy_out_stops_when_the_backup_locks() {
        let ts = TestShell::new();
        // After the shell, so it drops first: an observer holds a clone of the shell, which would keep it open.
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let bytes: Vec<u8> = (0..3 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
        let (id, _) = ts.stored_file(s, g, "report.pdf", &bytes);
        let dest = backup_file(&ts, "family.lockbox-backup");
        back_up(&ts, s, g, &dest);
        let (bs, bg) = open_backup(&ts, &dest);
        let files = vault_dir(&ts).join("files");
        let before = names(&files);

        let shell = Arc::clone(&ts.shell);
        // After the copy's files are written, before its item is.
        failpoint::observe(
            "copy.before_commit",
            Box::new(move || shell.sessions.lock(bs, LockReason::Manual)),
        );
        assert_eq!(
            ts.shell.copy_item_to(bs, bg, &id, s, g, false).err(),
            LOCKED
        );
        assert_eq!(names(&files), before, "no blob of the copy left");
        assert_eq!(titles(&ts, s, g), ["report.pdf"], "no item added");
        let states: Vec<_> = ts
            .shell
            .sessions
            .list()
            .into_iter()
            .map(|i| i.state)
            .collect();
        assert_eq!(states, [SessionState::Unlocked, SessionState::Locked]);
    }

    /// A read-only backup session and the live vault it came from, both usable at once; locking one leaves the other;
    /// the backup refuses writes and cannot itself be backed up; a closed dialog opens nothing.
    #[test]
    fn sessions_for_backup_and_live_vault_coexist() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "report.pdf", b"report");
        let dest = backup_file(&ts, "family.lockbox-backup");
        back_up(&ts, s, g, &dest);

        let closed = ts.shell.open_backup_read_only(password());
        assert!(matches!(closed, Ok(Outcome::Dismissed)));
        assert_eq!(ts.shell.sessions.list().len(), 1, "nothing opened");

        let (bs, bg) = open_backup(&ts, &dest);
        assert_ne!(bs, s);
        assert_eq!(titles(&ts, bs, bg), ["report.pdf"]);
        assert_eq!(titles(&ts, s, g), ["report.pdf"]);
        // The same backup again is the same session.
        ts.dialogs.answer(Some(dest.clone()));
        let again = done(ts.shell.open_backup_read_only(password()).unwrap());
        assert_eq!((again.session, again.generation), (bs, bg));

        // The live vault takes a change; the backup refuses one, and a backup of itself, before any dialog.
        ts.shell
            .new_item(s, g, NewKind::Note, "Note".into(), None, None)
            .unwrap();
        assert_eq!(
            ts.shell
                .new_item(bs, bg, NewKind::Note, "Note".into(), None, None)
                .err(),
            Some(ShellError::ReadOnly)
        );
        let opened = ts.dialogs.opened();
        assert_eq!(
            ts.shell.backup_vault(bs, bg, 1).err(),
            Some(ShellError::ReadOnly)
        );
        assert_eq!(ts.dialogs.opened(), opened);

        ts.shell.sessions.lock(bs, LockReason::Manual);
        assert_eq!(titles(&ts, s, g), ["Note", "report.pdf"]);
        assert_eq!(ts.shell.list_items(bs, bg).err(), LOCKED);
    }

    /// The size shown is the file's size on disk: the same in the backup's own answer and in testing it, and not the
    /// engine's count of content.
    #[test]
    fn sizes_shown_are_size_on_disk() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "report.pdf", &vec![7u8; 200_000]);
        let dest = backup_file(&ts, "family.lockbox-backup");
        let view = back_up(&ts, s, g, &dest);
        let on_disk = fs::metadata(&dest).unwrap().len();
        assert_eq!(view.size_on_disk, on_disk);
        assert_eq!(summary(&ts, &dest).size_on_disk, on_disk);
        let content = heavy(|| {
            verify_backup(
                &dest,
                Credential::Password(TEST_PASSWORD),
                &CancelToken::new(),
                &NoProgress,
            )
        })
        .unwrap()
        .bytes;
        assert_ne!(content, on_disk, "not the engine's content bytes");
    }

    /// One damaged item, one damaged file and one missing file are each counted once, in their own field.
    #[test]
    fn backup_view_counts_each_kind() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "good.bin", b"good");
        let (damaged_item, _) = ts.stored_file(s, g, "damaged item.bin", b"item");
        let (_, damaged_file) = ts.stored_file(s, g, "damaged file.bin", &vec![1u8; 2 << 20]);
        let (_, missing_file) = ts.stored_file(s, g, "missing file.bin", b"gone");
        let dir = vault_dir(&ts);
        let item_file = dir.join("items").join(format!("{damaged_item}.item"));
        flip_byte(&item_file, fs::metadata(&item_file).unwrap().len() / 2).unwrap();
        flip_byte(
            &dir.join("files").join(format!("{damaged_file}.blob")),
            (1 << 20) + 100,
        )
        .unwrap();
        fs::remove_file(dir.join("files").join(format!("{missing_file}.blob"))).unwrap();

        let dest = backup_file(&ts, "family.lockbox-backup");
        let view = back_up(&ts, s, g, &dest);
        assert_eq!(
            (
                view.items,
                view.files,
                view.damaged_items,
                view.damaged_files,
                view.missing_files
            ),
            (3, 1, 1, 1, 1)
        );
        let json = serde_json::to_value(&view).unwrap();
        assert_eq!(json["damaged_items"], 1);
        assert_eq!(json["damaged_files"], 1);
        assert_eq!(json["missing_files"], 1);
        // Testing the backup counts every attached file it lacks: the missing one and the damaged one left out.
        assert_eq!(summary(&ts, &dest).missing_files, 2);
    }

    /// The credential is one argument with two shapes; anything else is the fixed malformed-request answer, which
    /// quotes nothing.
    #[test]
    fn credential_argument_shapes() {
        let ok = |body: Value| parse::<CredentialOnly>(&InvokeBody::Json(body)).is_ok();
        assert!(ok(json!({ "credential": { "password": "pw" } })));
        assert!(ok(json!({ "credential": { "recovery_key": "key" } })));
        assert!(ok(json!({ "credential": { "password_or_key": "text" } })));
        for bad in [
            json!({ "credential": { "password_or_key": "text", "password": "pw" } }),
            json!({ "credential": { "password_or_key": 7 } }),
            json!({ "credential": { "passwordOrKey": "text" } }),
            json!({ "credential": { "password": "pw", "recovery_key": "key" } }),
            json!({ "credential": {} }),
            json!({ "credential": { "password": "pw", "path": "SENTINEL-7f3a" } }),
            json!({ "credential": { "token": "SENTINEL-7f3a" } }),
            json!({ "credential": { "password": 7 } }),
            json!({ "credential": "SENTINEL-7f3a" }),
            json!({ "password": "SENTINEL-7f3a" }),
            json!({ "credential": { "password": "pw" }, "path": "SENTINEL-7f3a" }),
        ] {
            let refused = parse::<CredentialOnly>(&InvokeBody::Json(bad.clone()));
            assert_eq!(refused.err(), Some(MALFORMED), "{bad}");
        }
    }

    #[test]
    fn request_with_a_path_field_refused() {
        let id = "0123456789abcdef0123456789abcdef";
        let refuses_a_path = |body: Value, parses: &dyn Fn(Value) -> bool| {
            assert!(parses(body.clone()), "{body}");
            let mut sneaked = body;
            sneaked["path"] = json!("SENTINEL-7f3a");
            assert!(!parses(sneaked));
        };
        refuses_a_path(
            json!({ "session": 1, "generation": 1, "request": 7 }),
            &|body| parse::<BackupVault>(&InvokeBody::Json(body)).is_ok(),
        );
        refuses_a_path(json!({ "session": 1, "generation": 1 }), &|body| {
            parse::<BackupDueArgs>(&InvokeBody::Json(body)).is_ok()
        });
        // The page's number is required for a backup (a job it can Stop), and no backup's due date takes one.
        for bad in [
            json!({ "session": 1, "generation": 1 }),
            json!({ "session": 1, "generation": 1, "request": -1 }),
            json!({ "session": 1, "generation": 1, "request": "7" }),
        ] {
            let refused = parse::<BackupVault>(&InvokeBody::Json(bad.clone()));
            assert_eq!(refused.err(), Some(MALFORMED), "{bad}");
        }
        let refused = parse::<BackupDueArgs>(&InvokeBody::Json(
            json!({ "session": 1, "generation": 1, "request": 7 }),
        ));
        assert_eq!(refused.err(), Some(MALFORMED));
        refuses_a_path(
            json!({
                "from": 1, "from_generation": 1, "id": id, "to": 2, "to_generation": 1, "skip_missing": false
            }),
            &|body| parse::<CopyItemTo>(&InvokeBody::Json(body)).is_ok(),
        );
    }

    /// The restore commands take IDs, tokens, flags, a credential and a destination name: never a path, and nothing
    /// they do not name. A bad shape is the fixed malformed-request answer, which quotes nothing.
    #[test]
    fn restore_requests_are_strict() {
        let hex = "0123456789abcdef0123456789abcdef";
        let password = json!({ "password": "pw" });
        let refuses_a_path = |body: Value, parses: &dyn Fn(Value) -> bool| {
            assert!(parses(body.clone()), "{body}");
            let mut sneaked = body;
            sneaked["path"] = json!("SENTINEL-7f3a");
            assert!(!parses(sneaked));
        };
        let one_box = json!({ "password_or_key": "pw" });
        refuses_a_path(json!({ "choice": null }), &|body| {
            parse::<RestorePickArgs>(&InvokeBody::Json(body)).is_ok()
        });
        refuses_a_path(json!({ "choice": hex }), &|body| {
            parse::<RestorePickArgs>(&InvokeBody::Json(body)).is_ok()
        });
        refuses_a_path(json!({ "choice": hex, "credential": one_box }), &|body| {
            parse::<RestoreCheckArgs>(&InvokeBody::Json(body)).is_ok()
        });
        refuses_a_path(json!({ "choice": hex }), &|body| {
            parse::<ChooseRestoreFolder>(&InvokeBody::Json(body)).is_ok()
        });
        refuses_a_path(json!({ "choice": hex, "request": 4 }), &|body| {
            parse::<RestorePrepare>(&InvokeBody::Json(body)).is_ok()
        });
        refuses_a_path(json!({ "choice": hex }), &|body| {
            parse::<ForgetRestorePick>(&InvokeBody::Json(body)).is_ok()
        });
        refuses_a_path(
            json!({ "token": hex, "name": null, "request": 4 }),
            &|body| parse::<RestorePrepareConfirm>(&InvokeBody::Json(body)).is_ok(),
        );
        refuses_a_path(
            json!({ "token": hex, "name": "Clients (restored)", "request": 4 }),
            &|body| parse::<RestorePrepareConfirm>(&InvokeBody::Json(body)).is_ok(),
        );
        refuses_a_path(json!({ "restore": 4, "request": 5 }), &|body| {
            parse::<RestoreCommit>(&InvokeBody::Json(body)).is_ok()
        });
        refuses_a_path(json!({ "restore": 4 }), &|body| {
            parse::<RestoreArg>(&InvokeBody::Json(body)).is_ok()
        });
        refuses_a_path(json!({ "confirm": true }), &|body| {
            parse::<DismissRestore>(&InvokeBody::Json(body)).is_ok()
        });
        refuses_a_path(json!({ "id": 2, "confirm": false }), &|body| {
            parse::<DeletePreRestore>(&InvokeBody::Json(body)).is_ok()
        });
        refuses_a_path(json!({ "id": 2, "credential": password }), &|body| {
            parse::<OpenPreRestore>(&InvokeBody::Json(body)).is_ok()
        });
        // An older copy opens with the one box too.
        assert!(
            parse::<OpenPreRestore>(&InvokeBody::Json(json!({ "id": 2, "credential": one_box })))
                .is_ok()
        );
        // The copy takes the held pick and the page's number: the credential and the folder are in Rust already, so
        // neither is accepted again, and neither is a destination or a path.
        for bad in [
            json!({ "choice": hex }),
            json!({ "request": 4 }),
            json!({ "choice": null, "request": 4 }),
            json!({ "choice": "SENTINEL-7f3a", "request": 4 }),
            json!({ "choice": hex, "request": -1 }),
            json!({ "choice": hex, "request": "4" }),
            json!({ "choice": hex, "request": 4, "credential": password }),
            json!({ "choice": hex, "request": 4, "destination": "same_vault" }),
            json!({ "choice": hex, "request": 4, "destination": { "new_folder": "x" } }),
        ] {
            let refused = parse::<RestorePrepare>(&InvokeBody::Json(bad.clone()));
            assert_eq!(refused.err(), Some(MALFORMED), "{bad}");
        }
        // The check takes a token and one credential: a password, a key, or the one box; not two, and not none.
        for good in [
            json!({ "password": "pw" }),
            json!({ "recovery_key": "k" }),
            json!({ "password_or_key": "pw" }),
        ] {
            let body = json!({ "choice": hex, "credential": good });
            assert!(parse::<RestoreCheckArgs>(&InvokeBody::Json(body)).is_ok());
        }
        for bad in [
            json!({ "choice": hex }),
            json!({ "credential": one_box }),
            json!({ "choice": null, "credential": one_box }),
            json!({ "choice": "SENTINEL-7f3a", "credential": one_box }),
            json!({ "choice": hex, "credential": { "password_or_key": "x", "password": "y" } }),
            json!({ "choice": hex, "credential": one_box, "request": 4 }),
        ] {
            let refused = parse::<RestoreCheckArgs>(&InvokeBody::Json(bad.clone()));
            assert_eq!(refused.err(), Some(MALFORMED), "{bad}");
        }
        // The folder and the forget name a held pick: always one, never none.
        for bad in [
            json!({}),
            json!({ "choice": null }),
            json!({ "choice": 7 }),
            json!({ "choice": "x" }),
        ] {
            let refused = parse::<ChooseRestoreFolder>(&InvokeBody::Json(bad.clone()));
            assert_eq!(refused.err(), Some(MALFORMED), "{bad}");
            let refused = parse::<ForgetRestorePick>(&InvokeBody::Json(bad.clone()));
            assert_eq!(refused.err(), Some(MALFORMED), "{bad}");
        }
        // The first pick has no choice yet: `null`, or left out.
        assert!(parse::<RestorePickArgs>(&InvokeBody::Json(json!({}))).is_ok());
        for bad in [json!({ "choice": 7 }), json!({ "choice": "x" })] {
            let refused = parse::<RestorePickArgs>(&InvokeBody::Json(bad.clone()));
            assert_eq!(refused.err(), Some(MALFORMED), "{bad}");
        }
        // A token is exactly 32 lowercase hex characters, and the answer's name is text or nothing.
        for bad in [
            json!({ "token": "SENTINEL-7f3a", "name": null, "request": 4 }),
            json!({ "token": hex.to_uppercase(), "name": null, "request": 4 }),
            json!({ "token": hex, "name": 5, "request": 4 }),
            json!({ "token": hex, "name": null }),
            json!({ "name": "x", "request": 4 }),
        ] {
            let refused = parse::<RestorePrepareConfirm>(&InvokeBody::Json(bad.clone()));
            assert_eq!(refused.err(), Some(MALFORMED), "{bad}");
        }
        // The swap takes the restore's number and the page's; the discard takes the number only.
        for bad in [
            json!({ "restore": -1, "request": 5 }),
            json!({ "restore": "4", "request": 5 }),
            json!({ "restore": 4 }),
            json!({ "request": 5 }),
            json!({}),
        ] {
            let refused = parse::<RestoreCommit>(&InvokeBody::Json(bad.clone()));
            assert_eq!(refused.err(), Some(MALFORMED), "{bad}");
        }
        for bad in [
            json!({ "restore": -1 }),
            json!({ "restore": "4" }),
            json!({ "restore": 4, "request": 5 }),
            json!({}),
        ] {
            let refused = parse::<RestoreArg>(&InvokeBody::Json(bad.clone()));
            assert_eq!(refused.err(), Some(MALFORMED), "{bad}");
        }
    }

    fn wrong_password() -> ShellError {
        lockbox_core::CoreError::WrongPassword.into()
    }

    // ---- Task 3: the job, the date, the refusals, the reminder ----

    /// 2026-11-16T12:00:00Z: the wall clock of these tests until one moves it.
    const NOW: u64 = 1_794_830_400;
    const DAY: u64 = 86_400;

    fn wall(ts: &TestShell, secs: u64) {
        ts.clock.set_wall(UNIX_EPOCH + Duration::from_secs(secs));
    }

    fn last_backup(ts: &TestShell) -> Option<String> {
        ts.shell.vault_state.last_backup(&vault_dir(ts))
    }

    fn due(ts: &TestShell, s: SessionId, g: u64) -> Option<u32> {
        ts.shell
            .vault_backup_due(s, g)
            .unwrap()
            .data
            .map(|d| d.days)
    }

    /// The vault folder's header, as written when the vault was made.
    fn header_of(dir: &Path) -> VaultHeader {
        parse_header(&fs::read(dir.join(HEADER_FILE)).unwrap()).unwrap()
    }

    fn edit_header(dir: &Path, edit: impl FnOnce(&mut VaultHeader)) {
        let mut header = header_of(dir);
        edit(&mut header);
        fs::write(dir.join(HEADER_FILE), serialize_header(&header)).unwrap();
    }

    /// A new vault "Family" in the test's vaults folder, closed again: its canonical folder and recovery secret.
    fn closed_vault(ts: &TestShell) -> (PathBuf, RecoverySecret) {
        let created =
            heavy(|| lockbox_core::Vault::create(&ts.vaults(), "Family", TEST_PASSWORD)).unwrap();
        let dir = fs::canonicalize(created.vault.dir()).unwrap();
        let recovery = created.recovery;
        drop(created.vault);
        (dir, recovery)
    }

    /// `vault`, unlocked through the engine, as the shell's writable session at its folder.
    fn session_over(ts: &TestShell, vault: lockbox_core::Vault) -> (SessionId, u64) {
        let location = Location::folder(vault.dir()).unwrap();
        let opened = ts.shell.sessions.open(Some(location.clone()), None, |_| {
            Ok(OpenStep::Session(location, Opened::Writable(vault), ()))
        });
        let Ok(Outcome::Done(tagged)) = opened else {
            panic!("the session did not open");
        };
        (tagged.session, tagged.generation)
    }

    /// Opens the closed vault in `dir` with its password, through the engine.
    fn by_password(ts: &TestShell, dir: &Path) -> (SessionId, u64) {
        let (vault, _) =
            heavy(|| lockbox_core::Vault::unlock_with_password(dir, TEST_PASSWORD)).unwrap();
        session_over(ts, vault)
    }

    /// The wire form of a refusal.
    fn wire(error: ShellError) -> Value {
        serde_json::to_value(error).unwrap()
    }

    /// How many job events and busy announcements the shell has sent so far: a job that registered would add to them.
    fn job_marks(ts: &TestShell) -> (usize, usize, usize) {
        (
            ts.events.started().len(),
            ts.events.progress().len(),
            ts.events.busy().len(),
        )
    }

    /// Asks for a backup into a fresh folder and returns what it was refused with, after checking that nothing was
    /// written there, nothing was left in the output journal, no date was noted, and no job was started or registered
    /// (the page is told of none, and nothing paused the idle lock).
    fn refused_backup(ts: &TestShell, s: SessionId, g: u64, vault: &Path) -> ShellError {
        let folder = ts.folder("Refused");
        ts.dialogs
            .answer(Some(folder.join("family.lockbox-backup")));
        let before = job_marks(ts);
        let refused = ts.shell.backup_vault(s, g, 1).err().expect("refused");
        assert_eq!(
            job_marks(ts),
            before,
            "a refusal before writing starts no job"
        );
        assert!(names(&folder).is_empty(), "{:?}", names(&folder));
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
        assert_eq!(ts.shell.vault_state.last_backup(vault), None);
        refused
    }

    /// Spec 6.7 and the reminder: the date a backup finished is kept (RFC 3339, UTC, the shell's own clock) when the
    /// backup is published, and only then: a refused name, a closed dialog and a failed backup leave it as it was.
    #[test]
    fn backup_writes_the_last_backup_date_on_success_only() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let folder = ts.folder("Backups");
        let dest = folder.join("family.lockbox-backup");
        wall(&ts, NOW);
        assert_eq!(last_backup(&ts), None);

        ts.dialogs.answer(Some(folder.join("x.zip")));
        assert_eq!(ts.shell.backup_vault(s, g, 1).err(), Some(NOT_A_BACKUP));
        assert!(matches!(
            ts.shell.backup_vault(s, g, 2).unwrap().data,
            Outcome::Dismissed
        ));
        failpoint::arm("backup.before_publish");
        ts.dialogs.answer(Some(dest.clone()));
        assert!(ts.shell.backup_vault(s, g, 3).is_err());
        failpoint::disarm_all();
        assert_eq!(last_backup(&ts), None, "nothing finished");

        back_up(&ts, s, g, &dest);
        assert_eq!(last_backup(&ts).as_deref(), Some("2026-11-16T12:00:00Z"));
        let state: Value =
            serde_json::from_slice(&fs::read(&ts.shell.paths.vault_state).unwrap()).unwrap();
        assert_eq!(
            state["vaults"][0]["last_backup"],
            json!("2026-11-16T12:00:00Z")
        );

        // Forty days on: a failed backup keeps the first date, the next good one moves it.
        wall(&ts, NOW + 40 * DAY);
        failpoint::arm("backup.before_publish");
        ts.dialogs.answer(Some(dest.clone()));
        assert!(ts.shell.backup_vault(s, g, 4).is_err());
        failpoint::disarm_all();
        assert_eq!(last_backup(&ts).as_deref(), Some("2026-11-16T12:00:00Z"));
        back_up(&ts, s, g, &dest);
        assert_eq!(last_backup(&ts).as_deref(), Some("2026-12-26T12:00:00Z"));
    }

    /// The save dialog suggests `<vault name> <YYYY-MM-DD>.lockbox-backup`, the date being the person's own local day
    /// (not UTC's), and a name that is not safe as a file name is cleaned as it always was.
    #[test]
    fn backup_dialog_suggests_the_name_and_the_local_date() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        // 23:00 UTC on 2026-11-16 is already the 17th in a zone 14 hours east, and still the 16th 5 hours west.
        wall(&ts, NOW + 11 * 3600);
        ts.clock.set_utc_offset_hours(14);
        assert!(matches!(
            ts.shell.backup_vault(s, g, 1).unwrap().data,
            Outcome::Dismissed
        ));
        ts.clock.set_utc_offset_hours(-5);
        assert!(matches!(
            ts.shell.backup_vault(s, g, 2).unwrap().data,
            Outcome::Dismissed
        ));
        assert_eq!(
            ts.dialogs.suggested(),
            [
                "Family 2026-11-17.lockbox-backup",
                "Family 2026-11-16.lockbox-backup"
            ]
        );
        assert_eq!(ts.dialogs.titles(), ["Back up this vault"; 2]);
    }

    /// A date that cannot be saved does not turn a backup that is on disk into a failure: the person is told it
    /// finished, and the reminder simply shows again.
    #[test]
    fn a_note_that_cannot_be_saved_does_not_fail_a_finished_backup() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let dest = backup_file(&ts, "family.lockbox-backup");
        // Where the notes file should be, a folder: it cannot be read or replaced.
        let _ = fs::remove_file(&ts.shell.paths.vault_state);
        fs::create_dir(&ts.shell.paths.vault_state).unwrap();
        let view = back_up(&ts, s, g, &dest);
        assert_eq!(view.items, 0);
        assert!(dest.is_file());
        assert_eq!(last_backup(&ts), None);
    }

    /// A Stop while the backup runs: `Cancelled`, the backup file that was there byte for byte as it was, nothing else
    /// beside it (the hidden partial was there when it was stopped, and is gone), the output journal clear, no date
    /// noted, and the same session backs up afterwards. The page was told of the job by its own request.
    #[test]
    fn cancelled_backup_leaves_no_file_and_keeps_the_old_one() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let bytes: Vec<u8> = (0..4 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
        ts.stored_file(s, g, "report.pdf", &bytes);
        let folder = ts.folder("Backups");
        let dest = folder.join("family.lockbox-backup");
        fs::write(&dest, b"old backup").unwrap();

        let during = Arc::new(Mutex::new(None));
        let (shell, seen, watched) = (Arc::clone(&ts.shell), Arc::clone(&during), folder.clone());
        ts.events.watch(move |name, payload| {
            let done = payload["done"].as_u64().unwrap_or(0);
            if name != crate::shell::PROGRESS_EVENT
                || payload["finished"] != json!(false)
                || done == 0
                || seen.lock().unwrap().is_some()
            {
                return;
            }
            *seen.lock().unwrap() = Some(names(&watched));
            let operation = OperationId(payload["operation"].as_u64().unwrap());
            let scope: JobScope = serde_json::from_value(payload["scope"].clone()).unwrap();
            shell.autolock.cancel_operation(operation, scope).unwrap();
        });
        ts.dialogs.answer(Some(dest.clone()));
        let stopped = ts.shell.backup_vault(s, g, 61);
        assert_eq!(stopped.err(), Some(ShellError::Cancelled));

        let during = during.lock().unwrap().take().expect("stopped part-way");
        assert!(during.len() > 1, "no partial was being written: {during:?}");
        assert_eq!(fs::read(&dest).unwrap(), b"old backup");
        assert_eq!(names(&folder), ["family.lockbox-backup"]);
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
        assert_eq!(last_backup(&ts), None);
        let started = ts.events.started();
        assert_eq!(started.len(), 1);
        assert_eq!(started[0]["request"], json!(61));
        assert_eq!(started[0]["kind"], json!("backup"));
        let last = ts.events.progress().pop().unwrap();
        assert_eq!(last["finished"], json!(true));

        ts.events.watch(|_, _| {});
        let view = back_up(&ts, s, g, &dest);
        assert_eq!(view.files, 1);
        assert_ne!(fs::read(&dest).unwrap(), b"old backup");
    }

    /// A backup that fails after the work started (the last step before publishing) leaves no file and no temp, an
    /// output journal with nothing in it, no date, and the engine's own refusal as the answer.
    #[test]
    fn failed_backup_leaves_no_file() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "report.pdf", b"report");
        let folder = ts.folder("Backups");
        let dest = folder.join("family.lockbox-backup");
        failpoint::arm("backup.before_publish");
        ts.dialogs.answer(Some(dest.clone()));
        let failed = ts.shell.backup_vault(s, g, 1);
        failpoint::disarm_all();
        assert!(matches!(
            failed.err(),
            Some(ShellError::Core(view)) if view.kind == "io"
        ));
        assert!(names(&folder).is_empty(), "{:?}", names(&folder));
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
        assert_eq!(last_backup(&ts), None);
        let last = ts.events.progress().pop().unwrap();
        assert_eq!(last["finished"], json!(true));

        // And the same session backs up afterwards.
        assert_eq!(back_up(&ts, s, g, &dest).files, 1);
    }

    /// The four refusals the design words differently, each from a real engine state, each before anything is
    /// written: the changed header, the two key slots the copies disagree on, and "details couldn't be checked", which
    /// both a failed header write and a `vault.json` changed since the unlock end in.
    #[test]
    fn backup_refusal_says_which_case() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;

        // A header changed outside Lockbox, not yet accepted.
        let (dir, _) = closed_vault(&ts);
        edit_header(&dir, |h| h.name = "Renamed".to_owned());
        let (s, g) = by_password(&ts, &dir);
        let refused = refused_backup(&ts, s, g, &dir);
        assert_eq!(
            refused,
            ShellError::InvalidInput {
                what: "details changed"
            }
        );
        assert_eq!(
            wire(refused),
            json!({ "code": "invalid_input", "what": "details changed" })
        );
        ts.shell.sessions.lock_all(LockReason::Manual);

        // The copies disagree on the recovery key: a password unlock cannot check that slot.
        let (dir, _) = closed_vault(&ts);
        edit_header(&dir, |h| h.slots[1].ciphertext[0] ^= 1);
        let (s, g) = by_password(&ts, &dir);
        let refused = refused_backup(&ts, s, g, &dir);
        assert_eq!(
            refused,
            ShellError::InvalidInput {
                what: "recovery key copies disagree"
            }
        );
        assert_eq!(
            wire(refused),
            json!({ "code": "invalid_input", "what": "recovery key copies disagree" })
        );
        ts.shell.sessions.lock_all(LockReason::Manual);

        // The copies disagree on the password: a recovery unlock cannot check that slot.
        let (dir, recovery) = closed_vault(&ts);
        edit_header(&dir, |h| h.slots[0].ciphertext[0] ^= 1);
        let (vault, _) =
            heavy(|| lockbox_core::Vault::unlock_with_recovery(&dir, &recovery)).unwrap();
        let (s, g) = session_over(&ts, vault);
        let refused = refused_backup(&ts, s, g, &dir);
        assert_eq!(
            refused,
            ShellError::InvalidInput {
                what: "password copies disagree"
            }
        );
        assert_eq!(
            wire(refused),
            json!({ "code": "invalid_input", "what": "password copies disagree" })
        );
        ts.shell.sessions.lock_all(LockReason::Manual);

        // A failed header write left the state unknown: "details couldn't be checked".
        let (dir, _) = closed_vault(&ts);
        edit_header(&dir, |h| h.slots[0].ciphertext[0] ^= 1);
        failpoint::arm("unlock.repair_write");
        let (mut vault, _) =
            heavy(|| lockbox_core::Vault::unlock_with_password(&dir, TEST_PASSWORD)).unwrap();
        failpoint::disarm_all();
        failpoint::arm("write_headers.before_first");
        assert!(vault.change_password("a different long password").is_err());
        failpoint::disarm_all();
        let (s, g) = session_over(&ts, vault);
        let refused = refused_backup(&ts, s, g, &dir);
        assert_eq!(
            refused,
            ShellError::InvalidInput {
                what: "details unchecked"
            }
        );
        assert_eq!(
            wire(refused),
            json!({ "code": "invalid_input", "what": "details unchecked" })
        );
        ts.shell.sessions.lock_all(LockReason::Manual);

        // `vault.json` is no longer the header that was opened: the engine's "header changed on disk" is the same
        // case, with the same advice (lock and open again).
        let (dir, _) = closed_vault(&ts);
        let (s, g) = by_password(&ts, &dir);
        fs::write(dir.join(HEADER_FILE), b"not a header").unwrap();
        let refused = refused_backup(&ts, s, g, &dir);
        assert_eq!(
            refused,
            ShellError::InvalidInput {
                what: "details unchecked"
            }
        );
    }

    /// A refusal that is not one of the four is the engine's own, as today: a destination the engine cannot take is
    /// not turned into header advice.
    #[test]
    fn other_refusals_keep_their_own_form() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let dir = vault_dir(&ts);
        ts.dialogs.answer(Some(dir.join("inside.lockbox-backup")));
        let before = job_marks(&ts);
        let refused = ts.shell.backup_vault(s, g, 1).err();
        assert_eq!(
            refused.map(wire),
            Some(json!({
                "code": "core", "kind": "invalid_input", "what": "destination inside vault"
            }))
        );
        assert!(!dir.join("inside.lockbox-backup").exists());
        assert_eq!(job_marks(&ts), before, "refused before writing: no job");

        // A destination that is a folder, which could never be replaced, is refused the same way.
        let folder = ts.folder("Backups");
        fs::create_dir(folder.join("taken.lockbox-backup")).unwrap();
        ts.dialogs.answer(Some(folder.join("taken.lockbox-backup")));
        let refused = ts.shell.backup_vault(s, g, 2).err();
        assert_eq!(
            refused.map(wire),
            Some(json!({
                "code": "core", "kind": "invalid_input", "what": "destination not writable"
            }))
        );
        assert_eq!(job_marks(&ts), before, "refused before writing: no job");
    }

    /// `job-started` is sent only once the work starts: not for a closed dialog, a read-only session, a refused name
    /// or a stale session. A backup that runs sends it before its first progress event and before the answer, with its
    /// session and generation as the scope, and progress that ends at the total.
    #[test]
    fn backup_sends_job_started_only_once_the_work_starts() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let bytes: Vec<u8> = (0..3 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
        ts.stored_file(s, g, "report.pdf", &bytes);
        let folder = ts.folder("Backups");
        let dest = folder.join("family.lockbox-backup");
        // A backup that is open (read-only) stays open: the one that runs is written beside it.
        let (bs, bg) = {
            let opened = folder.join("opened.lockbox-backup");
            back_up(&ts, s, g, &opened);
            open_backup(&ts, &opened)
        };
        ts.events.watch(|_, _| {});
        let before = ts.events.started().len();

        assert!(matches!(
            ts.shell.backup_vault(s, g, 2).unwrap().data,
            Outcome::Dismissed
        ));
        assert_eq!(
            ts.shell.backup_vault(bs, bg, 3).err(),
            Some(ShellError::ReadOnly)
        );
        ts.dialogs.answer(Some(folder.join("x.zip")));
        assert_eq!(ts.shell.backup_vault(s, g, 4).err(), Some(NOT_A_BACKUP));
        assert_eq!(ts.shell.backup_vault(s, g + 1, 5).err(), LOCKED);
        assert_eq!(ts.events.started().len(), before, "nothing started");

        let answered = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let early = Arc::new(Mutex::new(Vec::new()));
        let (flag, seen) = (Arc::clone(&answered), Arc::clone(&early));
        ts.events.watch(move |name, _| {
            let after = flag.load(std::sync::atomic::Ordering::SeqCst);
            seen.lock().unwrap().push((name, after));
        });
        ts.dialogs.answer(Some(dest.clone()));
        let view = ts.shell.backup_vault(s, g, 6).unwrap();
        answered.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(matches!(view.data, Outcome::Done(_)));
        let seen = early.lock().unwrap().clone();
        assert_eq!(seen[0].0, crate::shell::JOB_STARTED_EVENT);
        assert!(
            seen[1..]
                .iter()
                .all(|(name, _)| *name == crate::shell::PROGRESS_EVENT)
        );
        assert!(seen.len() >= 3, "{seen:?}");
        assert!(seen.iter().all(|(_, after)| !after), "an event came late");

        let started = ts.events.started();
        let started = &started[before];
        assert_eq!(started["request"], json!(6));
        assert_eq!(started["kind"], json!("backup"));
        assert_eq!(
            started["scope"],
            json!({ "type": "session", "session": s.0, "generation": g })
        );
        let operation = started["operation"].as_u64().unwrap();
        let progress: Vec<Value> = ts
            .events
            .progress()
            .into_iter()
            .filter(|event| event["operation"] == json!(operation))
            .collect();
        let (last, earlier) = progress.split_last().unwrap();
        assert!(earlier.iter().all(|e| e["finished"] == json!(false)));
        assert_eq!(last["finished"], json!(true));
        assert_eq!(last["done"], last["total"]);
        assert!(progress.iter().all(|e| e["kind"] == json!("backup")));
    }

    /// Stale generation: `Locked`; a session that is not ours: `NotFound`; both before the dialog opens and before
    /// anything is started or written.
    #[test]
    fn backup_vault_refused_stale_and_foreign() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let dialogs = ts.dialogs.opened();
        let foreign = SessionId(s.0 + 100);
        assert_eq!(ts.shell.backup_vault(s, g + 1, 1).err(), LOCKED);
        assert_eq!(
            ts.shell.backup_vault(foreign, g, 1).err(),
            Some(ShellError::NotFound)
        );
        ts.shell.sessions.lock(s, LockReason::Manual);
        assert_eq!(ts.shell.backup_vault(s, g, 1).err(), LOCKED);
        assert_eq!(ts.dialogs.opened(), dialogs, "no dialog before the check");
        assert!(ts.events.started().is_empty());
    }

    /// A read-only session (a backup opened to look inside) has nothing of its own to back up: refused before the
    /// dialog, with nothing started.
    #[test]
    fn backup_on_read_only_refused() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let dest = backup_file(&ts, "family.lockbox-backup");
        back_up(&ts, s, g, &dest);
        let (bs, bg) = open_backup(&ts, &dest);
        let (opened, started) = (ts.dialogs.opened(), ts.events.started().len());
        ts.dialogs
            .answer(Some(backup_file(&ts, "again.lockbox-backup")));
        assert_eq!(
            ts.shell.backup_vault(bs, bg, 9).err(),
            Some(ShellError::ReadOnly)
        );
        assert_eq!(ts.dialogs.opened(), opened);
        assert_eq!(ts.events.started().len(), started);
        assert!(!backup_file(&ts, "again.lockbox-backup").exists());
    }

    /// Spec 6.7's reminder: due when the last backup, else the vault's creation, is 30 or more whole days ago. The
    /// stored date is the shell's own RFC 3339 text; one that cannot be read counts as no backup; one in the future
    /// (a clock set back) is not due.
    #[test]
    fn backup_due_after_30_days_or_from_creation() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let dir = vault_dir(&ts);
        let created = dates::parse_utc(&header_of(&dir).created_at).expect("the engine's own date");

        // From creation: never backed up.
        for (now, expected) in [
            (created, None),
            (created + 30 * DAY - 1, None),
            (created + 30 * DAY, Some(30)),
            (created + 31 * DAY + 5 * 3600, Some(31)),
            (created - 10, None),
        ] {
            wall(&ts, now);
            assert_eq!(due(&ts, s, g), expected, "{}", now - created);
        }
        wall(&ts, created + 31 * DAY);
        assert_eq!(
            serde_json::to_value(ts.shell.vault_backup_due(s, g).unwrap()).unwrap(),
            json!({ "session": s.0, "generation": g, "data": { "days": 31 } })
        );
        wall(&ts, created + 1);
        assert_eq!(
            serde_json::to_value(ts.shell.vault_backup_due(s, g).unwrap()).unwrap(),
            json!({ "session": s.0, "generation": g, "data": null })
        );

        // From the last backup, once there is one.
        let then = created + 100 * DAY;
        ts.shell
            .vault_state
            .set_last_backup(
                &dir,
                &dates::rfc3339_utc(UNIX_EPOCH + Duration::from_secs(then)),
            )
            .unwrap();
        for (now, expected) in [
            (then, None),
            (then + 29 * DAY + 86_399, None),
            (then + 30 * DAY, Some(30)),
            (then + 45 * DAY, Some(45)),
            (then - 5, None),
        ] {
            wall(&ts, now);
            assert_eq!(due(&ts, s, g), expected, "{}", now - then);
        }

        // A note that cannot be read counts as no backup: the reminder shows rather than hides.
        for unreadable in ["yesterday", "2026-11-06", "", "2026-11-06T09:30:00+02:00"] {
            ts.shell
                .vault_state
                .set_last_backup(&dir, unreadable)
                .unwrap();
            wall(&ts, created + 31 * DAY);
            assert_eq!(due(&ts, s, g), Some(31), "{unreadable:?}");
        }

        // A real backup moves it, through the same clock.
        wall(&ts, created + 50 * DAY);
        back_up(&ts, s, g, &backup_file(&ts, "family.lockbox-backup"));
        wall(&ts, created + 79 * DAY);
        assert_eq!(due(&ts, s, g), None);
        wall(&ts, created + 80 * DAY);
        assert_eq!(due(&ts, s, g), Some(30));
    }

    /// The reminder is asked about this session's own vault: another vault's backup does not count for it, and the
    /// newer of two vaults is not the one read.
    #[test]
    fn backup_due_reads_the_asked_vault() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let (other, go) = ts.open_vault("Work");
        let created = dates::parse_utc(&header_of(&vault_dir(&ts)).created_at).unwrap();
        wall(&ts, created + 40 * DAY);
        back_up(&ts, other, go, &backup_file(&ts, "work.lockbox-backup"));
        assert_eq!(due(&ts, other, go), None);
        assert_eq!(due(&ts, s, g), Some(40));
    }

    /// Stale generation: `Locked`; a session that is not ours: `NotFound`.
    #[test]
    fn backup_due_refused_stale_foreign() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        wall(&ts, NOW + 400 * DAY);
        assert!(due(&ts, s, g).is_some(), "due, so a refusal is the check");
        assert_eq!(ts.shell.vault_backup_due(s, g + 1).err(), LOCKED);
        assert_eq!(
            ts.shell.vault_backup_due(SessionId(s.0 + 100), g).err(),
            Some(ShellError::NotFound)
        );
        ts.shell.sessions.lock(s, LockReason::Manual);
        assert_eq!(ts.shell.vault_backup_due(s, g).err(), LOCKED);
    }

    /// A read-only session (a backup, a pre-restore folder) is never asked to back up: `null`, even when the live
    /// vault beside it is long overdue.
    #[test]
    fn backup_due_is_none_on_read_only() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let dest = backup_file(&ts, "family.lockbox-backup");
        back_up(&ts, s, g, &dest);
        let (bs, bg) = open_backup(&ts, &dest);
        wall(&ts, NOW + 400 * DAY);
        assert!(due(&ts, s, g).is_some(), "the live vault is overdue");
        assert_eq!(due(&ts, bs, bg), None);
    }

    /// Where the free space is known to be too little, the backup is refused before anything is written, with the
    /// numbers: what it needs (the margin the engine keeps free included, so it is always above what is there) and
    /// what the drive has, in the form 22d reads.
    #[test]
    fn backup_no_space_refused_before_writing_with_numbers() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let _volume = Volume;
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "report.pdf", &vec![7u8; 300_000]);
        let folder = ts.folder("Backups");
        let dest = folder.join("family.lockbox-backup");

        // With nothing free, the answer says what it needs.
        pretend_free(Some(0));
        ts.dialogs.answer(Some(dest.clone()));
        let Some(ShellError::Core(view)) = ts.shell.backup_vault(s, g, 1).err() else {
            panic!("not refused for space");
        };
        assert_eq!(view.kind, "not_enough_space");
        let needed = view.needed.unwrap();
        assert_eq!(view.available, Some(0));
        assert!(needed > 64 * 1024 * 1024, "the margin is in it: {needed}");
        assert_eq!(
            wire(ShellError::Core(view)),
            json!({ "code": "core", "kind": "not_enough_space", "needed": needed, "available": 0 })
        );

        // One byte short: refused, and "needs X, has Y" has X above Y. Nothing was written or kept.
        pretend_free(Some(needed - 1));
        ts.dialogs.answer(Some(dest.clone()));
        let Some(ShellError::Core(view)) = ts.shell.backup_vault(s, g, 2).err() else {
            panic!("not refused for space");
        };
        assert_eq!(
            (view.needed, view.available),
            (Some(needed), Some(needed - 1))
        );
        assert!(names(&folder).is_empty(), "{:?}", names(&folder));
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
        assert_eq!(last_backup(&ts), None);

        // Exactly what it said it needs: goes ahead.
        pretend_free(Some(needed));
        assert_eq!(back_up(&ts, s, g, &dest).files, 1);
        assert!(dest.is_file());
    }

    /// An insufficient-space refusal starts no job: the page is sent no `job-started` and no progress, no job is
    /// registered (nothing paused the idle lock), the refusal carries the numbers 22d shows, and the same call made
    /// again with room (another destination, as 22d's retry does) is a backup that starts its job under its own
    /// request. The page treats `job-started` as "the work began", so one sent for this refusal would show the
    /// "didn't finish" screen instead of 22d.
    #[test]
    fn backup_no_space_starts_no_job_and_a_retry_works() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let _volume = Volume;
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "report.pdf", &vec![7u8; 300_000]);
        let folder = ts.folder("Backups");
        let elsewhere = ts.folder("Other drive");
        ts.events.watch(|_, _| {});
        let before = job_marks(&ts);

        pretend_free(Some(1024));
        ts.dialogs
            .answer(Some(folder.join("family.lockbox-backup")));
        let Some(ShellError::Core(view)) = ts.shell.backup_vault(s, g, 7).err() else {
            panic!("not refused for space");
        };
        assert_eq!(view.kind, "not_enough_space");
        let needed = view.needed.unwrap();
        assert_eq!(view.available, Some(1024));
        assert!(needed > 64 * 1024 * 1024, "the margin is in it: {needed}");
        assert_eq!(
            job_marks(&ts),
            before,
            "no job-started, no progress, no job"
        );
        assert!(ts.events.job_events().is_empty());
        assert!(names(&folder).is_empty(), "{:?}", names(&folder));
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
        assert_eq!(last_backup(&ts), None);

        // The retry with room, the way 22d sends it: the same session, another destination.
        pretend_free(Some(needed));
        ts.dialogs
            .answer(Some(elsewhere.join("family.lockbox-backup")));
        let view = done(ts.shell.backup_vault(s, g, 8).unwrap().data);
        assert_eq!((view.items, view.files), (1, 1));
        assert!(elsewhere.join("family.lockbox-backup").is_file());
        let started = ts.events.started();
        assert_eq!(started.len(), 1, "only the backup that ran started a job");
        assert_eq!(started[0]["request"], json!(8));
        assert_eq!(started[0]["kind"], json!("backup"));
        assert!(last_backup(&ts).is_some());
    }

    /// A drive whose free space cannot be read is "unknown", and unknown never blocks: the backup runs.
    #[test]
    fn backup_unknown_free_space_goes_ahead() {
        let ts = TestShell::new();
        let _volume = Volume;
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "report.pdf", b"report");
        let dest = backup_file(&ts, "family.lockbox-backup");
        pretend_free(None);
        let view = back_up(&ts, s, g, &dest);
        assert_eq!((view.items, view.files), (1, 1));
        assert!(dest.is_file());
        assert!(last_backup(&ts).is_some());
    }

    /// Makes the engine see `free` bytes free on every drive (`None`: the drive's free space is unknown), on this
    /// thread only.
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
}
