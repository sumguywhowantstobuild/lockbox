//! The user's settings (spec §7.4), in `settings.json` in the state folder:
//! `{ "version": 1, "idle_minutes": <1..=60>, "clipboard_seconds": <10..=300>, "theme": "system" | "light" | "dark",
//! "shortcut": { "ctrl", "shift", "alt", "key" }, "capture_protected": <bool>, "close_explained": <bool> }`. The
//! last is the shell's own note that the first close's explanation was seen; the page never reads or sets it. A file
//! from before a field existed loads with that field's default: the theme follows Windows, the save shortcut is
//! Ctrl+Shift+L, capture protection is on, and the first close was not yet explained.

use std::ops::RangeInclusive;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{ShellError, ShellResult};
use crate::lock;
use crate::os::Shortcut;
use crate::paths::{StateVersion, read_state, write_state};

/// The auto-lock idle time's bounds, in minutes.
pub const IDLE_MINUTES: RangeInclusive<u8> = 1..=60;
/// The clipboard clear delay's bounds, in seconds.
pub const CLIPBOARD_SECONDS: RangeInclusive<u16> = 10..=300;

/// What `settings.json` is called in errors.
const WHAT: &str = "settings";

/// The virtual-key codes a save shortcut may use: A to Z, 0 to 9 and F1 to F12.
const SHORTCUT_KEYS: [RangeInclusive<u16>; 3] = [0x41..=0x5A, 0x30..=0x39, 0x70..=0x7B];
/// C, V and X: with Ctrl they are copy, paste and cut, which the save shortcut must never take from every program.
const COPY_PASTE_KEYS: [u16; 3] = [0x43, 0x56, 0x58];

/// Whether `shortcut` may be the save shortcut: at least two of Ctrl, Shift and Alt (a lone key or one modifier would
/// steal ordinary typing from every program), a letter, a digit or F1 to F12, and never Ctrl with C, V or X, whatever
/// else is held.
fn shortcut_allowed(shortcut: Shortcut) -> bool {
    let modifiers = [shortcut.ctrl, shortcut.shift, shortcut.alt]
        .into_iter()
        .filter(|held| *held)
        .count();
    modifiers >= 2
        && SHORTCUT_KEYS
            .iter()
            .any(|keys| keys.contains(&shortcut.key))
        && !(shortcut.ctrl && COPY_PASTE_KEYS.contains(&shortcut.key))
}

/// How the page looks: its own light or dark, or whichever Windows uses (the default).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

/// Capture protection is on unless the person turns it off (Plan 4A, Task 4).
fn capture_protected_by_default() -> bool {
    true
}

/// The settings as the page reads and sends them (`get_settings`, `set_settings`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub idle_minutes: u8,
    pub clipboard_seconds: u16,
    #[serde(default)]
    pub theme: Theme,
    /// The save shortcut. Registered with Windows by `set_settings` and at launch, not by the store.
    #[serde(default)]
    pub shortcut: Shortcut,
    /// Whether Windows is asked to leave the window out of screenshots, recordings and screen sharing.
    #[serde(default = "capture_protected_by_default")]
    pub capture_protected: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            idle_minutes: 5,
            clipboard_seconds: 30,
            theme: Theme::default(),
            shortcut: Shortcut::default(),
            capture_protected: capture_protected_by_default(),
        }
    }
}

impl Settings {
    /// Refuses a value outside its bounds: `InvalidInput { what: "idle time" }`, `{ what: "clipboard delay" }` or, for a
    /// shortcut that [`shortcut_allowed`] does not allow, `{ what: "shortcut" }`.
    pub fn check(&self) -> ShellResult<()> {
        if !IDLE_MINUTES.contains(&self.idle_minutes) {
            return Err(ShellError::InvalidInput { what: "idle time" });
        }
        if !CLIPBOARD_SECONDS.contains(&self.clipboard_seconds) {
            return Err(ShellError::InvalidInput {
                what: "clipboard delay",
            });
        }
        if !shortcut_allowed(self.shortcut) {
            return Err(ShellError::InvalidInput { what: "shortcut" });
        }
        Ok(())
    }

