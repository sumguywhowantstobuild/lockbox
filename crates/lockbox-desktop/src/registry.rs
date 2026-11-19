//! The vault list (spec §6.10): the folders of the vaults Lockbox knows, in `vaults.json` in the state folder.
//! Locations only, no secrets: `{ "version": 2, "list": <u64>, "last_id": <u32>, "vaults": [ { "id": <u32>, "path":
//! "<absolute>" } ] }`. `list` is the list's own random identity and `last_id` the highest ID the list ever gave, so an
//! ID is never given twice within a list, and a row of an older list (before "Start a new list") names nothing on a new
//! one. The page names a vault by [`VaultRef`] (the identity and the ID); its path never leaves Rust. Version 1 (no
//! identity, no mark) is read, and rewritten as version 2 at its first read.

use std::fmt;
use std::io;
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::{Arc, Mutex, MutexGuard};

use lockbox_core::fsio::{is_destination_taken, rename_file_no_replace};
use lockbox_core::{CoreError, header_is_damaged, read_vault_name};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::error::{ShellError, ShellResult};
use crate::lock;
use crate::os::{Volumes, same_path};
use crate::paths::{StateVersion, read_state, write_state};

/// The most vaults the list holds.
pub const MAX_VAULTS: usize = 1000;

/// What `vaults.json` is called in errors.
const WHAT: &str = "vault list";

/// The largest list identity, 2^53 - 1: a JavaScript number carries every whole number up to it exactly.
const MAX_LIST: u64 = (1 << 53) - 1;

/// How many damaged lists are kept aside (`vaults.damaged.json`, then `vaults.damaged-2.json` to `-100`).
const MAX_SET_ASIDE: u32 = 100;

/// The refusal of a list that is there but cannot be used.
fn damaged_list() -> ShellError {
    CoreError::Damaged { what: WHAT }.into()
}

/// A row of the vault list as the page names it (Task 9): the list's identity and the vault's ID on it. A row from
/// another list (before Ask 12's reset) or an ID no longer listed is `NotFound`. Numbers only, so `Debug` is safe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VaultRef {
    pub list: u64,
    pub id: u32,
}

/// One vault as the page lists it. Never shows the name in `Debug` (R5).
#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct VaultEntry {
    /// The identity of the list this entry was read from (see [`VaultRef`]).
    pub list: u64,
    pub id: u32,
    /// From the vault's header, read without the key; `None` when neither header copy can be read.
    pub name: Option<String>,
    /// Whether the folder is there (its drive connected).
    pub available: bool,
    /// The folder holds the vault's header files but neither copy can be read, so no password can open it (Ask 8). False
    /// for a folder with no vault in it or no header files, though it too has no name.
    pub details_damaged: bool,
}

impl fmt::Debug for VaultEntry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("VaultEntry")
            .field("list", &self.list)
            .field("id", &self.id)
            .field("named", &self.name.is_some())
            .field("available", &self.available)
            .field("details_damaged", &self.details_damaged)
            .finish()
    }
}

/// The `"version"` of the list as it is written now: `2`, and only `2` is read as that shape. (`StateVersion`, which the
/// other state files use, is `1` only.)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct VersionTwo;

impl Serialize for VersionTwo {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u32(2)
    }
}

impl<'de> Deserialize<'de> for VersionTwo {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match u32::deserialize(deserializer)? {
            2 => Ok(VersionTwo),
            _ => Err(serde::de::Error::custom("vault list version")),
        }
    }
}

/// The list as version 1 wrote it: no identity, no high-water mark.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileV1 {
    #[serde(rename = "version")]
    _version: StateVersion,
    vaults: Vec<Stored>,
}

/// The list as it is read when it is version 2.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileV2 {
    #[serde(rename = "version")]
    _version: VersionTwo,
    list: u64,
    last_id: u32,
    vaults: Vec<Stored>,
}

/// Either shape: a file that is neither (a version 2 file without `list` or `last_id` included) is damaged.
#[derive(Deserialize)]
#[serde(untagged)]
enum ListFile {
    V2(FileV2),
    V1(FileV1),
}

/// The list as it is written: always version 2.
#[derive(Serialize)]
struct WrittenFile<'a> {
    version: VersionTwo,
    list: u64,
    last_id: u32,
    vaults: &'a [Stored],
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stored {
    id: u32,
    path: PathBuf,
}

/// The list as read and checked. `list` is `None` only when there is no file yet: the first add draws one.
struct Loaded {
    list: Option<u64>,
    last_id: u32,
    vaults: Vec<Stored>,
}

/// A new list identity: 8 bytes from the OS random source, masked to 53 bits, drawn again on 0.
fn new_identity() -> ShellResult<u64> {
    loop {
        let mut bytes = [0u8; 8];
        getrandom::fill(&mut bytes).map_err(|_| io::Error::other("no random bytes"))?;
        let list = u64::from_le_bytes(bytes) & MAX_LIST;
        if list != 0 {
            return Ok(list);
        }
    }
}

