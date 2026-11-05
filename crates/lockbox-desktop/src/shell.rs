//! The app's state behind every command: plain Rust, so almost every rule is tested without a window.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::TryLockError;
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use lockbox_core::fsio::remove_file_retry;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, EventTarget, Runtime};
use zeroize::Zeroizing;

use crate::autolock::AutoLock;
use crate::clipboard::Clipboard;
use crate::error::{ShellError, ShellResult};
use crate::locations::{LocationCheck, check_location, is_within};
use crate::lock;
use crate::open::{OpenFolders, RemoveReport};
use crate::os::{KnownFolder, Os, PrintFailed, Printer};
use crate::outputs::{Outputs, SweepReport};
use crate::paths::{StatePaths, state_paths};
use crate::registry::Registry;
use crate::restore::Restores;
use crate::session::{LockReason, Notice, Notifier, SessionId, Sessions};
use crate::settings::SettingsStore;
use crate::window;

/// A session locked: `{ session, generation, reason }`.
pub const LOCKED_EVENT: &str = "lockbox://locked";
/// The long operations under way: `{ session, operations }` (`session` null for one without a session).
pub const BUSY_EVENT: &str = "lockbox://busy";
/// Launch recovery and sweep results: `{ kind, .. }`.
pub const NOTICE_EVENT: &str = "lockbox://notice";

pub struct Shell {
    pub sessions: Arc<Sessions>,
    pub settings: Arc<SettingsStore>,
    /// Lockbox's clipboard copies, cleared after the delay, at a lock of their vault and at app close.
    pub clipboard: Clipboard,
    /// Locks the vaults on idle, Windows' signals, vanished folders and app exit.
    pub autolock: AutoLock,
    pub registry: Registry,
    /// The output journal (spec §7.2): every temporary plaintext file, written down before it exists.
    pub outputs: Arc<Outputs>,
    /// The "Open" folders (spec §7.2), removed at a lock of their vault and at app close.
    pub open_folders: Arc<OpenFolders>,
    /// The one restore that may be alive (spec §6.8) and the pre-restore folders last listed.
    pub restore: Arc<Restores>,
    pub paths: StatePaths,
    pub(crate) os: Os,
    /// Where the launch sweep's notice goes.
    notifier: Arc<dyn Notifier>,
    /// What the launch work had to tell ([`launch_notices`](Self::launch_notices)).
    launch_notices: Mutex<Vec<Notice>>,
    /// The folders no vault may be inside (spec §6.10): Tauri's app-data folders, the Roaming profile and the state
    /// folder.
    forbidden: Vec<PathBuf>,
    /// One vault creation or addition at a time ([`creating`](Self::creating)).
    creating: Mutex<()>,
    /// How many times the save shortcut has been pressed.
    shortcut_presses: AtomicU64,
    /// The text the last press of the save shortcut read, in the one slot that holds it; wiped when replaced, cleared
    /// and at shutdown. Only a probe reads it (its length), until the capture slot replaces it. A leaf lock: never held
    /// across a clipboard call or any other lock.
    probe_captured: Mutex<Option<Zeroizing<String>>>,
    /// Tests only: how many times a creation or addition had to wait for another.
    #[cfg(test)]
    creating_waited: AtomicUsize,
}

impl Shell {
    /// `app_dirs`: Tauri's `app_data_dir` and `app_local_data_dir`, which an uninstaller may delete. Reads only the
    /// known folders and the settings: nothing is written until a command saves state.
    pub fn new(notifier: Arc<dyn Notifier>, os: Os, app_dirs: Vec<PathBuf>) -> io::Result<Self> {
        let paths = state_paths(os.env.as_ref())?;
        let mut forbidden = app_dirs;
        forbidden.push(os.env.known_folder(KnownFolder::RoamingAppData)?);
        forbidden.push(paths.root.clone());
        let sessions = Arc::new(Sessions::new(Arc::clone(&notifier))?);
        let settings = Arc::new(SettingsStore::load(paths.settings.clone()));
        let outputs = Arc::new(Outputs::new(&paths, Arc::clone(&os.volumes)));
        let open_folders = Arc::new(OpenFolders::new(
            paths.open.clone(),
            Arc::clone(&outputs),
            Arc::clone(&notifier),
        ));
        // The auto-lock adds no lock hook; the clipboard reads the close's deadline from it.
        let autolock = AutoLock::new(
            Arc::clone(&sessions),
            Arc::clone(&settings),
            Arc::clone(&notifier),
            Arc::clone(&open_folders),
            &os,
        );
        let clipboard = Clipboard::new(&os, Arc::clone(&settings), autolock.close_deadline())?;
        // The first lock hook, before any other: a lock clears the clipboard before anything else of its hooks runs.
        sessions.on_lock(clipboard.lock_hook());
        // Then the "Open" cleanup, which hands its deletes to a worker and returns at once.
        sessions.on_lock(open_folders.lock_hook(Arc::downgrade(&sessions)));
        // Then the restore's: a restore that is not swapping ends with a lock (it drops its staged restore on a worker).
        let restore = Arc::new(Restores::new());
        sessions.on_lock(restore.lock_hook(Arc::downgrade(&sessions)));
        Ok(Shell {
            sessions,
            settings,
            clipboard,
            autolock,
            registry: Registry::new(paths.registry.clone(), Arc::clone(&os.volumes)),
            outputs,
            open_folders,
            restore,
            paths,
            os,
            notifier,
            launch_notices: Mutex::default(),
            forbidden,
            creating: Mutex::default(),
            shortcut_presses: AtomicU64::new(0),
            probe_captured: Mutex::default(),
            #[cfg(test)]
            creating_waited: AtomicUsize::new(0),
        })
    }

