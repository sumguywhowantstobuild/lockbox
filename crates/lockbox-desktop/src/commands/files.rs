//! Files in a vault (spec §7.2, §4.1): adding or replacing a stored file, Save a copy and Open. Every path comes from a
//! dialog Rust opens inside the command, outside every lock, or from the shell itself; the page sends IDs only.

use std::path::Path;
use std::sync::Arc;

use lockbox_core::blob::{CancelToken, OutputJournal, Progress};
use lockbox_core::ids::{FileId, ItemId};
use lockbox_core::{CoreError, Result as CoreResult, Vault};
use serde::Deserialize;
use tauri::State;
use tauri::ipc::Request;

use super::{NoArgs, args, blocking};
use crate::error::{Confirm, Outcome, ShellError, ShellResult};
use crate::jobs::{JobKind, JobScope};
use crate::open::{RemoveReport, is_executable, safe_name};
use crate::pending::{PendingChoice, Token};
use crate::session::{SessionId, Tagged, VaultRef};
use crate::shell::{Checked, Shell};

impl Shell {
    /// Saves a decrypted copy of the stored file `file_id` of the item `id` where the user picks (spec §7.2). Refused
    /// first while the output journal is damaged. The save dialog opens outside every lock, suggesting the stored
    /// name; Windows asks there before replacing an existing file, so its answer is final. Then, in a long job the
    /// page's `request` names (it is told of it with `lockbox://job-started`, and sees its progress and Stop): the
    /// engine's export, its temp written down in the output journal before it exists and each rename attempt
    /// only while the session is still unlocked in `generation`. An existing destination is touched only by the
    /// rename of a copy that has fully verified. `Dismissed` when the dialog is closed; `Locked` for a lock at any
    /// point; `Cancelled` for a Stop. A destination inside a vault's folder is refused, and one a cloud provider syncs
    /// answers [`Confirm::CloudFolder`] before anything is decrypted or written, with no job begun: the copy waits in
    /// [`Pending`](crate::pending), for [`save_file_copy_confirm`](Self::save_file_copy_confirm).
    pub fn save_file_copy(
        &self,
        session: SessionId,
        generation: u64,
        id: &str,
        file_id: &str,
        request: u32,
    ) -> ShellResult<Tagged<Outcome<()>>> {
        let (id, file_id) = (ItemId::from_hex(id)?, FileId::from_hex(file_id)?);
        self.outputs.usable()?;
        // Cleaned up as for "Open": the dialog would show a right-to-left mark's false extension as it is.
        let name = safe_name(&self.stored_name(session, generation, &id, &file_id)?);
        let Some(dest) = self.os.dialogs.save_file("Save a copy", &name, None) else {
            return self.still_current(session, generation, Outcome::Dismissed);
        };
        self.copy_to(session, generation, id, file_id, &dest, false, request)
    }

    /// The user's yes to saving a copy in a cloud folder: goes on with the copy parked before, for the session that asked
    /// (and only while it is still unlocked in the generation that asked), by the same long job, which the yes's own
    /// `request` names. Everything is checked again, since the folder may have changed since. A token for another
    /// question is used up and refused.
    pub fn save_file_copy_confirm(
        &self,
        token: &Token,
        request: u32,
    ) -> ShellResult<Tagged<Outcome<()>>> {
        match self.sessions.pending().take(token)? {
            PendingChoice::StoredCopy {
                session,
                generation,
                id,
                file_id,
                dest,
            } => self.copy_to(session, generation, id, file_id, &dest, true, request),
            _ => Err(ShellError::NotFound),
        }
    }

    /// The rest of a copy, after the dialog or after a yes: the checks on the destination, the cloud question unless
    /// `cloud_confirmed`, then the long job.
    #[allow(clippy::too_many_arguments)]
    fn copy_to(
        &self,
        session: SessionId,
        generation: u64,
        id: ItemId,
        file_id: FileId,
        dest: &Path,
        cloud_confirmed: bool,
        request: u32,
    ) -> ShellResult<Tagged<Outcome<()>>> {
        // The shared checks, again: after the dialog, or after a yes, the journal may have been damaged and the folder
        // may have become a vault's.
        let dest = match self.checked_output(dest, cloud_confirmed)? {
            Checked::Ready(dest) => dest,
            Checked::Cloud(dest) => {
                let token = self.sessions.pending().put(PendingChoice::StoredCopy {
                    session,
                    generation,
                    id,
                    file_id,
                    dest,
                });
                let ask = Outcome::Confirm(Confirm::CloudFolder { token });
                return self.still_current(session, generation, ask);
            }
        };
        self.sessions
            .read_long(session, generation, |vault, cancel| {
                let scope = JobScope::Session {
                    session,
                    generation,
                };
                let job = self
                    .autolock
                    .begin_job(scope, JobKind::SaveCopy, cancel, Some(request));
                let journal = self.outputs.for_call(&self.sessions, session, generation);
                let saved = export(
                    vault,
                    &id,
                    &file_id,
                    &dest,
                    &journal,
                    job.token(),
                    job.progress(),
                );
                journal.finish(saved).map(Outcome::Done)
            })
    }

    /// Opens the stored file `file_id` of the item `id` with its default app (spec §7.2). Refused first while the
    /// output journal is damaged. A type that can run code (judged on the safe name) answers
    /// [`Confirm::Executable`] until `confirmed_executable`, before anything is decrypted. Then, in a long operation:
    /// a new folder only the user can reach, written down in the journal first; the engine's export, which verifies the
    /// whole stream before the copy gets its name; the internet mark and the read-only flag. The session's generation is
    /// checked once more as the vault is let go, and the launch comes after that, under no lock, since it may wait for
    /// Windows or the user (spec §7.4). Anything that stops the open before the launch, or a launch that fails, removes
    /// the folder. A lock at any point answers `Locked`.
    pub fn open_file(
        &self,
        session: SessionId,
        generation: u64,
        id: &str,
        file_id: &str,
        confirmed_executable: bool,
    ) -> ShellResult<Tagged<Outcome<()>>> {
        let (id, file_id) = (ItemId::from_hex(id)?, FileId::from_hex(file_id)?);
        self.outputs.usable()?;
        let name = safe_name(&self.stored_name(session, generation, &id, &file_id)?);
        if !confirmed_executable && is_executable(&name) {
            let ask = Outcome::Confirm(Confirm::Executable);
            return self.still_current(session, generation, ask);
        }
        let mut made = None;
        let copy = self
            .sessions
            .read_long(session, generation, |vault, cancel| {
                let scope = JobScope::Session {
                    session,
                    generation,
                };
                // No request: Open tells the page nothing of its own beyond `lockbox://busy`.
                let job = self.autolock.begin_job(scope, JobKind::Open, cancel, None);
                // The app is closing: no new folder.
                if job.token().is_cancelled() {
                    return Err(ShellError::Cancelled);
                }
                let folder = self.open_folders.create(session, generation)?;
                let copy = folder.join(&name);
                made = Some(folder);
                let journal = self.outputs.for_call(&self.sessions, session, generation);
                let exported = export(
                    vault,
                    &id,
                    &file_id,
                    &copy,
                    &journal,
                    job.token(),
                    job.progress(),
                );
                journal.finish(exported)?;
                self.open_folders.seal(&copy)?;
                Ok(copy)
            });
        let discard = || {
            if let Some(folder) = &made {
                self.open_folders.discard(folder);
            }
        };
        let copy = match copy {
            Ok(copy) => copy.data,
            Err(error) => {
                discard();
                return Err(error);
            }
        };
        let launched = self.os.launcher.open_file(&copy);
        if launched.is_err() {
            discard();
        }
        // A lock during the launch has removed the copy, and comes first in the answer (spec §7.4).
        let answer = self.still_current(session, generation, Outcome::Done(()))?;
        launched?;
        Ok(answer)
    }

    /// The name of the stored file `file_id` of the item `id`.
    fn stored_name(
        &self,
        session: SessionId,
        generation: u64,
        id: &ItemId,
        file_id: &FileId,
    ) -> ShellResult<String> {
        let name = self.sessions.read(session, generation, |vault, _| {
            let item = match vault {
                VaultRef::Writable(vault) => vault.get_item(id)?,
                VaultRef::ReadOnly(vault) => vault.get_item(id)?,
            };
            let file = item
                .attachments
                .iter()
                .find(|file| file.file_id == *file_id);
            Ok(file.ok_or(CoreError::NotFound)?.name.clone())
        })?;
        Ok(name.data)
    }

