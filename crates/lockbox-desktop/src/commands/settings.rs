//! The settings screen (spec §7.4, design "Settings"): the page's app-wide settings, and starting with Windows.

use std::sync::Arc;

use serde::Deserialize;
use tauri::State;
use tauri::ipc::Request;

use super::{NoArgs, args, blocking};
use crate::error::{ShellError, ShellResult};
use crate::lock;
use crate::os::HotkeyTaken;
use crate::settings::Settings;
use crate::shell::Shell;
use crate::startup::StartupState;

/// Another program has the keys of the new save shortcut (Windows says they are registered already).
pub const SHORTCUT_TAKEN: ShellError = ShellError::InvalidInput {
    what: "shortcut taken",
};
/// Windows refused the new save shortcut for another reason, or did not answer.
pub const SHORTCUT_NOT_SET: ShellError = ShellError::InvalidInput {
    what: "shortcut not set",
};

impl Shell {
    /// Puts `new` in effect, each change at once (the page saves on every change), in this order: checks it (a refusal
    /// changes nothing); when the save shortcut differs from the saved one, registers it with Windows first, and when
    /// Windows refuses it answers [`SHORTCUT_TAKEN`] (the keys are registered already) or [`SHORTCUT_NOT_SET`] (any
    /// other refusal), with nothing saved and the old shortcut still working; saves, and when the save fails after a new
    /// shortcut was registered, puts the old one back before answering the save's error; then, if capture protection
    /// changed, tells the window.
    ///
    /// One change at a time: the shortcut Windows holds is always the saved one, whatever order two changes land in.
    pub fn set_settings(&self, new: Settings) -> ShellResult<()> {
        new.check()?;
        let _one_change = lock(&self.settings_change);
        let old = self.settings.get();
        let moved = new.shortcut != old.shortcut;
        if moved {
            self.os
                .hotkey
                .set(Some(new.shortcut))
                .map_err(|refused| match refused {
                    HotkeyTaken::Taken => SHORTCUT_TAKEN,
                    HotkeyTaken::NotSet => SHORTCUT_NOT_SET,
                })?;
        }
        if let Err(error) = self.settings.set(new) {
            if moved {
                // Best effort: the save's own error is what the page is told.
                let _ = self.os.hotkey.set(Some(old.shortcut));
            }
            return Err(error);
        }
        if moved {
            self.forget_shortcut_failure();
        }
        if new.capture_protected != old.capture_protected {
            self.os.window.protect_from_capture(new.capture_protected);
        }
        Ok(())
    }
}

/// The settings in effect.
#[tauri::command]
pub(super) async fn get_settings(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Settings> {
    let NoArgs {} = args(&request)?;
    Ok(shell.settings.get())
}

/// Saves new settings (the whole of them, every field always sent: the idle time, the clipboard delay, the theme, the
/// save shortcut and capture protection) and puts them in effect ([`Shell::set_settings`]). A value out of bounds is
/// refused (`InvalidInput`) and nothing changes; a shortcut Windows will not take is refused with its own label and the
/// old one keeps working.
#[tauri::command]
pub(super) async fn set_settings(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<()> {
    let settings: Settings = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.set_settings(settings)).await
}

/// Whether Lockbox starts with Windows, as the registry says now (`{ on, turned_off_in_windows }`).
#[tauri::command]
pub(super) async fn get_startup(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<StartupState> {
    let NoArgs {} = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.startup()).await
}

/// What the page asks of starting with Windows.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetStartup {
    on: bool,
}

