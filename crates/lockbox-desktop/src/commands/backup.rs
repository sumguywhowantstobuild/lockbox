//! Backups in the shell (spec §6.7, §6.9, §7.4): back up an open vault, test a backup, open a backup read-only and
//! copy an item out of one into an open vault. Every file comes from a dialog Rust opens inside the command, outside
//! every lock; the page sends IDs and the typed credential only (§4.1).
//!
//! The restore commands are here too (their logic is in [`crate::restore`]). Nothing here puts a path, a name or an item's content in an error (R5): the views and
//! [`Confirm::MissingFiles`] may carry the user's own file names, as the other results do.

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use lockbox_core::blob::CancelToken;
use lockbox_core::ids::{FileId, ItemId};
use lockbox_core::recovery::RecoverySecret;
use lockbox_core::{BackupReport, Credential, ReadOnlyVault, verify_backup};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Request;
use zeroize::Zeroizing;

use super::{NoArgs, args, blocking};
use crate::error::{Confirm, Outcome, ShellError, ShellResult};
use crate::open::safe_name;
use crate::pending::Token;
use crate::restore::{
    DestinationArg, PreRestoreEntry, RestoreNotice, RestorePreparedView, RestoredView,
};
use crate::session::{Location, OpenStep, Opened, SessionId, SessionInfo, Tagged, VaultRef};
use crate::shell::Shell;

/// The long operations' names in `lockbox://busy`. The page shows "Backup in progress" for [`BACKUP`].
const BACKUP: &str = "backup";
const TEST_BACKUP: &str = "test_backup";
const COPY_ITEM: &str = "copy_item";

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
}

impl BackupView {
    fn of(report: BackupReport, size_on_disk: u64) -> BackupView {
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
        }
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

/// What the user typed to open a backup, in the two shapes the page sends: `{ "password": ".." }` or
/// `{ "recovery_key": ".." }`. Anything else (both, none, another field, another type) fails to parse, and the
/// command answers the fixed malformed-request refusal without quoting the input. No `Debug`: it holds a secret.
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialArg {
    Password(Zeroizing<String>),
    RecoveryKey(Zeroizing<String>),
}

/// A [`CredentialArg`] checked: the recovery key parsed (a typo or a wrong format is refused here).
pub(crate) enum Typed {
    Password(Zeroizing<String>),
    Recovery(RecoverySecret),
}

impl CredentialArg {
    pub(crate) fn typed(self) -> ShellResult<Typed> {
        Ok(match self {
            CredentialArg::Password(password) => Typed::Password(password),
            CredentialArg::RecoveryKey(key) => Typed::Recovery(RecoverySecret::parse(&key)?),
        })
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
    /// save dialog, outside every lock, suggesting the vault's name (`Dismissed` when closed); a name that does not
    /// end in `.lockbox-backup` (any case) is refused as `"backup extension"`, a place inside the state folder as
    /// `"state folder"`, both before anything is written. Then, in a long operation (writes answer `Busy` meanwhile):
    /// the engine's backup, its temp recorded in the output journal first and each rename attempt only while the
    /// session is still unlocked in `generation`. An existing backup file is touched only by the rename of a backup
    /// that has verified. A lock at any point answers `Locked`.
    pub fn backup_vault(
        &self,
        session: SessionId,
        generation: u64,
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
        let suggested = safe_name(&format!("{}{EXTENSION}", name.data));
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
                let _operation = self.autolock.begin(Some(session), BACKUP, cancel.clone());
                let journal = self.outputs.for_call(&self.sessions, session, generation);
                let report = journal.finish(vault.backup(&dest, &journal, cancel))?;
                let size_on_disk = fs::metadata(&dest)?.len();
                Ok(Outcome::Done(BackupView::of(report, size_on_disk)))
            })
    }