    /// Adds a file item, in `collection` or none, holding a file the user picks: the new item's ID. A job the page's
    /// `request` names, with progress and a Stop; stopped, nothing is added (`Cancelled`).
    pub fn add_file(
        &self,
        session: SessionId,
        generation: u64,
        collection: Option<String>,
        request: u32,
    ) -> ShellResult<Tagged<Outcome<String>>> {
        let collection = collection.as_deref().map(ItemId::from_hex).transpose()?;
        self.import(
            session,
            generation,
            "Add a file",
            JobKind::Import,
            Some(request),
            |vault, source, cancel, progress| {
                Ok(vault
                    .new_file_item(collection, source, cancel, progress)?
                    .to_hex())
            },
        )
    }

    /// Attaches a file the user picks to the item `id`: the new file's ID. A job the page's `request` names.
    pub fn attach_file(
        &self,
        session: SessionId,
        generation: u64,
        id: &str,
        request: u32,
    ) -> ShellResult<Tagged<Outcome<String>>> {
        let id = ItemId::from_hex(id)?;
        self.import(
            session,
            generation,
            "Attach a file",
            JobKind::Import,
            Some(request),
            |vault, source, cancel, progress| {
                Ok(vault.attach_file(&id, source, cancel, progress)?.to_hex())
            },
        )
    }

    /// Replaces the stored file `file_id` of the item `id` with a file the user picks: the new file's ID. The old
    /// file stays in the vault until cleanup removes it (spec §6.4). A job in the shell's table, but the page is told
    /// nothing of it beyond `lockbox://busy`.
    pub fn replace_file(
        &self,
        session: SessionId,
        generation: u64,
        id: &str,
        file_id: &str,
    ) -> ShellResult<Tagged<Outcome<String>>> {
        let (id, file_id) = (ItemId::from_hex(id)?, FileId::from_hex(file_id)?);
        self.import(
            session,
            generation,
            "Replace the file",
            JobKind::Replace,
            None,
            |vault, source, cancel, progress| {
                Ok(vault
                    .replace_attachment(&id, &file_id, source, cancel, progress)?
                    .to_hex())
            },
        )
    }

    /// An import: refused before the dialog when the session is locked or read-only; the open dialog (titled `title`)
    /// outside every lock; then `store` in a long change of `kind`, cancelled by a Stop of its job, a lock, Windows lock,
    /// sleep or the app closing (the engine removes its partial blob). Imports write no decrypted output, so a damaged
    /// output journal does not stop them.
    fn import(
        &self,
        session: SessionId,
        generation: u64,
        title: &str,
        kind: JobKind,
        request: Option<u32>,
        store: impl FnOnce(&mut Vault, &Path, &CancelToken, &dyn Progress) -> CoreResult<String>,
    ) -> ShellResult<Tagged<Outcome<String>>> {
        self.sessions
            .read(session, generation, |vault, _| match vault {
                VaultRef::Writable(_) => Ok(()),
                VaultRef::ReadOnly(_) => Err(ShellError::ReadOnly),
            })?;
        let Some(source) = self.os.dialogs.pick_file(title, None) else {
            return self.still_current(session, generation, Outcome::Dismissed);
        };
        self.sessions
            .write_long(session, generation, |vault, cancel| {
                let scope = JobScope::Session {
                    session,
                    generation,
                };
                let job = self.autolock.begin_job(scope, kind, cancel, request);
                Ok(Outcome::Done(store(
                    vault,
                    &source,
                    job.token(),
                    job.progress(),
                )?))
            })
    }

    /// `data` tagged with `generation`, once the session is checked to be still unlocked in it (spec §7.4): `Locked`
    /// otherwise.
    pub(super) fn still_current<T>(
        &self,
        session: SessionId,
        generation: u64,
        data: T,
    ) -> ShellResult<Tagged<T>> {
        let current = self
            .sessions
            .unlocked()
            .into_iter()
            .any(|(s, g, _)| (s, g) == (session, generation));
        match current {
            true => Ok(Tagged {
                session,
                generation,
                data,
            }),
            false => Err(ShellError::Locked),
        }
    }
}

/// The stored file's decrypted copy at `dest`, from either kind of session (the engine's export: verify fully, then
/// publish).
fn export(
    vault: VaultRef<'_>,
    id: &ItemId,
    file_id: &FileId,
    dest: &Path,
    journal: &dyn OutputJournal,
    cancel: &CancelToken,
    progress: &dyn Progress,
) -> CoreResult<()> {
    match vault {
        VaultRef::Writable(vault) => {
            vault.export_file(id, file_id, dest, journal, cancel, progress)
        }
        VaultRef::ReadOnly(vault) => {
            vault.export_file(id, file_id, dest, journal, cancel, progress)
        }
    }
}

/// `replace_file`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileArgs {
    session: SessionId,
    generation: u64,
    id: String,
    file_id: String,
}

