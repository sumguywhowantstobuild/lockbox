//! Lockbox's desktop shell (spec §4): the Tauri app between the screens and the vault engine.
#![deny(unsafe_code)]

// The window's file-drop protection is WebView2's (`os::win`); there is no equivalent on other platforms.
#[cfg(not(windows))]
compile_error!("lockbox-desktop is Windows-only");

// A release build without `custom-protocol` would load the Vite dev server and allow its origin.
#[cfg(all(dev, not(debug_assertions)))]
compile_error!("release builds need `--features custom-protocol` (cargo tauri build adds it)");

pub mod commands;
mod os;
pub mod window;

pub use commands::handler;

use tauri::RunEvent;

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
            window::main_window(app.handle())?;
            // Fail closed: never run with files droppable into the page. Tauri ends the process on a setup error
            // (it panics with this message), before the event loop goes on to load and run the app page.
            if !window::external_drop_is_off() {
                return Err(
                    "Lockbox will not run: its window could not turn off file drops".into(),
                );
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the Lockbox app could not start");

    app.run(|_app, event| {
        if let RunEvent::ExitRequested { .. } = event {
            // Task 11: lock every vault here (`Shell::shutdown`) before the process ends.
        }
    });
}
