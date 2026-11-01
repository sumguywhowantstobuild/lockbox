//! The app's state behind every command: plain Rust, so almost every rule is tested without a window. A later task
//! adds the restore state.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::TryLockError;
#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Runtime};

use crate::autolock::AutoLock;
use crate::clipboard::Clipboard;
use crate::error::{ShellError, ShellResult};
use crate::locations::{LocationCheck, check_location, is_within};
use crate::lock;
use crate::os::{KnownFolder, Os};
use crate::outputs::{Outputs, SweepReport};
use crate::paths::{StatePaths, state_paths};
use crate::registry::Registry;
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
    pub outputs: Outputs,
    pub paths: StatePaths,
    pub(crate) os: Os,
    /// Where the launch sweep's notice goes.
    notifier: Arc<dyn Notifier>,
    /// The launch sweep's report, when it had anything to tell ([`launch_notices`](Self::launch_notices)).
    launch_sweep: Mutex<Option<SweepReport>>,
    /// The folders no vault may be inside (spec §6.10): Tauri's app-data folders, the Roaming profile and the state
    /// folder.
    forbidden: Vec<PathBuf>,
    /// One vault creation or addition at a time ([`creating`](Self::creating)).
    creating: Mutex<()>,
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
        // The auto-lock adds no lock hook; the clipboard reads the close's deadline from it.
        let autolock = AutoLock::new(
            Arc::clone(&sessions),
            Arc::clone(&settings),
            Arc::clone(&notifier),
            &os,
        );
        let clipboard = Clipboard::new(&os, Arc::clone(&settings), autolock.close_deadline())?;
        // The first lock hook, before any other (the "Open" cleanup comes after it): a lock clears the clipboard
        // before anything else of its hooks runs.
        sessions.on_lock(clipboard.lock_hook());
        Ok(Shell {
            sessions,
            settings,
            clipboard,
            autolock,
            registry: Registry::new(paths.registry.clone(), Arc::clone(&os.volumes)),
            outputs: Outputs::new(&paths, Arc::clone(&os.volumes)),
            paths,
            os,
            notifier,
            launch_sweep: Mutex::default(),
            forbidden,
            creating: Mutex::default(),
            #[cfg(test)]
            creating_waited: AtomicUsize::new(0),
        })
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

    /// Closing the app (the main window's close request, the app's exit, or Windows ending the session): locks every
    /// vault on a helper thread and cancels every long operation, then waits at most
    /// [`SHUTDOWN_WAIT`](crate::autolock::SHUTDOWN_WAIT) for the lock and its hooks (the clipboard clear and the "Open"
    /// cleanup, which treat `None` as all) before the process may exit. It does no hook work of its own. Only the
    /// first call does anything; later ones return at once.
    pub fn shutdown(&self) {
        self.autolock.shutdown();
    }

    /// Launch work, in the app's `.setup` (never in a second copy of the app): sweeps the output journal's leftovers.
    /// When there was anything to tell, the report is kept for [`launch_notices`](Self::launch_notices) (launch work
    /// runs before the page can listen) and also sent as `lockbox://notice` (`output_sweep`).
    pub fn sweep_outputs(&self) -> SweepReport {
        let report = self.outputs.sweep();
        if report != SweepReport::default() {
            *lock(&self.launch_sweep) = Some(report);
            self.notifier.notice(&Notice::OutputSweep(report));
        }
        report
    }

    /// What launch found that the page should show, asked by the page once it has loaded: each launch notice, counts
    /// and flags only. Kept, not used up, so a reloaded page shows it again.
    pub fn launch_notices(&self) -> Vec<Notice> {
        lock(&self.launch_sweep)
            .map(Notice::OutputSweep)
            .into_iter()
            .collect()
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
