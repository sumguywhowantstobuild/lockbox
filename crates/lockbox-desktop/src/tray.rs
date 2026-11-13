//! The icon by the clock, where the window hides to when it is closed (design: "The window"). Menu: Open Lockbox,
//! Lock all, Quit.

use std::sync::Arc;

use tauri::menu::{IsMenuItem, Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

use crate::shell::Shell;
use crate::window;

/// The tray icon's id.
const TRAY_ID: &str = "lockbox";
const OPEN: &str = "open";
const LOCK_ALL: &str = "lock_all";
const QUIT: &str = "quit";

/// The menu, in order: each item's id and its words on screen.
const ITEMS: [(&str, &str); 3] = [
    (OPEN, "Open Lockbox"),
    (LOCK_ALL, "Lock all"),
    (QUIT, "Quit"),
];

/// Puts Lockbox's icon by the clock, with its menu: a left click opens the window, a right click opens the menu. The setup hook calls it
/// and ends the app when it fails: with no icon, a hidden window could never be reached again (fail closed).
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let Some(icon) = app.default_window_icon() else {
        return Err(std::io::Error::other("no icon for the tray").into());
    };
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon.clone())
        .tooltip("Lockbox")
        .menu(&menu(app)?)
        // The menu opens on the right button only: the left one opens the window.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| chosen(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button,
                button_state,
                ..
            } = event
                && let Some(id) = click_chooses(button, button_state)
            {
                chosen(tray.app_handle(), id);
            }
        })
        .build(app)?;
    Ok(())
}

/// What a click on the icon chooses: the left button, on its release, is "Open Lockbox" (Windows' convention). Any other
/// click chooses nothing (the right button opens the menu on its own).
fn click_chooses(button: MouseButton, state: MouseButtonState) -> Option<&'static str> {
    match (button, state) {
        (MouseButton::Left, MouseButtonState::Up) => Some(OPEN),
        _ => None,
    }
}

/// Open Lockbox, Lock all and Quit, in that order.
fn menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let items = ITEMS
        .iter()
        .map(|(id, text)| MenuItem::with_id(app, *id, *text, true, None::<&str>))
        .collect::<tauri::Result<Vec<_>>>()?;
    let items: Vec<&dyn IsMenuItem<R>> = items.iter().map(|item| item as _).collect();
    Menu::with_items(app, &items)
}

/// What a menu item does. Runs on the event loop's thread, so each item is quick or hands its work to another thread.
fn chosen<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        // The way back for a hidden window, the one a second launch takes too.
        OPEN => window::bring_to_front(app),
        LOCK_ALL => {
            if let Some(shell) = app.try_state::<Arc<Shell>>() {
                lock_all(&shell);
            }
        }
        QUIT => match app.try_state::<Arc<Shell>>() {
            Some(shell) => quit(&shell, || app.exit(0)),
            // No shell, nothing to lock: a failed start.
            None => app.exit(0),
        },
        _ => {}
    }
}

/// Lock all, from the tray: what the page's `lock_all` command does (every vault locked as a person's own lock, the
/// clipboard copy cleared, every long operation cancelled), off the event loop's thread.
pub(crate) fn lock_all(shell: &Arc<Shell>) {
    shell.run_in_background(Shell::lock_all);
}

