//! The IPC bridge: which commands the page may call, from which window and origin, and what a bad request gets back.
//! The app is built from the real `tauri.conf.json` and `capabilities/main.json`, so the real ACL applies.
//!
//! The test runtime (`MockRuntime`) ignores the window's webview settings. Navigation, downloads and dropped files
//! were checked by hand on a release build (the hands-on probes of Plan 4A's first tasks, since removed). A popup's
//! outcome is the only thing observable: wry refuses new windows even without Tauri's handler. Autofill and the
//! in-private profile cannot be observed from the page; they are covered only by review of `window::main_window`.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::{Arc, Mutex};

use lockbox_desktop::commands::COMMANDS;
use lockbox_desktop::handler;
use lockbox_desktop::jobs::{
    CloseAsked, CloseReason, JobKind, JobScope, JobStarted, LockEpochEvent, OperationId,
    ProgressEvent,
};
use lockbox_desktop::session::{LockReason, Notifier, SessionId};
use lockbox_desktop::shell::{
    CLOSE_ASKED_EVENT, Events, JOB_STARTED_EVENT, LOCK_EPOCH_EVENT, PROGRESS_EVENT,
};
use lockbox_desktop::window::{allowed_navigation, main_window};
use serde_json::{Value, json};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
use tauri::utils::config::{Csp, FrontendDist, PatternKind};
use tauri::webview::InvokeRequest;
use tauri::{App, Listener, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; \
                   font-src 'self'; connect-src ipc: http://ipc.localhost; object-src 'none'; \
                   base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/// The app's own origin on Windows: where every request from the real page comes from.
const APP_ORIGIN: &str = "http://tauri.localhost";

fn app() -> App<MockRuntime> {
    mock_builder()
        .invoke_handler(handler())
        .build(tauri::generate_context!())
        .expect("the app builds")
}

fn main_webview(app: &App<MockRuntime>) -> WebviewWindow<MockRuntime> {
    main_window(app.handle()).expect("the main window builds")
}

/// Sends `cmd` with `body` from `window`, as a page loaded from `origin` would.
fn invoke(
    window: &WebviewWindow<MockRuntime>,
    origin: &str,
    cmd: &str,
    body: InvokeBody,
) -> Result<Value, Value> {
    let request = InvokeRequest {
        cmd: cmd.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: origin.parse().unwrap(),
        body,
        headers: Default::default(),
        invoke_key: INVOKE_KEY.into(),
    };
    get_ipc_response(window, request).map(|body| body.deserialize().expect("a JSON answer"))
}

/// The ACL refused the call before it ran: Tauri's refusal says "not allowed" (with details in debug builds). Any
/// other error, such as missing arguments, would mean the command was granted and ran.
fn assert_refused_by_acl(cmd: &str, answer: Result<Value, Value>) {
    match answer {
        Err(Value::String(refusal)) if refusal.contains("not allowed") => {}
        other => panic!("{cmd} was not refused by the ACL: {other:?}"),
    }
}

fn read_json(file: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(file);
    serde_json::from_str(&std::fs::read_to_string(path).expect("file exists")).expect("valid JSON")
}

#[test]
fn granted_command_runs_in_main_window() {
    let app = app();
    let answer = invoke(
        &main_webview(&app),
        APP_ORIGIN,
        "app_info",
        InvokeBody::Json(json!({})),
    );
    assert_eq!(answer, Ok(json!({ "version": env!("CARGO_PKG_VERSION") })));
}

/// Each listed command passes the ACL and reaches its handler (fix round 1: `add_existing_vault_confirm` was added).
/// This test app keeps no shell state, so a command that needs it stops at Tauri's "state not managed" answer:
/// past the ACL, inside the handler. The generator needs none: its own request check refuses the empty body.
#[test]
fn every_listed_command_reaches_its_handler() {
    let app = app();
    let main = main_webview(&app);
    let malformed = json!({ "code": "invalid_input", "what": "request" });
    for cmd in COMMANDS {
        match invoke(&main, APP_ORIGIN, cmd, InvokeBody::Json(json!({}))) {
            Ok(_) => assert_eq!(*cmd, "app_info"),
            Err(Value::String(answer)) if answer.contains("state not managed") => {}
            Err(answer) if cmd.starts_with("generate_") && answer == malformed => {}
            other => panic!("{cmd} did not reach its handler: {other:?}"),
        }
    }
}

/// The hands-on probes of Plan 4A's first tasks are gone from what ships: not in the list of commands, not granted to
/// the window, not in the invoke handler, and no source file of theirs. (The word is built from two pieces so this
/// file does not match itself.)
#[test]
fn no_probe_command_ships() {
    let word = ["pro", "be"].concat();
    let source = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("commands");
    assert!(
        !COMMANDS.iter().any(|cmd| cmd.contains(&word)),
        "a probe command is in COMMANDS"
    );
    let capability = read_json("capabilities/main.json").to_string();
    assert!(
        !capability.contains(&word),
        "a probe is granted to the window"
    );
    let handler = std::fs::read_to_string(source.join("mod.rs")).expect("commands/mod.rs exists");
    assert!(!handler.contains(&word), "a probe is in the invoke handler");
    let files: Vec<String> = std::fs::read_dir(&source)
        .expect("commands/ exists")
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        !files.iter().any(|name| name.contains(&word)),
        "a probe source file is left: {files:?}"
    );
}