    /// The save shortcut was pressed: counts the press and reads the clipboard once, into the probe's slot, replacing
    /// (and wiping) what was there. A clipboard with no text, too large a text, or one that cannot be read leaves the
    /// slot empty. Nothing is logged or sent to the page. Runs on its own thread (the clipboard may be held by another
    /// program), never the signal window's.
    pub fn save_shortcut_pressed(&self) {
        self.shortcut_presses.fetch_add(1, Ordering::SeqCst);
        // Whatever goes wrong, the slot ends up empty rather than holding an earlier press's text.
        let read = self.os.clipboard.read_text(None).ok().flatten();
        *lock(&self.probe_captured) = read;
    }

    /// How many times the save shortcut has been pressed.
    pub fn shortcut_presses(&self) -> u64 {
        self.shortcut_presses.load(Ordering::SeqCst)
    }

    /// The length in bytes of the text in the probe's slot; 0 when it is empty.
    pub fn probe_capture_length(&self) -> usize {
        lock(&self.probe_captured)
            .as_ref()
            .map_or(0, |text| text.len())
    }

    /// Empties the clipboard if it still holds the text in the probe's slot, and empties the slot either way: whether
    /// the clipboard was cleared.
    pub fn probe_clear_captured(&self) -> bool {
        // Taken out first, so the lock is not held across the clipboard, and wiped when it goes out of scope here.
        let Some(captured) = lock(&self.probe_captured).take() else {
            return false;
        };
        self.os
            .clipboard
            .clear_if_text(&captured, None)
            .unwrap_or(false)
    }

    /// Prints the test page's marked element to a PDF at a place chosen in Rust's save dialog, through a temp file in
    /// the `form` the page asked for (see [`probe_print_to`]). Slow: it waits for a dialog and for the print.
    pub fn probe_print_pdf(&self, form: PrintForm) -> ProbePrintAnswer {
        let Some(dest) = self.os.dialogs.save_file(
            "Print the test page to PDF",
            "lockbox-print-probe.pdf",
            Some(("PDF", &["pdf"])),
        ) else {
            return ProbePrintAnswer::nothing_made(form, ProbePrinted::Dismissed);
        };
        probe_print_to(self.os.printer.as_ref(), &dest, form, PROBE_PRINT_WAIT)
    }

