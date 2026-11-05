//! The one app window. Every rule about what the webview may load, open, download or receive is set here, in
//! [`main_window`] (spec §4.2).

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller;

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

/// Builds the main window, hidden. It navigates only within the app, opens no other windows, downloads nothing, keeps
/// no autofill or profile data on disk (WebView2 would otherwise store typed titles, usernames and searches), and
/// accepts no dropped files: Tauri's drag-and-drop handler is off (it would send dropped files' full paths to the
/// page), and so is WebView2's own external drop (it would hand the files to the page).
///
/// The settings that need the webview itself (external drop, the browser keys and the default context menu, capture
/// protection) are applied after the window exists, and only then is it shown: the caller runs [`show_main_window`]
/// right after, inside the setup hook, and ends the app when it answers [`StayedHidden`]. The window is hidden until
/// then, so nothing can be seen or pressed in a window whose protections are not in place. (The test runtime never
/// runs a webview callback, so the order and the refusal are tested through [`show_when_locked_down`] with a fake, and
/// the real window by review and by hand.)
pub fn main_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("Lockbox")
        .visible(false)
        .on_navigation(allowed_navigation)
        .on_new_window(|_url, _features| NewWindowResponse::Deny)
        .on_download(|_webview, _event| false)
        .general_autofill_enabled(false)
        .incognito(true)
        .disable_drag_drop_handler()
        .build()
}

/// Whether WebView2 confirmed that the main window refuses external file drops.
pub fn external_drop_is_off() -> bool {
    EXTERNAL_DROP_OFF.load(Ordering::SeqCst)
}

/// Keeps the window's contents out of screenshots, recordings and screen sharing (`on`), or lets them be captured
/// (Tauri's `set_content_protected`, which asks Windows for `WDA_EXCLUDEFROMCAPTURE`). `Ok` means the request was
/// made: Tao calls `SetWindowDisplayAffinity` and throws its result away, so Windows' own answer is not available.
pub fn set_capture_protection<R: Runtime>(
    window: &WebviewWindow<R>,
    on: bool,
) -> tauri::Result<()> {
    window.set_content_protected(on)
}

/// What the start of the main window does to a window that is still hidden, behind a seam so the order of the steps is
/// tested with a fake that records it ([`show_when_locked_down`]). The real one is [`RealSteps`].
pub trait WindowSteps {
    /// Keeps the window out of screen captures (`on`), or lets it be captured.
    fn protect_from_capture(&self, on: bool) -> tauri::Result<()>;
    /// Turns off the page's file drops; true only when WebView2 confirmed it.
    fn turn_off_external_drop(&self) -> bool;
    /// Turns off the browser's keys and its context menu; true only when WebView2 confirmed it.
    fn turn_off_browser_keys(&self) -> bool;
    fn show(&self) -> tauri::Result<()>;
}

/// The window was left hidden: a protection that must hold did not, or it could not be shown.
#[derive(Debug, PartialEq, Eq)]
pub struct StayedHidden;

/// Shows the hidden main window once it is ready, and not before: capture protection first, then the two settings that
/// must hold (no dropped files, no browser keys or menu), and only if both are confirmed, the show. A refusal leaves
/// the window hidden, and the caller ends the app (fail closed, as external drop does).
///
/// Capture protection is not one of those: the design treats it as a setting and "not a guarantee", and Windows' own
/// answer is thrown away below Tauri (`SetWindowDisplayAffinity` is called with its result ignored), so a failure
/// seen here is only a window that could not be asked. The window still shows.
pub fn show_when_locked_down(
    steps: &impl WindowSteps,
    capture_protected: bool,
) -> Result<(), StayedHidden> {
    let capture = steps.protect_from_capture(capture_protected);
    if cfg!(debug_assertions) && capture.is_err() {
        eprintln!("Lockbox debug: the window could not be asked for capture protection");
    }
    // Both are tried, so one failing does not hide that the other did too.
    let drop_off = steps.turn_off_external_drop();
    let keys_off = steps.turn_off_browser_keys();
    if !(drop_off && keys_off) {
        return Err(StayedHidden);
    }
    steps.show().map_err(|_| StayedHidden)
}

/// Whether capture protection is on when the window first shows. On until the capture setting exists (the design
/// decides its default after the hands-on check in Magnifier, Quick Assist and remote desktop).
pub const CAPTURE_PROTECTED_AT_START: bool = true;

/// Shows the main window, which [`main_window`] left hidden, through [`show_when_locked_down`] on the real window. Call
/// it on the main thread, in the setup hook (the webview's settings are changed by a callback that runs there at once;
/// from another thread the answer is "not off", and the window stays hidden). When it answers [`StayedHidden`], the
/// caller ends the app; [`external_drop_is_off`] and [`browser_keys_are_off`] say which setting was not confirmed.
pub fn show_main_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), StayedHidden> {
    show_when_locked_down(&RealSteps { window }, CAPTURE_PROTECTED_AT_START)
}

/// The steps on the real window. The test runtime never runs a webview callback, so these are checked by review and
/// by hand.
struct RealSteps<'a, R: Runtime> {
    window: &'a WebviewWindow<R>,
}

