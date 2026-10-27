//! Reading a command's request body. Tauri's own argument parsing answers a bad request with serde's message, which
//! can quote the value sent (a password, a path). Every command parses its body here instead, so a malformed
//! request gets one fixed answer.

use serde::de::DeserializeOwned;
use serde::ser::{Serialize, SerializeStruct, Serializer};
use tauri::ipc::{InvokeBody, Request};

/// What a command returns. Task 8 replaces `InvalidRequest` with `ShellError`, which serialises the same way.
pub type ShellResult<T> = Result<T, InvalidRequest>;

/// The answer to a malformed request: `{"code":"invalid_input","what":"request"}`, never the parser's text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidRequest;

impl Serialize for InvalidRequest {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut error = serializer.serialize_struct("InvalidRequest", 2)?;
        error.serialize_field("code", "invalid_input")?;
        error.serialize_field("what", "request")?;
        error.end()
    }
}

/// Parses the request's JSON body into `T`, a `#[serde(deny_unknown_fields)]` struct. Anything else (a field `T`
/// does not have, a wrong type, a body that is not JSON) is `InvalidRequest`.
pub fn args<T: DeserializeOwned>(request: &Request<'_>) -> ShellResult<T> {
    match request.body() {
        InvokeBody::Json(body) => T::deserialize(body).map_err(|_| InvalidRequest),
        InvokeBody::Raw(_) => Err(InvalidRequest),
    }
}
