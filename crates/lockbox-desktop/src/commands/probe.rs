//! Hands-on probes for the save shortcut. They go in Task 5, with the test page they serve. Neither has a session, so
//! there is no generation to check; each answers a number or a yes/no and never the text it is about.

use std::sync::Arc;

use tauri::State;
use tauri::ipc::Request;

use super::{NoArgs, args, blocking};
use crate::error::ShellResult;
use crate::shell::Shell;

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
