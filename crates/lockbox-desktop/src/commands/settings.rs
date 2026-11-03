//! The settings screen: the auto-lock idle time and the clipboard clear delay (spec §7.4).

use std::sync::Arc;

use tauri::State;
use tauri::ipc::Request;

use super::{NoArgs, args, blocking};
use crate::error::ShellResult;
use crate::settings::Settings;
use crate::shell::Shell;

/// The settings in effect.
#[tauri::command]
pub(super) async fn get_settings(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Settings> {
    let NoArgs {} = args(&request)?;
    Ok(shell.settings.get())
}

/// Saves new settings (`{ idle_minutes, clipboard_seconds }`, both always sent) and puts them in effect: the next
/// auto-lock tick uses the new idle time. A value out of bounds is refused (`InvalidInput`) and nothing changes.
#[tauri::command]
pub(super) async fn set_settings(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<()> {
    let settings: Settings = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.settings.set(settings)).await
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tauri::ipc::InvokeBody;

    use super::super::{MALFORMED, parse};
    use super::*;

    /// A field the settings do not have, a missing one, or a value its type cannot hold is a malformed request.
    #[test]
    fn set_settings_request_is_strict() {
        let body = |value| InvokeBody::Json(value);
        assert_eq!(
            parse::<Settings>(&body(json!({ "idle_minutes": 1, "clipboard_seconds": 10 }))).ok(),
            Some(Settings {
                idle_minutes: 1,
                clipboard_seconds: 10
            })
        );
        for malformed in [
            json!({ "idle_minutes": 5 }),
            json!({ "idle_minutes": 5, "clipboard_seconds": 30, "path": "C:\\" }),
            json!({ "idle_minutes": 256, "clipboard_seconds": 30 }),
            json!({ "idle_minutes": -1, "clipboard_seconds": 30 }),
            json!({ "idle_minutes": 5, "clipboard_seconds": 70000 }),
        ] {
            assert_eq!(parse::<Settings>(&body(malformed)).err(), Some(MALFORMED));
        }
    }
}
