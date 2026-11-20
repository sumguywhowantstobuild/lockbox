//! The app's state behind every command: plain Rust, so almost every rule is tested without a window.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::TryLockError;
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::thread;
use std::time::Instant;

use lockbox_core::fsio::refuse_vault_folder;
use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Runtime};

use crate::autolock::{AutoLock, SHUTDOWN_WAIT};
use crate::capture::{Capture, CaptureEvent, Read};
use crate::clipboard::Clipboard;
use crate::commands::env;
use crate::error::{ShellError, ShellResult};
use crate::jobs::{CloseAsked, CloseReason, JobStarted, LockEpochEvent, ProgressEvent};
use crate::locations::{
    CloudProvider, LocationCheck, check_location, cloud_provider_of, is_within,
};
use crate::lock;
use crate::open::{OpenFolders, RemoveReport};
use crate::os::{HotkeyTaken, KnownFolder, Os};
use crate::outputs::{Outputs, SweepReport};
use crate::paths::{StatePaths, state_paths};
use crate::registry::Registry;
use crate::restore::Restores;
use crate::session::{LockReason, Notice, Notifier, SessionId, Sessions};
use crate::settings::SettingsStore;
use crate::vault_state::VaultStateStore;
use crate::window;

/// A session locked: `{ session, generation, reason }`.
pub const LOCKED_EVENT: &str = "lockbox://locked";
/// The long operations under way: `{ session, operations }` (`session` null for one without a session).
pub const BUSY_EVENT: &str = "lockbox://busy";
/// Launch recovery and sweep results: `{ kind, .. }`.
pub const NOTICE_EVENT: &str = "lockbox://notice";
/// The copied value waiting for the save box changed or went: `{ capture_id, state, changed, env_keys }`.
pub const CAPTURE_EVENT: &str = "lockbox://capture";
/// A job began for the command that sent `request`: `{ request, operation, scope, kind }`.
pub const JOB_STARTED_EVENT: &str = "lockbox://job-started";
/// A job's bytes done of its total: `{ operation, scope, kind, done, total, finished }`.
pub const PROGRESS_EVENT: &str = "lockbox://progress";
/// All vaults locked, or the app closing, with or without any open: `{ epoch, reason }`.
pub const LOCK_EPOCH_EVENT: &str = "lockbox://lock-epoch";
/// A close or Quit arrived while a job runs or a restore waits: `{ reason, running, past_swap, restore_waiting }`. Sent to the main window and never kept.
pub const CLOSE_ASKED_EVENT: &str = "lockbox://close-asked";

/// A question asked of the page: what it was about, and the lock epoch it was asked in. A lock of all vaults changes the
/// epoch and so clears it (the page closes the question on `lockbox://lock-epoch`). Also what an answer claims
/// ([`Shell::claim_close_answer`]).
#[derive(Clone)]
pub struct PendingClose {
    reason: CloseReason,
    epoch: u64,
    /// What the page was sent, kept so that a repeat request sends the same again. Its `question` is the question's ID.
    asked: CloseAsked,
}

/// What the close question's lock holds: the pending question, and how many questions the shell has asked so far, which
/// is where each question's ID comes from. Together, so that an ID is given and the question that carries it is stored
/// in one step, and an answer's ID is compared with the pending one in the same step that takes the question out.
#[derive(Default)]
struct CloseQuestions {
    pending: Option<PendingClose>,
    /// The ID of the last question asked, 0 before the first. Counts up by one for each new question, never down, never
    /// repeated; a repeat of a pending question keeps its ID.
    minted: u64,
}

/// What the auto-lock does when the last running operation ends ([`AutoLock::on_last_end`]): hands the carry-on of a
/// pending close question ([`Shell::carry_on_close`]) to a thread of its own and returns at once. The ending thread may
/// be inside a lock's cancel or a lock hook, or just past the release of the operations' list, and the carry-on waits
/// for lock hooks; the shell is taken from its `Weak` on the new thread, so the ending thread never holds the last
/// reference to it. A thread that cannot start leaves the question as it is, still there for the person to answer:
/// unlike [`Shell::run_in_background`] this never falls back to running the work here.
fn carry_on_off_this_thread(shell: &Weak<Shell>) {
    #[cfg(test)]
    if let Some(shell) = shell.upgrade() {
        shell.carry_on_asks.fetch_add(1, Ordering::SeqCst);
    }
    let shell = Weak::clone(shell);
    let _ = thread::Builder::new()
        .name("lockbox-carry-on".into())
        .spawn(move || {
            if let Some(shell) = shell.upgrade() {
                shell.carry_on_close();
                #[cfg(test)]
                shell.carry_on_looks.fetch_add(1, Ordering::SeqCst);
            }
        });
}

/// What [`Shell::checked_output`] found: a destination that may be written now, or one in a cloud-synced folder that
/// needs the user's yes first. Either way, the canonical destination.
pub(crate) enum Checked {
    Ready(PathBuf),
    /// A folder a cloud provider syncs, with the provider the check found (for the question to name).
    Cloud(PathBuf, CloudProvider),
}

pub struct Shell {
    pub sessions: Arc<Sessions>,
    pub settings: Arc<SettingsStore>,
    /// Lockbox's clipboard copies, cleared after the delay, at a lock of their vault and at app close.
    pub clipboard: Clipboard,
    /// Locks the vaults on idle, Windows' signals, vanished folders and app exit.
    pub autolock: AutoLock,
    pub registry: Registry,
    /// What is noted about each vault folder: the "recovery key not confirmed" mark, the last backup.
    pub vault_state: VaultStateStore,
    /// The output journal (spec §7.2): every temporary plaintext file, written down before it exists.
    pub outputs: Arc<Outputs>,
    /// The "Open" folders (spec §7.2), removed at a lock of their vault and at app close.
    pub open_folders: Arc<OpenFolders>,
    /// The one restore that may be alive (spec §6.8) and the pre-restore folders last listed.
    pub restore: Arc<Restores>,
    /// The copied value the save shortcut read, waiting for the save box (one slot).
    pub capture: Arc<Capture>,
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
    /// One close of the window at a time; true while 5b, the first-close explanation, shows
    /// ([`close_window`](Self::close_window)).
    explaining: Mutex<bool>,
    /// The close or Quit the page was asked about and has not answered ([`ask_before_closing`](Self::ask_before_closing)).
    /// Held only while the epoch and the running jobs are read, never across a lock, a hook or the notifier.
    close_question: Mutex<CloseQuestions>,
    /// How many times the window was shown again ([`window_shown`](Self::window_shown)). Held while the window gate is
    /// sealed for a hide or lifted by a show, so a close knows whether a reopen came after its seal
    /// ([`lock_and_hide`](Self::lock_and_hide)). Never held across a lock or a call to the window.
    window_shows: Arc<Mutex<u64>>,
    /// One change of the settings at a time, held from the shortcut's registration to the save
    /// ([`set_settings`](Self::set_settings)).
    pub(crate) settings_change: Mutex<()>,
    /// How many times the save shortcut has been pressed: what the router's test watches.
    shortcut_presses: AtomicU64,
    /// Tests only: how many times a creation or addition had to wait for another.
    #[cfg(test)]
    creating_waited: AtomicUsize,
    /// Tests only: how long a PDF job waits for the printer's answer, in place of
    /// [`PRINT_ANSWER_WAIT`](crate::commands::readable::PRINT_ANSWER_WAIT).
    #[cfg(test)]
    pub(crate) print_wait: Mutex<Option<std::time::Duration>>,
    /// Tests only: how many times the end of the last operation asked for a carry-on (counted on the ending thread,
    /// before it returns), and how many of those the carry-on's own thread has finished
    /// ([`carry_on_settled`](Self::carry_on_settled)).
    #[cfg(test)]
    carry_on_asks: AtomicUsize,
    #[cfg(test)]
    carry_on_looks: AtomicUsize,
}

impl Shell {
    /// `app_dirs`: Tauri's `app_data_dir` and `app_local_data_dir`, which an uninstaller may delete. Reads only the
    /// known folders and the settings: nothing is written until a command saves state. The shell is made shared here
    /// because the auto-lock reports the end of the last operation to it ([`carry_on_close`](Self::carry_on_close)),
    /// through a `Weak` the auto-lock keeps: it is wired to hear that from the moment it exists.
    pub fn new(
        notifier: Arc<dyn Notifier>,
        os: Os,
        app_dirs: Vec<PathBuf>,
    ) -> io::Result<Arc<Self>> {
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
        // Then the pasted `.env` values' (a lock of one vault drains nothing of `Pending` by itself, and a paste parked
        // while a lock was under way is dropped here).
        sessions.on_lock(env::lock_hook(Arc::downgrade(&sessions)));
        // Then the capture slot's: every lock of all vaults empties it, and a lock of the vault it was handed to does.
        let capture = Arc::new(Capture::default());
        sessions.on_lock(capture.lock_hook(Arc::downgrade(&sessions), Arc::clone(&notifier)));
        let shell = Shell {
            sessions,
            settings,
            clipboard,
            autolock,
            registry: Registry::new(paths.registry.clone(), Arc::clone(&os.volumes)),
            vault_state: VaultStateStore::new(paths.vault_state.clone()),
            outputs,
            open_folders,
            restore,
            capture,
            paths,
            os,
            notifier,
            launch_notices: Mutex::default(),
            forbidden,
            creating: Mutex::default(),
            explaining: Mutex::default(),
            close_question: Mutex::default(),
            window_shows: Arc::default(),
            settings_change: Mutex::default(),
            shortcut_presses: AtomicU64::new(0),
            #[cfg(test)]
            creating_waited: AtomicUsize::new(0),
            #[cfg(test)]
            print_wait: Mutex::default(),
            #[cfg(test)]
            carry_on_asks: AtomicUsize::new(0),
            #[cfg(test)]
            carry_on_looks: AtomicUsize::new(0),
        };
        Ok(Arc::new_cyclic(|weak| {
            let weak = Weak::clone(weak);
            shell
                .autolock
                .on_last_end(move || carry_on_off_this_thread(&weak));
            shell
        }))
    }

