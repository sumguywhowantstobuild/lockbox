//! The restore journal (spec 6.8): one small file that says which staging folder a restore
//! is working in and how far it got, so a crash can never lose both copies of a vault. It
//! holds folder paths only, never a key, a name or any content.

use super::backup::not_found;
use super::cleanup::check_folder;
use crate::fsio::{
    atomic_create, atomic_write, parent_dir, read_retry, remove_dir_all_retry, remove_file_retry,
};
use crate::ids::VaultId;
use crate::limits::{MAX_JSON_DEPTH, check_json};
use crate::{CoreError, Result};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

/// The journal version this build reads and writes.
pub(super) const RESTORE_JOURNAL_VERSION: u16 = 1;
/// Largest journal accepted.
const MAX_JOURNAL_BYTES: usize = 65_536;
const STAGING_PREFIX: &str = ".restore-";
/// What a pre-restore folder's name adds to the vault folder's.
pub(super) const PRE_RESTORE: &str = ".before-restore";
const DAMAGED: CoreError = CoreError::Damaged {
    what: "restore journal",
};
/// Something is already at the journal path: a restore, or what is left of one.
pub(super) const IN_PROGRESS: CoreError = CoreError::InvalidInput {
    what: "restore in progress",
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

/// Whether a folder name is that of a pre-restore copy, in any letter case (Windows names are
/// case-insensitive, so `Family.BEFORE-RESTORE` is one too).
pub(super) fn is_pre_restore_name(name: &str) -> bool {
    name.to_lowercase().contains(PRE_RESTORE)
}

/// An absolute path made only of a prefix, a root and normal names: no `.`, no `..`.
pub(super) fn plain_absolute(path: &Path) -> bool {
    path.is_absolute()
        && path.components().all(|c| {
            matches!(
                c,
                Component::Prefix(_) | Component::RootDir | Component::Normal(_)
            )
        })
}

/// The name of the last component of `path`, if it is valid Unicode.
fn name_of(path: &Path) -> Option<&str> {
    path.file_name().and_then(|n| n.to_str())
}

/// Spec 6.8 journal validation, the part that needs no disk: paths absolute and plain with one
/// parent between them; the staging name; a target that is neither a staging name nor a
/// pre-restore name; a pre-restore name that is the target's plus `.before-restore` or
/// `.before-restore-<2..=99>`; no two names equal when compared without case (Windows names
/// are case-insensitive); and no pre-restore folder before the swap.
pub(super) fn validate_journal(j: &RestoreJournal) -> Result<()> {
    let paths = [&j.staging, &j.target]
        .into_iter()
        .chain(j.before_restore.as_ref());
    let parent = j.staging.parent();
    if parent.is_none()
        || !paths
            .clone()
            .all(|p| plain_absolute(p) && p.parent() == parent)
    {
        return Err(DAMAGED);
    }
    validate_staging_name(&j.staging)?;
    let target = name_of(&j.target).ok_or(DAMAGED)?;
    if target.to_lowercase().starts_with(STAGING_PREFIX) || is_pre_restore_name(target) {
        return Err(DAMAGED);
    }
    match (&j.before_restore, j.step) {
        (None, _) => {}
        (Some(_), JournalStep::Extracting) => return Err(DAMAGED),
        (Some(b), JournalStep::Swapping) => {
            let numbered = name_of(b)
                .and_then(|b| b.strip_prefix(target))
                .and_then(|b| b.strip_prefix(PRE_RESTORE))
                .ok_or(DAMAGED)?;
            let number = numbered.strip_prefix('-');
            let ok = numbered.is_empty()
                || number.is_some_and(|n| {
                    n.bytes().all(|b| b.is_ascii_digit())
                        && !n.starts_with('0')
                        && matches!(n.parse::<u8>(), Ok(2..=99))
                });
            if !ok {
                return Err(DAMAGED);
            }
        }
    }
    let mut names: Vec<String> = paths
        .filter_map(|p| name_of(p).map(str::to_lowercase))
        .collect();
    let all = names.len();
    names.sort();
    names.dedup();
    if names.len() != all {
        return Err(DAMAGED);
    }
    Ok(())
}

/// The whole of spec 6.8 journal validation: [`validate_journal`], then the part that looks at
/// the disk: each of the journal's folders that exists must be a real folder, not a file,
/// link, junction or other reparse point (by `symlink_metadata`). Refused as `Damaged`, with
/// nothing touched, before any deletion or move.
pub(super) fn validate_journal_on_disk(j: &RestoreJournal) -> Result<()> {
    validate_journal(j)?;
    let paths = [&j.staging, &j.target]
        .into_iter()
        .chain(j.before_restore.as_ref());
    for path in paths {
        match check_folder(path) {
            Err(CoreError::InvalidInput {
                what: "not a plain folder",
            }) => return Err(DAMAGED),
            other => other?,
        }
    }
    Ok(())
}

/// Whether anything at all is at `path`: a file, a folder, a link, even a dangling one.
pub(super) fn journal_exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}

