//! Many files into a vault at once (spec §7.2; plan 4B, task 10). The picker opens inside the command and its paths stay
//! in Rust, in one choice per pick session ([`PendingChoice::PickedFiles`]); the page sees names and sizes, and sends
//! the choice's token back. `add_files` is one job for the whole batch (one operation, one bar over every file's bytes
//! together), but each file is its own change of the vault, and the vault is let go between two files, so a read (a
//! search) is answered during the batch and a lock lands within one file.

use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;

use lockbox_core::blob::{CancelToken, Progress};
use lockbox_core::ids::ItemId;
use lockbox_core::{CoreError, Result as CoreResult, Vault};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Request;

use super::batch::{BatchProgress, RELEASE_GAP};
use super::{args, blocking};
use crate::error::{Outcome, ShellError, ShellResult};
use crate::jobs::{JobKind, JobScope, RunningJob};
use crate::pending::{PendingChoice, Token};
use crate::session::{SessionId, Tagged, VaultRef};
use crate::shell::Shell;

/// The title of the picker, for the first pick and Pick more alike.
const PICK_TITLE: &str = "Add files";

/// A picked file as the page lists it: its name (no folder) and its size now.
#[derive(Serialize)]
pub struct PickedFile {
    pub name: String,
    pub size: u64,
}

/// The answer of a first pick: the choice's token and what was picked.
#[derive(Serialize)]
pub struct PickedFiles {
    pub choice: Token,
    pub files: Vec<PickedFile>,
}

/// The list as it is now, after a file was removed from it.
#[derive(Serialize)]
pub struct PickedList {
    pub files: Vec<PickedFile>,
}

/// Where the files go: a new item each, in a folder (or none), or onto one item.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum AddInto {
    Folder { collection: Option<String> },
    Item { id: String },
}

/// What a batch did. `added` files went in whole; `failed` could not be read, or were no longer the size measured, when their turn came (named, and the batch
/// went on); `not_added` were never put in because the batch stopped, in the order picked, the one being written when it
/// stopped included (the engine leaves nothing of it); `stopped` says what ended the batch early, `None` when it ran to
/// the end. Names only: the page never gets a path.
#[derive(Serialize)]
pub struct AddFilesView {
    pub added: u32,
    pub failed: Vec<String>,
    pub not_added: Vec<String>,
    pub stopped: Option<ShellError>,
}

/// [`AddInto`] with its IDs parsed.
enum Target {
    Folder(Option<ItemId>),
    Item(ItemId),
}

impl AddInto {
    fn parse(self) -> ShellResult<Target> {
        Ok(match self {
            AddInto::Folder { collection } => {
                Target::Folder(collection.as_deref().map(ItemId::from_hex).transpose()?)
            }
            AddInto::Item { id } => Target::Item(ItemId::from_hex(&id)?),
        })
    }
}

/// One picked file as the batch holds it: where it is, the name the page was shown, and its size when the batch began
/// (`None`: it could not be opened then). That size is the one the space check, the total and the bar use for the file:
/// a file that is not that size at its turn is not put in.
struct Entry {
    /// Its place in the batch.
    index: usize,
    path: PathBuf,
    name: String,
    size: Option<u64>,
}

impl Entry {
    /// The size measured at the start, if the file is still readable and still exactly that big.
    fn unchanged(&self) -> Option<u64> {
        self.size.filter(|&size| probe(&self.path) == Some(size))
    }
}

/// What became of one file.
enum Step {
    Added,
    Failed,
    /// The batch ends here, with this refusal.
    Stopped(ShellError),
}

/// What one try at putting a file in came to, inside the vault's change.
enum Tried {
    /// It went in, at this measured size.
    Imported(u64),
    /// The source could not be opened, was not the size measured, or stopped being readable as the engine opened it:
    /// the file's failure, not the vault's.
    SourceGone,
}

/// The file's name for the page: its last part, as the engine will name the stored file.
fn name_of(path: &Path) -> String {
    path.file_name().map_or_else(
        || "file".to_owned(),
        |name| name.to_string_lossy().into_owned(),
    )
}

/// The size of the file at `path` as the engine will open it (read, others may read, none may write): `None` when it
/// cannot be opened or is not a file (deleted, held open by another program, a folder).
fn probe(path: &Path) -> Option<u64> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 1;
        options.share_mode(FILE_SHARE_READ);
    }
    let meta = options.open(path).ok()?.metadata().ok()?;
    #[cfg(test)]
    if let Some(size) = PRETEND_SIZES.with(|sizes| sizes.borrow().get(path).copied()) {
        return meta.is_file().then_some(size);
    }
    meta.is_file().then_some(meta.len())
}

/// How big a picked file shows in the list: its size now, 0 for one that cannot be measured (it is named in the summary
/// when its turn comes).
fn shown_size(path: &Path) -> u64 {
    fs::metadata(path)
        .ok()
        .filter(|meta| meta.is_file())
        .map_or(0, |meta| meta.len())
}

fn listed(paths: &[PathBuf]) -> Vec<PickedFile> {
    paths
        .iter()
        .map(|path| PickedFile {
            name: name_of(path),
            size: shown_size(path),
        })
        .collect()
}

impl Shell {
    /// Opens the picker (outside every lock) for the files to add to the session's vault. Without a `choice` it opens a new
    /// choice, kept under a token, and answers it with the list picked, or `Dismissed` when the picker is closed. With
    /// one, Pick more: the files picked now are added to the end of the same choice, under the same token and a new five
    /// minutes, and the whole list is answered; a closed picker answers the list as it was. Refused before the picker
    /// opens for a stale generation (`Locked`), a session that is not ours (`NotFound`), a read-only session (`ReadOnly`)
    /// and a choice that is gone (`ChoiceExpired`). The same file picked twice is in twice.
    pub fn pick_files_to_add(
        &self,
        session: SessionId,
        generation: u64,
        choice: Option<&Token>,
    ) -> ShellResult<Tagged<Outcome<PickedFiles>>> {
        self.require_writable(session, generation)?;
        let pending = self.sessions.pending();
        if let Some(choice) = choice {
            pending.peek_picked(choice, session, generation)?;
        }
        let more = self
            .os
            .dialogs
            .pick_files(PICK_TITLE, None)
            .filter(|paths| !paths.is_empty());
        let (token, paths, new) = match (choice, more) {
            (None, None) => return self.still_current(session, generation, Outcome::Dismissed),
            (None, Some(paths)) => {
                let token = pending.put(PendingChoice::PickedFiles {
                    session,
                    generation,
                    paths: paths.clone(),
                });
                (token, paths, true)
            }
            (Some(choice), more) => {
                let paths = pending.update_picked(choice, session, generation, |list| {
                    list.extend(more.unwrap_or_default());
                    Ok(list.clone())
                })?;
                (choice.clone(), paths, false)
            }
        };
        let files = listed(&paths);
        let answer = Outcome::Done(PickedFiles {
            choice: token.clone(),
            files,
        });
        self.still_current(session, generation, answer)
            .inspect_err(|_| {
                // A lock came while the picker was open: what was just parked is no one's.
                if new {
                    let _ = pending.take_picked(&token, session, generation, &paths);
                }
            })
    }

    /// Takes the picked file at `index` out of the choice and answers the list as it is now. `InvalidInput` for an index
    /// past the end, with the list as it was.
    pub fn remove_picked_file(
        &self,
        session: SessionId,
        generation: u64,
        choice: &Token,
        index: u32,
    ) -> ShellResult<Tagged<Outcome<PickedList>>> {
        self.require_writable(session, generation)?;
        let paths = self
            .sessions
            .pending()
            .update_picked(choice, session, generation, |list| {
                let at = usize::try_from(index)
                    .ok()
                    .filter(|&at| at < list.len())
                    .ok_or(ShellError::InvalidInput { what: "index" })?;
                list.remove(at);
                Ok(list.clone())
            })?;
        let files = listed(&paths);
        self.still_current(session, generation, Outcome::Done(PickedList { files }))
    }

