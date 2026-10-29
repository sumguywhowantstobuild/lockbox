//! The app's state behind every command: plain Rust, so almost every rule is tested without a window. Later tasks add
//! auto-lock, the clipboard, the output journal, settings and the restore state.

use std::io;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::TryLockError;
#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Runtime};

use crate::error::ShellResult;
use crate::locations::{LocationCheck, check_location};
use crate::lock;
use crate::os::{KnownFolder, Os};
use crate::paths::{StatePaths, state_paths};
use crate::registry::Registry;
use crate::session::{LockReason, Notice, Notifier, SessionId, Sessions};
use crate::window;

/// A session locked: `{ session, generation, reason }`.
pub const LOCKED_EVENT: &str = "lockbox://locked";
/// The long operations under way: `{ session, operations }` (`session` null for one without a session).
pub const BUSY_EVENT: &str = "lockbox://busy";
/// Launch recovery and sweep results: `{ kind, .. }`.
pub const NOTICE_EVENT: &str = "lockbox://notice";

pub struct Shell {
    pub sessions: Sessions,
    pub registry: Registry,
    pub paths: StatePaths,
    pub(crate) os: Os,
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
    /// known folders: nothing is written until a command saves state.
    pub fn new(notifier: Arc<dyn Notifier>, os: Os, app_dirs: Vec<PathBuf>) -> io::Result<Self> {
        let paths = state_paths(os.env.as_ref())?;
        let mut forbidden = app_dirs;
        forbidden.push(os.env.known_folder(KnownFolder::RoamingAppData)?);
        forbidden.push(paths.root.clone());
        Ok(Shell {
            sessions: Sessions::new(notifier),
            registry: Registry::new(paths.registry.clone(), Arc::clone(&os.volumes)),
            paths,
            os,
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