/// `save_file_copy`: a job the page numbered with `request`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveCopyArgs {
    session: SessionId,
    generation: u64,
    id: String,
    file_id: String,
    request: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenFile {
    session: SessionId,
    generation: u64,
    id: String,
    file_id: String,
    /// The user said yes to [`Confirm::Executable`](crate::error::Confirm::Executable).
    confirmed_executable: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AddFile {
    session: SessionId,
    generation: u64,
    /// The collection the new item goes in; `None`: none.
    collection: Option<String>,
    /// The page's number for this command, unique in its run: what `lockbox://job-started` answers.
    request: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AttachFile {
    session: SessionId,
    generation: u64,
    id: String,
    request: u32,
}

#[tauri::command]
pub(super) async fn save_file_copy(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<Outcome<()>>> {
    let SaveCopyArgs {
        session,
        generation,
        id,
        file_id,
        request,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.save_file_copy(session, generation, &id, &file_id, request)).await
}

/// `save_file_copy_confirm`: the token the cloud question gave and the page's number for this job, and nothing else.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfirmCopy {
    token: Token,
    request: u32,
}

/// The yes to saving a copy in a cloud-synced folder: the parked copy goes on.
#[tauri::command]
pub(super) async fn save_file_copy_confirm(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<Outcome<()>>> {
    let ConfirmCopy { token, request } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.save_file_copy_confirm(&token, request)).await
}

#[tauri::command]
pub(super) async fn add_file(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<Outcome<String>>> {
    let AddFile {
        session,
        generation,
        collection,
        request,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.add_file(session, generation, collection, request)).await
}

#[tauri::command]
pub(super) async fn attach_file(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<Outcome<String>>> {
    let AttachFile {
        session,
        generation,
        id,
        request,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.attach_file(session, generation, &id, request)).await
}

#[tauri::command]
pub(super) async fn replace_file(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<Outcome<String>>> {
    let FileArgs {
        session,
        generation,
        id,
        file_id,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.replace_file(session, generation, &id, &file_id)).await
}

#[tauri::command]
pub(super) async fn open_file(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<Outcome<()>>> {
    let OpenFile {
        session,
        generation,
        id,
        file_id,
        confirmed_executable,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.open_file(session, generation, &id, &file_id, confirmed_executable))
        .await
}

/// Tries again to remove the opened copies a cleanup could not remove (spec §7.2's Retry): counts only.
#[tauri::command]
pub(super) async fn retry_open_cleanup(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<RemoveReport> {
    let NoArgs {} = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || Ok(shell.open_folders.retry())).await
}

/// Sets a damaged output journal aside, so decrypted output works again (its temps are no longer swept; the next launch
/// still finds its "Open" folders, by listing `open\`).
#[tauri::command]
pub(super) async fn reset_output_journal(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<()> {
    let NoArgs {} = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.outputs.reset()).await
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::fs::{self, OpenOptions};
    use std::os::windows::fs::OpenOptionsExt;
    use std::path::PathBuf;
    use std::rc::Rc;
    use std::sync::{Mutex, mpsc};
    use std::thread;
    use std::time::{Duration, Instant};

    use lockbox_core::blob::NoProgress;
    use lockbox_core::internals::fsio::failpoint;
    use lockbox_core::internals::fsio::testutil::{make_dir_link, names};
    use lockbox_core::{Credential, ReadOnlyVault};
    use serde_json::{Value, json};
    use tauri::ipc::InvokeBody;

    use super::super::{MALFORMED, parse};
    use super::*;
    use crate::error::ShellError;
    use crate::jobs::{JobScope, OperationId};
    use crate::outputs::Attempt;
    use crate::session::{Location, LockReason, OpenStep, Opened};
    use crate::testing::{TEST_PASSWORD, TestShell, heavy, quiet};

    /// How long a test thread waits for the other before it fails instead of hanging.
    const GIVE_UP: Duration = Duration::from_secs(60);
    const LOCKED: Option<ShellError> = Some(ShellError::Locked);

    /// Always disarms, so a failing test cannot leak a failpoint into the next one on this thread.
    struct Cleanup;
    impl Drop for Cleanup {
        fn drop(&mut self) {
            failpoint::disarm_all();
        }
    }

    /// A vault holding one stored file, and a `Documents` folder holding `report.pdf` with "old contents": the
    /// session, the generation, the item's and the file's IDs, and that destination.
    fn with_destination(ts: &TestShell) -> (SessionId, u64, String, String, PathBuf) {
        let (s, g) = ts.open_vault("Family");
        // Several chunks, so the copy is not one write.
        let bytes: Vec<u8> = (0..3 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
        let (id, file_id) = ts.stored_file(s, g, "report.pdf", &bytes);
        let dest = ts.folder("Documents").join("report.pdf");
        fs::write(&dest, b"old contents").unwrap();
        (s, g, id, file_id, dest)
    }

    /// The destination as it was, and nothing else beside it: no temp left.
    fn untouched(dest: &std::path::Path) {
        assert_eq!(fs::read(dest).unwrap(), b"old contents");
        assert_eq!(names(dest.parent().unwrap()), ["report.pdf"]);
    }

    /// The destination is held open with no sharing, so each rename attempt fails with a sharing violation. At the
    /// start of the engine's wait before the next attempt (the step `publish.retry_wait`, outside the publish guard),
    /// the export pauses while another thread locks: the lock returns within 100 ms, before the next attempt begins.
    /// The file is let go right after the lock, so only the publish gate stops the next attempt: refused, `Locked`,
    /// the destination as it was, the temp gone and cleared.
    #[test]
    fn lock_not_delayed_by_a_held_file() {
        let _cleanup = Cleanup;
        let ts = TestShell::new();
        let (s, g, id, file_id, dest) = with_destination(&ts);
        let held = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&dest)
            .unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let attempts = Arc::clone(&seen);
        ts.shell.outputs.on_attempt(Box::new(move |attempt| {
            attempts.lock().unwrap().push((attempt, Instant::now()));
        }));
        // The first wait: tell the locker, and stay in the wait until it has locked.
        let (waiting, waiting_rx) = mpsc::channel();
        let (locked, locked_rx) = mpsc::channel::<()>();
        let mut first_wait = Some((waiting, locked_rx));
        failpoint::observe(
            "publish.retry_wait",
            Box::new(move || {
                if let Some((waiting, locked)) = first_wait.take() {
                    waiting.send(Instant::now()).unwrap();
                    locked.recv_timeout(GIVE_UP).expect("the locker locked");
                }
            }),
        );
        let shell = Arc::clone(&ts.shell);
        // No key derivation slows the lock while it is timed.
        let _quiet = quiet();
        let locker = thread::spawn(move || {
            let wait_began = waiting_rx
                .recv_timeout(GIVE_UP)
                .expect("the engine waited between attempts");
            let started = Instant::now();
            shell.sessions.lock_all(LockReason::Manual);
            let returned = Instant::now();
            drop(held);
            locked.send(()).unwrap();
            (wait_began, started, returned)
        });
        ts.dialogs.answer(Some(dest.clone()));
        let saved = ts.shell.save_file_copy(s, g, &id, &file_id, 1);
        let (wait_began, lock_started, lock_returned) = locker.join().unwrap();
        let took = lock_returned - lock_started;
        assert!(took < Duration::from_millis(100), "the lock took {took:?}");
        assert_eq!(saved.err(), LOCKED);
        let seen = seen.lock().unwrap().clone();
        assert_eq!(
            seen.len(),
            2,
            "one failed attempt, then one refused: {seen:?}"
        );
        let ((first, failed_at), (next, next_at)) = (seen[0], seen[1]);
        assert!(
            matches!(first, Attempt::Failed(Some(32 | 5))),
            "first a sharing violation: {seen:?}"
        );
        assert!(failed_at <= wait_began && wait_began <= lock_started);
        assert!(
            lock_returned <= next_at,
            "the lock returned before the next attempt"
        );
        assert_eq!(next, Attempt::Refused);
        untouched(&dest);
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    /// Fix round 1: a readable journal whose write fails while the temp is recorded: the export stops before its
    /// temp exists (it never reaches `export.after_record`), the destination is as it was and the journal unchanged.
    #[test]
    fn record_write_failure_stops_the_output() {
        let _cleanup = Cleanup;
        let ts = TestShell::new();
        let (s, g, id, file_id, dest) = with_destination(&ts);
        let paths = &ts.shell.paths;
        let journal = r#"{ "version": 1, "entries": [] }"#;
        fs::create_dir_all(&paths.root).unwrap();
        fs::write(&paths.outputs, journal).unwrap();
        let reached = Rc::new(Cell::new(false));
        let seen = Rc::clone(&reached);
        failpoint::observe("export.after_record", Box::new(move || seen.set(true)));
        failpoint::arm("atomic_write.before_replace");
        ts.dialogs.answer(Some(dest.clone()));
        let saved = ts.shell.save_file_copy(s, g, &id, &file_id, 1);
        assert!(
            matches!(saved, Err(ShellError::Core(view)) if view.kind == "io"),
            "refused as an I/O error"
        );
        assert!(!reached.get(), "the temp was never made");
        untouched(&dest);
        assert_eq!(fs::read_to_string(&paths.outputs).unwrap(), journal);
    }

    /// Fix round 1: a clear that cannot write the journal, with the real `CallJournal`, also while a panic unwinds:
    /// nothing panics further, the temp is removed, its entry stays (the next sweep drops it, nothing being there).
    #[test]
    fn clear_failure_keeps_the_entry() {
        let _cleanup = Cleanup;
        let ts = TestShell::new();
        let (s, g, id, file_id, dest) = with_destination(&ts);
        let one_temp_listed = |ts: &TestShell| {
            let entries = ts.journal();
            assert_eq!(entries.len(), 1, "the entry stays");
            assert!(!entries[0].exists(), "the temp is removed");
        };

        // The export fails at its last step, and the journal cannot be written from then on.
        failpoint::arm("export.before_publish");
        failpoint::observe(
            "export.before_publish",
            Box::new(|| failpoint::arm("atomic_write.before_replace")),
        );
        ts.dialogs.answer(Some(dest.clone()));
        let saved = ts.shell.save_file_copy(s, g, &id, &file_id, 1);
        assert!(matches!(saved, Err(ShellError::Core(view)) if view.kind == "io"));
        untouched(&dest);
        one_temp_listed(&ts);
        failpoint::disarm_all();
        assert_eq!(
            ts.shell.outputs.sweep(),
            crate::outputs::SweepReport::default()
        );
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());

        // A panic at the same step: the clear runs while it unwinds, and its failure is contained too.
        failpoint::observe(
            "export.before_publish",
            Box::new(|| {
                failpoint::arm("atomic_write.before_replace");
                panic!("a test panic inside the export");
            }),
        );
        ts.dialogs.answer(Some(dest.clone()));
        let shell = Arc::clone(&ts.shell);
        let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            shell.save_file_copy(s, g, &id, &file_id, 1)
        }));
        assert!(unwound.is_err(), "the panic reached the caller");
        failpoint::disarm_all();
        untouched(&dest);
        one_temp_listed(&ts);
    }

    /// A lock while the copy is being made (here at its last step before the rename): `Locked`, the existing
    /// destination as it was, the temp gone and cleared from the journal.
    #[test]
    fn lock_during_save_a_copy() {
        let _cleanup = Cleanup;
        let ts = TestShell::new();
        let (s, g, id, file_id, dest) = with_destination(&ts);
        let shell = Arc::clone(&ts.shell);
        failpoint::observe(
            "export.before_publish",
            Box::new(move || shell.sessions.lock_all(LockReason::Manual)),
        );
        ts.dialogs.answer(Some(dest.clone()));
        assert_eq!(
            ts.shell.save_file_copy(s, g, &id, &file_id, 1).err(),
            LOCKED
        );
        untouched(&dest);
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    /// The vault locks while the dialog waits for the user: `Locked`, nothing written, no journal. The same for an
    /// import: no file stored.
    #[test]
    fn lock_while_dialog_open() {
        let ts = TestShell::new();
        let (s, g, id, file_id, dest) = with_destination(&ts);
        let lock_in_dialog = || {
            let shell = Arc::clone(&ts.shell);
            ts.dialogs.during_next_dialog(Box::new(move || {
                shell.sessions.lock_all(LockReason::Manual)
            }));
        };
        lock_in_dialog();
        let copy = dest.with_file_name("report copy.pdf");
        ts.dialogs.answer(Some(copy));
        assert_eq!(
            ts.shell.save_file_copy(s, g, &id, &file_id, 1).err(),
            LOCKED
        );
        untouched(&dest);
        assert!(!ts.shell.paths.outputs.exists(), "no journal change");

        let (s, g) = ts.open_vault("Work");
        let source = ts.temp.path().join("statement.pdf");
        fs::write(&source, b"statement").unwrap();
        lock_in_dialog();
        ts.dialogs.answer(Some(source));
        assert_eq!(ts.shell.add_file(s, g, None, 1).err(), LOCKED);
        let work = ts.shell.registry.entries()[1].1.clone();
        assert_eq!(names(&work.join("files")), ["orphaned"], "no file stored");
        assert!(names(&work.join("items")).is_empty(), "no item stored");
    }

    /// A closed dialog: `Dismissed` (tagged), and nothing changes: no journal, no item, no file.
    #[test]
    fn closed_dialog_does_nothing() {
        let ts = TestShell::new();
        let (s, g, id, file_id, dest) = with_destination(&ts);
        fn dismissed<T>(answer: ShellResult<Tagged<Outcome<T>>>, s: SessionId, g: u64) {
            let Ok(answer) = answer else {
                panic!("refused");
            };
            assert_eq!((answer.session, answer.generation), (s, g));
            assert!(matches!(answer.data, Outcome::Dismissed));
        }
        dismissed(ts.shell.save_file_copy(s, g, &id, &file_id, 1), s, g);
        dismissed(ts.shell.add_file(s, g, None, 1), s, g);
        dismissed(ts.shell.attach_file(s, g, &id, 1), s, g);
        dismissed(ts.shell.replace_file(s, g, &id, &file_id), s, g);
        assert_eq!(ts.dialogs.opened(), 4);
        untouched(&dest);
        assert!(!ts.shell.paths.outputs.exists(), "no journal change");
        let items = serde_json::to_value(ts.shell.list_items(s, g).unwrap()).unwrap();
        let items = items["data"]["items"].as_array().unwrap().clone();
        assert_eq!(items.len(), 1, "no item added");
        assert_eq!(items[0]["attachments"].as_array().unwrap().len(), 1);
        assert_eq!(items[0]["attachments"][0]["file_id"], json!(file_id));
    }

    /// A copy into the state folder, its `open\` folder, or the state folder reached through a junction or spelled
    /// in another case: refused as `"state folder"`, nothing written.
    #[test]
    fn save_into_state_folder_refused() {
        let ts = TestShell::new();
        let (s, g, id, file_id, _) = with_destination(&ts);
        let paths = ts.shell.paths.clone();
        fs::create_dir_all(&paths.open).unwrap();
        let link = ts.temp.path().join("state link");
        make_dir_link(&link, &paths.root);
        let shouting = PathBuf::from(paths.root.to_string_lossy().to_uppercase());
        for dir in [&paths.root, &paths.open, &link, &shouting] {
            let dest = dir.join("report copy.pdf");
            ts.dialogs.answer(Some(dest.clone()));
            assert_eq!(
                ts.shell.save_file_copy(s, g, &id, &file_id, 1).err(),
                Some(ShellError::InvalidInput {
                    what: "state folder"
                })
            );
            assert!(!dest.exists());
        }
        assert!(!paths.outputs.exists(), "no journal change");
        assert!(names(&paths.open).is_empty());
    }

    /// Adding a file item, attaching a second file and replacing it, then a copy of the replacement: each through its
    /// dialog and a long operation the page is told of.
    #[test]
    fn add_attach_replace_and_save() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let source = |name: &str, bytes: &[u8]| {
            let path = ts.temp.path().join(name);
            fs::write(&path, bytes).unwrap();
            ts.dialogs.answer(Some(path));
        };
        let done = |answer: Tagged<Outcome<String>>| match answer.data {
            Outcome::Done(id) => id,
            _ => panic!("not done"),
        };
        source("statement.pdf", b"one");
        let id = done(ts.shell.add_file(s, g, None, 1).unwrap());
        source("scan.png", b"two");
        let second = done(ts.shell.attach_file(s, g, &id, 1).unwrap());
        source("scan v2.png", b"three");
        let third = done(ts.shell.replace_file(s, g, &id, &second).unwrap());
        let detail = serde_json::to_value(ts.shell.get_item(s, g, &id).unwrap()).unwrap();
        let names: Vec<Value> = detail["data"]["summary"]["attachments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| file["name"].clone())
            .collect();
        assert_eq!(names, [json!("statement.pdf"), json!("scan v2.png")]);
        assert_eq!(
            detail["data"]["summary"]["attachments"][1]["file_id"],
            json!(third)
        );

        let dest = ts.folder("Documents").join("scan copy.png");
        ts.dialogs.answer(Some(dest.clone()));
        let saved = ts.shell.save_file_copy(s, g, &id, &third, 1).unwrap();
        assert!(matches!(saved.data, Outcome::Done(())));
        assert_eq!(fs::read(&dest).unwrap(), b"three");
        let busy = ts.events.busy();
        assert!(busy.contains(&(Some(s), vec!["import"])), "{busy:?}");
        assert!(busy.contains(&(Some(s), vec!["save_copy"])), "{busy:?}");
    }

    /// A stored name is not trusted in a dialog either: a right-to-left mark would show a false extension there.
    #[test]
    fn save_dialog_suggests_the_cleaned_up_name() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let (id, file_id) = ts.stored_file(s, g, "invoice\u{202E}fdp.exe", b"x");
        ts.dialogs.answer(None);
        let saved = ts.shell.save_file_copy(s, g, &id, &file_id, 1).unwrap();
        assert!(matches!(saved.data, Outcome::Dismissed));
        assert_eq!(
            ts.dialogs.suggested().last().map(String::as_str),
            Some("invoice_fdp.exe")
        );
    }

    #[test]
    fn foreign_file_id_refused() {
        let ts = TestShell::new();
        let (a, ga) = ts.open_vault("Family");
        let (b, gb) = ts.open_vault("Work");
        let add = |session, generation, name: &str| {
            let path = ts.temp.path().join(name);
            fs::write(&path, name).unwrap();
            ts.dialogs.answer(Some(path));
            match ts
                .shell
                .add_file(session, generation, None, 1)
                .unwrap()
                .data
            {
                Outcome::Done(id) => id,
                _ => panic!("not done"),
            }
        };
        let file_of = |session, generation, id: &str| {
            let detail = ts.shell.get_item(session, generation, id).unwrap();
            let detail = serde_json::to_value(detail).unwrap();
            detail["data"]["summary"]["attachments"][0]["file_id"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        let mine = add(a, ga, "mine.txt");
        let theirs = add(b, gb, "theirs.txt");
        let their_file = file_of(b, gb, &theirs);
        let dialogs = ts.dialogs.opened();

        let not_found = Some(ShellError::from(CoreError::NotFound));
        // Another vault's item, and my item with another vault's file.
        for id in [&theirs, &mine] {
            let saved = ts.shell.save_file_copy(a, ga, id, &their_file, 1);
            assert_eq!(saved.err(), not_found);
            let opened = ts.shell.open_file(a, ga, id, &their_file, false);
            assert_eq!(opened.err(), not_found);
        }
        assert_eq!(ts.dialogs.opened(), dialogs, "no dialog before the check");
        assert!(ts.launcher.opened().is_empty());
    }

    /// A read-only session over the vault listed first, as a backup or a pre-restore copy opens. It locks every vault
    /// first, so a session opened earlier is locked after it.
    fn read_only_session(ts: &TestShell) -> (SessionId, u64) {
        let dir = ts.shell.registry.entries()[0].1.clone();
        ts.shell.sessions.lock_all(LockReason::Manual);
        let vault = heavy(|| {
            ReadOnlyVault::open_folder(
                &dir,
                Credential::Password(TEST_PASSWORD),
                &CancelToken::new(),
                &NoProgress,
            )
        })
        .unwrap();
        let location = Location::folder(&dir).unwrap();
        let opened = ts.shell.sessions.open(Some(location.clone()), None, |_| {
            Ok(OpenStep::Session(location, Opened::ReadOnly(vault), ()))
        });
        let Ok(Outcome::Done(tagged)) = opened else {
            panic!("the read-only session did not open");
        };
        (tagged.session, tagged.generation)
    }

    /// All five file commands are refused for a stale generation (`Locked`) and for a session that is not ours
    /// (`NotFound`), before any dialog opens or anything is launched. The three that write are refused on a read-only
    /// session before their dialog; Open and Save a copy are allowed there, since they write nothing into the vault. A
    /// replace or an attach naming another vault's item or file is refused with nothing stored.
    #[test]
    fn file_commands_refused_stale_foreign_read_only() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let (id, file_id) = ts.stored_file(s, g, "report.pdf", b"contents");
        let (other, go) = ts.open_vault("Work");
        let (their_id, their_file) = ts.stored_file(other, go, "theirs.pdf", b"theirs");
        let foreign = SessionId(s.0 + 100);
        let dialogs = ts.dialogs.opened();

        for (session, generation, wanted) in [
            (s, g + 1, Some(ShellError::Locked)),
            (foreign, g, Some(ShellError::NotFound)),
        ] {
            let opened = ts
                .shell
                .open_file(session, generation, &id, &file_id, false);
            assert_eq!(opened.err(), wanted);
            let saved = ts
                .shell
                .save_file_copy(session, generation, &id, &file_id, 1);
            assert_eq!(saved.err(), wanted);
            assert_eq!(
                ts.shell.add_file(session, generation, None, 1).err(),
                wanted
            );
            assert_eq!(
                ts.shell.attach_file(session, generation, &id, 1).err(),
                wanted
            );
            let replaced = ts.shell.replace_file(session, generation, &id, &file_id);
            assert_eq!(replaced.err(), wanted);
        }
        assert_eq!(ts.dialogs.opened(), dialogs, "no dialog before the check");
        assert!(ts.launcher.opened().is_empty());

        // Another vault's item, and my item with another vault's file: refused, nothing stored.
        let path = ts.temp.path().join("new.pdf");
        fs::write(&path, b"new").unwrap();
        let not_found = Some(ShellError::from(CoreError::NotFound));
        ts.dialogs.answer(Some(path.clone()));
        let attached = ts.shell.attach_file(s, g, &their_id, 1);
        assert_eq!(attached.err(), not_found);
        ts.dialogs.answer(Some(path));
        let replaced = ts.shell.replace_file(s, g, &id, &their_file);
        assert_eq!(replaced.err(), not_found);
        let item = ts.shell.get_item(s, g, &id).unwrap();
        let item = serde_json::to_value(item).unwrap();
        assert_eq!(
            item["data"]["summary"]["attachments"][0]["file_id"],
            json!(file_id)
        );
        assert_eq!(
            item["data"]["summary"]["attachments"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        let (r, gr) = read_only_session(&ts);
        let dialogs = ts.dialogs.opened();
        let refused = [
            ts.shell.add_file(r, gr, None, 1).err(),
            ts.shell.attach_file(r, gr, &id, 1).err(),
            ts.shell.replace_file(r, gr, &id, &file_id).err(),
        ];
        assert_eq!(refused, [Some(ShellError::ReadOnly); 3]);
        assert_eq!(ts.dialogs.opened(), dialogs, "no dialog before the check");
        // A copy of a stored file may be saved and opened from it.
        let dest = ts.folder("Documents").join("copy.pdf");
        ts.dialogs.answer(Some(dest.clone()));
        let saved = ts.shell.save_file_copy(r, gr, &id, &file_id, 1).unwrap();
        assert!(matches!(saved.data, Outcome::Done(())));
        assert_eq!(fs::read(&dest).unwrap(), b"contents");
        let opened = ts.shell.open_file(r, gr, &id, &file_id, false).unwrap();
        assert!(matches!(opened.data, Outcome::Done(())));
    }

    /// What `with_destination` stores, as the copy must read.
    fn stored_bytes() -> Vec<u8> {
        (0..3 * 1024 * 1024).map(|i| (i % 251) as u8).collect()
    }

    /// Asks for a copy to the destination of `with_destination` and gets the cloud question: its token.
    fn cloud_token(
        ts: &TestShell,
        session: SessionId,
        generation: u64,
        id: &str,
        file_id: &str,
        dest: &std::path::Path,
    ) -> Token {
        ts.dialogs.answer(Some(dest.to_path_buf()));
        let Ok(Tagged {
            data: Outcome::Confirm(Confirm::CloudFolder { token }),
            ..
        }) = ts.shell.save_file_copy(session, generation, id, file_id, 1)
        else {
            panic!("a cloud folder asks first");
        };
        token
    }

    /// A destination a cloud provider syncs asks first, after the dialog and before anything is decrypted or written:
    /// the destination is as it was, no temp, no long operation, and no second dialog.
    #[test]
    fn save_copy_to_a_cloud_folder_asks_first() {
        let ts = TestShell::new();
        let (s, g, id, file_id, dest) = with_destination(&ts);
        ts.volumes.add_sync_root(dest.parent().unwrap());
        let _token = cloud_token(&ts, s, g, &id, &file_id, &dest);
        untouched(&dest);
        assert_eq!(ts.dialogs.opened(), 1);
        assert!(ts.events.busy().is_empty(), "nothing was decrypted");
        assert!(ts.launcher.opened().is_empty());
        // A folder no provider syncs is not asked about.
        let plain = ts.folder("Plain").join("report.pdf");
        ts.dialogs.answer(Some(plain.clone()));
        let saved = ts.shell.save_file_copy(s, g, &id, &file_id, 1).unwrap();
        assert!(matches!(saved.data, Outcome::Done(())));
        assert_eq!(fs::read(&plain).unwrap(), stored_bytes());
    }

    /// The yes goes on with the parked copy: the same destination, no second dialog, the same long operation, and the
    /// token is used up. It works on a vault opened read-only too, which can save a copy.
    #[test]
    fn save_copy_cloud_yes_writes_the_file() {
        let ts = TestShell::new();
        let (s, g, id, file_id, dest) = with_destination(&ts);
        ts.volumes.add_sync_root(dest.parent().unwrap());
        let token = cloud_token(&ts, s, g, &id, &file_id, &dest);
        let saved = ts.shell.save_file_copy_confirm(&token, 1).unwrap();
        assert_eq!((saved.session, saved.generation), (s, g));
        assert!(matches!(saved.data, Outcome::Done(())));
        assert_eq!(fs::read(&dest).unwrap(), stored_bytes());
        assert_eq!(names(dest.parent().unwrap()), ["report.pdf"]);
        assert_eq!(ts.dialogs.opened(), 1, "no second dialog");
        let busy = ts.events.busy();
        assert!(busy.contains(&(Some(s), vec!["save_copy"])), "{busy:?}");
        assert_eq!(
            ts.shell.save_file_copy_confirm(&token, 1).err(),
            Some(ShellError::NotFound),
            "used up"
        );

        let (r, gr) = read_only_session(&ts);
        let token = cloud_token(&ts, r, gr, &id, &file_id, &dest);
        fs::write(&dest, b"old contents").unwrap();
        let saved = ts.shell.save_file_copy_confirm(&token, 1).unwrap();
        assert!(matches!(saved.data, Outcome::Done(())));
        assert_eq!(fs::read(&dest).unwrap(), stored_bytes());
    }

    /// The parked copy is the vault's: a lock of that one vault drops it at once (a lock of another leaves it), as does
    /// Lock all, five minutes and use. The yes then finds nothing, and writes nothing, even after the vault is unlocked
    /// again (a new generation).
    #[test]
    fn save_copy_cloud_token_dropped_at_lock() {
        let ts = TestShell::new();
        let (s, g, id, file_id, dest) = with_destination(&ts);
        ts.volumes.add_sync_root(dest.parent().unwrap());
        let token = cloud_token(&ts, s, g, &id, &file_id, &dest);
        let (other, _) = ts.open_vault("Work");
        assert_eq!(ts.shell.sessions.pending().len(), 1);
        ts.shell.sessions.lock(other, LockReason::Manual);
        assert_eq!(ts.shell.sessions.pending().len(), 1, "another vault's lock");
        ts.shell.sessions.lock(s, LockReason::Manual);
        assert_eq!(ts.shell.sessions.pending().len(), 0, "its own lock");
        assert_eq!(
            ts.shell.save_file_copy_confirm(&token, 1).err(),
            Some(ShellError::NotFound)
        );
        untouched(&dest);

        // Lock all drops it too.
        let (s2, g2) = ts.open_vault("Again");
        let (id2, file2) = ts.stored_file(s2, g2, "again.pdf", b"x");
        let token = cloud_token(&ts, s2, g2, &id2, &file2, &dest);
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert_eq!(
            ts.shell.save_file_copy_confirm(&token, 1).err(),
            Some(ShellError::NotFound)
        );
        untouched(&dest);
    }

    /// The vault-folder refusal runs again on the yes: a folder that became a vault's while the question waited is
    /// refused by the shell itself, before any long operation, journal entry or temp, with the destination as it was.
    #[test]
    fn save_copy_cloud_yes_refuses_a_folder_that_became_a_vault() {
        let ts = TestShell::new();
        let (s, g, id, file_id, dest) = with_destination(&ts);
        ts.volumes.add_sync_root(dest.parent().unwrap());
        let token = cloud_token(&ts, s, g, &id, &file_id, &dest);
        fs::write(dest.parent().unwrap().join("vault.json"), b"not really").unwrap();
        let refused = ts.shell.save_file_copy_confirm(&token, 1);
        assert_eq!(
            refused.err(),
            Some(ShellError::from(CoreError::InvalidInput {
                what: "destination in a vault folder"
            }))
        );
        assert!(ts.events.busy().is_empty(), "refused before the operation");
        assert_eq!(fs::read(&dest).unwrap(), b"old contents");
        assert_eq!(
            names(dest.parent().unwrap()),
            ["report.pdf", "vault.json"],
            "no temp"
        );
    }

    /// The confirming command takes a token and nothing else: a token never given, one used, one of another question (it
    /// is used up and its choice dropped), and the cloud question's own after a lock are all refused with nothing
    /// written. The question itself is refused for a stale generation and a foreign session, before the dialog.
    #[test]
    fn save_copy_cloud_confirm_refused_for_old_used_and_other_tokens() {
        let ts = TestShell::new();
        let (s, g, id, file_id, dest) = with_destination(&ts);
        ts.volumes.add_sync_root(dest.parent().unwrap());
        let made_up: Token =
            serde_json::from_value(Value::String(["0123456789abcdef"; 2].concat())).unwrap();
        let not_found = Some(ShellError::NotFound);
        assert_eq!(
            ts.shell.save_file_copy_confirm(&made_up, 1).err(),
            not_found
        );

        let other = ts
            .shell
            .sessions
            .pending()
            .put(crate::pending::PendingChoice::AddVault {
                dir: ts.temp.path().to_path_buf(),
            });
        assert_eq!(ts.shell.save_file_copy_confirm(&other, 1).err(), not_found);
        assert_eq!(ts.shell.sessions.pending().len(), 0, "used up");
        // And the other way round: this token is no good to another question.
        let token = cloud_token(&ts, s, g, &id, &file_id, &dest);
        assert_eq!(ts.shell.save_readable_confirm(&token).err(), not_found);
        assert_eq!(ts.shell.save_file_copy_confirm(&token, 1).err(), not_found);
        untouched(&dest);

        let dialogs = ts.dialogs.opened();
        let foreign = SessionId(s.0 + 100);
        ts.dialogs.answer(Some(dest.clone()));
        assert_eq!(
            ts.shell.save_file_copy(s, g + 1, &id, &file_id, 1).err(),
            LOCKED
        );
        assert_eq!(
            ts.shell.save_file_copy(foreign, g, &id, &file_id, 1).err(),
            not_found
        );
        assert_eq!(ts.dialogs.opened(), dialogs, "before the dialog");
        assert_eq!(ts.shell.sessions.pending().len(), 0);
    }

    /// The job events of one command: its `job-started` (with the `request` it was given), then its progress events in
    /// order, the last one finished with `done == total == size`.
    fn assert_one_job(ts: &TestShell, request: u32, kind: &str, size: u64) -> u64 {
        let started: Vec<Value> = ts
            .events
            .started()
            .into_iter()
            .filter(|event| event["request"] == json!(request))
            .collect();
        assert_eq!(started.len(), 1, "request {request}: {started:?}");
        assert_eq!(started[0]["kind"], json!(kind));
        let operation = started[0]["operation"].as_u64().unwrap();
        let progress: Vec<Value> = ts
            .events
            .progress()
            .into_iter()
            .filter(|event| event["operation"] == json!(operation))
            .collect();
        assert!(progress.len() >= 2, "{progress:?}");
        assert!(progress.iter().all(|event| event["kind"] == json!(kind)));
        assert!(
            progress
                .iter()
                .all(|event| event["scope"] == started[0]["scope"])
        );
        let (last, earlier) = progress.split_last().unwrap();
        assert!(earlier.iter().all(|e| e["finished"] == json!(false)));
        assert_eq!(last["finished"], json!(true));
        assert_eq!(last["done"], json!(size));
        assert_eq!(last["total"], json!(size));
        let mut before = 0;
        for event in &progress {
            let done = event["done"].as_u64().unwrap();
            assert!(done >= before && done <= size, "{progress:?}");
            before = done;
        }
        operation
    }

    /// The four commands this task gives progress each take a `request`: the page is told of the job with it, sees
    /// progress that ends at the file's size, and the cloud question, a closed dialog and a refusal send no
    /// `job-started` at all.
    #[test]
    fn one_file_add_and_save_copy_take_request() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let size = 3 * 1024 * 1024 + 5;
        let bytes: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        let source = ts.temp.path().join("big.bin");
        fs::write(&source, &bytes).unwrap();
        let done = |answer: Tagged<Outcome<String>>| match answer.data {
            Outcome::Done(id) => id,
            _ => panic!("not done"),
        };

        // A closed dialog and a refusal before the work start nothing.
        ts.dialogs.answer(None);
        assert!(matches!(
            ts.shell.add_file(s, g, None, 1).unwrap().data,
            Outcome::Dismissed
        ));
        assert_eq!(ts.shell.add_file(s, g + 1, None, 2).err(), LOCKED);
        assert!(ts.events.started().is_empty());

        ts.dialogs.answer(Some(source.clone()));
        let id = done(ts.shell.add_file(s, g, None, 11).unwrap());
        let scope = json!({ "type": "session", "session": s.0, "generation": g });
        let added = assert_one_job(&ts, 11, "import", size as u64);
        assert_eq!(
            ts.events.started()[0]["scope"],
            scope,
            "the job's scope is its session and generation"
        );

        ts.dialogs.answer(Some(source));
        let file_id = done(ts.shell.attach_file(s, g, &id, 12).unwrap());
        let attached = assert_one_job(&ts, 12, "import", size as u64);
        assert_ne!(added, attached);

        let dest = ts.folder("Documents").join("copy.bin");
        ts.dialogs.answer(Some(dest.clone()));
        let saved = ts.shell.save_file_copy(s, g, &id, &file_id, 13).unwrap();
        assert!(matches!(saved.data, Outcome::Done(())));
        assert_eq!(fs::read(&dest).unwrap(), bytes);
        assert_one_job(&ts, 13, "save_copy", size as u64);

        // The cloud question starts nothing; the yes starts the job, named by the confirm's own request.
        let dest = ts.folder("Synced").join("cloud.bin");
        ts.volumes.add_sync_root(dest.parent().unwrap());
        ts.dialogs.answer(Some(dest.clone()));
        let asked = ts.shell.save_file_copy(s, g, &id, &file_id, 20).unwrap();
        let Outcome::Confirm(Confirm::CloudFolder { token }) = asked.data else {
            panic!("a cloud folder asks first");
        };
        assert!(
            ts.events
                .started()
                .iter()
                .all(|e| e["request"] != json!(20))
        );
        let saved = ts.shell.save_file_copy_confirm(&token, 21).unwrap();
        assert!(matches!(saved.data, Outcome::Done(())));
        assert_eq!(fs::read(&dest).unwrap(), bytes);
        assert_one_job(&ts, 21, "save_copy", size as u64);
    }

    /// `job-started` and every progress event are sent while the command still runs, so before it answers, and the
    /// page can match the operation to its request.
    #[test]
    fn job_started_is_sent_before_progress_and_before_the_answer() {
        let ts = TestShell::new();
        let (s, g, id, file_id, dest) = with_destination(&ts);
        let answered = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let early = Arc::new(Mutex::new(Vec::new()));
        let (flag, seen) = (Arc::clone(&answered), Arc::clone(&early));
        ts.events.watch(move |name, _| {
            seen.lock()
                .unwrap()
                .push((name, flag.load(std::sync::atomic::Ordering::SeqCst)));
        });
        ts.dialogs.answer(Some(dest));
        let saved = ts.shell.save_file_copy(s, g, &id, &file_id, 31).unwrap();
        answered.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(matches!(saved.data, Outcome::Done(())));

        let seen = early.lock().unwrap().clone();
        assert_eq!(seen[0].0, crate::shell::JOB_STARTED_EVENT);
        assert!(
            seen[1..]
                .iter()
                .all(|(name, _)| *name == crate::shell::PROGRESS_EVENT)
        );
        assert!(seen.len() >= 3, "{seen:?}");
        assert!(
            seen.iter().all(|(_, after_the_answer)| !after_the_answer),
            "an event came after the answer"
        );
    }

    /// A Stop (`cancel_operation`) sent while a copy runs ends it as cancelled with the destination as it was and no temp,
    /// and stops nothing else: the same session saves the copy afterwards.
    #[test]
    fn stop_ends_a_running_copy_and_leaves_the_session_working() {
        let ts = TestShell::new();
        let (s, g, id, file_id, dest) = with_destination(&ts);
        let shell = Arc::clone(&ts.shell);
        ts.events.watch(move |name, payload| {
            if name == crate::shell::PROGRESS_EVENT && payload["finished"] == json!(false) {
                let operation = OperationId(payload["operation"].as_u64().unwrap());
                let scope: JobScope = serde_json::from_value(payload["scope"].clone()).unwrap();
                shell.autolock.cancel_operation(operation, scope).unwrap();
            }
        });
        ts.dialogs.answer(Some(dest.clone()));
        let stopped = ts.shell.save_file_copy(s, g, &id, &file_id, 41);
        assert_eq!(stopped.err(), Some(ShellError::Cancelled));
        untouched(&dest);
        let last = ts.events.progress().pop().unwrap();
        assert_eq!(last["finished"], json!(true));

        ts.events.watch(|_, _| {});
        ts.dialogs.answer(Some(dest.clone()));
        let saved = ts.shell.save_file_copy(s, g, &id, &file_id, 42).unwrap();
        assert!(matches!(saved.data, Outcome::Done(())));
        assert_eq!(fs::read(&dest).unwrap(), stored_bytes());
    }

    /// Every file under `dir` with its bytes, by path: what a folder holds, to compare before and after.
    fn files_under(dir: &std::path::Path) -> std::collections::BTreeMap<PathBuf, Vec<u8>> {
        let mut found = std::collections::BTreeMap::new();
        let mut pending = vec![dir.to_path_buf()];
        while let Some(folder) = pending.pop() {
            for entry in fs::read_dir(&folder).unwrap() {
                let path = entry.unwrap().path();
                match path.is_dir() {
                    true => pending.push(path),
                    false => {
                        // A file another handle holds exclusively (the vault's lock file, a temp being written) reads as
                        // empty: its name still counts.
                        found.insert(path.clone(), fs::read(&path).unwrap_or_default());
                    }
                }
            }
        }
        found
    }

    /// What a Stop found when it was sent: the folder's files at that moment, and how many bytes the job had done.
    struct StoppedAt {
        folder: std::sync::Mutex<Option<std::collections::BTreeMap<PathBuf, Vec<u8>>>>,
        done: std::sync::atomic::AtomicU64,
    }

    /// From now on, the first progress event that says bytes were written (`done > 0`, not the finished one) sends the
    /// job's Stop through `cancel_operation`, as the page's button does, after taking a snapshot of `watched`.
    fn stop_once_bytes_are_written(ts: &TestShell, watched: PathBuf) -> Arc<StoppedAt> {
        let stopped = Arc::new(StoppedAt {
            folder: Mutex::new(None),
            done: std::sync::atomic::AtomicU64::new(0),
        });
        let (shell, seen) = (Arc::clone(&ts.shell), Arc::clone(&stopped));
        ts.events.watch(move |name, payload| {
            let done = payload["done"].as_u64().unwrap_or(0);
            if name != crate::shell::PROGRESS_EVENT
                || payload["finished"] != json!(false)
                || done == 0
                || seen.done.load(std::sync::atomic::Ordering::SeqCst) != 0
            {
                return;
            }
            *seen.folder.lock().unwrap() = Some(files_under(&watched));
            seen.done.store(done, std::sync::atomic::Ordering::SeqCst);
            let operation = OperationId(payload["operation"].as_u64().unwrap());
            let scope: JobScope = serde_json::from_value(payload["scope"].clone()).unwrap();
            shell.autolock.cancel_operation(operation, scope).unwrap();
        });
        stopped
    }

    /// A made-up file of several MiB, so the engine reports bytes done before it ends.
    fn big_source(ts: &TestShell, name: &str) -> PathBuf {
        let path = ts.temp.path().join(name);
        let bytes: Vec<u8> = (0..4 * 1024 * 1024).map(|i| (i % 241) as u8).collect();
        fs::write(&path, bytes).unwrap();
        path
    }

    /// The item's attachments, by file ID.
    fn attachment_ids(ts: &TestShell, s: SessionId, g: u64, id: &str) -> Vec<String> {
        let detail = serde_json::to_value(ts.shell.get_item(s, g, id).unwrap()).unwrap();
        detail["data"]["summary"]["attachments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| file["file_id"].as_str().unwrap().to_owned())
            .collect()
    }

    fn item_count(ts: &TestShell, s: SessionId, g: u64) -> usize {
        let items = serde_json::to_value(ts.shell.list_items(s, g).unwrap()).unwrap();
        items["data"]["items"].as_array().unwrap().len()
    }

    /// Stop an Add after bytes were written: `Cancelled`, the vault's folder byte for byte as it was (the partial blob
    /// the engine had begun is gone, no item was added), and the session still works: the same file adds afterwards.
    #[test]
    fn stopped_add_after_a_partial_write_leaves_the_vault_as_it_was() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        ts.stored_file(s, g, "existing.pdf", b"already here");
        let vault_dir = ts.shell.registry.entries()[0].1.clone();
        let before = files_under(&vault_dir);
        let items = item_count(&ts, s, g);
        let source = big_source(&ts, "big.bin");

        let stopped = stop_once_bytes_are_written(&ts, vault_dir.clone());
        ts.dialogs.answer(Some(source.clone()));
        let answer = ts.shell.add_file(s, g, None, 51);
        assert_eq!(answer.err(), Some(ShellError::Cancelled));

        assert!(stopped.done.load(std::sync::atomic::Ordering::SeqCst) > 0);
        let during = stopped.folder.lock().unwrap().take().unwrap();
        assert_ne!(
            during, before,
            "no partial blob was there when it was stopped"
        );
        assert_eq!(files_under(&vault_dir), before, "a partial blob was left");
        assert_eq!(item_count(&ts, s, g), items, "an item was added");
        let last = ts.events.progress().pop().unwrap();
        assert_eq!(last["finished"], json!(true));

        ts.events.watch(|_, _| {});
        ts.dialogs.answer(Some(source));
        let added = ts.shell.add_file(s, g, None, 52).unwrap();
        assert!(matches!(added.data, Outcome::Done(_)));
        assert_eq!(item_count(&ts, s, g), items + 1);
    }

    /// The same for Attach: the item keeps its one file, the folder is as it was, and attaching works afterwards.
    #[test]
    fn stopped_attach_after_a_partial_write_leaves_the_item_as_it_was() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let (id, file_id) = ts.stored_file(s, g, "existing.pdf", b"already here");
        let vault_dir = ts.shell.registry.entries()[0].1.clone();
        let before = files_under(&vault_dir);
        let source = big_source(&ts, "big.bin");

        let stopped = stop_once_bytes_are_written(&ts, vault_dir.clone());
        ts.dialogs.answer(Some(source.clone()));
        let answer = ts.shell.attach_file(s, g, &id, 53);
        assert_eq!(answer.err(), Some(ShellError::Cancelled));

        assert!(stopped.done.load(std::sync::atomic::Ordering::SeqCst) > 0);
        let during = stopped.folder.lock().unwrap().take().unwrap();
        assert_ne!(
            during, before,
            "no partial blob was there when it was stopped"
        );
        assert_eq!(files_under(&vault_dir), before, "a partial blob was left");
        assert_eq!(
            attachment_ids(&ts, s, g, &id),
            std::slice::from_ref(&file_id)
        );

        ts.events.watch(|_, _| {});
        ts.dialogs.answer(Some(source));
        let attached = ts.shell.attach_file(s, g, &id, 54).unwrap();
        assert!(matches!(attached.data, Outcome::Done(_)));
        assert_eq!(attachment_ids(&ts, s, g, &id).len(), 2);
    }

    /// Stop a Save a copy after bytes were written, where nothing exists at the destination: no file and no partial
    /// beside it, the output journal clear, and the same copy saves afterwards.
    #[test]
    fn stopped_save_after_a_partial_write_leaves_no_file_and_no_partial() {
        let ts = TestShell::new();
        let (s, g, id, file_id, _) = with_destination(&ts);
        let folder = ts.folder("Fresh");
        let dest = folder.join("copy.pdf");

        let stopped = stop_once_bytes_are_written(&ts, folder.clone());
        ts.dialogs.answer(Some(dest.clone()));
        let answer = ts.shell.save_file_copy(s, g, &id, &file_id, 55);
        assert_eq!(answer.err(), Some(ShellError::Cancelled));

        assert!(stopped.done.load(std::sync::atomic::Ordering::SeqCst) > 0);
        let during = stopped.folder.lock().unwrap().take().unwrap();
        assert!(
            !during.is_empty(),
            "no partial file was there when it was stopped"
        );
        assert!(!dest.exists(), "a file was left");
        assert!(
            names(&folder).is_empty(),
            "a partial was left: {:?}",
            names(&folder)
        );
        assert!(ts.journal().is_empty(), "the output journal kept an entry");
        let last = ts.events.progress().pop().unwrap();
        assert_eq!(last["finished"], json!(true));

        ts.events.watch(|_, _| {});
        ts.dialogs.answer(Some(dest.clone()));
        let saved = ts.shell.save_file_copy(s, g, &id, &file_id, 56).unwrap();
        assert!(matches!(saved.data, Outcome::Done(())));
        assert_eq!(fs::read(&dest).unwrap(), stored_bytes());
    }

    /// Stop a Save a copy after bytes were written, onto a destination that exists: it stays byte for byte as it was,
    /// with no partial beside it, and the vault's folder is unchanged (nothing decrypted is left anywhere).
    #[test]
    fn stopped_save_after_a_partial_write_keeps_an_existing_destination() {
        let ts = TestShell::new();
        let (s, g, id, file_id, dest) = with_destination(&ts);
        let vault_dir = ts.shell.registry.entries()[0].1.clone();
        let vault_before = files_under(&vault_dir);
        let folder = dest.parent().unwrap().to_path_buf();

        let stopped = stop_once_bytes_are_written(&ts, folder.clone());
        ts.dialogs.answer(Some(dest.clone()));
        let answer = ts.shell.save_file_copy(s, g, &id, &file_id, 57);
        assert_eq!(answer.err(), Some(ShellError::Cancelled));

        assert!(stopped.done.load(std::sync::atomic::Ordering::SeqCst) > 0);
        untouched(&dest);
        assert!(ts.journal().is_empty(), "the output journal kept an entry");
        assert_eq!(files_under(&vault_dir), vault_before);
        assert!(!ts.shell.paths.open.exists() || names(&ts.shell.paths.open).is_empty());

        ts.events.watch(|_, _| {});
        ts.dialogs.answer(Some(dest.clone()));
        let saved = ts.shell.save_file_copy(s, g, &id, &file_id, 58).unwrap();
        assert!(matches!(saved.data, Outcome::Done(())));
        assert_eq!(fs::read(&dest).unwrap(), stored_bytes());
    }

    /// Replace file and Open are jobs in the shell's table (they pause the idle lock and a lock stops them) but tell
    /// the page nothing of their own: no `job-started`, no progress.
    #[test]
    fn open_and_replace_are_jobs_without_events() {
        let ts = TestShell::new();
        let (s, g, id, file_id, _) = with_destination(&ts);
        let source = ts.temp.path().join("new.pdf");
        fs::write(&source, b"new").unwrap();
        ts.dialogs.answer(Some(source));
        let replaced = ts.shell.replace_file(s, g, &id, &file_id).unwrap();
        let Outcome::Done(new_file) = replaced.data else {
            panic!("not replaced");
        };
        let opened = ts.shell.open_file(s, g, &id, &new_file, false).unwrap();
        assert!(matches!(opened.data, Outcome::Done(())));
        assert!(ts.events.job_events().is_empty());
        let busy = ts.events.busy();
        assert!(busy.contains(&(Some(s), vec!["import"])), "{busy:?}");
    }

    /// The five commands' bodies: the four that gained a `request` need it (a `u32`), and `replace_file` and `open_file`
    /// still refuse one.
    #[test]
    fn request_is_required_by_the_four_and_refused_by_the_rest() {
        let id = "0123456789abcdef0123456789abcdef";
        let with = |mut body: Value, request: Value| {
            body["request"] = request;
            body
        };
        let copy = json!({ "session": 1, "generation": 1, "id": id, "file_id": id });
        let add = json!({ "session": 1, "generation": 1, "collection": null });
        let attach = json!({ "session": 1, "generation": 1, "id": id });
        let confirm = json!({ "token": id });
        fn parses<T: serde::de::DeserializeOwned>(body: &Value) -> bool {
            parse::<T>(&InvokeBody::Json(body.clone())).is_ok()
        }
        macro_rules! needs_request {
            ($ty:ty, $body:expr) => {
                assert!(!parses::<$ty>(&$body), "accepted without a request");
                assert!(parses::<$ty>(&with($body.clone(), json!(5))));
                assert!(parses::<$ty>(&with($body.clone(), json!(0))));
                assert!(parses::<$ty>(&with($body.clone(), json!(u32::MAX))));
                for bad in [
                    json!(-1),
                    json!(4294967296u64),
                    json!("5"),
                    json!(1.5),
                    json!(null),
                ] {
                    assert!(
                        !parses::<$ty>(&with($body.clone(), bad.clone())),
                        "accepted request {bad}"
                    );
                }
            };
        }
        needs_request!(SaveCopyArgs, copy);
        needs_request!(AddFile, add);
        needs_request!(AttachFile, attach);
        needs_request!(ConfirmCopy, confirm);
        // `replace_file` shares `copy`'s body without a request.
        assert!(parses::<FileArgs>(&copy));
        assert!(!parses::<FileArgs>(&with(copy, json!(5))));
    }

    fn refuses_a_path<T: serde::de::DeserializeOwned>(body: Value) {
        assert!(
            parse::<T>(&InvokeBody::Json(body.clone())).is_ok(),
            "{body}"
        );
        let mut sneaked = body;
        sneaked["path"] = json!("SENTINEL-7f3a");
        assert_eq!(
            parse::<T>(&InvokeBody::Json(sneaked)).err(),
            Some(MALFORMED)
        );
    }

    #[test]
    fn request_with_a_path_field_refused() {
        let id = "0123456789abcdef0123456789abcdef";
        // `replace_file`, and `save_file_copy` with its `request`.
        refuses_a_path::<FileArgs>(
            json!({ "session": 1, "generation": 1, "id": id, "file_id": id }),
        );
        refuses_a_path::<SaveCopyArgs>(
            json!({ "session": 1, "generation": 1, "id": id, "file_id": id, "request": 1 }),
        );
        refuses_a_path::<ConfirmCopy>(json!({ "token": id, "request": 1 }));
        refuses_a_path::<AddFile>(
            json!({ "session": 1, "generation": 1, "collection": null, "request": 1 }),
        );
        refuses_a_path::<AttachFile>(
            json!({ "session": 1, "generation": 1, "id": id, "request": 1 }),
        );
        refuses_a_path::<OpenFile>(json!({
            "session": 1, "generation": 1, "id": id, "file_id": id, "confirmed_executable": false
        }));
        // `reset_output_journal` and `retry_open_cleanup`.
        refuses_a_path::<NoArgs>(json!({}));
    }
}
