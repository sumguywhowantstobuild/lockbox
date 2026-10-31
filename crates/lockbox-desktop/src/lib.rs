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
pub mod commands;
pub mod error;
pub mod locations;
mod os;
pub mod paths;
pub mod pending;
pub mod registry;
pub mod session;
pub mod settings;
pub mod shell;
#[cfg(test)]
mod testing;
pub mod views;
pub mod window;

pub use commands::handler;

use std::sync::{Arc, Mutex, MutexGuard, PoisonError, mpsc};
use std::time::Instant;
use std::{io, thread};

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

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
            // `manage` refuses (and drops, which closes the window) a second value of the same type.
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
            if !app.manage(Arc::clone(&shell)) {
                return Err("Lockbox will not run: its vault sessions could not be kept".into());
            }
            // Fail closed here too: never run without the auto-lock. Signals that came before this wait in the channel.
            route_signals(signals, Arc::clone(&shell))?;
            start_ticks(shell)?;

            window::main_window(app.handle())?;
            // Fail closed as well: never run with files droppable into the page.
            if !window::external_drop_is_off() {
                return Err(
                    "Lockbox will not run: its window could not turn off file drops".into(),
                );
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the Lockbox app could not start");

    // Every way out locks every vault before the process ends: closing the main window, the exit request that follows,
    // and the loop's end. Windows signing out or shutting down (`WM_ENDSESSION`) reaches the app only as `Exit`: tao
    // 0.37.2 sends it, then calls `process::exit` as soon as this callback returns. Each call returns once every vault
    // is revoked (later calls at once), or after `autolock::SHUTDOWN_WAIT` at most.
    app.run(|app, event| match event {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { .. },
            ..
        } if label == window::MAIN => shutdown(app),
        RunEvent::ExitRequested { .. } | RunEvent::Exit => shutdown(app),
        _ => {}
    });
}

/// [`Shell::shutdown`], when the shell was made (a failed setup ends the app before there is one).
fn shutdown(app: &AppHandle) {
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
/// must not wait. Debug builds also print each signal on standard error, one line each, for the hands-on check: the
/// signal's name and, for a drive, its drive-letter mask; nothing else.
fn route_signals(signals: mpsc::Receiver<os::OsSignal>, shell: Arc<Shell>) -> io::Result<()> {
    thread::Builder::new()
        .name("lockbox-signal-route".into())
        .spawn(move || {
            for signal in signals {
                #[cfg(debug_assertions)]
                eprintln!("Lockbox debug: Windows signal {signal:?}");
                shell.autolock.signal(signal);
            }
            #[cfg(debug_assertions)]
            eprintln!("Lockbox debug: Windows signals stopped");
        })?;
    Ok(())
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