/// Serializes `j`. Fails on a path that is not valid Unicode, before anything is written.
fn journal_bytes(j: &RestoreJournal) -> Result<Vec<u8>> {
    serde_json::to_vec_pretty(j).map_err(|_| CoreError::InvalidInput {
        what: "restore journal",
    })
}

/// Publishes the first journal of an operation. It fails with "restore in progress", and
/// changes nothing, if anything at all is already at `path`: the journal belongs to whoever
/// put it there. Later updates by that owner use [`write_journal`].
pub(super) fn create_journal(path: &Path, j: &RestoreJournal) -> Result<()> {
    atomic_create(path, &journal_bytes(j)?).map_err(|e| match e {
        CoreError::InvalidInput {
            what: "destination exists",
        } => IN_PROGRESS,
        other => other,
    })
}

/// Replaces the journal at `path` with a new version of the owner's own journal.
pub(super) fn write_journal(path: &Path, j: &RestoreJournal) -> Result<()> {
    atomic_write(path, &journal_bytes(j)?)
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

/// Removes the staging folder, retrying while another program holds something in it. Refused,
/// with nothing touched: a name that is not a staging name; a folder whose real name in its
/// parent is not exactly that name (Windows finds a folder under any letter case, but only
/// `.restore-` in lowercase followed by lowercase hex is a staging folder); a path that is
/// not a real folder (a link, junction or other reparse point). A folder that is already gone
/// counts as removed.
pub(super) fn remove_staging(staging: &Path) -> Result<()> {
    validate_staging_name(staging)?;
    match fs::symlink_metadata(staging) {
        Ok(_) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    }
    let name = staging.file_name().ok_or(DAMAGED)?;
    let real = fs::read_dir(parent_dir(staging))?
        .filter_map(std::result::Result::ok)
        .any(|entry| entry.file_name() == name);
    if !real {
        return Err(DAMAGED);
    }
    check_folder(staging)?;
    #[cfg(test)]
    crate::fsio::failpoint::check("restore.remove_staging")?;
    remove_dir_all_retry(staging)
}

/// The exclusive lock on `<journal>.lock`, beside the journal, until dropped. Whoever looks at
/// the journal in order to publish, replace or remove it holds it, so no one can publish or
/// remove in between a look and the act. The OS releases it when the handle closes, so a crash
/// never leaves it held, and a leftover lock file that nobody holds is simply locked again.
#[derive(Debug)]
pub(super) struct JournalLock {
    _file: File,
}

/// Takes the journal lock, waiting for whoever holds it (they hold it for a read and a delete,
/// not for a restore). Never call it while already holding the lock: a second handle in the
/// same process waits for the first. Recovery holds the lock for its whole run and uses
/// [`remove_staging`] and [`remove_journal_if_owner`] with it.
pub(super) fn lock_journal(journal: &Path) -> Result<JournalLock> {
    let file = open_lock_file(journal)?;
    file.lock()?;
    Ok(JournalLock { _file: file })
}

/// A new handle on `<journal>.lock`, created if missing, not yet locked.
fn open_lock_file(journal: &Path) -> Result<File> {
    let mut name = journal.file_name().ok_or(DAMAGED)?.to_owned();
    name.push(".lock");
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    // No FILE_SHARE_DELETE (read + write only), as for the vault lock: a held lock file cannot
    // be deleted and replaced by a fresh one that someone else then locks as well.
    #[cfg(windows)]
    std::os::windows::fs::OpenOptionsExt::share_mode(&mut options, 1 | 2);
    Ok(options.open(journal.with_file_name(name))?)
}

/// Test probe: whether anyone holds the journal lock right now, asked through a separate
/// handle with `try_lock`, which never waits (and releases at once if it got the lock).
#[cfg(test)]
pub(super) fn lock_is_held(journal: &Path) -> bool {
    use std::fs::TryLockError;
    match open_lock_file(journal).unwrap().try_lock() {
        Ok(()) => false,
        Err(TryLockError::WouldBlock) => true,
        Err(TryLockError::Error(e)) => panic!("probing the journal lock: {e}"),
    }
}

/// Test hook: every time the failpoint `name` is reached, asserts that the journal lock is
/// held at that moment. The counter says how often it was reached, so a test also proves the
/// critical section ran.
#[cfg(test)]
pub(super) fn observe_lock_held(
    name: &'static str,
    journal: &Path,
) -> std::rc::Rc<std::cell::Cell<u32>> {
    let (journal, count) = (
        journal.to_owned(),
        std::rc::Rc::new(std::cell::Cell::new(0)),
    );
    let seen = count.clone();
    crate::fsio::failpoint::observe(
        name,
        Box::new(move || {
            assert!(
                lock_is_held(&journal),
                "the journal lock is not held at {name}"
            );
            seen.set(seen.get() + 1);
        }),
    );
    count
}

/// How long a test waits for something that must happen before it calls it a hang.
#[cfg(test)]
pub(super) const WATCHDOG: std::time::Duration = std::time::Duration::from_secs(30);

/// Removes the journal at `journal` if it is readable and still names `staging`. A journal of
/// another operation, an unreadable one and a missing one are left alone. The lock proves
/// nobody can publish or remove a journal between the read and the delete.
pub(super) fn remove_journal_if_owner(
    _lock: &JournalLock,
    journal: &Path,
    staging: &Path,
) -> Result<()> {
    match read_journal(journal) {
        Ok(Some(j)) if j.staging == staging => {
            #[cfg(test)]
            crate::fsio::failpoint::check("journal.before_owner_delete")?;
            remove_file_retry(journal)
        }
        _ => Ok(()),
    }
}

/// [`remove_journal_if_owner`] under a lock taken just for it.
pub(super) fn remove_own_journal(journal: &Path, staging: &Path) -> Result<()> {
    remove_journal_if_owner(&lock_journal(journal)?, journal, staging)
}

/// Removes the staging folder, then the journal, and only if the first worked (the journal is
/// what lets the next launch finish the job) and only if it still names this staging folder.
/// See [`remove_staging`] for what is refused.
pub(super) fn remove_staging_then_journal(staging: &Path, journal: &Path) -> Result<()> {
    remove_staging(staging)?;
    remove_own_journal(journal, staging)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsio::failpoint;
    use crate::fsio::testutil::{TempDir, make_dir_link, names};
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::sync::mpsc;
    use std::thread;

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

    /// A staging folder with a file in a subfolder, and the journal that names it.
    fn staged(dir: &Path) -> (PathBuf, PathBuf) {
        let staging = new_staging_path(dir);
        fs::create_dir_all(staging.join("items")).unwrap();
        fs::write(staging.join("items").join("x.item"), b"x").unwrap();
        let journal = dir.join("j.json");
        let entry = RestoreJournal {
            step: JournalStep::Extracting,
            staging: staging.clone(),
            before_restore: None,
            ..self::journal(dir)
        };
        write_journal(&journal, &entry).unwrap();
        (staging, journal)
    }

    #[test]
    fn removes_the_staging_folder_then_the_journal() {
        let dir = TempDir::new();
        let (staging, journal) = staged(dir.path());
        remove_staging_then_journal(&staging, &journal).unwrap();
        assert!(!staging.exists() && !journal.exists());
        // Already gone counts as removed, and so does a journal that is gone.
        let (staging, journal) = staged(dir.path());
        fs::remove_dir_all(&staging).unwrap();
        remove_staging_then_journal(&staging, &journal).unwrap();
        assert!(!journal.exists());
        remove_staging_then_journal(&staging, &journal).unwrap();
    }

    /// The journal goes only if it still names this staging folder: another operation's stays.
    #[test]
    fn another_operations_journal_is_left_alone() {
        let dir = TempDir::new();
        let (staging, journal) = staged(dir.path());
        let other = new_staging_path(dir.path());
        let theirs = RestoreJournal {
            staging: other.clone(),
            ..self::journal(dir.path())
        };
        // Another operation has taken the journal over.
        write_journal(&journal, &theirs).unwrap();
        let bytes = fs::read(&journal).unwrap();

        remove_staging_then_journal(&staging, &journal).unwrap();
        assert!(!staging.exists(), "this operation's folder goes");
        assert_eq!(fs::read(&journal).unwrap(), bytes);
        // An unreadable or a missing journal is left alone and not reported either.
        fs::write(&journal, b"garbage").unwrap();
        remove_own_journal(&journal, &other).unwrap();
        assert!(journal.exists());
        remove_own_journal(&dir.path().join("none"), &other).unwrap();
        // Its owner removes it.
        write_journal(&journal, &theirs).unwrap();
        remove_own_journal(&journal, &other).unwrap();
        assert!(!journal.exists());
    }

    /// A's cleanup has read that the journal is A's and is about to delete it. At that moment
    /// the lock is held (asked through a separate handle), so B, which starts right there and
    /// asks for it, can publish only after A's delete: it would fail "restore in progress"
    /// against A's journal otherwise. A stale second cleanup of A then leaves B's journal.
    #[test]
    fn nobody_publishes_between_the_owner_check_and_the_delete() {
        let dir = TempDir::new();
        let (staging_a, journal) = staged(dir.path());
        let staging_b = new_staging_path(dir.path());
        let held = observe_lock_held("journal.before_owner_delete", &journal);
        // B is started inside the critical section, right after the probe has run.
        let b = Rc::new(RefCell::new(None));
        let (slot, journal_b, staging, parent) = (
            b.clone(),
            journal.clone(),
            staging_b.clone(),
            dir.path().to_owned(),
        );
        failpoint::observe(
            "journal.before_owner_delete",
            Box::new(move || {
                let (journal, staging, parent) =
                    (journal_b.clone(), staging.clone(), parent.clone());
                *slot.borrow_mut() = Some(thread::spawn(move || {
                    let lock = lock_journal(&journal).unwrap();
                    let entry = RestoreJournal {
                        step: JournalStep::Extracting,
                        staging,
                        before_restore: None,
                        ..self::journal(&parent)
                    };
                    create_journal(&journal, &entry).unwrap();
                    drop(lock);
                }));
            }),
        );
        remove_staging_then_journal(&staging_a, &journal).unwrap();
        failpoint::disarm_all();
        assert_eq!(held.get(), 1, "the critical section was reached once");

        b.borrow_mut().take().unwrap().join().unwrap();
        assert!(!staging_a.exists());
        assert_eq!(read_journal(&journal).unwrap().unwrap().staging, staging_b);
        // A second, stale cleanup of A finds B's journal and leaves it ...
        remove_staging_then_journal(&staging_a, &journal).unwrap();
        assert_eq!(read_journal(&journal).unwrap().unwrap().staging, staging_b);
        // ... and the lock is free again once nobody is working on the journal.
        assert!(!lock_is_held(&journal));
    }

    #[test]
    fn the_lock_is_exclusive_and_lives_beside_the_journal() {
        let dir = TempDir::new();
        let journal = dir.path().join("restore-journal.json");
        assert!(!lock_is_held(&journal));
        let first = lock_journal(&journal).unwrap();
        assert!(lock_is_held(&journal), "a second handle cannot take it");
        assert_eq!(names(dir.path()), ["restore-journal.json.lock"]);
        #[cfg(windows)]
        assert!(
            fs::remove_file(dir.path().join("restore-journal.json.lock")).is_err(),
            "a held lock file cannot be deleted"
        );
        // A waiter gets it once the first holder lets go (the watchdog only catches a hang).
        let (tx, rx) = mpsc::channel();
        let again = journal.clone();
        let handle = thread::spawn(move || {
            let second = lock_journal(&again).unwrap();
            tx.send(()).unwrap();
            drop(second);
        });
        drop(first);
        rx.recv_timeout(WATCHDOG)
            .expect("the waiter never got the lock");
        handle.join().unwrap();
        assert!(!lock_is_held(&journal));
        // The lock file is not a journal.
        assert!(!journal_exists(&journal).unwrap());
    }

    /// The first publish never replaces anything, whatever is at the path.
    #[test]
    fn create_journal_refuses_any_existing_entry() {
        let dir = TempDir::new();
        let path = dir.path().join("restore-journal.json");
        let j = journal(dir.path());
        create_journal(&path, &j).unwrap();
        assert_eq!(read_journal(&path).unwrap().unwrap().target, j.target);
        let before = fs::read(&path).unwrap();
        assert!(matches!(
            create_journal(&path, &journal(dir.path())),
            Err(CoreError::InvalidInput {
                what: "restore in progress"
            })
        ));
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(names(dir.path()), ["restore-journal.json"]);

        let folder = dir.path().join("folder");
        fs::create_dir(&folder).unwrap();
        assert!(create_journal(&folder, &j).is_err());
        let gone = TempDir::new();
        let link = dir.path().join("link");
        make_dir_link(&link, gone.path());
        drop(gone);
        assert!(matches!(
            create_journal(&link, &j),
            Err(CoreError::InvalidInput {
                what: "restore in progress"
            })
        ));
        assert!(fs::symlink_metadata(&link).is_ok());
        assert!(
            journal_exists(&link).unwrap() && !journal_exists(&dir.path().join("none")).unwrap()
        );
    }

    /// Windows finds a folder under any spelling; only its real name makes it a staging folder.
    #[cfg(windows)]
    #[test]
    fn a_staging_name_in_another_letter_case_is_not_removed() {
        let dir = TempDir::new();
        let hex = "0123456789abcdef".repeat(2);
        let real = dir.path().join(format!(".RESTORE-{}", hex.to_uppercase()));
        fs::create_dir(&real).unwrap();
        fs::write(real.join("keep"), b"keep").unwrap();
        let asked = dir.path().join(format!(".restore-{hex}"));
        validate_staging_name(&asked).unwrap();
        assert!(asked.exists(), "Windows resolves the lowercase spelling");
        let journal = dir.path().join("j.json");
        fs::write(&journal, b"{}").unwrap();

        assert!(remove_staging_then_journal(&asked, &journal).is_err());
        assert!(real.join("keep").exists() && journal.exists());
    }

    /// A journal that passes validation. Nothing is created: only the paths are looked at.
    fn valid() -> RestoreJournal {
        let dir = std::env::temp_dir().join("lockbox-journal-paths");
        RestoreJournal {
            staging: dir.join(format!(".restore-{}", "ab".repeat(16))),
            ..journal(&dir)
        }
    }

    #[test]
    fn journal_paths_follow_the_recovery_rules() {
        validate_journal(&valid()).unwrap();
        let ok = || RestoreJournal {
            step: JournalStep::Extracting,
            before_restore: None,
            ..valid()
        };
        validate_journal(&ok()).unwrap();
        let j = valid();
        let parent = j.target.parent().unwrap().to_owned();
        let t = j.target.clone();
        let with_b = |b: &str| RestoreJournal {
            before_restore: Some(parent.join(b)),
            ..valid()
        };
        let named = |s: String| RestoreJournal {
            target: parent.join(s),
            ..valid()
        };
        let hex = "cd".repeat(16);
        let bad: Vec<(&str, RestoreJournal)> = vec![
            (
                "relative staging",
                RestoreJournal {
                    staging: PathBuf::from(format!(".restore-{hex}")),
                    ..valid()
                },
            ),
            (
                "dot dot",
                RestoreJournal {
                    target: parent.join("..").join("Family-x"),
                    ..valid()
                },
            ),
            (
                "other parent",
                RestoreJournal {
                    target: parent.join("sub").join("Family-x"),
                    ..valid()
                },
            ),
            (
                "staging name",
                RestoreJournal {
                    staging: parent.join("Family-x"),
                    ..valid()
                },
            ),
            ("target is a staging name", named(format!(".restore-{hex}"))),
            (
                "target is a staging name, other case",
                named(format!(".RESTORE-{hex}")),
            ),
            (
                "target holds before-restore",
                named("Family.before-restore".into()),
            ),
            (
                "target holds before-restore, other case",
                named("Family.BEFORE-RESTORE".into()),
            ),
            ("pre-restore name unrelated", with_b("Other.before-restore")),
            (
                "pre-restore number 1",
                with_b("Family-abababab.before-restore-1"),
            ),
            (
                "pre-restore number 100",
                with_b("Family-abababab.before-restore-100"),
            ),
            (
                "pre-restore number 02",
                with_b("Family-abababab.before-restore-02"),
            ),
            (
                "pre-restore number +5",
                with_b("Family-abababab.before-restore-+5"),
            ),
            (
                "same name as target",
                RestoreJournal {
                    before_restore: Some(t.clone()),
                    ..valid()
                },
            ),
            (
                "extracting with a pre-restore folder",
                RestoreJournal {
                    step: JournalStep::Extracting,
                    ..valid()
                },
            ),
        ];
        for (what, j) in bad {
            assert!(
                matches!(
                    validate_journal(&j),
                    Err(CoreError::Damaged {
                        what: "restore journal"
                    })
                ),
                "{what}"
            );
        }
        for good in [
            "Family-abababab.before-restore-2",
            "Family-abababab.before-restore-99",
        ] {
            validate_journal(&with_b(good)).unwrap();
        }
        assert!(!plain_absolute(&parent.join("..")));
        assert!(plain_absolute(&parent));
        assert!(!plain_absolute(Path::new("relative")));
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
