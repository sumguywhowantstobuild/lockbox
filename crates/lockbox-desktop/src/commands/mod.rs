//! The commands the page may call. Each is `async` (Tauri runs sync commands on the main thread), takes the raw
//! request and parses it with [`args`] into a struct that refuses unknown fields.

mod args;
mod list;

pub use args::{InvalidRequest, ShellResult, args};
pub use list::COMMANDS;

use serde::{Deserialize, Serialize};
use tauri::Runtime;
use tauri::ipc::{Invoke, Request};

/// The invoke handler shared by the app (`run`) and the tests (`MockRuntime`). Every command listed here is also in
/// [`COMMANDS`], or the page could never be granted it.
pub fn handler<R: Runtime>() -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![app_info]
}

/// The body of a command that takes no arguments: `{}`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoArgs {}

#[derive(Debug, Serialize)]
pub struct AppInfo {
    pub version: String,
}

#[tauri::command]
async fn app_info(request: Request<'_>) -> ShellResult<AppInfo> {
    let NoArgs {} = args(&request)?;
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}
