//! Reading a command's request body. Tauri's own argument parsing answers a bad request with serde's message, which
//! can quote the value sent (a password, a path). Every command parses its body here instead, so a malformed
//! request gets one fixed answer.

use serde::de::DeserializeOwned;
use tauri::ipc::{InvokeBody, Request};

use crate::error::{ShellError, ShellResult};

/// The answer to a malformed request: `{"code":"invalid_input","what":"request"}`, never the parser's text.
const MALFORMED: ShellError = ShellError::InvalidInput { what: "request" };

/// Parses the request's JSON body into `T`, a `#[serde(deny_unknown_fields)]` struct. Anything else (a field `T`
/// does not have, a wrong type, a body that is not JSON) is [`MALFORMED`].
pub fn args<T: DeserializeOwned>(request: &Request<'_>) -> ShellResult<T> {
    match request.body() {
        InvokeBody::Json(body) => T::deserialize(body).map_err(|_| MALFORMED),
        InvokeBody::Raw(_) => Err(MALFORMED),
    }
}