    /// Held from the vault list's room check to the new vault's place on it (a create), or from a folder's check to
    /// its place on the list (an addition): the engine's create removes every unfinished staging folder in its
    /// parent, another create's included, and two creates could both pass the room check for the last place.
    ///
    /// Outside the sessions' lock order: taken only inside an opening closure or outside any session call, never
    /// while calling a [`Sessions`] lock or open method, and released before the closure returns. Nothing is dropped
    /// while it is held that could be a vault.
    pub(crate) fn creating(&self) -> MutexGuard<'_, ()> {
        #[cfg(test)]
        match self.creating.try_lock() {
            Ok(creating) => return creating,
            Err(TryLockError::Poisoned(poisoned)) => return poisoned.into_inner(),
            Err(TryLockError::WouldBlock) => {
                self.creating_waited.fetch_add(1, Ordering::SeqCst);
            }
        }
        lock(&self.creating)
    }

    /// Tests only: how many times a creation or addition has had to wait for another.
    #[cfg(test)]
    pub(crate) fn creation_waits(&self) -> usize {
        self.creating_waited.load(Ordering::SeqCst)
    }

    /// The page's "Lock all": revokes every vault, then cancels every long operation, since testing a backup has no
    /// session for the lock to reach and holds the backup's key while it runs; then waits for the hooks, so a slow hook
    /// delays neither step. In this order: an operation that begins in between sees the lock in the sessions' epoch.
    pub fn lock_all(&self) {
        let hooks = self.sessions.revoke_all(LockReason::Manual);
        self.autolock.cancel_operations();
        if let Some(hooks) = hooks {
            hooks.wait();
        }
    }

    /// Closing the app (the main window's close request, the app's exit, or Windows ending the session): locks every
    /// vault on a helper thread and cancels every long operation, then waits at most
    /// [`SHUTDOWN_WAIT`](crate::autolock::SHUTDOWN_WAIT) for the lock and its hooks (the clipboard clear and the "Open"
    /// cleanup, which treat `None` as all) before the process may exit. It does no hook work of its own. Every call,
    /// the second included, waits the same way.
    pub fn shutdown(&self) {
        // The probe's slot first: it needs no wait, and nothing may keep it past the close.
        drop(lock(&self.probe_captured).take());
        self.autolock.shutdown();
    }

    /// Launch work after restore recovery ([`launch_work`](Self::launch_work)): sweeps the output journal's leftovers.
    /// When there was anything to tell, the report is kept for [`launch_notices`](Self::launch_notices) (launch work
    /// runs before the page can listen) and also sent as `lockbox://notice` (`output_sweep`). Then the leftovers in
    /// `open\` that no journal entry lists; those and the "Open" folders the sweep could not remove go on the retry
    /// list, told the same way (`open_cleanup`).
    pub fn sweep_outputs(&self) -> SweepReport {
        let report = self.outputs.sweep();
        if report != SweepReport::default() {
            self.tell(Notice::OutputSweep(report));
        }
        let open = self.open_folders.sweep_leftovers();
        if open != RemoveReport::default() {
            self.tell(Notice::OpenCleanup(open));
        }
        report
    }

    /// Tells the page a launch finding: sent as `lockbox://notice`, and kept for
    /// [`launch_notices`](Self::launch_notices), since the page cannot listen yet.
    pub(crate) fn tell(&self, notice: Notice) {
        self.notifier.notice(&notice);
        lock(&self.launch_notices).push(notice);
    }

    /// Sends `notice` as `lockbox://notice` and keeps nothing: a finding of a running app, which the page asks for
    /// again with its own command.
    pub(crate) fn notify(&self, notice: &Notice) {
        self.notifier.notice(notice);
    }

    /// What launch found that the page should show, asked by the page once it has loaded: each launch notice, counts
    /// and flags only. Kept, not used up, so a reloaded page shows it again.
    pub fn launch_notices(&self) -> Vec<Notice> {
        lock(&self.launch_notices).clone()
    }

    /// Where an output the user chose in a save dialog (Save a copy, a backup) goes: `dest` with its folder canonical
    /// (links, junctions and short names resolved), so the checks and the output journal name the folder it really
    /// lands in. Refused inside the state folder (spec §7.2): `InvalidInput { what: "state folder" }`.
    pub fn output_destination(&self, dest: &Path) -> ShellResult<PathBuf> {
        let (Some(name), Some(folder)) = (dest.file_name(), dest.parent()) else {
            return Err(ShellError::InvalidInput { what: "file name" });
        };
        let folder = fs::canonicalize(folder)?;
        let state = match fs::canonicalize(&self.paths.root) {
            Ok(state) => Some(state),
            // Not made yet: nothing is inside it.
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        if state.is_some_and(|state| is_within(&folder, &state)) {
            return Err(ShellError::InvalidInput {
                what: "state folder",
            });
        }
        Ok(folder.join(name))
    }

    /// Whether a vault may be at `dir` (see [`check_location`]).
    pub fn check_location(&self, dir: &Path) -> ShellResult<LocationCheck> {
        check_location(
            self.os.volumes.as_ref(),
            self.os.env.as_ref(),
            &self.forbidden,
            dir,
        )
    }
}

/// Sends the shell's events to the main window.
pub struct Events<R: Runtime>(pub AppHandle<R>);

#[derive(Clone, Serialize)]
struct Locked {
    session: SessionId,
    generation: u64,
    reason: LockReason,
}

#[derive(Clone, Serialize)]
struct Busy<'a> {
    session: Option<SessionId>,
    operations: &'a [&'static str],
}

impl<R: Runtime> Events<R> {
    /// Best effort: with the window gone there is no page to tell, and the page checks every answer's generation
    /// anyway (spec §7.4).
    fn emit(&self, event: &str, payload: impl Serialize + Clone) {
        let _ = self
            .0
            .emit_to(EventTarget::webview_window(window::MAIN), event, payload);
    }
}

impl<R: Runtime> Notifier for Events<R> {
    fn locked(&self, session: SessionId, generation: u64, reason: LockReason) {
        self.emit(
            LOCKED_EVENT,
            Locked {
                session,
                generation,
                reason,
            },
        );
    }

