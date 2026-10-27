//! Lockbox's desktop shell (spec §4): the Tauri app between the screens and the vault engine.
#![deny(unsafe_code)]

pub mod commands;
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
