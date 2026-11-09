//! The user's settings (spec §7.4): the auto-lock idle time and the clipboard clear delay, in `settings.json` in the
//! state folder: `{ "version": 1, "idle_minutes": <1..=60>, "clipboard_seconds": <10..=300>, "close_explained": <bool> }`.
//! The last is the shell's own note that the first close's explanation was seen; the page never reads or sets it, and a
//! file without it (from before it existed) loads with `false`.

use std::ops::RangeInclusive;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{ShellError, ShellResult};
use crate::lock;
use crate::paths::{StateVersion, read_state, write_state};

/// The auto-lock idle time's bounds, in minutes.
pub const IDLE_MINUTES: RangeInclusive<u8> = 1..=60;
/// The clipboard clear delay's bounds, in seconds.
pub const CLIPBOARD_SECONDS: RangeInclusive<u16> = 10..=300;

/// What `settings.json` is called in errors.
const WHAT: &str = "settings";

/// The settings as the page reads and sends them (`get_settings`, `set_settings`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub idle_minutes: u8,
    pub clipboard_seconds: u16,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            idle_minutes: 5,
            clipboard_seconds: 30,
        }
    }
}

impl Settings {
    /// Refuses a value outside its bounds: `InvalidInput { what: "idle time" }` or `{ what: "clipboard delay" }`.
    pub fn check(&self) -> ShellResult<()> {
        if !IDLE_MINUTES.contains(&self.idle_minutes) {
            return Err(ShellError::InvalidInput { what: "idle time" });
        }
        if !CLIPBOARD_SECONDS.contains(&self.clipboard_seconds) {
            return Err(ShellError::InvalidInput {
                what: "clipboard delay",
            });
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
/// [`Settings`] never carry it, and a file from before it existed loads with `false`.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SettingsFile {
    version: StateVersion,
    idle_minutes: u8,
    clipboard_seconds: u16,
    #[serde(default)]
    close_explained: bool,
}

impl SettingsFile {
    fn new(settings: Settings, close_explained: bool) -> Self {
        SettingsFile {
            version: StateVersion,
            idle_minutes: settings.idle_minutes,
            clipboard_seconds: settings.clipboard_seconds,
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
                clipboard_seconds: 45
            }
        );
        assert!(!store.close_explained());

        store.set(store.get()).unwrap();
        assert_eq!(saved(&file)["close_explained"], false);
        assert!(!SettingsStore::load(file).close_explained());
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
                "close_explained": true
            })
        );
        assert!(SettingsStore::load(file.clone()).close_explained());

        // A change of the page's settings keeps it.
        let chosen = Settings {
            idle_minutes: 2,
            clipboard_seconds: 60,
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
            serde_json::json!({ "idle_minutes": 2, "clipboard_seconds": 60 })
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