    fn busy(&self, session: Option<SessionId>, operations: &[&'static str]) {
        self.emit(
            BUSY_EVENT,
            Busy {
                session,
                operations,
            },
        );
    }

    fn notice(&self, notice: &Notice) {
        self.emit(NOTICE_EVENT, notice);
    }
}

/// How long [`Shell::probe_print_pdf`] waits for the print to end.
const PROBE_PRINT_WAIT: Duration = Duration::from_secs(60);

/// How the print probe ended. Fixed words and numbers only: never a path (the page never receives one).
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum ProbePrinted {
    /// The save dialog was closed: nothing was made.
    Dismissed,
    /// Something already exists at the chosen place: nothing was made, nothing was written over.
    DestinationExists,
    /// A step before or after the print failed: `step` says which.
    Refused { step: &'static str },
    /// A print job of Lockbox's own is still running.
    Busy,
    /// WebView2 refused to start the job; `code` is its `HRESULT`.
    NotStarted { code: i32 },
    /// The job ended without a file; `code` is the `HRESULT` it gave (0 for none).
    NotWritten { code: i32 },
    /// No answer in time. Whatever the run made is left beside the chosen place, since WebView2 may still write it.
    NoAnswer,
    /// The PDF is at the chosen place. `temp_hidden`: the temp file had the hidden attribute when the print ended.
    /// `hid_after`: for the form that hides it only afterwards, whether that worked; `None` for every other form.
    Printed {
        size: u64,
        temp_hidden: bool,
        hid_after: Option<bool>,
    },
}

/// What of its own a probe run left behind. Nothing, unless a removal failed or the print gave no answer.
#[derive(Debug, Default, PartialEq, Eq, Serialize)]
pub struct Left {
    /// A temp file is still there; whether it is hidden.
    pub file_hidden: Option<bool>,
    /// The hidden folder the run made is still there.
    pub folder: bool,
}

/// The form of temp file the print probe hands WebView2, one button for each (hands-on only: this and the probe go in
/// Task 5). It decides only the path and the file behind it; the page sends this word and nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrintForm {
    /// A name that does not exist yet, beside the destination, as the dialog gave it; WebView2 creates the file.
    NewPlain,
    /// The same, named by a `\\?\` path.
    NewLong,
    /// An empty temp made first, not hidden, named by a `\\?\` path.
    ExistingPlain,
    /// An empty hidden temp made first, named by a `\\?\` path.
    ExistingHidden,
    /// A new name, `\\?\` path, WebView2 creates the file; the probe hides it only after the print answers.
    NewThenHide,
    /// A new hidden folder beside the destination, and a new not-hidden temp name inside it, `\\?\` path.
    InHiddenFolder,
}

/// What the print probe answers: the form it ran, how it ended, and what of its own it left behind.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct ProbePrintAnswer {
    pub form: PrintForm,
    #[serde(flatten)]
    pub result: ProbePrinted,
    pub left: Left,
}

impl ProbePrintAnswer {
    fn nothing_made(form: PrintForm, result: ProbePrinted) -> ProbePrintAnswer {
        ProbePrintAnswer {
            form,
            result,
            left: Left::default(),
        }
    }
}

/// What a run made besides the PDF.
struct Made {
    temp: PathBuf,
    /// The hidden folder the temp is in, when the run made one.
    folder: Option<PathBuf>,
}

/// A random 16-hex-character name part, as the engine names its own temps.
fn random_name() -> Option<String> {
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).ok()?;
    Some(random.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Makes what `form` needs beside `dest`, or says which step failed (and leaves nothing it made).
fn make_temp(form: PrintForm, dest: &Path) -> Result<Made, &'static str> {
    let folder = match form {
        PrintForm::NewPlain => dest.parent().map(Path::to_path_buf),
        // `canonicalize` gives the `\\?\` form of the folder.
        _ => dest
            .parent()
            .and_then(|folder| fs::canonicalize(folder).ok()),
    }
    .ok_or("folder")?;
    let (first, second) = (random_name().ok_or("name")?, random_name().ok_or("name")?);
    // The temp's name, as the engine names its own: a dot, 16 hex characters, `.tmp`.
    let temp_name = format!(".{first}.tmp");
    match form {
        PrintForm::NewPlain | PrintForm::NewLong | PrintForm::NewThenHide => Ok(Made {
            temp: folder.join(temp_name),
            folder: None,
        }),
        PrintForm::ExistingPlain | PrintForm::ExistingHidden => {
            let temp = folder.join(temp_name);
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            if form == PrintForm::ExistingHidden {
                options.attributes(FILE_ATTRIBUTE_HIDDEN);
            }
            options.open(&temp).map_err(|_| "temp")?;
            Ok(Made { temp, folder: None })
        }
        PrintForm::InHiddenFolder => {
            let hidden = folder.join(format!(".{second}"));
            fs::create_dir(&hidden).map_err(|_| "folder")?;
            if crate::os::win::set_hidden(&hidden).is_err() {
                // Empty and just made: `remove_dir` takes nothing else.
                let _ = fs::remove_dir(&hidden);
                return Err("folder");
            }
            Ok(Made {
                temp: hidden.join(temp_name),
                folder: Some(hidden),
            })
        }
    }
}

/// What of `made` is still there.
fn inspect(made: &Made) -> Left {
    Left {
        file_hidden: fs::metadata(&made.temp)
            .ok()
            .map(|meta| meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0),
        folder: made
            .folder
            .as_ref()
            .is_some_and(|folder| fs::symlink_metadata(folder).is_ok()),
    }
}

/// Removes what the run made, and only that: the temp file, then the folder if the run made one (`remove_dir`, so a
/// folder with anything else in it stays). Says what is left.
fn clean_up(made: &Made) -> Left {
    let _ = remove_file_retry(&made.temp);
    if let Some(folder) = &made.folder {
        let _ = fs::remove_dir(folder);
    }
    inspect(made)
}