    /// The save shortcut was pressed: reads the clipboard once, into the one capture slot (a text with something in it, or
    /// nothing, or too much), tells the page its id and state, and brings the window forward, in that order. Runs on a thread
    /// of its own (the clipboard may be held by another program), never the signal window's, so a read that waits holds up
    /// no lock signal.
    ///
    /// The sessions' epoch is read before the read begins: when every vault locks while it runs (a lock, the window's
    /// close, idle, Windows' lock or sleep, Quit), the slot keeps nothing and nothing is sent or shown.
    pub fn save_shortcut_pressed(&self) {
        self.shortcut_presses.fetch_add(1, Ordering::SeqCst);
        let began = self.sessions.epoch();
        let read = Read::of(self.os.clipboard.read_text(None));
        if self
            .capture
            .fill(&*self.notifier, &self.sessions, began, read)
        {
            self.os.window.bring_forward();
        }
    }

    /// Registers the save shortcut the settings hold (Ctrl+Shift+L until the person changes it) and tells the page what
    /// Windows answered ([`shortcut_registered`](Self::shortcut_registered)). Once, at launch, after the signals are
    /// routed so that a press that comes at once is answered. The app runs whatever Windows says.
    pub fn register_save_shortcut(&self) {
        let saved = self.settings.get().shortcut;
        self.shortcut_registered(self.os.hotkey.set(Some(saved)));
    }

    /// What Windows answered when the save shortcut was registered at launch: a shortcut that is taken, or that could not
    /// be set, is told to the page as a launch notice. The app runs either way.
    pub fn shortcut_registered(&self, answer: Result<(), HotkeyTaken>) {
        match answer {
            Ok(()) => {}
            Err(HotkeyTaken::Taken) => self.tell(Notice::ShortcutTaken),
            Err(HotkeyTaken::NotSet) => self.tell(Notice::ShortcutNotSet),
        }
    }

    /// Forgets the kept launch notice that the save shortcut was taken or not set: a shortcut was registered and saved
    /// since, so a page that asks again must not hear a failure that no longer holds. Other launch notices stay.
    pub(crate) fn forget_shortcut_failure(&self) {
        lock(&self.launch_notices)
            .retain(|kept| !matches!(kept, Notice::ShortcutTaken | Notice::ShortcutNotSet));
    }

    /// Whether the save shortcut is off since launch: Windows refused it then, and no shortcut has been registered and
    /// saved since (the kept launch notice says so until [`forget_shortcut_failure`](Self::forget_shortcut_failure)).
    pub(crate) fn shortcut_failed_at_launch(&self) -> bool {
        lock(&self.launch_notices)
            .iter()
            .any(|kept| matches!(kept, Notice::ShortcutTaken | Notice::ShortcutNotSet))
    }

    /// Where the shell's events go.
    pub(crate) fn notifier(&self) -> &dyn Notifier {
        &*self.notifier
    }

    /// How many times the save shortcut has been pressed.
    pub fn shortcut_presses(&self) -> u64 {
        self.shortcut_presses.load(Ordering::SeqCst)
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

    /// Runs `work` on a thread of its own, so it never holds up the thread that asked (the window's event loop: a lock
    /// waits for the hooks). A thread that cannot start runs it here instead: a lock is never skipped.
    pub(crate) fn run_in_background(self: &Arc<Self>, work: fn(&Shell)) {
        let shell = Arc::clone(self);
        let started = thread::Builder::new()
            .name("lockbox-window".into())
            .spawn(move || work(&shell));
        if started.is_err() {
            work(self);
        }
    }

    /// The window's close button: with a job running, asks the page first ([`ask_before_closing`](Self::ask_before_closing));
    /// with none, closes as it always has ([`close_window`](Self::close_window)). Waits for the lock hooks when it
    /// closes, so the caller runs it off the event loop's thread ([`run_in_background`](Self::run_in_background)).
    pub fn close_or_ask(&self) {
        if !self.ask_before_closing(CloseReason::Close) {
            self.close_window();
        }
    }

    /// With at least one job running (every operation the auto-lock counts: [`AutoLock::running_kinds`]), or a restore
    /// finished and waiting for its yes at 24d ([`Restores::waiting`]), asks the page whether to go on with a close or
    /// Quit (`lockbox://close-asked`) and answers `true`; nothing is locked, hidden or cancelled until
    /// [`close_answer`](Self::close_answer). The close's own lock of every vault is what ends a waiting restore. With
    /// neither, answers `false` and does nothing: the caller closes as always. A Quit shows the window first (it comes
    /// from the tray, with the window hidden), then asks.
    ///
    /// Each new question is given an ID by the shell (`question` in the event, counting up from 1, never reused). While a
    /// question is pending in the same lock epoch, a second request sends the same question again (the same
    /// event with the same ID, the first one's reason and payload; the pending question is still the first), and a Quit shows the window
    /// again: a page that never showed the first, because the event was lost or the page reloaded, would otherwise leave
    /// Close and Quit dead until a lock. The page keeps one question, and knows a repeat by its ID. A change of the
    /// epoch (Lock all, Windows locking or sleeping, an idle lock) clears the pending question, so a request after it is
    /// judged afresh. Jobs that end meanwhile change nothing while any still runs or a restore still waits for its yes;
    /// once the last one ends the shell answers the question as Close anyway itself, since nothing is left to cancel
    /// ([`carry_on_close`](Self::carry_on_close)).
    pub fn ask_before_closing(&self, reason: CloseReason) -> bool {
        let asked = {
            let mut state = lock(&self.close_question);
            let epoch = self.sessions.epoch();
            match state.pending.as_ref() {
                Some(question) if question.epoch == epoch => question.asked.clone(),
                _ => {
                    state.pending = None;
                    let running = self.autolock.running_kinds();
                    let restore_waiting = self.restore.waiting();
                    if running.is_empty() && !restore_waiting {
                        return false;
                    }
                    state.minted += 1;
                    let asked = CloseAsked {
                        reason,
                        running,
                        past_swap: self.restore.past_swap(),
                        restore_waiting,
                        question: state.minted,
                    };
                    state.pending = Some(PendingClose {
                        reason,
                        epoch,
                        asked: asked.clone(),
                    });
                    asked
                }
            }
        };
        if reason == CloseReason::Quit {
            self.os.window.bring_forward();
        }
        self.notifier.close_asked(&asked);
        true
    }

    /// The page's answer to the question with ID `question` ([`ask_before_closing`](Self::ask_before_closing)). Either
    /// answer uses the question up. `go`: runs the old path for the question's reason, a close (today's
    /// [`close_window`](Self::close_window), whose lock cancels every job) or a Quit (the shutdown, within
    /// [`SHUTDOWN_WAIT`](crate::autolock::SHUTDOWN_WAIT), then the exit). Not `go`: nothing changes. `NotFound` when that
    /// question is not the one pending: never asked, already answered, or cleared by a lock of all vaults since, whether
    /// or not another question has been asked after it (which an answer to the older one leaves alone). Waits for the
    /// lock hooks when it closes, so the caller runs it off the async runtime.
    pub fn close_answer(&self, question: u64, go: bool) -> ShellResult<()> {
        let question = self.claim_close_answer(question)?;
        self.answer_claimed(question, go)
    }

    /// The first half of an answer: takes the pending question, and its lock epoch, out of the shell at the moment the
    /// answer arrives, so that work queued behind it (the command runs the rest on the blocking pool) belongs to that
    /// question alone. The answer names the question it is for (`question`, the ID the page was sent): the ID and the
    /// lock epoch are compared with the pending question's under the lock, and only a match takes it out. An answer to
    /// any other question (an earlier one, answered or dropped, or an ID never given) is refused and leaves the
    /// pending question where it is, so a stale answer can neither consume a newer question nor run for it. `NotFound`
    /// when the IDs differ, when none is pending, or when a lock of all vaults has cleared it.
    pub fn claim_close_answer(&self, question: u64) -> ShellResult<PendingClose> {
        let mut state = lock(&self.close_question);
        let epoch = self.sessions.epoch();
        let is_it = state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.asked.question == question && pending.epoch == epoch);
        if is_it {
            state.pending.take().ok_or(ShellError::NotFound)
        } else {
            Err(ShellError::NotFound)
        }
    }

    /// The second half: `go` runs the old path for the claimed question's reason, unless a lock of all vaults came since
    /// it was claimed (`NotFound`, nothing run: the question it answered is gone, and what is running now was started
    /// after it); not `go` changes nothing.
    pub fn answer_claimed(&self, question: PendingClose, go: bool) -> ShellResult<()> {
        if go {
            if question.epoch != self.sessions.epoch() {
                return Err(ShellError::NotFound);
            }
            match question.reason {
                CloseReason::Close => self.close_window(),
                CloseReason::Quit => crate::tray::quit(self, || self.os.window.exit_app()),
            }
        }
        Ok(())
    }

    /// The last running operation ended ([`AutoLock::on_last_end`]): with a close or Quit question pending in the
    /// current lock epoch and nothing left to cancel (no operation running, no restore waiting for its yes at 24d, none
    /// past its swap), the shell answers the question as Close anyway itself, so the close or Quit the person asked for
    /// goes ahead without a second press. The pending question is claimed exactly as an answer claims it (so the page's
    /// own answer, if it comes after, is `NotFound`) and run by [`answer_claimed`](Self::answer_claimed), which checks
    /// the epoch again. With anything still running or waiting, no question, or one a lock of all vaults has dropped,
    /// nothing changes: the question stays as asked, or is gone.
    ///
    /// Waits for the lock hooks when it closes, so it never runs on the ending job's thread
    /// ([`carry_on_off_this_thread`] hands it to a thread of its own). It takes the question's lock only to read and
    /// claim, in the order [`ask_before_closing`](Self::ask_before_closing) does, and releases it before the go path.
    pub(crate) fn carry_on_close(&self) {
        let question = {
            let mut state = lock(&self.close_question);
            let nothing_left = state.pending.as_ref().is_some_and(|question| {
                question.epoch == self.sessions.epoch()
                    && self.autolock.running_kinds().is_empty()
                    && !self.restore.waiting()
                    && !self.restore.past_swap()
            });
            if nothing_left {
                state.pending.take()
            } else {
                None
            }
        };
        if let Some(question) = question {
            // The same epoch check as an answer's. `NotFound` here only means a lock came in between: nothing to do.
            let _ = self.answer_claimed(question, true);
        }
    }

    /// Tests only: how many times the end of the last operation has asked for a carry-on.
    #[cfg(test)]
    pub(crate) fn carry_on_asked(&self) -> usize {
        self.carry_on_asks.load(Ordering::SeqCst)
    }

