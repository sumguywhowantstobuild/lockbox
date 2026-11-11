//! The one app window. Every rule about what the webview may load, open, download or receive is set here, in
//! [`main_window`] (spec §4.2).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller;

use crate::shell::Shell;

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

/// The size the window opens at, in logical pixels (width, height): the design's 1280 by 800.
pub const WINDOW_SIZE: (f64, f64) = (1280.0, 800.0);
/// The size below which the window cannot be made: the design's 960 by 460, so a 200% screen still fits it.
pub const MIN_WINDOW_SIZE: (f64, f64) = (960.0, 460.0);

/// Set once WebView2 has confirmed that the main window refuses files dropped from outside the app.
static EXTERNAL_DROP_OFF: AtomicBool = AtomicBool::new(false);

/// Builds the main window, hidden. It navigates only within the app, opens no other windows, downloads nothing, keeps
/// no autofill or profile data on disk (WebView2 would otherwise store typed titles, usernames and searches), and
/// accepts no dropped files: Tauri's drag-and-drop handler is off (it would send dropped files' full paths to the
/// page), and so is WebView2's own external drop (it would hand the files to the page).
///
/// The settings that need the webview itself (external drop, the browser keys and the default context menu, capture
/// protection) are applied after the window exists, and only then is it shown: the caller runs [`start_main_window`]
/// right after, inside the setup hook, and ends the app when it answers [`StayedHidden`]. The window is hidden until
/// then (and stays hidden for a launch that asked for it), so nothing can be seen or pressed in a window whose
/// protections are not in place. (The test runtime never
/// runs a webview callback, so the order and the refusal are tested through [`show_when_locked_down`] with a fake, and
/// the real window by review and by hand.)
pub fn main_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("Lockbox")
        .inner_size(WINDOW_SIZE.0, WINDOW_SIZE.1)
        .min_inner_size(MIN_WINDOW_SIZE.0, MIN_WINDOW_SIZE.1)
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
    /// Restores the window from the taskbar when it was minimized. Best effort.
    fn unminimize(&self);
    /// Gives the window the keyboard focus. Best effort.
    fn focus(&self);
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
    lock_down(steps, capture_protected)?;
    steps.show().map_err(|_| StayedHidden)
}

/// The protections of [`show_when_locked_down`] without the show: capture protection as asked, then the two settings that
/// must hold, both tried, and a refusal of either is [`StayedHidden`].
fn lock_down(steps: &impl WindowSteps, capture_protected: bool) -> Result<(), StayedHidden> {
    let capture = steps.protect_from_capture(capture_protected);
    if cfg!(debug_assertions) && capture.is_err() {
        eprintln!("Lockbox debug: the window could not be asked for capture protection");
    }
    // Both are tried, so one failing does not hide that the other did too.
    let drop_off = steps.turn_off_external_drop();
    let keys_off = steps.turn_off_browser_keys();
    match drop_off && keys_off {
        true => Ok(()),
        false => Err(StayedHidden),
    }
}

/// What the first start does with the window [`main_window`] built hidden, behind the same seam
/// ([`WindowSteps`]): shows it ([`show_when_locked_down`]), or, when the launch asked to stay hidden
/// ([`startup::hidden_launch`](crate::startup::hidden_launch): Start with Windows), puts the same protections in place and
/// leaves it hidden in the tray. Capture protection is the setting
/// ([`Settings::capture_protected`](crate::settings::Settings::capture_protected)), read here.
///
/// The argument only ever affects whether the window shows: the protections are the same, a window whose protections
/// cannot be confirmed is [`StayedHidden`] either way, and a hidden start seals the sessions' window gate as the close
/// to the tray does, until the window is brought forward ([`bring_forward`] lifts it). Launch work and its notices are
/// not this function's: they run as for a visible start, and the notices wait in the shell for the page to ask.
pub fn start_window(
    steps: &impl WindowSteps,
    shell: &Shell,
    hidden: bool,
) -> Result<(), StayedHidden> {
    let capture_protected = shell.settings.get().capture_protected;
    if !hidden {
        return show_when_locked_down(steps, capture_protected);
    }
    lock_down(steps, capture_protected)?;
    shell.sessions.seal();
    Ok(())
}

