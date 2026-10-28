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
pub(super) const DAMAGED: CoreError = CoreError::Damaged {
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

/// How far a restore got: the journal's `step`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JournalStep {
    /// The backup was being copied into the staging folder; nothing had moved.
    Extracting,
    /// The swap had begun: the old vault may be at `before_restore`, the restored one at the
    /// target or still in the staging folder.
    Swapping,
}

/// What a restore journal says, read without acting on it ([`inspect_restore_journal`]), so the
/// interface can tell the user where things are. The paths are the user's own folders: shown
/// to them, never put in error text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalView {
    pub step: JournalStep,
    /// The hidden `.restore-<hex>` folder the backup was extracted into.
    pub staging: PathBuf,
    /// The folder the restored vault takes.
    pub target: PathBuf,
    /// Where the vault that was there went, once the swap had begun.
    pub before_restore: Option<PathBuf>,
    /// Whether the folder that holds all three is there (it is not while its drive is
    /// unplugged; recovery then says `RestorePending`).
    pub parent_present: bool,
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
        && !has_dot_segment(path)
}

/// Whether the text of `path` has a `.` segment. `Path::components` drops those inside a path
/// (`a/./b` has the components `a`, `b`), so this looks at the raw text, past the Windows prefix
/// (`\\.\` device paths have one), split on `/` and, on Windows, `\`.
fn has_dot_segment(path: &Path) -> bool {
    let bytes = path.as_os_str().as_encoded_bytes();
    let prefix = match path.components().next() {
        Some(Component::Prefix(p)) => p.as_os_str().len(),
        _ => 0,
    };
    bytes[prefix..]
        .split(|&b| b == b'/' || (cfg!(windows) && b == b'\\'))
        .any(|segment| segment == b".")
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
/// the disk: each of the journal's folders that exists must be a real folder (`check_folder`,
/// by `symlink_metadata`), not a file, a link, a junction or another reparse point that
/// redirects (a Windows "name surrogate"), and the staging folder must be listed in its parent
/// under exactly the journal's name ([`check_real_name`]). Refused as `Damaged`, with nothing
/// touched, before any deletion, move or rename.
pub(super) fn validate_journal_on_disk(j: &RestoreJournal) -> Result<()> {
    validate_journal(j)?;
    if journal_exists(&j.staging)? {
        check_real_name(&j.staging)?;
    }
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

/// The journal at `path`, read under the held lock and through the whole of spec 6.8 validation
/// ([`read_journal`], then [`validate_journal_on_disk`]): what recovery acts on and what
/// [`inspect_restore_journal`] shows. A missing journal is `None`. Reads only.
pub(super) fn read_checked_journal(
    _lock: &JournalLock,
    path: &Path,
) -> Result<Option<RestoreJournal>> {
    let Some(j) = read_journal(path)? else {
        return Ok(None);
    };
    validate_journal_on_disk(&j)?;
    Ok(Some(j))
}

/// Reads the restore journal at `journal` without acting on it: `None` when there is none.
/// It fails exactly as startup recovery does on the same file (too large, an unknown version,
/// or `Damaged { what: "restore journal" }`, links included) and touches no folder. It reads
/// under the journal lock, so it writes nothing but `<journal>.lock`, created if missing.
pub fn inspect_restore_journal(journal: &Path) -> Result<Option<JournalView>> {
    let lock = lock_journal(journal)?;
    Ok(read_checked_journal(&lock, journal)?.map(|j| JournalView {
        parent_present: check_staging_parent(&j.staging).is_ok(),
        step: j.step,
        staging: j.staging,
        target: j.target,
        before_restore: j.before_restore,
    }))
}

/// Refused, as `Damaged`, unless the existing entry at `path` is listed in its parent under
/// exactly this name. Windows finds a folder under any letter case, but only `.restore-` in
/// lowercase followed by lowercase hex is a staging folder.
fn check_real_name(path: &Path) -> Result<()> {
    let name = path.file_name().ok_or(DAMAGED)?;
    let real = fs::read_dir(parent_dir(path))?
        .filter_map(std::result::Result::ok)
        .any(|entry| entry.file_name() == name);
    if real { Ok(()) } else { Err(DAMAGED) }
}

/// Removes the staging folder, retrying while another program holds something in it. Refused,
/// with nothing touched: a name that is not a staging name; a folder whose real name in its
/// parent is not exactly that name ([`check_real_name`]); a path that is not a real folder (a
/// link, a junction or another reparse point that redirects: a Windows "name surrogate"). A
/// folder that is already gone counts as removed.
pub(super) fn remove_staging(staging: &Path) -> Result<()> {
    validate_staging_name(staging)?;
    if !journal_exists(staging)? {
        return Ok(());
    }
    check_real_name(staging)?;
    check_folder(staging)?;
    #[cfg(any(test, feature = "test-internals"))]
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
            #[cfg(any(test, feature = "test-internals"))]
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

/// Fails with `RestorePending` unless the folder that holds `staging` (the vaults folder) is an
/// existing folder. Without it, as when its drive is not plugged in, the staging folder and the
/// target both read as missing, which says nothing about them: recovery and the clean-up after
/// a failed restore then decide nothing, and the journal stays for a later recovery or for the
/// user's dismissal.
pub(super) fn check_staging_parent(staging: &Path) -> Result<()> {
    if parent_dir(staging).is_dir() {
        Ok(())
    } else {
        Err(CoreError::RestorePending)
    }
}

/// Removes the staging folder, then the journal, and only if the first worked (the journal is
/// what lets the next launch finish the job) and only if it still names this staging folder.
/// While the folder that holds the staging folder is missing, neither goes
/// ([`check_staging_parent`]). See [`remove_staging`] for what is refused.
pub(super) fn remove_staging_then_journal(staging: &Path, journal: &Path) -> Result<()> {
    check_staging_parent(staging)?;
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
        // With no pre-restore folder, so only the target's own name can be what is refused.
        let named = |s: String| RestoreJournal {
            target: parent.join(s),
            before_restore: None,
            ..valid()
        };
        // All three folders in one directory, so only that directory's own path can be refused.
        let under = |dir: &Path| RestoreJournal {
            staging: dir.join(j.staging.file_name().unwrap()),
            target: dir.join(t.file_name().unwrap()),
            before_restore: Some(dir.join("Family-abababab.before-restore")),
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
            ("dot dot", under(&parent.join("sub").join(".."))),
            ("dot", under(&parent.join("."))),
            ("dot inside", under(&parent.join(".").join("sub"))),
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
        // `components()` drops an interior `.`, so the raw text has to be looked at.
        assert!(
            parent.join(".").join("x").components().count()
                == parent.join("x").components().count()
        );
        assert!(!plain_absolute(&parent.join(".").join("x")));
        assert!(!plain_absolute(&parent.join("x").join(".")));
        assert!(plain_absolute(&parent.join(".x").join("..x")));
        #[cfg(windows)]
        {
            assert!(!plain_absolute(Path::new(r"C:\a\.\b")));
            assert!(plain_absolute(Path::new(r"\\.\C:\a\b")));
        }
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

    // ---- Plan 3 Task 5: reading the journal without acting on it.

    use crate::vault::restore::tests::{Tree, tree};
    use crate::vault::restore::{Recovery, recover_restore};

    /// A journal's folder, and the journal path inside it.
    fn journal_place() -> (TempDir, PathBuf) {
        let dir = TempDir::new();
        let path = dir.path().join("restore-journal.json");
        (dir, path)
    }

    /// Everything under `dir` except the journal's lock file, the one thing inspecting may write.
    fn without_lock(dir: &Path) -> Tree {
        tree(dir)
            .into_iter()
            .filter(|(name, _)| name != "restore-journal.json.lock")
            .collect()
    }

    #[track_caller]
    fn assert_same_error<T: std::fmt::Debug, U: std::fmt::Debug>(
        inspected: Result<T>,
        recovered: Result<U>,
    ) {
        let (inspected, recovered) = (inspected.unwrap_err(), recovered.unwrap_err());
        assert_eq!(format!("{inspected:?}"), format!("{recovered:?}"));
    }

    /// A state recovery acts on (B there, T missing: it would move B back and remove S). The
    /// view says what the journal says, and nothing changes but the lock file, whether it was
    /// there before or not; recovery, run afterwards, still finds everything to do.
    #[test]
    fn inspect_reads_without_acting() {
        let parent = TempDir::new();
        let (journal_dir, path) = journal_place();
        let j = journal(parent.path());
        let b = j.before_restore.clone().unwrap();
        for (dir, marker) in [(&j.staging, "S"), (&b, "B")] {
            fs::create_dir(dir).unwrap();
            fs::write(dir.join("marker"), marker).unwrap();
        }
        write_journal(&path, &j).unwrap();
        let before = (tree(parent.path()), tree(journal_dir.path()));

        for round in ["no lock file yet", "lock file there"] {
            let view = inspect_restore_journal(&path).unwrap().unwrap();
            let expected = JournalView {
                step: JournalStep::Swapping,
                staging: j.staging.clone(),
                target: j.target.clone(),
                before_restore: Some(b.clone()),
                parent_present: true,
            };
            assert_eq!(view, expected, "{round}");
            let after = (tree(parent.path()), without_lock(journal_dir.path()));
            assert!(after == before, "{round}: a file or folder changed");
            assert!(!lock_is_held(&path), "{round}: the lock was kept");
        }
        assert_eq!(
            names(journal_dir.path()),
            ["restore-journal.json", "restore-journal.json.lock"]
        );
        assert_eq!(recover_restore(&path).unwrap(), Recovery::RolledBack);
        assert_eq!(fs::read_to_string(j.target.join("marker")).unwrap(), "B");
    }

    /// The folder that holds S, T and B is gone (its drive is not plugged in): the view says
    /// so, as recovery's `RestorePending` does, and nothing is created there.
    #[test]
    fn inspect_reports_missing_parent() {
        let parent = TempDir::new();
        let (_journal_dir, path) = journal_place();
        let gone = parent.path().join("unplugged");
        let j = journal(&gone);
        write_journal(&path, &j).unwrap();
        let bytes = fs::read(&path).unwrap();

        let view = inspect_restore_journal(&path).unwrap().unwrap();
        assert!(!view.parent_present);
        assert_eq!(
            (view.step, view.staging, view.target, view.before_restore),
            (
                j.step,
                j.staging.clone(),
                j.target.clone(),
                j.before_restore.clone()
            )
        );
        assert!(matches!(
            recover_restore(&path),
            Err(CoreError::RestorePending)
        ));
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert!(!gone.exists(), "the folder was created");

        // Plugged in again.
        fs::create_dir(&gone).unwrap();
        assert!(
            inspect_restore_journal(&path)
                .unwrap()
                .unwrap()
                .parent_present
        );
    }

    #[test]
    fn inspect_no_journal_is_none() {
        let (journal_dir, path) = journal_place();
        assert_eq!(inspect_restore_journal(&path).unwrap(), None);
        assert_eq!(names(journal_dir.path()), ["restore-journal.json.lock"]);
        assert!(!lock_is_held(&path));
    }

    /// A journal recovery refuses is refused the same way here, and kept byte for byte: bad
    /// JSON, a `..` path, a staging folder that is a link, and (not `Damaged`) a newer version
    /// and an oversized file.
    #[test]
    fn inspect_damaged_journal_is_damaged() {
        let parent = TempDir::new();
        let odd = parent.path().join("sub").join("..");
        let dot_dot = RestoreJournal {
            staging: odd.join(format!("{STAGING_PREFIX}{}", "ab".repeat(16))),
            target: odd.join("Family-abababab"),
            before_restore: Some(odd.join("Family-abababab.before-restore")),
            ..journal(parent.path())
        };
        let mut newer = serde_json::to_value(journal(parent.path())).unwrap();
        newer["version"] = 2.into();
        let outside = TempDir::new();
        let linked = journal(parent.path());
        make_dir_link(&linked.staging, outside.path());
        let cases: [(&str, Vec<u8>, bool); 5] = [
            ("bad json", b"{ not json".to_vec(), true),
            ("a .. path", journal_bytes(&dot_dot).unwrap(), true),
            ("a staging link", journal_bytes(&linked).unwrap(), true),
            ("newer version", serde_json::to_vec(&newer).unwrap(), false),
            ("too large", vec![b' '; MAX_JOURNAL_BYTES + 1], false),
        ];
        for (what, bytes, is_damaged) in cases {
            let (_journal_dir, path) = journal_place();
            fs::write(&path, &bytes).unwrap();
            let before = tree(parent.path());

            let inspected = inspect_restore_journal(&path);
            if is_damaged {
                assert!(
                    matches!(
                        inspected,
                        Err(CoreError::Damaged {
                            what: "restore journal"
                        })
                    ),
                    "{what}: {inspected:?}"
                );
            }
            assert_same_error(inspected, recover_restore(&path));
            assert_eq!(
                fs::read(&path).unwrap(),
                bytes,
                "{what}: the journal changed"
            );
            assert!(tree(parent.path()) == before, "{what}: a folder changed");
        }
        assert!(fs::symlink_metadata(&linked.staging).is_ok());
    }

    /// Property tests (spec 5.4): the journal is read back from the user's profile, where it
    /// may be cut short or damaged, so any bytes are an error or a journal, never a panic, and
    /// the error text never repeats the input.
    mod never_panics {
        use super::*;
        use crate::archive::testkit::{assert_text_is_fixed, mutated};
        use proptest::collection::vec;
        use proptest::prelude::*;
        use std::sync::LazyLock;

        /// A journal as `write_journal` writes it, serialized once. Forward slashes keep the
        /// JSON free of escapes.
        static VALID: LazyLock<Vec<u8>> = LazyLock::new(|| {
            let j = RestoreJournal {
                version: RESTORE_JOURNAL_VERSION,
                step: JournalStep::Swapping,
                staging: PathBuf::from(format!("C:/Vaults/{STAGING_PREFIX}{}", "ab".repeat(16))),
                target: PathBuf::from("C:/Vaults/Family-abababab"),
                before_restore: Some(PathBuf::from("C:/Vaults/Family-abababab.before-restore")),
            };
            journal_bytes(&j).unwrap()
        });

        /// Half the cases are random bytes, which stop at the size or JSON check; half are a
        /// valid journal with up to three bytes changed, which reach the version peek and the
        /// strict parse.
        fn journal_file_bytes() -> impl Strategy<Value = Vec<u8>> {
            prop_oneof![vec(any::<u8>(), 0..1024), mutated(&VALID, 3)]
        }

        #[test]
        fn the_valid_journal_reads() {
            let dir = TempDir::new();
            let path = dir.path().join("j.json");
            fs::write(&path, &*VALID).unwrap();
            let j = read_journal(&path).unwrap().unwrap();
            assert_eq!(j.step, JournalStep::Swapping);
        }

        proptest! {
            #![proptest_config(ProptestConfig::with_cases(256))]

            #[test]
            fn read_journal_never_panics(bytes in journal_file_bytes()) {
                let dir = TempDir::new();
                let path = dir.path().join("j.json");
                fs::write(&path, &bytes).unwrap();
                if let Err(error) = read_journal(&path) {
                    assert_text_is_fixed(&error, &bytes)?;
                }
            }
        }
    }
}
