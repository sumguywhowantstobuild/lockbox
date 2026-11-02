//! Files in a vault (spec §7.2, §4.1): adding or replacing a stored file, Save a copy and Open. Every path comes from a
//! dialog Rust opens inside the command, outside every lock, or from the shell itself; the page sends IDs only.

use std::path::Path;
use std::sync::Arc;

use lockbox_core::blob::{CancelToken, OutputJournal};
use lockbox_core::ids::{FileId, ItemId};
use lockbox_core::{CoreError, Result as CoreResult, Vault};
use serde::Deserialize;
use tauri::State;
use tauri::ipc::Request;

use super::{NoArgs, args, blocking};
use crate::error::{Confirm, Outcome, ShellError, ShellResult};
use crate::open::{RemoveReport, is_executable, safe_name};
use crate::session::{SessionId, Tagged, VaultRef};
use crate::shell::Shell;

/// The long operations' names in `lockbox://busy`.
const SAVE_COPY: &str = "save_copy";
const IMPORT: &str = "import";
const OPEN: &str = "open";

impl Shell {
    /// Saves a decrypted copy of the stored file `file_id` of the item `id` where the user picks (spec §7.2). Refused
    /// first while the output journal is damaged. The save dialog opens outside every lock, suggesting the stored
    /// name; Windows asks there before replacing an existing file, so its answer is final. Then, in a long operation:
    /// the engine's export, its temp written down in the output journal before it exists and each rename attempt
    /// only while the session is still unlocked in `generation`. An existing destination is touched only by the
    /// rename of a copy that has fully verified. `Dismissed` when the dialog is closed; `Locked` for a lock at any
    /// point.
    pub fn save_file_copy(
        &self,
        session: SessionId,
        generation: u64,
        id: &str,
        file_id: &str,
    ) -> ShellResult<Tagged<Outcome<()>>> {
        let (id, file_id) = (ItemId::from_hex(id)?, FileId::from_hex(file_id)?);
        self.outputs.usable()?;
        let name = self.stored_name(session, generation, &id, &file_id)?;
        let Some(dest) = self.os.dialogs.save_file("Save a copy", &name, None) else {
            return self.still_current(session, generation, Outcome::Dismissed);
        };
        let dest = self.output_destination(&dest)?;
        self.sessions
            .read_long(session, generation, |vault, cancel| {
                let _operation = self
                    .autolock
                    .begin(Some(session), SAVE_COPY, cancel.clone());
                let journal = self.outputs.for_call(&self.sessions, session, generation);
                let saved = export(vault, &id, &file_id, &dest, &journal, cancel);
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
                let _operation = self.autolock.begin(Some(session), OPEN, cancel.clone());
                // The app is closing: no new folder.
                if cancel.is_cancelled() {
                    return Err(ShellError::Cancelled);
                }
                let folder = self.open_folders.create(session, generation)?;
                let copy = folder.join(&name);
                made = Some(folder);
                let journal = self.outputs.for_call(&self.sessions, session, generation);
                let exported = export(vault, &id, &file_id, &copy, &journal, cancel);
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

    /// Adds a file item, in `collection` or none, holding a file the user picks: the new item's ID.
    pub fn add_file(
        &self,
        session: SessionId,
        generation: u64,
        collection: Option<String>,
    ) -> ShellResult<Tagged<Outcome<String>>> {
        let collection = collection.as_deref().map(ItemId::from_hex).transpose()?;
        self.import(
            session,
            generation,
            "Add a file",
            |vault, source, cancel| Ok(vault.new_file_item(collection, source, cancel)?.to_hex()),
        )
    }

    /// Attaches a file the user picks to the item `id`: the new file's ID.
    pub fn attach_file(
        &self,
        session: SessionId,
        generation: u64,
        id: &str,
    ) -> ShellResult<Tagged<Outcome<String>>> {
        let id = ItemId::from_hex(id)?;
        self.import(
            session,
            generation,
            "Attach a file",
            |vault, source, cancel| Ok(vault.attach_file(&id, source, cancel)?.to_hex()),
        )
    }

    /// Replaces the stored file `file_id` of the item `id` with a file the user picks: the new file's ID. The old
    /// file stays in the vault until cleanup removes it (spec §6.4).
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
            |vault, source, cancel| {
                Ok(vault
                    .replace_attachment(&id, &file_id, source, cancel)?
                    .to_hex())
            },
        )
    }

    /// An import: refused before the dialog when the session is locked or read-only; the open dialog (titled `title`)
    /// outside every lock; then `store` in a long change, cancelled by a lock, Windows lock, sleep or the app closing
    /// (the engine removes its partial blob). Imports write no decrypted output, so a damaged output journal does not
    /// stop them.
    fn import(
        &self,
        session: SessionId,
        generation: u64,
        title: &str,
        store: impl FnOnce(&mut Vault, &Path, &CancelToken) -> CoreResult<String>,
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
                let _operation = self.autolock.begin(Some(session), IMPORT, cancel.clone());
                Ok(Outcome::Done(store(vault, &source, cancel)?))
            })
    }

    /// `data` tagged with `generation`, once the session is checked to be still unlocked in it (spec §7.4): `Locked`
    /// otherwise.
    fn still_current<T>(
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
) -> CoreResult<()> {
    match vault {
        VaultRef::Writable(vault) => vault.export_file(id, file_id, dest, journal, cancel),
        VaultRef::ReadOnly(vault) => vault.export_file(id, file_id, dest, journal, cancel),
    }
}

