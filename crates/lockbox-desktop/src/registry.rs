//! The vault list (spec §6.10): the folders of the vaults Lockbox knows, in `vaults.json` in the state folder.
//! Locations only, no secrets: `{ "version": 1, "vaults": [ { "id": <u32>, "path": "<absolute>" } ] }`. The page names
//! a vault by its ID; its path never leaves Rust.

use std::fmt;
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::{Arc, Mutex};

use lockbox_core::fsio::{is_destination_taken, rename_file_no_replace};
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

/// How many damaged lists are kept aside (`vaults.damaged.json`, then `vaults.damaged-2.json` to `-100`).
const MAX_SET_ASIDE: u32 = 100;

/// The refusal of a list that is there but cannot be used.
fn damaged_list() -> ShellError {
    CoreError::Damaged { what: WHAT }.into()
}

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

    /// Adds the vault folder `path` (canonical: a local drive's verbatim path, `\\?\C:\..`) and returns its ID; a
    /// folder already on the list keeps its ID. `TooLarge` once the list holds [`MAX_VAULTS`], or when it would
    /// grow larger than it can be read back. A damaged list is refused and left as it is.
    pub fn add(&self, path: &Path) -> ShellResult<u32> {
        if !on_local_drive(path) || path.to_str().is_none() {
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
        let _edit = lock(&self.edits);
        match self.load() {
            Err(error) if error == damaged_list() => {}
            Err(error) => return Err(error),
            Ok(_) => return Err(ShellError::InvalidInput { what: WHAT }),
        }
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
                Ok(()) => return self.save(Vec::new()),
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

    /// The list on disk, checked: at most [`MAX_VAULTS`], IDs from 1 and each once, every path a local drive's
    /// verbatim path as `add` stores it (a network share or device path from a tampered file would be opened by every
    /// `list`). Empty when there is no file yet.
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
            && vaults.iter().all(|v| on_local_drive(&v.path));
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
        // The same folder again, in another letter case or with a trailing separator, keeps its ID.
        let upper = PathBuf::from(a.to_string_lossy().to_uppercase());
        assert_eq!(registry.add(&upper), Ok(1));
        let trailing = PathBuf::from(format!("{}\\", a.display()));
        assert_eq!(registry.add(&trailing), Ok(1));
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
        assert_eq!(registry.add(&base.join("v7")), Ok(7));
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
                .collect();
            let file = RegistryFile {
                version: StateVersion,
                vaults,
            };
            (serde_json::to_vec_pretty(&file).unwrap().len(), file.vaults)
        };
        // A few entries short of the cap, written through the list's own save.
        let (one, _) = size(1);
        let each = size(2).0 - one;
        let seeded = (MAX_STATE_FILE as usize - one) / each - 3;
        let (_, vaults) = size(seeded);
        registry.save(vaults).unwrap();
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
            json!({ "version": 2, "vaults": [] }).to_string(),
            json!({ "version": 1, "vaults": [ { "id": 1, "path": "relative" } ] }).to_string(),
            json!({ "version": 1, "vaults": [ { "id": 0, "path": a } ] }).to_string(),
            json!({ "version": 1, "vaults": [ { "id": 1, "path": a }, { "id": 1, "path": a } ] })
                .to_string(),
            json!({ "version": 1, "vaults": too_many }).to_string(),
            "{".to_string(),
        ]
        .into_iter()
        .chain(elsewhere)
        {
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
        assert_eq!(written, json!({ "version": 1, "vaults": [] }));
        assert_eq!(registry.list(), Ok(vec![]));
        assert_eq!(registry.entries(), vec![]);
        // And it takes vaults again (the first screen's "I already have a vault").
        assert_eq!(registry.add(&folder(&temp, "back")), Ok(1));
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
        registry.add(&folder(&temp, "a")).unwrap();
        registry.add(&folder(&temp, "b")).unwrap();
        let before = fs::read(&registry.file).unwrap();
        assert_eq!(
            registry.start_new_list(),
            Err(ShellError::InvalidInput { what: WHAT })
        );
        assert_eq!(fs::read(&registry.file).unwrap(), before, "bytes equal");
        assert!(!aside(&registry, "vaults.damaged.json").exists());
        assert_eq!(registry.list().unwrap().len(), 2);

        // An empty list that reads fine is a good list as well.
        registry.forget(1).unwrap();
        registry.forget(2).unwrap();
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
        assert_eq!(registry.add(&folder(&temp, "back")), Ok(1));
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
        registry.add(&fs::canonicalize(&good).unwrap()).unwrap();
        registry.add(&fs::canonicalize(&bad).unwrap()).unwrap();
        assert_eq!(
            registry.list(),
            Ok(vec![entry(1, Some("Family"), true), entry(2, None, true)])
        );
    }
}