/// Quit: [`Shell::shutdown`] (every vault locked as an app close, at most [`SHUTDOWN_WAIT`] of waiting for the hooks),
/// then `exit`. The exit that follows runs `shutdown` again, which returns at once. Runs on the event loop's thread,
/// as the close request's did before the window hid to the tray.
///
/// [`SHUTDOWN_WAIT`]: crate::autolock::SHUTDOWN_WAIT
pub(crate) fn quit(shell: &Shell, exit: impl FnOnce()) {
    shell.shutdown();
    exit();
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    use tauri::menu::MenuItemKind;
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use zeroize::Zeroizing;

    use super::*;
    use crate::autolock::SHUTDOWN_WAIT;
    use crate::lock;
    use crate::session::{LockReason, SessionState};
    use crate::testing::TestShell;

    /// How long a test waits for a step on another thread before it fails.
    const PATIENCE: Duration = Duration::from_secs(5);
    /// What a shutdown may take past [`SHUTDOWN_WAIT`] on a loaded machine.
    const SCHEDULING_MARGIN: Duration = Duration::from_millis(250);
    /// A made-up text, never a real secret.
    const COPIED: &str = "Pw-0123456789-xyz";

    fn wait_until(what: &str, done: impl Fn() -> bool) {
        let began = Instant::now();
        while !done() {
            assert!(began.elapsed() < PATIENCE, "{what}");
            thread::sleep(Duration::from_millis(2));
        }
    }

    fn all_locked(ts: &TestShell) -> bool {
        ts.shell
            .sessions
            .list()
            .iter()
            .all(|s| s.state == SessionState::Locked)
    }

    /// The tray's Lock all does what the page's `lock_all` command does: every vault locks as a person's own lock, the
    /// clipboard copy is cleared and a long operation without a session is cancelled. It runs off the thread that
    /// called it (the event loop's), and has finished by the time the vaults read as locked.
    #[test]
    fn tray_lock_all_locks() {
        let ts = TestShell::new();
        let (session, generation) = ts.open_vault("Family");
        ts.open_vault("Work");
        ts.shell
            .clipboard
            .copy(
                &ts.shell.sessions,
                session,
                generation,
                Zeroizing::new(COPIED.to_owned()),
            )
            .unwrap();
        let test_backup = lockbox_core::blob::CancelToken::new();
        let _running = ts
            .shell
            .autolock
            .begin(None, "test_backup", test_backup.clone());

        lock_all(&ts.shell);

        wait_until("the tray's Lock all did not lock", || {
            all_locked(&ts) && ts.clipboard.text().is_none() && test_backup.is_cancelled()
        });
        assert!(
            ts.events
                .locked()
                .iter()
                .all(|(_, _, reason)| *reason == LockReason::Manual)
        );
        assert_eq!(ts.events.locked().len(), 2);
        // The thread that locked holds the shell until it is done.
        wait_until("the lock never finished", || {
            Arc::strong_count(&ts.shell) == 1
        });
        // Lock all is not the end: the gate is open, and the window is left as it is.
        assert_eq!(ts.window.hides(), 0);
        let (again, _) = ts.open_vault("Again");
        assert!(
            ts.shell
                .sessions
                .list()
                .iter()
                .any(|s| s.session == again && s.state == SessionState::Unlocked)
        );
    }

    /// Quit runs the shell's shutdown and only then exits: every vault is locked when `exit` is called, and a lock hook
    /// that stalls holds the exit for no longer than the shutdown wait.
    #[test]
    fn quit_locks_within_the_shutdown_wait() {
        // Hooks that return: locked, then exit, at once.
        let ts = TestShell::new();
        ts.open_vault("Family");
        let exits = AtomicUsize::new(0);
        let started = Instant::now();
        quit(&ts.shell, || {
            assert!(all_locked(&ts), "exit before every vault was locked");
            exits.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(exits.load(Ordering::SeqCst), 1);
        assert!(started.elapsed() < SHUTDOWN_WAIT);
        assert!(
            ts.events
                .locked()
                .iter()
                .all(|(_, _, reason)| *reason == LockReason::AppClosing)
        );

        // A hook that blocks: still locked, and exit comes after the wait and not much later.
        let ts = TestShell::new();
        ts.open_vault("Family");
        let (release, released) = mpsc::channel::<()>();
        let released = std::sync::Mutex::new(released);
        ts.shell.sessions.on_lock(Box::new(move |_, _| {
            let _ = lock(&released).recv_timeout(Duration::from_secs(60));
        }));
        let exits = AtomicUsize::new(0);
        let started = Instant::now();
        quit(&ts.shell, || {
            assert!(all_locked(&ts), "exit before every vault was locked");
            exits.fetch_add(1, Ordering::SeqCst);
        });
        let took = started.elapsed();
        assert_eq!(exits.load(Ordering::SeqCst), 1);
        assert!(
            took >= SHUTDOWN_WAIT,
            "it did not wait for the hook ({took:?})"
        );
        assert!(
            took < SHUTDOWN_WAIT + SCHEDULING_MARGIN,
            "it waited too long ({took:?})"
        );
        release.send(()).unwrap();
    }

    /// A left click on the icon opens the window (Windows' convention), on the release of the button, through the same
    /// menu choice as "Open Lockbox" and so the same way back; no other click does anything, and a right click is left
    /// to the menu.
    #[test]
    fn left_click_opens_the_window_through_the_open_item() {
        use MouseButton::{Left, Middle, Right};
        use MouseButtonState::{Down, Up};
        assert_eq!(click_chooses(Left, Up), Some(OPEN));
        assert_eq!(
            ITEMS[0].0, OPEN,
            "Open Lockbox is not the item the click uses"
        );
        for (button, state) in [
            (Left, Down),
            (Right, Up),
            (Right, Down),
            (Middle, Up),
            (Middle, Down),
        ] {
            assert_eq!(click_chooses(button, state), None, "{button:?} {state:?}");
        }
    }

    /// The menu is exactly Open Lockbox, Lock all and Quit, in that order, with ids the handler knows.
    #[test]
    fn tray_menu_is_open_lock_all_and_quit() {
        let app = mock_builder()
            .build(mock_context(noop_assets()))
            .expect("the mock app builds");
        let menu = menu(app.handle()).expect("the menu builds");
        let seen: Vec<(String, String)> = menu
            .items()
            .expect("the menu lists its items")
            .into_iter()
            .map(|item| match item {
                MenuItemKind::MenuItem(item) => (
                    item.id().as_ref().to_owned(),
                    item.text().expect("an item has its text"),
                ),
                _ => panic!("the menu holds only plain items"),
            })
            .collect();
        assert_eq!(
            seen,
            [
                ("open".to_owned(), "Open Lockbox".to_owned()),
                ("lock_all".to_owned(), "Lock all".to_owned()),
                ("quit".to_owned(), "Quit".to_owned()),
            ]
        );
    }
}
