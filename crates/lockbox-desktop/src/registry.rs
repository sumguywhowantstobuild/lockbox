//! The vault list (spec §6.10): the folders of the vaults Lockbox knows, in `vaults.json` in the state folder.
//! Locations only, no secrets: `{ "version": 1, "vaults": [ { "id": <u32>, "path": "<absolute>" } ] }`. The page names
//! a vault by its ID; its path never leaves Rust.

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use lockbox_core::{CoreError, read_vault_name};
use serde::{Deserialize, Serialize};

use crate::error::{ShellError, ShellResult};
use crate::lock;
use crate::os::{Volumes, same_path};
use crate::paths::{StateVersion, read_state, write_state};

/// The most vaults the list holds.
pub const MAX_VAULTS: usize = 1000;

/// What `vaults.json` is called in errors.
const WHAT: &str = "vault list";

/// One vault as the page lists it. Never shows the name in `Debug` (R5).
#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct VaultEntry {
    pub id: u32,
    /// From the vault's header, read without the key; `None` when neither header copy can be read.
    pub name: Option<String>,
    /// Whether the folder is there (its drive connected).
    pub available: bool,
}

impl fmt::Debug for VaultEntry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("VaultEntry")
            .field("id", &self.id)
            .field("named", &self.name.is_some())
            .field("available", &self.available)
            .finish()
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistryFile {
    version: StateVersion,
    vaults: Vec<Stored>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stored {
    id: u32,
    path: PathBuf,
}

/// The vault list. Each change reads the file, changes it and writes it back while holding the list's own lock.
pub struct Registry {
    file: PathBuf,
    volumes: Arc<dyn Volumes>,
    edits: Mutex<()>,
}

impl Registry {
    pub fn new(file: PathBuf, volumes: Arc<dyn Volumes>) -> Registry {
        Registry {
            file,
            volumes,
            edits: Mutex::default(),
        }
    }

    /// Every vault on the list, in the order they were added. A damaged list is refused
    /// (`Core(Damaged { what: "vault list" })`), never shown as empty.
    pub fn list(&self) -> ShellResult<Vec<VaultEntry>> {
        Ok(self
            .load()?
            .into_iter()
            .map(|stored| self.entry(stored.id, &stored.path))
            .collect())
    }

    /// Adds the vault folder `path` (canonical) and returns its ID; a folder already on the list keeps its ID.
    /// `TooLarge` once the list holds [`MAX_VAULTS`]. A damaged list is refused and left as it is.
    pub fn add(&self, path: &Path) -> ShellResult<u32> {
        if !path.is_absolute() || path.to_str().is_none() {
            return Err(ShellError::InvalidInput { what: "folder" });
        }
        let _edit = lock(&self.edits);
        let mut vaults = self.load()?;
        if let Some(listed) = vaults.iter().find(|v| same_path(&v.path, path)) {
            return Ok(listed.id);
        }
        room_for_one(&vaults)?;
        // One more than the highest: an ID is not reused while a higher one is listed.
        let id = vaults
            .iter()
            .map(|v| v.id)
            .max()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or(ShellError::TooLarge { what: WHAT })?;
        vaults.push(Stored {
            id,
            path: path.to_path_buf(),
        });
        self.save(vaults)?;
        Ok(id)
    }

    /// Takes the vault `id` off the list (its folder is not touched). `NotFound` for an ID not on it.
    pub fn forget(&self, id: u32) -> ShellResult<()> {
        let _edit = lock(&self.edits);
        let mut vaults = self.load()?;
        let at = vaults
            .iter()
            .position(|v| v.id == id)
            .ok_or(ShellError::NotFound)?;
        vaults.remove(at);
        self.save(vaults)
    }

    /// The folder of the vault `id`; `None` when it is not on the list, or the list is damaged.
    pub fn path(&self, id: u32) -> Option<PathBuf> {
        self.load()
            .ok()?
            .into_iter()
            .find(|v| v.id == id)
            .map(|v| v.path)
    }

    /// Every vault's ID and folder; empty when the list is damaged.
    pub fn entries(&self) -> Vec<(u32, PathBuf)> {
        self.load()
            .unwrap_or_default()
            .into_iter()
            .map(|v| (v.id, v.path))
            .collect()
    }

    /// Refuses as [`add`](Self::add) would for a new folder, without adding one: checked before a vault is created,
    /// so a full or damaged list never leaves a new vault off it.
    pub fn check_room(&self) -> ShellResult<()> {
        room_for_one(&self.load()?)
    }

    /// One vault as the page lists it.
    pub fn entry(&self, id: u32, path: &Path) -> VaultEntry {
        VaultEntry {
            id,
            name: read_vault_name(path).ok(),
            available: self.volumes.exists(path).unwrap_or(false),
        }
    }

    /// The list on disk, checked: at most [`MAX_VAULTS`], IDs from 1 and each once, absolute paths. Empty when there
    /// is no file yet.
    fn load(&self) -> ShellResult<Vec<Stored>> {
        let Some(file) = read_state::<RegistryFile>(&self.file, WHAT)? else {
            return Ok(Vec::new());
        };
        let vaults = file.vaults;
        let mut ids: Vec<u32> = vaults.iter().map(|v| v.id).collect();
        ids.sort_unstable();
        ids.dedup();
        let valid = vaults.len() <= MAX_VAULTS
            && ids.len() == vaults.len()
            && ids.first().is_none_or(|&lowest| lowest >= 1)
            && vaults.iter().all(|v| v.path.is_absolute());
        match valid {
            true => Ok(vaults),
            false => Err(CoreError::Damaged { what: WHAT }.into()),
        }
    }

    fn save(&self, vaults: Vec<Stored>) -> ShellResult<()> {
        write_state(
            &self.file,
            &RegistryFile {
                version: StateVersion,
                vaults,
            },
        )
    }
}

fn room_for_one(vaults: &[Stored]) -> ShellResult<()> {
    match vaults.len() < MAX_VAULTS {
        true => Ok(()),
        false => Err(ShellError::TooLarge { what: WHAT }),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use lockbox_core::internals::fsio::testutil::TempDir;
    use lockbox_core::internals::header::{HEADER_BACKUP, HEADER_FILE};
    use serde_json::json;

    use super::*;
    use crate::testing::{FakeVolumes, heavy};

    fn registry(temp: &TempDir) -> Registry {
        Registry::new(
            temp.path().join("state").join("vaults.json"),
            Arc::new(FakeVolumes::default()),
        )
    }

    /// A new folder `name` in `temp`, canonical.
    fn folder(temp: &TempDir, name: &str) -> PathBuf {
        let dir = temp.path().join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(dir).unwrap()
    }

    fn damaged() -> ShellError {
        CoreError::Damaged { what: WHAT }.into()
    }

    fn entry(id: u32, name: Option<&str>, available: bool) -> VaultEntry {
        VaultEntry {
            id,
            name: name.map(str::to_owned),
            available,
        }
    }

    #[test]
    fn registry_round_trip_and_limits() {
        let temp = TempDir::new();
        let registry = registry(&temp);
        assert_eq!(registry.list(), Ok(vec![]), "no file yet: an empty list");
        let (a, b) = (folder(&temp, "a"), folder(&temp, "b"));
        assert_eq!(registry.add(&a), Ok(1));
        assert_eq!(registry.add(&b), Ok(2));
        // The same folder again, in another letter case, keeps its ID.
        let upper = PathBuf::from(a.to_string_lossy().to_uppercase());
        assert_eq!(registry.add(&upper), Ok(1));
        assert_eq!(
            registry.list(),
            Ok(vec![entry(1, None, true), entry(2, None, true)])
        );
        assert_eq!(registry.path(2), Some(b.clone()));
        assert_eq!(registry.path(3), None);
        assert_eq!(registry.entries(), vec![(1, a.clone()), (2, b.clone())]);

        // The file as written.
        let written: serde_json::Value =
            serde_json::from_slice(&fs::read(&registry.file).unwrap()).unwrap();
        assert_eq!(
            written,
            json!({ "version": 1, "vaults": [ { "id": 1, "path": a }, { "id": 2, "path": b } ] })
        );

        assert_eq!(registry.forget(1), Ok(()));
        assert_eq!(registry.forget(1), Err(ShellError::NotFound));
        assert_eq!(registry.entries(), vec![(2, b.clone())]);
        // IDs are not reused while a higher one is listed.
        assert_eq!(registry.add(&a), Ok(3));

        // A missing folder is listed as unavailable.
        fs::remove_dir(&b).unwrap();
        assert_eq!(registry.list().unwrap()[0], entry(2, None, false));
    }

    #[test]
    fn registry_full_at_a_thousand() {
        let temp = TempDir::new();
        let registry = registry(&temp);
        let vaults: Vec<_> = (1..=MAX_VAULTS as u32)
            .map(|id| json!({ "id": id, "path": temp.path().join(format!("v{id}")) }))
            .collect();
        fs::create_dir_all(registry.file.parent().unwrap()).unwrap();
        fs::write(
            &registry.file,
            json!({ "version": 1, "vaults": vaults }).to_string(),
        )
        .unwrap();
        assert_eq!(registry.list().unwrap().len(), MAX_VAULTS);
        let full = ShellError::TooLarge { what: WHAT };
        assert_eq!(registry.check_room(), Err(full));
        assert_eq!(registry.add(&folder(&temp, "one more")), Err(full));
        // A folder already listed is still found.
        assert_eq!(registry.add(&temp.path().join("v7")), Ok(7));
    }

    #[test]
    fn damaged_registry_refused_and_kept() {
        let temp = TempDir::new();
        let registry = registry(&temp);
        fs::create_dir_all(registry.file.parent().unwrap()).unwrap();
        let a = temp.path().join("a");
        let too_many: Vec<_> = (1..=MAX_VAULTS as u32 + 1)
            .map(|id| json!({ "id": id, "path": temp.path().join(format!("v{id}")) }))
            .collect();
        for text in [
            json!({ "version": 1, "vaults": [], "extra": 1 }).to_string(), // unknown field
            json!({ "version": 1, "vaults": [ { "id": 1, "path": a, "name": "x" } ] }).to_string(),
            json!({ "version": 2, "vaults": [] }).to_string(),
            json!({ "version": 1, "vaults": [ { "id": 1, "path": "relative" } ] }).to_string(),
            json!({ "version": 1, "vaults": [ { "id": 0, "path": a } ] }).to_string(),
            json!({ "version": 1, "vaults": [ { "id": 1, "path": a }, { "id": 1, "path": a } ] })
                .to_string(),
            json!({ "version": 1, "vaults": too_many }).to_string(),
            "{".to_string(),
        ] {
            fs::write(&registry.file, &text).unwrap();
            assert_eq!(registry.list(), Err(damaged()), "{text}");
            assert_eq!(registry.add(&folder(&temp, "b")), Err(damaged()), "{text}");
            assert_eq!(registry.forget(1), Err(damaged()), "{text}");
            assert_eq!(registry.check_room(), Err(damaged()), "{text}");
            assert_eq!(registry.path(1), None);
            assert_eq!(registry.entries(), vec![]);
            assert_eq!(
                fs::read_to_string(&registry.file).unwrap(),
                text,
                "file kept"
            );
        }
    }

    #[test]
    fn registry_lists_unreadable_vault_without_name() {
        let temp = TempDir::new();
        let registry = registry(&temp);
        let vaults = folder(&temp, "vaults");
        let (good, bad) = heavy(|| {
            let good = lockbox_core::Vault::create(&vaults, "Family", "correct horse battery")
                .unwrap()
                .vault;
            let bad = lockbox_core::Vault::create(&vaults, "Work", "correct horse battery")
                .unwrap()
                .vault;
            (good.dir().to_path_buf(), bad.dir().to_path_buf())
        });
        fs::write(bad.join(HEADER_FILE), b"damaged").unwrap();
        fs::write(bad.join(HEADER_BACKUP), b"damaged").unwrap();
        registry.add(&fs::canonicalize(&good).unwrap()).unwrap();
        registry.add(&fs::canonicalize(&bad).unwrap()).unwrap();
        assert_eq!(
            registry.list(),
            Ok(vec![entry(1, Some("Family"), true), entry(2, None, true)])
        );
    }
}