    /// How long without input locks every vault.
    pub fn idle_limit(&self) -> Duration {
        Duration::from_secs(60 * u64::from(self.idle_minutes))
    }

    /// How long a copied value stays on the clipboard.
    pub fn clipboard_delay(&self) -> Duration {
        Duration::from_secs(u64::from(self.clipboard_seconds))
    }
}

/// The file as written. `close_explained` is the shell's own note (the first close's explanation was seen): the page's
/// [`Settings`] never carry it, and a file from before it existed loads with `false`. The same goes for each field of
/// the settings added since version 1 was first written: a file without it loads with its default.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SettingsFile {
    version: StateVersion,
    idle_minutes: u8,
    clipboard_seconds: u16,
    #[serde(default)]
    theme: Theme,
    #[serde(default)]
    shortcut: Shortcut,
    #[serde(default = "capture_protected_by_default")]
    capture_protected: bool,
    #[serde(default)]
    close_explained: bool,
}

impl SettingsFile {
    fn new(settings: Settings, close_explained: bool) -> Self {
        SettingsFile {
            version: StateVersion,
            idle_minutes: settings.idle_minutes,
            clipboard_seconds: settings.clipboard_seconds,
            theme: settings.theme,
            shortcut: settings.shortcut,
            capture_protected: settings.capture_protected,
            close_explained,
        }
    }
}

