//! The session list and locking from the page.

use std::sync::Arc;

use serde::Deserialize;
use tauri::State;
use tauri::ipc::Request;

use super::{NoArgs, args, blocking};
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

#[tauri::command]
pub(super) async fn lock_all(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<()> {
    let NoArgs {} = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || {
        shell.sessions.lock_all(LockReason::Manual);
        Ok(())
    })
    .await
}