/// Prints the page to a PDF that ends up at `dest`, through a temp file in the `form` asked for. Nothing is ever written
/// over: a `dest` that exists is refused before anything is made, and the last step makes `dest` new or fails. The only
/// things removed are the temp file and the folder this run made.
pub(crate) fn probe_print_to(
    printer: &dyn Printer,
    dest: &Path,
    form: PrintForm,
    wait: Duration,
) -> ProbePrintAnswer {
    let reply = |result, left| ProbePrintAnswer { form, result, left };
    let nothing = |result| ProbePrintAnswer::nothing_made(form, result);
    // Anything at the place (a file, a folder, a dangling link) refuses it, before anything is made.
    match fs::symlink_metadata(dest) {
        Ok(_) => return nothing(ProbePrinted::DestinationExists),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => {
            return nothing(ProbePrinted::Refused {
                step: "destination",
            });
        }
    }
    let made = match make_temp(form, dest) {
        Ok(made) => made,
        Err(step) => return nothing(ProbePrinted::Refused { step }),
    };

    match printer.print_to_pdf(&made.temp).recv_timeout(wait) {
        Ok(Ok(())) => {}
        // WebView2 may still be writing the file: it stays.
        Err(RecvTimeoutError::Timeout) => return reply(ProbePrinted::NoAnswer, inspect(&made)),
        failed => {
            let result = match failed {
                Ok(Err(PrintFailed::Busy)) => ProbePrinted::Busy,
                Ok(Err(PrintFailed::NotStarted { code })) => ProbePrinted::NotStarted { code },
                Ok(Err(PrintFailed::NotWritten { code })) => ProbePrinted::NotWritten { code },
                // The webview went away before it answered.
                _ => ProbePrinted::NotWritten { code: 0 },
            };
            return reply(result, clean_up(&made));
        }
    }

    let Ok(written) = fs::metadata(&made.temp) else {
        return reply(ProbePrinted::Refused { step: "read" }, clean_up(&made));
    };
    let temp_hidden = written.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0;
    let hid_after =
        (form == PrintForm::NewThenHide).then(|| crate::os::win::set_hidden(&made.temp).is_ok());
    // A new file, or nothing: `create_new` never opens one that is there, so nothing is written over.
    let copied = File::open(&made.temp).and_then(|mut from| {
        let mut to = OpenOptions::new().write(true).create_new(true).open(dest)?;
        io::copy(&mut from, &mut to)?;
        to.sync_all()
    });
    let left = clean_up(&made);
    let result = match copied {
        Ok(()) => ProbePrinted::Printed {
            size: written.len(),
            temp_hidden,
            hid_after,
        },
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            ProbePrinted::DestinationExists
        }
        Err(_) => ProbePrinted::Refused { step: "publish" },
    };
    reply(result, left)
}

/// `FILE_ATTRIBUTE_HIDDEN`.
const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;

#[cfg(test)]
mod tests {
    use std::time::Instant;
    use std::{fs, thread};

    use lockbox_core::item::MAX_ITEM_JSON;

    use super::*;
    use crate::testing::TestShell;

    /// A made-up text, never a real secret.
    const COPIED: &str = "Pw-0123456789-xyz";

    /// Each press counts and reads the clipboard once into the one slot: a second press replaces the first's text
    /// (the length is the new text's, not both), and a press that finds no text, or too much, leaves the slot empty.
    #[test]
    fn a_press_reads_once_into_the_one_slot() {
        let ts = TestShell::new();
        assert_eq!(ts.shell.probe_capture_length(), 0);
        assert!(ts.clipboard.user_copy(COPIED));
        ts.shell.save_shortcut_pressed();
        assert_eq!(ts.shell.shortcut_presses(), 1);
        assert_eq!(ts.shell.probe_capture_length(), COPIED.len());
        assert_eq!(ts.clipboard.opens(), 1, "more than one opening");

        assert!(ts.clipboard.user_copy("short"));
        ts.shell.save_shortcut_pressed();
        assert_eq!(ts.shell.probe_capture_length(), "short".len());

        assert!(ts.clipboard.user_copy_non_text());
        ts.shell.save_shortcut_pressed();
        assert_eq!(ts.shell.probe_capture_length(), 0, "an old text was kept");

        assert!(ts.clipboard.user_copy(COPIED));
        ts.shell.save_shortcut_pressed();
        assert!(ts.clipboard.user_copy(&"a".repeat(MAX_ITEM_JSON + 1)));
        ts.shell.save_shortcut_pressed();
        assert_eq!(ts.shell.probe_capture_length(), 0, "a large text was kept");

        assert_eq!(ts.shell.shortcut_presses(), 5);
        // Reading never changes the clipboard.
        assert!(ts.clipboard.text().is_some());
    }

    /// A press that cannot open the clipboard leaves the slot empty too, not the earlier text.
    #[test]
    fn a_press_on_a_busy_clipboard_leaves_the_slot_empty() {
        let ts = TestShell::new();
        assert!(ts.clipboard.user_copy(COPIED));
        ts.shell.save_shortcut_pressed();
        assert_eq!(ts.shell.probe_capture_length(), COPIED.len());
        ts.clipboard.hold_open_elsewhere(true);
        ts.shell.save_shortcut_pressed();
        assert_eq!(ts.shell.probe_capture_length(), 0);
    }

