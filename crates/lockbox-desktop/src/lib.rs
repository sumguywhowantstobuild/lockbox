//! Lockbox's desktop shell (spec §4): the Tauri app between the screens and the vault engine.
#![deny(unsafe_code)]

// The window's file-drop protection is WebView2's and the lock signals are Windows' own (`os::win`); there is no
// equivalent on other platforms.
#[cfg(not(windows))]
compile_error!("lockbox-desktop is Windows-only");

// A release build without `custom-protocol` would load the Vite dev server and allow its origin.
#[cfg(all(dev, not(debug_assertions)))]
compile_error!("release builds need `--features custom-protocol` (cargo tauri build adds it)");

pub mod autolock;
pub mod capture;
pub mod clipboard;
pub mod commands;
pub mod error;
pub mod locations;
pub mod open;
mod os;
pub mod outputs;
pub mod paths;
pub mod pending;
pub mod registry;
pub mod restore;
pub mod session;
pub mod settings;
pub mod shell;
#[cfg(test)]
mod testing;
pub mod tray;
pub mod vault_state;
pub mod views;
pub mod window;

pub use commands::handler;

use std::sync::{Arc, Mutex, MutexGuard, PoisonError, mpsc};
use std::time::Instant;
use std::{io, thread};

use tauri::{AppHandle, CloseRequestApi, Manager, RunEvent, Runtime, WindowEvent};

use crate::shell::{Events, Shell};

