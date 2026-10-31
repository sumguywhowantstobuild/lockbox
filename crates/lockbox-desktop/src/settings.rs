//! The user's settings (spec §7.4): the auto-lock idle time and the clipboard clear delay, in `settings.json` in the
//! state folder: `{ "version": 1, "idle_minutes": <1..=60>, "clipboard_seconds": <10..=300> }`.

use std::ops::RangeInclusive;
use std::path::PathBuf;
use std::sync::Mutex;
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

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SettingsFile {
    version: StateVersion,
    idle_minutes: u8,
    clipboard_seconds: u16,
}

impl From<Settings> for SettingsFile {
    fn from(settings: Settings) -> Self {
        SettingsFile {
            version: StateVersion,
            idle_minutes: settings.idle_minutes,
            clipboard_seconds: settings.clipboard_seconds,
        }
    }
}

/// The settings in effect, and their file. Read once, at launch; each change is saved before it takes effect.
pub struct SettingsStore {
    file: PathBuf,
    /// Also held while a change is saved, so two changes land in the file in the order they take effect.
    current: Mutex<Settings>,
}

impl SettingsStore {
    /// The settings in `file`, or the defaults when there is none yet. A file that cannot be read, is damaged, or
    /// holds a value out of bounds also gives the defaults (the auto-lock must run whatever the file holds) and is
    /// left as it is until the user saves settings again.
    pub fn load(file: PathBuf) -> SettingsStore {
        let saved = read_state::<SettingsFile>(&file, WHAT)
            .ok()
            .flatten()
            .map(|saved| Settings {
                idle_minutes: saved.idle_minutes,
                clipboard_seconds: saved.clipboard_seconds,
            })
            .filter(|saved| saved.check().is_ok());
        SettingsStore {
            file,
            current: Mutex::new(saved.unwrap_or_default()),
        }
    }

    /// The settings in effect.
    pub fn get(&self) -> Settings {
        *lock(&self.current)
    }

    /// Checks `settings`, saves them and puts them in effect.
    pub fn set(&self, settings: Settings) -> ShellResult<()> {
        settings.check()?;
        let mut current = lock(&self.current);
        write_state(&self.file, &SettingsFile::from(settings), WHAT)?;
        *current = settings;
        Ok(())
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
            serde_json::json!({ "version": 1, "idle_minutes": 1, "clipboard_seconds": 300 })
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
}