    /// Tests only: whether every carry-on the end of an operation asked for has finished. An end asks before it
    /// returns, so a test that has dropped its job and then finds this true has seen the carry-on done, however late a
    /// thread of an earlier end ran.
    #[cfg(test)]
    pub(crate) fn carry_on_settled(&self) -> bool {
        self.carry_on_looks.load(Ordering::SeqCst) == self.carry_on_asks.load(Ordering::SeqCst)
    }

    /// The window's close button (design, "The window"): it never ends the app. Locks every vault, exactly as the page's
    /// "Lock all" does and with the reason a person's own lock has (the app keeps running, so the lock hooks must act as
    /// they do for a lock, not for an exit); then, once the explanation was seen, hides the window to the tray. The first
    /// time it leaves the window visible and tells the page to show 5b (`first_close`, `explain: true`). A second close
    /// while 5b shows counts as 5b's button ([`close_explained_ok`](Self::close_explained_ok)). Never calls
    /// [`shutdown`](Self::shutdown), which shuts the closing gate for good. Waits for the lock hooks, so the caller runs
    /// it off the event loop's thread ([`run_in_background`](Self::run_in_background)).
    ///
    /// Every path that hides the window ends the same way ([`lock_and_hide`](Self::lock_and_hide)): the window never
    /// hides with a vault unlocked, however an unlock races the close. The first close, which leaves the window visible,
    /// only locks.
    ///
    /// One close at a time, so two presses at once explain once. That gate is taken before any session lock and is not
    /// held by anything a lock hook calls.
    pub fn close_window(&self) {
        let mut explaining = lock(&self.explaining);
        if *explaining {
            self.finish_explanation(&mut explaining);
        } else if self.settings.close_explained() {
            self.lock_and_hide();
        } else {
            self.lock_all();
            *explaining = true;
            self.notify(&Notice::FirstClose { explain: true });
        }
    }

    /// 5b's button: notes that the explanation was seen (saved with the settings; when that fails it is remembered for
    /// this run only, and nothing is shown), tells the page it is done (`first_close`, `explain: false`) and hides the
    /// window, after locking again: a vault opened while 5b showed is locked here.
    pub fn close_explained_ok(&self) {
        let mut explaining = lock(&self.explaining);
        self.finish_explanation(&mut explaining);
    }

    /// The window is shown again (Open Lockbox, a second launch, the save shortcut): unlocks are accepted again, and a
    /// close still waiting to hide will not ([`lock_and_hide`](Self::lock_and_hide)).
    pub fn window_shown(&self) {
        let mut shows = lock(&self.window_shows);
        *shows += 1;
        self.sessions.unseal();
    }

    /// Hides the window with every vault locked. The sessions' window gate is sealed first: from then on no unlock
    /// starts or finishes, so none opens in the wait for the lock hooks or after it, and one that finished before is
    /// locked by the lock that follows. The gate stays sealed while the window is hidden, until
    /// [`window_shown`](Self::window_shown); a person who pressed Unlock just before the close is answered `Locked`,
    /// which the page treats as a stale answer. Only then does the window hide, and only if it was not shown again in
    /// the meantime: a reopen during the wait lifts the gate, and is the later wish (Greptile, PR 4). The window then
    /// stays shown, so no vault opened after the reopen is left in a hidden window.
    fn lock_and_hide(&self) {
        let sealed_at = self.seal_for_hide();
        self.lock_all();
        self.hide_unless_shown_since(sealed_at);
    }

    fn finish_explanation(&self, explaining: &mut bool) {
        *explaining = false;
        let sealed_at = self.seal_for_hide();
        self.lock_all();
        if self.settings.mark_close_explained().is_err() {
            // No detail: the settings file's path and the error are not logged (R5).
            eprintln!("Lockbox: the first-close note could not be saved");
        }
        self.notify(&Notice::FirstClose { explain: false });
        self.hide_unless_shown_since(sealed_at);
    }

    /// Seals the window gate for a hide and says how many shows there had been by then: the seal and the count are
    /// taken together, so a show is either counted before the seal or comes after it and lifts it.
    fn seal_for_hide(&self) -> u64 {
        let shows = lock(&self.window_shows);
        self.sessions.seal();
        *shows
    }

    /// Hides the window, on its own thread, unless it was shown again since `sealed_at` ([`seal_for_hide`](Self::seal_for_hide)).
    fn hide_unless_shown_since(&self, sealed_at: u64) {
        let shows = Arc::clone(&self.window_shows);
        self.os
            .window
            .hide_if(Box::new(move || *lock(&shows) == sealed_at));
    }