    /// Puts the files of the choice into the vault, in the order picked, as one job the page's `request` names, with
    /// progress over the whole batch's bytes and one Stop.
    ///
    /// Before the job, and refused with nothing started and the choice kept: the session checks of the other two
    /// commands; a bad `into`; `ChoiceExpired`; and the vault's own checks for the whole batch together (a file over 256
    /// GiB, one the file system cannot hold, too little free space for all of it, with the numbers; unknown free space
    /// goes ahead). Then the choice is used up and the job starts.
    ///
    /// Each file is its own change of the vault (`Busy` at once if another command has it, tried again for 30 seconds by
    /// the shell's clock, between files only), and the vault is let go for a moment after each one. A file that cannot be
    /// read when its turn comes is named in `failed`; the batch goes on. A Stop, a full drive, a vault that stays busy or
    /// any other refusal of the vault ends the batch: the files before it are in, the one being written is not (the engine
    /// leaves nothing of it), and it and every file after are named in `not_added`, with the refusal in `stopped`. A lock
    /// is the one exception: like every command, the answer is `Locked`.
    pub fn add_files(
        &self,
        session: SessionId,
        generation: u64,
        choice: &Token,
        into: AddInto,
        request: u32,
    ) -> ShellResult<Tagged<Outcome<AddFilesView>>> {
        let target = into.parse()?;
        self.require_writable(session, generation)?;
        let pending = self.sessions.pending();
        let paths = pending.peek_picked(choice, session, generation)?;
        // Measured now, and again at each file's turn: the list shown at the pick may be old.
        let entries: Vec<Entry> = paths
            .iter()
            .enumerate()
            .map(|(index, path)| Entry {
                index,
                path: path.clone(),
                name: name_of(path),
                size: probe(path),
            })
            .collect();
        let sizes: Vec<u64> = entries.iter().filter_map(|entry| entry.size).collect();
        let total = sizes
            .iter()
            .fold(0u64, |sum, size| sum.saturating_add(*size));
        let parent = self
            .sessions
            .read(session, generation, |vault, cancel| match vault {
                VaultRef::Writable(vault) => {
                    vault.check_import_space(&sizes)?;
                    Ok(cancel.clone())
                }
                VaultRef::ReadOnly(_) => Err(ShellError::ReadOnly),
            })?
            .data;
        pending.take_picked(choice, session, generation, &paths)?;

        let scope = JobScope::Session {
            session,
            generation,
        };
        let job = self
            .autolock
            .begin_job(scope, JobKind::Import, &parent, Some(request));
        let progress = BatchProgress::new(job.progress(), total);
        let mut view = AddFilesView {
            added: 0,
            failed: Vec::new(),
            not_added: Vec::new(),
            stopped: None,
        };
        for entry in &entries {
            let index = entry.index;
            #[cfg(test)]
            reached("file_start", index);
            let step = match job.token().is_cancelled() {
                true => Step::Stopped(self.cancelled_or_locked(session, generation)?),
                false => self.put_in(session, generation, &job, &target, entry, &progress)?,
            };
            match step {
                Step::Added => view.added += 1,
                Step::Failed => view.failed.push(entry.name.clone()),
                Step::Stopped(error) => {
                    view.stopped = Some(error);
                    view.not_added
                        .extend(entries[index..].iter().map(|entry| entry.name.clone()));
                    break;
                }
            }
            #[cfg(test)]
            reached("file_done", index);
            // The vault is free now: a read that has been waiting gets in before the next file takes it again.
            if index + 1 < entries.len() {
                thread::sleep(RELEASE_GAP);
            }
        }
        // The job ends here, so its last progress event goes out before the answer.
        drop(job);
        self.still_current(session, generation, Outcome::Done(view))
    }

    /// One file of a batch, at its turn: opened once more as the engine will, and put in only if it is still the size it
    /// was measured at (a file that cannot be opened, or has changed size, is `Failed`, passed over in the bar), as a
    /// change of its own. `Busy` is tried again for [`BUSY_WAIT`] by the shell's clock (a Stop ends the wait). The file
    /// is looked at again inside the change, when the vault is the batch's and the engine is about to open it, so a file
    /// that went during the wait is `Failed` too, and so is one the engine could not open or read when the file is no
    /// longer as measured then. What ends the whole command (a lock, a session that is gone) is the error; anything else
    /// the vault refuses with ends the batch as [`Step::Stopped`].
    fn put_in(
        &self,
        session: SessionId,
        generation: u64,
        job: &RunningJob,
        target: &Target,
        entry: &Entry,
        progress: &BatchProgress<'_>,
    ) -> ShellResult<Step> {
        // Not worth waiting for the vault with a file that has already gone.
        if entry.unchanged().is_none() {
            progress.passed_over(entry.size.unwrap_or(0));
            return Ok(Step::Failed);
        }
        // `Busy` (another command has the vault) is waited out by the batches' shared wait.
        let result = self.when_free(
            job,
            |retries| {
                #[cfg(test)]
                reached("busy_retry", retries);
                #[cfg(not(test))]
                let _ = retries;
            },
            || {
                let tried = self.sessions.write_long(session, generation, |vault, _| {
                    // The vault is ours now: the file is checked against its measured size once more, and the engine
                    // opens it right after.
                    let Some(size) = entry.unchanged() else {
                        return Ok(Tried::SourceGone);
                    };
                    progress.begin_file(size);
                    #[cfg(test)]
                    reached("import_open", entry.index);
                    match store(vault, target, &entry.path, job.token(), progress) {
                        Ok(()) => Ok(Tried::Imported(size)),
                        // The engine opens the source itself, so a failure to open or read it comes back as one of
                        // these; told from the vault's own by looking at the file again.
                        Err(CoreError::Io(_) | CoreError::InvalidInput { .. })
                            if entry.unchanged().is_none() =>
                        {
                            Ok(Tried::SourceGone)
                        }
                        Err(error) => Err(error.into()),
                    }
                });
                tried.map(|tagged| tagged.data)
            },
        );
        match result {
            Ok(Tried::Imported(size)) => {
                progress.finished_file(size);
                Ok(Step::Added)
            }
            Ok(Tried::SourceGone) => {
                progress.passed_over(entry.size.unwrap_or(0));
                Ok(Step::Failed)
            }
            Err(error @ (ShellError::Locked | ShellError::NotFound | ShellError::ReadOnly)) => {
                Err(error)
            }
            Err(ShellError::Cancelled) => Ok(Step::Stopped(
                self.cancelled_or_locked(session, generation)?,
            )),
            Err(error) => Ok(Step::Stopped(error)),
        }
    }

    /// Refuses a session that is stale, not ours or read-only, before anything else.
    fn require_writable(&self, session: SessionId, generation: u64) -> ShellResult<()> {
        self.sessions
            .read(session, generation, |vault, _| match vault {
                VaultRef::Writable(_) => Ok(()),
                VaultRef::ReadOnly(_) => Err(ShellError::ReadOnly),
            })
            .map(|_| ())
    }
}

/// The engine's import of one file: a new item in a folder, or one more file on an item.
fn store(
    vault: &mut Vault,
    target: &Target,
    path: &Path,
    cancel: &CancelToken,
    progress: &dyn Progress,
) -> CoreResult<()> {
    match target {
        Target::Folder(collection) => vault
            .new_file_item(*collection, path, cancel, progress)
            .map(drop),
        Target::Item(id) => vault.attach_file(id, path, cancel, progress).map(drop),
    }
}

/// `pick_files_to_add`: no `choice` for a first pick, the choice's token for Pick more.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PickFilesArgs {
    session: SessionId,
    generation: u64,
    choice: Option<Token>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoveArgs {
    session: SessionId,
    generation: u64,
    choice: Token,
    index: u32,
}

/// `add_files`: a job the page numbered with `request`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AddFilesArgs {
    session: SessionId,
    generation: u64,
    choice: Token,
    into: AddInto,
    request: u32,
}