impl<R: Runtime> WindowSteps for RealSteps<'_, R> {
    fn protect_from_capture(&self, on: bool) -> tauri::Result<()> {
        set_capture_protection(self.window, on)
    }

    fn turn_off_external_drop(&self) -> bool {
        in_webview(
            self.window,
            &EXTERNAL_DROP_OFF,
            crate::os::win::turn_off_external_drop,
        )
    }

    fn turn_off_browser_keys(&self) -> bool {
        in_webview(
            self.window,
            &BROWSER_KEYS_OFF,
            crate::os::win::turn_off_browser_keys,
        )
    }

    fn show(&self) -> tauri::Result<()> {
        self.window.show()
    }
}

/// Runs `turn_off` on the window's WebView2 controller and keeps what it confirmed in `confirmed`. Starts as "not
/// confirmed", and stays so when the callback did not run before this returns or the window could not be reached.
fn in_webview<R: Runtime>(
    window: &WebviewWindow<R>,
    confirmed: &'static AtomicBool,
    turn_off: fn(&ICoreWebView2Controller) -> bool,
) -> bool {
    confirmed.store(false, Ordering::SeqCst);
    let queued = window.with_webview(move |webview| {
        confirmed.store(turn_off(&webview.controller()), Ordering::SeqCst);
    });
    queued.is_ok() && confirmed.load(Ordering::SeqCst)
}

/// Set once WebView2 has confirmed that the main window's browser keys (Ctrl+P, F12, F5 and the rest) and its default
/// context menu are off.
static BROWSER_KEYS_OFF: AtomicBool = AtomicBool::new(false);

/// Whether WebView2 confirmed that the main window's browser keys and default context menu are off.
pub fn browser_keys_are_off() -> bool {
    BROWSER_KEYS_OFF.load(Ordering::SeqCst)
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

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    /// A window that records each step in the order it was taken, and answers as the test says.
    struct FakeSteps {
        events: RefCell<Vec<String>>,
        capture_set: bool,
        drop_off: bool,
        keys_off: bool,
        shows: bool,
    }

    impl Default for FakeSteps {
        fn default() -> FakeSteps {
            FakeSteps {
                events: RefCell::default(),
                capture_set: true,
                drop_off: true,
                keys_off: true,
                shows: true,
            }
        }
    }

    impl FakeSteps {
        fn events(&self) -> Vec<String> {
            self.events.borrow().clone()
        }

        fn note(&self, event: &str) {
            self.events.borrow_mut().push(event.to_owned());
        }
    }

    impl WindowSteps for FakeSteps {
        fn protect_from_capture(&self, on: bool) -> tauri::Result<()> {
            self.note(&format!("capture {on}"));
            match self.capture_set {
                true => Ok(()),
                false => Err(std::io::Error::other("no window").into()),
            }
        }

        fn turn_off_external_drop(&self) -> bool {
            self.note("drop off");
            self.drop_off
        }

        fn turn_off_browser_keys(&self) -> bool {
            self.note("keys off");
            self.keys_off
        }

        fn show(&self) -> tauri::Result<()> {
            self.note("show");
            match self.shows {
                true => Ok(()),
                false => Err(std::io::Error::other("no window").into()),
            }
        }
    }

    fn position(events: &[String], event: &str) -> usize {
        events
            .iter()
            .position(|seen| seen == event)
            .unwrap_or_else(|| panic!("{event:?} never happened: {events:?}"))
    }

    /// Capture protection and both settings are all in place before the window is shown, and the show is the last
    /// step; the person's choice of protection (on or off) is what is applied.
    #[test]
    fn window_sequence_protects_before_showing() {
        for on in [true, false] {
            let steps = FakeSteps::default();
            assert_eq!(show_when_locked_down(&steps, on), Ok(()));
            let events = steps.events();
            assert_eq!(events.len(), 4, "{events:?}");
            let show = position(&events, "show");
            assert_eq!(show, events.len() - 1, "{events:?}");
            for before in [&format!("capture {on}"), "drop off", "keys off"] {
                assert!(position(&events, before) < show, "{before}: {events:?}");
            }
        }
    }

    /// The window stays hidden when the browser keys and menu, or the file drop, could not be confirmed off: the show
    /// never happens (the app then refuses to run).
    #[test]
    fn window_sequence_never_shows_if_keys_stay_on() {
        for (drop_off, keys_off) in [(true, false), (false, true), (false, false)] {
            let steps = FakeSteps {
                drop_off,
                keys_off,
                ..FakeSteps::default()
            };
            assert_eq!(
                show_when_locked_down(&steps, true),
                Err(StayedHidden),
                "drop {drop_off}, keys {keys_off}"
            );
            let events = steps.events();
            assert!(
                !events.iter().any(|event| event == "show"),
                "shown with drop {drop_off}, keys {keys_off}: {events:?}"
            );
            // Both were tried: one failing does not skip the other.
            position(&events, "drop off");
            position(&events, "keys off");
        }
    }

    /// Capture protection is a setting, not a guarantee: a window that cannot be asked for it still shows, and the
    /// settings that must hold are still turned off.
    #[test]
    fn window_sequence_shows_when_capture_protection_cannot_be_set() {
        let steps = FakeSteps {
            capture_set: false,
            ..FakeSteps::default()
        };
        assert_eq!(show_when_locked_down(&steps, true), Ok(()));
        assert_eq!(
            steps.events(),
            ["capture true", "drop off", "keys off", "show"]
        );
    }

    /// A window that cannot be shown is reported as left hidden.
    #[test]
    fn window_sequence_reports_a_window_that_cannot_be_shown() {
        let steps = FakeSteps {
            shows: false,
            ..FakeSteps::default()
        };
        assert_eq!(show_when_locked_down(&steps, true), Err(StayedHidden));
    }
}