    /// Closing the app (the main window's close request, the app's exit, or Windows ending the session): locks every
    /// vault on a helper thread and cancels every long operation, then waits at most
    /// [`SHUTDOWN_WAIT`](crate::autolock::SHUTDOWN_WAIT) for the lock and its hooks (the clipboard clear and the "Open"
    /// cleanup, which treat `None` as all) before the process may exit, and, inside the same wait, for the clean-up of a
    /// restore that was waiting for its yes (its staging folder and journal, removed on a worker the lock hook starts):
    /// a Quit after "Close anyway" leaves nothing for the next launch to recover. It does no hook work of its own. Every
    /// call, the second included, waits the same way.
    pub fn shutdown(&self) {
        self.autolock.shutdown();
        // The first call's deadline: the hooks are done by now (or the wait is), and the restore's hook has handed its
        // clean-up to a worker before it ended, so the worker is counted.
        let deadline =
            (self.autolock.close_deadline())().unwrap_or_else(|| Instant::now() + SHUTDOWN_WAIT);
        self.restore.wait_idle(deadline);
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

    /// The checks every readable output passes before anything is made: a decrypted copy (Save a copy), a readable file
    /// (the recovery key's PDF, a `.env`) and a folder's files saved together. The output journal must be readable
    /// ([`Outputs::usable`]); the destination `dest` (a file's path: for a folder, any name in it, which is never
    /// made) is made canonical and refused inside Lockbox's own state folder ([`output_destination`](Self::output_destination));
    /// and refused in or below a vault's folder ([`refuse_vault_folder`]). Then, unless `cloud_confirmed`, the cloud
    /// question: a folder a cloud provider syncs is [`Checked::Cloud`] and nothing is made until the user says yes.
    ///
    /// It refuses no kind of session: a read-only vault may save copies out.
    pub(crate) fn checked_output(
        &self,
        dest: &Path,
        cloud_confirmed: bool,
    ) -> ShellResult<Checked> {
        self.outputs.usable()?;
        let dest = self.output_destination(dest)?;
        // Every time, the yes included: the folder may have become a vault's while the question waited.
        refuse_vault_folder(&dest)?;
        if !cloud_confirmed {
            let folder = dest
                .parent()
                .ok_or(ShellError::InvalidInput { what: "file name" })?;
            if let Some(provider) =
                cloud_provider_of(self.os.volumes.as_ref(), self.os.env.as_ref(), folder)?
            {
                return Ok(Checked::Cloud(dest, provider));
            }
        }
        Ok(Checked::Ready(dest))
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

    fn capture(&self, event: &CaptureEvent) {
        self.emit(CAPTURE_EVENT, event);
    }

    fn job_started(&self, event: &JobStarted) {
        self.emit(JOB_STARTED_EVENT, *event);
    }

    fn progress(&self, event: &ProgressEvent) {
        self.emit(PROGRESS_EVENT, *event);
    }

    fn lock_epoch(&self, event: &LockEpochEvent) {
        self.emit(LOCK_EPOCH_EVENT, *event);
    }

    fn close_asked(&self, event: &CloseAsked) {
        self.emit(CLOSE_ASKED_EVENT, event.clone());
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::{Arc, Barrier, Mutex, mpsc};
    use std::thread;
    use std::time::Duration;

    use lockbox_core::blob::CancelToken;
    use serde_json::{Value, json};
    use zeroize::Zeroizing;

    use super::{CLOSE_ASKED_EVENT, CloseAsked, CloseReason};
    use crate::error::ShellError;
    use crate::jobs::JobKind;
    use crate::lock;
    use crate::session::{LockReason, SessionState};
    use crate::settings::SettingsStore;
    use crate::testing::{TEST_PASSWORD, TestShell, heavy};

    /// A made-up text, never a real secret.
    const COPIED: &str = "Pw-0123456789-xyz";

    fn first_close(explain: bool) -> Value {
        json!({ "kind": "first_close", "explain": explain })
    }

    /// Every session the shell lists, locked or not.
    fn states(ts: &TestShell) -> Vec<SessionState> {
        ts.shell.sessions.list().iter().map(|s| s.state).collect()
    }

    /// Two unlocked vaults and a Lockbox copy on the clipboard, which a close must clear.
    fn two_vaults_and_a_copy(ts: &TestShell) -> [(crate::session::SessionId, u64); 2] {
        let vaults = [ts.open_vault("Family"), ts.open_vault("Work")];
        let (session, generation) = vaults[0];
        ts.shell
            .clipboard
            .copy(
                &ts.shell.sessions,
                session,
                generation,
                Zeroizing::new(COPIED.to_owned()),
            )
            .unwrap();
        assert_eq!(ts.clipboard.text().as_deref(), Some(COPIED));
        vaults
    }

    fn assert_all_locked_by_a_manual_lock(
        ts: &TestShell,
        vaults: &[(crate::session::SessionId, u64)],
    ) {
        assert!(states(ts).iter().all(|s| *s == SessionState::Locked));
        let locked: Vec<_> = ts
            .events
            .locked()
            .into_iter()
            .map(|(session, _, reason)| (session, reason))
            .collect();
        for (session, _) in vaults {
            assert!(
                locked.contains(&(*session, LockReason::Manual)),
                "a vault was not locked as a person's own lock"
            );
        }
        assert_eq!(locked.len(), vaults.len());
        assert_eq!(
            ts.clipboard.text(),
            None,
            "the copy was left on the clipboard"
        );
    }

    /// The window's close button, once the explanation was seen: every vault locks (with the reason a person's own lock
    /// uses, since the app keeps running), the clipboard copy is cleared, the window hides and the page is told nothing.
    /// The window is hidden only after the locks: what the window's hide sees is a locked app.
    #[test]
    fn close_request_locks_every_vault_and_hides() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        let vaults = two_vaults_and_a_copy(&ts);
        let at_hide = Arc::new(Mutex::new(None));
        let (seen, shell) = (Arc::clone(&at_hide), Arc::clone(&ts.shell));
        ts.window.during_next_hide(move || {
            *lock(&seen) = Some(
                shell
                    .sessions
                    .list()
                    .iter()
                    .map(|s| s.state)
                    .collect::<Vec<_>>(),
            );
        });

        ts.shell.close_window();

        assert_all_locked_by_a_manual_lock(&ts, &vaults);
        assert_eq!(ts.window.hides(), 1);
        assert_eq!(*lock(&at_hide), Some(vec![SessionState::Locked; 2]));
        assert_eq!(ts.events.notices(), Vec::<Value>::new());
    }

    /// The first close: every vault locks, the window stays visible and the page is told to show 5b. The note is not
    /// saved yet (nothing is written until 5b's button), and `first_close` is an event only: `launch_notices` never has it.
    #[test]
    fn first_close_locks_and_stays_visible() {
        let ts = TestShell::new();
        let vaults = two_vaults_and_a_copy(&ts);

        ts.shell.close_window();

        assert_all_locked_by_a_manual_lock(&ts, &vaults);
        assert_eq!(ts.window.hides(), 0, "the window hid before 5b was shown");
        assert_eq!(ts.events.notices(), [first_close(true)]);
        assert!(ts.shell.launch_notices().is_empty());
        assert!(!ts.shell.settings.close_explained());
        assert!(
            !ts.shell.paths.settings.exists(),
            "the note was saved too soon"
        );
    }

    /// 5b's button: the note is saved (the next launch reads it), the page is told the explanation is done, and the
    /// window hides, in that order; later closes hide at once and say nothing.
    #[test]
    fn ok_on_first_close_sets_the_flag_and_hides() {
        let ts = TestShell::new();
        let vaults = two_vaults_and_a_copy(&ts);
        ts.shell.close_window();
        assert_eq!(ts.window.hides(), 0);

        let at_hide = Arc::new(Mutex::new(None));
        let (seen, shell, events, file) = (
            Arc::clone(&at_hide),
            Arc::clone(&ts.shell),
            Arc::clone(&ts.events),
            ts.shell.paths.settings.clone(),
        );
        ts.window.during_next_hide(move || {
            *lock(&seen) = Some((
                shell.settings.close_explained(),
                SettingsStore::load(file).close_explained(),
                events.notices(),
            ));
        });
        ts.shell.close_explained_ok();

        assert_eq!(ts.window.hides(), 1);
        assert_eq!(
            *lock(&at_hide),
            Some((true, true, vec![first_close(true), first_close(false)]))
        );
        assert!(ts.shell.launch_notices().is_empty());
        assert_all_locked_by_a_manual_lock(&ts, &vaults);

        // The window is shown again, a vault is opened, and the next close hides at once, says nothing and locks it.
        ts.shell.window_shown();
        let (again, _) = ts.open_vault("Later");
        ts.shell.close_window();
        assert_eq!(ts.window.hides(), 2);
        assert_eq!(ts.events.notices().len(), 2, "a later close said something");
        let info = ts.shell.sessions.list();
        assert_eq!(
            info.iter().find(|s| s.session == again).map(|s| s.state),
            Some(SessionState::Locked)
        );
    }

    /// A second close while 5b shows counts as its button: the same three effects, and no second 5b.
    #[test]
    fn second_close_during_5b_counts_as_ok() {
        let ts = TestShell::new();
        ts.open_vault("Family");
        ts.shell.close_window();
        assert_eq!(ts.events.notices(), [first_close(true)]);

        // A vault opened while 5b was up is locked by the second close too.
        let (later, _) = ts.open_vault("Work");
        ts.shell.close_window();

        assert_eq!(ts.events.notices(), [first_close(true), first_close(false)]);
        assert!(ts.shell.settings.close_explained());
        assert!(SettingsStore::load(ts.shell.paths.settings.clone()).close_explained());
        assert_eq!(ts.window.hides(), 1);
        assert!(
            ts.shell
                .sessions
                .list()
                .iter()
                .find(|s| s.session == later)
                .is_some_and(|s| s.state == SessionState::Locked)
        );
    }

    /// Two closes at the same moment explain once: one of them shows 5b and the other counts as its button.
    #[test]
    fn two_closes_at_once_explain_once() {
        let ts = TestShell::new();
        ts.open_vault("Family");
        let closers: Vec<_> = (0..2)
            .map(|_| {
                let shell = Arc::clone(&ts.shell);
                thread::spawn(move || shell.close_window())
            })
            .collect();
        for closer in closers {
            closer.join().unwrap();
        }
        assert_eq!(ts.events.notices(), [first_close(true), first_close(false)]);
        assert_eq!(ts.window.hides(), 1);
    }

    /// The note cannot be saved: it is remembered for this run, the window still hides, the page is still told, and
    /// the next close hides without the explanation. Nothing the person sees is an error.
    #[test]
    fn ok_when_the_note_cannot_be_saved_is_remembered_for_this_run() {
        let ts = TestShell::new();
        // The state folder's place is taken by a file, so the settings file cannot be written.
        let root = ts.shell.paths.root.clone();
        fs::create_dir_all(root.parent().unwrap()).unwrap();
        fs::write(&root, "a file where the state folder goes").unwrap();

        ts.shell.close_window();
        ts.shell.close_explained_ok();

        assert!(ts.shell.settings.close_explained());
        assert!(!SettingsStore::load(ts.shell.paths.settings.clone()).close_explained());
        assert_eq!(ts.events.notices(), [first_close(true), first_close(false)]);
        assert_eq!(ts.window.hides(), 1);

        ts.shell.close_window();
        assert_eq!(ts.window.hides(), 2);
        assert_eq!(ts.events.notices().len(), 2);
    }

    /// A close is not the app's end: the shell's closing gate stays open, so once the window is shown again (from the
    /// tray) a vault opens, and the sessions still lock for the real exit later.
    #[test]
    fn close_does_not_end_the_app() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        ts.open_vault("Family");
        ts.shell.close_window();
        assert_eq!(ts.window.hides(), 1);

        ts.shell.window_shown();
        let (again, _) = ts.open_vault("Again");
        assert_eq!(
            ts.shell
                .sessions
                .list()
                .iter()
                .find(|s| s.session == again)
                .map(|s| s.state),
            Some(SessionState::Unlocked),
            "a close shut the gate that only the exit may shut"
        );
        ts.shell.shutdown();
        assert!(states(&ts).iter().all(|s| *s == SessionState::Locked));
        assert!(
            ts.events
                .locked()
                .iter()
                .any(|(session, _, reason)| *session == again && *reason == LockReason::AppClosing)
        );
    }

    /// A lock hook that stops the lock's hooks where they are: `started` says it is running (the vaults are revoked by
    /// then), and sending on `release` lets it go. The lock call waits for hooks, so this holds the whole close.
    fn hold_the_hooks(ts: &TestShell) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (started, running) = mpsc::channel::<()>();
        let (release, released) = mpsc::channel::<()>();
        let (started, released) = (Mutex::new(started), Mutex::new(released));
        ts.shell.sessions.on_lock(Box::new(move |_, _| {
            let _ = lock(&started).send(());
            let _ = lock(&released).recv_timeout(Duration::from_secs(60));
        }));
        (running, release)
    }

    /// A person presses Unlock now: whether the new vault was refused, and nothing is left unlocked either way.
    fn unlock_is_refused(ts: &TestShell, name: &str) -> bool {
        let password = Zeroizing::new(TEST_PASSWORD.to_owned());
        let answer = heavy(|| ts.shell.create_vault(name.into(), password, false));
        answer.is_err()
    }

    /// The reviewer's race: the vaults are revoked and the close waits for a slow lock hook. A person who presses Unlock
    /// in that wait is refused (`Locked`, a stale answer to the page), so the window hides with every vault locked.
    #[test]
    fn unlock_while_the_close_waits_for_hooks_is_refused_and_the_window_hides_locked() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        ts.open_vault("Family");
        let (started, release) = hold_the_hooks(&ts);
        let closer = {
            let shell = Arc::clone(&ts.shell);
            thread::spawn(move || shell.close_window())
        };
        started.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(ts.window.hides(), 0, "hid before the hooks finished");

        assert!(unlock_is_refused(&ts, "Late"), "a vault opened in the wait");