#[test]
fn other_window_is_refused() {
    let app = app();
    let probe = WebviewWindowBuilder::new(&app, "probe", WebviewUrl::App("index.html".into()))
        .build()
        .expect("the probe window builds");
    assert_refused_by_acl(
        "app_info",
        invoke(&probe, APP_ORIGIN, "app_info", InvokeBody::Json(json!({}))),
    );
}

/// `list_printers` is listed, granted to the main window and reaches its handler from it (it takes no arguments and no
/// session: a plain read of the printers Windows has); another window and a remote origin are refused by the ACL.
#[test]
fn list_printers_command_is_listed() {
    let cmd = "list_printers";
    assert!(COMMANDS.contains(&cmd), "{cmd} is not listed");
    let capability = read_json("capabilities/main.json");
    let granted: Vec<&str> = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(granted.contains(&"allow-list-printers"));
    let app = app();
    let main = main_webview(&app);
    let other = WebviewWindowBuilder::new(&app, "probe", WebviewUrl::App("index.html".into()))
        .build()
        .expect("the probe window builds");
    let body = || InvokeBody::Json(json!({}));
    match invoke(&main, APP_ORIGIN, cmd, body()) {
        Err(Value::String(answer)) if answer.contains("state not managed") => {}
        answer => panic!("{cmd} did not reach its handler: {answer:?}"),
    }
    assert_refused_by_acl(cmd, invoke(&other, APP_ORIGIN, cmd, body()));
    assert_refused_by_acl(cmd, invoke(&main, "https://example.com", cmd, body()));
}

/// `close_explained_ok` (5b's button) is listed, granted to the main window and reaches its handler from it; another
/// window and a remote origin are refused by the ACL, before the handler. It takes no session and no generation, so the
/// stale-generation, foreign-ID and read-only refusals do not apply to it (its own tests are in `commands::sessions`).
#[test]
fn close_explained_ok_is_granted_to_the_main_window_only() {
    let cmd = "close_explained_ok";
    assert!(COMMANDS.contains(&cmd), "{cmd} is not listed");
    let capability = read_json("capabilities/main.json");
    let granted: Vec<&str> = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(granted.contains(&"allow-close-explained-ok"));
    let app = app();
    let main = main_webview(&app);
    let other = WebviewWindowBuilder::new(&app, "probe", WebviewUrl::App("index.html".into()))
        .build()
        .expect("the probe window builds");
    let body = || InvokeBody::Json(json!({}));
    match invoke(&main, APP_ORIGIN, cmd, body()) {
        Err(Value::String(answer)) if answer.contains("state not managed") => {}
        answer => panic!("{cmd} did not reach its handler: {answer:?}"),
    }
    assert_refused_by_acl(cmd, invoke(&other, APP_ORIGIN, cmd, body()));
    assert_refused_by_acl(cmd, invoke(&main, "https://example.com", cmd, body()));
}