    /// Checks a backup the user picks, without restoring it (spec §6.7): the credential opens it, every entry and
    /// file is read and checked. The lock epoch is read before the dialog, so a lock of all vaults while the picker
    /// is open is not forgotten; a closed picker is still `Dismissed`, since it shows nothing. It runs as a long
    /// operation without a session. A lock of all vaults, or the app closing, is looked for as the operation
    /// begins (before the backup is read) and again after it has ended, its announcement included (a lock can land
    /// there): `Locked`, whatever was found. Writes nothing; a damaged output journal does not stop it.
    pub fn test_backup(
        &self,
        credential: CredentialArg,
    ) -> ShellResult<Outcome<BackupSummaryView>> {
        let epoch = self.sessions.epoch();
        let Some(backup) = self.os.dialogs.pick_file("Test a backup", Some(FILTER)) else {
            return Ok(Outcome::Dismissed);
        };
        let credential = credential.typed()?;
        let cancel = CancelToken::new();
        let operation = self.autolock.begin(None, TEST_BACKUP, cancel.clone());
        // A lock before this point left `cancel` fresh and uncancelled: nothing is read.
        if self.locked_since(epoch) {
            return Err(ShellError::Locked);
        }
        let verified = verify_backup(&backup, credential.credential(), &cancel);
        drop(credential);
        let checked = verified.map_err(ShellError::from).and_then(|found| {
            let size_on_disk = fs::metadata(&backup)?.len();
            Ok(BackupSummaryView {
                created_at: found.created_at,
                items: found.items,
                files: found.files,
                missing_files: found.missing_files,
                size_on_disk,
            })
        });
        // Ending the operation announces on `lockbox://busy`, where a lock can land: the last check comes after it.
        drop(operation);
        if self.locked_since(epoch) {
            return Err(ShellError::Locked);
        }
        checked.map(Outcome::Done)
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
                let vault =
                    ReadOnlyVault::open_backup(location.path(), credential.credential(), cancel)?;
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
                let _operation = self.autolock.begin(Some(to), COPY_ITEM, cancel.clone());
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
}

/// `test_backup` and `open_backup_read_only`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialOnly {
    credential: CredentialArg,
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
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.backup_vault(session, generation)).await
}

#[tauri::command]
pub(super) async fn test_backup(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Outcome<BackupSummaryView>> {
    let CredentialOnly { credential } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.test_backup(credential)).await
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

/// `restore_prepare`: the backup's credential, and where the vault goes.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RestorePrepare {
    credential: CredentialArg,
    destination: DestinationArg,
}

/// `restore_prepare_confirm`: the token of the question, and for a new folder its name.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RestorePrepareConfirm {
    token: Token,
    name: Option<String>,
}