/// Whether the folder `path` holds the header files of a vault but neither copy can be read (Ask 8): the engine says
/// so, not a folder with no vault in it, and not a header another program is holding or the disk would not give up.
pub fn details_damaged(path: &Path) -> bool {
    read_vault_name(path).is_err() && header_is_damaged(path)
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
        let Loaded { list, vaults, .. } = self.load()?;
        // An empty list has no entry to carry an identity.
        let Some(list) = list else {
            return Ok(Vec::new());
        };
        Ok(vaults
            .into_iter()
            .map(|stored| {
                self.entry(
                    VaultRef {
                        list,
                        id: stored.id,
                    },
                    &stored.path,
                )
            })
            .collect())
    }

    /// Adds the vault folder `path` (canonical: a local drive's verbatim path, `\\?\C:\..`) and returns its place on the
    /// list; a folder already on the list keeps its ID. A new ID is one more than the highest the list ever gave
    /// (`last_id`), saved in the same write. `TooLarge` once the list holds [`MAX_VAULTS`], or when it would grow
    /// larger than it can be read back. A damaged list is refused and left as it is.
    pub fn add(&self, path: &Path) -> ShellResult<VaultRef> {
        if !on_local_drive(path) || path.to_str().is_none() {
            return Err(ShellError::InvalidInput { what: "folder" });
        }
        let edit = lock(&self.edits);
        let Loaded {
            list,
            last_id,
            mut vaults,
        } = self.load_locked(&edit)?;
        let list = match list {
            Some(list) => list,
            None => new_identity()?,
        };
        if let Some(listed) = vaults.iter().find(|v| same_path(&v.path, path)) {
            return Ok(VaultRef {
                list,
                id: listed.id,
            });
        }
        room_for_one(&vaults)?;
        // One more than the highest ever given: an ID is never reused, whatever was removed since.
        let id = last_id
            .checked_add(1)
            .ok_or(ShellError::TooLarge { what: WHAT })?;
        vaults.push(Stored {
            id,
            path: path.to_path_buf(),
        });
        self.save(list, id, &vaults)?;
        Ok(VaultRef { list, id })
    }

    /// Takes the vault `vault` off the list (its folder is not touched; the high-water mark stays, so its ID is not
    /// given again). `NotFound` for a row of another list or an ID not on it.
    pub fn forget(&self, vault: VaultRef) -> ShellResult<()> {
        let edit = lock(&self.edits);
        let Loaded {
            list,
            last_id,
            mut vaults,
        } = self.load_locked(&edit)?;
        if list != Some(vault.list) {
            return Err(ShellError::NotFound);
        }
        let at = vaults
            .iter()
            .position(|v| v.id == vault.id)
            .ok_or(ShellError::NotFound)?;
        vaults.remove(at);
        self.save(vault.list, last_id, &vaults)
    }

    /// Starts the vault list over when it is damaged (the first screen's "Start a new list", Ask 12): the damaged file
    /// is moved, never deleted, to `vaults.damaged.json` in the same folder (`vaults.damaged-2.json`, `-3`, ... when that
    /// name is taken, up to `-100`: `TooLarge` once all are), and a new, empty list is written in its place. The page
    /// then adds each vault back.
    ///
    /// It acts only on a list that is damaged (`Core(Damaged { what: "vault list" })`): a list that reads fine, or no
    /// list yet, is refused (`InvalidInput`) and nothing is touched, and so is a list that could not be read for any
    /// other reason (a program holding it): that one may be fine. The move never replaces anything (the engine's
    /// no-replace move, so a file that appears at a name is never overwritten); a name that is taken moves on to the
    /// next. If the move fails, nothing has changed and the error comes back. If the move worked and the new list could
    /// not be written, the error comes back and the list reads as empty (no file), as the new one would have.
    pub fn start_new_list(&self) -> ShellResult<()> {
        let edit = lock(&self.edits);
        match self.load_locked(&edit) {
            Err(error) if error == damaged_list() => {}
            Err(error) => return Err(error),
            Ok(_) => return Err(ShellError::InvalidInput { what: WHAT }),
        }
        // The new list is its own list: a new identity, so a row of the old one names nothing on it. Drawn before
        // anything moves, so a random source that fails changes nothing.
        let list = new_identity()?;
        let stem = self
            .file
            .file_stem()
            .ok_or(ShellError::InvalidInput { what: WHAT })?
            .to_string_lossy();
        for n in 1..=MAX_SET_ASIDE {
            let name = match n {
                1 => format!("{stem}.damaged.json"),
                n => format!("{stem}.damaged-{n}.json"),
            };
            match rename_file_no_replace(&self.file, &self.file.with_file_name(name)) {
                Ok(()) => return self.save(list, 0, &[]),
                Err(error) if is_destination_taken(&error) => {}
                Err(error) => return Err(error.into()),
            }
        }
        Err(ShellError::TooLarge {
            what: "damaged vault lists",
        })
    }

    /// The folder of the vault `id`; `None` when it is not on the list, or the list is damaged.
    pub fn path(&self, id: u32) -> Option<PathBuf> {
        self.load()
            .ok()?
            .vaults
            .into_iter()
            .find(|v| v.id == id)
            .map(|v| v.path)
    }

    /// The folder of the row `vault`; `None` for a row of another list, an ID not on the list, or a damaged list.
    pub fn path_of(&self, vault: VaultRef) -> Option<PathBuf> {
        let loaded = self.load().ok()?;
        if loaded.list != Some(vault.list) {
            return None;
        }
        loaded
            .vaults
            .into_iter()
            .find(|v| v.id == vault.id)
            .map(|v| v.path)
    }

    /// Every vault's ID and folder; empty when the list is damaged.
    pub fn entries(&self) -> Vec<(u32, PathBuf)> {
        self.load()
            .map(|loaded| loaded.vaults)
            .unwrap_or_default()
            .into_iter()
            .map(|v| (v.id, v.path))
            .collect()
    }

    /// Tests only: the row for the vault `id` on the list as it is now, whether the ID is listed or not.
    #[cfg(test)]
    pub fn vault_ref(&self, id: u32) -> VaultRef {
        let list = self.load().unwrap().list.unwrap_or(1);
        VaultRef { list, id }
    }

    /// Refuses as [`add`](Self::add) would for a new folder, without adding one: checked before a vault is created,
    /// so a full or damaged list never leaves a new vault off it.
    pub fn check_room(&self) -> ShellResult<()> {
        room_for_one(&self.load()?.vaults)
    }

    /// One vault as the page lists it: the row `vault` and its folder `path`.
    pub fn entry(&self, vault: VaultRef, path: &Path) -> VaultEntry {
        let name = read_vault_name(path).ok();
        // Damaged is what the engine says of the header files (corrupt or too large, every copy that is there): not a
        // folder with no vault in it, and not a header another program is holding or the disk would not give up.
        let details_damaged = name.is_none() && header_is_damaged(path);
        VaultEntry {
            list: vault.list,
            id: vault.id,
            name,
            available: self.volumes.exists(path).unwrap_or(false),
            details_damaged,
        }
    }

    /// [`load_locked`](Self::load_locked) under the list's own lock, for a caller that holds none.
    fn load(&self) -> ShellResult<Loaded> {
        let edit = lock(&self.edits);
        self.load_locked(&edit)
    }

    /// The list on disk, checked: version 1 or 2 and nothing else, at most [`MAX_VAULTS`], IDs from 1 and each once,
    /// every path a local drive's verbatim path as `add` stores it (a network share or device path from a tampered
    /// file would be opened by every `list`); for version 2 also an identity in `1..=2^53-1` and a high-water mark no
    /// lower than any listed ID. Empty when there is no file yet.
    ///
    /// A version 1 list gets its identity and its mark (the highest listed ID) here, and is rewritten as version 2
    /// before anything is answered, so every caller from then on sees one identity. A rewrite that fails answers its
    /// error and leaves the version 1 file as it was; the next read tries again. `_edit` is the list's lock, held by
    /// the caller.
    fn load_locked(&self, _edit: &MutexGuard<'_, ()>) -> ShellResult<Loaded> {
        let Some(file) = read_state::<ListFile>(&self.file, WHAT)? else {
            return Ok(Loaded {
                list: None,
                last_id: 0,
                vaults: Vec::new(),
            });
        };
        let (list, last_id, vaults) = match file {
            ListFile::V2(file) => (Some(file.list), file.last_id, file.vaults),
            ListFile::V1(file) => (None, 0, file.vaults),
        };
        let highest = vaults.iter().map(|v| v.id).max().unwrap_or(0);
        let mut ids: Vec<u32> = vaults.iter().map(|v| v.id).collect();
        ids.sort_unstable();
        ids.dedup();
        let valid = vaults.len() <= MAX_VAULTS
            && ids.len() == vaults.len()
            && ids.first().is_none_or(|&lowest| lowest >= 1)
            && vaults.iter().all(|v| on_local_drive(&v.path))
            && list.is_none_or(|list| (1..=MAX_LIST).contains(&list))
            && (list.is_none() || last_id >= highest);
        if !valid {
            return Err(damaged_list());
        }
        match list {
            Some(list) => Ok(Loaded {
                list: Some(list),
                last_id,
                vaults,
            }),
            None => {
                let list = new_identity()?;
                self.save(list, highest, &vaults)?;
                Ok(Loaded {
                    list: Some(list),
                    last_id: highest,
                    vaults,
                })
            }
        }
    }

    fn save(&self, list: u64, last_id: u32, vaults: &[Stored]) -> ShellResult<()> {
        write_state(
            &self.file,
            &WrittenFile {
                version: VersionTwo,
                list,
                last_id,
                vaults,
            },
            WHAT,
        )
    }
}

