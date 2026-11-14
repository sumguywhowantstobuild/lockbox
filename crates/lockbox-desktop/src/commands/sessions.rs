//! The session list and locking from the page.

use std::sync::Arc;

use serde::Deserialize;
use tauri::State;
use tauri::ipc::Request;

use super::{NoArgs, args, blocking};
use crate::clipboard::ClearNow;
use crate::error::ShellResult;
use crate::session::{LockReason, SessionId, SessionInfo};
use crate::shell::Shell;

#[tauri::command]
pub(super) async fn list_sessions(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Vec<SessionInfo>> {
    let NoArgs {} = args(&request)?;
    Ok(shell.sessions.list())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LockVault {
    session: SessionId,
}

/// Locks one vault. Its lock hooks run too (the clipboard clear among them), so off the async runtime.
#[tauri::command]
pub(super) async fn lock_vault(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<()> {
    let LockVault { session } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || {
        shell.sessions.lock(session, LockReason::Manual);
        Ok(())
    })
    .await
}

/// 5b's button, after the first close (every vault is locked already): see [`Shell::close_explained_ok`]. It takes no
/// session and no generation (it reads and writes no vault) and never refuses for what happened: a note that cannot be
/// saved is remembered for this run, and the answer is still `null`.
#[tauri::command]
pub(super) async fn close_explained_ok(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<()> {
    let NoArgs {} = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || {
        shell.close_explained_ok();
        Ok(())
    })
    .await
}

/// 2c's Clear now, on any copy message: takes Lockbox's last copy off the clipboard if it is still there (see
/// [`Clipboard::clear_now`](crate::clipboard::Clipboard::clear_now)). It takes no session: it reads no vault and can only
/// remove what Lockbox itself put on the clipboard.
#[tauri::command]
pub(super) async fn clear_copied(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<ClearNow> {
    let NoArgs {} = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || Ok(shell.clipboard.clear_now())).await
}

#[tauri::command]
pub(super) async fn lock_all(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<()> {
    let NoArgs {} = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || {
        shell.lock_all();
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
    use tauri::webview::InvokeRequest;
    use tauri::{App, Manager, WebviewWindow};

    use super::*;
    use crate::commands::handler;
    use crate::settings::SettingsStore;
    use crate::testing::TestShell;
    use crate::window::main_window;

    fn app_with(ts: &TestShell) -> App<MockRuntime> {
        let app = mock_builder()
            .invoke_handler(handler())
            .build(tauri::generate_context!())
            .expect("the app builds");
        assert!(app.manage(Arc::clone(&ts.shell)));
        app
    }

    /// `cmd` with `body`, sent from the main window as the real page's own origin.
    fn invoke(window: &WebviewWindow<MockRuntime>, cmd: &str, body: Value) -> Result<Value, Value> {
        let request = InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "http://tauri.localhost".parse().unwrap(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        };
        get_ipc_response(window, request).map(|body| body.deserialize().expect("a JSON answer"))
    }

    /// 2c's Clear now through the real command: "cleared" while Lockbox's copy is on the clipboard, "gone" once it
    /// isn't, and a body with anything in it refused.
    #[test]
    fn clear_copied_answers_what_it_found() {
        let ts = TestShell::new();
        let (session, generation) = ts.open_vault("Family");
        let app = app_with(&ts);
        let main = main_window(app.handle()).expect("the main window builds");
        ts.shell
            .clipboard
            .copy(
                &ts.shell.sessions,
                session,
                generation,
                zeroize::Zeroizing::new("Pw-made-up-1".to_owned()),
            )
            .unwrap();

        assert_eq!(
            invoke(&main, "clear_copied", json!({})),
            Ok(json!("cleared"))
        );
        assert_eq!(ts.clipboard.text(), None);
        assert_eq!(invoke(&main, "clear_copied", json!({})), Ok(json!("gone")));
        assert_eq!(
            invoke(&main, "clear_copied", json!({ "session": session })),
            Err(json!({ "code": "invalid_input", "what": "request" }))
        );
        // The vault's folder is removed with the test's: it must be closed first.
        ts.shell.lock_all();
    }

    /// 5b's button through the real command: it answers `null`, the note is saved, the page is told the explanation is
    /// over and the window hides. It takes no session, so the stale-generation, foreign-ID and read-only refusals of
    /// the other commands do not apply to it; it refuses only a body that is not `{}`, and says nothing about a note
    /// that could not be saved.
    #[test]
    fn close_explained_ok_answers_null_and_does_the_three_things() {
        let ts = TestShell::new();
        ts.open_vault("Family");
        ts.shell.close_window();
        assert_eq!(ts.window.hides(), 0);
        let app = app_with(&ts);
        let main = main_window(app.handle()).expect("the main window builds");

        assert_eq!(
            invoke(&main, "close_explained_ok", json!({})),
            Ok(Value::Null)
        );

        assert!(SettingsStore::load(ts.shell.paths.settings.clone()).close_explained());
        assert_eq!(
            ts.events.notices(),
            [
                json!({ "kind": "first_close", "explain": true }),
                json!({ "kind": "first_close", "explain": false })
            ]
        );
        assert_eq!(ts.window.hides(), 1);

        // A body with anything in it is a malformed request, and does nothing.
        let before = ts.events.notices().len();
        let refused = invoke(&main, "close_explained_ok", json!({ "session": 1 }));
        assert_eq!(
            refused,
            Err(json!({ "code": "invalid_input", "what": "request" }))
        );
        assert_eq!(ts.events.notices().len(), before);
        assert_eq!(ts.window.hides(), 1);
    }
}