/// The commands that write a readable file or print the recovery key (Task 7) are listed, granted to the main window and
/// reach their handler from it; another window and a remote origin are refused by the ACL, before the handler. The page
/// sends no path and no key to any of them: their bodies are a session and a generation (and a printer's name, for
/// Print), or a token (checked in `commands::readable`'s own tests).
#[test]
fn readable_file_commands_are_granted_to_the_main_window_only() {
    let commands = [
        "save_recovery_pdf",
        "save_readable_confirm",
        "print_recovery_key",
    ];
    let capability = read_json("capabilities/main.json");
    let granted: Vec<&str> = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let app = app();
    let main = main_webview(&app);
    let other = WebviewWindowBuilder::new(&app, "probe", WebviewUrl::App("index.html".into()))
        .build()
        .expect("the probe window builds");
    for cmd in commands {
        assert!(COMMANDS.contains(&cmd), "{cmd} is not listed");
        let permission = format!("allow-{}", cmd.replace('_', "-"));
        assert!(
            granted.contains(&permission.as_str()),
            "{permission} is not granted"
        );
        let body = || InvokeBody::Json(json!({}));
        // Past the ACL and inside the handler: this test app keeps no shell state.
        match invoke(&main, APP_ORIGIN, cmd, body()) {
            Err(Value::String(answer)) if answer.contains("state not managed") => {}
            answer => panic!("{cmd} did not reach its handler: {answer:?}"),
        }
        assert_refused_by_acl(cmd, invoke(&other, APP_ORIGIN, cmd, body()));
        assert_refused_by_acl(cmd, invoke(&main, "https://example.com", cmd, body()));
    }
}

/// The five Save all commands (Plan 4B, Task 11) are listed, granted to the main window and reach their handler from it;
/// another window and a remote origin are refused by the ACL, before the handler. None takes a path: a folder is picked
/// by Rust, and the summary's folder is opened through a handle (their bodies are checked in `commands::save_all`'s own
/// tests, with the stale-generation, foreign-ID and read-only refusals).
#[test]
fn save_all_commands_are_granted_to_the_main_window_only() {
    let commands = [
        "save_all_files",
        "save_all_files_confirm",
        "save_all_start",
        "show_output_in_explorer",
        "close_output",
    ];
    let capability = read_json("capabilities/main.json");
    let granted: Vec<&str> = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let app = app();
    let main = main_webview(&app);
    let other = WebviewWindowBuilder::new(&app, "probe", WebviewUrl::App("index.html".into()))
        .build()
        .expect("the probe window builds");
    for cmd in commands {
        assert!(COMMANDS.contains(&cmd), "{cmd} is not listed");
        let permission = format!("allow-{}", cmd.replace('_', "-"));
        assert!(
            granted.contains(&permission.as_str()),
            "{permission} is not granted"
        );
        let body = || InvokeBody::Json(json!({}));
        // Past the ACL and inside the handler: this test app keeps no shell state.
        match invoke(&main, APP_ORIGIN, cmd, body()) {
            Err(Value::String(answer)) if answer.contains("state not managed") => {}
            answer => panic!("{cmd} did not reach its handler: {answer:?}"),
        }
        assert_refused_by_acl(cmd, invoke(&other, APP_ORIGIN, cmd, body()));
        assert_refused_by_acl(cmd, invoke(&main, "https://example.com", cmd, body()));
    }
}

/// The settings and Start with Windows commands (Task 20) are listed, granted to the main window and reach their handler
/// from it; another window and a remote origin are refused by the ACL, before the handler. None takes a session, a
/// generation or a path: the settings, or `{ on }`, are all they are sent (their bodies are checked in
/// `commands::settings`'s own tests, so the stale-generation, foreign-ID and read-only refusals do not apply).
#[test]
fn settings_and_startup_commands_are_granted_to_the_main_window_only() {
    let commands = ["get_settings", "set_settings", "get_startup", "set_startup"];
    let capability = read_json("capabilities/main.json");
    let granted: Vec<&str> = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let app = app();
    let main = main_webview(&app);
    let other = WebviewWindowBuilder::new(&app, "probe", WebviewUrl::App("index.html".into()))
        .build()
        .expect("the probe window builds");
    for cmd in commands {
        assert!(COMMANDS.contains(&cmd), "{cmd} is not listed");
        let permission = format!("allow-{}", cmd.replace('_', "-"));
        assert!(
            granted.contains(&permission.as_str()),
            "{permission} is not granted"
        );
        let body = || InvokeBody::Json(json!({}));
        // Past the ACL and inside the handler: this test app keeps no shell state.
        match invoke(&main, APP_ORIGIN, cmd, body()) {
            Err(Value::String(answer)) if answer.contains("state not managed") => {}
            answer => panic!("{cmd} did not reach its handler: {answer:?}"),
        }
        assert_refused_by_acl(cmd, invoke(&other, APP_ORIGIN, cmd, body()));
        assert_refused_by_acl(cmd, invoke(&main, "https://example.com", cmd, body()));
    }
}

