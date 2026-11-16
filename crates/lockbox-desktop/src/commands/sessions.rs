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

/// `close_answer`: the one field, and nothing else (no session, no generation, no reason: the shell knows which question
/// it asked).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CloseAnswer {
    go: bool,
}

/// The answer to the close or Quit question ([`Shell::close_answer`]): `go` runs the old path (cancel the jobs, then lock
/// and hide, or Quit), `go: false` changes nothing; either answer uses the question up. Refused as `not_found` when none
/// is pending (never asked, already answered, or cleared by a lock of all vaults). It takes no session and no generation
/// (it reads and writes no vault). On the blocking pool: the close path waits for the lock hooks.
#[tauri::command]
pub(super) async fn close_answer(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<()> {
    let CloseAnswer { go } = args(&request)?;
    // Claimed here, when the answer arrives, not inside the blocking task: work queued behind other work must still
    // belong to the question it answered, never to one asked after it ([`Shell::claim_close_answer`]).
    let question = shell.claim_close_answer()?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.answer_claimed(question, go)).await
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

    /// The question's answer through the real command (Task 12): `null` for both answers, and the old close runs only on
    /// `go: true`. It takes no session and no generation (it reads and writes no vault), so the stale-generation,
    /// foreign-ID and read-only refusals of the other commands do not apply; it refuses what has no question pending
    /// (never asked, already answered, or cleared by a lock of all vaults) as `not_found`, and any body that is not
    /// exactly `{ go: boolean }` as a malformed request, before anything runs.
    #[test]
    fn close_answer_answers_null_and_refuses_when_no_question_is_pending() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        let (session, _) = ts.open_vault("Family");
        let token = lockbox_core::blob::CancelToken::new();
        let _job =
            ts.shell
                .autolock
                .begin(Some(session), crate::jobs::JobKind::Import, token.clone());
        let app = app_with(&ts);
        let main = main_window(app.handle()).expect("the main window builds");
        let not_found = Err(json!({ "code": "not_found" }));

        // No question pending: refused either way, and nothing runs.
        assert_eq!(
            invoke(&main, "close_answer", json!({ "go": true })),
            not_found
        );
        assert_eq!(
            invoke(&main, "close_answer", json!({ "go": false })),
            not_found
        );
        assert_eq!(ts.window.hides(), 0);
        assert!(!token.is_cancelled());

        // A malformed body does nothing, and leaves the question pending.
        ts.shell.close_or_ask();
        for bad in [
            json!({}),
            json!({ "go": "yes" }),
            json!({ "go": 1 }),
            json!({ "go": null }),
            json!({ "go": true, "session": 1 }),
            json!({ "go": true, "generation": 1 }),
            json!({ "go": true, "reason": "quit" }),
        ] {
            assert_eq!(
                invoke(&main, "close_answer", bad.clone()),
                Err(json!({ "code": "invalid_input", "what": "request" })),
                "{bad}"
            );
        }
        assert!(!token.is_cancelled());
        assert_eq!(ts.window.hides(), 0);

        // Keep it running: `null`, nothing changed, the question used up.
        assert_eq!(
            invoke(&main, "close_answer", json!({ "go": false })),
            Ok(Value::Null)
        );
        assert!(!token.is_cancelled());
        assert_eq!(ts.window.hides(), 0);
        assert_eq!(
            invoke(&main, "close_answer", json!({ "go": false })),
            not_found
        );

        // Close anyway: `null`, the job cancelled, the vault locked, the window hidden; a second answer is refused.
        ts.shell.close_or_ask();
        assert_eq!(
            invoke(&main, "close_answer", json!({ "go": true })),
            Ok(Value::Null)
        );
        assert!(token.is_cancelled());
        assert_eq!(ts.window.hides(), 1);
        assert_eq!(
            ts.shell.sessions.list()[0].state,
            crate::session::SessionState::Locked
        );
        assert_eq!(
            invoke(&main, "close_answer", json!({ "go": true })),
            not_found
        );
        assert_eq!(ts.events.close_asked().len(), 2);
    }
}