/// Turns Lockbox's `Run` entry on or off and answers the state read back (`{ on, turned_off_in_windows }`), which is
/// not always what was asked: Windows' own Startup settings may have it turned off.
#[tauri::command]
pub(super) async fn set_startup(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<StartupState> {
    let SetStartup { on } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.set_startup(on)).await
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    use serde_json::json;
    use tauri::ipc::InvokeBody;

    use super::super::{MALFORMED, parse};
    use super::*;
    use crate::os::Shortcut;
    use crate::settings::{SettingsStore, Theme};
    use crate::testing::TestShell;

    /// A field the settings do not have, a missing one, or a value its type cannot hold is a malformed request.
    #[test]
    fn set_settings_request_is_strict() {
        let body = |value| InvokeBody::Json(value);
        assert_eq!(
            parse::<Settings>(&body(json!({ "idle_minutes": 1, "clipboard_seconds": 10 }))).ok(),
            Some(Settings {
                idle_minutes: 1,
                clipboard_seconds: 10,
                ..Settings::default()
            })
        );
        let whole = json!({
            "idle_minutes": 1,
            "clipboard_seconds": 10,
            "theme": "dark",
            "shortcut": { "ctrl": true, "shift": false, "alt": true, "key": 75 },
            "capture_protected": false
        });
        assert_eq!(
            parse::<Settings>(&body(whole)).ok(),
            Some(Settings {
                idle_minutes: 1,
                clipboard_seconds: 10,
                theme: Theme::Dark,
                shortcut: Shortcut {
                    ctrl: true,
                    shift: false,
                    alt: true,
                    key: 75
                },
                capture_protected: false
            })
        );
        for malformed in [
            json!({ "idle_minutes": 5 }),
            json!({ "idle_minutes": 5, "clipboard_seconds": 30, "path": "C:\\" }),
            // The first-close note lives in the settings file only: the page can neither read nor set it.
            json!({ "idle_minutes": 5, "clipboard_seconds": 30, "close_explained": true }),
            json!({ "idle_minutes": 256, "clipboard_seconds": 30 }),
            json!({ "idle_minutes": -1, "clipboard_seconds": 30 }),
            json!({ "idle_minutes": 5, "clipboard_seconds": 70000 }),
            json!({ "idle_minutes": 5, "clipboard_seconds": 30, "theme": "purple" }),
            json!({ "idle_minutes": 5, "clipboard_seconds": 30, "theme": 1 }),
            json!({ "idle_minutes": 5, "clipboard_seconds": 30, "capture_protected": "yes" }),
            json!({ "idle_minutes": 5, "clipboard_seconds": 30, "shortcut": { "ctrl": true } }),
            json!({ "idle_minutes": 5, "clipboard_seconds": 30, "shortcut": { "ctrl": true, "shift": true, "alt": false, "key": 65536 } }),
            json!({ "idle_minutes": 5, "clipboard_seconds": 30, "shortcut": { "ctrl": true, "shift": true, "alt": false, "key": 76, "path": "C:\\" } }),
            json!({ "idle_minutes": 5, "clipboard_seconds": 30, "shortcut": "Ctrl+Shift+L" }),
        ] {
            assert_eq!(parse::<Settings>(&body(malformed)).err(), Some(MALFORMED));
        }
    }

    /// `set_startup` takes exactly `{ on: <bool> }`: nothing missing, nothing else, nothing that is not a boolean.
    #[test]
    fn set_startup_request_is_strict() {
        let body = |value| InvokeBody::Json(value);
        for on in [true, false] {
            assert_eq!(
                parse::<SetStartup>(&body(json!({ "on": on })))
                    .ok()
                    .map(|asked| asked.on),
                Some(on)
            );
        }
        for malformed in [
            json!({}),
            json!({ "on": "yes" }),
            json!({ "on": 1 }),
            json!({ "on": null }),
            json!({ "on": true, "path": "C:\\" }),
            json!({ "on": true, "value": "--hidden" }),
            json!(true),
        ] {
            assert!(
                parse::<SetStartup>(&body(malformed.clone())).is_err(),
                "{malformed}"
            );
        }
        // The two reads take no arguments at all.
        assert!(parse::<NoArgs>(&body(json!({}))).is_ok());
        assert_eq!(
            parse::<NoArgs>(&body(json!({ "on": true }))).err(),
            Some(MALFORMED)
        );
    }

    fn other_shortcut() -> Shortcut {
        Shortcut {
            ctrl: true,
            shift: false,
            alt: true,
            key: u16::from(b'K'),
        }
    }

    /// A shell whose save shortcut is registered, as at launch.
    fn launched() -> TestShell {
        let ts = TestShell::new();
        ts.shell.register_save_shortcut();
        assert_eq!(ts.hotkey.registered(), Some(Shortcut::default()));
        ts
    }

    fn saved_on_disk(ts: &TestShell) -> Settings {
        SettingsStore::load(ts.shell.paths.settings.clone()).get()
    }

    /// Each change is in effect the moment it is saved: the idle time and the clipboard delay the timers read, the
    /// theme and the shortcut the next launch reads; the new settings are what the page reads back.
    #[test]
    fn each_change_applies_at_once() {
        let ts = launched();
        let chosen = Settings {
            idle_minutes: 2,
            clipboard_seconds: 90,
            theme: Theme::Light,
            shortcut: other_shortcut(),
            capture_protected: true,
        };
        assert_eq!(ts.shell.set_settings(chosen), Ok(()));
        assert_eq!(ts.shell.settings.get(), chosen);
        assert_eq!(saved_on_disk(&ts), chosen, "the next launch reads it");
        assert_eq!(
            ts.shell.settings.get().idle_limit(),
            Duration::from_secs(120)
        );
        assert_eq!(
            ts.shell.settings.get().clipboard_delay(),
            Duration::from_secs(90)
        );
        assert_eq!(ts.hotkey.registered(), Some(other_shortcut()));

        // One field at a time, as the page saves them.
        let theme = Settings {
            theme: Theme::Dark,
            ..chosen
        };
        assert_eq!(ts.shell.set_settings(theme), Ok(()));
        assert_eq!(ts.shell.settings.get(), theme);
        assert_eq!(saved_on_disk(&ts), theme);
        // The first-close note and the other fields are kept by a change.
        assert_eq!(ts.shell.settings.get().shortcut, other_shortcut());
    }

    /// A shortcut the settings do not allow, or any other value out of bounds, is refused before Windows is asked for
    /// anything and before anything is saved or applied.
    #[test]
    fn refused_settings_ask_windows_for_nothing() {
        let ts = launched();
        let before = ts.shell.settings.get();
        let asked_at_launch = ts.hotkey.asked();
        let with_shortcut = |ctrl, shift, alt, key| Settings {
            shortcut: Shortcut {
                ctrl,
                shift,
                alt,
                key,
            },
            capture_protected: false,
            ..before
        };
        for (settings, label) in [
            (with_shortcut(true, false, false, 0x4B), "shortcut"),
            (with_shortcut(true, true, false, 0x43), "shortcut"),
            (with_shortcut(true, true, false, 0x56), "shortcut"),
            (with_shortcut(true, true, false, 0x58), "shortcut"),
            (with_shortcut(true, true, false, 0x20), "shortcut"),
            (
                Settings {
                    idle_minutes: 0,
                    shortcut: other_shortcut(),
                    ..before
                },
                "idle time",
            ),
            (
                Settings {
                    clipboard_seconds: 5,
                    shortcut: other_shortcut(),
                    ..before
                },
                "clipboard delay",
            ),
        ] {
            let refused = ts.shell.set_settings(settings).unwrap_err();
            assert_eq!(
                serde_json::to_value(refused).unwrap()["what"],
                label,
                "{settings:?}"
            );
        }
        assert_eq!(ts.hotkey.asked(), asked_at_launch, "Windows was asked");
        assert_eq!(ts.hotkey.registered(), Some(Shortcut::default()));
        assert_eq!(ts.shell.settings.get(), before);
        assert!(!ts.shell.paths.settings.exists(), "something was saved");
        assert_eq!(ts.window.protections(), Vec::<bool>::new());
    }

    /// A shortcut another program has (Windows says registered already) is `shortcut taken`; any other refusal is
    /// `shortcut not set`. Either way nothing is saved, nothing else of the request is applied, and the old shortcut
    /// still works.
    #[test]
    fn taken_shortcut_changes_nothing() {
        for (why, refusal) in [
            (HotkeyTaken::Taken, SHORTCUT_TAKEN),
            (HotkeyTaken::NotSet, SHORTCUT_NOT_SET),
        ] {
            let ts = launched();
            let before = ts.shell.settings.get();
            ts.hotkey.refuse_next(why);
            let asked = Settings {
                shortcut: other_shortcut(),
                idle_minutes: 1,
                theme: Theme::Dark,
                capture_protected: false,
                ..before
            };
            assert_eq!(ts.shell.set_settings(asked), Err(refusal), "{why:?}");
            assert_eq!(
                ts.hotkey.asked(),
                [Some(Shortcut::default()), Some(other_shortcut())]
            );
            assert_eq!(ts.hotkey.registered(), Some(Shortcut::default()));
            assert_eq!(ts.shell.settings.get(), before);
            assert!(!ts.shell.paths.settings.exists(), "something was saved");
            assert_eq!(ts.window.protections(), Vec::<bool>::new());

            // The same request goes through once the keys are free.
            assert_eq!(ts.shell.set_settings(asked), Ok(()));
            assert_eq!(ts.hotkey.registered(), Some(other_shortcut()));
            assert_eq!(saved_on_disk(&ts), asked);
        }
        // The two refusals are told apart by their labels, and are not the check's own.
        assert_eq!(
            serde_json::to_value(SHORTCUT_TAKEN).unwrap(),
            json!({ "code": "invalid_input", "what": "shortcut taken" })
        );
        assert_eq!(
            serde_json::to_value(SHORTCUT_NOT_SET).unwrap(),
            json!({ "code": "invalid_input", "what": "shortcut not set" })
        );
    }

    /// A launch notice that the save shortcut was taken or not set is stale once a replacement is registered and saved:
    /// the page that asks again (a reload) must not hear it. Other launch notices stay, and a refused or failed change
    /// leaves it, since the shortcut is still the one that was not set.
    #[test]
    fn a_new_shortcut_clears_the_launch_failure_notice() {
        use crate::outputs::SweepReport;
        use crate::session::Notice;
        for why in [HotkeyTaken::Taken, HotkeyTaken::NotSet] {
            let ts = TestShell::new();
            ts.hotkey.refuse_next(why);
            ts.shell.register_save_shortcut();
            ts.shell.tell(Notice::OutputSweep(SweepReport::default()));
            let kinds = |ts: &TestShell| {
                ts.shell
                    .launch_notices()
                    .iter()
                    .map(|n| serde_json::to_value(n).unwrap()["kind"].clone())
                    .collect::<Vec<_>>()
            };
            let failure = match why {
                HotkeyTaken::Taken => "shortcut_taken",
                HotkeyTaken::NotSet => "shortcut_not_set",
            };
            assert_eq!(kinds(&ts), [failure, "output_sweep"]);

            // A change that is refused, or a save that does not change the shortcut, leaves it.
            let before = ts.shell.settings.get();
            ts.hotkey.refuse_next(HotkeyTaken::Taken);
            let asked = Settings {
                shortcut: other_shortcut(),
                ..before
            };
            assert!(ts.shell.set_settings(asked).is_err());
            assert_eq!(
                ts.shell.set_settings(Settings {
                    theme: Theme::Dark,
                    ..before
                }),
                Ok(())
            );
            assert_eq!(kinds(&ts), [failure, "output_sweep"]);

            // A new shortcut that is registered and saved clears it, and only it.
            assert_eq!(ts.shell.set_settings(asked), Ok(()));
            assert_eq!(kinds(&ts), ["output_sweep"]);
        }
    }

    /// The new shortcut is registered, then the settings are saved; a save that fails puts the old shortcut back
    /// before the save's own error is answered. Nothing is saved, so the old shortcut is still the saved one.
    #[test]
    fn a_failed_save_puts_the_old_shortcut_back() {
        let ts = launched();
        // The state folder's place is taken by a file, so the settings file cannot be written.
        let root = ts.shell.paths.root.clone();
        fs::create_dir_all(root.parent().unwrap()).unwrap();
        fs::write(&root, "a file where the state folder goes").unwrap();
        let before = ts.shell.settings.get();
        let asked = Settings {
            shortcut: other_shortcut(),
            capture_protected: false,
            ..before
        };
        let save_error = SettingsStore::load(ts.shell.paths.settings.clone())
            .set(asked)
            .unwrap_err();

        assert_eq!(ts.shell.set_settings(asked), Err(save_error));
        assert_eq!(
            ts.hotkey.asked(),
            [
                Some(Shortcut::default()),
                Some(other_shortcut()),
                Some(Shortcut::default())
            ],
            "the new one, then the old one back"
        );
        assert_eq!(ts.hotkey.registered(), Some(Shortcut::default()));
        assert_eq!(ts.shell.settings.get(), before);
        assert_eq!(ts.window.protections(), Vec::<bool>::new());
    }

    /// A change that leaves the shortcut as it is never asks Windows for it again (a shortcut taken at launch would
    /// otherwise be asked for at every change of the theme).
    #[test]
    fn an_unchanged_shortcut_is_not_registered_again() {
        let ts = launched();
        let asked_at_launch = ts.hotkey.asked();
        let before = ts.shell.settings.get();
        for changed in [
            Settings {
                theme: Theme::Dark,
                ..before
            },
            Settings {
                idle_minutes: 9,
                ..before
            },
        ] {
            assert_eq!(ts.shell.set_settings(changed), Ok(()));
        }
        assert_eq!(ts.hotkey.asked(), asked_at_launch);
    }

    /// Capture protection is applied to the window at once when it changes, once per change, and not by a save that
    /// leaves it as it was.
    #[test]
    fn capture_applies_at_once() {
        let ts = launched();
        let before = ts.shell.settings.get();
        assert!(before.capture_protected, "on by default");

        // Unchanged: the window is not asked.
        assert_eq!(
            ts.shell.set_settings(Settings {
                theme: Theme::Dark,
                ..before
            }),
            Ok(())
        );
        assert_eq!(ts.window.protections(), Vec::<bool>::new());

        let off = Settings {
            capture_protected: false,
            ..ts.shell.settings.get()
        };
        assert_eq!(ts.shell.set_settings(off), Ok(()));
        assert_eq!(ts.window.protections(), [false]);
        assert!(!saved_on_disk(&ts).capture_protected);

        // Saved again as it is: nothing more.
        assert_eq!(ts.shell.set_settings(off), Ok(()));
        assert_eq!(ts.window.protections(), [false]);

        let on = Settings {
            capture_protected: true,
            ..off
        };
        assert_eq!(ts.shell.set_settings(on), Ok(()));
        assert_eq!(ts.window.protections(), [false, true]);
        assert!(saved_on_disk(&ts).capture_protected);
    }

    /// Two changes at the same moment (the page saves on every change) take turns: the shortcut Windows holds is the
    /// shortcut that was saved last, never one saved first. The first change is held while it registers its shortcut,
    /// and the second is sent then.
    #[test]
    fn two_changes_at_once_leave_the_registered_shortcut_the_saved_one() {
        let ts = launched();
        let first = Settings {
            shortcut: other_shortcut(),
            ..ts.shell.settings.get()
        };
        let second = Settings {
            shortcut: Shortcut {
                ctrl: false,
                shift: true,
                alt: true,
                key: u16::from(b'J'),
            },
            ..first
        };
        let (registering, is_registering) = mpsc::channel::<()>();
        let (release, released) = mpsc::channel::<()>();
        ts.hotkey.during_next_set(move || {
            let _ = registering.send(());
            let _ = released.recv_timeout(Duration::from_secs(30));
        });
        let (done, second_done) = mpsc::channel::<()>();
        thread::scope(|scope| {
            let one = scope.spawn(|| ts.shell.set_settings(first));
            is_registering
                .recv_timeout(Duration::from_secs(30))
                .expect("the first change never reached Windows");
            let two = scope.spawn(|| {
                let answer = ts.shell.set_settings(second);
                let _ = done.send(());
                answer
            });
            // A second change that does not wait would finish here, with the first one still held.
            let finished_early = second_done.recv_timeout(Duration::from_millis(300)).is_ok();
            release.send(()).unwrap();
            assert_eq!(one.join().unwrap(), Ok(()));
            assert_eq!(two.join().unwrap(), Ok(()));
            assert!(!finished_early, "the second change did not wait its turn");
        });
        assert_eq!(ts.shell.settings.get(), second);
        assert_eq!(ts.hotkey.registered(), Some(second.shortcut));
        assert_eq!(saved_on_disk(&ts), second);
    }
}