/// Whether `path` starts with a local drive's verbatim prefix (`\\?\C:\`), the form `fs::canonicalize` gives a
/// folder on a lettered drive: not a share (`\\server\..`, `\\?\UNC\..`), a device or volume path, or a plain one.
fn on_local_drive(path: &Path) -> bool {
    matches!(
        path.components().next(),
        Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::VerbatimDisk(_))
    ) && path.is_absolute()
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
    use crate::paths::MAX_STATE_FILE;
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

    /// The list's identity as the file holds it.
    fn identity(registry: &Registry) -> u64 {
        let written: serde_json::Value =
            serde_json::from_slice(&fs::read(&registry.file).unwrap()).unwrap();
        written["list"].as_u64().expect("a whole number")
    }

    /// The row `id` on the list as it is now.
    fn row(registry: &Registry, id: u32) -> VaultRef {
        VaultRef {
            list: identity(registry),
            id,
        }
    }

    fn entry(list: u64, id: u32, name: Option<&str>, available: bool) -> VaultEntry {
        VaultEntry {
            list,
            id,
            name: name.map(str::to_owned),
            available,
            details_damaged: false,
        }
    }

    #[test]
    fn registry_round_trip_and_limits() {
        let temp = TempDir::new();
        let registry = registry(&temp);
        assert_eq!(registry.list(), Ok(vec![]), "no file yet: an empty list");
        let (a, b) = (folder(&temp, "a"), folder(&temp, "b"));
        let first = registry.add(&a).unwrap();
        assert_eq!(first.id, 1);
        let list = first.list;
        assert!((1..=MAX_LIST).contains(&list), "a safe whole number");
        assert_eq!(registry.add(&b), Ok(VaultRef { list, id: 2 }));
        // The same folder again, in another letter case or with a trailing separator, keeps its ID.
        let upper = PathBuf::from(a.to_string_lossy().to_uppercase());
        assert_eq!(registry.add(&upper), Ok(first));
        let trailing = PathBuf::from(format!("{}\\", a.display()));
        assert_eq!(registry.add(&trailing), Ok(first));
        assert_eq!(
            registry.list(),
            Ok(vec![entry(list, 1, None, true), entry(list, 2, None, true)])
        );
        assert_eq!(registry.path(2), Some(b.clone()));
        assert_eq!(registry.path(3), None);
        assert_eq!(registry.entries(), vec![(1, a.clone()), (2, b.clone())]);
        assert_eq!(registry.path_of(VaultRef { list, id: 2 }), Some(b.clone()));
        assert_eq!(registry.path_of(VaultRef { list, id: 3 }), None);

        // The file as written: version 2, the list's identity and the high-water mark.
        let written: serde_json::Value =
            serde_json::from_slice(&fs::read(&registry.file).unwrap()).unwrap();
        assert_eq!(
            written,
            json!({ "version": 2, "list": list, "last_id": 2,
                    "vaults": [ { "id": 1, "path": a }, { "id": 2, "path": b } ] })
        );

        assert_eq!(registry.forget(first), Ok(()));
        assert_eq!(registry.forget(first), Err(ShellError::NotFound));
        assert_eq!(registry.entries(), vec![(2, b.clone())]);
        // An ID is given once: removing the first and adding again gives a new one, never 1 or 2 again.
        assert_eq!(registry.add(&a), Ok(VaultRef { list, id: 3 }));

        // A missing folder is listed as unavailable.
        fs::remove_dir(&b).unwrap();
        assert_eq!(registry.list().unwrap()[0], entry(list, 2, None, false));

        // Only a local drive's canonical (verbatim) path is added (fix round 1, F10).
        for path in [
            r"C:\Vaults\v",
            r"\\server\share\v",
            r"\\?\UNC\server\share\v",
        ] {
            assert_eq!(
                registry.add(Path::new(path)),
                Err(ShellError::InvalidInput { what: "folder" }),
                "{path}"
            );
        }
    }

    #[test]
    fn registry_full_at_a_thousand() {
        let temp = TempDir::new();
        let registry = registry(&temp);
        let base = fs::canonicalize(temp.path()).unwrap();
        let vaults: Vec<_> = (1..=MAX_VAULTS as u32)
            .map(|id| json!({ "id": id, "path": base.join(format!("v{id}")) }))
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
        assert_eq!(registry.add(&base.join("v7")).map(|v| v.id), Ok(7));
    }

    /// Fix round 1 (F6): an add that would make the list larger than it can be read back is refused, and the list
    /// stays as it was. The list is filled with long paths (Windows allows about 32,000 characters).
    #[test]
    fn registry_never_grows_past_what_it_reads() {
        let temp = TempDir::new();
        let registry = registry(&temp);
        let base = fs::canonicalize(temp.path()).unwrap();
        let long = |at: usize| base.join(format!("{at:04}{}", "x".repeat(2000)));
        let size = |count: usize| {
            let vaults = (0..count)
                .map(|at| Stored {
                    id: at as u32 + 1,
                    path: long(at),
                })
                .collect::<Vec<_>>();
            let file = WrittenFile {
                version: VersionTwo,
                list: 1,
                last_id: count as u32,
                vaults: &vaults,
            };
            (serde_json::to_vec_pretty(&file).unwrap().len(), vaults)
        };
        // A few entries short of the cap, written through the list's own save.
        let (one, _) = size(1);
        let each = size(2).0 - one;
        let seeded = (MAX_STATE_FILE as usize - one) / each - 3;
        let (_, vaults) = size(seeded);
        registry.save(1, seeded as u32, &vaults).unwrap();
        let mut added = seeded;
        let refused = loop {
            match registry.add(&long(added)) {
                Ok(_) => added += 1,
                Err(e) => break e,
            }
            assert!(added < seeded + 10, "never refused");
        };
        assert_eq!(refused, ShellError::TooLarge { what: WHAT });
        assert!(added < MAX_VAULTS, "refused for its size, not its count");
        let before = fs::read(&registry.file).unwrap();
        assert!(before.len() as u64 <= MAX_STATE_FILE);
        assert_eq!(registry.list().unwrap().len(), added, "still readable");
        assert_eq!(registry.add(&long(added)), Err(refused));
        assert_eq!(fs::read(&registry.file).unwrap(), before, "file kept");
    }

    #[test]
    fn damaged_registry_refused_and_kept() {
        let temp = TempDir::new();
        let registry = registry(&temp);
        fs::create_dir_all(registry.file.parent().unwrap()).unwrap();
        let base = fs::canonicalize(temp.path()).unwrap();
        let a = base.join("a");
        let too_many: Vec<_> = (1..=MAX_VAULTS as u32 + 1)
            .map(|id| json!({ "id": id, "path": base.join(format!("v{id}")) }))
            .collect();
        // Fix round 1 (F10): only a local drive's verbatim path (`\\?\C:\..`), as `add` stores it. A network share
        // or a device path would be opened by every `list`.
        let elsewhere = [
            r"C:\Vaults\v",
            r"\\server\share\v",
            r"\\?\UNC\server\share\v",
            r"\\.\C:\Vaults\v",
            r"\\?\Volume{00000000-0000-0000-0000-000000000000}\v",
        ]
        .map(|path| json!({ "version": 1, "vaults": [ { "id": 1, "path": path } ] }).to_string());
        for text in [
            json!({ "version": 1, "vaults": [], "extra": 1 }).to_string(), // unknown field
            json!({ "version": 1, "vaults": [ { "id": 1, "path": a, "name": "x" } ] }).to_string(),
            json!({ "version": 2, "vaults": [] }).to_string(), // no identity, no mark
            json!({ "version": 2, "last_id": 0, "vaults": [] }).to_string(),
            json!({ "version": 2, "list": 5, "vaults": [] }).to_string(),
            json!({ "version": 2, "list": 0, "last_id": 0, "vaults": [] }).to_string(),
            json!({ "version": 2, "list": MAX_LIST + 1, "last_id": 0, "vaults": [] }).to_string(),
            json!({ "version": 2, "list": -4, "last_id": 0, "vaults": [] }).to_string(),
            json!({ "version": 2, "list": "5", "last_id": 0, "vaults": [] }).to_string(),
            json!({ "version": 2, "list": 5, "last_id": 0, "vaults": [], "extra": 1 }).to_string(),
            // A mark below a listed ID.
            json!({ "version": 2, "list": 5, "last_id": 1,
                    "vaults": [ { "id": 1, "path": a }, { "id": 2, "path": a } ] })
            .to_string(),
            // Version 2's own fields in a version 1 file, and a version that is neither.
            json!({ "version": 1, "list": 5, "last_id": 0, "vaults": [] }).to_string(),
            json!({ "version": 3, "list": 5, "last_id": 0, "vaults": [] }).to_string(),
            json!({ "version": 1, "vaults": [ { "id": 1, "path": "relative" } ] }).to_string(),
            json!({ "version": 1, "vaults": [ { "id": 0, "path": a } ] }).to_string(),
            json!({ "version": 1, "vaults": [ { "id": 1, "path": a }, { "id": 1, "path": a } ] })
                .to_string(),
            json!({ "version": 1, "vaults": too_many }).to_string(),
            json!({ "version": 2, "list": 5, "last_id": 5,
                    "vaults": [ { "id": 1, "path": a }, { "id": 1, "path": a } ] })
            .to_string(),
            "{".to_string(),
        ]
        .into_iter()
        .chain(elsewhere)
        {
            fs::write(&registry.file, &text).unwrap();
            assert_eq!(registry.list(), Err(damaged()), "{text}");
            assert_eq!(registry.add(&folder(&temp, "b")), Err(damaged()), "{text}");
            assert_eq!(
                registry.forget(VaultRef { list: 5, id: 1 }),
                Err(damaged()),
                "{text}"
            );
            assert_eq!(registry.path_of(VaultRef { list: 5, id: 1 }), None);
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

    /// What a damaged list looks like on disk in these tests: not JSON, and not even UTF-8, so a set-aside copy has to
    /// be the very bytes and not a re-written text.
    const DAMAGED_BYTES: &[u8] = b"{ \"version\": 1, \xff\xfe damaged";

    /// The list file written with `bytes`, its folder made first.
    fn write_list(registry: &Registry, bytes: &[u8]) {
        fs::create_dir_all(registry.file.parent().unwrap()).unwrap();
        fs::write(&registry.file, bytes).unwrap();
    }

    /// Where a set-aside copy goes: next to the list, `vaults.damaged.json`, then `vaults.damaged-2.json`, ...
    fn aside(registry: &Registry, name: &str) -> PathBuf {
        registry.file.with_file_name(name)
    }

    #[test]
    fn start_new_list_sets_a_damaged_list_aside_and_starts_empty() {
        let temp = TempDir::new();
        let registry = registry(&temp);
        write_list(&registry, DAMAGED_BYTES);
        assert_eq!(registry.list(), Err(damaged()));

        assert_eq!(registry.start_new_list(), Ok(()));

        // The damaged file was moved, not deleted and not rewritten: its exact bytes are at the new name.
        assert_eq!(
            fs::read(aside(&registry, "vaults.damaged.json")).unwrap(),
            DAMAGED_BYTES
        );
        // A new, empty list is where the old one was, and reads as a list.
        let written: serde_json::Value =
            serde_json::from_slice(&fs::read(&registry.file).unwrap()).unwrap();
        let list = written["list"].as_u64().expect("a new identity");
        assert!((1..=MAX_LIST).contains(&list));
        assert_eq!(
            written,
            json!({ "version": 2, "list": list, "last_id": 0, "vaults": [] })
        );
        assert_eq!(registry.list(), Ok(vec![]));
        assert_eq!(registry.entries(), vec![]);
        // And it takes vaults again (the first screen's "I already have a vault"): IDs start again, under the new
        // identity.
        assert_eq!(
            registry.add(&folder(&temp, "back")),
            Ok(VaultRef { list, id: 1 })
        );
        // The folder holds the list and the one set aside, and nothing else (no temp file left).
        let mut names: Vec<String> = fs::read_dir(registry.file.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["vaults.damaged.json", "vaults.json"]);
    }

    #[test]
    fn a_second_damage_goes_to_the_next_name_and_the_first_is_kept() {
        let temp = TempDir::new();
        let registry = registry(&temp);
        write_list(&registry, DAMAGED_BYTES);
        registry.start_new_list().unwrap();

        let second: &[u8] = b"second damage \x00\x01";
        fs::write(&registry.file, second).unwrap();
        assert_eq!(registry.start_new_list(), Ok(()));
        assert_eq!(
            fs::read(aside(&registry, "vaults.damaged.json")).unwrap(),
            DAMAGED_BYTES,
            "the first one is kept as it was"
        );
        assert_eq!(
            fs::read(aside(&registry, "vaults.damaged-2.json")).unwrap(),
            second
        );
        assert_eq!(registry.list(), Ok(vec![]));

        let third: &[u8] = b"third";
        fs::write(&registry.file, third).unwrap();
        assert_eq!(registry.start_new_list(), Ok(()));
        assert_eq!(
            fs::read(aside(&registry, "vaults.damaged-3.json")).unwrap(),
            third
        );
        assert_eq!(
            fs::read(aside(&registry, "vaults.damaged-2.json")).unwrap(),
            second
        );
    }

    /// A name that is taken by something else (a file Lockbox did not make, even a folder) is never replaced: the
    /// move goes on to the next name.
    #[test]
    fn a_taken_name_is_never_replaced() {
        let temp = TempDir::new();
        let registry = registry(&temp);
        write_list(&registry, DAMAGED_BYTES);
        fs::write(aside(&registry, "vaults.damaged.json"), b"someone else's").unwrap();
        fs::create_dir(aside(&registry, "vaults.damaged-2.json")).unwrap();

        assert_eq!(registry.start_new_list(), Ok(()));
        assert_eq!(
            fs::read(aside(&registry, "vaults.damaged.json")).unwrap(),
            b"someone else's"
        );
        assert!(aside(&registry, "vaults.damaged-2.json").is_dir());
        assert_eq!(
            fs::read(aside(&registry, "vaults.damaged-3.json")).unwrap(),
            DAMAGED_BYTES
        );
    }

    /// Only the first hundred names are tried; with all of them taken the damaged list stays where it is.
    #[test]
    fn all_names_taken_refuses_and_changes_nothing() {
        let temp = TempDir::new();
        let registry = registry(&temp);
        write_list(&registry, DAMAGED_BYTES);
        fs::write(aside(&registry, "vaults.damaged.json"), b"x").unwrap();
        for n in 2..=100 {
            fs::write(aside(&registry, &format!("vaults.damaged-{n}.json")), b"x").unwrap();
        }
        assert_eq!(
            registry.start_new_list(),
            Err(ShellError::TooLarge {
                what: "damaged vault lists"
            })
        );
        assert_eq!(fs::read(&registry.file).unwrap(), DAMAGED_BYTES);
        assert!(!aside(&registry, "vaults.damaged-101.json").exists());
    }

    #[test]
    fn a_good_list_is_refused_and_left_alone() {
        let temp = TempDir::new();
        let registry = registry(&temp);
        let first = registry.add(&folder(&temp, "a")).unwrap();
        let second = registry.add(&folder(&temp, "b")).unwrap();
        let before = fs::read(&registry.file).unwrap();
        assert_eq!(
            registry.start_new_list(),
            Err(ShellError::InvalidInput { what: WHAT })
        );
        assert_eq!(fs::read(&registry.file).unwrap(), before, "bytes equal");
        assert!(!aside(&registry, "vaults.damaged.json").exists());
        assert_eq!(registry.list().unwrap().len(), 2);

        // An empty list that reads fine is a good list as well.
        registry.forget(first).unwrap();
        registry.forget(second).unwrap();
        let empty = fs::read(&registry.file).unwrap();
        assert_eq!(
            registry.start_new_list(),
            Err(ShellError::InvalidInput { what: WHAT })
        );
        assert_eq!(fs::read(&registry.file).unwrap(), empty);
        assert!(!aside(&registry, "vaults.damaged.json").exists());
    }

    #[test]
    fn no_list_file_is_refused_and_none_is_made() {
        let temp = TempDir::new();
        let registry = registry(&temp);
        assert_eq!(
            registry.start_new_list(),
            Err(ShellError::InvalidInput { what: WHAT })
        );
        assert!(!registry.file.exists(), "no file made");
        assert!(
            !registry.file.parent().unwrap().exists(),
            "not even the state folder"
        );

        // With the folder there but no file: the same.
        fs::create_dir_all(registry.file.parent().unwrap()).unwrap();
        assert_eq!(
            registry.start_new_list(),
            Err(ShellError::InvalidInput { what: WHAT })
        );
        assert_eq!(
            fs::read_dir(registry.file.parent().unwrap())
                .unwrap()
                .count(),
            0
        );
    }

    /// Every way a list can be damaged (the ones `load` refuses) can be started over, not only unreadable bytes.
    #[test]
    fn every_kind_of_damage_can_be_started_over() {
        let temp = TempDir::new();
        let registry = registry(&temp);
        let base = fs::canonicalize(temp.path()).unwrap();
        let a = base.join("a");
        for text in [
            json!({ "version": 1, "vaults": [], "extra": 1 }).to_string(),
            json!({ "version": 2, "vaults": [] }).to_string(),
            json!({ "version": 2, "list": 0, "last_id": 0, "vaults": [] }).to_string(),
            json!({ "version": 1, "vaults": [ { "id": 0, "path": a } ] }).to_string(),
            json!({ "version": 1, "vaults": [ { "id": 1, "path": r"\\server\share\v" } ] })
                .to_string(),
            "{".to_string(),
            String::new(),
        ] {
            write_list(&registry, text.as_bytes());
            assert_eq!(registry.list(), Err(damaged()), "{text}");
            assert_eq!(registry.start_new_list(), Ok(()), "{text}");
            assert_eq!(registry.list(), Ok(vec![]), "{text}");
            // Cleared away for the next round, so the names do not run out.
            for n in 1..=100 {
                let name = match n {
                    1 => "vaults.damaged.json".to_string(),
                    n => format!("vaults.damaged-{n}.json"),
                };
                let _ = fs::remove_file(aside(&registry, &name));
            }
        }
    }

    /// A list that cannot be read for another reason than damage (here a program holding it so it cannot be opened for
    /// reading, though it could be moved) is not set aside: it may be fine.
    #[test]
    fn a_list_that_is_held_open_is_not_taken_for_damaged() {
        use std::fs::OpenOptions;
        use std::os::windows::fs::OpenOptionsExt;

        let temp = TempDir::new();
        let registry = registry(&temp);
        write_list(&registry, DAMAGED_BYTES);
        // Delete sharing only: a move would work, a read does not.
        let held = OpenOptions::new()
            .read(true)
            .share_mode(4)
            .open(&registry.file)
            .unwrap();
        let refused = registry.start_new_list().unwrap_err();
        assert_ne!(refused, damaged());
        assert!(matches!(&refused, ShellError::Core(view) if view.kind == "io"));
        drop(held);
        assert_eq!(fs::read(&registry.file).unwrap(), DAMAGED_BYTES);
        assert!(!aside(&registry, "vaults.damaged.json").exists());
    }

    /// The move fails (here the damaged file is held so it cannot be moved): nothing changes, and the error comes back.
    #[test]
    fn a_failed_move_changes_nothing() {
        use std::fs::OpenOptions;
        use std::os::windows::fs::OpenOptionsExt;

        let temp = TempDir::new();
        let registry = registry(&temp);
        write_list(&registry, DAMAGED_BYTES);
        // Others may read it (so it is seen as damaged), but not move it: no delete sharing.
        let held = OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&registry.file)
            .unwrap();
        let refused = registry.start_new_list().unwrap_err();
        assert!(matches!(&refused, ShellError::Core(view) if view.kind == "io"));
        drop(held);
        assert_eq!(fs::read(&registry.file).unwrap(), DAMAGED_BYTES);
        assert!(!aside(&registry, "vaults.damaged.json").exists());
        assert_eq!(registry.list(), Err(damaged()), "still damaged, as it was");
    }

    /// The move worked and the new list could not be written: the answer is the error, and the list reads as empty
    /// (there is no file), which is where a new list would have left it. The damaged file is safe at its new name.
    #[test]
    fn a_failed_write_after_the_move_leaves_an_empty_list() {
        use lockbox_core::internals::fsio::failpoint;

        let temp = TempDir::new();
        let registry = registry(&temp);
        write_list(&registry, DAMAGED_BYTES);
        failpoint::arm("atomic_write.before_replace");
        let refused = registry.start_new_list();
        failpoint::disarm_all();
        assert!(matches!(&refused, Err(ShellError::Core(view)) if view.kind == "io"));
        assert_eq!(
            fs::read(aside(&registry, "vaults.damaged.json")).unwrap(),
            DAMAGED_BYTES
        );
        assert!(!registry.file.exists());
        assert_eq!(registry.list(), Ok(vec![]));
        // No temp file is left in the folder.
        let left: Vec<_> = fs::read_dir(registry.file.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(left.len(), 1, "{left:?}");
        // Nothing is damaged now, so a second press is refused as a good (empty) list is, and a new vault can be added.
        assert_eq!(
            registry.start_new_list(),
            Err(ShellError::InvalidInput { what: WHAT })
        );
        assert_eq!(registry.add(&folder(&temp, "back")).map(|v| v.id), Ok(1));
    }

    /// Two presses at once: the list's own lock makes them one after the other, so the second finds the new, good list
    /// and is refused; the damaged copy is made once.
    #[test]
    fn two_presses_set_aside_one_copy() {
        let temp = TempDir::new();
        let registry = Arc::new(registry(&temp));
        write_list(&registry, DAMAGED_BYTES);
        let answers: Vec<_> = (0..2)
            .map(|_| {
                let registry = Arc::clone(&registry);
                std::thread::spawn(move || registry.start_new_list())
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(
            answers.iter().filter(|a| a.is_ok()).count(),
            1,
            "{answers:?}"
        );
        assert!(answers.contains(&Err(ShellError::InvalidInput { what: WHAT })));
        assert_eq!(
            fs::read(aside(&registry, "vaults.damaged.json")).unwrap(),
            DAMAGED_BYTES
        );
        assert!(!aside(&registry, "vaults.damaged-2.json").exists());
        assert_eq!(registry.list(), Ok(vec![]));
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
        let list = registry
            .add(&fs::canonicalize(&good).unwrap())
            .unwrap()
            .list;
        registry.add(&fs::canonicalize(&bad).unwrap()).unwrap();
        assert_eq!(
            registry.list(),
            Ok(vec![
                entry(list, 1, Some("Family"), true),
                VaultEntry {
                    details_damaged: true,
                    ..entry(list, 2, None, true)
                }
            ])
        );
        assert!(!details_damaged(&good));
        assert!(details_damaged(&bad));
    }

    /// A version 1 list is read as it is (IDs and paths), gets an identity and a mark, and is rewritten as version 2
    /// before anything is answered, so every caller sees the same identity; a rewrite that fails leaves the old file
    /// and is tried again at the next read; one that would make the file too large says so and leaves it.
    #[test]
    fn a_version_1_vaults_json_reads_and_is_rewritten_as_version_2() {
        use lockbox_core::internals::fsio::failpoint;

        let temp = TempDir::new();
        let registry = Arc::new(registry(&temp));
        let (a, b) = (folder(&temp, "a"), folder(&temp, "b"));
        // A hole in the IDs: the highest ever listed is the mark.
        let v1 =
            json!({ "version": 1, "vaults": [ { "id": 1, "path": a }, { "id": 3, "path": b } ] })
                .to_string();
        write_list(&registry, v1.as_bytes());

        // Many readers at once: one identity for all, and the file is version 2 after them.
        let readers: Vec<_> = (0..8)
            .map(|_| {
                let registry = Arc::clone(&registry);
                std::thread::spawn(move || registry.list())
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|reader| reader.join().unwrap().expect("a version 1 list reads"))
            .collect();
        let list = readers[0][0].list;
        assert!((1..=MAX_LIST).contains(&list));
        for seen in &readers {
            assert_eq!(
                seen,
                &vec![entry(list, 1, None, true), entry(list, 3, None, true)]
            );
        }
        let written: serde_json::Value =
            serde_json::from_slice(&fs::read(&registry.file).unwrap()).unwrap();
        assert_eq!(
            written,
            json!({ "version": 2, "list": list, "last_id": 3,
                    "vaults": [ { "id": 1, "path": a }, { "id": 3, "path": b } ] })
        );
        // The mark was the highest ID: removing it and adding gives 4, not 3.
        registry.forget(VaultRef { list, id: 3 }).unwrap();
        assert_eq!(
            registry.add(&b),
            Ok(VaultRef { list, id: 4 }),
            "the mark came from the highest listed ID"
        );

        // An empty version 1 list: the mark is 0.
        write_list(&registry, br#"{ "version": 1, "vaults": [] }"#);
        assert_eq!(registry.list(), Ok(vec![]));
        let written: serde_json::Value =
            serde_json::from_slice(&fs::read(&registry.file).unwrap()).unwrap();
        assert_eq!(written["version"], 2);
        assert_eq!(written["last_id"], 0);
        assert_eq!(written["vaults"], json!([]));

        // A rewrite that fails: the answer is the error, the version 1 file is as it was, the next read tries again.
        write_list(&registry, v1.as_bytes());
        failpoint::arm("atomic_write.before_replace");
        let refused = registry.list();
        failpoint::disarm_all();
        assert!(matches!(&refused, Err(ShellError::Core(view)) if view.kind == "io"));
        assert_eq!(fs::read(&registry.file).unwrap(), v1.as_bytes());
        assert_eq!(
            registry.list().unwrap().len(),
            2,
            "tried again, and written"
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&fs::read(&registry.file).unwrap())
                .unwrap()["version"],
            2
        );

        // A version 1 file already at the size limit would be too large as version 2: refused, and kept.
        let base = fs::canonicalize(temp.path()).unwrap();
        let text = |count: usize, pad: usize| {
            let vaults: Vec<_> = (0..count)
                .map(|at| {
                    let extra = if at + 1 == count { pad } else { 0 };
                    let name = format!("{at:04}{}", "x".repeat(2000 + extra));
                    json!({ "id": at + 1, "path": base.join(name) })
                })
                .collect();
            serde_json::to_vec_pretty(&json!({ "version": 1, "vaults": vaults })).unwrap()
        };
        let count = (1..)
            .take_while(|&count| text(count, 0).len() as u64 <= MAX_STATE_FILE)
            .last()
            .expect("at least one fits");
        let full = text(count, MAX_STATE_FILE as usize - text(count, 0).len());
        assert_eq!(full.len() as u64, MAX_STATE_FILE);
        write_list(&registry, &full);
        assert_eq!(registry.list(), Err(ShellError::TooLarge { what: WHAT }));
        assert_eq!(fs::read(&registry.file).unwrap(), full, "kept as it was");
    }

    /// An ID is given once within a list, however much is removed; a row of an older list (before "Start a new list")
    /// names nothing on the new one, though the new list gives ID 1 again.
    #[test]
    fn ids_are_given_once_and_rows_of_another_list_name_nothing() {
        let temp = TempDir::new();
        let registry = registry(&temp);
        let (a, b, c) = (folder(&temp, "a"), folder(&temp, "b"), folder(&temp, "c"));
        let (first, second) = (registry.add(&a).unwrap(), registry.add(&b).unwrap());
        // Removing the highest and adding another is a new ID.
        registry.forget(second).unwrap();
        let third = registry.add(&c).unwrap();
        assert_eq!(third.id, 3, "2 is not given again");
        registry.forget(third).unwrap();
        registry.forget(first).unwrap();
        let fourth = registry.add(&a).unwrap();
        assert_eq!(fourth.id, 4, "an empty list keeps its mark");
        assert_eq!(registry.path_of(second), None);
        assert_eq!(registry.forget(second), Err(ShellError::NotFound));

        // A new list: IDs start again, under a new identity.
        write_list(&registry, DAMAGED_BYTES);
        registry.start_new_list().unwrap();
        let again = registry.add(&b).unwrap();
        assert_eq!(again.id, 1);
        assert_ne!(again.list, fourth.list, "a new identity");
        let old_row = VaultRef {
            list: fourth.list,
            id: 1,
        };
        assert_eq!(registry.path_of(old_row), None);
        assert_eq!(registry.forget(old_row), Err(ShellError::NotFound));
        assert_eq!(registry.path_of(again), Some(b.clone()), "still listed");
        assert_eq!(
            registry.path_of(row(&registry, 1)),
            Some(b),
            "by the current identity"
        );
    }
}
