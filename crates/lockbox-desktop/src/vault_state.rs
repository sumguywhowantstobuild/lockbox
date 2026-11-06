//! What the shell notes about each vault folder, in `vault-state.json` in the state folder:
//! `{ "version": 1, "vaults": [ { "path": "<absolute>", "unconfirmed": <bool>, "last_backup": <string or null> } ] }`.
//! Keyed by the vault folder's location (compared as Windows compares names), never by vault ID: a copy of a vault
//! keeps its ID, and its notes must stay its own. Nothing here crosses to the page except through the commands that
//! read it.
//!
//! `unconfirmed` is the "recovery key not confirmed" mark: written before a recovery key is made, cleared once the
//! person has typed part of it back. `last_backup` is for the backup reminder. The file holds no secret, only places.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{ShellError, ShellResult};
use crate::lock;
use crate::os::same_path;
use crate::paths::{StateVersion, read_state, write_state};

/// What `vault-state.json` is called in errors.
const WHAT: &str = "vault state";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StateFile {
    version: StateVersion,
    vaults: Vec<Stored>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stored {
    path: PathBuf,
    unconfirmed: bool,
    last_backup: Option<String>,
}

impl Stored {
    /// Nothing to remember about the folder.
    fn is_blank(&self) -> bool {
        !self.unconfirmed && self.last_backup.is_none()
    }
}

/// The notes on each vault folder. Each change reads the file, changes it and writes it back while holding the
/// store's own lock. A damaged file reads as empty, and the next change replaces it.
pub struct VaultStateStore {
    file: PathBuf,
    edits: Mutex<()>,
}

impl VaultStateStore {
    pub fn new(file: PathBuf) -> VaultStateStore {
        VaultStateStore {
            file,
            edits: Mutex::default(),
        }
    }

    /// Notes that the recovery key made for the vault folder `folder` (canonical) has not been confirmed. Refused,
    /// writing nothing, when the note cannot be saved (`TooLarge { what: "vault state" }`, or an I/O refusal).
    pub fn mark_unconfirmed(&self, folder: &Path) -> ShellResult<()> {
        self.change(folder, |stored| stored.unconfirmed = true)
    }

    /// Clears the mark for `folder`; a folder with no mark is a success. Refused, changing nothing, when the file
    /// cannot be saved.
    pub fn clear_unconfirmed(&self, folder: &Path) -> ShellResult<()> {
        self.change(folder, |stored| stored.unconfirmed = false)
    }

    /// Whether `folder` has the mark. A damaged file reads as empty (no mark), but a file that cannot be read for
    /// another reason (another program holds it) says yes: the mark may be there, and a needless new key costs little
    /// where a key nobody saw costs a lot.
    pub fn is_unconfirmed(&self, folder: &Path) -> bool {
        match self.find(folder) {
            Ok(stored) => stored.is_some_and(|stored| stored.unconfirmed),
            Err(_) => true,
        }
    }

    /// The date `folder` was last backed up, as it was set.
    pub fn last_backup(&self, folder: &Path) -> Option<String> {
        self.find(folder).ok()??.last_backup
    }

    /// Notes the date `folder` was last backed up (RFC 3339, as the engine writes dates).
    pub fn set_last_backup(&self, folder: &Path, date: &str) -> ShellResult<()> {
        self.change(folder, |stored| stored.last_backup = Some(date.to_owned()))
    }

    fn find(&self, folder: &Path) -> ShellResult<Option<Stored>> {
        let _edit = lock(&self.edits);
        Ok(self
            .load()?
            .into_iter()
            .find(|stored| same_path(&stored.path, folder)))
    }

    /// Runs `edit` on the note for `folder` (a blank one when it has none) and saves the file if that changed the
    /// note. A note left with nothing in it is dropped, so the file holds only what matters.
    fn change(&self, folder: &Path, edit: impl FnOnce(&mut Stored)) -> ShellResult<()> {
        let _edit = lock(&self.edits);
        let mut vaults = self.load()?;
        let at = vaults
            .iter()
            .position(|stored| same_path(&stored.path, folder));
        let before = at.map(|at| vaults[at].clone());
        let mut stored = before.clone().unwrap_or_else(|| Stored {
            path: folder.to_path_buf(),
            unconfirmed: false,
            last_backup: None,
        });
        edit(&mut stored);
        let unchanged = match &before {
            Some(before) => *before == stored,
            None => stored.is_blank(),
        };
        if unchanged {
            return Ok(());
        }
        match at {
            Some(at) if stored.is_blank() => {
                vaults.remove(at);
            }
            Some(at) => vaults[at] = stored,
            None => vaults.push(stored),
        }
        write_state(
            &self.file,
            &StateFile {
                version: StateVersion,
                vaults,
            },
            WHAT,
        )
    }

    /// The notes on disk. A damaged file (too large, not the schema) reads as none; a file that cannot be read for
    /// another reason is refused, so a change never replaces notes it could not see.
    fn load(&self) -> ShellResult<Vec<Stored>> {
        match read_state::<StateFile>(&self.file, WHAT) {
            Ok(Some(file)) => Ok(file.vaults),
            Ok(None) => Ok(Vec::new()),
            Err(ShellError::Core(view)) if view.kind == "damaged" => Ok(Vec::new()),
            Err(other) => Err(other),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use lockbox_core::Vault;
    use lockbox_core::ids::VaultId;
    use lockbox_core::internals::fsio::testutil::TempDir;
    use lockbox_core::read_vault_id;
    use serde_json::{Value, json};

    use super::*;
    use crate::paths::MAX_STATE_FILE;
    use crate::testing::heavy;

    fn store(temp: &TempDir) -> VaultStateStore {
        VaultStateStore::new(temp.path().join("state").join("vault-state.json"))
    }

    fn written(store: &VaultStateStore) -> Value {
        serde_json::from_slice(&fs::read(&store.file).unwrap()).unwrap()
    }

    #[test]
    fn mark_round_trip_and_exact_file() {
        let temp = TempDir::new();
        let store = store(&temp);
        let folder = temp.path().join("Family-1234abcd");
        assert!(!store.is_unconfirmed(&folder), "no file yet");
        store.mark_unconfirmed(&folder).unwrap();
        assert!(store.is_unconfirmed(&folder));
        assert_eq!(
            written(&store),
            json!({
                "version": 1,
                "vaults": [ { "path": folder, "unconfirmed": true, "last_backup": null } ]
            })
        );
        // A second mark changes nothing.
        store.mark_unconfirmed(&folder).unwrap();
        assert_eq!(written(&store)["vaults"].as_array().unwrap().len(), 1);
        store.clear_unconfirmed(&folder).unwrap();
        assert!(!store.is_unconfirmed(&folder));
        assert_eq!(written(&store), json!({ "version": 1, "vaults": [] }));
        // Clearing what is not there is a success.
        store.clear_unconfirmed(&folder).unwrap();
        store
            .clear_unconfirmed(&temp.path().join("Other-00000000"))
            .unwrap();
    }

    #[test]
    fn damaged_state_file_starts_empty() {
        let temp = TempDir::new();
        let store = store(&temp);
        let folder = temp.path().join("Family-1234abcd");
        fs::create_dir_all(store.file.parent().unwrap()).unwrap();
        let mut oversized = r#"{ "version": 1, "vaults": [] }"#.to_string();
        oversized.push_str(&" ".repeat(MAX_STATE_FILE as usize));
        for text in [
            "not json".to_string(),
            r#"{ "version": 2, "vaults": [] }"#.to_string(),
            r#"{ "version": 1, "vaults": [], "extra": true }"#.to_string(),
            r#"{ "version": 1, "vaults": [ { "path": "x" } ] }"#.to_string(),
            oversized,
        ] {
            fs::write(&store.file, &text).unwrap();
            assert!(!store.is_unconfirmed(&folder), "reads as empty");
            assert_eq!(store.last_backup(&folder), None);
            // The next change replaces it, so a first vault can still be made.
            store.mark_unconfirmed(&folder).unwrap();
            assert!(store.is_unconfirmed(&folder));
            assert_eq!(written(&store)["version"], 1);
        }
    }

    /// A file that cannot be read for another reason is not "damaged": a change is refused and nothing is replaced,
    /// so the other vaults' marks are not lost to a hiccup.
    #[test]
    fn an_unreadable_file_is_not_replaced() {
        let temp = TempDir::new();
        let store = store(&temp);
        // A folder where the file should be: opening it for reading fails, and it is not a damaged file.
        fs::create_dir_all(&store.file).unwrap();
        let folder = temp.path().join("Family-1234abcd");
        assert!(matches!(
            store.mark_unconfirmed(&folder),
            Err(ShellError::Core(view)) if view.kind == "io"
        ));
        assert!(store.file.is_dir(), "left as it was");
        // And a mark that cannot be read is taken for a mark: a needless new key costs little, an unseen key a lot.
        assert!(store.is_unconfirmed(&folder));
        assert_eq!(store.last_backup(&folder), None);
    }

    #[test]
    fn two_folders_with_one_vault_id_keep_separate_marks() {
        let temp = TempDir::new();
        let store = store(&temp);
        let id = VaultId::random();
        let (one, two) = (temp.path().join("one"), temp.path().join("two"));
        fs::create_dir_all(&one).unwrap();
        fs::create_dir_all(&two).unwrap();
        let (a, b) = heavy(|| {
            let a = Vault::create_with_id(&one, "Family", "correct horse battery", id).unwrap();
            let b = Vault::create_with_id(&two, "Family", "correct horse battery", id).unwrap();
            (a.vault.dir().to_path_buf(), b.vault.dir().to_path_buf())
        });
        assert_eq!(read_vault_id(&a).unwrap(), read_vault_id(&b).unwrap());
        assert_ne!(a, b);

        store.mark_unconfirmed(&a).unwrap();
        assert!(store.is_unconfirmed(&a));
        assert!(!store.is_unconfirmed(&b), "the copy has no mark");
        store.mark_unconfirmed(&b).unwrap();
        store.clear_unconfirmed(&a).unwrap();
        assert!(!store.is_unconfirmed(&a));
        assert!(store.is_unconfirmed(&b), "clearing one leaves the other");
    }

    /// A place is the same place however it is spelled: letter case and a trailing separator (the registry compares
    /// the same way).
    #[test]
    fn a_folder_is_one_key_however_it_is_spelled() {
        let temp = TempDir::new();
        let store = store(&temp);
        let folder = temp.path().join("Family-1234abcd");
        let text = folder.to_string_lossy().into_owned();
        store.mark_unconfirmed(&folder).unwrap();
        assert!(store.is_unconfirmed(&PathBuf::from(text.to_uppercase())));
        assert!(store.is_unconfirmed(&PathBuf::from(format!("{text}\\"))));
        store
            .mark_unconfirmed(&PathBuf::from(text.to_uppercase()))
            .unwrap();
        assert_eq!(written(&store)["vaults"].as_array().unwrap().len(), 1);
        store
            .clear_unconfirmed(&PathBuf::from(text.to_lowercase()))
            .unwrap();
        assert!(!store.is_unconfirmed(&folder));
    }

    #[test]
    fn last_backup_is_kept_apart_from_the_mark() {
        let temp = TempDir::new();
        let store = store(&temp);
        let folder = temp.path().join("Family-1234abcd");
        assert_eq!(store.last_backup(&folder), None);
        store.set_last_backup(&folder, "2026-11-06").unwrap();
        assert_eq!(store.last_backup(&folder).as_deref(), Some("2026-11-06"));
        assert!(!store.is_unconfirmed(&folder), "a backup date is no mark");
        store.mark_unconfirmed(&folder).unwrap();
        store.clear_unconfirmed(&folder).unwrap();
        assert_eq!(
            store.last_backup(&folder).as_deref(),
            Some("2026-11-06"),
            "clearing the mark keeps the date"
        );
        store.set_last_backup(&folder, "2026-11-07").unwrap();
        assert_eq!(store.last_backup(&folder).as_deref(), Some("2026-11-07"));
        assert_eq!(written(&store)["vaults"].as_array().unwrap().len(), 1);
        let other = temp.path().join("Work-5678abcd");
        assert_eq!(store.last_backup(&other), None);
    }

    #[test]
    fn a_note_that_cannot_fit_is_refused_and_the_file_kept() {
        let temp = TempDir::new();
        let store = store(&temp);
        // A file 100 bytes short of its cap: one more entry does not fit.
        let seed = |chars: usize| {
            let path = temp.path().join("x".repeat(chars));
            json!({
                "version": 1,
                "vaults": [ { "path": path, "unconfirmed": false, "last_backup": "d" } ]
            })
            .to_string()
        };
        let overhead = seed(1).len() - 1;
        let seed = seed(MAX_STATE_FILE as usize - 100 - overhead);
        assert_eq!(seed.len() as u64, MAX_STATE_FILE - 100);
        fs::create_dir_all(store.file.parent().unwrap()).unwrap();
        fs::write(&store.file, &seed).unwrap();
        let folder = temp.path().join("Family-1234abcd");
        assert_eq!(
            store.mark_unconfirmed(&folder),
            Err(ShellError::TooLarge {
                what: "vault state"
            })
        );
        assert_eq!(fs::read_to_string(&store.file).unwrap(), seed, "kept");
    }
}