/// The `.env` commands (Task 17) are listed, granted to the main window and reach their handler from it; another window
/// and a remote origin are refused by the ACL, before the handler. The page sends the pasted text to `env_read` once and
/// no path to any of them (their bodies are checked in `commands::env`'s own tests).
#[test]
fn env_commands_are_granted_to_the_main_window_only() {
    let commands = ["env_read", "env_save", "env_copy", "env_save_file"];
    let capability = read_json("capabilities/main.json");
    let granted: Vec<&str> = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let app = app();
    let main = main_webview(&app);
    let other = WebviewWindowBuilder::new(&app, "probe", WebviewUrl::App("index.html".into()))
        .build()
        .expect("the probe window builds");
    for cmd in commands {
        assert!(COMMANDS.contains(&cmd), "{cmd} is not listed");
        let permission = format!("allow-{}", cmd.replace('_', "-"));
        assert!(
            granted.contains(&permission.as_str()),
            "{permission} is not granted"
        );
        let body = || InvokeBody::Json(json!({}));
        // Past the ACL and inside the handler: this test app keeps no shell state.
        match invoke(&main, APP_ORIGIN, cmd, body()) {
            Err(Value::String(answer)) if answer.contains("state not managed") => {}
            answer => panic!("{cmd} did not reach its handler: {answer:?}"),
        }
        assert_refused_by_acl(cmd, invoke(&other, APP_ORIGIN, cmd, body()));
        assert_refused_by_acl(cmd, invoke(&main, "https://example.com", cmd, body()));
    }
}

/// The save box's commands (Task 18) are listed, granted to the main window and reach their handler from it; another window
/// and a remote origin are refused by the ACL, before the handler. None of them sends a value to Rust except a typed one
/// to `capture_save`, and none returns one except `capture_reveal` (checked in `commands::capture`'s own tests).
#[test]
fn capture_commands_are_granted_to_the_main_window_only() {
    let commands = [
        "capture_state",
        "capture_choose",
        "capture_reveal",
        "capture_save",
        "capture_cancel",
        "capture_env",
    ];
    let capability = read_json("capabilities/main.json");
    let granted: Vec<&str> = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let app = app();
    let main = main_webview(&app);
    let other = WebviewWindowBuilder::new(&app, "probe", WebviewUrl::App("index.html".into()))
        .build()
        .expect("the probe window builds");
    for cmd in commands {
        assert!(COMMANDS.contains(&cmd), "{cmd} is not listed");
        let permission = format!("allow-{}", cmd.replace('_', "-"));
        assert!(
            granted.contains(&permission.as_str()),
            "{permission} is not granted"
        );
        let body = || InvokeBody::Json(json!({}));
        // Past the ACL and inside the handler: this test app keeps no shell state.
        match invoke(&main, APP_ORIGIN, cmd, body()) {
            Err(Value::String(answer)) if answer.contains("state not managed") => {}
            answer => panic!("{cmd} did not reach its handler: {answer:?}"),
        }
        assert_refused_by_acl(cmd, invoke(&other, APP_ORIGIN, cmd, body()));
        assert_refused_by_acl(cmd, invoke(&main, "https://example.com", cmd, body()));
    }
}

/// `start_new_vault_list` (the lost-list screen's button) is listed, granted to the main window and reaches its handler
/// from it; another window and a remote origin are refused by the ACL, before the handler. It takes no arguments, no session
/// and no path, so the stale-generation, foreign-ID and read-only refusals do not apply to it (its own tests are in
/// `registry`, and `commands::vaults` refuses a request with a field).
#[test]
fn start_new_vault_list_is_granted_to_the_main_window_only() {
    let cmd = "start_new_vault_list";
    assert!(COMMANDS.contains(&cmd), "{cmd} is not listed");
    let capability = read_json("capabilities/main.json");
    let granted: Vec<&str> = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(granted.contains(&"allow-start-new-vault-list"));
    let app = app();
    let main = main_webview(&app);
    let other = WebviewWindowBuilder::new(&app, "probe", WebviewUrl::App("index.html".into()))
        .build()
        .expect("the probe window builds");
    let body = || InvokeBody::Json(json!({}));
    // Past the ACL and inside the handler: this test app keeps no shell state.
    match invoke(&main, APP_ORIGIN, cmd, body()) {
        Err(Value::String(answer)) if answer.contains("state not managed") => {}
        answer => panic!("{cmd} did not reach its handler: {answer:?}"),
    }
    assert_refused_by_acl(cmd, invoke(&other, APP_ORIGIN, cmd, body()));
    assert_refused_by_acl(cmd, invoke(&main, "https://example.com", cmd, body()));
}