/// `restore_commit` and `restore_discard`.
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
pub(super) async fn restore_prepare(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Outcome<RestorePreparedView>> {
    let RestorePrepare {
        credential,
        destination,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.restore_prepare(credential, destination)).await
}

#[tauri::command]
pub(super) async fn restore_prepare_confirm(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Outcome<RestorePreparedView>> {
    let RestorePrepareConfirm { token, name } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.restore_prepare_confirm(&token, name)).await
}

#[tauri::command]
pub(super) async fn restore_commit(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<RestoredView> {
    let RestoreArg { restore } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.restore_commit(restore)).await
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

    use lockbox_core::internals::fsio::failpoint;
    use lockbox_core::internals::fsio::testutil::{flip_byte, names};
    use serde_json::{Value, json};
    use tauri::ipc::InvokeBody;
    use zeroize::Zeroizing;

    use super::super::items::{ItemEdit, NewKind};
    use super::super::{MALFORMED, parse};
    use super::*;
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
        done(ts.shell.backup_vault(s, g).unwrap().data)
    }

    /// The backup in `dest` opened read-only: its session and generation.
    fn open_backup(ts: &TestShell, dest: &Path) -> (SessionId, u64) {
        ts.dialogs.answer(Some(dest.to_path_buf()));
        let opened = heavy(|| ts.shell.open_backup_read_only(password())).unwrap();
        let tagged = done(opened);
        assert!(tagged.data.read_only);
        (tagged.session, tagged.generation)
    }

    fn summary(ts: &TestShell, dest: &Path) -> BackupSummaryView {
        ts.dialogs.answer(Some(dest.to_path_buf()));
        done(heavy(|| ts.shell.test_backup(password())).unwrap())
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
                Ok(vault.attach_file(&id, &source, cancel)?.to_hex())
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
                let imported = shell.add_file(s, g, None).err();
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
            )
        })
        .unwrap();
        assert_eq!((held.items, held.files), (2, 1));
        assert_eq!(titles(&ts, s, g), ["Bank", "report.pdf"]);
        let busy = ts.events.busy();
        assert!(busy.contains(&(Some(s), vec![BACKUP])), "{busy:?}");
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
                ts.shell.backup_vault(s, g).err(),
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
            ts.shell.backup_vault(s, g).err(),
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
        let closed = ts.shell.backup_vault(s, g).unwrap();
        assert_eq!((closed.session, closed.generation), (s, g));
        assert!(matches!(closed.data, Outcome::Dismissed));

        // A damaged output journal: refused before the dialog.
        let opened = ts.dialogs.opened();
        fs::create_dir_all(&ts.shell.paths.root).unwrap();
        fs::write(&ts.shell.paths.outputs, b"not a journal").unwrap();
        assert!(matches!(
            ts.shell.backup_vault(s, g).err(),
            Some(ShellError::Core(view)) if view.kind == "damaged"
        ));
        assert_eq!(ts.dialogs.opened(), opened);
    }

    /// The typed credential opens the backup: the password, the recovery key; a wrong password is refused as one; a
    /// closed dialog does not look at the credential; a lock of all vaults while it runs, or the app closing, drops
    /// the answer.
    #[test]
    fn test_backup_needs_the_credential() {
        let ts = TestShell::new();
        // After the shell, so it drops first: an observer holds a clone of the shell, which would keep it open.
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "report.pdf", b"report");
        let key = ts.shell.regenerate_recovery(s, g).unwrap().data;
        let dest = backup_file(&ts, "family.lockbox-backup");
        back_up(&ts, s, g, &dest);

        let found = summary(&ts, &dest);
        assert_eq!((found.items, found.files, found.missing_files), (1, 1, 0));
        assert!(found.created_at.starts_with("20"), "{}", found.created_at);
        ts.dialogs.answer(Some(dest.clone()));
        let by_key = CredentialArg::RecoveryKey(key);
        let found = done(heavy(|| ts.shell.test_backup(by_key)).unwrap());
        assert_eq!(found.items, 1);

        ts.dialogs.answer(Some(dest.clone()));
        let wrong = CredentialArg::Password(Zeroizing::new("another long password".into()));
        let refused = heavy(|| ts.shell.test_backup(wrong)).err();
        assert_eq!(refused, Some(wrong_password()));
        // A recovery key that is no key at all is refused too.
        ts.dialogs.answer(Some(dest.clone()));
        let junk = CredentialArg::RecoveryKey(Zeroizing::new("not a key".into()));
        assert!(matches!(
            ts.shell.test_backup(junk).err(),
            Some(ShellError::Core(_))
        ));

        // A closed dialog: nothing looked at, not even a credential that could not be parsed.
        let junk = CredentialArg::RecoveryKey(Zeroizing::new("not a key".into()));
        assert!(matches!(ts.shell.test_backup(junk), Ok(Outcome::Dismissed)));

        // A lock of all vaults during the work (here as the operation begins): the answer is dropped.
        let shell = Arc::clone(&ts.shell);
        ts.events.during_next_busy(Box::new(move || {
            shell.sessions.lock_all(LockReason::Manual)
        }));
        ts.dialogs.answer(Some(dest.clone()));
        assert_eq!(heavy(|| ts.shell.test_backup(password())).err(), LOCKED);
        let busy = ts.events.busy();
        assert!(busy.contains(&(None, vec![TEST_BACKUP])), "{busy:?}");

        // The app closing: dropped too, even when the check itself would have passed.
        ts.shell.sessions.shut();
        ts.dialogs.answer(Some(dest.clone()));
        assert_eq!(heavy(|| ts.shell.test_backup(password())).err(), LOCKED);
    }

    /// A lock of all vaults while the picker of "Test a backup" is open: `Locked`, and the backup was never read (a
    /// credential that would be refused still answers `Locked`). A closed picker still answers `Dismissed`.
    #[test]
    fn lock_during_test_backup_picker() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let dest = backup_file(&ts, "family.lockbox-backup");
        back_up(&ts, s, g, &dest);
        let lock_in_picker = || {
            let shell = Arc::clone(&ts.shell);
            ts.dialogs.during_next_dialog(Box::new(move || {
                shell.sessions.lock_all(LockReason::Manual)
            }));
        };
        lock_in_picker();
        ts.dialogs.answer(Some(dest.clone()));
        let wrong = CredentialArg::Password(Zeroizing::new("another long password".into()));
        assert_eq!(ts.shell.test_backup(wrong).err(), LOCKED);

        lock_in_picker();
        assert!(matches!(
            ts.shell.test_backup(password()),
            Ok(Outcome::Dismissed)
        ));
    }

    /// A lock of all vaults in the announcement that ends the test (the `LongOp` dropping): `Locked`. The final
    /// check must come after the operation is dropped.
    #[test]
    fn lock_as_test_backup_ends() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let dest = backup_file(&ts, "family.lockbox-backup");
        back_up(&ts, s, g, &dest);
        let (events, shell) = (Arc::clone(&ts.events), Arc::clone(&ts.shell));
        // The first announcement is the start; the hook it leaves runs in the second, the end.
        ts.events.during_next_busy(Box::new(move || {
            events.during_next_busy(Box::new(move || {
                shell.sessions.lock_all(LockReason::Manual)
            }));
        }));
        ts.dialogs.answer(Some(dest));
        assert_eq!(heavy(|| ts.shell.test_backup(password())).err(), LOCKED);
        let busy = ts.events.busy();
        assert_eq!(busy.last(), Some(&(None, vec![])), "the end was announced");
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
        assert_eq!(ts.shell.backup_vault(s, g).err(), LOCKED);
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
        assert!(busy.contains(&(Some(s), vec![COPY_ITEM])), "{busy:?}");
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
            ts.shell.backup_vault(bs, bg).err(),
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
        for bad in [
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
        refuses_a_path(json!({ "session": 1, "generation": 1 }), &|body| {
            parse::<BackupVault>(&InvokeBody::Json(body)).is_ok()
        });
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
        refuses_a_path(
            json!({ "credential": password, "destination": "same_vault" }),
            &|body| parse::<RestorePrepare>(&InvokeBody::Json(body)).is_ok(),
        );
        refuses_a_path(
            json!({ "credential": password, "destination": { "new_folder": "Clients (restored)" } }),
            &|body| parse::<RestorePrepare>(&InvokeBody::Json(body)).is_ok(),
        );
        refuses_a_path(json!({ "token": hex, "name": null }), &|body| {
            parse::<RestorePrepareConfirm>(&InvokeBody::Json(body)).is_ok()
        });
        refuses_a_path(
            json!({ "token": hex, "name": "Clients (restored)" }),
            &|body| parse::<RestorePrepareConfirm>(&InvokeBody::Json(body)).is_ok(),
        );
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
        for bad in [
            json!({ "credential": password, "destination": "elsewhere" }),
            json!({ "credential": password, "destination": { "new_folder": 7 } }),
            json!({ "credential": password, "destination": { "path": "SENTINEL-7f3a" } }),
            json!({ "credential": password }),
            json!({ "credential": password, "destination": "same_vault", "restore": 1 }),
        ] {
            let refused = parse::<RestorePrepare>(&InvokeBody::Json(bad.clone()));
            assert_eq!(refused.err(), Some(MALFORMED), "{bad}");
        }
        // A token is exactly 32 lowercase hex characters, and the answer's name is text or nothing.
        for bad in [
            json!({ "token": "SENTINEL-7f3a", "name": null }),
            json!({ "token": hex.to_uppercase(), "name": null }),
            json!({ "token": hex, "name": 5 }),
            json!({ "name": "x" }),
        ] {
            let refused = parse::<RestorePrepareConfirm>(&InvokeBody::Json(bad.clone()));
            assert_eq!(refused.err(), Some(MALFORMED), "{bad}");
        }
        for bad in [
            json!({ "restore": -1 }),
            json!({ "restore": "4" }),
            json!({}),
        ] {
            let refused = parse::<RestoreArg>(&InvokeBody::Json(bad.clone()));
            assert_eq!(refused.err(), Some(MALFORMED), "{bad}");
        }
    }

    fn wrong_password() -> ShellError {
        lockbox_core::CoreError::WrongPassword.into()
    }
}
