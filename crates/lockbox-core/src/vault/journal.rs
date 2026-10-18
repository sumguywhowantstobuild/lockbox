//! The restore journal (spec 6.8): one small file that says which staging folder a restore
//! is working in and how far it got, so a crash can never lose both copies of a vault. It
//! holds folder paths only, never a key, a name or any content.

use super::backup::not_found;
use super::cleanup::check_folder;
use crate::fsio::{atomic_write, read_retry, remove_file_retry};
use crate::ids::VaultId;
use crate::limits::{MAX_JSON_DEPTH, check_json};
use crate::{CoreError, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

/// The journal version this build reads and writes.
pub(super) const RESTORE_JOURNAL_VERSION: u16 = 1;
/// Largest journal accepted.
const MAX_JOURNAL_BYTES: usize = 65_536;
const STAGING_PREFIX: &str = ".restore-";
const DAMAGED: CoreError = CoreError::Damaged {
    what: "restore journal",
};

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RestoreJournal {
    pub version: u16,
    pub step: JournalStep,
    pub staging: PathBuf,
    pub target: PathBuf,
    pub before_restore: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum JournalStep {
    Extracting,
    Swapping,
}

/// A fresh staging folder path `.restore-<32 lowercase hex>` in `parent`; nothing is created.
pub(super) fn new_staging_path(parent: &Path) -> PathBuf {
    // Any random 32 hex characters will do; a vault ID is what is at hand.
    parent.join(format!("{STAGING_PREFIX}{}", VaultId::random().to_hex()))
}

/// Whether `path` is named exactly `.restore-` plus 32 lowercase hex characters. Only such a
/// folder is ever deleted as a staging folder.
pub(super) fn validate_staging_name(path: &Path) -> Result<()> {
    let hex = path
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_prefix(STAGING_PREFIX));
    // `from_hex` takes exactly 32 lowercase hex characters, nothing else.
    match hex {
        Some(hex) if VaultId::from_hex(hex).is_ok() => Ok(()),
        _ => Err(DAMAGED),
    }
}

/// Writes the journal to `path`, replacing any earlier one.
pub(super) fn write_journal(path: &Path, j: &RestoreJournal) -> Result<()> {
    // Fails on a path that is not valid Unicode, before anything is written.
    let bytes = serde_json::to_vec_pretty(j).map_err(|_| CoreError::InvalidInput {
        what: "restore journal",
    })?;
    atomic_write(path, &bytes)
}

/// Reads the journal at `path`; a missing file is `None`. Order matters, as for the header:
/// size and depth first, then only the version (so a newer journal says "update Lockbox",
/// not "damaged"), then the strict parse. Serde's own messages are never passed on.
pub(super) fn read_journal(path: &Path) -> Result<Option<RestoreJournal>> {
    let bytes = match read_retry(path, MAX_JOURNAL_BYTES) {
        Err(e) if not_found(&e) => return Ok(None),
        other => other?,
    };
    check_json(&bytes, MAX_JOURNAL_BYTES, MAX_JSON_DEPTH)?;
    #[derive(Deserialize)]
    struct Peek {
        version: u16,
    }
    let peek: Peek = serde_json::from_slice(&bytes).map_err(|_| DAMAGED)?;
    if peek.version != RESTORE_JOURNAL_VERSION {
        return Err(CoreError::UnsupportedVersion);
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| DAMAGED)
}

/// Removes the staging folder, then the journal, and only if the first worked (the journal is
/// what lets the next launch finish the job). A name that is not a staging name, or a staging
/// path that is not a real folder (a link, junction or reparse point), is refused and
/// nothing is touched. A staging folder that is already gone counts as removed.
pub(super) fn remove_staging_then_journal(staging: &Path, journal: &Path) -> Result<()> {
    validate_staging_name(staging)?;
    check_folder(staging)?;
    #[cfg(test)]
    crate::fsio::failpoint::check("restore.remove_staging")?;
    match fs::remove_dir_all(staging) {
        Err(e) if e.kind() != ErrorKind::NotFound => return Err(e.into()),
        _ => {}
    }
    remove_file_retry(journal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsio::failpoint;
    use crate::fsio::testutil::{TempDir, make_dir_link, names};

    fn journal(dir: &Path) -> RestoreJournal {
        RestoreJournal {
            version: RESTORE_JOURNAL_VERSION,
            step: JournalStep::Swapping,
            staging: new_staging_path(dir),
            target: dir.join("Family-abababab"),
            before_restore: Some(dir.join("Family-abababab.before-restore")),
        }
    }

    #[track_caller]
    fn read_err(path: &Path) -> CoreError {
        read_journal(path).expect_err("expected an error")
    }

    #[test]
    fn round_trip_and_missing() {
        let dir = TempDir::new();
        let path = dir.path().join("restore-journal.json");
        assert!(read_journal(&path).unwrap().is_none());
        let j = journal(dir.path());
        write_journal(&path, &j).unwrap();
        let back = read_journal(&path).unwrap().unwrap();
        assert_eq!(format!("{back:?}"), format!("{j:?}"));
        assert_eq!(back.step, JournalStep::Swapping);
        // Written again, the new one wins and no temp file is left.
        let j = RestoreJournal {
            step: JournalStep::Extracting,
            before_restore: None,
            ..j
        };
        write_journal(&path, &j).unwrap();
        assert_eq!(
            read_journal(&path).unwrap().unwrap().step,
            JournalStep::Extracting
        );
        assert_eq!(names(dir.path()), ["restore-journal.json"]);
        assert!(
            fs::read_to_string(&path)
                .unwrap()
                .contains("\"extracting\"")
        );
    }

    #[test]
    fn unreadable_journals_are_refused_with_fixed_text() {
        let dir = TempDir::new();
        let path = dir.path().join("j.json");
        let good = journal(dir.path());
        let mut value = serde_json::to_value(&good).unwrap();
        let write = |v: &serde_json::Value| fs::write(&path, serde_json::to_vec(v).unwrap());

        value["version"] = 2.into();
        write(&value).unwrap();
        assert!(matches!(read_err(&path), CoreError::UnsupportedVersion));
        // The version is read before the strict parse: a newer journal may have new fields.
        value["extra"] = 1.into();
        write(&value).unwrap();
        assert!(matches!(read_err(&path), CoreError::UnsupportedVersion));
        value["version"] = 1.into();
        write(&value).unwrap();
        assert!(matches!(
            read_err(&path),
            CoreError::Damaged {
                what: "restore journal"
            }
        ));

        fs::write(&path, b"not json").unwrap();
        assert!(matches!(
            read_err(&path),
            CoreError::Damaged {
                what: "restore journal"
            }
        ));
        fs::write(&path, vec![b' '; MAX_JOURNAL_BYTES + 1]).unwrap();
        assert!(matches!(read_err(&path), CoreError::TooLarge { .. }));
        let deep = format!(
            "{}{}",
            "[".repeat(MAX_JSON_DEPTH + 1),
            "]".repeat(MAX_JSON_DEPTH + 1)
        );
        fs::write(&path, deep).unwrap();
        assert!(matches!(
            read_err(&path),
            CoreError::Damaged {
                what: "json nesting"
            }
        ));
    }

    #[test]
    fn staging_names() {
        let hex = "0123456789abcdef".repeat(2);
        let dir = Path::new("parent");
        validate_staging_name(&dir.join(format!(".restore-{hex}"))).unwrap();
        for bad in [
            format!(".restore-{}", hex.to_uppercase()),
            format!(".restore-{}", &hex[1..]),
            format!(".restore-{hex}0"),
            format!(".creating-{hex}"),
            format!("restore-{hex}"),
            ".restore-".to_owned(),
            "Family-abababab".to_owned(),
        ] {
            assert!(validate_staging_name(&dir.join(&bad)).is_err(), "{bad}");
        }
        assert!(validate_staging_name(Path::new("")).is_err());
        let fresh = new_staging_path(dir);
        validate_staging_name(&fresh).unwrap();
        assert_ne!(fresh, new_staging_path(dir));
    }

    /// A staging folder with a file in a subfolder, and a journal file.
    fn staged(dir: &Path) -> (PathBuf, PathBuf) {
        let staging = new_staging_path(dir);
        fs::create_dir_all(staging.join("items")).unwrap();
        fs::write(staging.join("items").join("x.item"), b"x").unwrap();
        let journal = dir.join("j.json");
        fs::write(&journal, b"{}").unwrap();
        (staging, journal)
    }

    #[test]
    fn removes_the_staging_folder_then_the_journal() {
        let dir = TempDir::new();
        let (staging, journal) = staged(dir.path());
        remove_staging_then_journal(&staging, &journal).unwrap();
        assert!(!staging.exists() && !journal.exists());
        // Already gone counts as removed, and so does a journal that is gone.
        fs::write(&journal, b"{}").unwrap();
        remove_staging_then_journal(&staging, &journal).unwrap();
        assert!(!journal.exists());
        remove_staging_then_journal(&staging, &journal).unwrap();
    }

    #[test]
    fn the_journal_stays_when_the_staging_folder_will_not_go() {
        let dir = TempDir::new();
        let (staging, journal) = staged(dir.path());
        failpoint::arm("restore.remove_staging");
        let result = remove_staging_then_journal(&staging, &journal);
        failpoint::disarm_all();
        assert!(matches!(result, Err(CoreError::Io(_))));
        assert!(staging.join("items").join("x.item").exists() && journal.exists());
    }

    #[test]
    fn only_a_real_staging_folder_is_removed() {
        let dir = TempDir::new();
        // Not a staging name: a vault folder is never deleted.
        let vault = dir.path().join("Family-abababab");
        fs::create_dir(&vault).unwrap();
        fs::write(vault.join("vault.json"), b"x").unwrap();
        let journal = dir.path().join("j.json");
        fs::write(&journal, b"{}").unwrap();
        assert!(remove_staging_then_journal(&vault, &journal).is_err());
        assert!(vault.join("vault.json").exists() && journal.exists());

        // A staging name that is a link: the folder it leads to and the link stay.
        let outside = TempDir::new();
        fs::write(outside.path().join("keep"), b"keep").unwrap();
        let link = new_staging_path(dir.path());
        make_dir_link(&link, outside.path());
        let result = remove_staging_then_journal(&link, &journal);
        assert!(matches!(
            result,
            Err(CoreError::InvalidInput {
                what: "not a plain folder"
            })
        ));
        assert!(outside.path().join("keep").exists() && journal.exists());
        assert!(fs::symlink_metadata(&link).is_ok());

        // A staging name that is a file.
        let file = new_staging_path(dir.path());
        fs::write(&file, b"x").unwrap();
        assert!(remove_staging_then_journal(&file, &journal).is_err());
        assert!(file.exists() && journal.exists());
    }
}