    /// The clear takes the clipboard only while it holds the text that press read, never "the newest": a text copied
    /// after the press is left alone, and the slot is empty afterwards either way.
    #[test]
    fn probe_clear_clears_only_what_it_read() {
        let ts = TestShell::new();
        assert!(!ts.shell.probe_clear_captured(), "nothing captured");

        assert!(ts.clipboard.user_copy(COPIED));
        ts.shell.save_shortcut_pressed();
        assert!(ts.shell.probe_clear_captured());
        assert_eq!(ts.clipboard.text(), None);
        assert_eq!(ts.shell.probe_capture_length(), 0);

        assert!(ts.clipboard.user_copy(COPIED));
        ts.shell.save_shortcut_pressed();
        assert!(ts.clipboard.user_copy("copied later"));
        assert!(!ts.shell.probe_clear_captured());
        assert_eq!(ts.clipboard.text().as_deref(), Some("copied later"));
        assert_eq!(ts.shell.probe_capture_length(), 0);

        // The text is the same again, but the slot was emptied: a second clear has nothing to go by.
        assert!(ts.clipboard.user_copy(COPIED));
        assert!(!ts.shell.probe_clear_captured());
        assert_eq!(ts.clipboard.text().as_deref(), Some(COPIED));
    }

    /// A clear that cannot open the clipboard says no, and still empties the slot.
    #[test]
    fn probe_clear_on_a_busy_clipboard_says_no() {
        let ts = TestShell::new();
        assert!(ts.clipboard.user_copy(COPIED));
        ts.shell.save_shortcut_pressed();
        ts.clipboard.hold_open_elsewhere(true);
        assert!(!ts.shell.probe_clear_captured());
        assert_eq!(ts.shell.probe_capture_length(), 0);
        ts.clipboard.hold_open_elsewhere(false);
        assert_eq!(ts.clipboard.text().as_deref(), Some(COPIED));
    }

    /// A made-up PDF, never a real document.
    const PDF: &[u8] = b"%PDF-1.4 print probe test bytes";

