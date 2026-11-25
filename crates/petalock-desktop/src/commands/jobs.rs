//! The page's Stop for a long job.

use std::sync::Arc;

use serde::Deserialize;
use tauri::State;
use tauri::ipc::Request;

use super::args;
use crate::error::ShellResult;
use crate::jobs::{JobScope, OperationId};
use crate::shell::Shell;

/// `cancel_operation`: the job to stop and the scope the page saw it in, nothing else.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CancelOperation {
    operation: OperationId,
    scope: JobScope,
}

/// Stops one job, and no other. Refused as `Locked` when its scope has gone, `NotFound` when it is not running in that
/// scope (another scope's, finished, or never started): the page shows neither, since the job is over or ends with its
/// own answer. A lookup and a flag, so it needs no blocking thread.
#[tauri::command]
pub(super) async fn cancel_operation(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<()> {
    let CancelOperation { operation, scope } = args(&request)?;
    shell.autolock.cancel_operation(operation, scope)
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use tauri::ipc::InvokeBody;

    use super::super::{MALFORMED, parse};
    use super::*;
    use crate::session::SessionId;

    fn parses(body: Value) -> ShellResult<CancelOperation> {
        parse::<CancelOperation>(&InvokeBody::Json(body))
    }

    /// The body the frozen connection names: an operation and its scope, nothing else.
    #[test]
    fn cancel_operation_takes_an_operation_and_a_scope_only() {
        let session = json!({ "type": "session", "session": 1, "generation": 2 });
        let launch = json!({ "type": "launch", "epoch": 3 });
        let CancelOperation { operation, scope } =
            parses(json!({ "operation": 4, "scope": session })).unwrap();
        assert_eq!(operation, OperationId(4));
        assert_eq!(
            scope,
            JobScope::Session {
                session: SessionId(1),
                generation: 2
            }
        );
        let parsed = parses(json!({ "operation": 4, "scope": launch })).unwrap();
        assert_eq!(parsed.scope, JobScope::Launch { epoch: 3 });

        for bad in [
            json!({}),
            json!({ "operation": 4 }),
            json!({ "scope": launch }),
            json!({ "operation": "4", "scope": launch }),
            json!({ "operation": -4, "scope": launch }),
            json!({ "operation": 4, "scope": launch, "path": "SENTINEL-7f3a" }),
            json!({ "operation": 4, "scope": { "type": "launch", "epoch": 3, "path": "x" } }),
            json!({ "operation": 4, "scope": { "type": "launch" } }),
            json!({ "operation": 4, "scope": "launch" }),
        ] {
            assert_eq!(parses(bad.clone()).err(), Some(MALFORMED), "{bad}");
        }
    }
}