/// `cancel_operation` (a job's Stop) is listed, granted to the main window and reaches its handler from it; another window
/// and a remote origin are refused by the ACL, before the handler. It takes an operation and its scope, not a session's
/// generation as a field of its own: a stale scope and a foreign or finished operation are refused by the shell
/// (`jobs`' own tests), since this test app keeps no shell state.
#[test]
fn cancel_operation_is_granted_to_the_main_window_only() {
    let cmd = "cancel_operation";
    assert!(COMMANDS.contains(&cmd), "{cmd} is not listed");
    let capability = read_json("capabilities/main.json");
    let granted: Vec<&str> = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(granted.contains(&"allow-cancel-operation"));
    let app = app();
    let main = main_webview(&app);
    let other = WebviewWindowBuilder::new(&app, "probe", WebviewUrl::App("index.html".into()))
        .build()
        .expect("the probe window builds");
    let body = || {
        InvokeBody::Json(json!({
            "operation": 1,
            "scope": { "type": "launch", "epoch": 0 }
        }))
    };
    match invoke(&main, APP_ORIGIN, cmd, body()) {
        Err(Value::String(answer)) if answer.contains("state not managed") => {}
        answer => panic!("{cmd} did not reach its handler: {answer:?}"),
    }
    assert_refused_by_acl(cmd, invoke(&other, APP_ORIGIN, cmd, body()));
    assert_refused_by_acl(cmd, invoke(&main, "https://example.com", cmd, body()));
}

/// `close_answer` (the answer to the close or Quit question) is listed, granted to the main window and reaches its handler
/// from it; another window and a remote origin are refused by the ACL, before the handler. It takes no session and no
/// generation (it reads and writes no vault), so the stale-generation, foreign-ID and read-only refusals do not apply to
/// it; a question that is not pending is refused by the shell (its own tests are in `commands::sessions`).
#[test]
fn close_answer_is_granted_to_the_main_window_only() {
    let cmd = "close_answer";
    assert!(COMMANDS.contains(&cmd), "{cmd} is not listed");
    let capability = read_json("capabilities/main.json");
    let granted: Vec<&str> = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(granted.contains(&"allow-close-answer"));
    let app = app();
    let main = main_webview(&app);
    let other = WebviewWindowBuilder::new(&app, "probe", WebviewUrl::App("index.html".into()))
        .build()
        .expect("the probe window builds");
    let body = || InvokeBody::Json(json!({ "go": false }));
    match invoke(&main, APP_ORIGIN, cmd, body()) {
        Err(Value::String(answer)) if answer.contains("state not managed") => {}
        answer => panic!("{cmd} did not reach its handler: {answer:?}"),
    }
    assert_refused_by_acl(cmd, invoke(&other, APP_ORIGIN, cmd, body()));
    assert_refused_by_acl(cmd, invoke(&main, "https://example.com", cmd, body()));
}

/// The question goes to the main window and no other window: a listener on the main window hears it with exactly the
/// frozen payload, and one on another window hears nothing. Widening the target to every window (`Any`) fails this.
#[test]
fn close_asked_goes_to_the_main_window_only() {
    let app = app();
    let main = main_webview(&app);
    let other = WebviewWindowBuilder::new(&app, "probe", WebviewUrl::App("index.html".into()))
        .build()
        .expect("the probe window builds");
    let (heard_main, heard_other) = (
        Arc::new(Mutex::new(Vec::<String>::new())),
        Arc::new(Mutex::new(Vec::<String>::new())),
    );
    for (window, heard) in [(&main, &heard_main), (&other, &heard_other)] {
        let heard = Arc::clone(heard);
        window.listen(CLOSE_ASKED_EVENT, move |event| {
            heard.lock().unwrap().push(event.payload().to_owned());
        });
    }

    Events(app.handle().clone()).close_asked(&CloseAsked {
        reason: CloseReason::Quit,
        running: vec![JobKind::Import, JobKind::Restore],
        past_swap: true,
    });

    let heard: Vec<Value> = heard_main
        .lock()
        .unwrap()
        .iter()
        .map(|payload| serde_json::from_str(payload).unwrap())
        .collect();
    assert_eq!(
        heard,
        [json!({ "reason": "quit", "running": ["import", "restore"], "past_swap": true })]
    );
    assert!(
        heard_other.lock().unwrap().is_empty(),
        "another window heard the question"
    );
}

