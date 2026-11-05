//! Hands-on probes for the save shortcut, capture protection and print-to-PDF. They go in Task 5, with the test page they
//! serve. None has a session, so there is no generation to check; each answers a number, a yes/no or a fixed word, and
//! never the text or the path it is about.

use std::sync::Arc;

use serde::Deserialize;
use tauri::ipc::Request;
use tauri::{AppHandle, Manager, Runtime, State};

use super::{NoArgs, args, blocking};
use crate::error::{CoreErrorView, ShellError, ShellResult};
use crate::shell::{PrintForm, ProbePrintAnswer, Shell};
use crate::window;

/// How many bytes of text the last press of the save shortcut read; 0 when it read none.
#[tauri::command]
pub(super) async fn probe_capture_length(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<usize> {
    let NoArgs {} = args(&request)?;
    Ok(shell.probe_capture_length())
}

/// Empties the clipboard if it still holds what the last press read, and forgets what it read: whether it did.
#[tauri::command]
pub(super) async fn probe_clear_captured(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<bool> {
    let NoArgs {} = args(&request)?;
    let shell = Arc::clone(&shell);
    // The clipboard may be held by another program for a moment: off the async runtime.
    blocking(move || Ok(shell.probe_clear_captured())).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PrintArgs {
    /// One of [`PrintForm`]'s fixed words; any other value is the malformed-request answer.
    form: PrintForm,
}

/// Prints the test page's marked element to a PDF where Rust's own save dialog says (the page sends and receives no
/// path), through a temp file in the `form` asked for, made beside it. The answer names the form and is made of fixed
/// words and numbers. The forms are for the hands-on that decides how Task 7 writes its temp file; they go in Task 5.
#[tauri::command]
pub(super) async fn probe_print_pdf(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<ProbePrintAnswer> {
    let PrintArgs { form } = args(&request)?;
    let shell = Arc::clone(&shell);
    // A dialog and a print: both wait, so off the async runtime.
    blocking(move || Ok(shell.probe_print_pdf(form))).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CaptureArgs {
    on: bool,
}

/// Windows refused to be asked, or the window is gone. Fixed text only.
const CAPTURE_FAILED: ShellError = ShellError::Core(CoreErrorView {
    kind: "io",
    what: Some("window"),
    needed: None,
    available: None,
    max_file: None,
    min: None,
});

/// Asks for the main window to be kept out of screen captures (`on`), or to be capturable again. Whether Windows
/// obeyed is not known here (Tauri passes the request on and ignores Windows' answer): the hands-on looks at a
/// screenshot.
#[tauri::command]
pub(super) async fn probe_set_capture<R: Runtime>(
    app: AppHandle<R>,
    request: Request<'_>,
) -> ShellResult<()> {
    let CaptureArgs { on } = args(&request)?;
    let window = app.get_webview_window(window::MAIN).ok_or(CAPTURE_FAILED)?;
    window::set_capture_protection(&window, on).map_err(|_| CAPTURE_FAILED)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tauri::ipc::InvokeBody;

    use super::super::{MALFORMED, parse};
    use super::*;

    /// The print probe takes exactly one `form`, one of six fixed words, and nothing else: an unknown word, another
    /// field, a path, or a wrong type is the fixed malformed-request answer. (`tests/ipc.rs` cannot reach this: the
    /// shell state is resolved before the body is read.)
    #[test]
    fn probe_print_pdf_takes_one_known_form() {
        let forms = [
            ("new_plain", PrintForm::NewPlain),
            ("new_long", PrintForm::NewLong),
            ("existing_plain", PrintForm::ExistingPlain),
            ("existing_hidden", PrintForm::ExistingHidden),
            ("new_then_hide", PrintForm::NewThenHide),
            ("in_hidden_folder", PrintForm::InHiddenFolder),
        ];
        for (word, form) in forms {
            let body = InvokeBody::Json(json!({ "form": word }));
            assert_eq!(parse::<PrintArgs>(&body).unwrap().form, form, "{word}");
        }
        for body in [
            json!({}),
            json!({ "form": "other" }),
            json!({ "form": "NewPlain" }),
            json!({ "form": "C:\\x" }),
            json!({ "form": 3 }),
            json!({ "form": "new_plain", "path": "C:\\x" }),
            json!("new_plain"),
        ] {
            let body_text = body.to_string();
            let answer = parse::<PrintArgs>(&InvokeBody::Json(body)).err();
            assert_eq!(answer, Some(MALFORMED), "{body_text}");
        }
    }
}