/// [`start_window`] on the real window, which [`main_window`] left hidden. Call it on the main thread, in the setup hook
/// (the webview's settings are changed by a callback that runs there at once; from another thread the answer is "not
/// off", and the window stays hidden). When it answers [`StayedHidden`], the caller ends the app;
/// [`external_drop_is_off`] and [`browser_keys_are_off`] say which setting was not confirmed.
pub fn start_main_window<R: Runtime>(
    window: &WebviewWindow<R>,
    shell: &Shell,
    hidden: bool,
) -> Result<(), StayedHidden> {
    start_window(&RealSteps { window }, shell, hidden)
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

    fn unminimize(&self) {
        let _ = self.window.unminimize();
    }

    fn focus(&self) {
        let _ = self.window.set_focus();
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

/// Shows the main window again and brings it forward: a second copy of the app was started, or "Open Lockbox" was chosen
/// in the tray. The same steps as the first show ([`show_when_locked_down`]), so the window's protections are confirmed
/// again before it can be seen: a window that stays hidden is not shown, restored or focused.
///
/// Capture protection is the setting as it is now
/// ([`Settings::capture_protected`](crate::settings::Settings::capture_protected), read from `shell`).
///
/// Once the window shows, `shell` is told ([`Shell::window_shown`]): the gate that refused every unlock while the window
/// was hidden is lifted. A window that stays hidden keeps it shut.
pub fn bring_forward(steps: &impl WindowSteps, shell: &Shell) -> Result<(), StayedHidden> {
    show_when_locked_down(steps, shell.settings.get().capture_protected)?;
    shell.window_shown();
    steps.unminimize();
    steps.focus();
    Ok(())
}

/// [`bring_forward`] on the real window (the one way back from the tray, for the second launch and "Open Lockbox").
/// Call it on the main thread, as [`start_main_window`] must be. Nothing happens when the window is gone, or when it
/// stays hidden (the person can still Quit from the tray).
pub fn bring_to_front<R: Runtime>(app: &AppHandle<R>) {
    // No shell (a failed start): no window to bring back either.
    let (Some(window), Some(shell)) = (app.get_webview_window(MAIN), app.try_state::<Arc<Shell>>())
    else {
        return;
    };
    let _ = bring_forward(&RealSteps { window: &window }, &shell);
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use zeroize::Zeroizing;

    use super::*;
    use crate::testing::{TEST_PASSWORD, TestShell, heavy};

    /// The design: the window opens at 1280 by 800 and cannot go below 960 by 460 (so a 200% screen still fits). The
    /// real window's size is checked by hand: the test runtime keeps no window size.
    #[test]
    fn window_size_constants_match_the_design() {
        assert_eq!(WINDOW_SIZE, (1280.0, 800.0));
        assert_eq!(MIN_WINDOW_SIZE, (960.0, 460.0));
        assert!(WINDOW_SIZE.0 >= MIN_WINDOW_SIZE.0 && WINDOW_SIZE.1 >= MIN_WINDOW_SIZE.1);
    }

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

        fn unminimize(&self) {
            self.note("unminimize");
        }

        fn focus(&self) {
            self.note("focus");
        }
    }

    /// A second launch, and the tray's "Open Lockbox", bring a hidden window back through the same steps as the first
    /// show: capture protection, no file drops and no browser keys first, and only then the show, the restore from the
    /// taskbar and the focus.
    #[test]
    fn second_launch_shows_the_hidden_window() {
        let steps = FakeSteps::default();
        let ts = TestShell::new();
        assert_eq!(bring_forward(&steps, &ts.shell), Ok(()));
        assert_eq!(
            steps.events(),
            [
                "capture true",
                "drop off",
                "keys off",
                "show",
                "unminimize",
                "focus"
            ]
        );
    }

    /// A window whose protections cannot be confirmed stays hidden when asked for again: nothing is shown, restored or
    /// focused.
    #[test]
    fn second_launch_never_shows_a_window_whose_protections_are_unconfirmed() {
        let ts = TestShell::new();
        for (drop_off, keys_off, shows) in [
            (false, true, true),
            (true, false, true),
            (false, false, true),
            (true, true, false),
        ] {
            let steps = FakeSteps {
                drop_off,
                keys_off,
                shows,
                ..FakeSteps::default()
            };
            assert_eq!(bring_forward(&steps, &ts.shell), Err(StayedHidden));
            let events = steps.events();
            for after in ["unminimize", "focus"] {
                assert!(
                    !events.iter().any(|event| event == after),
                    "{after} after a refusal: {events:?}"
                );
            }
            if !(drop_off && keys_off) {
                assert!(!events.iter().any(|event| event == "show"), "{events:?}");
            }
        }
    }

    /// While the window is hidden no unlock is accepted. Showing it again (Open Lockbox, a second launch) lifts that
    /// once the window is shown, and not before: a window that stays hidden keeps refusing.
    #[test]
    fn showing_the_window_again_lifts_the_refusal_of_unlocks() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        ts.shell.close_window();
        assert_eq!(ts.window.hides(), 1);
        let refused = |name: &str| {
            let password = Zeroizing::new(TEST_PASSWORD.to_owned());
            heavy(|| ts.shell.create_vault(name.into(), password, false)).is_err()
        };
        assert!(refused("Hidden"), "a vault opened with the window hidden");

        let stays_hidden = FakeSteps {
            keys_off: false,
            ..FakeSteps::default()
        };
        assert_eq!(bring_forward(&stays_hidden, &ts.shell), Err(StayedHidden));
        assert!(
            refused("Still hidden"),
            "lifted by a window that stayed hidden"
        );

        assert_eq!(bring_forward(&FakeSteps::default(), &ts.shell), Ok(()));
        let (session, _) = ts.open_vault("Shown");
        assert!(
            ts.shell
                .sessions
                .list()
                .iter()
                .any(|s| s.session == session && s.state == crate::session::SessionState::Unlocked)
        );
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

    /// Whether a person's unlock is refused now (the window gate is sealed): a vault made with the window hidden.
    fn unlock_is_refused(ts: &TestShell, name: &str) -> bool {
        let password = Zeroizing::new(TEST_PASSWORD.to_owned());
        heavy(|| ts.shell.create_vault(name.into(), password, false)).is_err()
    }

    /// `--hidden` only ever changes whether the window shows: every protection is put in place the same way and in the
    /// same order, a window whose protections cannot be confirmed is left hidden (and the app ends) whether it was to
    /// show or not, and the one difference is the missing show. Nothing is restored or focused, and the sessions' gate
    /// stays sealed, as when the window hides to the tray, until the window is brought forward.
    #[test]
    fn hidden_argument_only_affects_visibility() {
        for capture in [true, false] {
            let ts = TestShell::new();
            let settings = crate::settings::Settings {
                capture_protected: capture,
                ..ts.shell.settings.get()
            };
            ts.shell.set_settings(settings).unwrap();
            let protect = format!("capture {capture}");

            let shown = FakeSteps::default();
            assert_eq!(start_window(&shown, &ts.shell, false), Ok(()));
            assert_eq!(
                shown.events(),
                [protect.as_str(), "drop off", "keys off", "show"]
            );
            let (visible, _) = ts.open_vault("Visible");
            assert!(
                ts.shell
                    .sessions
                    .list()
                    .iter()
                    .any(|s| s.session == visible),
                "a visible start sealed the gate"
            );

            let ts = TestShell::new();
            ts.shell.set_settings(settings).unwrap();
            let hidden = FakeSteps::default();
            assert_eq!(start_window(&hidden, &ts.shell, true), Ok(()));
            assert_eq!(
                hidden.events(),
                [protect.as_str(), "drop off", "keys off"],
                "the same steps, without the show"
            );
            assert_eq!(ts.window.forwards(), 0);
            assert_eq!(ts.window.hides(), 0);
            assert!(unlock_is_refused(&ts, "Hidden"), "a hidden window unlocked");

            // The window is brought forward (Open Lockbox): shown, and unlocks are accepted again.
            let later = FakeSteps::default();
            assert_eq!(bring_forward(&later, &ts.shell), Ok(()));
            assert_eq!(
                later.events(),
                [
                    protect.as_str(),
                    "drop off",
                    "keys off",
                    "show",
                    "unminimize",
                    "focus"
                ]
            );
            let (session, _) = ts.open_vault("Shown");
            assert!(
                ts.shell
                    .sessions
                    .list()
                    .iter()
                    .any(|s| s.session == session)
            );
        }

        // Protections that cannot be confirmed are refused alike, shown or not, and the show never happens.
        for (drop_off, keys_off) in [(true, false), (false, true), (false, false)] {
            for hidden in [false, true] {
                let ts = TestShell::new();
                let steps = FakeSteps {
                    drop_off,
                    keys_off,
                    ..FakeSteps::default()
                };
                assert_eq!(
                    start_window(&steps, &ts.shell, hidden),
                    Err(StayedHidden),
                    "drop {drop_off}, keys {keys_off}, hidden {hidden}"
                );
                let events = steps.events();
                assert!(!events.iter().any(|event| event == "show"), "{events:?}");
                position(&events, "drop off");
                position(&events, "keys off");
            }
        }
    }

    /// What launch found waits for the page, whether the window shows or not: the notices are kept by the shell (not used
    /// up by being asked for), sent as events too, and a hidden start shows nothing and brings nothing forward. The page
    /// asks when it loads, and again after a reload, and hears the same each time, also after the window is shown.
    #[test]
    fn launch_notices_wait_for_the_window() {
        let ts = TestShell::new();
        ts.hotkey.refuse_next(crate::os::HotkeyTaken::Taken);
        ts.shell.register_save_shortcut();
        let steps = FakeSteps::default();
        assert_eq!(start_window(&steps, &ts.shell, true), Ok(()));
        assert!(!steps.events().iter().any(|event| event == "show"));
        assert_eq!(ts.window.forwards(), 0, "a hidden start brought it forward");

        let told = serde_json::json!({ "kind": "shortcut_taken" });
        let kept = |ts: &TestShell| {
            ts.shell
                .launch_notices()
                .iter()
                .map(|notice| serde_json::to_value(notice).unwrap())
                .collect::<Vec<_>>()
        };
        let once = std::slice::from_ref(&told);
        assert_eq!(kept(&ts), once, "kept for the page that asks");
        assert_eq!(kept(&ts), once, "asked for again after a reload");
        assert_eq!(ts.events.notices(), once);

        assert_eq!(bring_forward(&FakeSteps::default(), &ts.shell), Ok(()));
        assert_eq!(kept(&ts), once, "used up by the window's show");
        assert_eq!(ts.events.notices(), once, "told a second time");
    }

    /// Capture protection is the setting, read when the window first starts and every time it is brought forward, not a
    /// constant: off in the settings, the window is asked for "off"; on again, for "on".
    #[test]
    fn capture_follows_the_setting_when_the_window_shows() {
        let ts = TestShell::new();
        let steps = FakeSteps::default();
        assert_eq!(start_window(&steps, &ts.shell, false), Ok(()));
        assert_eq!(steps.events()[0], "capture true", "on by default");

        let mut settings = ts.shell.settings.get();
        for capture in [false, true, false] {
            settings.capture_protected = capture;
            ts.shell.set_settings(settings).unwrap();
            let start = FakeSteps::default();
            assert_eq!(start_window(&start, &ts.shell, false), Ok(()));
            assert_eq!(start.events()[0], format!("capture {capture}"));
            let again = FakeSteps::default();
            assert_eq!(bring_forward(&again, &ts.shell), Ok(()));
            assert_eq!(again.events()[0], format!("capture {capture}"));
        }
    }
}