/// `save_file_copy` and `replace_file`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileArgs {
    session: SessionId,
    generation: u64,
    id: String,
    file_id: String,
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
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AttachFile {
    session: SessionId,
    generation: u64,
    id: String,
}

#[tauri::command]
pub(super) async fn save_file_copy(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<Outcome<()>>> {
    let FileArgs {
        session,
        generation,
        id,
        file_id,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.save_file_copy(session, generation, &id, &file_id)).await
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
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.add_file(session, generation, collection)).await
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
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.attach_file(session, generation, &id)).await
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

    use lockbox_core::internals::fsio::failpoint;
    use lockbox_core::internals::fsio::testutil::{make_dir_link, names};
    use serde_json::{Value, json};
    use tauri::ipc::InvokeBody;

    use super::super::{MALFORMED, parse};
    use super::*;
    use crate::error::ShellError;
    use crate::outputs::Attempt;
    use crate::session::LockReason;
    use crate::testing::{TestShell, quiet};

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
        let saved = ts.shell.save_file_copy(s, g, &id, &file_id);
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
        let saved = ts.shell.save_file_copy(s, g, &id, &file_id);
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
        let saved = ts.shell.save_file_copy(s, g, &id, &file_id);
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
            shell.save_file_copy(s, g, &id, &file_id)
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
        assert_eq!(ts.shell.save_file_copy(s, g, &id, &file_id).err(), LOCKED);
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
        assert_eq!(ts.shell.save_file_copy(s, g, &id, &file_id).err(), LOCKED);
        untouched(&dest);
        assert!(!ts.shell.paths.outputs.exists(), "no journal change");

        let (s, g) = ts.open_vault("Work");
        let source = ts.temp.path().join("statement.pdf");
        fs::write(&source, b"statement").unwrap();
        lock_in_dialog();
        ts.dialogs.answer(Some(source));
        assert_eq!(ts.shell.add_file(s, g, None).err(), LOCKED);
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
        dismissed(ts.shell.save_file_copy(s, g, &id, &file_id), s, g);
        dismissed(ts.shell.add_file(s, g, None), s, g);
        dismissed(ts.shell.attach_file(s, g, &id), s, g);
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
                ts.shell.save_file_copy(s, g, &id, &file_id).err(),
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
        let id = done(ts.shell.add_file(s, g, None).unwrap());
        source("scan.png", b"two");
        let second = done(ts.shell.attach_file(s, g, &id).unwrap());
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
        let saved = ts.shell.save_file_copy(s, g, &id, &third).unwrap();
        assert!(matches!(saved.data, Outcome::Done(())));
        assert_eq!(fs::read(&dest).unwrap(), b"three");
        let busy = ts.events.busy();
        assert!(busy.contains(&(Some(s), vec!["import"])), "{busy:?}");
        assert!(busy.contains(&(Some(s), vec!["save_copy"])), "{busy:?}");
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
        // `save_file_copy` and `replace_file`.
        refuses_a_path::<FileArgs>(
            json!({ "session": 1, "generation": 1, "id": id, "file_id": id }),
        );
        refuses_a_path::<AddFile>(json!({ "session": 1, "generation": 1, "collection": null }));
        refuses_a_path::<AttachFile>(json!({ "session": 1, "generation": 1, "id": id }));
        refuses_a_path::<OpenFile>(json!({
            "session": 1, "generation": 1, "id": id, "file_id": id, "confirmed_executable": false
        }));
        // `reset_output_journal` and `retry_open_cleanup`.
        refuses_a_path::<NoArgs>(json!({}));
    }
}
