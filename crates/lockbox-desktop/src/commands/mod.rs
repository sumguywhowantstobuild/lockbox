//! The commands the page may call. Each is `async` (Tauri runs sync commands on the main thread), takes the raw
//! request and parses it with [`args`] into a struct that refuses unknown fields.

mod args;
pub mod backup;
pub mod files;
mod generator;
pub mod items;
mod list;
mod sessions;
mod settings;
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
        launch_notices,
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
        items::copy_field,
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
        files::save_file_copy,
        files::add_file,
        files::attach_file,
        files::replace_file,
        files::open_file,
        files::retry_open_cleanup,
        files::reset_output_journal,
        backup::backup_vault,
        backup::test_backup,
        backup::open_backup_read_only,
        backup::copy_item_to,
        backup::restore_prepare,
        backup::restore_prepare_confirm,
        backup::restore_commit,
        backup::restore_discard,
        backup::restore_notice,
        backup::retry_restore_recovery,
        backup::dismiss_restore,
        backup::list_pre_restore,
        backup::delete_pre_restore,
        backup::open_pre_restore_read_only,
        generator::generate_password,
        generator::generate_passphrase,
        settings::get_settings,
        settings::set_settings
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

/// What launch found that the page should show (the output sweep's counts, opened copies it could not remove): kept by
/// the shell, since launch work runs before the page listens for `lockbox://notice`. The page asks once it has loaded.
#[tauri::command]
async fn launch_notices(
    shell: tauri::State<'_, std::sync::Arc<crate::shell::Shell>>,
    request: Request<'_>,
) -> ShellResult<Vec<crate::session::Notice>> {
    let NoArgs {} = args(&request)?;
    Ok(shell.launch_notices())
}
