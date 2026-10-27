//! The one app window. Every rule about what the webview may load, open, download or receive is set here, in
//! [`main_window`] (spec §4.2).

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// The window's label; the capability grants Lockbox's commands to this window only.
pub const MAIN: &str = "main";

/// Origins the window may show: the app's own content, plus the Vite dev server in `cargo tauri dev` builds (its
/// port is pinned in `tauri.conf.json` `devUrl` and `ui/vite.config.ts`).
#[cfg(not(dev))]
const ALLOWED_ORIGINS: &[&str] = &["http://tauri.localhost"];
#[cfg(dev)]
const ALLOWED_ORIGINS: &[&str] = &["http://tauri.localhost", "http://localhost:5173"];

/// Whether the window may navigate to `url`: only to a page of an allowed origin (same scheme, host and port).
pub fn allowed_navigation(url: &Url) -> bool {
    ALLOWED_ORIGINS
        .iter()
        .any(|allowed| Url::parse(allowed).is_ok_and(|allowed| allowed.origin() == url.origin()))
}

/// Set once WebView2 has confirmed that the main window refuses files dropped from outside the app.
static EXTERNAL_DROP_OFF: AtomicBool = AtomicBool::new(false);

/// Builds the main window. It navigates only within the app, opens no other windows, downloads nothing, keeps no
/// autofill or profile data on disk (WebView2 would otherwise store typed titles, usernames and searches), and
/// accepts no dropped files: Tauri's drag-and-drop handler is off (it would send dropped files' full paths to the
/// page), and so is WebView2's own external drop (it would hand the files to the page).
///
/// Called from the setup hook, which Tauri runs on the main thread while handling the event loop's first event. There
/// Tauri creates the window and runs the `with_webview` callback before returning, so drops are off before the event
/// loop can deliver any input to the new window. The caller checks [`external_drop_is_off`] and refuses to run
/// otherwise. (The test runtime never runs the callback.)
pub fn main_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("Lockbox")
        .on_navigation(allowed_navigation)
        .on_new_window(|_url, _features| NewWindowResponse::Deny)
        .on_download(|_webview, _event| false)
        .general_autofill_enabled(false)
        .incognito(true)
        .disable_drag_drop_handler()
        .build()?;
    window.with_webview(|webview| {
        let off = crate::os::win::turn_off_external_drop(&webview.controller());
        EXTERNAL_DROP_OFF.store(off, Ordering::SeqCst);
    })?;
    Ok(window)
}

/// Whether WebView2 confirmed that the main window refuses external file drops.
pub fn external_drop_is_off() -> bool {
    EXTERNAL_DROP_OFF.load(Ordering::SeqCst)
}

/// Brings the main window to the front (a second copy of the app was started).
pub fn bring_to_front<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN) {
        // Best effort: if the window is closing there is nothing to bring forward.
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