        release.send(()).unwrap();
        closer.join().unwrap();
        assert_eq!(ts.window.hides(), 1);
        assert_eq!(ts.shell.sessions.list().len(), 1);
        assert!(states(&ts).iter().all(|s| *s == SessionState::Locked));
    }

    /// The same race on 5b's button ("Got it"): it locks again before it hides, and an unlock in that wait is refused.
    /// A vault opened while 5b was showing is locked by it.
    #[test]
    fn got_it_locks_a_vault_opened_while_5b_showed_and_refuses_an_unlock_in_its_wait() {
        let ts = TestShell::new();
        ts.open_vault("Family");
        ts.shell.close_window();
        assert_eq!(ts.events.notices(), [first_close(true)]);
        // 5b is up and nothing is hidden: a vault can still be opened behind it.
        let (work, _) = ts.open_vault("Work");
        assert!(
            ts.shell
                .sessions
                .list()
                .iter()
                .any(|s| s.session == work && s.state == SessionState::Unlocked)
        );

        let (started, release) = hold_the_hooks(&ts);
        let ok = {
            let shell = Arc::clone(&ts.shell);
            thread::spawn(move || shell.close_explained_ok())
        };
        started.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(ts.window.hides(), 0, "hid before the hooks finished");
        assert!(unlock_is_refused(&ts, "Late"), "a vault opened in the wait");

        release.send(()).unwrap();
        ok.join().unwrap();
        assert_eq!(ts.window.hides(), 1);
        assert_eq!(ts.shell.sessions.list().len(), 2);
        assert!(states(&ts).iter().all(|s| *s == SessionState::Locked));
    }

    /// An unlock whose password check is under way when the window closes: the close cancels it and the vault is
    /// discarded, so the window hides with nothing unlocked.
    #[test]
    fn unlock_in_flight_when_the_window_closes_does_not_survive_the_hide() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        let vault = heavy(|| {
            lockbox_core::Vault::create(&ts.vaults(), "Inflight", TEST_PASSWORD)
                .unwrap()
                .vault
        });
        let location = crate::session::Location::folder(vault.dir()).unwrap();
        let (checked, closed) = (Barrier::new(2), Barrier::new(2));
        let answer = thread::scope(|s| {
            let opening = s.spawn(|| {
                ts.shell.sessions.open(Some(location.clone()), None, |_| {
                    checked.wait();
                    closed.wait();
                    Ok(crate::session::OpenStep::Session(
                        location.clone(),
                        crate::session::Opened::Writable(vault),
                        (),
                    ))
                })
            });
            checked.wait();
            ts.shell.close_window();
            closed.wait();
            opening.join().unwrap()
        });
        assert_eq!(answer.err(), Some(ShellError::Locked));
        assert_eq!(ts.window.hides(), 1);
        assert!(states(&ts).iter().all(|s| *s == SessionState::Locked));
    }

    /// Greptile's race on PR 4: the close waits for a slow lock hook, and in that wait the window is brought back (Open
    /// Lockbox in the tray, or the save shortcut), which lifts the gate. The reopen is the later wish and wins: the
    /// older close does not hide the window, so no vault can be unlocked in a window that then hides. The close's own
    /// lock still ran: what was open before the reopen is locked.
    #[test]
    fn a_reopen_while_the_close_waits_for_hooks_keeps_the_window_shown() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        ts.open_vault("Family");
        let (started, release) = hold_the_hooks(&ts);
        let closer = {
            let shell = Arc::clone(&ts.shell);
            thread::spawn(move || shell.close_window())
        };
        started.recv_timeout(Duration::from_secs(10)).unwrap();

        ts.shell.window_shown();
        release.send(()).unwrap();
        closer.join().unwrap();

        assert_eq!(
            ts.window.hides(),
            0,
            "an older close hid the window the person had just brought back"
        );
        assert!(states(&ts).iter().all(|s| *s == SessionState::Locked));
        assert!(
            !unlock_is_refused(&ts, "After"),
            "the shown window refuses unlocks"
        );
    }

    /// The same race on 5b's button ("Got it"): a reopen in its wait keeps the window shown, and unlocks work there.
    #[test]
    fn a_reopen_while_got_it_waits_for_hooks_keeps_the_window_shown() {
        let ts = TestShell::new();
        ts.open_vault("Family");
        ts.shell.close_window();
        assert_eq!(ts.events.notices(), [first_close(true)]);

        let (started, release) = hold_the_hooks(&ts);
        let ok = {
            let shell = Arc::clone(&ts.shell);
            thread::spawn(move || shell.close_explained_ok())
        };
        started.recv_timeout(Duration::from_secs(10)).unwrap();

        ts.shell.window_shown();
        release.send(()).unwrap();
        ok.join().unwrap();

        assert_eq!(
            ts.window.hides(),
            0,
            "an older close hid the window the person had just brought back"
        );
        assert!(ts.shell.settings.close_explained());
        assert!(states(&ts).iter().all(|s| *s == SessionState::Locked));
        assert!(
            !unlock_is_refused(&ts, "After"),
            "the shown window refuses unlocks"
        );
    }

    /// The race one step later (Codex, on the fix): the close has locked and queued its hide on the window's busy
    /// thread, and the reopen and an unlock come before that thread runs it. The queued hide checks then, sees the
    /// reopen, and leaves the window shown with the new vault open in it.
    #[test]
    fn a_reopen_after_the_hide_is_queued_keeps_the_window_shown() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        ts.open_vault("Family");
        ts.window.defer_hides();
        ts.shell.close_window();
        assert_eq!(ts.window.queued_hides(), 1);
        assert!(states(&ts).iter().all(|s| *s == SessionState::Locked));

        ts.shell.window_shown();
        let (after, _) = ts.open_vault("After");
        ts.window.run_queued_hides();

        assert_eq!(
            ts.window.hides(),
            0,
            "a queued hide ran after the window was shown again"
        );
        assert!(
            ts.shell
                .sessions
                .list()
                .iter()
                .any(|s| s.session == after && s.state == SessionState::Unlocked)
        );
    }

    /// The same on 5b's button: its queued hide is overtaken by a reopen and does not run.
    #[test]
    fn a_reopen_after_got_it_queued_its_hide_keeps_the_window_shown() {
        let ts = TestShell::new();
        ts.open_vault("Family");
        ts.shell.close_window();
        ts.window.defer_hides();
        ts.shell.close_explained_ok();
        assert_eq!(ts.window.queued_hides(), 1);

        ts.shell.window_shown();
        let (after, _) = ts.open_vault("After");
        ts.window.run_queued_hides();

        assert_eq!(
            ts.window.hides(),
            0,
            "a queued hide ran after the window was shown again"
        );
        assert!(
            ts.shell
                .sessions
                .list()
                .iter()
                .any(|s| s.session == after && s.state == SessionState::Unlocked)
        );
    }

    // -----------------------------------------------------------------------------------------------------------
    // Close or Quit with a job running (Task 12): the question, and its answer.
    // -----------------------------------------------------------------------------------------------------------

    /// What the page is sent when a close arrives while jobs run, as question number `question` (the shell counts its
    /// questions from 1, and a fresh test shell has asked none).
    fn asked(question: u64, reason: &str, running: &[&str], past_swap: bool) -> Value {
        json!({
            "reason": reason, "running": running, "past_swap": past_swap, "restore_waiting": false,
            "question": question
        })
    }

    /// `lockbox://close-asked` has exactly the frozen JSON shape: a snake_case reason, the kinds in start order,
    /// whether the swap is past, whether a restore waits for its yes, and the question's number (Plan 4C Task 12, a
    /// plain JSON number). Nothing else (no path, no name, no count).
    #[test]
    fn close_asked_has_the_frozen_shape() {
        let event = CloseAsked {
            reason: CloseReason::Close,
            running: vec![JobKind::Import, JobKind::Backup],
            past_swap: false,
            restore_waiting: false,
            question: 1,
        };
        assert_eq!(
            serde_json::to_string(&event).unwrap(),
            r#"{"reason":"close","running":["import","backup"],"past_swap":false,"restore_waiting":false,"question":1}"#
        );
        let quit = CloseAsked {
            reason: CloseReason::Quit,
            running: vec![JobKind::SaveCopy, JobKind::OpenBackup, JobKind::CopyItem],
            past_swap: true,
            restore_waiting: false,
            question: 42,
        };
        assert_eq!(
            serde_json::to_value(&quit).unwrap(),
            asked(42, "quit", &["save_copy", "open_backup", "copy_item"], true)
        );
        let waiting = CloseAsked {
            reason: CloseReason::Close,
            running: vec![],
            past_swap: false,
            restore_waiting: true,
            question: 3,
        };
        assert_eq!(
            serde_json::to_string(&waiting).unwrap(),
            r#"{"reason":"close","running":[],"past_swap":false,"restore_waiting":true,"question":3}"#
        );
        assert_eq!(CLOSE_ASKED_EVENT, "lockbox://close-asked");
    }

    /// With nothing running, a close is the close it always was: every vault locks, the window hides, and the page is
    /// asked nothing.
    #[test]
    fn close_with_no_job_hides_and_locks_as_before() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        let vaults = two_vaults_and_a_copy(&ts);

        ts.shell.close_or_ask();

        assert_all_locked_by_a_manual_lock(&ts, &vaults);
        assert_eq!(ts.window.hides(), 1);
        assert!(ts.events.close_asked().is_empty());
        assert_eq!(
            ts.answer_close(true),
            Err(ShellError::NotFound),
            "a question was left pending"
        );
    }

    /// A close with a job running asks first: nothing is locked, hidden, cancelled or brought forward, and the page is
    /// sent the one question, naming the job.
    #[test]
    fn close_with_a_job_running_asks_first() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        let vaults = two_vaults_and_a_copy(&ts);
        let token = CancelToken::new();
        let _import = ts
            .shell
            .autolock
            .begin(Some(vaults[0].0), JobKind::Import, token.clone());

        ts.shell.close_or_ask();

        assert_eq!(
            ts.events.close_asked(),
            [asked(1, "close", &["import"], false)]
        );
        assert!(states(&ts).iter().all(|s| *s == SessionState::Unlocked));
        assert!(ts.events.locked().is_empty());
        assert!(
            !token.is_cancelled(),
            "the job was cancelled before the answer"
        );
        assert_eq!(ts.window.hides(), 0);
        assert_eq!(ts.window.forwards(), 0, "a close has the window up already");
        assert_eq!(ts.clipboard.text().as_deref(), Some(COPIED));
        assert!(ts.events.notices().is_empty());
    }

    /// Close anyway: the jobs are cancelled, then the old close runs (every vault locked, the window hidden), in that
    /// order, and the question is used up.
    #[test]
    fn close_anyway_cancels_the_jobs_then_hides_and_locks() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        let vaults = two_vaults_and_a_copy(&ts);
        let token = CancelToken::new();
        let _import = ts
            .shell
            .autolock
            .begin(Some(vaults[0].0), JobKind::Import, token.clone());
        ts.shell.close_or_ask();

        let at_hide = Arc::new(Mutex::new(None));
        let (seen, shell, job) = (Arc::clone(&at_hide), Arc::clone(&ts.shell), token.clone());
        ts.window.during_next_hide(move || {
            *lock(&seen) = Some((
                job.is_cancelled(),
                shell
                    .sessions
                    .list()
                    .iter()
                    .map(|s| s.state)
                    .collect::<Vec<_>>(),
            ));
        });
        assert_eq!(ts.answer_close(true), Ok(()));

        assert!(token.is_cancelled());
        assert_all_locked_by_a_manual_lock(&ts, &vaults);
        assert_eq!(ts.window.hides(), 1);
        assert_eq!(
            *lock(&at_hide),
            Some((true, vec![SessionState::Locked; 2])),
            "the window hid before the jobs were cancelled and the vaults locked"
        );
        assert_eq!(ts.answer_close(true), Err(ShellError::NotFound));
        assert_eq!(ts.events.close_asked().len(), 1);
    }

    /// Keep it running: nothing changes, the question is used up (a second answer is refused), and the next close
    /// asks again.
    #[test]
    fn keep_it_running_changes_nothing() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        let vaults = two_vaults_and_a_copy(&ts);
        let token = CancelToken::new();
        let _import = ts
            .shell
            .autolock
            .begin(Some(vaults[0].0), JobKind::Import, token.clone());
        ts.shell.close_or_ask();

        assert_eq!(ts.answer_close(false), Ok(()));

        assert!(states(&ts).iter().all(|s| *s == SessionState::Unlocked));
        assert!(ts.events.locked().is_empty());
        assert!(!token.is_cancelled());
        assert_eq!(ts.window.hides(), 0);
        assert_eq!(ts.clipboard.text().as_deref(), Some(COPIED));
        assert_eq!(ts.answer_close(false), Err(ShellError::NotFound));
        assert_eq!(ts.answer_close(true), Err(ShellError::NotFound));

        ts.shell.close_or_ask();
        assert_eq!(
            ts.events.close_asked(),
            [
                asked(1, "close", &["import"], false),
                asked(2, "close", &["import"], false)
            ]
        );
    }

    /// While the question shows, a second close (or a Quit) sends the same question again, with the first one's
    /// reason and payload, because a page that never showed it would leave Close and Quit dead (the page keeps one
    /// question, so a repeat changes nothing there); a Quit brings the window forward again. Nothing else changes: the
    /// question pending is still the first, and its answer runs the old path of that first reason.
    #[test]
    fn a_second_close_sends_the_same_question_again() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        let (session, _) = ts.open_vault("Family");
        let _import = ts
            .shell
            .autolock
            .begin(Some(session), JobKind::Import, CancelToken::new());
        ts.shell.close_or_ask();
        assert_eq!(ts.window.forwards(), 0, "a close has the window up already");

        ts.shell.close_or_ask();
        assert_eq!(
            ts.events.close_asked(),
            [
                asked(1, "close", &["import"], false),
                asked(1, "close", &["import"], false)
            ],
            "the same event, sent a second time"
        );
        assert_eq!(ts.window.forwards(), 0, "a repeated close moves nothing");

        assert!(ts.shell.ask_before_closing(CloseReason::Quit));
        assert_eq!(
            ts.events.close_asked(),
            vec![asked(1, "close", &["import"], false); 3],
            "the Quit repeats the first question: its reason stays the close's"
        );
        assert_eq!(
            ts.window.forwards(),
            1,
            "the Quit brings the window forward"
        );
        assert!(states(&ts).iter().all(|s| *s == SessionState::Unlocked));
        assert_eq!(ts.answer_close(true), Ok(()));
        assert_eq!(
            ts.window.exits(),
            0,
            "the Quit that only asked again exited"
        );
        assert_eq!(ts.window.hides(), 1, "the close's own answer ran");
        assert_eq!(ts.answer_close(true), Err(ShellError::NotFound));
    }

    /// A change of the lock epoch (Lock all, Windows locking or sleeping, an idle lock) clears the question: an answer
    /// to it is refused as no question pending, and nothing it would have done is done. A close after that, with a job
    /// running, asks afresh.
    #[test]
    fn a_lock_epoch_change_clears_the_question() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        let (session, _) = ts.open_vault("Family");
        let _import = ts
            .shell
            .autolock
            .begin(Some(session), JobKind::Import, CancelToken::new());
        let _copy = ts
            .shell
            .autolock
            .begin(None, JobKind::CopyItem, CancelToken::new());
        for lock_all in [
            (|ts: &TestShell| ts.shell.lock_all()) as fn(&TestShell),
            |ts| ts.shell.autolock.signal(crate::os::OsSignal::SessionLocked),
            |ts| ts.shell.autolock.signal(crate::os::OsSignal::Suspending),
        ] {
            let asked_before = ts.events.close_asked().len();
            ts.shell.close_or_ask();
            assert_eq!(ts.events.close_asked().len(), asked_before + 1);

            lock_all(&ts);

            assert_eq!(ts.answer_close(true), Err(ShellError::NotFound));
            assert_eq!(ts.answer_close(false), Err(ShellError::NotFound));
            assert_eq!(
                ts.window.hides(),
                0,
                "an answer to a cleared question closed"
            );
        }
        // A close after the change, with jobs still running (they were told to stop and have not ended): asks afresh.
        let asked_before = ts.events.close_asked().len();
        ts.shell.close_or_ask();
        assert_eq!(ts.events.close_asked().len(), asked_before + 1);
        assert_eq!(ts.answer_close(false), Ok(()));
    }

    /// A question nobody answered before a lock of all vaults is gone with it: the next close, with a job still running,
    /// asks again (a second event) instead of leaving the page waiting on a question it has dropped, and that new
    /// question is the one an answer reaches.
    #[test]
    fn a_close_after_a_lock_epoch_change_asks_afresh_without_an_answer_between() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        let (session, _) = ts.open_vault("Family");
        let _import = ts
            .shell
            .autolock
            .begin(Some(session), JobKind::Import, CancelToken::new());
        ts.shell.close_or_ask();
        ts.shell.lock_all();

        assert!(ts.shell.ask_before_closing(CloseReason::Quit));

        assert_eq!(
            ts.events.close_asked(),
            [
                asked(1, "close", &["import"], false),
                asked(2, "quit", &["import"], false)
            ]
        );
        assert_eq!(ts.answer_close(false), Ok(()));
        assert_eq!(ts.window.exits(), 0);
        assert_eq!(ts.answer_close(false), Err(ShellError::NotFound));
    }

    /// A delayed answer (Codex F1): the answer is claimed when it arrives, before its work is queued. A lock of all
    /// vaults and a new question can come before that work runs; the old answer then closes or quits nothing (its own
    /// question's epoch has gone), and the new question stays pending for its own answer. Both reasons, and `go: false`
    /// (which only uses its own question up).
    #[test]
    fn a_delayed_answer_never_consumes_or_runs_for_a_newer_question() {
        for first in [CloseReason::Close, CloseReason::Quit] {
            let ts = TestShell::new();
            ts.shell.settings.mark_close_explained().unwrap();
            let (session, _) = ts.open_vault("Family");
            let _import =
                ts.shell
                    .autolock
                    .begin(Some(session), JobKind::Import, CancelToken::new());
            assert!(ts.shell.ask_before_closing(first));
            // The old answer arrives (claimed) but its work has not run.
            let old_id = question_of(&ts.events.close_asked()[0]);
            let old = ts.shell.claim_close_answer(old_id).unwrap();
            assert_eq!(
                ts.shell.claim_close_answer(old_id).err(),
                Some(ShellError::NotFound)
            );

            // Windows locks; a job is still running, and a new question is asked.
            ts.shell.autolock.signal(crate::os::OsSignal::SessionLocked);
            let token = CancelToken::new();
            let _backup = ts
                .shell
                .autolock
                .begin(None, JobKind::Backup, token.clone());
            assert!(ts.shell.ask_before_closing(CloseReason::Close));
            let hides = ts.window.hides();

            // The old answer's work runs now: refused, and nothing happens.
            assert_eq!(
                ts.shell.answer_claimed(old, true),
                Err(ShellError::NotFound),
                "{first:?}"
            );
            assert_eq!(ts.window.exits(), 0, "an old Quit exited");
            assert_eq!(ts.window.hides(), hides, "an old close hid the window");
            assert!(!token.is_cancelled(), "an old answer cancelled new work");

            // The new question is still there, and is answered by its own answer.
            assert_eq!(ts.events.close_asked().len(), 2);
            assert_eq!(ts.answer_close(true), Ok(()));
            assert!(token.is_cancelled());
        }
    }

    /// A claimed answer whose epoch is unchanged runs as the answer to its own question, and `go: false` claims and
    /// changes nothing.
    #[test]
    fn a_claimed_answer_in_the_same_epoch_runs() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        let (session, _) = ts.open_vault("Family");
        let token = CancelToken::new();
        let _import = ts
            .shell
            .autolock
            .begin(Some(session), JobKind::Import, token.clone());
        ts.shell.close_or_ask();
        let kept = ts
            .shell
            .claim_close_answer(question_of(&ts.events.close_asked()[0]))
            .unwrap();
        assert_eq!(ts.shell.answer_claimed(kept, false), Ok(()));
        assert!(!token.is_cancelled());

        ts.shell.close_or_ask();
        let go = ts
            .shell
            .claim_close_answer(question_of(&ts.events.close_asked()[1]))
            .unwrap();
        assert_eq!(ts.shell.answer_claimed(go, true), Ok(()));
        assert!(token.is_cancelled());
        assert_eq!(ts.window.hides(), 1);
    }

    /// 5b first, after the question: a first close with a job running asks (no 5b yet, nothing locked); Close anyway
    /// then runs today's first close, which locks and shows 5b with the window visible.
    #[test]
    fn first_close_asks_before_5b_and_close_anyway_shows_5b() {
        let ts = TestShell::new();
        let (session, _) = ts.open_vault("Family");
        let token = CancelToken::new();
        let _import = ts
            .shell
            .autolock
            .begin(Some(session), JobKind::Import, token.clone());

        ts.shell.close_or_ask();
        assert_eq!(
            ts.events.close_asked(),
            [asked(1, "close", &["import"], false)]
        );
        assert!(
            ts.events.notices().is_empty(),
            "5b came before the question"
        );
        assert!(states(&ts).iter().all(|s| *s == SessionState::Unlocked));

        assert_eq!(ts.answer_close(true), Ok(()));
        assert_eq!(ts.events.notices(), [first_close(true)]);
        assert!(token.is_cancelled());
        assert!(states(&ts).iter().all(|s| *s == SessionState::Locked));
        assert_eq!(ts.window.hides(), 0, "5b is shown with the window visible");
    }

    /// Every operation the auto-lock counts is a job for the question (Task 2's definition), including the ones with no
    /// bar of their own: an open, a replace and a copy of an item, each named by its kind, in start order.
    #[test]
    fn close_during_an_open_replace_or_copy_item_asks_too() {
        for (kind, name) in [
            (JobKind::Open, "open"),
            (JobKind::Replace, "replace"),
            (JobKind::CopyItem, "copy_item"),
        ] {
            let ts = TestShell::new();
            ts.shell.settings.mark_close_explained().unwrap();
            let (session, _) = ts.open_vault("Family");
            let job = ts
                .shell
                .autolock
                .begin(Some(session), kind, CancelToken::new());

            ts.shell.close_or_ask();

            assert_eq!(ts.events.close_asked(), [asked(1, "close", &[name], false)]);
            assert_eq!(ts.window.hides(), 0, "{name}");
            assert!(states(&ts).iter().all(|s| *s == SessionState::Unlocked));
            // Answered first: the job's end would otherwise carry the close on (Task 14).
            assert_eq!(ts.answer_close(false), Ok(()));
            drop(job);
            ts.shell.lock_all();
        }
        // Several at once: each kind once, in start order.
        let ts = TestShell::new();
        let (session, _) = ts.open_vault("Family");
        let _open = ts
            .shell
            .autolock
            .begin(Some(session), JobKind::Open, CancelToken::new());
        let _backup = ts
            .shell
            .autolock
            .begin(None, JobKind::Backup, CancelToken::new());
        let _copy = ts
            .shell
            .autolock
            .begin(Some(session), JobKind::CopyItem, CancelToken::new());
        let _second_open =
            ts.shell
                .autolock
                .begin(Some(session), JobKind::Open, CancelToken::new());
        ts.shell.close_or_ask();
        assert_eq!(
            ts.events.close_asked(),
            [asked(1, "close", &["open", "backup", "copy_item"], false)]
        );
        assert_eq!(ts.answer_close(false), Ok(()));
    }

    /// An answer with no question pending is refused as not found, on a shell that was never asked, and after a
    /// question that has been answered.
    #[test]
    fn close_answer_with_no_question_pending_is_refused() {
        let ts = TestShell::new();
        assert_eq!(ts.answer_close(true), Err(ShellError::NotFound));
        assert_eq!(ts.answer_close(false), Err(ShellError::NotFound));
        assert_eq!(ts.window.hides(), 0);
        assert_eq!(ts.window.exits(), 0);
    }

    /// A question is the exact one asked: an answer after a newer question (the earlier one answered, a job started,
    /// a new close) is for the newer one only, with the newer one's reason.
    #[test]
    fn an_answer_goes_to_the_question_that_is_pending_now() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        let (session, _) = ts.open_vault("Family");
        let _import = ts
            .shell
            .autolock
            .begin(Some(session), JobKind::Import, CancelToken::new());
        ts.shell.close_or_ask();
        assert_eq!(ts.answer_close(false), Ok(()));
        let _backup = ts
            .shell
            .autolock
            .begin(Some(session), JobKind::Backup, CancelToken::new());
        assert!(ts.shell.ask_before_closing(CloseReason::Quit));

        assert_eq!(
            ts.events.close_asked(),
            [
                asked(1, "close", &["import"], false),
                asked(2, "quit", &["import", "backup"], false)
            ]
        );
        assert_eq!(ts.answer_close(true), Ok(()));
        assert_eq!(ts.window.exits(), 1, "the newer question was a Quit");
        assert_eq!(ts.window.hides(), 0, "the older close ran");
    }

    // -----------------------------------------------------------------------------------------------------------
    // Plan 4C Task 12: the question's own ID, minted in the shell.
    // -----------------------------------------------------------------------------------------------------------

    /// The ID a `lockbox://close-asked` event carries.
    fn question_of(event: &Value) -> u64 {
        event["question"]
            .as_u64()
            .expect("the event carries a question ID")
    }

    /// Each question the shell asks is given an ID by the shell: it is in the event, it is a number, and a question
    /// asked after another (answered, or dropped by a lock of all vaults) never reuses an earlier ID.
    #[test]
    fn each_close_question_has_an_id_minted_in_the_shell() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        let (session, _) = ts.open_vault("Family");
        let _import = ts
            .shell
            .autolock
            .begin(Some(session), JobKind::Import, CancelToken::new());

        ts.shell.close_or_ask();
        let first = question_of(&ts.events.close_asked()[0]);
        assert_eq!(
            ts.events.close_asked(),
            [asked(first, "close", &["import"], false)],
            "every field it had, and the ID"
        );
        assert_eq!(ts.shell.close_answer(first, false), Ok(()));

        ts.shell.close_or_ask();
        let second = question_of(&ts.events.close_asked()[1]);
        assert_ne!(second, first, "an answered question's ID was reused");

        // A lock of all vaults drops the second; the one after it is another question.
        ts.shell.lock_all();
        ts.shell.close_or_ask();
        let third = question_of(&ts.events.close_asked()[2]);
        assert!(third != second && third != first, "an ID was reused");
        assert_eq!(ts.shell.close_answer(third, false), Ok(()));
    }

    /// A repeat of the question that is pending (a second close, a Quit, a reloaded page) carries the same ID, so the
    /// page can tell it is the same question. A question asked after a lock of all vaults is a new one, with another.
    #[test]
    fn a_repeat_carries_the_same_id() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        let (session, _) = ts.open_vault("Family");
        let _import = ts
            .shell
            .autolock
            .begin(Some(session), JobKind::Import, CancelToken::new());
        ts.shell.close_or_ask();
        ts.shell.close_or_ask();
        assert!(ts.shell.ask_before_closing(CloseReason::Quit));

        let sent = ts.events.close_asked();
        assert_eq!(sent.len(), 3);
        let id = question_of(&sent[0]);
        assert_eq!(sent, vec![asked(id, "close", &["import"], false); 3]);

        ts.shell.lock_all();
        assert!(ts.shell.ask_before_closing(CloseReason::Close));
        assert_ne!(question_of(&ts.events.close_asked()[3]), id);
    }

    /// An answer that names a question that is not the pending one is refused, whichever way the question went (answered,
    /// dropped by a lock, never asked), and it leaves the pending question where it was: the newer question is still
    /// there for its own answer, and nothing the old answer would have done is done.
    #[test]
    fn a_stale_answer_is_refused_and_leaves_the_newer_question_answerable() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        let (session, _) = ts.open_vault("Family");
        let token = CancelToken::new();
        let _import = ts
            .shell
            .autolock
            .begin(Some(session), JobKind::Import, token.clone());

        // An answered question, then a newer one.
        ts.shell.close_or_ask();
        let first = question_of(&ts.events.close_asked()[0]);
        assert_eq!(ts.shell.close_answer(first, false), Ok(()));
        assert!(ts.shell.ask_before_closing(CloseReason::Quit));
        let second = question_of(&ts.events.close_asked()[1]);
        for go in [true, false] {
            assert_eq!(
                ts.shell.close_answer(first, go),
                Err(ShellError::NotFound),
                "go {go}"
            );
        }
        assert_eq!(
            ts.shell.claim_close_answer(second + 1).err(),
            Some(ShellError::NotFound),
            "an ID that was never given"
        );
        assert_eq!(ts.window.exits(), 0, "a stale answer quit");
        assert_eq!(ts.window.hides(), 0, "a stale answer closed");
        assert!(!token.is_cancelled(), "a stale answer cancelled the job");

        // A question a lock of all vaults dropped, then a newer one: its answer is refused the same way.
        ts.shell.lock_all();
        assert_eq!(
            ts.shell.claim_close_answer(second).err(),
            Some(ShellError::NotFound),
            "the dropped question's own answer"
        );
        assert!(ts.shell.ask_before_closing(CloseReason::Close));
        let third = question_of(&ts.events.close_asked()[2]);
        assert_eq!(
            ts.shell.claim_close_answer(second).err(),
            Some(ShellError::NotFound),
            "the dropped question's ID after a newer question"
        );

        // The newer question was not consumed by any of it: its own answer is the one that works.
        assert_eq!(ts.events.close_asked().len(), 3, "no question was re-asked");
        assert_eq!(ts.shell.close_answer(third, false), Ok(()));
        assert_eq!(
            ts.shell.close_answer(third, false),
            Err(ShellError::NotFound)
        );
    }

    /// The answer to the pending question is on its way when the person presses Close or Quit again: the repeat is the
    /// same question (one question, the same ID, nothing second pending), and one answer, however it is repeated, is
    /// accepted once.
    #[test]
    fn a_repeat_close_while_an_answer_is_in_flight_keeps_one_question() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        let (session, _) = ts.open_vault("Family");
        let token = CancelToken::new();
        let _import = ts
            .shell
            .autolock
            .begin(Some(session), JobKind::Import, token.clone());
        ts.shell.close_or_ask();
        let id = question_of(&ts.events.close_asked()[0]);

        // The repeats come before the answer is claimed.
        ts.shell.close_or_ask();
        assert!(ts.shell.ask_before_closing(CloseReason::Quit));
        assert_eq!(
            ts.events.close_asked(),
            vec![asked(id, "close", &["import"], false); 3],
            "one question, said three times"
        );

        let claimed = ts.shell.claim_close_answer(id).unwrap();
        assert_eq!(
            ts.shell.claim_close_answer(id).err(),
            Some(ShellError::NotFound),
            "a second answer to the same question"
        );
        assert_eq!(ts.shell.answer_claimed(claimed, false), Ok(()));
        assert_eq!(
            ts.shell.close_answer(id, true),
            Err(ShellError::NotFound),
            "the repeats left a second question pending"
        );
        assert!(!token.is_cancelled());
        assert_eq!(ts.window.hides(), 0);
        assert_eq!(ts.window.exits(), 0);
    }

    /// A question that was answered is gone: its ID answers nothing again, and a question asked afterwards is a new one
    /// with a new ID that the old ID cannot answer (the page ignores a repeated event of an answered question for the
    /// same reason).
    #[test]
    fn a_repeated_event_after_its_answer_cannot_reopen_it() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        let (session, _) = ts.open_vault("Family");
        let token = CancelToken::new();
        let _import = ts
            .shell
            .autolock
            .begin(Some(session), JobKind::Import, token.clone());
        ts.shell.close_or_ask();
        let answered = question_of(&ts.events.close_asked()[0]);
        assert_eq!(ts.shell.close_answer(answered, false), Ok(()));
        assert_eq!(
            ts.shell.close_answer(answered, true),
            Err(ShellError::NotFound)
        );

        ts.shell.close_or_ask();
        let next = question_of(&ts.events.close_asked()[1]);
        assert_ne!(next, answered);
        assert_eq!(
            ts.shell.close_answer(answered, true),
            Err(ShellError::NotFound),
            "the answered question's ID answered the new one"
        );
        assert!(!token.is_cancelled());
        assert_eq!(ts.window.hides(), 0);
        assert_eq!(ts.shell.close_answer(next, false), Ok(()));
    }

    // -----------------------------------------------------------------------------------------------------------
    // Task 14: the question carries on when the jobs it asked about have ended.
    // -----------------------------------------------------------------------------------------------------------

    /// A close question pending, its only job ends: nothing is left to cancel, so the close the person asked for goes
    /// ahead by itself, once (every vault locked as a person's own lock, the copy cleared, the window hidden), and the
    /// page's later answer finds no question.
    #[test]
    fn the_last_job_ending_still_carries_on_with_the_close() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        let vaults = two_vaults_and_a_copy(&ts);
        let import =
            ts.shell
                .autolock
                .begin(Some(vaults[0].0), JobKind::Import, CancelToken::new());
        ts.shell.close_or_ask();
        assert_eq!(ts.window.hides(), 0);
        let before = ts.shell.carry_on_asked();

        drop(import);
        ts.wait_for_carry_on(before);

        assert_all_locked_by_a_manual_lock(&ts, &vaults);
        assert_eq!(ts.window.hides(), 1, "the window hides once");
        assert_eq!(ts.window.exits(), 0);
        assert_eq!(ts.events.close_asked().len(), 1, "no second question");
        assert_eq!(
            ts.answer_close(true),
            Err(ShellError::NotFound),
            "the page's answer came after the shell's own"
        );
        assert_eq!(ts.answer_close(false), Err(ShellError::NotFound));
        assert_eq!(ts.window.hides(), 1);
    }

    /// The same for the tray's Quit: the shutdown runs (every vault locked as an app close) and the app exits, once.
    #[test]
    fn last_job_ending_carries_on_with_the_quit() {
        let ts = TestShell::new();
        let vaults = two_vaults_and_a_copy(&ts);
        let backup =
            ts.shell
                .autolock
                .begin(Some(vaults[0].0), JobKind::Backup, CancelToken::new());
        assert!(ts.shell.ask_before_closing(CloseReason::Quit));
        assert_eq!(ts.window.exits(), 0);
        let before = ts.shell.carry_on_asked();

        drop(backup);
        ts.wait_for_carry_on(before);

        assert_eq!(ts.window.exits(), 1, "the app exits once");
        assert!(states(&ts).iter().all(|s| *s == SessionState::Locked));
        let locked = ts.events.locked();
        assert_eq!(locked.len(), 2);
        assert!(
            locked
                .iter()
                .all(|(_, _, reason)| *reason == LockReason::AppClosing)
        );
        assert_eq!(ts.window.hides(), 0, "a Quit hides nothing, it exits");
        assert_eq!(ts.answer_close(true), Err(ShellError::NotFound));
        assert_eq!(ts.window.exits(), 1);
    }

    /// While another job still runs there is something left to cancel: the question stays as it was asked (the
    /// carry-on itself refuses, too, when it is asked), and the last one's end then carries on.
    #[test]
    fn a_job_ending_with_another_running_keeps_the_question() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        let vaults = two_vaults_and_a_copy(&ts);
        let import =
            ts.shell
                .autolock
                .begin(Some(vaults[0].0), JobKind::Import, CancelToken::new());
        let backup = ts
            .shell
            .autolock
            .begin(None, JobKind::Backup, CancelToken::new());
        ts.shell.close_or_ask();

        drop(import);
        // What the end of a job asks for, asked now with the backup still running.
        ts.shell.carry_on_close();
        assert_eq!(ts.window.hides(), 0);
        assert!(states(&ts).iter().all(|s| *s == SessionState::Unlocked));
        assert!(ts.events.locked().is_empty());
        ts.shell.close_or_ask();
        assert_eq!(
            ts.events.close_asked().len(),
            2,
            "the question is still the one pending"
        );

        let before = ts.shell.carry_on_asked();
        drop(backup);
        ts.wait_for_carry_on(before);
        assert_all_locked_by_a_manual_lock(&ts, &vaults);
        assert_eq!(ts.window.hides(), 1);
    }

    /// Keep it running used the question up: the job ending afterwards closes nothing, for a close and for a Quit.
    #[test]
    fn keep_it_running_then_the_job_ends_closes_nothing() {
        for reason in [CloseReason::Close, CloseReason::Quit] {
            let ts = TestShell::new();
            ts.shell.settings.mark_close_explained().unwrap();
            let vaults = two_vaults_and_a_copy(&ts);
            let import =
                ts.shell
                    .autolock
                    .begin(Some(vaults[0].0), JobKind::Import, CancelToken::new());
            assert!(ts.shell.ask_before_closing(reason));
            assert_eq!(ts.answer_close(false), Ok(()));
            let before = ts.shell.carry_on_asked();

            drop(import);
            ts.wait_for_carry_on(before);

            assert!(
                states(&ts).iter().all(|s| *s == SessionState::Unlocked),
                "{reason:?}"
            );
            assert!(ts.events.locked().is_empty());
            assert_eq!(ts.window.hides(), 0);
            assert_eq!(ts.window.exits(), 0);
            assert_eq!(ts.clipboard.text().as_deref(), Some(COPIED));
        }
    }

    /// A lock of all vaults changed the epoch the question was asked in, so it was dropped with it: the job ending
    /// afterwards (it was told to stop and took a while) carries on with nothing, for a close and for a Quit.
    #[test]
    fn a_lock_of_all_vaults_before_the_job_ends_carries_on_with_nothing() {
        for reason in [CloseReason::Close, CloseReason::Quit] {
            let ts = TestShell::new();
            ts.shell.settings.mark_close_explained().unwrap();
            let (session, _) = ts.open_vault("Family");
            let import =
                ts.shell
                    .autolock
                    .begin(Some(session), JobKind::Import, CancelToken::new());
            assert!(ts.shell.ask_before_closing(reason));
            ts.shell.lock_all();
            let locks = ts.events.locked().len();
            let before = ts.shell.carry_on_asked();

            drop(import);
            ts.wait_for_carry_on(before);

            assert_eq!(ts.window.hides(), 0, "{reason:?}");
            assert_eq!(ts.window.exits(), 0, "{reason:?}");
            assert_eq!(ts.events.locked().len(), locks, "no second lock");
            assert_eq!(ts.answer_close(true), Err(ShellError::NotFound));
        }
    }

    /// The carry-on never runs on the thread of the job that ended: a job ends from `LongOp`'s drop, which can be
    /// inside a lock hook, and the close waits for the lock hooks. Here the person's lock of one vault (which leaves the
    /// epoch, so the question stays) runs a hook that ends the only job; a carry-on run inline would wait for the hook
    /// thread it is running on, and the lock would never return.
    #[test]
    fn the_carry_on_does_not_run_on_the_ending_jobs_thread() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        let (session, _) = ts.open_vault("Family");
        let held = Arc::new(Mutex::new(Some(ts.shell.autolock.begin(
            Some(session),
            JobKind::Import,
            CancelToken::new(),
        ))));
        let ending = Arc::clone(&held);
        // The epoch is read inside the hook, before it ends the job: after the job ends the carry-on's own lock of all
        // vaults may advance it at any moment, so a read by the test after the lock returns would race with it.
        let epochs = Arc::new(Mutex::new(None));
        let (seen, sessions) = (Arc::clone(&epochs), Arc::clone(&ts.shell.sessions));
        ts.shell.sessions.on_lock(Box::new(move |_, _| {
            // Only the first run, the one lock of one vault: the carry-on's lock runs this hook again.
            lock(&seen).get_or_insert_with(|| sessions.epoch());
            drop(lock(&ending).take());
        }));
        ts.shell.close_or_ask();
        let (epoch, before) = (ts.shell.sessions.epoch(), ts.shell.carry_on_asked());

        let (done, finished) = mpsc::channel();
        let sessions = Arc::clone(&ts.shell.sessions);
        thread::spawn(move || {
            sessions.lock(session, LockReason::Manual);
            let _ = done.send(());
        });
        finished
            .recv_timeout(Duration::from_secs(10))
            .expect("the lock never returned: the carry-on ran on the ending job's thread");
        assert!(lock(&held).is_none(), "the hook ended the job");
        assert_eq!(
            *lock(&epochs),
            Some(epoch),
            "the person's lock of one vault changed the epoch"
        );
        ts.wait_for_carry_on(before);

        assert_eq!(ts.window.hides(), 1, "the carry-on closed");
        assert_eq!(ts.answer_close(true), Err(ShellError::NotFound));
    }

    /// Close anyway cancels the jobs inside its own lock, and each job ends as it sees the cancel: the ends come
    /// during the close, finish, and carry nothing on (the answer already used the question up), so the window hides
    /// once.
    #[test]
    fn a_job_ending_inside_close_anyways_own_lock_finishes_and_closes_once() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        let (session, _) = ts.open_vault("Family");
        let token = CancelToken::new();
        let (running, running_now) = mpsc::channel();
        let job = {
            let (shell, token) = (Arc::clone(&ts.shell), token.clone());
            thread::spawn(move || {
                let op = shell
                    .autolock
                    .begin(Some(session), JobKind::Import, token.clone());
                running.send(()).unwrap();
                while !token.is_cancelled() {
                    thread::sleep(Duration::from_millis(1));
                }
                // The job ends as it sees the cancel, while the close is still locking.
                drop(op);
            })
        };
        running_now.recv_timeout(Duration::from_secs(10)).unwrap();
        ts.shell.close_or_ask();
        let before = ts.shell.carry_on_asked();

        assert_eq!(ts.answer_close(true), Ok(()));
        job.join().unwrap();
        ts.wait_for_carry_on(before);

        assert_eq!(ts.window.hides(), 1, "the window hid more than once");
        assert!(states(&ts).iter().all(|s| *s == SessionState::Locked));
        assert_eq!(ts.answer_close(true), Err(ShellError::NotFound));
    }

    /// A queued hide with no reopen before it runs: it hides, and the gate stays sealed.
    #[test]
    fn a_queued_hide_with_no_reopen_hides_and_keeps_the_gate_sealed() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        ts.open_vault("Family");
        ts.window.defer_hides();
        ts.shell.close_window();
        ts.window.run_queued_hides();
        assert_eq!(ts.window.hides(), 1);
        assert!(
            unlock_is_refused(&ts, "Hidden"),
            "the hidden window accepts unlocks"
        );
    }

    /// A reopen that comes after the hide changes nothing about it: the close hid, and the reopen lifts the gate.
    #[test]
    fn a_reopen_after_the_hide_lifts_the_gate() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        ts.open_vault("Family");
        ts.shell.close_window();
        assert_eq!(ts.window.hides(), 1);
        assert!(
            unlock_is_refused(&ts, "Hidden"),
            "the hidden window accepts unlocks"
        );

        ts.shell.window_shown();
        assert!(
            !unlock_is_refused(&ts, "Shown"),
            "the shown window refuses unlocks"
        );
    }
}
