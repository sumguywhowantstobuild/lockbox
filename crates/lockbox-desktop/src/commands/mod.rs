//! The commands the page may call. Each is `async` (Tauri runs sync commands on the main thread), takes the raw
//! request and parses it with [`args`] into a struct that refuses unknown fields.

mod args;
mod generator;
pub mod items;
mod list;
mod sessions;
pub mod vaults;

pub use args::args;
#[cfg(test)]
use args::{MALFORMED, parse};
pub use list::COMMANDS;

use serde::{Deserialize, Serialize};
use tauri::Runtime;
use tauri::ipc::{Invoke, Request};

use crate::error::{ShellError, ShellResult};

/// The invoke handler shared by the app (`run`) and the tests (`MockRuntime`). Every command listed here is also in
/// [`COMMANDS`], or the page could never be granted it.
pub fn handler<R: Runtime>() -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        app_info,
        sessions::list_sessions,
        sessions::lock_vault,
        sessions::lock_all,
        vaults::list_vaults,
        vaults::add_existing_vault,
        vaults::add_existing_vault_confirm,
        vaults::forget_vault,
        vaults::create_vault,
        vaults::create_vault_confirm,
        vaults::unlock_vault,
        vaults::recover_vault,
        vaults::recover_vault_confirm,
        vaults::change_password,
        vaults::regenerate_recovery,
        vaults::accept_header,
        items::list_items,
        items::get_item,
        items::reveal_password,
        items::new_item,
        items::update_item,
        items::trash_item,
        items::restore_item,
        items::delete_collection,
        items::purge_item,
        items::old_trash,
        items::search_all,
        items::open_url,
        items::list_orphans,
        items::delete_orphans,
        generator::generate_password,
        generator::generate_passphrase
    ]
}

/// The body of a command that takes no arguments: `{}`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoArgs {}

/// Runs `work` on Tauri's blocking pool: anything slower than a lookup stays off the async runtime.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> ShellResult<T> + Send + 'static,
) -> ShellResult<T> {
    // The pool answers an error only when `work` panicked (or the runtime is shutting down): it did not finish.
    tauri::async_runtime::spawn_blocking(work)
        .await
        .unwrap_or(Err(ShellError::Cancelled))
}

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