/// The settings in effect, and their file. Read once, at launch; each change is saved before it takes effect.
pub struct SettingsStore {
    file: PathBuf,
    /// Held only to copy the settings in or out: the auto-lock's tick reads it and must never wait for the disk.
    current: Mutex<Settings>,
    /// Whether the first close's explanation was seen: kept for this run even when it could not be saved.
    close_explained: AtomicBool,
    /// Held while a change is saved and put in effect, so two changes land in the file in the order they take effect.
    saving: Mutex<()>,
    /// Tests only: run once, inside the next save, before the file is written.
    #[cfg(test)]
    on_save: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl SettingsStore {
    /// The settings in `file`, or the defaults when there is none yet. A file that cannot be read, is damaged, or
    /// holds a value out of bounds also gives the defaults (the auto-lock must run whatever the file holds) and is
    /// left as it is until the user saves settings again.
    pub fn load(file: PathBuf) -> SettingsStore {
        let saved = read_state::<SettingsFile>(&file, WHAT)
            .ok()
            .flatten()
            .map(|saved| {
                let settings = Settings {
                    idle_minutes: saved.idle_minutes,
                    clipboard_seconds: saved.clipboard_seconds,
                    theme: saved.theme,
                    shortcut: saved.shortcut,
                    capture_protected: saved.capture_protected,
                };
                (settings, saved.close_explained)
            })
            .filter(|(settings, _)| settings.check().is_ok());
        let (settings, close_explained) = saved.unwrap_or_default();
        SettingsStore {
            file,
            current: Mutex::new(settings),
            close_explained: AtomicBool::new(close_explained),
            saving: Mutex::default(),
            #[cfg(test)]
            on_save: Mutex::default(),
        }
    }

    /// The settings in effect.
    pub fn get(&self) -> Settings {
        *lock(&self.current)
    }

    /// Checks `settings`, saves them and puts them in effect.
    pub fn set(&self, settings: Settings) -> ShellResult<()> {
        settings.check()?;
        let _saving = lock(&self.saving);
        #[cfg(test)]
        self.run_on_save();
        let explained = self.close_explained.load(Ordering::SeqCst);
        write_state(&self.file, &SettingsFile::new(settings, explained), WHAT)?;
        *lock(&self.current) = settings;
        Ok(())
    }

    /// Whether the first close's explanation was seen (saved, or only remembered for this run).
    pub fn close_explained(&self) -> bool {
        self.close_explained.load(Ordering::SeqCst)
    }

    /// Notes that the first close's explanation was seen and saves it with the other settings. Taken for this run
    /// even when the file cannot be written: the error is only for the caller to log, never to show.
    pub fn mark_close_explained(&self) -> ShellResult<()> {
        let _saving = lock(&self.saving);
        self.close_explained.store(true, Ordering::SeqCst);
        write_state(&self.file, &SettingsFile::new(self.get(), true), WHAT)
    }

    /// Tests only: runs `hook` once, inside the next save, before the file is written.
    #[cfg(test)]
    pub(crate) fn during_next_save(&self, hook: Box<dyn FnOnce() + Send>) {
        *lock(&self.on_save) = Some(hook);
    }

    #[cfg(test)]
    fn run_on_save(&self) {
        let hook = lock(&self.on_save).take();
        if let Some(hook) = hook {
            hook();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use lockbox_core::internals::fsio::testutil::TempDir;

    use super::*;

    #[test]
    fn settings_bounds_table() {
        let defaults = Settings::default();
        assert_eq!((defaults.idle_minutes, defaults.clipboard_seconds), (5, 30));
        let idle = |idle_minutes| Settings {
            idle_minutes,
            ..defaults
        };
        let clipboard = |clipboard_seconds| Settings {
            clipboard_seconds,
            ..defaults
        };
        let idle_refused = Err(ShellError::InvalidInput { what: "idle time" });
        let clipboard_refused = Err(ShellError::InvalidInput {
            what: "clipboard delay",
        });
        let table = [
            (idle(0), idle_refused),
            (idle(1), Ok(())),
            (idle(60), Ok(())),
            (idle(61), idle_refused),
            (idle(u8::MAX), idle_refused),
            (clipboard(9), clipboard_refused),
            (clipboard(10), Ok(())),
            (clipboard(300), Ok(())),
            (clipboard(301), clipboard_refused),
            (clipboard(0), clipboard_refused),
        ];
        for (settings, expected) in table {
            assert_eq!(settings.check(), expected, "{settings:?}");
        }

        // No file yet: the defaults. A refused value is neither saved nor put in effect.
        let temp = TempDir::new();
        let file = temp.path().join("Lockbox").join("settings.json");
        let store = SettingsStore::load(file.clone());
        assert_eq!(store.get(), defaults);
        for refused in [idle(0), idle(61), clipboard(9), clipboard(301)] {
            assert!(store.set(refused).is_err(), "{refused:?}");
            assert_eq!(store.get(), defaults);
            assert!(!file.exists(), "a refused value wrote the file");
        }

        // A value in bounds is saved, and read back by the next launch.
        let chosen = Settings {
            idle_minutes: 1,
            clipboard_seconds: 300,
            ..defaults
        };
        store.set(chosen).unwrap();
        assert_eq!(store.get(), chosen);
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert_eq!(
            saved,
            serde_json::json!({
                "version": 1,
                "idle_minutes": 1,
                "clipboard_seconds": 300,
                "theme": "system",
                "shortcut": { "ctrl": true, "shift": true, "alt": false, "key": 76 },
                "capture_protected": true,
                "close_explained": false
            })
        );
        assert_eq!(SettingsStore::load(file.clone()).get(), chosen);

        // A damaged file, an unknown field or a value out of bounds: the defaults, the file left as it is.
        for damaged in [
            r#"{ "version": 1, "idle_minutes": 0, "clipboard_seconds": 30 }"#,
            r#"{ "version": 1, "idle_minutes": 5, "clipboard_seconds": 301 }"#,
            r#"{ "version": 1, "idle_minutes": 5, "clipboard_seconds": 30, "extra": 1 }"#,
            r#"{ "version": 2, "idle_minutes": 5, "clipboard_seconds": 30 }"#,
            "not json",
        ] {
            fs::write(&file, damaged).unwrap();
            assert_eq!(
                SettingsStore::load(file.clone()).get(),
                defaults,
                "{damaged}"
            );
            assert_eq!(fs::read_to_string(&file).unwrap(), damaged);
        }
    }

    fn saved(file: &std::path::Path) -> serde_json::Value {
        serde_json::from_slice(&fs::read(file).unwrap()).unwrap()
    }

    /// A settings file from before `close_explained` existed loads as it did, with the note at `false`; the next save
    /// (a change of the page's settings) writes the field out, still `false`.
    #[test]
    fn old_settings_file_still_loads() {
        let temp = TempDir::new();
        let file = temp.path().join("settings.json");
        fs::write(
            &file,
            r#"{ "version": 1, "idle_minutes": 7, "clipboard_seconds": 45 }"#,
        )
        .unwrap();
        let store = SettingsStore::load(file.clone());
        assert_eq!(
            store.get(),
            Settings {
                idle_minutes: 7,
                clipboard_seconds: 45,
                ..Settings::default()
            }
        );
        assert!(!store.close_explained());

        store.set(store.get()).unwrap();
        assert_eq!(saved(&file)["close_explained"], false);
        assert!(!SettingsStore::load(file).close_explained());
    }

    /// A file from before the theme, the shortcut and capture protection existed (version 1, the two old values and
    /// maybe the first-close note) loads with their defaults and keeps what it had; the next save writes them out.
    #[test]
    fn old_settings_file_gets_defaults() {
        for old in [
            r#"{ "version": 1, "idle_minutes": 7, "clipboard_seconds": 45 }"#,
            r#"{ "version": 1, "idle_minutes": 7, "clipboard_seconds": 45, "close_explained": true }"#,
        ] {
            let temp = TempDir::new();
            let file = temp.path().join("settings.json");
            fs::write(&file, old).unwrap();
            let store = SettingsStore::load(file.clone());
            let got = store.get();
            assert_eq!((got.idle_minutes, got.clipboard_seconds), (7, 45), "{old}");
            assert_eq!(got.theme, Theme::System);
            assert_eq!(got.shortcut, Shortcut::default());
            assert_eq!(
                (got.shortcut.ctrl, got.shortcut.shift, got.shortcut.alt),
                (true, true, false)
            );
            assert_eq!(got.shortcut.key, 76, "Ctrl+Shift+L");
            assert!(got.capture_protected, "capture protection defaults to on");
            assert_eq!(
                store.close_explained(),
                old.contains("true"),
                "the first-close note is kept"
            );
            // Read, not written: the file is as it was until a save.
            assert_eq!(fs::read_to_string(&file).unwrap(), old);

            store.set(got).unwrap();
            let written = saved(&file);
            assert_eq!(written["version"], 1);
            assert_eq!(written["theme"], "system");
            assert_eq!(written["capture_protected"], true);
            assert_eq!(written["shortcut"]["key"], 76);
        }
    }

    /// A field the file does not know is still refused (the whole file gives the defaults, and is left as it is), also
    /// beside the new fields; so is a theme, a shortcut or a flag of a shape the settings cannot hold.
    #[test]
    fn unknown_field_still_refused() {
        let defaults = Settings::default();
        for damaged in [
            r#"{ "version": 1, "idle_minutes": 7, "clipboard_seconds": 45, "theme": "dark", "extra": 1 }"#,
            r#"{ "version": 1, "idle_minutes": 7, "clipboard_seconds": 45, "shortcut": { "ctrl": true, "shift": true, "alt": false, "key": 76, "extra": 1 } }"#,
            r#"{ "version": 1, "idle_minutes": 7, "clipboard_seconds": 45, "theme": "purple" }"#,
            r#"{ "version": 1, "idle_minutes": 7, "clipboard_seconds": 45, "capture_protected": "yes" }"#,
            r#"{ "version": 1, "idle_minutes": 7, "clipboard_seconds": 45, "shortcut": { "ctrl": true, "shift": true, "alt": false, "key": 70000 } }"#,
        ] {
            let temp = TempDir::new();
            let file = temp.path().join("settings.json");
            fs::write(&file, damaged).unwrap();
            assert_eq!(
                SettingsStore::load(file.clone()).get(),
                defaults,
                "{damaged}"
            );
            assert_eq!(fs::read_to_string(&file).unwrap(), damaged);
        }
        // The page's own request is as strict.
        for refused in [
            serde_json::json!({ "idle_minutes": 5, "clipboard_seconds": 30, "extra": true }),
            serde_json::json!({ "idle_minutes": 5, "clipboard_seconds": 30, "theme": "purple" }),
            serde_json::json!({ "idle_minutes": 5, "clipboard_seconds": 30, "shortcut": { "ctrl": true } }),
            serde_json::json!({ "idle_minutes": 5, "clipboard_seconds": 30, "shortcut": { "ctrl": true, "shift": true, "alt": false, "key": 76, "path": "C:\\" } }),
            serde_json::json!({ "idle_minutes": 5, "clipboard_seconds": 30, "capture_protected": 1 }),
        ] {
            assert!(
                serde_json::from_value::<Settings>(refused.clone()).is_err(),
                "{refused}"
            );
        }
    }

    /// What the new fields hold is written, and read back by the next launch.
    #[test]
    fn new_settings_are_saved_and_read_back() {
        let temp = TempDir::new();
        let file = temp.path().join("Lockbox").join("settings.json");
        let store = SettingsStore::load(file.clone());
        let chosen = Settings {
            theme: Theme::Dark,
            shortcut: Shortcut {
                ctrl: true,
                shift: false,
                alt: true,
                key: 0x71,
            },
            capture_protected: false,
            ..Settings::default()
        };
        store.set(chosen).unwrap();
        let written = saved(&file);
        assert_eq!(written["theme"], "dark");
        assert_eq!(
            written["shortcut"],
            serde_json::json!({ "ctrl": true, "shift": false, "alt": true, "key": 113 })
        );
        assert_eq!(written["capture_protected"], false);
        assert_eq!(SettingsStore::load(file).get(), chosen);

        for (theme, word) in [
            (Theme::System, "system"),
            (Theme::Light, "light"),
            (Theme::Dark, "dark"),
        ] {
            assert_eq!(serde_json::to_value(theme).unwrap(), word);
            assert_eq!(serde_json::from_value::<Theme>(word.into()).unwrap(), theme);
        }
    }

    /// A shortcut needs at least two of Ctrl, Shift and Alt, a key that is a letter, a digit or F1 to F12, and is never
    /// Ctrl with C, V or X (whatever else is held): `InvalidInput { what: "shortcut" }`, and nothing is saved.
    #[test]
    fn shortcut_needs_two_modifiers() {
        let refused = Err(ShellError::InvalidInput { what: "shortcut" });
        let with = |ctrl, shift, alt, key| Settings {
            shortcut: Shortcut {
                ctrl,
                shift,
                alt,
                key,
            },
            ..Settings::default()
        };
        let (a, zero, f1) = (0x41, 0x30, 0x70);
        let table = [
            // Two or three modifiers, any allowed key.
            (with(true, true, false, a), Ok(())),
            (with(true, false, true, a), Ok(())),
            (with(false, true, true, a), Ok(())),
            (with(true, true, true, a), Ok(())),
            (with(true, true, false, 0x5A), Ok(())),
            (with(true, true, false, zero), Ok(())),
            (with(true, true, false, 0x39), Ok(())),
            (with(true, true, false, f1), Ok(())),
            (with(true, true, false, 0x7B), Ok(())),
            // Fewer than two modifiers.
            (with(false, false, false, a), refused),
            (with(true, false, false, a), refused),
            (with(false, true, false, a), refused),
            (with(false, false, true, a), refused),
            (with(false, false, false, f1), refused),
            // A key that is not a letter, a digit or F1 to F12.
            (with(true, true, false, 0), refused),
            (with(true, true, false, 0x40), refused),
            (with(true, true, false, 0x5B), refused),
            (with(true, true, false, 0x2F), refused),
            (with(true, true, false, 0x3A), refused),
            (with(true, true, false, 0x6F), refused),
            (with(true, true, false, 0x7C), refused),
            (with(true, true, false, 0x0D), refused),
            (with(true, true, false, 0x1B), refused),
            (with(true, true, false, u16::MAX), refused),
            // Ctrl with C, V or X, whatever else is held.
            (with(true, true, false, 0x43), refused),
            (with(true, true, false, 0x56), refused),
            (with(true, true, false, 0x58), refused),
            (with(true, false, true, 0x43), refused),
            (with(true, true, true, 0x56), refused),
            // The same keys without Ctrl are only a shortcut like another.
            (with(false, true, true, 0x43), Ok(())),
            (with(false, true, true, 0x56), Ok(())),
            (with(false, true, true, 0x58), Ok(())),
        ];
        for (settings, expected) in table {
            assert_eq!(settings.check(), expected, "{:?}", settings.shortcut);
        }

        // A refused shortcut is neither saved nor put in effect.
        let temp = TempDir::new();
        let file = temp.path().join("settings.json");
        let store = SettingsStore::load(file.clone());
        assert_eq!(store.set(with(true, false, false, a)), refused);
        assert_eq!(store.get(), Settings::default());
        assert!(!file.exists());
        // The order of the checks: a refused idle time is named before a refused shortcut.
        let both = Settings {
            idle_minutes: 0,
            ..with(true, false, false, a)
        };
        assert_eq!(
            both.check(),
            Err(ShellError::InvalidInput { what: "idle time" })
        );
    }

    /// The note is saved in the settings file beside the page's settings, kept by every later save of them, read back by
    /// the next launch, and never part of the page's own `Settings`.
    #[test]
    fn close_explained_is_saved_with_the_settings_and_kept() {
        let temp = TempDir::new();
        let file = temp.path().join("Lockbox").join("settings.json");
        let store = SettingsStore::load(file.clone());
        assert!(!store.close_explained());

        store.mark_close_explained().unwrap();
        assert!(store.close_explained());
        assert_eq!(
            saved(&file),
            serde_json::json!({
                "version": 1,
                "idle_minutes": 5,
                "clipboard_seconds": 30,
                "theme": "system",
                "shortcut": { "ctrl": true, "shift": true, "alt": false, "key": 76 },
                "capture_protected": true,
                "close_explained": true
            })
        );
        assert!(SettingsStore::load(file.clone()).close_explained());

        // A change of the page's settings keeps it.
        let chosen = Settings {
            idle_minutes: 2,
            clipboard_seconds: 60,
            ..Settings::default()
        };
        store.set(chosen).unwrap();
        assert!(store.close_explained());
        assert_eq!(saved(&file)["close_explained"], true);
        let again = SettingsStore::load(file);
        assert_eq!((again.get(), again.close_explained()), (chosen, true));

        // The page's shape has no such field.
        let page = serde_json::to_value(chosen).unwrap();
        assert_eq!(
            page,
            serde_json::json!({
                "idle_minutes": 2,
                "clipboard_seconds": 60,
                "theme": "system",
                "shortcut": { "ctrl": true, "shift": true, "alt": false, "key": 76 },
                "capture_protected": true
            })
        );
        assert!(
            serde_json::from_value::<Settings>(serde_json::json!({
                "idle_minutes": 2,
                "clipboard_seconds": 60,
                "close_explained": true
            }))
            .is_err()
        );
    }

    /// A file that cannot be written: the note is still taken for this run, the settings in effect do not change, and
    /// the error is handed back for the caller to log.
    #[test]
    fn close_explained_is_remembered_when_the_file_cannot_be_written() {
        let temp = TempDir::new();
        let blocker = temp.path().join("blocker");
        fs::write(&blocker, "a file where a folder is needed").unwrap();
        let file = blocker.join("settings.json");
        let store = SettingsStore::load(file.clone());

        assert!(store.mark_close_explained().is_err());
        assert!(store.close_explained(), "not remembered for this run");
        assert_eq!(store.get(), Settings::default());
        assert!(!file.exists());
        // The next launch has not seen it.
        assert!(!SettingsStore::load(file).close_explained());
    }
}