#[tauri::command]
pub(super) async fn pick_files_to_add(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<Outcome<PickedFiles>>> {
    let PickFilesArgs {
        session,
        generation,
        choice,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.pick_files_to_add(session, generation, choice.as_ref())).await
}

#[tauri::command]
pub(super) async fn remove_picked_file(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<Outcome<PickedList>>> {
    let RemoveArgs {
        session,
        generation,
        choice,
        index,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.remove_picked_file(session, generation, &choice, index)).await
}

#[tauri::command]
pub(super) async fn add_files(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<Outcome<AddFilesView>>> {
    let AddFilesArgs {
        session,
        generation,
        choice,
        into,
        request,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.add_files(session, generation, &choice, into, request)).await
}

/// Tests only: hooks run when a batch reaches a step on this thread (`file_start` and `file_done`, with the file's place
/// in the batch; `busy_retry`, with the number of tries so far), and sizes a file is pretended to have.
#[cfg(test)]
type StepHook = Box<dyn FnMut(usize)>;

#[cfg(test)]
thread_local! {
    static STEPS: std::cell::RefCell<Vec<(&'static str, StepHook)>> =
        const { std::cell::RefCell::new(Vec::new()) };
    static PRETEND_SIZES: std::cell::RefCell<std::collections::HashMap<PathBuf, u64>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

/// Tests only: runs `hook` each time this thread reaches `step`.
#[cfg(test)]
fn at(step: &'static str, hook: impl FnMut(usize) + 'static) {
    STEPS.with(|steps| steps.borrow_mut().push((step, Box::new(hook))));
}

/// Tests only: the point `step` is reached. The hooks run with the list free, so one may add another.
#[cfg(test)]
fn reached(step: &'static str, index: usize) {
    let mut hooks = STEPS.with(|steps| std::mem::take(&mut *steps.borrow_mut()));
    for (name, hook) in &mut hooks {
        if *name == step {
            hook(index);
        }
    }
    STEPS.with(|steps| {
        let mut steps = steps.borrow_mut();
        hooks.append(&mut steps);
        *steps = hooks;
    });
}

/// Tests only: the file at `path` is `size` bytes to the batch (a file over 256 GiB cannot be made).
#[cfg(test)]
fn pretend_size(path: &Path, size: u64) {
    PRETEND_SIZES.with(|sizes| sizes.borrow_mut().insert(path.to_path_buf(), size));
}

/// Tests only: forgets every hook and pretended size of this thread.
#[cfg(test)]
fn forget_test_steps() {
    STEPS.with(|steps| steps.borrow_mut().clear());
    PRETEND_SIZES.with(|sizes| sizes.borrow_mut().clear());
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::fs::{self, OpenOptions};
    use std::os::windows::fs::OpenOptionsExt;
    use std::path::PathBuf;
    use std::rc::Rc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, mpsc};
    use std::thread;
    use std::time::{Duration, Instant};

    use lockbox_core::blob::{CancelToken, MAX_FILE_BYTES, NoProgress};
    use lockbox_core::internals::blob::blob_len;
    use lockbox_core::internals::fsio::{VolumeInfo, set_volume_override};
    use lockbox_core::{Credential, ReadOnlyVault};
    use serde_json::{Value, json};
    use tauri::ipc::InvokeBody;
    use zeroize::Zeroizing;

    use super::super::items::NewKind;
    use super::super::{MALFORMED, parse};
    use super::*;
    use crate::jobs::{JobScope, OperationId};
    use crate::os::Clock;
    use crate::session::{Location, LockReason, OpenStep, Opened};
    use crate::shell::PROGRESS_EVENT;
    use crate::testing::{TEST_PASSWORD, TestShell, heavy};

    const MIB: u64 = 1024 * 1024;
    const GIB: u64 = 1024 * MIB;
    /// The slack the engine keeps free on top of what a write needs.
    const MARGIN: u64 = 64 * MIB;
    /// How long a test thread waits for another before it fails instead of hanging.
    const GIVE_UP: Duration = Duration::from_secs(60);
    const LOCKED: Option<ShellError> = Some(ShellError::Locked);
    const EXPIRED: Option<ShellError> = Some(ShellError::ChoiceExpired);

    /// Puts back what a test changed on its thread, whatever way it ends.
    struct Cleanup;
    impl Drop for Cleanup {
        fn drop(&mut self) {
            set_volume_override(None);
            forget_test_steps();
        }
    }

    const FOLDER: AddInto = AddInto::Folder { collection: None };

    /// Made-up files with these names and sizes, in a folder of the test's own: their paths.
    fn files(ts: &TestShell, specs: &[(&str, u64)]) -> Vec<PathBuf> {
        let dir = ts.temp.path().join("picked");
        fs::create_dir_all(&dir).unwrap();
        specs
            .iter()
            .map(|(name, size)| {
                let path = dir.join(name);
                let bytes: Vec<u8> = (0..*size).map(|i| (i % 251) as u8).collect();
                fs::write(&path, bytes).unwrap();
                path
            })
            .collect()
    }

    /// What the answer of a command that went through holds.
    fn done<T>(answer: ShellResult<Tagged<Outcome<T>>>) -> T {
        match answer.unwrap() {
            Tagged {
                data: Outcome::Done(data),
                ..
            } => data,
            _ => panic!("the command did not finish"),
        }
    }

    /// The batch's answer as the page receives it.
    fn view(answer: ShellResult<Tagged<Outcome<AddFilesView>>>) -> Value {
        serde_json::to_value(done(answer)).unwrap()
    }

    /// Picks `paths` as the first pick of a session: the choice and the list the page is shown.
    fn pick(ts: &TestShell, s: SessionId, g: u64, paths: &[PathBuf]) -> (Token, Value) {
        ts.dialogs.answer_files(Some(paths.to_vec()));
        let picked = done(ts.shell.pick_files_to_add(s, g, None));
        let list = serde_json::to_value(&picked.files).unwrap();
        (picked.choice, list)
    }

    /// The same token again: a token is spent by being sent, and the page keeps its own copy.
    fn again(token: &Token) -> Token {
        serde_json::from_value(serde_json::to_value(token).unwrap()).unwrap()
    }

    fn names(list: &Value) -> Vec<String> {
        list.as_array()
            .unwrap()
            .iter()
            .map(|file| file["name"].as_str().unwrap().to_owned())
            .collect()
    }

    fn item_count(ts: &TestShell, s: SessionId, g: u64) -> usize {
        let items = serde_json::to_value(ts.shell.list_items(s, g).unwrap()).unwrap();
        items["data"]["items"].as_array().unwrap().len()
    }

    /// The `.blob` files and the partial ones in the vault's `files` folder.
    fn blobs_and_partials(ts: &TestShell) -> (usize, usize) {
        let dir = ts.shell.registry.entries()[0].1.join("files");
        let mut found = (0, 0);
        for entry in fs::read_dir(dir).unwrap() {
            let name = entry.unwrap().file_name().to_string_lossy().into_owned();
            if name.ends_with(".partial") {
                found.1 += 1;
            } else if name.ends_with(".blob") {
                found.0 += 1;
            }
        }
        found
    }

    /// Another command using the vault: a thread inside a read of it, from just after file `file` of a batch is done
    /// until it is released.
    struct Holder(Held);

    /// What lets the holder go (a channel to it) and its thread.
    type Held = Rc<RefCell<Option<(mpsc::Sender<()>, thread::JoinHandle<()>)>>>;

    /// When each step of a batch was reached: its name, the file's place and the time.
    type Marks = Rc<RefCell<Vec<(&'static str, usize, Instant)>>>;

    impl Holder {
        fn start_after_file(ts: &TestShell, s: SessionId, g: u64, file: usize) -> Holder {
            let held = Held::default();
            let (shell, slot) = (Arc::downgrade(&ts.shell), Rc::clone(&held));
            let mut fired = false;
            at("file_done", move |index| {
                // Once: a later batch of the same test is not held.
                if index != file || std::mem::replace(&mut fired, true) {
                    return;
                }
                let shell = shell.upgrade().unwrap();
                let (ready, ready_rx) = mpsc::channel();
                let (release, release_rx) = mpsc::channel::<()>();
                let thread = thread::spawn(move || {
                    let _ = shell.sessions.read(s, g, |_, _| {
                        ready.send(()).unwrap();
                        let _ = release_rx.recv_timeout(GIVE_UP);
                        Ok(())
                    });
                });
                ready_rx
                    .recv_timeout(GIVE_UP)
                    .expect("the holder has the vault");
                *slot.borrow_mut() = Some((release, thread));
            });
            Holder(held)
        }

        /// Lets the vault go and waits for the thread to end.
        fn release(self) {
            if let Some((release, thread)) = self.0.borrow_mut().take() {
                let _ = release.send(());
                thread.join().unwrap();
            }
        }
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

    /// The job events of the one batch: its `job-started` and the progress events that followed it, in order.
    fn one_batch(ts: &TestShell, request: u32, total: u64) -> Vec<Value> {
        let started = ts.events.started();
        assert_eq!(started.len(), 1, "one operation for the whole batch");
        assert_eq!(started[0]["request"], json!(request));
        assert_eq!(started[0]["kind"], json!("import"));
        let operation = started[0]["operation"].as_u64().unwrap();
        let progress = ts.events.progress();
        assert!(
            progress.iter().all(|e| e["operation"] == json!(operation)
                && e["kind"] == json!("import")
                && e["scope"] == started[0]["scope"]
                && e["total"] == json!(total)),
            "{progress:?}"
        );
        let (last, earlier) = progress.split_last().unwrap();
        assert!(earlier.iter().all(|e| e["finished"] == json!(false)));
        assert_eq!(last["finished"], json!(true));
        let mut before = 0;
        for event in &progress {
            let done = event["done"].as_u64().unwrap();
            assert!(done >= before && done <= total, "{progress:?}");
            before = done;
        }
        progress
    }

    /// Makes every progress event the shell sends due: the clock stands still in tests, so a job's events are throttled
    /// away unless it moves on.
    fn keep_progress_flowing(ts: &TestShell) {
        let clock = Arc::clone(&ts.clock);
        ts.events.watch(move |name, _| {
            if name == PROGRESS_EVENT {
                clock.sleep(Duration::from_millis(150));
            }
        });
    }

    // The batch.

    /// The whole batch is one operation: one `job-started` for the page's request, and one bar over every file's bytes
    /// together, which grows past the first file's size into the second's and ends at the total.
    #[test]
    fn batch_is_one_operation_with_the_batch_total() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let sizes = [3 * MIB + 5, 2 * MIB, MIB + 1];
        let paths = files(
            &ts,
            &[
                ("a.bin", sizes[0]),
                ("b.bin", sizes[1]),
                ("c.bin", sizes[2]),
            ],
        );
        let (token, _) = pick(&ts, s, g, &paths);
        keep_progress_flowing(&ts);

        let answer = ts.shell.add_files(s, g, &token, FOLDER, 7);
        let answered = view(answer);
        assert_eq!(
            answered,
            json!({ "added": 3, "failed": [], "not_added": [], "stopped": null })
        );
        let total: u64 = sizes.iter().sum();
        let progress = one_batch(&ts, 7, total);
        let last = progress.last().unwrap();
        assert_eq!(
            (last["done"].clone(), last["total"].clone()),
            (json!(total), json!(total))
        );
        assert!(
            progress
                .iter()
                .any(|e| e["done"].as_u64().unwrap() > sizes[0] && e["finished"] == json!(false)),
            "the bar never went past the first file: {progress:?}"
        );
        assert_eq!(item_count(&ts, s, g), 3);
        assert_eq!(blobs_and_partials(&ts), (3, 0));
    }

    /// Each file is its own change of the vault, and between two of them it is let go for a short while: a read in
    /// another thread (search, which polls every 10 ms) gets in between files, not only after the batch.
    #[test]
    fn vault_is_released_between_files() {
        let _cleanup = Cleanup;
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let count = 6;
        let specs: Vec<(String, u64)> = (0..count)
            .map(|i| (format!("f{i}.bin"), 64 * 1024))
            .collect();
        let specs: Vec<(&str, u64)> = specs.iter().map(|(n, size)| (n.as_str(), *size)).collect();
        let paths = files(&ts, &specs);
        let (token, _) = pick(&ts, s, g, &paths);

        let marks: Marks = Rc::default();
        for step in ["file_start", "file_done"] {
            let marks = Rc::clone(&marks);
            at(step, move |index| {
                marks.borrow_mut().push((step, index, Instant::now()));
            });
        }
        // A search, over and over, from another thread.
        let reads = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let reader = {
            let (shell, reads, stop) =
                (Arc::clone(&ts.shell), Arc::clone(&reads), Arc::clone(&stop));
            thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    if shell.sessions.read(s, g, |_, _| Ok(())).is_ok() {
                        reads.lock().unwrap().push(Instant::now());
                    }
                    thread::sleep(Duration::from_millis(1));
                }
            })
        };

        let answered = view(ts.shell.add_files(s, g, &token, FOLDER, 1));
        stop.store(true, Ordering::SeqCst);
        reader.join().unwrap();
        assert_eq!(answered["added"], json!(count));

        let marks = marks.borrow();
        let at_of = |step: &str, index: usize| {
            marks
                .iter()
                .find(|(name, i, _)| *name == step && *i == index)
                .map(|(_, _, when)| *when)
                .unwrap_or_else(|| panic!("{step} {index} never reached"))
        };
        let reads = reads.lock().unwrap();
        let gaps_with_a_read = (0..count as usize - 1)
            .filter(|&i| {
                let (from, to) = (at_of("file_done", i), at_of("file_start", i + 1));
                reads.iter().any(|read| *read > from && *read < to)
            })
            .count();
        // One gap would do to show the vault is let go; two keep a busy PC from failing the test.
        assert!(
            gaps_with_a_read >= 2,
            "a read got in between only {gaps_with_a_read} of {} times",
            count - 1
        );
    }

    /// A Stop in the middle of the second file keeps the first (added, whole), drops the second (nothing of it is left:
    /// no partial blob, no item) and never tries the third. The answer says so, names both, and the choice is used up.
    #[test]
    fn stop_keeps_files_already_added_and_drops_the_one_in_progress() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let paths = files(
            &ts,
            &[("a.bin", 4 * MIB), ("b.bin", 4 * MIB), ("c.bin", 4 * MIB)],
        );
        let (token, _) = pick(&ts, s, g, &paths);

        let (shell, stopped) = (Arc::downgrade(&ts.shell), Arc::new(AtomicBool::new(false)));
        let clock = Arc::clone(&ts.clock);
        ts.events.watch(move |name, payload| {
            if name != PROGRESS_EVENT {
                return;
            }
            clock.sleep(Duration::from_millis(150));
            // The first MiB of the second file.
            if payload["done"].as_u64().unwrap() >= 5 * MIB && !stopped.swap(true, Ordering::SeqCst)
            {
                let operation = OperationId(payload["operation"].as_u64().unwrap());
                let scope: JobScope = serde_json::from_value(payload["scope"].clone()).unwrap();
                let shell = shell.upgrade().unwrap();
                shell.autolock.cancel_operation(operation, scope).unwrap();
            }
        });
        let answered = view(ts.shell.add_files(s, g, &again(&token), FOLDER, 3));
        assert_eq!(
            answered,
            json!({
                "added": 1,
                "failed": [],
                "not_added": ["b.bin", "c.bin"],
                "stopped": { "code": "cancelled" }
            })
        );
        ts.events.watch(|_, _| {});
        assert_eq!(item_count(&ts, s, g), 1);
        assert_eq!(blobs_and_partials(&ts), (1, 0), "a partial blob was left");
        let last = ts.events.progress().pop().unwrap();
        assert_eq!(last["finished"], json!(true));
        assert!(last["done"].as_u64().unwrap() < last["total"].as_u64().unwrap());
        assert_eq!(
            ts.shell.add_files(s, g, &token, FOLDER, 4).err(),
            EXPIRED,
            "the choice was used up when the job started"
        );

        // The vault still works: the two left out go in with a new pick.
        let (token, _) = pick(&ts, s, g, &paths[1..]);
        let answered = view(ts.shell.add_files(s, g, &token, FOLDER, 5));
        assert_eq!(answered["added"], json!(2));
        assert_eq!(item_count(&ts, s, g), 3);
    }

    /// The whole batch's space is checked once, before the job: three files that each fit are refused together with
    /// what they need (slack included) and what there is, no job starts, nothing is written, and the choice is kept so
    /// the page can go back to its list. With room for exactly that, the same choice goes in.
    #[test]
    fn no_space_for_the_batch_refused_before_starting_with_numbers() {
        let _cleanup = Cleanup;
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let sizes = [MIB + 3, MIB + 7, 2 * MIB];
        let paths = files(
            &ts,
            &[
                ("a.bin", sizes[0]),
                ("b.bin", sizes[1]),
                ("c.bin", sizes[2]),
            ],
        );
        let (token, _) = pick(&ts, s, g, &paths);
        let blobs: u64 = sizes.iter().map(|&size| blob_len(size)).sum();
        let free = |free: u64| {
            set_volume_override(Some(VolumeInfo {
                free_bytes: Some(free),
                max_file_bytes: None,
            }))
        };

        free(blobs + MARGIN - 1);
        let refused = ts.shell.add_files(s, g, &again(&token), FOLDER, 9).err();
        assert_eq!(
            serde_json::to_value(refused).unwrap(),
            json!({
                "code": "core",
                "kind": "not_enough_space",
                "needed": blobs + MARGIN,
                "available": blobs + MARGIN - 1
            })
        );
        assert!(ts.events.started().is_empty(), "no job before the refusal");
        assert!(ts.events.progress().is_empty());
        assert_eq!(blobs_and_partials(&ts), (0, 0));
        assert_eq!(item_count(&ts, s, g), 0);
        assert_eq!(ts.shell.sessions.pending().len(), 1, "the choice is kept");

        free(blobs + MARGIN);
        let answered = view(ts.shell.add_files(s, g, &token, FOLDER, 10));
        assert_eq!(answered["added"], json!(3));
    }

    /// A file system that cannot hold a stored file as large as the largest refuses before the job too, as a single
    /// file does today.
    #[test]
    fn a_file_the_file_system_cannot_hold_refuses_the_batch() {
        let _cleanup = Cleanup;
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let paths = files(&ts, &[("a.bin", 10), ("b.bin", 2 * MIB)]);
        let (token, _) = pick(&ts, s, g, &paths);
        set_volume_override(Some(VolumeInfo {
            free_bytes: Some(100 * GIB),
            max_file_bytes: Some(MIB),
        }));
        let refused = ts.shell.add_files(s, g, &token, FOLDER, 1).err();
        assert_eq!(
            serde_json::to_value(refused).unwrap(),
            json!({ "code": "core", "kind": "file_system_limit", "max_file": MIB })
        );
        assert!(ts.events.started().is_empty());
        assert_eq!(item_count(&ts, s, g), 0);
    }

    /// A file over 256 GiB (measured as such, since a test cannot make one) refuses the whole batch before the job,
    /// whatever free space is, with the page's own words for it; the files before and after it are not added.
    #[test]
    fn over_256_gib_refused_before_starting() {
        let _cleanup = Cleanup;
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let paths = files(&ts, &[("a.bin", 10), ("huge.bin", 10), ("c.bin", 10)]);
        let (token, list) = pick(&ts, s, g, &paths);
        assert_eq!(names(&list), ["a.bin", "huge.bin", "c.bin"]);
        pretend_size(&paths[1], MAX_FILE_BYTES + 1);
        set_volume_override(Some(VolumeInfo {
            free_bytes: None,
            max_file_bytes: None,
        }));
        let refused = ts.shell.add_files(s, g, &token, FOLDER, 1).err();
        assert_eq!(
            serde_json::to_value(refused).unwrap(),
            json!({ "code": "core", "kind": "too_large", "what": "file" })
        );
        assert!(ts.events.started().is_empty(), "no job before the refusal");
        assert_eq!(item_count(&ts, s, g), 0);
        assert_eq!(ts.shell.sessions.pending().len(), 1, "the choice is kept");
        // A file of exactly 256 GiB is not over.
        pretend_size(&paths[1], MAX_FILE_BYTES);
        assert!(ts.shell.add_files(s, g, &token, FOLDER, 2).is_ok());
        assert_eq!(item_count(&ts, s, g), 3);
    }

    /// Free space that cannot be read never blocks: a batch that known free space would refuse goes ahead, and the
    /// engine's own per-file check lets each file through too.
    #[test]
    fn add_files_unknown_free_space_goes_ahead() {
        let _cleanup = Cleanup;
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let paths = files(&ts, &[("a.bin", MIB), ("b.bin", MIB)]);
        let (token, _) = pick(&ts, s, g, &paths);
        pretend_size(&paths[0], 200 * GIB);
        pretend_size(&paths[1], 200 * GIB);
        set_volume_override(Some(VolumeInfo {
            free_bytes: Some(10 * GIB),
            max_file_bytes: None,
        }));
        let refused = ts.shell.add_files(s, g, &again(&token), FOLDER, 1).err();
        assert!(matches!(
            refused,
            Some(ShellError::Core(view)) if view.kind == "not_enough_space"
        ));
        set_volume_override(Some(VolumeInfo {
            free_bytes: None,
            max_file_bytes: None,
        }));
        let answered = view(ts.shell.add_files(s, g, &token, FOLDER, 2));
        assert_eq!(answered["added"], json!(2));
        assert_eq!(answered["stopped"], Value::Null);
    }

    /// Pick more adds to the same choice: the token is the same, the answer is the whole list in the order picked, and one
    /// Add puts in every file of both picks. A file picked twice is in twice.
    #[test]
    fn two_picks_are_added_together() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let paths = files(&ts, &[("a.bin", 100), ("b.bin", 200), ("c.bin", 300)]);
        let (token, list) = pick(&ts, s, g, &paths[..2]);
        assert_eq!(
            list,
            json!([{ "name": "a.bin", "size": 100 }, { "name": "b.bin", "size": 200 }])
        );

        ts.dialogs
            .answer_files(Some(vec![paths[2].clone(), paths[0].clone()]));
        let more = done(ts.shell.pick_files_to_add(s, g, Some(&token)));
        assert_eq!(
            serde_json::to_value(&more.choice).unwrap(),
            serde_json::to_value(&token).unwrap(),
            "the same token"
        );
        let list = serde_json::to_value(&more.files).unwrap();
        assert_eq!(names(&list), ["a.bin", "b.bin", "c.bin", "a.bin"]);
        assert_eq!(ts.shell.sessions.pending().len(), 1, "one choice");

        let answered = view(ts.shell.add_files(s, g, &token, FOLDER, 1));
        assert_eq!(answered["added"], json!(4));
        assert_eq!(item_count(&ts, s, g), 4);
    }

    /// A picker closed on Pick more keeps the first pick, answers it and the same token; closed on the first pick it is
    /// `Dismissed` and nothing is kept.
    #[test]
    fn a_closed_second_picker_keeps_the_first_pick() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let paths = files(&ts, &[("a.bin", 100), ("b.bin", 200)]);

        ts.dialogs.answer_files(None);
        let first = ts.shell.pick_files_to_add(s, g, None).unwrap();
        assert!(matches!(first.data, Outcome::Dismissed));
        assert_eq!(ts.shell.sessions.pending().len(), 0);

        let (token, _) = pick(&ts, s, g, &paths);
        ts.dialogs.answer_files(None);
        let kept = done(ts.shell.pick_files_to_add(s, g, Some(&token)));
        assert_eq!(
            names(&serde_json::to_value(&kept.files).unwrap()),
            ["a.bin", "b.bin"]
        );
        assert_eq!(
            serde_json::to_value(&kept.choice).unwrap(),
            serde_json::to_value(&token).unwrap()
        );
        // An empty answer is a closed picker too.
        ts.dialogs.answer_files(Some(Vec::new()));
        let kept = done(ts.shell.pick_files_to_add(s, g, Some(&token)));
        assert_eq!(kept.files.len(), 2);
        let answered = view(ts.shell.add_files(s, g, &token, FOLDER, 1));
        assert_eq!(answered["added"], json!(2));
    }

    /// A file that cannot be read when its turn comes (deleted after the pick, held open by another program, not a file,
    /// or gone between the start and its turn) is named in `failed` and the batch goes on with the rest. The bar still
    /// ends at its total.
    #[test]
    fn a_file_that_cannot_be_read_is_named_and_the_rest_go_in() {
        let _cleanup = Cleanup;
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let paths = files(
            &ts,
            &[
                ("a.bin", MIB + 1),
                ("deleted.bin", 10),
                ("held.bin", 10),
                ("e.bin", MIB + 2),
                ("vanishes.bin", 10),
                ("f.bin", 10),
            ],
        );
        let folder = ts.temp.path().join("picked").join("folder");
        fs::create_dir(&folder).unwrap();
        let mut picked = paths.clone();
        picked.insert(3, folder);
        let (token, list) = pick(&ts, s, g, &picked);
        assert_eq!(names(&list).len(), 7);

        fs::remove_file(&paths[1]).unwrap();
        let _held = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&paths[2])
            .unwrap();
        // Between the start and its turn (before the sixth file's).
        let vanishing = paths[4].clone();
        at("file_start", move |index| {
            if index == 5 {
                fs::remove_file(&vanishing).unwrap();
            }
        });
        keep_progress_flowing(&ts);

        let answered = view(ts.shell.add_files(s, g, &token, FOLDER, 1));
        assert_eq!(
            answered,
            json!({
                "added": 3,
                "failed": ["deleted.bin", "held.bin", "folder", "vanishes.bin"],
                "not_added": [],
                "stopped": null
            })
        );
        assert_eq!(item_count(&ts, s, g), 3);
        // What could be measured when the batch began: a, e, the one that vanished later and f.
        let total = 2 * MIB + 3 + 10 + 10;
        let progress = one_batch(&ts, 1, total);
        let last = progress.last().unwrap();
        assert_eq!(last["done"], last["total"], "the bar ends at its total");
    }

    /// Files that go while the batch waits for a busy vault (the second one deleted, the third opened by another program
    /// that lets no one else read it) are unreadable like any other: named in `failed`, and the batch goes on to the
    /// fourth. The wait is on the shell's clock, so the change lands in the middle of it.
    #[test]
    fn a_file_that_goes_during_the_busy_wait_is_named_and_the_rest_go_in() {
        let _cleanup = Cleanup;
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let paths = files(
            &ts,
            &[("a.bin", 10), ("b.bin", 20), ("c.bin", 30), ("d.bin", 40)],
        );
        let (token, _) = pick(&ts, s, g, &paths);
        let holder = Rc::new(RefCell::new(Some(Holder::start_after_file(&ts, s, g, 0))));
        let exclusive = Rc::new(RefCell::new(None));
        let (gone, opened, slot) = (paths[1].clone(), paths[2].clone(), Rc::clone(&exclusive));
        at("busy_retry", move |retries| {
            if retries == 2 {
                fs::remove_file(&gone).unwrap();
                let held = OpenOptions::new()
                    .read(true)
                    .share_mode(0)
                    .open(&opened)
                    .unwrap();
                *slot.borrow_mut() = Some(held);
            }
        });
        let seen = Rc::clone(&holder);
        at("busy_retry", move |retries| {
            if retries == 3 {
                seen.borrow_mut().take().unwrap().release();
            }
        });
        keep_progress_flowing(&ts);

        let answered = view(ts.shell.add_files(s, g, &token, FOLDER, 1));
        assert_eq!(
            answered,
            json!({
                "added": 2,
                "failed": ["b.bin", "c.bin"],
                "not_added": [],
                "stopped": null
            })
        );
        assert_eq!(item_count(&ts, s, g), 2);
        assert_eq!(blobs_and_partials(&ts), (2, 0));
        let progress = one_batch(&ts, 1, 100);
        assert_eq!(progress.last().unwrap()["done"], json!(100));
        // The hook still holds a copy of the slot, so let the file go here, before the test's folder is removed.
        exclusive.borrow_mut().take();
    }

    /// The file that waits for the vault grows during the wait: it is looked at again once the vault is the batch's, found
    /// not to be the size that was checked, and refused (named in `failed`) without being written.
    #[test]
    fn a_file_that_changes_size_during_the_busy_wait_is_refused() {
        let _cleanup = Cleanup;
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let paths = files(&ts, &[("a.bin", 10), ("b.bin", 20), ("c.bin", 30)]);
        let (token, _) = pick(&ts, s, g, &paths);
        let holder = Rc::new(RefCell::new(Some(Holder::start_after_file(&ts, s, g, 0))));
        let growing = paths[1].clone();
        at("busy_retry", move |retries| {
            if retries == 2 {
                let mut file = OpenOptions::new().append(true).open(&growing).unwrap();
                std::io::Write::write_all(&mut file, b"more").unwrap();
            }
        });
        let seen = Rc::clone(&holder);
        at("busy_retry", move |retries| {
            if retries == 3 {
                seen.borrow_mut().take().unwrap().release();
            }
        });
        keep_progress_flowing(&ts);

        let answered = view(ts.shell.add_files(s, g, &token, FOLDER, 1));
        assert_eq!(
            answered,
            json!({ "added": 2, "failed": ["b.bin"], "not_added": [], "stopped": null })
        );
        assert_eq!(blobs_and_partials(&ts), (2, 0));
        let progress = one_batch(&ts, 1, 60);
        assert_eq!(progress.last().unwrap()["done"], json!(60));
    }

    /// A file that goes after the shell last looked and before the engine opens it (the engine's open fails) is the
    /// file's failure too, not the vault's: named in `failed`, the rest go in. A vault refusal still ends the batch (the
    /// tests of the vault's refusals above).
    #[test]
    fn a_file_that_goes_just_before_the_engine_opens_it_is_named_and_the_rest_go_in() {
        let _cleanup = Cleanup;
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let paths = files(&ts, &[("a.bin", 10), ("b.bin", 20), ("c.bin", 30)]);
        let (token, _) = pick(&ts, s, g, &paths);
        let gone = paths[1].clone();
        at("import_open", move |index| {
            if index == 1 {
                fs::remove_file(&gone).unwrap();
            }
        });
        keep_progress_flowing(&ts);

        let answered = view(ts.shell.add_files(s, g, &token, FOLDER, 1));
        assert_eq!(
            answered,
            json!({ "added": 2, "failed": ["b.bin"], "not_added": [], "stopped": null })
        );
        assert_eq!(blobs_and_partials(&ts), (2, 0));
        let progress = one_batch(&ts, 1, 60);
        assert_eq!(progress.last().unwrap()["done"], json!(60));
    }

    /// The last file shrinks after it was measured: it is refused like an unreadable one (named in `failed`; its measured
    /// bytes count as passed over), the batch goes on, the bar never goes back and a batch that ends well ends at its
    /// total.
    #[test]
    fn a_file_that_shrinks_after_it_was_measured_is_refused_and_the_bar_reaches_its_total() {
        let _cleanup = Cleanup;
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let paths = files(&ts, &[("a.bin", MIB), ("b.bin", 2 * MIB), ("c.bin", MIB)]);
        let (token, _) = pick(&ts, s, g, &paths);
        let shrinking = paths[2].clone();
        at("file_start", move |index| {
            if index == 2 {
                fs::write(&shrinking, b"tiny").unwrap();
            }
        });
        keep_progress_flowing(&ts);

        let answered = view(ts.shell.add_files(s, g, &token, FOLDER, 1));
        assert_eq!(
            answered,
            json!({ "added": 2, "failed": ["c.bin"], "not_added": [], "stopped": null })
        );
        assert_eq!(item_count(&ts, s, g), 2);
        let progress = one_batch(&ts, 1, 4 * MIB);
        assert_eq!(progress.last().unwrap()["done"], json!(4 * MIB));
    }

    /// A file that grows after it was measured is refused the same way, and the space check stays honest: the batch was
    /// checked with room for exactly what was measured, so the bigger file is never written (nothing of it is left), the
    /// others go in, and the bar still ends at its total.
    #[test]
    fn a_file_that_grows_after_it_was_measured_is_refused_not_written() {
        let _cleanup = Cleanup;
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let sizes = [MIB, MIB, MIB];
        let paths = files(
            &ts,
            &[
                ("a.bin", sizes[0]),
                ("b.bin", sizes[1]),
                ("c.bin", sizes[2]),
            ],
        );
        let (token, _) = pick(&ts, s, g, &paths);
        let blobs: u64 = sizes.iter().map(|&size| blob_len(size)).sum();
        set_volume_override(Some(VolumeInfo {
            free_bytes: Some(blobs + MARGIN),
            max_file_bytes: None,
        }));
        let growing = paths[1].clone();
        at("file_start", move |index| {
            if index == 1 {
                let mut file = OpenOptions::new().append(true).open(&growing).unwrap();
                std::io::Write::write_all(&mut file, &vec![7u8; 3 * MIB as usize]).unwrap();
            }
        });
        keep_progress_flowing(&ts);

        let answered = view(ts.shell.add_files(s, g, &token, FOLDER, 1));
        assert_eq!(
            answered,
            json!({ "added": 2, "failed": ["b.bin"], "not_added": [], "stopped": null })
        );
        assert_eq!(item_count(&ts, s, g), 2);
        assert_eq!(blobs_and_partials(&ts), (2, 0));
        let progress = one_batch(&ts, 1, 3 * MIB);
        assert_eq!(progress.last().unwrap()["done"], json!(3 * MIB));
    }

    /// Every report of the batch's bar, as the job would hear it.
    struct Recorder(Mutex<Vec<(u64, u64)>>);

    impl Progress for Recorder {
        fn advance(&self, done: u64, total: u64) {
            self.0.lock().unwrap().push((done, total));
        }
    }

    /// The bar counts one stable size for each file (the one measured): an engine that reports more than that (a file
    /// that grew) is held at it, one that reports less (a file that shrank) is made up when the file is finished, and a
    /// report that goes back never moves the bar back.
    #[test]
    fn the_batch_bar_uses_the_measured_size_and_never_goes_back() {
        let recorder = Recorder(Mutex::default());
        let bar = BatchProgress::new(&recorder, 150);
        bar.begin_file(100);
        bar.advance(40, 300);
        bar.advance(250, 300);
        bar.finished_file(100);
        bar.begin_file(50);
        bar.advance(10, 20);
        bar.advance(20, 20);
        bar.finished_file(50);
        assert_eq!(
            *recorder.0.lock().unwrap(),
            [
                (40, 150),
                (100, 150),
                (100, 150),
                (110, 150),
                (120, 150),
                (150, 150)
            ]
        );

        let recorder = Recorder(Mutex::default());
        let bar = BatchProgress::new(&recorder, 100);
        bar.begin_file(100);
        bar.advance(80, 100);
        bar.advance(30, 100);
        bar.passed_over(0);
        assert_eq!(
            *recorder.0.lock().unwrap(),
            [(80, 100), (80, 100), (80, 100)]
        );
    }

    /// A file that could not be opened when the batch was measured is not in the space check or the total; if it can be
    /// opened at its turn it is still refused (named in `failed`), not slipped in unchecked.
    #[test]
    fn a_file_unreadable_at_the_measuring_is_not_added_when_it_can_be_read_later() {
        let _cleanup = Cleanup;
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let paths = files(&ts, &[("a.bin", 10), ("b.bin", 20), ("c.bin", 30)]);
        let (token, _) = pick(&ts, s, g, &paths);
        let held = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&paths[1])
            .unwrap();
        let held = Rc::new(RefCell::new(Some(held)));
        at("file_start", move |index| {
            if index == 1 {
                held.borrow_mut().take();
            }
        });
        keep_progress_flowing(&ts);

        let answered = view(ts.shell.add_files(s, g, &token, FOLDER, 1));
        assert_eq!(
            answered,
            json!({ "added": 2, "failed": ["b.bin"], "not_added": [], "stopped": null })
        );
        let progress = one_batch(&ts, 1, 40);
        assert_eq!(progress.last().unwrap()["done"], json!(40));
    }

    /// The vault is busy (a read holds it) from the second file on for the whole 30 seconds of waiting between files
    /// (the shell's clock: no real wait): the batch stops, the one that went in is counted, and the rest are named as
    /// not added, with the refusal.
    #[test]
    fn busy_for_30_seconds_between_files_stops_the_batch_and_counts_it() {
        let _cleanup = Cleanup;
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let paths = files(&ts, &[("a.bin", 10), ("b.bin", 20), ("c.bin", 30)]);
        let (token, _) = pick(&ts, s, g, &paths);
        let holder = Holder::start_after_file(&ts, s, g, 0);
        let began = ts.clock.now();

        let answered = view(ts.shell.add_files(s, g, &token, FOLDER, 1));
        let waited = ts.clock.now() - began;
        holder.release();
        assert_eq!(
            answered,
            json!({
                "added": 1,
                "failed": [],
                "not_added": ["b.bin", "c.bin"],
                "stopped": { "code": "busy", "what": "operation in progress" }
            })
        );
        assert!(
            waited >= Duration::from_secs(30) && waited < Duration::from_secs(32),
            "waited {waited:?}"
        );
        assert_eq!(item_count(&ts, s, g), 1);
        // Nothing was lost by the wait: a new pick of the two goes in.
        let (token, _) = pick(&ts, s, g, &paths[1..]);
        assert_eq!(
            view(ts.shell.add_files(s, g, &token, FOLDER, 2))["added"],
            json!(2)
        );
    }

    /// A vault that is free again within the 30 seconds lets the batch go on with the file that waited.
    #[test]
    fn busy_that_clears_within_the_wait_goes_on() {
        let _cleanup = Cleanup;
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let paths = files(&ts, &[("a.bin", 10), ("b.bin", 20), ("c.bin", 30)]);
        let (token, _) = pick(&ts, s, g, &paths);
        let holder = Rc::new(RefCell::new(Some(Holder::start_after_file(&ts, s, g, 0))));
        let seen = Rc::clone(&holder);
        at("busy_retry", move |retries| {
            if retries == 3 {
                seen.borrow_mut().take().unwrap().release();
            }
        });
        let began = ts.clock.now();
        let answered = view(ts.shell.add_files(s, g, &token, FOLDER, 1));
        assert_eq!(
            answered,
            json!({ "added": 3, "failed": [], "not_added": [], "stopped": null })
        );
        assert!(ts.clock.now() - began < Duration::from_secs(5));
    }

    /// A Stop sent while the batch waits for the vault ends it at once (not after 30 seconds), as cancelled.
    #[test]
    fn a_stop_while_waiting_for_the_vault_ends_the_batch() {
        let _cleanup = Cleanup;
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let paths = files(&ts, &[("a.bin", 10), ("b.bin", 20)]);
        let (token, _) = pick(&ts, s, g, &paths);
        let holder = Holder::start_after_file(&ts, s, g, 0);
        let shell = Arc::downgrade(&ts.shell);
        let started = Arc::clone(&ts.events);
        at("busy_retry", move |retries| {
            if retries == 2 {
                let job = started.started().pop().unwrap();
                let operation = OperationId(job["operation"].as_u64().unwrap());
                let scope: JobScope = serde_json::from_value(job["scope"].clone()).unwrap();
                shell
                    .upgrade()
                    .unwrap()
                    .autolock
                    .cancel_operation(operation, scope)
                    .unwrap();
            }
        });
        let began = ts.clock.now();
        let answered = view(ts.shell.add_files(s, g, &token, FOLDER, 1));
        let waited = ts.clock.now() - began;
        holder.release();
        assert_eq!(
            answered,
            json!({
                "added": 1,
                "failed": [],
                "not_added": ["b.bin"],
                "stopped": { "code": "cancelled" }
            })
        );
        assert!(waited < Duration::from_secs(5), "waited {waited:?}");
    }

    /// Into an item: every file of the choice is attached to it, in order, and nothing becomes a new item.
    #[test]
    fn add_files_into_an_item_attaches_each() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let (item, existing) = ts.stored_file(s, g, "old.pdf", b"already here");
        let paths = files(&ts, &[("a.bin", 100), ("b.bin", 200)]);
        let (token, _) = pick(&ts, s, g, &paths);
        let into = AddInto::Item { id: item.clone() };
        let answered = view(ts.shell.add_files(s, g, &token, into, 1));
        assert_eq!(answered["added"], json!(2));
        assert_eq!(item_count(&ts, s, g), 1, "no new item");
        let detail = serde_json::to_value(ts.shell.get_item(s, g, &item).unwrap()).unwrap();
        let attached: Vec<&str> = detail["data"]["summary"]["attachments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| file["name"].as_str().unwrap())
            .collect();
        assert_eq!(attached, ["old.pdf", "a.bin", "b.bin"]);
        assert_eq!(
            detail["data"]["summary"]["attachments"][0]["file_id"],
            json!(existing)
        );

        // An item that is not there ends the batch at the first file, naming every file as not added.
        let (token, _) = pick(&ts, s, g, &paths);
        let gone = AddInto::Item {
            id: "0123456789abcdef0123456789abcdef".to_owned(),
        };
        let answered = view(ts.shell.add_files(s, g, &token, gone, 2));
        assert_eq!(answered["added"], json!(0));
        assert_eq!(answered["not_added"], json!(["a.bin", "b.bin"]));
        assert_eq!(answered["stopped"]["kind"], json!("not_found"));
    }

    /// Into a folder: the new items are in that folder.
    #[test]
    fn add_files_into_a_folder_puts_the_items_in_it() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let folder = ts
            .shell
            .new_item(s, g, NewKind::Collection, "Papers".into(), None, None)
            .unwrap()
            .data;
        let paths = files(&ts, &[("a.bin", 100)]);
        let (token, _) = pick(&ts, s, g, &paths);
        let into = AddInto::Folder {
            collection: Some(folder.clone()),
        };
        assert_eq!(
            view(ts.shell.add_files(s, g, &token, into, 1))["added"],
            json!(1)
        );
        let items = serde_json::to_value(ts.shell.list_items(s, g).unwrap()).unwrap();
        let in_folder = items["data"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["collection"] == json!(folder))
            .count();
        assert_eq!(in_folder, 1);
    }

    // The choice.

    /// Remove drops one picked file by its place and answers the shorter list, under the same token; an index past the end
    /// is refused and changes nothing; the file removed is not added.
    #[test]
    fn remove_picked_file_answers_the_shorter_list() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let paths = files(&ts, &[("a.bin", 100), ("b.bin", 200), ("c.bin", 300)]);
        let (token, _) = pick(&ts, s, g, &paths);

        let shorter = done(ts.shell.remove_picked_file(s, g, &token, 1));
        assert_eq!(
            serde_json::to_value(&shorter).unwrap(),
            json!({ "files": [{ "name": "a.bin", "size": 100 }, { "name": "c.bin", "size": 300 }] })
        );
        let refused = ts.shell.remove_picked_file(s, g, &token, 2).err();
        assert_eq!(
            serde_json::to_value(refused).unwrap(),
            json!({ "code": "invalid_input", "what": "index" })
        );
        let answered = view(ts.shell.add_files(s, g, &token, FOLDER, 1));
        assert_eq!(answered["added"], json!(2));
        assert_eq!(item_count(&ts, s, g), 2);
        assert_eq!(
            ts.shell.remove_picked_file(s, g, &token, 0).err(),
            EXPIRED,
            "the choice was used up"
        );
    }

    /// A lock of that vault, or of all, drops its picked files; a lock of another vault leaves them. The choice is then
    /// refused: for a locked session by the session's own checks, and after the vault is unlocked again (a new generation)
    /// as expired, however it is asked, and a choice made by one session is no use to another.
    #[test]
    fn choice_refused_after_lock() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let (other, go) = ts.open_vault("Work");
        let paths = files(&ts, &[("a.bin", 100)]);
        let (mine, _) = pick(&ts, s, g, &paths);
        let (theirs, _) = pick(&ts, other, go, &paths);
        assert_eq!(ts.shell.sessions.pending().len(), 2);

        // Each session's own choice only.
        assert_eq!(
            ts.shell.add_files(other, go, &mine, FOLDER, 1).err(),
            EXPIRED
        );
        assert_eq!(
            ts.shell.remove_picked_file(other, go, &mine, 0).err(),
            EXPIRED
        );
        assert_eq!(
            ts.shell.sessions.pending().len(),
            2,
            "a refusal changes nothing"
        );

        ts.shell.sessions.lock(other, LockReason::Manual);
        assert_eq!(ts.shell.sessions.pending().len(), 1, "another vault's lock");
        assert_eq!(
            ts.shell.add_files(other, go, &theirs, FOLDER, 1).err(),
            LOCKED
        );
        ts.shell.sessions.lock(s, LockReason::Manual);
        assert_eq!(ts.shell.sessions.pending().len(), 0, "its own lock");
        assert_eq!(ts.shell.add_files(s, g, &mine, FOLDER, 1).err(), LOCKED);

        // Unlocked again: a new generation, and the old choice is gone for good.
        let id = ts.shell.registry.entries()[0].0;
        let password = Zeroizing::new(TEST_PASSWORD.to_owned());
        let unlocked = heavy(|| ts.shell.unlock_vault(id, password)).unwrap();
        let (s2, g2) = (unlocked.session, unlocked.generation);
        assert_ne!(g2, g);
        assert_eq!(ts.shell.add_files(s2, g2, &mine, FOLDER, 2).err(), EXPIRED);
        assert_eq!(ts.shell.remove_picked_file(s2, g2, &mine, 0).err(), EXPIRED);
        let dialogs = ts.dialogs.opened();
        assert_eq!(
            ts.shell.pick_files_to_add(s2, g2, Some(&mine)).err(),
            EXPIRED
        );
        assert_eq!(
            ts.dialogs.opened(),
            dialogs,
            "no dialog for a choice that is gone"
        );
        assert_eq!(item_count(&ts, s2, g2), 0);

        // Lock all drops every list, and a choice that was never given is refused the same way.
        let (again_token, _) = pick(&ts, s2, g2, &paths);
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert_eq!(ts.shell.sessions.pending().len(), 0);
        let made_up: Token =
            serde_json::from_value(Value::String(["0123456789abcdef"; 2].concat())).unwrap();
        let _ = again_token;
        let (s3, g3) = ts.open_vault("Third");
        assert_eq!(
            ts.shell.add_files(s3, g3, &made_up, FOLDER, 3).err(),
            EXPIRED
        );
    }

    /// A choice five minutes old is expired, and one used on Pick more or Remove lives five minutes from then (the
    /// lifetime itself is tested in `pending`); an Add that is refused before its job keeps the choice.
    #[test]
    fn add_refused_before_the_job_keeps_the_choice() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let paths = files(&ts, &[("a.bin", 100)]);
        let (token, _) = pick(&ts, s, g, &paths);
        let bad = AddInto::Item {
            id: "not hex".to_owned(),
        };
        assert!(matches!(
            ts.shell.add_files(s, g, &token, bad, 1).err(),
            Some(ShellError::Core(view)) if view.kind == "invalid_input"
        ));
        assert_eq!(ts.shell.sessions.pending().len(), 1);
        assert_eq!(
            view(ts.shell.add_files(s, g, &token, FOLDER, 2))["added"],
            json!(1)
        );
    }

    /// All three commands are refused for a stale generation (`Locked`) and a session that is not ours (`NotFound`), and
    /// on a read-only session (`ReadOnly`), before any dialog opens or any job starts; a refusal leaves the choice alone.
    #[test]
    fn pick_files_to_add_remove_picked_file_and_add_files_refused_stale_foreign_read_only() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let paths = files(&ts, &[("a.bin", 100)]);
        let (token, _) = pick(&ts, s, g, &paths);
        let foreign = SessionId(s.0 + 100);
        let dialogs = ts.dialogs.opened();

        for (session, generation, wanted) in [
            (s, g + 1, Some(ShellError::Locked)),
            (foreign, g, Some(ShellError::NotFound)),
        ] {
            ts.dialogs.answer_files(Some(paths.clone()));
            assert_eq!(
                ts.shell.pick_files_to_add(session, generation, None).err(),
                wanted
            );
            assert_eq!(
                ts.shell
                    .pick_files_to_add(session, generation, Some(&token))
                    .err(),
                wanted
            );
            assert_eq!(
                ts.shell
                    .remove_picked_file(session, generation, &token, 0)
                    .err(),
                wanted
            );
            assert_eq!(
                ts.shell
                    .add_files(session, generation, &token, FOLDER, 1)
                    .err(),
                wanted
            );
        }
        assert_eq!(ts.dialogs.opened(), dialogs, "no dialog before the check");
        assert!(ts.events.started().is_empty());
        assert_eq!(
            ts.shell.sessions.pending().len(),
            1,
            "the choice is untouched"
        );
        assert_eq!(item_count(&ts, s, g), 0);

        // Read-only: nothing to pick for, nothing to remove from, nothing to add to.
        let (r, gr) = read_only_session(&ts);
        let made_up: Token =
            serde_json::from_value(Value::String(["0123456789abcdef"; 2].concat())).unwrap();
        let dialogs = ts.dialogs.opened();
        ts.dialogs.answer_files(Some(paths.clone()));
        let refused = [
            ts.shell.pick_files_to_add(r, gr, None).err(),
            ts.shell.pick_files_to_add(r, gr, Some(&made_up)).err(),
            ts.shell.remove_picked_file(r, gr, &made_up, 0).err(),
            ts.shell.add_files(r, gr, &made_up, FOLDER, 1).err(),
        ];
        assert_eq!(refused, [Some(ShellError::ReadOnly); 4]);
        assert_eq!(ts.dialogs.opened(), dialogs, "no dialog before the check");
        assert!(ts.events.started().is_empty());
    }

    // The words on the wire.

    fn parses<T: serde::de::DeserializeOwned>(body: &Value) -> bool {
        parse::<T>(&InvokeBody::Json(body.clone())).is_ok()
    }

    /// The frozen shapes: what the page is sent, in both directions, and the bodies the three commands take. Every one
    /// refuses a field it does not know, a path included, and a number that is not a `u32`.
    #[test]
    fn the_frozen_shapes_and_strict_arguments() {
        let hex = "0123456789abcdef0123456789abcdef";
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let paths = files(&ts, &[("a.pdf", 100)]);
        ts.dialogs.answer_files(Some(paths));
        let answer = ts.shell.pick_files_to_add(s, g, None).unwrap();
        let sent = serde_json::to_value(&answer).unwrap();
        let token = sent["data"]["Done"]["choice"].as_str().unwrap().to_owned();
        assert_eq!(token.len(), 32);
        assert!(
            token
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        );
        assert_eq!(
            sent["data"]["Done"]["files"],
            json!([{ "name": "a.pdf", "size": 100 }])
        );
        assert_eq!(sent["session"], json!(s.0));
        assert_eq!(sent["generation"], json!(g));

        let stopped = AddFilesView {
            added: 1,
            failed: Vec::new(),
            not_added: vec!["b.zip".to_owned()],
            stopped: Some(ShellError::Cancelled),
        };
        assert_eq!(
            serde_json::to_value(Tagged {
                session: SessionId(3),
                generation: 7,
                data: Outcome::Done(stopped)
            })
            .unwrap(),
            json!({
                "session": 3, "generation": 7,
                "data": { "Done": { "added": 1, "failed": [], "not_added": ["b.zip"], "stopped": { "code": "cancelled" } } }
            })
        );

        let pick = json!({ "session": 3, "generation": 7, "choice": null });
        let pick_more = json!({ "session": 3, "generation": 7, "choice": hex });
        let remove = json!({ "session": 3, "generation": 7, "choice": hex, "index": 0 });
        let add = json!({
            "session": 3, "generation": 7, "choice": hex,
            "into": { "type": "folder", "collection": null }, "request": 12
        });
        let attach = json!({
            "session": 3, "generation": 7, "choice": hex,
            "into": { "type": "item", "id": hex }, "request": 12
        });
        for ok in [&pick, &pick_more] {
            assert!(parses::<PickFilesArgs>(ok), "{ok}");
        }
        assert!(parses::<RemoveArgs>(&remove));
        assert!(parses::<AddFilesArgs>(&add));
        assert!(parses::<AddFilesArgs>(&attach));
        // The folder may leave `collection` out; an item may not leave `id` out.
        let mut bare = add.clone();
        bare["into"] = json!({ "type": "folder" });
        assert!(parses::<AddFilesArgs>(&bare));
        let mut no_id = attach.clone();
        no_id["into"] = json!({ "type": "item" });
        assert!(!parses::<AddFilesArgs>(&no_id));

        let sneak = |mut body: Value| {
            body["path"] = json!("SENTINEL-7f3a");
            body
        };
        assert_eq!(
            parse::<PickFilesArgs>(&InvokeBody::Json(sneak(pick.clone()))).err(),
            Some(MALFORMED)
        );
        assert_eq!(
            parse::<RemoveArgs>(&InvokeBody::Json(sneak(remove.clone()))).err(),
            Some(MALFORMED)
        );
        assert_eq!(
            parse::<AddFilesArgs>(&InvokeBody::Json(sneak(add.clone()))).err(),
            Some(MALFORMED)
        );
        for bad_into in [
            json!({ "type": "folder", "collection": null, "path": "C:\\x" }),
            json!({ "type": "item", "id": hex, "extra": 1 }),
            json!({ "type": "elsewhere" }),
            json!({ "collection": null }),
            json!("folder"),
        ] {
            let mut body = add.clone();
            body["into"] = bad_into.clone();
            assert!(!parses::<AddFilesArgs>(&body), "{bad_into} was accepted");
        }
        for bad in [
            json!(-1),
            json!(4294967296u64),
            json!("5"),
            json!(1.5),
            json!(null),
        ] {
            let mut body = add.clone();
            body["request"] = bad.clone();
            assert!(!parses::<AddFilesArgs>(&body), "request {bad}");
            let mut body = remove.clone();
            body["index"] = bad.clone();
            assert!(!parses::<RemoveArgs>(&body), "index {bad}");
        }
        for bad in [
            json!("short"),
            json!(5),
            json!(format!("{hex}0")),
            json!(hex.to_uppercase()),
        ] {
            let mut body = pick.clone();
            body["choice"] = bad.clone();
            assert!(!parses::<PickFilesArgs>(&body), "choice {bad}");
        }
        let mut no_request = add.clone();
        no_request.as_object_mut().unwrap().remove("request");
        assert!(!parses::<AddFilesArgs>(&no_request));
    }
}
