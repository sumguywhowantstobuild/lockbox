//! The app's state behind every command: plain Rust, so almost every rule is tested without a window. Later tasks add
//! auto-lock, the clipboard, the output journal, the registry, settings and the restore state.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Runtime};

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
}

impl Shell {
    pub fn new(notifier: Arc<dyn Notifier>) -> Self {
        Shell {
            sessions: Sessions::new(notifier),
        }
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