    /// The names in `dir`, sorted, hidden ones included.
    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    /// `path` with the `\\?\` prefix a canonical path carries taken off: the form a dialog hands back.
    fn plain(path: &Path) -> PathBuf {
        PathBuf::from(path.to_str().unwrap().trim_start_matches(r"\\?\"))
    }

    /// Runs the probe on its own thread, as a command does, lets the one print job it starts end with `outcome`, and
    /// gives the probe's answer.
    fn probe_until(
        ts: &TestShell,
        form: PrintForm,
        outcome: Result<(), PrintFailed>,
    ) -> ProbePrintAnswer {
        let shell = Arc::clone(&ts.shell);
        let probe = thread::spawn(move || shell.probe_print_pdf(form));
        wait_for_print(ts);
        assert!(ts.print.finish(outcome));
        probe.join().unwrap()
    }

    fn wait_for_print(ts: &TestShell) {
        let began = Instant::now();
        while ts.print.started().is_empty() {
            assert!(began.elapsed() < Duration::from_secs(30), "no print began");
            thread::sleep(Duration::from_millis(2));
        }
    }

    const FORMS: [PrintForm; 6] = [
        PrintForm::NewPlain,
        PrintForm::NewLong,
        PrintForm::ExistingPlain,
        PrintForm::ExistingHidden,
        PrintForm::NewThenHide,
        PrintForm::InHiddenFolder,
    ];

    fn is_long(path: &Path) -> bool {
        path.to_str().unwrap().starts_with(r"\\?\")
    }

    fn hidden(path: &Path) -> bool {
        fs::metadata(path).unwrap().file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
    }

    /// A closed dialog makes nothing, whatever the form.
    #[test]
    fn probe_print_dialog_closed_creates_nothing() {
        for form in FORMS {
            let ts = TestShell::new();
            let out = ts.folder("out");
            ts.dialogs.answer(None);
            let answer = ts.shell.probe_print_pdf(form);
            assert_eq!(
                answer,
                ProbePrintAnswer::nothing_made(form, ProbePrinted::Dismissed)
            );
            assert!(ts.print.started().is_empty());
            assert!(names(&out).is_empty());
        }
    }

    /// A place that is already taken is refused before anything is made, and what is there is left as it was.
    #[test]
    fn probe_print_refuses_an_existing_destination() {
        for form in FORMS {
            let ts = TestShell::new();
            let out = ts.folder("out");
            let dest = out.join("mine.pdf");
            fs::write(&dest, b"keep me").unwrap();
            ts.dialogs.answer(Some(dest.clone()));
            assert_eq!(
                ts.shell.probe_print_pdf(form),
                ProbePrintAnswer::nothing_made(form, ProbePrinted::DestinationExists)
            );
            assert!(ts.print.started().is_empty(), "{form:?} printed anyway");
            assert_eq!(fs::read(&dest).unwrap(), b"keep me");
            assert_eq!(names(&out), ["mine.pdf"], "{form:?} left something");
        }
    }

    /// Each form hands the printer the path it names, and what is there when the print begins is what it names:
    /// plain or `\\?\`, a file already there or not, hidden or not, in a hidden folder or beside the destination. Then
    /// the PDF is at the destination, everything the run made is gone, and nothing else in the folder was touched.
    #[test]
    fn probe_print_each_form_hands_webview2_the_path_it_names() {
        for form in FORMS {
            let ts = TestShell::new();
            let out = ts.folder("out");
            fs::write(out.join("neighbour.pdf"), b"theirs").unwrap();
            fs::write(out.join(".dot-neighbour"), b"theirs too").unwrap();
            fs::create_dir(out.join("neighbour-folder")).unwrap();
            ts.print.write_on_success(PDF);
            let dest = plain(&out).join("probe.pdf");
            assert!(!is_long(&dest));
            ts.dialogs.answer(Some(dest.clone()));

            let answer = probe_until(&ts, form, Ok(()));

            let [job] = <[_; 1]>::try_from(ts.print.started()).unwrap();
            let name = job.path.file_name().unwrap().to_str().unwrap();
            assert!(name.starts_with('.') && name.ends_with(".tmp"), "{name}");
            let (long, existed, was_hidden, in_hidden_folder, hid_after) = match form {
                PrintForm::NewPlain => (false, false, false, false, None),
                PrintForm::NewLong => (true, false, false, false, None),
                PrintForm::ExistingPlain => (true, true, false, false, None),
                PrintForm::ExistingHidden => (true, true, true, false, None),
                PrintForm::NewThenHide => (true, false, false, false, Some(true)),
                PrintForm::InHiddenFolder => (true, false, false, true, None),
            };
            assert_eq!(is_long(&job.path), long, "{form:?}: {job:?}");
            assert_eq!(job.existed, existed, "{form:?}: {job:?}");
            assert_eq!(job.hidden, was_hidden, "{form:?}: {job:?}");
            assert_eq!(job.folder_hidden, in_hidden_folder, "{form:?}: {job:?}");
            let beside = if in_hidden_folder {
                job.path.parent().unwrap().parent().unwrap()
            } else {
                job.path.parent().unwrap()
            };
            assert!(
                crate::os::same_path(beside, &out) || crate::os::same_path(beside, &plain(&out)),
                "{form:?}: not beside the destination: {job:?}"
            );

            assert_eq!(
                answer,
                ProbePrintAnswer {
                    form,
                    result: ProbePrinted::Printed {
                        size: PDF.len() as u64,
                        // What the file looked like when the print ended: hidden only where it was made hidden.
                        temp_hidden: was_hidden,
                        hid_after,
                    },
                    left: Left::default(),
                }
            );
            assert_eq!(fs::read(&dest).unwrap(), PDF);
            assert!(!hidden(&dest), "{form:?}: the PDF was left hidden");
            assert_eq!(
                names(&out),
                [
                    ".dot-neighbour",
                    "neighbour-folder",
                    "neighbour.pdf",
                    "probe.pdf"
                ],
                "{form:?}"
            );
            assert_eq!(fs::read(out.join("neighbour.pdf")).unwrap(), b"theirs");
            assert_eq!(fs::read(out.join(".dot-neighbour")).unwrap(), b"theirs too");
        }
    }

    /// A print that says it succeeded but left no file (the forms where WebView2 is to create the file) is reported
    /// as refused at the step "read", nothing is made at the destination, and the hidden folder the run made is gone.
    #[test]
    fn probe_print_success_without_a_file_is_refused_at_read() {
        for form in [
            PrintForm::NewPlain,
            PrintForm::NewLong,
            PrintForm::NewThenHide,
            PrintForm::InHiddenFolder,
        ] {
            let ts = TestShell::new();
            let out = ts.folder("out");
            ts.dialogs.answer(Some(out.join("probe.pdf")));
            // The fake writes nothing here.
            let answer = probe_until(&ts, form, Ok(()));
            assert_eq!(
                answer,
                ProbePrintAnswer::nothing_made(form, ProbePrinted::Refused { step: "read" }),
                "{form:?}"
            );
            assert!(names(&out).is_empty(), "{form:?}");
        }
    }

    /// A destination that appears while the print runs is never written over, in any form: the last step makes the
    /// file new or fails, and what the run made is still cleaned up.
    #[test]
    fn probe_print_never_overwrites_a_destination_that_appears_meanwhile() {
        for form in FORMS {
            let ts = TestShell::new();
            let out = ts.folder("out");
            let dest = out.join("probe.pdf");
            ts.print.write_on_success(PDF);
            ts.dialogs.answer(Some(dest.clone()));

            let shell = Arc::clone(&ts.shell);
            let probe = thread::spawn(move || shell.probe_print_pdf(form));
            wait_for_print(&ts);
            fs::write(&dest, b"theirs, made meanwhile").unwrap();
            assert!(ts.print.finish(Ok(())));

            assert_eq!(
                probe.join().unwrap(),
                ProbePrintAnswer::nothing_made(form, ProbePrinted::DestinationExists),
                "{form:?}"
            );
            assert_eq!(fs::read(&dest).unwrap(), b"theirs, made meanwhile");
            assert_eq!(names(&out), ["probe.pdf"], "{form:?}: something was left");
        }
    }

    /// Every way the print can fail is reported as it is, in every form, with nothing at the destination and only
    /// what the run made removed: the files and folders beside it stay.
    #[test]
    fn probe_print_failure_removes_only_what_it_made() {
        for form in FORMS {
            let ts = TestShell::new();
            let out = ts.folder("out");
            fs::write(out.join("neighbour.pdf"), b"theirs").unwrap();
            fs::write(out.join(".dot-neighbour.tmp"), b"theirs too").unwrap();
            fs::create_dir(out.join(".dot-folder")).unwrap();
            let before = names(&out);
            let dest = out.join("probe.pdf");
            let gone = |result| ProbePrintAnswer::nothing_made(form, result);

            ts.dialogs.answer(Some(dest.clone()));
            let ended = PrintFailed::NotWritten { code: 5 };
            assert_eq!(
                probe_until(&ts, form, Err(ended)),
                gone(ProbePrinted::NotWritten { code: 5 })
            );
            assert_eq!(names(&out), before, "{form:?}");

            // WebView2 refuses to begin.
            ts.dialogs.answer(Some(dest.clone()));
            ts.print.refuse_next(PrintFailed::NotStarted { code: -2 });
            assert_eq!(
                ts.shell.probe_print_pdf(form),
                gone(ProbePrinted::NotStarted { code: -2 })
            );
            assert_eq!(names(&out), before, "{form:?}");

            // A job of Lockbox's own is still running.
            let _running = ts.shell.os.printer.print_to_pdf(Path::new("other.pdf"));
            ts.dialogs.answer(Some(dest.clone()));
            assert_eq!(ts.shell.probe_print_pdf(form), gone(ProbePrinted::Busy));
            assert_eq!(names(&out), before, "{form:?}");
            assert_eq!(fs::read(out.join("neighbour.pdf")).unwrap(), b"theirs");
            assert_eq!(
                fs::read(out.join(".dot-neighbour.tmp")).unwrap(),
                b"theirs too"
            );
        }
    }

    /// The hidden folder is removed only if the run's temp was all that was in it: a file somebody else put there
    /// stays, and so does the folder, and the answer says so. Nothing is emptied.
    #[test]
    fn probe_print_hidden_folder_is_never_emptied_of_other_files() {
        let ts = TestShell::new();
        let out = ts.folder("out");
        ts.dialogs.answer(Some(out.join("probe.pdf")));
        let shell = Arc::clone(&ts.shell);
        let probe = thread::spawn(move || shell.probe_print_pdf(PrintForm::InHiddenFolder));
        wait_for_print(&ts);
        let folder = ts.print.started()[0].path.parent().unwrap().to_path_buf();
        fs::write(folder.join("stranger.txt"), b"not ours").unwrap();
        assert!(ts.print.finish(Err(PrintFailed::NotWritten { code: 0 })));

        let answer = probe.join().unwrap();
        assert_eq!(answer.result, ProbePrinted::NotWritten { code: 0 });
        assert_eq!(
            answer.left,
            Left {
                file_hidden: None,
                folder: true
            }
        );
        assert_eq!(fs::read(folder.join("stranger.txt")).unwrap(), b"not ours");
    }

    /// With no answer what the run made stays (WebView2 may still be writing it), and the answer says what and
    /// whether it is hidden; nothing is made at the destination.
    #[test]
    fn probe_print_no_answer_leaves_what_it_made() {
        let table = [
            (PrintForm::NewPlain, None, false),
            (PrintForm::NewLong, None, false),
            (PrintForm::ExistingPlain, Some(false), false),
            (PrintForm::ExistingHidden, Some(true), false),
            (PrintForm::NewThenHide, None, false),
            (PrintForm::InHiddenFolder, None, true),
        ];
        for (form, file_hidden, folder) in table {
            let ts = TestShell::new();
            let out = ts.folder("out");
            let answer = probe_print_to(
                ts.shell.os.printer.as_ref(),
                &out.join("probe.pdf"),
                form,
                Duration::from_millis(30),
            );
            assert_eq!(answer.result, ProbePrinted::NoAnswer, "{form:?}");
            assert_eq!(
                answer.left,
                Left {
                    file_hidden,
                    folder
                },
                "{form:?}"
            );
            assert!(!out.join("probe.pdf").exists(), "{form:?}");
        }
    }

    /// The answer's words, as the page reads them: the form named, the result's own fields, and what was left.
    #[test]
    fn probe_print_answer_has_the_shape_the_page_reads() {
        let answer = ProbePrintAnswer {
            form: PrintForm::InHiddenFolder,
            result: ProbePrinted::Printed {
                size: 5,
                temp_hidden: false,
                hid_after: None,
            },
            left: Left {
                file_hidden: Some(true),
                folder: false,
            },
        };
        assert_eq!(
            serde_json::to_value(answer).unwrap(),
            serde_json::json!({
                "form": "in_hidden_folder",
                "result": "printed",
                "size": 5,
                "temp_hidden": false,
                "hid_after": null,
                "left": { "file_hidden": true, "folder": false },
            })
        );
    }

    /// Closing the app empties the slot.
    #[test]
    fn shutdown_empties_the_slot() {
        let ts = TestShell::new();
        assert!(ts.clipboard.user_copy(COPIED));
        ts.shell.save_shortcut_pressed();
        assert_eq!(ts.shell.probe_capture_length(), COPIED.len());
        ts.shell.shutdown();
        assert_eq!(ts.shell.probe_capture_length(), 0);
        // What was on the clipboard is not Lockbox's to clear.
        assert_eq!(ts.clipboard.text().as_deref(), Some(COPIED));
    }
}