/// `vault_backup_due` (the 30-day reminder) is listed, granted to the main window and reaches its handler from it;
/// another window and a remote origin are refused by the ACL, before the handler. Its arguments are a session and its
/// generation (`backup_due_refused_stale_foreign` and the argument tests in `commands/backup.rs` cover the rest).
#[test]
fn vault_backup_due_is_granted_to_the_main_window_only() {
    let cmd = "vault_backup_due";
    assert!(COMMANDS.contains(&cmd), "{cmd} is not listed");
    let capability = read_json("capabilities/main.json");
    let granted: Vec<&str> = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(granted.contains(&"allow-vault-backup-due"));
    let app = app();
    let main = main_webview(&app);
    let other = WebviewWindowBuilder::new(&app, "probe", WebviewUrl::App("index.html".into()))
        .build()
        .expect("the probe window builds");
    let body = || InvokeBody::Json(json!({ "session": 1, "generation": 1 }));
    match invoke(&main, APP_ORIGIN, cmd, body()) {
        Err(Value::String(answer)) if answer.contains("state not managed") => {}
        answer => panic!("{cmd} did not reach its handler: {answer:?}"),
    }
    assert_refused_by_acl(cmd, invoke(&other, APP_ORIGIN, cmd, body()));
    assert_refused_by_acl(cmd, invoke(&main, "https://example.com", cmd, body()));
}

/// The commands of "Test a backup" (the pick, the test, the forget) are listed, granted to the main window and reach
/// their handler from it; another window and a remote origin are refused by the ACL, before the handler. They take a
/// token, a typed credential and the page's number, and no path and no session (their bodies are checked in
/// `commands::backup`'s own tests).
#[test]
fn test_backup_commands_are_granted_to_the_main_window_only() {
    let hex = "0123456789abcdef0123456789abcdef";
    let commands = [
        ("test_backup_pick", json!({ "choice": null })),
        (
            "test_backup",
            json!({ "choice": hex, "credential": { "password_or_key": "x" }, "request": 1 }),
        ),
        ("forget_test_backup", json!({ "choice": hex })),
    ];
    let capability = read_json("capabilities/main.json");
    let granted: Vec<&str> = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let app = app();
    let main = main_webview(&app);
    let other = WebviewWindowBuilder::new(&app, "probe", WebviewUrl::App("index.html".into()))
        .build()
        .expect("the probe window builds");
    for (cmd, request) in commands {
        assert!(COMMANDS.contains(&cmd), "{cmd} is not listed");
        let permission = format!("allow-{}", cmd.replace('_', "-"));
        assert!(
            granted.contains(&permission.as_str()),
            "{permission} is not granted"
        );
        let body = || InvokeBody::Json(request.clone());
        // Past the ACL and inside the handler: this test app keeps no shell state.
        match invoke(&main, APP_ORIGIN, cmd, body()) {
            Err(Value::String(answer)) if answer.contains("state not managed") => {}
            answer => panic!("{cmd} did not reach its handler: {answer:?}"),
        }
        assert_refused_by_acl(cmd, invoke(&other, APP_ORIGIN, cmd, body()));
        assert_refused_by_acl(cmd, invoke(&main, "https://example.com", cmd, body()));
    }
}

/// The commands of "Restore a backup" (the pick, the password check, the folder, the copy, its yes, the swap, the discard
/// and the forget) are listed, granted to the main window and reach their handler from it; another window and a remote
/// origin are refused by the ACL, before the handler. They take tokens, a typed credential and the page's numbers, and no
/// path (their bodies are checked in `commands::backup`'s own tests).
#[test]
fn restore_commands_are_granted_to_the_main_window_only() {
    // Built, not written out: the review packer's key scan reads a long hex literal beside "choice" as a secret.
    let hex = "0123456789abcdef".repeat(2);
    let commands = [
        ("restore_pick", json!({ "choice": null })),
        (
            "restore_check",
            json!({ "choice": hex, "credential": { "password_or_key": "x" } }),
        ),
        ("restore_choose_folder", json!({ "choice": hex })),
        ("restore_prepare", json!({ "choice": hex, "request": 1 })),
        (
            "restore_prepare_confirm",
            json!({ "token": hex, "name": null, "request": 1 }),
        ),
        ("restore_commit", json!({ "restore": 1, "request": 2 })),
        ("restore_discard", json!({ "restore": 1 })),
        ("forget_restore_pick", json!({ "choice": hex })),
    ];
    let capability = read_json("capabilities/main.json");
    let granted: Vec<&str> = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let app = app();
    let main = main_webview(&app);
    let other = WebviewWindowBuilder::new(&app, "probe", WebviewUrl::App("index.html".into()))
        .build()
        .expect("the probe window builds");
    for (cmd, request) in commands {
        assert!(COMMANDS.contains(&cmd), "{cmd} is not listed");
        let permission = format!("allow-{}", cmd.replace('_', "-"));
        assert!(
            granted.contains(&permission.as_str()),
            "{permission} is not granted"
        );
        let body = || InvokeBody::Json(request.clone());
        // Past the ACL and inside the handler: this test app keeps no shell state.
        match invoke(&main, APP_ORIGIN, cmd, body()) {
            Err(Value::String(answer)) if answer.contains("state not managed") => {}
            answer => panic!("{cmd} did not reach its handler: {answer:?}"),
        }
        assert_refused_by_acl(cmd, invoke(&other, APP_ORIGIN, cmd, body()));
        assert_refused_by_acl(cmd, invoke(&main, "https://example.com", cmd, body()));
    }
}

