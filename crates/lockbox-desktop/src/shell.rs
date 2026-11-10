//! The app's state behind every command: plain Rust, so almost every rule is tested without a window.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::TryLockError;
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Runtime};

use crate::autolock::AutoLock;
use crate::clipboard::Clipboard;
use crate::commands::env;
use crate::error::{ShellError, ShellResult};
use crate::locations::{LocationCheck, check_location, is_within};
use crate::lock;
use crate::open::{OpenFolders, RemoveReport};
use crate::os::{KnownFolder, Os};
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
    /// How many times the save shortcut has been pressed. The shortcut is not registered yet (the save box's task
    /// registers it); the count is what the router's test watches.
    shortcut_presses: AtomicU64,
    /// Tests only: how many times a creation or addition had to wait for another.
    #[cfg(test)]
    creating_waited: AtomicUsize,
    /// Tests only: how long a PDF job waits for the printer's answer, in place of
    /// [`PRINT_ANSWER_WAIT`](crate::commands::readable::PRINT_ANSWER_WAIT).
    #[cfg(test)]
    pub(crate) print_wait: Mutex<Option<std::time::Duration>>,
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
        // Then the pasted `.env` values' (a lock of one vault drains nothing of `Pending` by itself, and a paste parked
        // while a lock was under way is dropped here).
        sessions.on_lock(env::lock_hook(Arc::downgrade(&sessions)));
        Ok(Shell {
            sessions,
            settings,
            clipboard,
            autolock,
            registry: Registry::new(paths.registry.clone(), Arc::clone(&os.volumes)),
            vault_state: VaultStateStore::new(paths.vault_state.clone()),
            outputs,
            open_folders,
            restore,
            paths,
            os,
            notifier,
            launch_notices: Mutex::default(),
            forbidden,
            creating: Mutex::default(),
            explaining: Mutex::default(),
            shortcut_presses: AtomicU64::new(0),
            #[cfg(test)]
            creating_waited: AtomicUsize::new(0),
            #[cfg(test)]
            print_wait: Mutex::default(),
        })
    }

    /// The save shortcut was pressed. For now it only counts the press: it reads nothing and keeps nothing, so no
    /// copied text is held anywhere. The save box's task makes it read the clipboard once here, into its one capture slot. Runs on a
    /// thread of its own (the clipboard may be held by another program), never the signal window's.
    pub fn save_shortcut_pressed(&self) {
        self.shortcut_presses.fetch_add(1, Ordering::SeqCst);
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

    /// The window is shown again (Open Lockbox, a second launch): unlocks are accepted again.
    pub fn window_shown(&self) {
        self.sessions.unseal();
    }

    /// Hides the window with every vault locked. The sessions' window gate is sealed first: from then on no unlock
    /// starts or finishes, so none opens in the wait for the lock hooks or after it, and one that finished before is
    /// locked by the lock that follows. The gate stays sealed while the window is hidden, until
    /// [`window_shown`](Self::window_shown); a person who pressed Unlock just before the close is answered `Locked`,
    /// which the page treats as a stale answer. Only then does the window hide.
    fn lock_and_hide(&self) {
        self.sessions.seal();
        self.lock_all();
        self.os.window.hide();
    }

    fn finish_explanation(&self, explaining: &mut bool) {
        *explaining = false;
        self.sessions.seal();
        self.lock_all();
        if self.settings.mark_close_explained().is_err() {
            // No detail: the settings file's path and the error are not logged (R5).
            eprintln!("Lockbox: the first-close note could not be saved");
        }
        self.notify(&Notice::FirstClose { explain: false });
        self.os.window.hide();
    }

    /// Closing the app (the main window's close request, the app's exit, or Windows ending the session): locks every
    /// vault on a helper thread and cancels every long operation, then waits at most
    /// [`SHUTDOWN_WAIT`](crate::autolock::SHUTDOWN_WAIT) for the lock and its hooks (the clipboard clear and the "Open"
    /// cleanup, which treat `None` as all) before the process may exit. It does no hook work of its own. Every call,
    /// the second included, waits the same way.
    pub fn shutdown(&self) {
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

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::{Arc, Barrier, Mutex, mpsc};
    use std::thread;
    use std::time::Duration;

    use serde_json::{Value, json};
    use zeroize::Zeroizing;

    use crate::error::ShellError;
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

    /// A press counts and nothing else: the clipboard is not opened and is left as it was, so no copied text is held in
    /// the shell between a press and the save box that will read it.
    #[test]
    fn a_press_only_counts_and_reads_nothing() {
        let ts = TestShell::new();
        assert!(ts.clipboard.user_copy(COPIED));
        ts.shell.save_shortcut_pressed();
        ts.shell.save_shortcut_pressed();
        assert_eq!(ts.shell.shortcut_presses(), 2);
        assert_eq!(ts.clipboard.opens(), 0, "the clipboard was opened");
        assert_eq!(ts.clipboard.text().as_deref(), Some(COPIED));
    }
}