/// Starts the app and runs it until it exits.
pub fn run() {
    let app = tauri::Builder::default()
        // First: a second copy of the app hands over to this one and exits inside `build()`, before any setup runs.
        // Its arguments and working directory are ignored (and never logged).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            window::bring_to_front(app)
        }))
        .invoke_handler(handler())
        .setup(|app| {
            // First of all, before any launch work: the one copy of the app in this sign-in. The single-instance
            // plugin falls through when its mutex exists but its window does not exist yet, so two copies can reach
            // here, and the second one's launch work would remove the first one's staging folder and temps. Nothing
            // has started in this copy, so it simply ends. Fail closed when Windows will not say.
            match os::win::claim_instance() {
                Err(_) => {
                    return Err(
                        "Lockbox will not run: it could not tell whether it is already running"
                            .into(),
                    );
                }
                Ok(None) => std::process::exit(0),
                Ok(Some(running)) => {
                    // For the life of the process: dropping the guard would let a second copy start.
                    if !app.manage(running) {
                        return Err(
                            "Lockbox will not run: its running copy could not be kept".into()
                        );
                    }
                }
            }
            // Fail closed: never run without Windows' lock, sleep and drive notices (spec §7.4). Tauri ends the
            // process on a setup error (it panics with this message), before the event loop goes on to load and run
            // the app page. The app's state keeps the signal thread for as long as the app runs: dropping it would
            // stop the notices.
            let (sink, signals) = mpsc::channel();
            let Ok(signal_thread) = os::win::spawn(sink) else {
                return Err(
                    "Lockbox will not run: it could not listen for Windows lock and sleep".into(),
                );
            };
            // The save shortcut is registered below, once the shell exists to answer a press and to tell the page when
            // Windows says no. `manage` refuses (and drops, which closes the window) a second value of the same type.
            if !app.manage(signal_thread) {
                return Err(
                    "Lockbox will not run: its Windows lock and sleep listener could not be kept"
                        .into(),
                );
            }

            // Before the window, so every command finds it. No vault may live in the folders Tauri keeps for the
            // app, which an uninstaller may delete (spec §6.10).
            let app_dirs = vec![app.path().app_data_dir()?, app.path().app_local_data_dir()?];
            let shell = Arc::new(Shell::new(
                Arc::new(Events(app.handle().clone())),
                os::Os::windows(app.handle().clone()),
                app_dirs,
            )?);
            // Launch work, here only: a second copy of the app exits before setup, so it never recovers or sweeps the
            // first copy's folders. It comes before the shell is managed and before the window exists, so no command
            // can answer before it has run: a half-done restore is settled first (spec §6.8), then the output journal's
            // leftovers (spec §7.2), then the "Open" folders'.
            shell.launch_work();
            if !app.manage(Arc::clone(&shell)) {
                return Err("Lockbox will not run: its vault sessions could not be kept".into());
            }
            // Fail closed here too: never run without the auto-lock. Signals that came before this wait in the channel.
            route_signals(signals, Arc::clone(&shell))?;
            // After the route, so a press that comes at once is answered. The app runs whatever Windows says.
            register_save_shortcut(&shell, |shortcut| {
                app.state::<os::win::SignalThread>().set_hotkey(shortcut)
            });
            start_ticks(shell)?;

            // The icon by the clock, where the window hides to: fail closed, since a hidden window with no icon could
            // never be reached again.
            if tray::build(app.handle()).is_err() {
                return Err("Lockbox will not run: its icon by the clock could not be made".into());
            }

            // The window is built hidden and shown only once its protections are in place. Fail closed as well: never
            // run with files droppable into the page, or with the browser's keys and menu (Ctrl+P, F12, the context
            // menu) able to reach a revealed secret. The window stays hidden when either is not confirmed.
            let window = window::main_window(app.handle())?;
            if window::show_main_window(&window).is_err() {
                return Err(match (
                    window::external_drop_is_off(),
                    window::browser_keys_are_off(),
                ) {
                    (false, _) => "Lockbox will not run: its window could not turn off file drops",
                    (_, false) => {
                        "Lockbox will not run: its window could not turn off the browser's keys and menu"
                    }
                    (true, true) => "Lockbox will not run: its window could not be shown",
                }
                .into());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the Lockbox app could not start");

    app.run(on_run_event);
}

/// What the app does with each event of its run. The window's close button never ends the app (it locks every vault
/// and hides the window to the tray: [`close_requested`]); the tray's Quit does ([`tray::quit`]). Every way out locks
/// every vault before the process ends: Quit, the exit request that follows it, and the loop's end. Windows signing out
/// or shutting down (`WM_ENDSESSION`) reaches the app only as `Exit`: tao 0.37.2 sends it, then calls `process::exit`
/// as soon as this callback returns. Each [`shutdown`] call returns once every vault is revoked (later calls at once),
/// or after `autolock::SHUTDOWN_WAIT` at most.
fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: RunEvent) {
    match event {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if label == window::MAIN => close_requested(app, &api),
        RunEvent::ExitRequested { .. } | RunEvent::Exit => shutdown(app),
        _ => {}
    }
}

/// What a close request lets the handler do to the window's close.
trait PreventClose {
    fn prevent_close(&self);
}

impl PreventClose for CloseRequestApi {
    fn prevent_close(&self) {
        CloseRequestApi::prevent_close(self);
    }
}

/// The main window's close button: the window is not closed (so the app keeps running, and the save shortcut with it),
/// and [`Shell::close_window`] locks every vault and hides the window, off the event loop's thread. With no shell (a
/// failed start) the close is left alone, so the app can still end.
fn close_requested<R: Runtime>(app: &AppHandle<R>, api: &impl PreventClose) {
    let Some(shell) = app.try_state::<Arc<Shell>>() else {
        return;
    };
    api.prevent_close();
    shell.run_in_background(Shell::close_window);
}

/// [`Shell::shutdown`], when the shell was made (a failed setup ends the app before there is one).
fn shutdown<R: Runtime>(app: &AppHandle<R>) {
    if let Some(shell) = app.try_state::<Arc<Shell>>() {
        shell.shutdown();
    }
}

/// Locks `mutex`, also after a panic elsewhere left it poisoned: what each lock of the crate guards is never left
/// half-written.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Hands each Windows signal to the auto-lock, on a thread of its own: never on the signal window's thread, which
/// must not wait. A press of the save shortcut is not a lock signal: it goes to the shell on a second thread, because
/// reading the clipboard can wait for another program, and a lock signal behind it must not. Debug builds also print
/// each signal on standard error, one line each, for the hands-on check: the signal's name and, for a drive, its
/// drive-letter mask; nothing else.
fn route_signals(signals: mpsc::Receiver<os::OsSignal>, shell: Arc<Shell>) -> io::Result<()> {
    let (presses, pressed) = mpsc::channel::<()>();
    let reader = Arc::clone(&shell);
    thread::Builder::new()
        .name("lockbox-save-shortcut".into())
        .spawn(move || {
            for () in pressed {
                reader.save_shortcut_pressed();
            }
        })?;
    thread::Builder::new()
        .name("lockbox-signal-route".into())
        .spawn(move || {
            for signal in signals {
                #[cfg(debug_assertions)]
                eprintln!("Lockbox debug: Windows signal {signal:?}");
                match signal {
                    // The reader thread ends with the router's, which drops `presses`.
                    os::OsSignal::SaveShortcut => {
                        let _ = presses.send(());
                    }
                    lock_signal => shell.autolock.signal(lock_signal),
                }
            }
            #[cfg(debug_assertions)]
            eprintln!("Lockbox debug: Windows signals stopped");
        })?;
    Ok(())
}

/// Registers the save shortcut (Ctrl+Shift+L) through `set_hotkey` and tells the shell what Windows answered: the page
/// hears of a shortcut that is taken or could not be set ([`Shell::shortcut_registered`]). The app runs either way.
fn register_save_shortcut(
    shell: &Shell,
    set_hotkey: impl FnOnce(Option<os::Shortcut>) -> Result<(), os::HotkeyTaken>,
) {
    shell.shortcut_registered(set_hotkey(Some(os::Shortcut::default())));
}

/// The auto-lock's timer: a tick every [`autolock::TICK`] for as long as the app runs.
fn start_ticks(shell: Arc<Shell>) -> io::Result<()> {
    thread::Builder::new()
        .name("lockbox-autolock".into())
        .spawn(move || {
            loop {
                thread::sleep(autolock::TICK);
                shell.autolock.tick(Instant::now());
            }
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    use tauri::App;
    use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};

    use super::*;
    use crate::os::OsSignal;
    use crate::session::{LockReason, SessionState};
    use crate::testing::TestShell;

    /// How long a test waits before it fails instead of hanging.
    const GIVE_UP: Duration = Duration::from_secs(30);
    const COPIED: &str = "Pw-0123456789-xyz";

    fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
        let began = Instant::now();
        while !done() {
            assert!(began.elapsed() < GIVE_UP, "{what}");
            thread::sleep(Duration::from_millis(2));
        }
    }

    /// A close request's answer, recorded.
    #[derive(Default)]
    struct FakeClose(AtomicBool);

    impl PreventClose for FakeClose {
        fn prevent_close(&self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    impl FakeClose {
        fn prevented(&self) -> bool {
            self.0.load(Ordering::SeqCst)
        }
    }

    /// A test app (no window, no webview) that keeps `ts`'s shell, as the real one does.
    fn app_with(ts: &TestShell) -> App<MockRuntime> {
        let app = mock_builder()
            .build(mock_context(noop_assets()))
            .expect("the mock app builds");
        assert!(app.manage(Arc::clone(&ts.shell)));
        app
    }

    fn state_of(ts: &TestShell, session: crate::session::SessionId) -> SessionState {
        ts.shell
            .sessions
            .list()
            .iter()
            .find(|s| s.session == session)
            .expect("the session is listed")
            .state
    }

    /// Windows ending the session (and the app's own exit) still runs the shutdown: every vault locks as an app close,
    /// through the run's own event handler (`Exit` is the only event a sign-out or shutdown brings) and through the
    /// signal router (`Ending`). An event that is neither locks nothing.
    #[test]
    fn windows_ending_still_runs_shutdown() {
        let ts = TestShell::new();
        let (family, _) = ts.open_vault("Family");
        let app = app_with(&ts);

        on_run_event(app.handle(), RunEvent::Ready);
        assert_eq!(state_of(&ts, family), SessionState::Unlocked);

        on_run_event(app.handle(), RunEvent::Exit);
        assert_eq!(state_of(&ts, family), SessionState::Locked);
        assert_eq!(
            ts.events.locked().iter().map(|l| l.2).collect::<Vec<_>>(),
            [LockReason::AppClosing]
        );

        let ts = TestShell::new();
        let (session, _) = ts.open_vault("Family");
        let (sink, signals) = mpsc::channel();
        route_signals(signals, Arc::clone(&ts.shell)).unwrap();
        sink.send(OsSignal::Ending).unwrap();
        wait_until("Windows ending never reached the shutdown", || {
            ts.events.locked().iter().any(|l| l.0 == session)
        });
        assert_eq!(
            ts.events.locked().iter().map(|l| l.2).collect::<Vec<_>>(),
            [LockReason::AppClosing]
        );
    }

    /// The window's close button is stopped from closing the window, and what runs instead locks every vault off the
    /// event loop's thread. It is not an exit: the shell's closing gate stays open. Without a shell (a failed start) the
    /// close is left alone, so the app can still end.
    #[test]
    fn close_request_is_prevented_and_leaves_the_app_running() {
        let ts = TestShell::new();
        let (family, _) = ts.open_vault("Family");
        let app = app_with(&ts);

        let api = FakeClose::default();
        close_requested(app.handle(), &api);
        assert!(api.prevented(), "the window was left to close");
        // The lock event is sent just after the session's state changes, from the close's own thread: wait for both.
        wait_until("the close never locked", || {
            state_of(&ts, family) == SessionState::Locked && !ts.events.locked().is_empty()
        });
        assert_eq!(
            ts.events.locked().iter().map(|l| l.2).collect::<Vec<_>>(),
            [LockReason::Manual]
        );
        // The close's thread holds the shell until it is done: the managed copy and the test's are the other two.
        wait_until("the close never finished", || {
            Arc::strong_count(&ts.shell) == 2
        });
        let (again, _) = ts.open_vault("Again");
        assert_eq!(state_of(&ts, again), SessionState::Unlocked);
        // The test app keeps the shell alive past this test: no vault is left open in the folder that is removed.
        ts.shell.lock_all();

        let bare = mock_builder()
            .build(mock_context(noop_assets()))
            .expect("the mock app builds");
        let api = FakeClose::default();
        close_requested(bare.handle(), &api);
        assert!(
            !api.prevented(),
            "a close was stopped with no shell to lock"
        );
    }

    /// A press of the shortcut, as the signal window sends it, ends in the shell, which reads the clipboard once and tells
    /// the page. A lock signal still reaches the auto-lock, and a press never counts as a lock or a lock as a press.
    /// A clipboard read that hangs (another program holds the clipboard) does not hold up a lock signal sent after the
    /// press, and the press that began before that lock keeps nothing when it finishes.
    #[test]
    fn hotkey_signal_reaches_the_router() {
        let ts = TestShell::new();
        let (sink, signals) = mpsc::channel();
        route_signals(signals, Arc::clone(&ts.shell)).unwrap();

        assert!(ts.clipboard.user_copy(COPIED));
        sink.send(OsSignal::SaveShortcut).unwrap();
        wait_until("the press never reached the shell", || {
            ts.shell.shortcut_presses() == 1
        });
        wait_until("the press never told the page", || {
            ts.events.captures().len() == 1
        });
        assert_eq!(ts.clipboard.opens(), 1, "a press opens the clipboard once");

        let (session, _) = ts.open_vault("Family");
        sink.send(OsSignal::SessionLocked).unwrap();
        wait_until("the lock signal never reached the auto-lock", || {
            ts.events.locked().iter().any(|locked| locked.0 == session)
        });
        assert_eq!(ts.shell.shortcut_presses(), 1, "a lock counted as a press");

        // A press whose read hangs, and a lock signal sent after it.
        let (stuck, is_stuck) = mpsc::channel::<()>();
        let (release, released) = mpsc::channel::<()>();
        let released = Mutex::new(released);
        ts.clipboard.during_next_read(Box::new(move || {
            let _ = stuck.send(());
            let _ = lock(&released).recv_timeout(GIVE_UP);
        }));
        assert!(ts.clipboard.user_copy(COPIED));
        sink.send(OsSignal::SaveShortcut).unwrap();
        is_stuck
            .recv_timeout(GIVE_UP)
            .expect("the press never reached the clipboard");
        let (again, _) = ts.open_vault("Work");
        sink.send(OsSignal::SessionLocked).unwrap();
        wait_until("a hung read held up the lock signal", || {
            ts.events.locked().iter().any(|locked| locked.0 == again)
        });
        assert_eq!(ts.shell.shortcut_presses(), 2);

        // The read finishes after the lock: that press keeps nothing and tells nothing. The next press (read behind it)
        // is the one the page hears of. The first capture was emptied by the first lock (`gone`), so the page was told:
        // a value, its end, and the third press's value, in that order, and no value for the hung press.
        release.send(()).unwrap();
        wait_until("the hung press never ended", || !ts.clipboard.is_open());
        sink.send(OsSignal::SaveShortcut).unwrap();
        wait_until("the third press never told the page", || {
            ts.shell.shortcut_presses() == 3 && ts.shell.capture_state().is_some()
        });
        let told: Vec<String> = ts
            .events
            .captures()
            .iter()
            .map(|event| event["state"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            told,
            ["value", "gone", "value"],
            "the hung press told the page after a lock"
        );
        assert_eq!(ts.events.locked().len(), 2, "a press locked a vault");
        assert_eq!(ts.clipboard.text().as_deref(), Some(COPIED));
    }

    /// The shortcut is asked for at launch (Ctrl+Shift+L), and what Windows says about it is told to the page as a launch
    /// notice, kept for a page that loads later: "taken" only when Windows says the keys are registered already, and
    /// "not set" for every other refusal. A shortcut that is set says nothing.
    #[test]
    fn taken_at_launch_is_told() {
        let default = os::Shortcut::default();
        assert_eq!(
            (default.ctrl, default.shift, default.alt, default.key),
            (true, true, false, u16::from(b'L'))
        );
        let cases = [
            (Err(os::HotkeyTaken::Taken), Some("shortcut_taken")),
            (Err(os::HotkeyTaken::NotSet), Some("shortcut_not_set")),
            (Ok(()), None),
        ];
        for (answer, notice) in cases {
            let ts = TestShell::new();
            let mut asked = Vec::new();
            register_save_shortcut(&ts.shell, |shortcut| {
                asked.push(shortcut);
                answer
            });
            assert_eq!(
                asked,
                [Some(default)],
                "it was asked for once, with the default keys"
            );
            let told: Vec<serde_json::Value> = notice
                .into_iter()
                .map(|kind| serde_json::json!({ "kind": kind }))
                .collect();
            assert_eq!(ts.events.notices(), told, "{answer:?}");
            let kept: Vec<serde_json::Value> = ts
                .shell
                .launch_notices()
                .iter()
                .map(|kept| serde_json::to_value(kept).unwrap())
                .collect();
            assert_eq!(
                kept, told,
                "a page that loads later must hear of it too: {answer:?}"
            );
        }
    }
}
