//! Where the shell keeps its own files (the state folder) and where new vaults go by default, and how a state file
//! is read and written: capped in size, a strict schema with `"version": 1`, saved crash-safe (spec §6.10).

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use lockbox_core::CoreError;
use lockbox_core::fsio::atomic_write;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::error::{ShellError, ShellResult};
use crate::os::{Env, KnownFolder};

/// The largest state file the shell reads: anything bigger is damaged.
pub const MAX_STATE_FILE: u64 = 1024 * 1024;

/// The state folder, `%LOCALAPPDATA%\Lockbox\`, and the files in it. No vault, export or backup may be placed inside
/// it.
#[derive(Clone)]
pub struct StatePaths {
    pub root: PathBuf,
    /// The restore journal (`restore-journal.json`).
    pub journal: PathBuf,
    /// The vault list (`vaults.json`).
    pub registry: PathBuf,
    /// The output journal (`pending-outputs.json`).
    pub outputs: PathBuf,
    pub settings: PathBuf,
    /// The "Open" folders' parent (`open\`).
    pub open: PathBuf,
}

/// The state folder from the known folder `LocalAppData`, never an environment variable.
pub fn state_paths(env: &dyn Env) -> io::Result<StatePaths> {
    let root = env.known_folder(KnownFolder::LocalAppData)?.join("Lockbox");
    Ok(StatePaths {
        journal: root.join("restore-journal.json"),
        registry: root.join("vaults.json"),
        outputs: root.join("pending-outputs.json"),
        settings: root.join("settings.json"),
        open: root.join("open"),
        root,
    })
}

/// Where new vaults go unless the user picks a folder: `<Profile>\Lockbox Vaults\`.
pub fn default_vault_parent(env: &dyn Env) -> io::Result<PathBuf> {
    Ok(env
        .known_folder(KnownFolder::Profile)?
        .join("Lockbox Vaults"))
}

/// The `"version"` of every state file: written as `1`, and only `1` is read back.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StateVersion;

impl Serialize for StateVersion {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u32(1)
    }
}

impl<'de> Deserialize<'de> for StateVersion {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match u32::deserialize(deserializer)? {
            1 => Ok(StateVersion),
            _ => Err(serde::de::Error::custom("state file version")),
        }
    }
}

/// Reads the state file `file` into `T` (a `deny_unknown_fields` struct with a [`StateVersion`]): `None` when there
/// is no such file. A file larger than [`MAX_STATE_FILE`], or one that does not parse as `T`, is damaged
/// (`Core(Damaged { what })`) and left as it is.
pub fn read_state<T: DeserializeOwned>(file: &Path, what: &'static str) -> ShellResult<Option<T>> {
    let Some(bytes) = read_capped(file, MAX_STATE_FILE)? else {
        return Ok(None);
    };
    let damaged = || ShellError::from(CoreError::Damaged { what });
    if bytes.len() as u64 > MAX_STATE_FILE {
        return Err(damaged());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| damaged())
}

/// Saves `value` as the state file `file`, crash-safe (the engine's `atomic_write`), making the state folder first
/// if it is not there yet.
pub fn write_state<T: Serialize>(file: &Path, value: &T) -> ShellResult<()> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|_| ShellError::InvalidInput { what: "state file" })?;
    if let Some(folder) = file.parent() {
        fs::create_dir_all(folder)?;
    }
    Ok(atomic_write(file, &bytes)?)
}

/// The whole of `file`, or `None` when there is no such file. Reads at most `max + 1` bytes, so a caller can tell a
/// file over `max` without reading all of it.
pub fn read_capped(file: &Path, max: u64) -> io::Result<Option<Vec<u8>>> {
    let file = match File::open(file) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut bytes = Vec::new();
    file.take(max + 1).read_to_end(&mut bytes)?;
    Ok(Some(bytes))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use lockbox_core::CoreError;
    use lockbox_core::internals::fsio::testutil::TempDir;
    use serde_json::json;

    use super::*;
    use crate::error::ShellError;
    use crate::testing::FakeEnv;

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Sample {
        version: StateVersion,
        items: Vec<u32>,
    }

    fn damaged(what: &'static str) -> ShellError {
        CoreError::Damaged { what }.into()
    }

    #[test]
    fn default_parent_is_profile_lockbox_vaults() {
        let temp = TempDir::new();
        let env = FakeEnv::new(temp.path());
        let profile = env.known_folder(KnownFolder::Profile).unwrap();
        let parent = default_vault_parent(&env).unwrap();
        assert!(parent.to_string_lossy().ends_with("\\Lockbox Vaults"));
        assert_eq!(parent.parent(), Some(profile.as_path()));
    }

    #[test]
    fn state_folder_is_local_app_data_lockbox() {
        let temp = TempDir::new();
        let env = FakeEnv::new(temp.path());
        let local = env.known_folder(KnownFolder::LocalAppData).unwrap();
        let paths = state_paths(&env).unwrap();
        assert_eq!(paths.root, local.join("Lockbox"));
        assert_eq!(paths.journal, paths.root.join("restore-journal.json"));
        assert_eq!(paths.registry, paths.root.join("vaults.json"));
        assert_eq!(paths.outputs, paths.root.join("pending-outputs.json"));
        assert_eq!(paths.settings, paths.root.join("settings.json"));
        assert_eq!(paths.open, paths.root.join("open"));
    }

    #[test]
    fn state_file_round_trip_makes_the_folder() {
        let temp = TempDir::new();
        let file = temp.path().join("state").join("sample.json");
        assert_eq!(read_state::<Sample>(&file, "sample"), Ok(None));
        let sample = Sample {
            version: StateVersion,
            items: vec![1, 2],
        };
        write_state(&file, &sample).unwrap();
        let written: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert_eq!(written, json!({ "version": 1, "items": [1, 2] }));
        assert_eq!(read_state::<Sample>(&file, "sample"), Ok(Some(sample)));
    }

    #[test]
    fn state_file_schema_is_strict_and_kept_when_refused() {
        let temp = TempDir::new();
        let file = temp.path().join("sample.json");
        for text in [
            r#"{ "version": 1, "items": [], "extra": true }"#, // unknown field
            r#"{ "version": 2, "items": [] }"#,                // another version
            r#"{ "items": [] }"#,                              // no version
            r#"{ "version": 1, "items": "x" }"#,               // wrong type
            "not json",
        ] {
            fs::write(&file, text).unwrap();
            assert_eq!(
                read_state::<Sample>(&file, "sample"),
                Err(damaged("sample")),
                "{text}"
            );
            assert_eq!(fs::read_to_string(&file).unwrap(), text, "the file is kept");
        }
    }

    #[test]
    fn state_file_over_one_mebibyte_is_damaged() {
        let temp = TempDir::new();
        let file = temp.path().join("sample.json");
        // Valid JSON, padded with spaces to one byte over the cap.
        let mut text = r#"{ "version": 1, "items": [] }"#.to_string();
        text.push_str(&" ".repeat(MAX_STATE_FILE as usize + 1 - text.len()));
        fs::write(&file, &text).unwrap();
        assert_eq!(
            read_state::<Sample>(&file, "sample"),
            Err(damaged("sample"))
        );
        // At the cap exactly, it is read.
        text.pop();
        fs::write(&file, &text).unwrap();
        assert!(read_state::<Sample>(&file, "sample").unwrap().is_some());
    }
}
