//! Direct Windows and WebView2 calls. Every `unsafe` block of the crate is here, each with a `// SAFETY:` comment.
#![allow(unsafe_code)]

use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Controller, ICoreWebView2Controller4,
};
use windows_core::{BOOL, Interface};

/// Turns off WebView2's external drop (files dragged in from outside the app), then reads the setting back.
/// Returns `true` only when WebView2 confirms drops are off.
///
/// With Tauri's drag-and-drop handler off, wry leaves this on (it turns it off only for Tauri's own handler), and the
/// page could then read a dropped file through `event.dataTransfer.files` (spec §4.2).
pub fn turn_off_external_drop(controller: &ICoreWebView2Controller) -> bool {
    // A WebView2 runtime too old for `ICoreWebView2Controller4` cannot turn drops off: that counts as failure.
    let Ok(controller) = controller.cast::<ICoreWebView2Controller4>() else {
        return false;
    };
    let mut allowed = BOOL::from(true);
    // SAFETY: `controller` is a live COM interface, obtained by `cast` (QueryInterface) from the webview's own
    // controller, which Tauri hands us on the thread that owns the webview (`with_webview`). Both calls are plain
    // property accessors; `allowed` is a valid, writable `BOOL` for the getter.
    let confirmed = unsafe {
        controller.SetAllowExternalDrop(false).is_ok()
            && controller.AllowExternalDrop(&mut allowed).is_ok()
    };
    confirmed && !allowed.as_bool()
}