/// The three job events go to the main window and no other window: a listener on the main window hears each of them with
/// exactly the frozen payload, and one on another window hears none. Widening the target to every window (`Any`) fails
/// this.
#[test]
fn progress_events_go_to_the_main_window_only() {
    let app = app();
    let main = main_webview(&app);
    let other = WebviewWindowBuilder::new(&app, "probe", WebviewUrl::App("index.html".into()))
        .build()
        .expect("the probe window builds");
    let (heard_main, heard_other) = (
        Arc::new(Mutex::new(Vec::<(String, String)>::new())),
        Arc::new(Mutex::new(Vec::<(String, String)>::new())),
    );
    for event in [JOB_STARTED_EVENT, PROGRESS_EVENT, LOCK_EPOCH_EVENT] {
        for (window, heard) in [(&main, &heard_main), (&other, &heard_other)] {
            let heard = Arc::clone(heard);
            window.listen(event, move |heard_event| {
                heard
                    .lock()
                    .unwrap()
                    .push((event.to_owned(), heard_event.payload().to_owned()));
            });
        }
    }

    let events = Events(app.handle().clone());
    let scope = JobScope::Session {
        session: SessionId(3),
        generation: 7,
    };
    events.job_started(&JobStarted {
        request: 9,
        operation: OperationId(4),
        scope,
        kind: JobKind::Import,
    });
    events.progress(&ProgressEvent {
        operation: OperationId(4),
        scope,
        kind: JobKind::Import,
        done: 1,
        total: 2,
        finished: false,
    });
    events.lock_epoch(&LockEpochEvent {
        epoch: 5,
        reason: LockReason::Manual,
    });

    let scope_json = json!({ "type": "session", "session": 3, "generation": 7 });
    let expected = [
        (
            JOB_STARTED_EVENT,
            json!({ "request": 9, "operation": 4, "scope": scope_json, "kind": "import" }),
        ),
        (
            PROGRESS_EVENT,
            json!({
                "operation": 4, "scope": scope_json, "kind": "import",
                "done": 1, "total": 2, "finished": false
            }),
        ),
        (LOCK_EPOCH_EVENT, json!({ "epoch": 5, "reason": "manual" })),
    ];
    let heard: Vec<(String, Value)> = heard_main
        .lock()
        .unwrap()
        .iter()
        .map(|(name, payload)| (name.clone(), serde_json::from_str(payload).unwrap()))
        .collect();
    let expected: Vec<(String, Value)> = expected
        .into_iter()
        .map(|(name, payload)| (name.to_owned(), payload))
        .collect();
    assert_eq!(heard, expected);
    assert!(
        heard_other.lock().unwrap().is_empty(),
        "another window heard a job event"
    );
}

#[test]
fn remote_origin_is_refused() {
    let app = app();
    let answer = invoke(
        &main_webview(&app),
        "https://example.com",
        "app_info",
        InvokeBody::Json(json!({})),
    );
    assert_refused_by_acl("app_info from https://example.com", answer);
}

#[test]
fn plugin_commands_are_refused() {
    let app = app();
    let main = main_webview(&app);
    for cmd in [
        "plugin:dialog|open",
        "plugin:fs|read_file",
        "plugin:shell|open",
        "plugin:opener|open_url",
        "plugin:http|fetch",
        "plugin:clipboard-manager|read_text",
        "plugin:webview|create_webview_window",
        "plugin:window|set_title",
        "plugin:path|resolve_directory",
    ] {
        assert_refused_by_acl(
            cmd,
            invoke(&main, APP_ORIGIN, cmd, InvokeBody::Json(json!({}))),
        );
    }
}

#[test]
fn malformed_request_answers_fixed_error() {
    let app = app();
    let main = main_webview(&app);
    for body in [
        InvokeBody::Json(json!({ "SENTINEL-7f3a": 1 })), // unknown field
        InvokeBody::Json(json!("SENTINEL-7f3a")),        // wrong type: a string, not an object
        InvokeBody::Raw(b"SENTINEL-7f3a".to_vec()),      // not JSON at all
    ] {
        let error = invoke(&main, APP_ORIGIN, "app_info", body)
            .expect_err("a malformed request is refused");
        assert_eq!(error, json!({ "code": "invalid_input", "what": "request" }));
        assert!(!error.to_string().contains("SENTINEL"));
    }
}

#[test]
fn capability_grants_exactly_the_expected_set() {
    let capability = read_json("capabilities/main.json");
    let keys: BTreeSet<&str> = capability
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        BTreeSet::from(["identifier", "description", "windows", "permissions"])
    );
    assert_eq!(capability["identifier"], "main");
    assert_eq!(capability["windows"], json!(["main"]));

    // Sorted lists, not sets, so a permission granted twice is caught too.
    let mut granted: Vec<&str> = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.as_str().expect("permissions are plain identifiers"))
        .collect();
    let mut expected = vec![
        "core:event:allow-listen".to_string(),
        "core:event:allow-unlisten".to_string(),
    ];
    expected.extend(
        COMMANDS
            .iter()
            .map(|c| format!("allow-{}", c.replace('_', "-"))),
    );
    granted.sort_unstable();
    expected.sort_unstable();
    assert_eq!(granted, expected);

    let capability_files =
        std::fs::read_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities"))
            .unwrap()
            .count();
    assert_eq!(capability_files, 1, "capabilities/ holds only main.json");
}

#[test]
fn security_config_is_pinned() {
    // The file as written...
    let config = read_json("tauri.conf.json");
    assert_eq!(
        config["identifier"],
        "io.github.sumguywhowantstobuild.lockbox"
    );
    assert_eq!(config["productName"], "Lockbox");
    assert_eq!(config["app"]["withGlobalTauri"], false);
    assert_eq!(config["app"]["windows"], json!([]));
    assert_eq!(
        config["app"]["security"],
        json!({ "csp": CSP, "freezePrototype": true }),
        "only the CSP and the frozen prototype: no devCsp, no inline capabilities, no asset protocol"
    );
    assert_eq!(config["bundle"]["active"], false);
    assert_eq!(config["build"]["devUrl"], "http://localhost:5173");
    assert!(config.get("plugins").is_none(), "no plugin configuration");
    assert!(!config.to_string().contains("remote"), "no remote access");

    // ...and as compiled into the app.
    let app = app();
    let compiled = app.config();
    assert_eq!(compiled.app.security.csp, Some(Csp::Policy(CSP.into())));
    assert!(!compiled.app.with_global_tauri);
    assert!(compiled.app.security.freeze_prototype);
    assert_eq!(
        compiled.app.security.pattern,
        PatternKind::Brownfield,
        "Tauri's isolation pattern is off by decision (2026-11-05): its sandboxed frame is reported to hang \
         every call on Windows (tauri-apps/tauri issue 16219) and its hook cannot tell the app's calls from a bad \
         package's"
    );
    assert!(compiled.app.windows.is_empty());
    assert!(compiled.app.security.capabilities.is_empty());
    assert_eq!(
        compiled.build.frontend_dist,
        Some(FrontendDist::Directory("../../ui/dist".into()))
    );
}

#[test]
fn navigation_allows_only_the_app() {
    assert!(allowed_navigation(
        &"http://tauri.localhost/index.html".parse().unwrap()
    ));
    for bad in [
        "https://example.com/",
        "http://tauri.localhost.evil.com/",
        "file:///C:/Windows/",
        "javascript:alert(1)",
        "data:text/html,x",
    ] {
        assert!(
            !allowed_navigation(&bad.parse().unwrap()),
            "{bad} was allowed"
        );
    }
}

#[cfg(dev)]
#[test]
fn dev_server_allowed_only_in_dev() {
    assert!(allowed_navigation(
        &"http://localhost:5173/".parse().unwrap()
    ));
}

#[cfg(not(dev))]
#[test]
fn dev_server_refused_in_release() {
    assert!(!allowed_navigation(
        &"http://localhost:5173/".parse().unwrap()
    ));
}
