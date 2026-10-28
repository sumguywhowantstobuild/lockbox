//! Restore (spec 6.8). Part 1, steps 1 to 4: unlock the backup, choose the destination and
//! extract into a hidden staging folder, with every check done. Part 2, steps 5 and 6: the
//! journaled swap into place ([`PreparedRestore::commit`]), startup recovery
//! ([`recover_restore`]) and dismissal of a journal recovery refused
//! ([`dismiss_restore_journal`]).

use super::cleanup::ORPHANED_DIR;
use super::files::FILES_DIR;
use super::folder_name;
use super::items::ITEMS_DIR;
use super::journal::{
    DAMAGED, IN_PROGRESS, JournalLock, JournalStep, PRE_RESTORE, RESTORE_JOURNAL_VERSION,
    RestoreJournal, check_staging_parent, create_journal, is_pre_restore_name, journal_exists,
    lock_journal, new_staging_path, plain_absolute, read_checked_journal, read_journal,
    remove_journal_if_owner, remove_own_journal, remove_staging, remove_staging_then_journal,
    validate_journal, validate_journal_on_disk, write_journal,
};
use super::naming::{check_folder_name, check_path_room};
use super::readonly::refuse_vault_folder;
use super::source::{
    VaultSource, attached_blobs, attached_refs, check_listed, check_opened, copy_blob,
    manifest_hashes, unlock_source,
};
use super::unlock::{Credential, load};
use crate::archive::{BackupArchive, EntryKind, copy_hashed};
use crate::blob::CancelToken;
use crate::fsio::{
    DESTINATION_EXISTS, atomic_write, check_space, clear_hidden, open_shared_read, parent_dir,
    read_retry, remove_file_retry, rename_dir_no_replace, set_hidden, sync_dir, volume_info,
};
use crate::header::{HEADER_BACKUP, HEADER_FILE, MAX_HEADER_BYTES};
use crate::ids::{FileId, VaultId};
use crate::item::FileRef;
use crate::lockfile::VaultLock;
use crate::{CoreError, Result};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

const BAD_PATH: CoreError = CoreError::InvalidInput {
    what: "restore path",
};
const SEVERAL_COPIES: CoreError = CoreError::InvalidInput {
    what: "several copies of this vault",
};
const ALREADY_HERE: CoreError = CoreError::InvalidInput {
    what: "vault already here",
};

/// Where a restore puts the vault, in the parent folder it is given (spec 6.8 step 3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestoreDestination {
    /// The folder of the same vault, which is replaced (its old copy kept as
    /// `<folder>.before-restore`); without one, a new folder `<name>-<short id>`.
    SameVault,
    /// A new folder of this name, which must not exist yet, when no readable copy of the vault
    /// is in the parent: for a vault folder whose two header copies are unreadable, so restore
    /// cannot tell it is the same vault, and which it leaves untouched.
    NewFolder(String),
}

/// A backup that is unlocked, checked and extracted into a hidden staging folder beside its
/// destination, ready to be swapped in. Dropping it discards the staging folder.
pub struct PreparedRestore {
    /// Held open (read-only) until the restore is done, so the backup cannot change meanwhile.
    archive: VaultSource,
    staging: PathBuf,
    /// The folder the restored vault takes: `existing`, or a new `<name>-<short id>`.
    target: PathBuf,
    existing: Option<PathBuf>,
    journal: PathBuf,
    name: String,
    vault_id: VaultId,
    /// Dropping cleans up the staging folder and the journal. Off once the swap is past the
    /// point where only recovery may decide what to do with them.
    armed: bool,
    /// The swap went through.
    finished: bool,
    /// The last swap attempt got as far as writing `swapping` into the journal, so only
    /// recovery can say what its error left behind.
    swap_started: bool,
}

/// What a finished (or recovered) swap left on disk.
#[derive(Debug)]
pub struct RestoreOutcome {
    /// The restored vault's folder.
    pub dir: PathBuf,
    /// Where the vault that was there before went, if there was one.
    pub before_restore: Option<PathBuf>,
}

/// What [`recover_restore`] did.
#[derive(Debug, PartialEq, Eq)]
pub enum Recovery {
    /// There was no journal.
    NothingToDo,
    /// A restore that had not started swapping: its staging folder and journal are gone.
    StagingRemoved,
    /// A swap that had not finished is undone: the old vault is at its place again.
    RolledBack,
    /// The swap had finished except for the clean-up, which is now done.
    Finished,
}

const UNCLEAR: CoreError = CoreError::InvalidInput {
    what: "restore state unclear",
};

/// The archive inside a source that `prepare` opened as one.
fn archive_of(src: &VaultSource) -> &BackupArchive {
    match src {
        VaultSource::Archive(a) => a,
        VaultSource::Folder(_) => unreachable!("restore opens a backup archive"),
    }
}

/// The one folder directly inside `parent` that holds the vault `id`, if any. Hidden folders
/// (a staging folder among them) and pre-restore copies are never the vault to replace; two
/// candidates are refused.
fn find_existing(parent: &Path, id: &VaultId, cancel: &CancelToken) -> Result<Option<PathBuf>> {
    let mut found = None;
    for entry in fs::read_dir(parent)? {
        cancel.check()?;
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        // A link or a junction is not a folder here: `file_type` does not follow it, and std's
        // `is_dir` is false for every reparse point that redirects (a Windows "name surrogate").
        if name.starts_with('.') || is_pre_restore_name(&name) || !entry.file_type()?.is_dir() {
            continue;
        }
        let dir = entry.path();
        let header = load(&dir.join(HEADER_FILE)).or_else(|_| load(&dir.join(HEADER_BACKUP)));
        if !header.is_ok_and(|h| h.header.vault_id == *id) {
            continue;
        }
        if found.replace(dir).is_some() {
            return Err(SEVERAL_COPIES);
        }
    }
    Ok(found)
}

/// `parent/folder`, for a vault folder that does not exist yet: refused with "destination
/// exists" if anything at all is at that name, a dangling link included (by
/// `symlink_metadata`, which on Windows also finds a name that differs only in letter case). A
/// new folder never replaces anything, and the swap's no-replace rename refuses again if
/// something takes the name after this look.
fn new_folder_target(parent: &Path, folder: &str) -> Result<PathBuf> {
    let target = parent.join(folder);
    if journal_exists(&target)? {
        return Err(DESTINATION_EXISTS);
    }
    Ok(target)
}

/// Test hook: once an entry is written, closed and synced, flips one data byte of it, so the
/// read-back that follows must catch it.
#[cfg(any(test, feature = "test-internals"))]
fn corrupt_if_armed(path: &Path) -> Result<()> {
    if crate::fsio::failpoint::check("restore.corrupt_extract").is_err() {
        crate::fsio::testutil::flip_byte(path, 0)?;
    }
    Ok(())
}

impl PreparedRestore {
    /// Spec 6.8 steps 1 to 4. Everything that can refuse does so before anything is written:
    /// no journal yet, the archive structure, the credential, the manifest MAC and every
    /// header and item hash, the header MAC, no damaged item, no unattached blob, free space,
    /// and the destination ([`RestoreDestination`]: a new folder is refused for a bad name,
    /// checked first of all, for a path too long for Windows, inside a vault folder, while a
    /// readable copy of the vault is in `parent`, and when anything at all is at that name).
    /// Only then is the journal written (before the staging folder
    /// exists) and the backup extracted into `parent/.restore-<hex>`, each entry hashed
    /// against the manifest as it is written and again as it is read back from disk, each blob
    /// authenticated as it is written. Any error after the journal removes the staging folder,
    /// once it exists, and then the journal; from then on, while the parent folder is missing
    /// (its drive is not plugged in), both stay, for startup recovery or the user's dismissal to
    /// settle. A failed `create_dir` made no staging folder, so only the journal goes.
    pub fn prepare(
        archive: &Path,
        parent: &Path,
        credential: Credential,
        destination: RestoreDestination,
        journal: &Path,
        cancel: &CancelToken,
    ) -> Result<PreparedRestore> {
        // A bad name is refused before the archive is even opened (unlocking takes a second).
        if let RestoreDestination::NewFolder(chosen) = &destination {
            check_folder_name(chosen)?;
        }
        // Anything at the journal path counts, a damaged or newer journal too: only recovery
        // reads it.
        if journal_exists(journal)? {
            return Err(IN_PROGRESS);
        }
        // The journal names its folders by absolute paths with only normal components.
        let parent = std::path::absolute(parent)?;
        if !plain_absolute(&parent) {
            return Err(BAD_PATH);
        }
        if let RestoreDestination::NewFolder(chosen) = &destination {
            let target = parent.join(chosen);
            // Every path the restored vault needs must fit Windows' limit, and a vault never
            // goes inside another vault's folder (the damaged one's included).
            check_path_room(&target, &new_staging_path(&parent))?;
            refuse_vault_folder(&target)?;
        }
        let src = VaultSource::Archive(BackupArchive::open(archive, cancel)?);
        let opened = unlock_source(&src, &credential, cancel)?;
        check_opened(&opened)?;
        let refs = attached_refs(&opened);
        attached_blobs(&src, &refs)?;

        let a = archive_of(&src);
        let largest = a.entries().iter().map(|e| e.size).max().unwrap_or(0);
        check_space(a.total_size(), largest, &volume_info(&parent)?)?;

        let (name, vault_id) = (opened.header.name.clone(), opened.header.vault_id);
        let existing = find_existing(&parent, &vault_id, cancel)?;
        let target = match (&destination, &existing) {
            (RestoreDestination::SameVault, Some(dir)) => dir.clone(),
            (RestoreDestination::SameVault, None) => {
                new_folder_target(&parent, &folder_name(&name, &vault_id))?
            }
            // Two writable copies would make every later restore here refuse "several copies".
            (RestoreDestination::NewFolder(_), Some(_)) => return Err(ALREADY_HERE),
            (RestoreDestination::NewFolder(chosen), None) => {
                check_folder_name(chosen)?;
                new_folder_target(&parent, chosen)?
            }
        };

        let staging = new_staging_path(&parent);
        let entry = RestoreJournal {
            version: RESTORE_JOURNAL_VERSION,
            step: JournalStep::Extracting,
            staging: staging.clone(),
            target: target.clone(),
            before_restore: None,
        };
        validate_journal(&entry)?;
        #[cfg(any(test, feature = "test-internals"))]
        crate::fsio::failpoint::check("restore.before_journal")?;
        {
            // The look at the journal path and the publish are one step for everybody who
            // takes the lock; the early check above only refuses sooner.
            let lock = lock_journal(journal)?;
            if journal_exists(journal)? {
                return Err(IN_PROGRESS);
            }
            #[cfg(any(test, feature = "test-internals"))]
            crate::fsio::failpoint::check("restore.under_lock")?;
            if let Err(e) = create_journal(journal, &entry) {
                // An error reported after the journal landed leaves one that is ours; it goes.
                // Anyone else's is not named after this staging folder and stays.
                let _ = remove_journal_if_owner(&lock, journal, &staging);
                return Err(e);
            }
        }
        // Until the folder exists it is not ours to remove: whatever is at that path stays, and
        // only this operation's journal goes.
        let created: Result<()> = (|| {
            #[cfg(any(test, feature = "test-internals"))]
            crate::fsio::failpoint::check("restore.before_staging")?;
            Ok(fs::create_dir(&staging)?)
        })();
        if let Err(e) = created {
            let _ = remove_own_journal(journal, &staging);
            return Err(e);
        }
        // From here on, dropping this (an error below included) cleans up.
        let prepared = PreparedRestore {
            archive: src,
            staging,
            target,
            existing,
            journal: journal.to_owned(),
            name,
            vault_id,
            armed: true,
            finished: false,
            swap_started: false,
        };
        prepared.extract(&refs, cancel)?;
        Ok(prepared)
    }

    /// Hides the staging folder (made by `prepare`) and writes every entry into it, then
    /// `vault.json.bak`.
    /// Each entry gets a new file that is synced and closed before the next, then read back
    /// from disk: the bytes on disk, not the ones just written, must hash to the manifest.
    fn extract(&self, refs: &BTreeMap<FileId, &FileRef>, cancel: &CancelToken) -> Result<()> {
        let staging = &self.staging;
        let (items, files) = (staging.join(ITEMS_DIR), staging.join(FILES_DIR));
        set_hidden(staging)?;
        fs::create_dir(&items)?;
        fs::create_dir_all(files.join(ORPHANED_DIR))?;

        let listed = manifest_hashes(&self.archive);
        for e in archive_of(&self.archive).entries() {
            cancel.check()?;
            let path = staging.join(&e.name);
            let mut file = File::create_new(&path)?;
            match e.kind {
                EntryKind::Blob(id) => {
                    let (vault_id, fref) = (&self.vault_id, refs[&id]);
                    copy_blob(
                        &self.archive,
                        &id,
                        fref,
                        vault_id,
                        &listed,
                        &mut file,
                        cancel,
                    )?;
                }
                _ => {
                    let src = &mut archive_of(&self.archive).reader(e);
                    let hash = copy_hashed(src, e.size, &mut file, cancel)?;
                    check_listed(&listed, &e.name, hash)?;
                }
            }
            file.sync_all()?;
            drop(file); // The read-back below opens it again.
            #[cfg(any(test, feature = "test-internals"))]
            corrupt_if_armed(&path)?;
            let hash = copy_hashed(
                &mut open_shared_read(&path)?,
                e.size,
                &mut io::sink(),
                cancel,
            )?;
            check_listed(&listed, &e.name, hash)?;
            #[cfg(any(test, feature = "test-internals"))]
            crate::fsio::failpoint::check("restore.after_entry")?;
        }

        // The copy is made from the file that was just read back.
        let header = read_retry(&staging.join(HEADER_FILE), MAX_HEADER_BYTES)?;
        atomic_write(&staging.join(HEADER_BACKUP), &header)?;
        for dir in [&items, &files, staging] {
            sync_dir(dir)?;
        }
        Ok(())
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn vault_id(&self) -> VaultId {
        self.vault_id
    }

    pub fn existing(&self) -> Option<&Path> {
        self.existing.as_deref()
    }

    /// Spec 6.8 steps 5 and 6: swaps the staged vault into place. Cancelling is checked once,
    /// before anything happens; once the swap has begun it is never cancelled.
    ///
    /// `VaultInUse` (the vault being replaced is open), a refused first rename and a journal
    /// that cannot be rewritten all leave the restore as it was, for a retry. Any other error
    /// runs recovery: if the swap turns out to be complete, that is `Ok`; if it is undone, the
    /// error that stopped it; if recovery itself could not finish, `RestorePending` (the journal
    /// stays, and the next launch completes the job). The recovery runs after the swap's own
    /// short journal rewrites have released the journal lock, so it can take the lock itself.
    pub fn commit(&mut self, cancel: &CancelToken) -> Result<RestoreOutcome> {
        if self.finished {
            return Err(CoreError::InvalidInput {
                what: "already restored",
            });
        }
        if !self.armed {
            return Err(CoreError::InvalidInput {
                what: "restore discarded",
            });
        }
        cancel.check()?;
        let before = self.choose_before_restore()?;
        let swapped = match self.swap_steps(before.clone()) {
            // Still armed, or refused before the swap began: the restore is as it was.
            Err(e) if self.armed || !self.swap_started => return Err(e),
            Err(e) => match recover_restore(&self.journal) {
                Ok(Recovery::Finished) => Ok(self.outcome(before)),
                Ok(_) => Err(e),
                Err(_) => Err(CoreError::RestorePending),
            },
            done => done,
        };
        self.finished = swapped.is_ok();
        swapped
    }

    fn outcome(&self, before: Option<PathBuf>) -> RestoreOutcome {
        RestoreOutcome {
            dir: self.target.clone(),
            before_restore: before,
        }
    }

    /// Step 1: with a vault to replace, takes its lock (`VaultInUse` if it is open), checks it
    /// is still the vault this restore was prepared for, and picks the first free
    /// `<folder>.before-restore[-2..=99]` name. The lock is dropped again, because Windows
    /// cannot rename a folder with an open handle inside it.
    // shortcut: the lock is released before the rename, so another process could open T in that instant (the rename then fails with nothing moved, the journal goes back to `extracting` and the restore is re-armed for a retry); upgrade if Lockbox ever allows more than one instance (Plan 3 makes it single-instance).
    fn choose_before_restore(&self) -> Result<Option<PathBuf>> {
        let Some(existing) = &self.existing else {
            return Ok(None);
        };
        let lock = VaultLock::acquire(existing)?;
        let header = load(&existing.join(HEADER_FILE))
            .or_else(|_| load(&existing.join(HEADER_BACKUP)))?
            .header;
        if header.vault_id != self.vault_id {
            return Err(CoreError::InvalidInput {
                what: "destination changed",
            });
        }
        let name = existing
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or(BAD_PATH)?;
        let parent = parent_dir(existing);
        let free = (1..=99)
            .map(|n| match n {
                1 => parent.join(format!("{name}{PRE_RESTORE}")),
                n => parent.join(format!("{name}{PRE_RESTORE}-{n}")),
            })
            .find_map(|b| {
                journal_exists(&b)
                    .map(|taken| (!taken).then_some(b))
                    .transpose()
            });
        drop(lock);
        free.unwrap_or(Err(CoreError::InvalidInput {
            what: "too many before-restore copies",
        }))
        .map(Some)
    }

    /// The journal, read under `lock`, if it is this restore's own; else "restore in progress"
    /// (it belongs to another operation, or is gone).
    fn own_journal(&self, _lock: &JournalLock) -> Result<RestoreJournal> {
        match read_journal(&self.journal)? {
            Some(j) if j.staging == self.staging => Ok(j),
            _ => Err(IN_PROGRESS),
        }
    }

    /// Before the first rename, under the held lock: the journal on disk must be exactly this
    /// restore's pre-swap state (`extracting`, no pre-restore folder, the same staging folder and
    /// target) and pass the full validation recovery uses, so S, T and B are real folders and
    /// nothing is renamed through a link. A refusal, an unreadable journal included, is `Damaged`
    /// (or too large, or of an unknown version); it disarms the restore (a drop must not delete
    /// what is not trusted) and leaves the journal and the folders for the user to dismiss. A
    /// journal that is gone or another operation's is "restore in progress" and stays armed.
    fn check_before_swap(&mut self, lock: &JournalLock) -> Result<()> {
        let checked = match self.own_journal(lock) {
            Ok(j)
                if j.target == self.target
                    && j.step == JournalStep::Extracting
                    && j.before_restore.is_none() =>
            {
                validate_journal_on_disk(&j)
            }
            Ok(_) => Err(DAMAGED),
            Err(e) => Err(e),
        };
        if matches!(
            checked,
            Err(CoreError::Damaged { .. }
                | CoreError::TooLarge { .. }
                | CoreError::UnsupportedVersion)
        ) {
            self.armed = false;
        }
        checked
    }

    /// Rewrites the journal with `step` and `before`, under the held `lock` and only if it is
    /// still this restore's own.
    fn rewrite_journal(
        &self,
        lock: &JournalLock,
        step: JournalStep,
        before: Option<PathBuf>,
    ) -> Result<()> {
        self.own_journal(lock)?;
        #[cfg(any(test, feature = "test-internals"))]
        crate::fsio::failpoint::check(match step {
            JournalStep::Swapping => "restore.swap_under_lock",
            JournalStep::Extracting => "restore.revert_under_lock",
        })?;
        let journal = RestoreJournal {
            version: RESTORE_JOURNAL_VERSION,
            step,
            staging: self.staging.clone(),
            target: self.target.clone(),
            before_restore: before,
        };
        write_journal(&self.journal, &journal)
    }

    /// Steps 2 to 5. A test calls it directly to simulate a crash at a failpoint.
    ///
    /// One journal lock is held from the first look at the journal to its deletion, so no one
    /// publishes, replaces, removes or recovers it while folders are being renamed; it is
    /// released on return, before the caller falls back to recovery, which takes it itself.
    ///
    /// The restore stays armed (a drop cleans up) until the journal says `swapping`, and
    /// again if the first rename failed with nothing moved. A refused validation disarms it
    /// without recovery (`swap_started` stays off); any later error leaves it disarmed, and the
    /// caller runs recovery.
    fn swap_steps(&mut self, before: Option<PathBuf>) -> Result<RestoreOutcome> {
        self.swap_started = false;
        let parent = parent_dir(&self.target).to_owned();
        let lock = lock_journal(&self.journal)?;
        // Step 2.
        self.check_before_swap(&lock)?;
        self.rewrite_journal(&lock, JournalStep::Swapping, before.clone())?;
        self.armed = false;
        self.swap_started = true;
        #[cfg(any(test, feature = "test-internals"))]
        crate::fsio::failpoint::check("restore.after_journal")?;

        // Step 3.
        if let Some(b) = &before {
            #[cfg(any(test, feature = "test-internals"))]
            let moved = crate::fsio::failpoint::check("restore.fail_move_existing")
                .and_then(|()| rename_dir_no_replace(&self.target, b))
                .and_then(|()| crate::fsio::failpoint::check("restore.fail_after_move_existing"));
            #[cfg(not(any(test, feature = "test-internals")))]
            let moved = rename_dir_no_replace(&self.target, b);
            if let Err(e) = moved {
                // A rename can report an error after it moved the folder. Only T still in place
                // and B still free prove that nothing moved (so does "destination exists",
                // which is refused before any move: B was taken at the last moment). Then the
                // journal goes back to `extracting` and the restore stays for a retry (if that
                // write fails, the disarmed restore goes to recovery). Otherwise recovery moves
                // B back.
                let refused = matches!(
                    e,
                    CoreError::InvalidInput {
                        what: "destination exists"
                    }
                );
                let in_place = matches!(
                    (journal_exists(&self.target), journal_exists(b)),
                    (Ok(true), Ok(false))
                );
                if refused || in_place {
                    self.armed = self
                        .rewrite_journal(&lock, JournalStep::Extracting, None)
                        .is_ok();
                }
                return Err(e);
            }
        }
        // Reached with or without a vault to replace.
        #[cfg(any(test, feature = "test-internals"))]
        crate::fsio::failpoint::check("restore.after_move_existing")?;

        // Step 4.
        clear_hidden(&self.staging)?;
        #[cfg(any(test, feature = "test-internals"))]
        crate::fsio::failpoint::check("restore.fail_move_staging")?;
        rename_dir_no_replace(&self.staging, &self.target)?;
        #[cfg(any(test, feature = "test-internals"))]
        {
            crate::fsio::failpoint::check("restore.fail_after_move_staging")?;
            crate::fsio::failpoint::check("restore.after_move_staging")?;
        }

        // Step 5.
        sync_dir(&parent)?;
        #[cfg(any(test, feature = "test-internals"))]
        crate::fsio::failpoint::check("restore.before_journal_done")?;
        remove_journal_if_owner(&lock, &self.journal, &self.staging)?;
        Ok(self.outcome(before))
    }
}

/// Startup recovery (spec 6.8): looks at the journal, if any, and finishes or undoes whatever
/// a crash or a failed swap left, deciding from the folders on disk (S staging, T target, B
/// pre-restore):
///
/// | Journal | Disk | Action | Result |
/// |---|---|---|---|
/// | any | the folder that holds S, T and B missing | nothing touched | `Err(RestorePending)` |
/// | `extracting` | any | remove S | `StagingRemoved` |
/// | `swapping`, no B | T there, S gone | nothing | `Finished` |
/// | `swapping`, no B | T missing, or T and S there | remove S | `RolledBack` |
/// | `swapping`, B | B missing, T there | remove S | `RolledBack` |
/// | `swapping`, B | B there, T missing | B back to T, remove S | `RolledBack` |
/// | `swapping`, B | B and T there, S gone | nothing (B kept) | `Finished` |
/// | anything else | | nothing touched | `InvalidInput { "restore state unclear" }` |
///
/// Run it at every launch, and right away when a commit says `RestorePending`. The journal is
/// validated first, and one that fails is `Damaged` with nothing touched. While the folder that
/// holds S, T and B is missing (its drive is not plugged in, say), nothing is decided: the
/// result is `Err(RestorePending)` and the journal stays. Every action ends by removing the
/// journal; if a rename or the staging removal fails the result is `Err(RestorePending)` and
/// the journal stays. An unclear state is for the user to decide (see
/// [`dismiss_restore_journal`]). Runs again safely after any crash of its own.
pub fn recover_restore(journal: &Path) -> Result<Recovery> {
    // Held for the whole run, so no one publishes, replaces or removes the journal under it.
    let lock = lock_journal(journal)?;
    let Some(j) = read_checked_journal(&lock, journal)? else {
        return Ok(Recovery::NothingToDo);
    };
    #[cfg(any(test, feature = "test-internals"))]
    crate::fsio::failpoint::check("recover.under_lock")?;
    check_staging_parent(&j.staging)?;

    let (staging, target) = (&j.staging, &j.target);
    let (t, s) = (journal_exists(target)?, journal_exists(staging)?);
    // The result, and the folder to move back to the target first.
    let (recovery, move_back) = match (j.step, &j.before_restore) {
        (JournalStep::Extracting, _) => (Recovery::StagingRemoved, None),
        (JournalStep::Swapping, None) if t && !s => (Recovery::Finished, None),
        (JournalStep::Swapping, None) => (Recovery::RolledBack, None),
        (JournalStep::Swapping, Some(b)) => match (journal_exists(b)?, t, s) {
            (false, true, _) => (Recovery::RolledBack, None),
            (true, false, _) => (Recovery::RolledBack, Some(b)),
            (true, true, false) => (Recovery::Finished, None),
            _ => return Err(UNCLEAR),
        },
    };
    let done: Result<()> = (|| {
        if let Some(b) = move_back {
            #[cfg(any(test, feature = "test-internals"))]
            crate::fsio::failpoint::check("recover.fail_rename")?;
            rename_dir_no_replace(b, target)?;
            #[cfg(any(test, feature = "test-internals"))]
            crate::fsio::failpoint::check("recover.after_rename")?;
        }
        remove_staging(staging)?;
        remove_journal_if_owner(&lock, journal, staging)
    })();
    done.map_err(|_| CoreError::RestorePending)?;
    Ok(recovery)
}

/// For the UI, after the user has confirmed a journal that recovery refused: removes the
/// staging folder if the journal is valid and names a real one, then the journal itself, even
/// an unreadable or invalid one. It never touches the target or the pre-restore folder. A
/// staging folder that cannot be removed leaves the journal in place. While the folder that
/// holds the staging folder is missing (its drive is not plugged in), there is nothing there
/// to remove: the journal goes and nothing on the missing path is touched, since this is the
/// user's confirmed way out (the interface says the drive is not connected).
pub fn dismiss_restore_journal(journal: &Path) -> Result<()> {
    let _lock = lock_journal(journal)?;
    match read_journal(journal) {
        Ok(None) => return Ok(()),
        Ok(Some(j)) => match validate_journal_on_disk(&j) {
            Ok(()) => remove_staging(&j.staging)?,
            // A journal that cannot be trusted names nothing that may be deleted: its staging
            // folder (a link, a letter-case variant ...) stays. Only a disk error keeps the journal.
            Err(CoreError::Damaged { .. }) => {}
            Err(e) => return Err(e),
        },
        Err(
            CoreError::Damaged { .. } | CoreError::TooLarge { .. } | CoreError::UnsupportedVersion,
        ) => {}
        Err(e) => return Err(e),
    }
    #[cfg(any(test, feature = "test-internals"))]
    crate::fsio::failpoint::check("dismiss.before_delete")?;
    remove_file_retry(journal)
}

impl Drop for PreparedRestore {
    fn drop(&mut self) {
        if self.armed {
            let _ = remove_staging_then_journal(&self.staging, &self.journal);
        }
    }
}

#[cfg(test)]
// `pub(super)`: the read-only vault's tests compare folder trees with the same helper.
pub(super) mod tests {
    use super::*;
    use crate::archive::testkit::{
        ManifestMode, central_offset, patch, resize_entry, rewrite_backup,
    };
    use crate::fsio::testutil::{TempDir, make_dir_link, names};
    use crate::fsio::{VolumeInfo, failpoint, set_volume_override};
    use crate::item::ItemKind;
    use crate::vault::folder_name;
    use crate::vault::journal::{
        JournalStep, RESTORE_JOURNAL_VERSION, RestoreJournal, lock_is_held, observe_lock_held,
        plain_absolute, read_journal, write_journal,
    };
    use crate::vault::source::item_name;
    use crate::vault::source::tests::{Fixture, MIB, PW, flip_blob_second_chunk, flip_item};
    use std::cell::{Cell, RefCell};
    use std::fs;
    use std::path::Component;
    use std::rc::Rc;

    /// Always resets, so a failing test cannot leak a failpoint or volume on this thread.
    struct Cleanup;
    impl Drop for Cleanup {
        fn drop(&mut self) {
            failpoint::disarm_all();
            set_volume_override(None);
        }
    }

    /// An empty destination parent, and a separate folder for the journal.
    struct Dest {
        parent: TempDir,
        journal_dir: TempDir,
        /// How often a prepare got as far as writing its journal.
        reached_journal: Rc<Cell<u32>>,
    }

    impl Dest {
        fn new() -> Dest {
            let reached_journal = Rc::new(Cell::new(0));
            let count = reached_journal.clone();
            failpoint::observe(
                "restore.before_journal",
                Box::new(move || count.set(count.get() + 1)),
            );
            Dest {
                parent: TempDir::new(),
                journal_dir: TempDir::new(),
                reached_journal,
            }
        }

        fn parent(&self) -> &Path {
            self.parent.path()
        }

        fn journal(&self) -> PathBuf {
            self.journal_dir.path().join("restore-journal.json")
        }

        fn prepare(&self, archive: &Path, credential: Credential) -> Result<PreparedRestore> {
            self.prepare_with(archive, credential, &CancelToken::new())
        }

        fn prepare_with(
            &self,
            archive: &Path,
            credential: Credential,
            cancel: &CancelToken,
        ) -> Result<PreparedRestore> {
            PreparedRestore::prepare(
                archive,
                self.parent(),
                credential,
                RestoreDestination::SameVault,
                &self.journal(),
                cancel,
            )
        }

        /// Nothing was written: no folder in the parent, no journal.
        #[track_caller]
        fn assert_untouched(&self) {
            assert_eq!(names(self.parent()), Vec::<String>::new());
            assert!(!self.journal().exists(), "journal left behind");
        }

        /// Refused before any write: nothing on disk, and the journal write was never reached
        /// (a clean-up afterwards would hide that).
        #[track_caller]
        fn assert_not_written(&self) {
            self.assert_untouched();
            assert_eq!(
                self.reached_journal.get(),
                0,
                "the journal write was reached"
            );
        }
    }

    #[track_caller]
    fn error(result: Result<PreparedRestore>) -> CoreError {
        match result {
            Err(e) => e,
            Ok(_) => panic!("expected an error"),
        }
    }

    #[track_caller]
    fn damaged(result: Result<PreparedRestore>) -> &'static str {
        match error(result) {
            CoreError::Damaged { what } => what,
            other => panic!("expected Damaged, got {other:?}"),
        }
    }

    #[track_caller]
    fn invalid(result: Result<PreparedRestore>) -> &'static str {
        match error(result) {
            CoreError::InvalidInput { what } => what,
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    /// A vault with a note, a file item and a second attachment over a megabyte, backed up.
    fn backed_up() -> (Fixture, PathBuf) {
        let mut f = Fixture::new();
        f.vault.new_item(ItemKind::Note, "note", None).unwrap();
        let (item, _) = f.file_item(b"hello");
        f.attach(&item, &vec![7u8; MIB + 5]);
        let backup = f.backup("a.lockbox-backup");
        (f, backup)
    }

    /// Puts a `vault.json` of `f`'s vault into the new folder `parent/name`.
    fn plant_vault(f: &Fixture, parent: &Path, name: &str) -> PathBuf {
        let dir = parent.join(name);
        fs::create_dir(&dir).unwrap();
        fs::copy(f.vault.dir().join("vault.json"), dir.join("vault.json")).unwrap();
        dir
    }

    /// The only `.restore-<hex>` folder in `parent`.
    #[track_caller]
    fn staging_in(parent: &Path) -> PathBuf {
        let found: Vec<String> = names(parent)
            .into_iter()
            .filter(|n| n.starts_with(".restore-"))
            .collect();
        assert_eq!(found.len(), 1, "{found:?}");
        parent.join(&found[0])
    }

    /// Both folders hold the same files, byte for byte, directly inside them.
    #[track_caller]
    fn assert_same_files(a: &Path, b: &Path) {
        let files = |dir: &Path| -> Vec<String> {
            names(dir)
                .into_iter()
                .filter(|n| dir.join(n).is_file())
                .collect()
        };
        assert_eq!(files(a), files(b));
        for name in files(a) {
            assert_eq!(
                fs::read(a.join(&name)).unwrap(),
                fs::read(b.join(&name)).unwrap()
            );
        }
    }

    #[test]
    fn prepare_new_vault() {
        let (f, backup) = backed_up();
        let d = Dest::new();
        let p = d.prepare(&backup, Credential::Password(PW)).unwrap();

        assert_eq!((p.name(), p.vault_id()), ("Family", f.vault.id()));
        assert_eq!(p.existing(), None);
        let staging = staging_in(d.parent());
        assert_eq!(names(d.parent()).len(), 1);
        assert_eq!(
            names(&staging),
            ["files", "items", "vault.json", "vault.json.bak"]
        );
        assert_eq!(
            names(&staging.join("files").join("orphaned")),
            Vec::<String>::new()
        );
        // Every entry, byte for byte as the live vault holds it.
        let live = f.vault.dir();
        assert_eq!(
            fs::read(staging.join("vault.json")).unwrap(),
            fs::read(live.join("vault.json")).unwrap()
        );
        assert_same_files(&staging.join("items"), &live.join("items"));
        assert_same_files(&staging.join("files"), &live.join("files"));
        assert_eq!(
            fs::read(staging.join("vault.json.bak")).unwrap(),
            fs::read(staging.join("vault.json")).unwrap()
        );
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            let attributes = fs::metadata(&staging).unwrap().file_attributes();
            assert_ne!(attributes & 0x2, 0, "staging folder is not hidden");
        }

        let journal = read_journal(&d.journal()).unwrap().unwrap();
        assert_eq!(journal.version, RESTORE_JOURNAL_VERSION);
        assert_eq!(journal.step, JournalStep::Extracting);
        assert_eq!(journal.staging, staging);
        assert_eq!(
            journal.target,
            d.parent().join(folder_name("Family", &f.vault.id()))
        );
        assert_eq!(journal.before_restore, None);

        // Dropping a prepared restore is how the user says "no".
        drop(p);
        d.assert_untouched();
    }

    #[test]
    fn wrong_password_fails_before_any_write() {
        let (_f, backup) = backed_up();
        let d = Dest::new();
        let result = d.prepare(&backup, Credential::Password("not the password"));
        assert!(matches!(error(result), CoreError::WrongPassword));
        d.assert_not_written();
    }

    #[test]
    fn recovery_key_works() {
        let (f, backup) = backed_up();
        let d = Dest::new();
        let p = d
            .prepare(&backup, Credential::Recovery(&f.recovery))
            .unwrap();
        assert_eq!(p.vault_id(), f.vault.id());
        drop(p);
        d.assert_untouched();
    }

    #[test]
    fn malformed_archive_refused_before_any_write() {
        let mut f = Fixture::new();
        let (item, _) = f.file_item(b"x");
        let backup = f.backup("a.lockbox-backup");
        let item = item_name(&item);
        let copy = |name: &str| {
            let path = f.out().join(name);
            fs::copy(&backup, &path).unwrap();
            path
        };
        let d = Dest::new();

        // A traversal name in the central directory.
        let traversal = copy("traversal.lockbox-backup");
        let mut bytes = fs::read(&traversal).unwrap();
        let at = central_offset(&bytes, &item) + 46;
        patch(
            &mut bytes,
            at,
            format!("items/../{}", "a".repeat(34)).as_bytes(),
        );
        fs::write(&traversal, bytes).unwrap();
        assert_eq!(
            damaged(d.prepare(&traversal, Credential::Password(PW))),
            "backup: entry name"
        );
        d.assert_not_written();

        // An entry the manifest does not list.
        let mismatch = copy("mismatch.lockbox-backup");
        let extra = crate::vault::source::blob_name(&crate::ids::FileId::random());
        rewrite_backup(
            &mismatch,
            |m| {
                m.insert(extra, vec![1, 2, 3]);
            },
            ManifestMode::Keep,
        );
        assert_eq!(
            damaged(d.prepare(&mismatch, Credential::Password(PW))),
            "backup: manifest mismatch"
        );
        d.assert_not_written();

        // An entry that runs one byte into the next.
        let overlap = copy("overlap.lockbox-backup");
        let mut bytes = fs::read(&overlap).unwrap();
        resize_entry(&mut bytes, &item, 1);
        fs::write(&overlap, bytes).unwrap();
        assert_eq!(
            damaged(d.prepare(&overlap, Credential::Password(PW))),
            "backup: layout"
        );
        d.assert_not_written();
    }

    #[test]
    fn unrelated_folder_at_target_refused() {
        let (f, backup) = backed_up();
        let d = Dest::new();
        let squatter = d.parent().join(folder_name("Family", &f.vault.id()));
        fs::create_dir(&squatter).unwrap();
        fs::write(squatter.join("mine.txt"), b"mine").unwrap();

        let result = d.prepare(&backup, Credential::Password(PW));
        assert_eq!(invalid(result), "destination exists");
        assert_eq!(names(&squatter), ["mine.txt"]);
        assert_eq!(fs::read(squatter.join("mine.txt")).unwrap(), b"mine");
        assert_eq!(
            names(d.parent()),
            [squatter.file_name().unwrap().to_str().unwrap()]
        );
        assert!(!d.journal().exists());
        assert_eq!(d.reached_journal.get(), 0);
    }

    #[test]
    fn same_id_vault_found() {
        let (f, backup) = backed_up();
        let d = Dest::new();
        let old = plant_vault(&f, d.parent(), "Family-old");
        // None of these is a candidate: hidden, a pre-restore copy, a stranger, a plain file.
        plant_vault(&f, d.parent(), ".Family-hidden");
        plant_vault(&f, d.parent(), "Family-old.before-restore");
        fs::create_dir(d.parent().join("Other")).unwrap();
        fs::write(d.parent().join("Other").join("vault.json"), b"not a header").unwrap();
        fs::write(d.parent().join("notes.txt"), b"x").unwrap();

        let p = d.prepare(&backup, Credential::Password(PW)).unwrap();
        assert_eq!(p.existing(), Some(old.as_path()));
        let journal = read_journal(&d.journal()).unwrap().unwrap();
        assert_eq!(journal.target, old);
        // The vault it would replace is not touched.
        assert_eq!(names(&old), ["vault.json"]);
        drop(p);
        assert!(!d.journal().exists());
    }

    /// A link or junction in the parent is never the vault to replace, not even one that leads
    /// to a copy of it: only a real folder is.
    #[test]
    fn a_linked_vault_folder_is_not_a_candidate() {
        let (f, backup) = backed_up();
        let elsewhere = TempDir::new();
        let copy = plant_vault(&f, elsewhere.path(), "Family-copy");
        let d = Dest::new();
        let link = d.parent().join("Family-link");
        make_dir_link(&link, &copy);

        let p = d.prepare(&backup, Credential::Password(PW)).unwrap();
        assert_eq!(p.existing(), None);
        let target = read_journal(&d.journal()).unwrap().unwrap().target;
        assert_eq!(
            target,
            d.parent().join(folder_name("Family", &f.vault.id()))
        );
        drop(p);
        assert!(fs::symlink_metadata(&link).is_ok());
        assert_eq!(names(&copy), ["vault.json"]);
    }

    #[test]
    fn several_same_id_vaults_refused() {
        let (f, backup) = backed_up();
        let d = Dest::new();
        plant_vault(&f, d.parent(), "Family-a");
        plant_vault(&f, d.parent(), "Family-b");
        let result = d.prepare(&backup, Credential::Password(PW));
        assert_eq!(invalid(result), "several copies of this vault");
        assert_eq!(names(d.parent()), ["Family-a", "Family-b"]);
        assert!(!d.journal().exists());
        assert_eq!(d.reached_journal.get(), 0);
    }

    /// Any entry at the journal path is "in progress": a valid journal, a corrupt one, a newer
    /// one, a folder, a dangling link. Only recovery parses it; nothing here replaces it.
    #[test]
    fn restore_in_progress_refused() {
        let (_f, backup) = backed_up();
        let valid = RestoreJournal {
            version: RESTORE_JOURNAL_VERSION,
            step: JournalStep::Swapping,
            staging: PathBuf::from("staging"),
            target: PathBuf::from("target"),
            before_restore: None,
        };
        let newer = serde_json::json!({"version": 2, "step": "extracting", "new": true});
        type Plant<'a> = Box<dyn Fn(&Path) + 'a>;
        let cases: [(&str, Plant); 5] = [
            ("valid", Box::new(|p| write_journal(p, &valid).unwrap())),
            (
                "corrupt",
                Box::new(|p| fs::write(p, b"{ not json").unwrap()),
            ),
            (
                "unsupported version",
                Box::new(|p| fs::write(p, newer.to_string()).unwrap()),
            ),
            ("folder", Box::new(|p| fs::create_dir(p).unwrap())),
            (
                "dangling link",
                Box::new(|p| {
                    let gone = TempDir::new();
                    make_dir_link(p, gone.path());
                    drop(gone);
                }),
            ),
        ];
        for (what, plant) in cases {
            let d = Dest::new();
            plant(&d.journal());
            let before = fs::symlink_metadata(d.journal()).unwrap().file_type();
            let bytes = fs::read(d.journal()).ok();

            let result = d.prepare(&backup, Credential::Password(PW));
            assert_eq!(invalid(result), "restore in progress", "{what}");
            let after = fs::symlink_metadata(d.journal()).unwrap().file_type();
            assert_eq!(before, after, "{what}");
            assert_eq!(fs::read(d.journal()).ok(), bytes, "{what}");
            assert_eq!(names(d.parent()), Vec::<String>::new(), "{what}");
            assert_eq!(d.reached_journal.get(), 0, "{what}");
            failpoint::disarm_all();
        }
    }

    /// A second prepare has passed every check and is about to publish its journal when a
    /// first one completes. It must fail without touching the first one's journal or staging
    /// folder, and its own clean-up must leave them alone.
    #[test]
    fn a_second_prepare_cannot_take_over_the_first_ones_journal() {
        let _reset = Cleanup;
        let (_f, backup) = backed_up();
        let d = Dest::new();
        let first: Rc<RefCell<Option<PreparedRestore>>> = Rc::default();
        let (slot, archive) = (first.clone(), backup.clone());
        let (parent, journal) = (d.parent().to_owned(), d.journal());
        failpoint::observe(
            "restore.before_journal",
            Box::new(move || {
                let cancel = CancelToken::new();
                let credential = Credential::Password(PW);
                let same = RestoreDestination::SameVault;
                let p = PreparedRestore::prepare(
                    &archive, &parent, credential, same, &journal, &cancel,
                );
                *slot.borrow_mut() = Some(p.unwrap());
            }),
        );

        let result = d.prepare(&backup, Credential::Password(PW));
        assert_eq!(invalid(result), "restore in progress");

        let staging = staging_in(d.parent());
        assert!(staging.join("vault.json.bak").exists());
        assert_eq!(
            read_journal(&d.journal()).unwrap().unwrap().staging,
            staging
        );
        let first = first.borrow_mut().take().unwrap();
        drop(first);
        d.assert_untouched();
    }

    /// The presence check and the publish happen under the journal lock, and so does the
    /// clean-up that follows: at each of those moments a separate handle cannot take the lock,
    /// and right after each it can.
    #[test]
    fn prepare_and_its_cleanup_run_under_the_journal_lock() {
        let _reset = Cleanup;
        let (_f, backup) = backed_up();
        let d = Dest::new();
        assert!(!lock_is_held(&d.journal()));
        let at_publish = observe_lock_held("restore.under_lock", &d.journal());
        let p = d.prepare(&backup, Credential::Password(PW)).unwrap();
        assert_eq!(
            at_publish.get(),
            1,
            "the presence check and publish ran once"
        );
        assert!(!lock_is_held(&d.journal()), "the lock was not released");
        assert!(read_journal(&d.journal()).unwrap().is_some());

        let at_cleanup = observe_lock_held("journal.before_owner_delete", &d.journal());
        drop(p);
        assert_eq!(at_cleanup.get(), 1, "the owner check and delete ran once");
        assert!(!lock_is_held(&d.journal()), "the lock was not released");
        d.assert_untouched();
    }

    /// A publish that reports an error after the journal had already landed (the portable
    /// version links first, then unlinks the temp and syncs the folder) leaves a journal that is
    /// ours: it goes, and nothing else is left.
    #[test]
    fn a_publish_that_fails_after_the_journal_landed_is_cleaned_up() {
        let _reset = Cleanup;
        let (_f, backup) = backed_up();
        let d = Dest::new();
        failpoint::arm("publish.after_link");
        let at_cleanup = observe_lock_held("journal.before_owner_delete", &d.journal());
        let result = d.prepare(&backup, Credential::Password(PW));
        assert!(matches!(error(result), CoreError::Io(_)));
        assert_eq!(
            at_cleanup.get(),
            1,
            "our journal was removed under the lock"
        );
        assert!(!lock_is_held(&d.journal()));
        assert_eq!(d.reached_journal.get(), 1);
        d.assert_untouched();
        assert_eq!(names(d.journal_dir.path()), ["restore-journal.json.lock"]);
    }

    /// The generated staging path is taken by something else just before it is created: that
    /// folder is left as it is, and only this operation's journal goes.
    #[test]
    fn staging_collision_keeps_the_existing_folder() {
        let _reset = Cleanup;
        let (_f, backup) = backed_up();
        let d = Dest::new();
        let journal = d.journal();
        failpoint::observe(
            "restore.before_staging",
            Box::new(move || {
                let staging = read_journal(&journal).unwrap().unwrap().staging;
                fs::create_dir(&staging).unwrap();
                fs::write(staging.join("sentinel"), b"mine").unwrap();
            }),
        );

        let at_cleanup = observe_lock_held("journal.before_owner_delete", &d.journal());
        let result = d.prepare(&backup, Credential::Password(PW));
        assert!(matches!(error(result), CoreError::Io(_)));
        assert_eq!(
            at_cleanup.get(),
            1,
            "our journal was removed under the lock"
        );
        assert!(!lock_is_held(&d.journal()));
        let squatter = staging_in(d.parent());
        assert_eq!(names(&squatter), ["sentinel"]);
        assert_eq!(fs::read(squatter.join("sentinel")).unwrap(), b"mine");
        assert!(!d.journal().exists(), "this operation's journal is gone");
    }

    /// Journal paths have only normal components. Windows resolves `..` when it makes a path
    /// absolute; elsewhere it is refused. Either way none reaches the journal.
    #[test]
    fn parent_with_dot_dot_never_reaches_the_journal() {
        let (_f, backup) = backed_up();
        let d = Dest::new();
        let sub = d.parent().join("sub");
        fs::create_dir(&sub).unwrap();
        let odd = sub.join("..");
        assert!(!plain_absolute(&odd));

        let credential = Credential::Password(PW);
        let result = PreparedRestore::prepare(
            &backup,
            &odd,
            credential,
            RestoreDestination::SameVault,
            &d.journal(),
            &CancelToken::new(),
        );
        match result {
            Err(e) => {
                assert!(matches!(
                    e,
                    CoreError::InvalidInput {
                        what: "restore path"
                    }
                ));
                // Only the test's own `sub` folder is there: nothing else was written.
                assert_eq!(names(d.parent()), vec!["sub".to_string()]);
                assert!(!d.journal().exists(), "journal left behind");
                assert_eq!(d.reached_journal.get(), 0, "the journal write was reached");
            }
            Ok(p) => {
                let journal = read_journal(&d.journal()).unwrap().unwrap();
                assert!(
                    journal
                        .staging
                        .components()
                        .all(|c| c != Component::ParentDir)
                );
                assert!(
                    journal
                        .target
                        .components()
                        .all(|c| c != Component::ParentDir)
                );
                assert_eq!(journal.staging.parent().unwrap(), d.parent());
                drop(p);
            }
        }
    }

    /// A pre-restore copy is never a candidate, whatever its letter case (Windows names are
    /// case-insensitive, so `Family.BEFORE-RESTORE` is `Family.before-restore`).
    #[test]
    fn case_variant_pre_restore_copy_is_not_a_candidate() {
        let (f, backup) = backed_up();
        // With a live copy: it is chosen, with no "several copies".
        let d = Dest::new();
        let live = plant_vault(&f, d.parent(), "Family-old");
        plant_vault(&f, d.parent(), "Family.BEFORE-RESTORE");
        plant_vault(&f, d.parent(), "Family-old.Before-Restore-2");
        let p = d.prepare(&backup, Credential::Password(PW)).unwrap();
        assert_eq!(p.existing(), Some(live.as_path()));
        drop(p);

        // Without one: not chosen, a new folder is the target.
        let d = Dest::new();
        plant_vault(&f, d.parent(), "Family.BEFORE-RESTORE");
        let p = d.prepare(&backup, Credential::Password(PW)).unwrap();
        assert_eq!(p.existing(), None);
        let target = read_journal(&d.journal()).unwrap().unwrap().target;
        assert_eq!(
            target,
            d.parent().join(folder_name("Family", &f.vault.id()))
        );
    }

    #[test]
    fn hash_mismatch_during_extraction_cleans_up() {
        let _reset = Cleanup;
        let (_f, backup) = backed_up();
        let d = Dest::new();
        failpoint::arm("restore.corrupt_extract");
        let result = d.prepare(&backup, Credential::Password(PW));
        assert_eq!(damaged(result), "backup: entry hash");
        d.assert_untouched();
    }

    #[test]
    fn tampered_blob_refused_during_extraction() {
        let mut f = Fixture::new();
        f.file_item(&vec![1u8; 2 * MIB]);
        let backup = f.backup("a.lockbox-backup");
        let mode = ManifestMode::Rehash { key: Some(f.key()) };
        rewrite_backup(&backup, flip_blob_second_chunk, mode);

        let d = Dest::new();
        let result = d.prepare(&backup, Credential::Password(PW));
        assert_eq!(damaged(result), "backup: damaged file");
        d.assert_untouched();
    }

    /// Task 4's `damaged_blob_left_out`: the backup holds the item and the one good file.
    #[test]
    fn damaged_blob_backup_restores() {
        let mut f = Fixture::new();
        let (item, bad) = f.file_item(&vec![1u8; 2 * MIB]);
        let good = f.attach(&item, b"good");
        let path = f.blob_file(&bad);
        let mut bytes = fs::read(&path).unwrap();
        bytes[MIB + 100] ^= 1;
        fs::write(&path, bytes).unwrap();
        let backup = f.backup("a.lockbox-backup");

        let d = Dest::new();
        let p = d.prepare(&backup, Credential::Password(PW)).unwrap();
        let files = staging_in(d.parent()).join("files");
        assert_eq!(
            names(&files),
            [format!("{}.blob", good.to_hex()), "orphaned".to_owned()]
        );
        drop(p);
        d.assert_untouched();
    }

    #[test]
    fn damaged_item_refused() {
        let mut f = Fixture::new();
        f.file_item(b"x");
        let backup = f.backup("a.lockbox-backup");
        rewrite_backup(
            &backup,
            flip_item,
            ManifestMode::Rehash { key: Some(f.key()) },
        );

        let d = Dest::new();
        let result = d.prepare(&backup, Credential::Password(PW));
        assert_eq!(damaged(result), "backup: damaged item");
        d.assert_not_written();
    }

    #[test]
    fn unexpected_blob_refused() {
        let mut f = Fixture::new();
        f.file_item(b"x");
        let backup = f.backup("a.lockbox-backup");
        let extra = crate::vault::source::blob_name(&crate::ids::FileId::random());
        rewrite_backup(
            &backup,
            |m| {
                m.insert(extra, vec![1, 2, 3]);
            },
            ManifestMode::Rehash { key: Some(f.key()) },
        );

        let d = Dest::new();
        let result = d.prepare(&backup, Credential::Password(PW));
        assert_eq!(damaged(result), "backup: unexpected file");
        d.assert_not_written();
    }

    #[test]
    fn space_checked_first() {
        let _reset = Cleanup;
        let (_f, backup) = backed_up();
        let d = Dest::new();
        set_volume_override(Some(VolumeInfo {
            free_bytes: Some(0),
            max_file_bytes: None,
        }));
        let result = d.prepare(&backup, Credential::Password(PW));
        assert!(matches!(error(result), CoreError::NotEnoughSpace { .. }));
        d.assert_not_written();
    }

    #[test]
    fn cancel_cleans_up() {
        let _reset = Cleanup;
        let (_f, backup) = backed_up();
        let d = Dest::new();
        let token = CancelToken::new();
        failpoint::arm_cancel("restore.after_entry", token.clone());
        let result = d.prepare_with(&backup, Credential::Password(PW), &token);
        assert!(matches!(error(result), CoreError::Cancelled));
        d.assert_untouched();
    }

    #[test]
    fn staging_removal_failure_keeps_journal() {
        let _reset = Cleanup;
        let (_f, backup) = backed_up();
        let d = Dest::new();
        let p = d.prepare(&backup, Credential::Password(PW)).unwrap();
        let staging = staging_in(d.parent());
        failpoint::arm("restore.remove_staging");
        drop(p);
        failpoint::disarm_all();
        // The staging folder is still there, so the journal that names it must stay.
        assert!(staging.join("vault.json").exists());
        let journal = read_journal(&d.journal()).unwrap().unwrap();
        assert_eq!(journal.staging, staging);
        // Cleaning up again, as the next launch would, removes both.
        remove_staging_then_journal(&staging, &d.journal()).unwrap();
        d.assert_untouched();
    }

    // ---- Task 7: the journaled swap, startup recovery and dismissal.

    use crate::blob::NoJournal;
    use crate::vault::Vault;

    /// A staging name's 32 hex characters, and the vault folder name the hand-made states use.
    const HEX: &str = "abababababababababababababababab";

    fn sorted_titles(vault: &Vault) -> Vec<String> {
        let mut titles: Vec<String> = vault.items().map(|i| i.title.clone()).collect();
        titles.sort();
        titles
    }

    /// The sorted titles of the vault in `dir`. It unlocks it, so nobody may hold it open.
    fn titles(dir: &Path) -> Vec<String> {
        sorted_titles(&Vault::unlock_with_password(dir, PW).unwrap().0)
    }

    /// The sorted contents of every attachment of the vault in `dir`.
    fn contents(dir: &Path) -> Vec<Vec<u8>> {
        let (vault, _) = Vault::unlock_with_password(dir, PW).unwrap();
        let out = TempDir::new();
        let dest = out.path().join("copy.bin");
        let mut all = Vec::new();
        for item in vault.items() {
            for file in &item.attachments {
                let cancel = CancelToken::new();
                vault
                    .export_file(&item.id, &file.file_id, &dest, &NoJournal, &cancel)
                    .unwrap();
                all.push(fs::read(&dest).unwrap());
            }
        }
        all.sort();
        all
    }

    /// A folder's contents, see [`tree`].
    pub(in crate::vault) type Tree = Vec<(String, Option<Vec<u8>>)>;

    /// Every file and folder under `dir` with the bytes of the files, links recorded as links
    /// and never followed. A `.lock` file is left out: a held one cannot be read on Windows.
    pub(in crate::vault) fn tree(dir: &Path) -> Tree {
        fn walk(root: &Path, dir: &Path, out: &mut Tree) {
            let mut paths: Vec<PathBuf> = fs::read_dir(dir)
                .unwrap()
                .map(|e| e.unwrap().path())
                .collect();
            paths.sort();
            for path in paths {
                if path.file_name().unwrap() == ".lock" {
                    continue;
                }
                let rel = path.strip_prefix(root).unwrap();
                let rel = rel.to_string_lossy().replace('\\', "/");
                let meta = fs::symlink_metadata(&path).unwrap();
                if meta.file_type().is_symlink() {
                    out.push((rel, Some(b"<link>".to_vec())));
                } else if meta.is_dir() {
                    out.push((rel, None));
                    walk(root, &path, out);
                } else {
                    out.push((rel, Some(fs::read(&path).unwrap())));
                }
            }
        }
        let mut out = Vec::new();
        walk(dir, dir, &mut out);
        out
    }

    /// A backup and its destination. The backup holds the note, the file item and the large
    /// attachment of [`backed_up`].
    struct Scene {
        parent: TempDir,
        journal_dir: TempDir,
        /// Keeps the source vault's folder (and so the backup) alive.
        _source: Option<TempDir>,
        backup: PathBuf,
        target: PathBuf,
        backup_titles: Vec<String>,
        /// Replacing: the titles of the live vault, which gained a note after the backup.
        old_titles: Option<Vec<String>>,
    }

    impl Scene {
        /// The destination holds a vault with the backup's ID that is newer than the backup.
        /// The vault is returned open.
        fn replacing() -> (Scene, Vault) {
            let (mut f, backup) = backed_up();
            let backup_titles = sorted_titles(&f.vault);
            f.vault.new_item(ItemKind::Note, "newer", None).unwrap();
            let old_titles = Some(sorted_titles(&f.vault));
            let target = f.vault.dir().to_owned();
            let Fixture { parent, vault, .. } = f;
            let scene = Scene {
                parent,
                journal_dir: TempDir::new(),
                _source: None,
                backup,
                target,
                backup_titles,
                old_titles,
            };
            (scene, vault)
        }

        fn replace() -> Scene {
            let (scene, vault) = Scene::replacing();
            drop(vault);
            scene
        }

        /// The destination is an empty folder.
        fn fresh() -> Scene {
            let (f, backup) = backed_up();
            let backup_titles = sorted_titles(&f.vault);
            let parent = TempDir::new();
            let target = parent.path().join(folder_name("Family", &f.vault.id()));
            let Fixture {
                parent: source,
                vault,
                ..
            } = f;
            drop(vault);
            Scene {
                parent,
                journal_dir: TempDir::new(),
                _source: Some(source),
                backup,
                target,
                backup_titles,
                old_titles: None,
            }
        }

        fn parent(&self) -> &Path {
            self.parent.path()
        }

        fn journal(&self) -> PathBuf {
            self.journal_dir.path().join("restore-journal.json")
        }

        fn prepare(&self) -> PreparedRestore {
            let credential = Credential::Password(PW);
            let cancel = CancelToken::new();
            PreparedRestore::prepare(
                &self.backup,
                self.parent(),
                credential,
                RestoreDestination::SameVault,
                &self.journal(),
                &cancel,
            )
            .unwrap()
        }

        /// The pre-restore folder with `suffix` `""`, `"-2"` ...
        fn before(&self, suffix: &str) -> PathBuf {
            let mut name = self.target.file_name().unwrap().to_owned();
            name.push(format!(".before-restore{suffix}"));
            self.parent().join(name)
        }

        #[track_caller]
        fn assert_settled(&self) {
            let staging: Vec<String> = names(self.parent())
                .into_iter()
                .filter(|n| n.starts_with(".restore-"))
                .collect();
            assert_eq!(staging, Vec::<String>::new());
            assert!(!self.journal().exists(), "journal left behind");
        }

        #[track_caller]
        fn assert_restored_at(&self, dir: &Path) {
            assert_eq!(titles(dir), self.backup_titles);
        }

        #[track_caller]
        fn assert_old_at(&self, dir: &Path) {
            assert_eq!(&titles(dir), self.old_titles.as_ref().unwrap());
        }
    }

    /// The folders under `parent` and the bytes of the journal, to compare before and after.
    fn snapshot(parent: &Path, journal: &Path) -> (Tree, Vec<u8>) {
        (tree(parent), fs::read(journal).unwrap())
    }

    /// The process dies after a failed swap step: nothing is cleaned up. `mem::forget` would
    /// do the same but keeps the backup file open, and Windows then cannot delete the test's
    /// folder. Once the swap has disarmed it, a dropped restore does nothing at all, which the
    /// snapshots prove: the folders and the journal are the same bytes before and after.
    #[track_caller]
    fn die(p: PreparedRestore, s: &Scene) {
        assert!(!p.armed, "a restore past the journal rewrite is disarmed");
        let before = snapshot(s.parent(), &s.journal());
        drop(p);
        assert!(
            snapshot(s.parent(), &s.journal()) == before,
            "dropping the restore cleaned up"
        );
    }

    /// Runs the swap up to the failpoint `point` and then kills the process there.
    #[track_caller]
    fn crash_at(s: &Scene, point: &'static str) {
        let mut p = s.prepare();
        let before = p.choose_before_restore().unwrap();
        failpoint::arm(point);
        let result = p.swap_steps(before);
        failpoint::disarm_all();
        assert!(matches!(result, Err(CoreError::Io(_))), "{point}");
        die(p, s);
    }

    #[track_caller]
    fn assert_damaged_journal(got: Result<Recovery>) {
        assert!(
            matches!(
                got,
                Err(CoreError::Damaged {
                    what: "restore journal"
                })
            ),
            "{got:?}"
        );
    }

    #[track_caller]
    fn assert_damaged_commit(got: Result<RestoreOutcome>) {
        assert!(
            matches!(
                got,
                Err(CoreError::Damaged {
                    what: "restore journal"
                })
            ),
            "{got:?}"
        );
    }

    /// The name suffix of the `n`th pre-restore folder: `""`, `"-2"` ...
    fn copy_suffix(n: u32) -> String {
        if n == 1 {
            String::new()
        } else {
            format!("-{n}")
        }
    }

    #[track_caller]
    fn journal_step(journal: &Path) -> RestoreJournal {
        read_journal(journal).unwrap().unwrap()
    }

    #[test]
    fn commit_new_vault() {
        let _reset = Cleanup;
        let s = Scene::fresh();
        let mut p = s.prepare();
        let at_delete = observe_lock_held("journal.before_owner_delete", &s.journal());

        let out = p.commit(&CancelToken::new()).unwrap();
        assert_eq!(out.dir, s.target);
        assert_eq!(out.before_restore, None);
        assert_eq!(at_delete.get(), 1, "the journal went under the lock");
        s.assert_settled();
        assert_eq!(
            names(s.parent()),
            [s.target.file_name().unwrap().to_str().unwrap()]
        );
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            let attributes = fs::metadata(&s.target).unwrap().file_attributes();
            assert_eq!(attributes & 0x2, 0, "the restored folder is hidden");
        }
        // It unlocks with the backup's password, and holds what the source vault held.
        s.assert_restored_at(&s.target);
        let mut expected = vec![b"hello".to_vec(), vec![7u8; MIB + 5]];
        expected.sort();
        assert_eq!(contents(&s.target), expected);
        // The restore is used up.
        assert!(matches!(
            p.commit(&CancelToken::new()),
            Err(CoreError::InvalidInput {
                what: "already restored"
            })
        ));
        drop(p);
        s.assert_settled();
    }

    #[test]
    fn commit_replaces_same_vault() {
        let s = Scene::replace();
        let mut p = s.prepare();
        let out = p.commit(&CancelToken::new()).unwrap();
        assert_eq!(out.dir, s.target);
        assert_eq!(out.before_restore, Some(s.before("")));
        s.assert_settled();
        s.assert_restored_at(&s.target);
        s.assert_old_at(&s.before(""));
    }

    /// Review Focus 1.
    #[test]
    fn second_restore_keeps_first_original() {
        let s = Scene::replace();
        s.prepare().commit(&CancelToken::new()).unwrap();
        let first_original = tree(&s.before(""));

        // The restored vault changes, then is restored over again.
        {
            let (mut vault, _) = Vault::unlock_with_password(&s.target, PW).unwrap();
            vault.new_item(ItemKind::Note, "second", None).unwrap();
        }
        let out = s.prepare().commit(&CancelToken::new()).unwrap();

        assert_eq!(out.before_restore, Some(s.before("-2")));
        assert_eq!(
            tree(&s.before("")),
            first_original,
            "the first original changed"
        );
        s.assert_old_at(&s.before(""));
        assert!(titles(&s.before("-2")).contains(&"second".to_owned()));
        s.assert_restored_at(&s.target);
        s.assert_settled();
        assert!(!s.before("-3").exists());
    }

    /// Review Focus 4.
    #[test]
    fn open_vault_blocks_swap_before_any_rename() {
        let _reset = Cleanup;
        let (s, vault) = Scene::replacing();
        let mut p = s.prepare();
        let staging = staging_in(s.parent());
        let before = snapshot(s.parent(), &s.journal());

        let result = p.commit(&CancelToken::new());
        assert!(matches!(result, Err(CoreError::VaultInUse)));
        let after = snapshot(s.parent(), &s.journal());
        assert!(after == before, "something moved or changed");
        assert!(s.target.exists() && staging.exists() && !s.before("").exists());
        assert_eq!(journal_step(&s.journal()).step, JournalStep::Extracting);

        // Closing the vault is all the retry needs.
        drop(vault);
        p.commit(&CancelToken::new()).unwrap();
        s.assert_settled();
        s.assert_restored_at(&s.target);
        s.assert_old_at(&s.before(""));
    }

    #[test]
    fn locked_first_rename_keeps_restore() {
        let _reset = Cleanup;
        let s = Scene::replace();
        let mut p = s.prepare();
        let before = tree(s.parent());
        failpoint::arm("restore.fail_move_existing");
        let result = p.commit(&CancelToken::new());
        failpoint::disarm_all();

        assert!(matches!(result, Err(CoreError::Io(_))));
        assert_eq!(tree(s.parent()), before, "something moved");
        let j = journal_step(&s.journal());
        assert_eq!(j.step, JournalStep::Extracting);
        assert_eq!(j.before_restore, None);
        // Still armed: a second attempt works.
        p.commit(&CancelToken::new()).unwrap();
        s.assert_settled();
        s.assert_restored_at(&s.target);
        s.assert_old_at(&s.before(""));
    }

    #[test]
    fn cancel_is_checked_before_anything_and_never_after() {
        let _reset = Cleanup;
        let s = Scene::replace();
        let mut p = s.prepare();
        let token = CancelToken::new();
        token.cancel();
        let before = tree(s.parent());
        assert!(matches!(p.commit(&token), Err(CoreError::Cancelled)));
        assert_eq!(tree(s.parent()), before);
        assert_eq!(journal_step(&s.journal()).step, JournalStep::Extracting);

        // A cancel that arrives once the swap has begun changes nothing.
        let token = CancelToken::new();
        failpoint::arm_cancel("restore.after_move_existing", token.clone());
        p.commit(&token).unwrap();
        s.assert_settled();
        s.assert_restored_at(&s.target);
    }

    #[test]
    fn destination_changed_and_too_many_copies_are_refused() {
        let s = Scene::replace();
        // 99 pre-restore folders are taken: the 100th has no name.
        let mut p = s.prepare();
        for n in 1..=99 {
            fs::create_dir(s.before(&copy_suffix(n))).unwrap();
        }
        let before = tree(s.parent());
        assert!(matches!(
            p.commit(&CancelToken::new()),
            Err(CoreError::InvalidInput {
                what: "too many before-restore copies"
            })
        ));
        assert_eq!(tree(s.parent()), before);
        for n in 1..=99 {
            fs::remove_dir(s.before(&copy_suffix(n))).unwrap();
        }

        // The folder at the target is now a different vault.
        let other = TempDir::new();
        let other_vault = Vault::create(other.path(), "Other", PW).unwrap().vault;
        let header = fs::read(other_vault.dir().join("vault.json")).unwrap();
        drop(other_vault);
        fs::write(s.target.join("vault.json"), &header).unwrap();
        fs::write(s.target.join("vault.json.bak"), &header).unwrap();
        let before = tree(s.parent());
        assert!(matches!(
            p.commit(&CancelToken::new()),
            Err(CoreError::InvalidInput {
                what: "destination changed"
            })
        ));
        assert_eq!(tree(s.parent()), before);
        assert_eq!(journal_step(&s.journal()).step, JournalStep::Extracting);
    }

    /// The four places a crash can fall, with and without a vault to replace.
    #[test]
    fn crash_at_each_step_recovers_with_no_data_lost() {
        let _reset = Cleanup;
        let points = [
            ("restore.after_journal", false),
            ("restore.after_move_existing", false),
            ("restore.after_move_staging", true),
            ("restore.before_journal_done", true),
        ];
        for replacing in [true, false] {
            for (point, finished) in points {
                let what = format!("{point}, replacing: {replacing}");
                let s = if replacing {
                    Scene::replace()
                } else {
                    Scene::fresh()
                };
                crash_at(&s, point);
                let j = journal_step(&s.journal());
                assert_eq!(j.step, JournalStep::Swapping, "{what}");
                assert_eq!(j.before_restore.is_some(), replacing, "{what}");

                let expected = if finished {
                    Recovery::Finished
                } else {
                    Recovery::RolledBack
                };
                assert_eq!(recover_restore(&s.journal()).unwrap(), expected, "{what}");
                s.assert_settled();
                match (replacing, finished) {
                    (true, false) => {
                        s.assert_old_at(&s.target);
                        assert!(!s.before("").exists(), "{what}");
                    }
                    (true, true) => {
                        s.assert_restored_at(&s.target);
                        s.assert_old_at(&s.before(""));
                    }
                    (false, false) => assert!(!s.target.exists(), "{what}"),
                    (false, true) => s.assert_restored_at(&s.target),
                }
                // A second run finds nothing to do.
                assert_eq!(
                    recover_restore(&s.journal()).unwrap(),
                    Recovery::NothingToDo,
                    "{what}"
                );
            }
        }
    }

    #[test]
    fn crash_during_recovery_recovers() {
        let _reset = Cleanup;
        let s = Scene::replace();
        crash_at(&s, "restore.after_move_existing");
        // B exists, T is missing.
        assert!(s.before("").exists() && !s.target.exists());

        failpoint::arm("recover.after_rename");
        assert!(recover_restore(&s.journal()).is_err());
        failpoint::disarm_all();
        // The rename back happened; the staging folder and the journal are still there.
        s.assert_old_at(&s.target);
        assert!(!s.before("").exists());
        assert!(s.journal().exists());
        staging_in(s.parent());

        assert_eq!(recover_restore(&s.journal()).unwrap(), Recovery::RolledBack);
        s.assert_settled();
        s.assert_old_at(&s.target);
    }

    #[test]
    fn failed_rollback_is_restore_pending() {
        let _reset = Cleanup;
        let s = Scene::replace();
        let mut p = s.prepare();
        failpoint::arm("restore.fail_move_staging");
        failpoint::arm("recover.fail_rename");
        let result = p.commit(&CancelToken::new());
        failpoint::disarm_all();

        let error = result.unwrap_err();
        assert!(matches!(error, CoreError::RestorePending), "{error:?}");
        assert_eq!(
            error.to_string(),
            "restore not finished; it will be completed at the next start"
        );
        let j = journal_step(&s.journal());
        assert_eq!(j.step, JournalStep::Swapping);
        assert!(s.before("").exists() && !s.target.exists());
        staging_in(s.parent());
        drop(p); // nothing more happens on a drop: the journal is for the next launch

        assert!(s.journal().exists());
        assert_eq!(recover_restore(&s.journal()).unwrap(), Recovery::RolledBack);
        s.assert_settled();
        s.assert_old_at(&s.target);
        assert!(!s.before("").exists());
    }

    #[test]
    fn error_after_successful_rename_finishes() {
        let _reset = Cleanup;
        let s = Scene::replace();
        let mut p = s.prepare();
        failpoint::arm("restore.fail_after_move_staging");
        let out = p.commit(&CancelToken::new());
        failpoint::disarm_all();

        let out = out.unwrap();
        assert_eq!(out.dir, s.target);
        assert_eq!(out.before_restore, Some(s.before("")));
        s.assert_settled();
        s.assert_restored_at(&s.target);
        s.assert_old_at(&s.before(""));
    }

    #[test]
    fn an_error_before_the_second_rename_rolls_back_and_discards() {
        let _reset = Cleanup;
        let s = Scene::replace();
        let mut p = s.prepare();
        failpoint::arm("restore.fail_move_staging");
        let rolled_back = p.commit(&CancelToken::new());
        failpoint::disarm_all();
        // The original error comes back and everything is as it was.
        assert!(matches!(rolled_back, Err(CoreError::Io(_))));
        s.assert_settled();
        s.assert_old_at(&s.target);
        assert!(!s.before("").exists());
        assert!(matches!(
            p.commit(&CancelToken::new()),
            Err(CoreError::InvalidInput {
                what: "restore discarded"
            })
        ));
    }

    /// Disk states built by hand: T = `Family-abababab`, S = `.restore-<hex>`, B = T plus
    /// `.before-restore`. A marker file in each folder says which one it is.
    struct Raw {
        parent: TempDir,
        journal_dir: TempDir,
    }

    impl Raw {
        fn new() -> Raw {
            Raw {
                parent: TempDir::new(),
                journal_dir: TempDir::new(),
            }
        }

        fn t(&self) -> PathBuf {
            self.parent.path().join("Family-abababab")
        }

        fn s(&self) -> PathBuf {
            self.parent.path().join(format!(".restore-{HEX}"))
        }

        fn b(&self) -> PathBuf {
            self.parent.path().join("Family-abababab.before-restore")
        }

        fn journal(&self) -> PathBuf {
            self.journal_dir.path().join("restore-journal.json")
        }

        fn make(&self, path: &Path, marker: &str) {
            fs::create_dir(path).unwrap();
            fs::write(path.join("marker"), marker).unwrap();
        }

        /// T, S and B all there.
        fn make_all(&self) {
            for (path, marker) in [(self.t(), "T"), (self.s(), "S"), (self.b(), "B")] {
                self.make(&path, marker);
            }
        }

        fn write(&self, step: JournalStep, with_b: bool) {
            let journal = RestoreJournal {
                version: RESTORE_JOURNAL_VERSION,
                step,
                staging: self.s(),
                target: self.t(),
                before_restore: with_b.then(|| self.b()),
            };
            write_journal(&self.journal(), &journal).unwrap();
        }

        fn marker(path: &Path) -> Option<String> {
            fs::read_to_string(path.join("marker")).ok()
        }
    }

    #[test]
    fn recovery_table_rows() {
        use JournalStep::{Extracting, Swapping};
        // (step, B in the journal, T, S, B on disk) -> the result, and T, S, B afterwards.
        type After = (
            Option<&'static str>,
            Option<&'static str>,
            Option<&'static str>,
        );
        type Row = (
            &'static str,
            JournalStep,
            bool,
            [bool; 3],
            Option<Recovery>,
            After,
        );
        let rows: Vec<Row> = vec![
            (
                "extracting, everything there",
                Extracting,
                false,
                [true, true, false],
                Some(Recovery::StagingRemoved),
                (Some("T"), None, None),
            ),
            (
                "extracting, no staging folder",
                Extracting,
                false,
                [true, false, false],
                Some(Recovery::StagingRemoved),
                (Some("T"), None, None),
            ),
            (
                "swapping, no B: T there, S gone",
                Swapping,
                false,
                [true, false, false],
                Some(Recovery::Finished),
                (Some("T"), None, None),
            ),
            (
                "swapping, no B: T missing",
                Swapping,
                false,
                [false, true, false],
                Some(Recovery::RolledBack),
                (None, None, None),
            ),
            (
                "swapping, no B: T and S there",
                Swapping,
                false,
                [true, true, false],
                Some(Recovery::RolledBack),
                (Some("T"), None, None),
            ),
            (
                "swapping, B: B missing, T there",
                Swapping,
                true,
                [true, true, false],
                Some(Recovery::RolledBack),
                (Some("T"), None, None),
            ),
            (
                "swapping, B: B missing, T there, S gone",
                Swapping,
                true,
                [true, false, false],
                Some(Recovery::RolledBack),
                (Some("T"), None, None),
            ),
            (
                "swapping, B: B there, T missing",
                Swapping,
                true,
                [false, true, true],
                Some(Recovery::RolledBack),
                (Some("B"), None, None),
            ),
            (
                "swapping, B: B and T there, S gone",
                Swapping,
                true,
                [true, false, true],
                Some(Recovery::Finished),
                (Some("T"), None, Some("B")),
            ),
            (
                "swapping, B: B and T missing",
                Swapping,
                true,
                [false, true, false],
                None,
                (None, None, None),
            ),
            (
                "swapping, B: B, T and S all there",
                Swapping,
                true,
                [true, true, true],
                None,
                (None, None, None),
            ),
        ];
        for (what, step, journal_b, [t, s, b], result, (t_after, s_after, b_after)) in rows {
            let raw = Raw::new();
            for (present, path, marker) in [(t, raw.t(), "T"), (s, raw.s(), "S"), (b, raw.b(), "B")]
            {
                if present {
                    raw.make(&path, marker);
                }
            }
            raw.write(step, journal_b);
            let before = snapshot(raw.parent.path(), &raw.journal());

            let got = recover_restore(&raw.journal());
            match result {
                Some(expected) => {
                    assert_eq!(got.unwrap(), expected, "{what}");
                    assert_eq!(Raw::marker(&raw.t()).as_deref(), t_after, "{what}: T");
                    assert_eq!(Raw::marker(&raw.s()).as_deref(), s_after, "{what}: S");
                    assert_eq!(Raw::marker(&raw.b()).as_deref(), b_after, "{what}: B");
                    assert!(!raw.journal().exists(), "{what}: journal left");
                }
                None => {
                    assert!(
                        matches!(
                            got,
                            Err(CoreError::InvalidInput {
                                what: "restore state unclear"
                            })
                        ),
                        "{what}: {got:?}"
                    );
                    let after = snapshot(raw.parent.path(), &raw.journal());
                    assert!(after == before, "{what}: touched");
                }
            }
        }
        // No journal at all.
        let raw = Raw::new();
        assert_eq!(
            recover_restore(&raw.journal()).unwrap(),
            Recovery::NothingToDo
        );
    }

    /// A journal that no honest restore wrote: nothing is touched, not even a folder it names.
    #[test]
    fn forged_or_odd_journal_touches_nothing() {
        let hex_upper = HEX.to_uppercase();
        let outside = TempDir::new();
        let outside_b = outside.path().join("Family-abababab.before-restore");
        fs::create_dir(&outside_b).unwrap();
        fs::write(outside_b.join("marker"), "outside").unwrap();

        let forge = |name: &str, build: &dyn Fn(&Raw) -> RestoreJournal| {
            let raw = Raw::new();
            raw.make_all();
            raw.make(&raw.parent.path().join("Documents"), "docs");
            write_journal(&raw.journal(), &build(&raw)).unwrap();
            let before = snapshot(raw.parent.path(), &raw.journal());
            let outside_before = tree(outside.path());

            assert_damaged_journal(recover_restore(&raw.journal()));
            let after = snapshot(raw.parent.path(), &raw.journal());
            assert!(after == before, "{name}: a folder or the journal changed");
            assert!(tree(outside.path()) == outside_before, "{name}: outside");
        };
        let journal = |raw: &Raw| RestoreJournal {
            version: RESTORE_JOURNAL_VERSION,
            step: JournalStep::Swapping,
            staging: raw.s(),
            target: raw.t(),
            before_restore: Some(raw.b()),
        };

        forge("staging named Documents", &|raw| RestoreJournal {
            staging: raw.parent.path().join("Documents"),
            ..journal(raw)
        });
        forge("B outside T's parent", &|raw| RestoreJournal {
            before_restore: Some(outside_b.clone()),
            ..journal(raw)
        });
        forge("relative paths", &|_| RestoreJournal {
            staging: PathBuf::from(format!(".restore-{HEX}")),
            target: PathBuf::from("Family-abababab"),
            before_restore: Some(PathBuf::from("Family-abababab.before-restore")),
            ..journal(&Raw::new())
        });
        // S, T and B all in one directory, so only that directory's path can be what is refused.
        let all_under = |raw: &Raw, dir: PathBuf| RestoreJournal {
            staging: dir.join(format!(".restore-{HEX}")),
            target: dir.join("Family-abababab"),
            before_restore: Some(dir.join("Family-abababab.before-restore")),
            ..journal(raw)
        };
        forge("a dot dot component", &|raw| {
            all_under(raw, raw.parent.path().join("Documents").join(".."))
        });
        forge("a dot component", &|raw| {
            all_under(raw, raw.parent.path().join("."))
        });
        // With no B, so only T's own name can be what is refused.
        forge("T is a case alias of S", &|raw| RestoreJournal {
            target: raw.parent.path().join(format!(".RESTORE-{hex_upper}")),
            before_restore: None,
            ..journal(raw)
        });
        forge("T is a staging name in capitals", &|raw| RestoreJournal {
            target: raw
                .parent
                .path()
                .join(format!(".RESTORE-{}", "CD".repeat(16))),
            before_restore: None,
            ..journal(raw)
        });
        forge("T is S in lowercase and B differs", &|raw| RestoreJournal {
            target: raw.s(),
            before_restore: None,
            ..journal(raw)
        });
        forge("extracting with a B", &|raw| RestoreJournal {
            step: JournalStep::Extracting,
            ..journal(raw)
        });
    }

    /// S is a junction (a symlink off Windows) to a folder elsewhere. The helper panics if it
    /// cannot make one, so this never passes by skipping where it should run.
    #[test]
    fn a_staging_link_touches_nothing() {
        let raw = Raw::new();
        let outside = TempDir::new();
        fs::write(outside.path().join("keep"), b"keep").unwrap();
        make_dir_link(&raw.s(), outside.path());
        raw.make(&raw.t(), "T");
        raw.make(&raw.b(), "B");
        for (step, with_b) in [
            (JournalStep::Swapping, true),
            (JournalStep::Swapping, false),
            (JournalStep::Extracting, false),
        ] {
            raw.write(step, with_b);
            let before = snapshot(raw.parent.path(), &raw.journal());
            assert_damaged_journal(recover_restore(&raw.journal()));
            assert!(snapshot(raw.parent.path(), &raw.journal()) == before);
            assert_eq!(tree(outside.path()).len(), 1);
        }
        // T may not be a link either. A junction is removed like a folder, a symlink like a file.
        #[cfg(windows)]
        fs::remove_dir(raw.s()).unwrap();
        #[cfg(not(windows))]
        fs::remove_file(raw.s()).unwrap();
        raw.make(&raw.s(), "S");
        fs::remove_dir_all(raw.t()).unwrap();
        make_dir_link(&raw.t(), outside.path());
        raw.write(JournalStep::Swapping, true);
        assert_damaged_journal(recover_restore(&raw.journal()));
        assert_eq!(Raw::marker(&raw.s()).as_deref(), Some("S"));
        assert_eq!(fs::read(outside.path().join("keep")).unwrap(), b"keep");
    }

    #[test]
    fn dismiss_removes_only_staging_and_journal() {
        // An unclear state: B, T and S all there.
        let raw = Raw::new();
        raw.make_all();
        raw.write(JournalStep::Swapping, true);
        assert!(recover_restore(&raw.journal()).is_err());
        assert!(raw.journal().exists() && raw.s().exists());

        dismiss_restore_journal(&raw.journal()).unwrap();
        assert!(!raw.s().exists() && !raw.journal().exists());
        assert_eq!(Raw::marker(&raw.t()).as_deref(), Some("T"));
        assert_eq!(Raw::marker(&raw.b()).as_deref(), Some("B"));
        // Nothing left to dismiss is not an error.
        dismiss_restore_journal(&raw.journal()).unwrap();

        // An unparseable journal goes, and nothing else is touched.
        let raw = Raw::new();
        raw.make(&raw.t(), "T");
        raw.make(&raw.s(), "S");
        fs::write(raw.journal(), b"not json").unwrap();
        let before = tree(raw.parent.path());
        dismiss_restore_journal(&raw.journal()).unwrap();
        assert!(!raw.journal().exists());
        assert_eq!(tree(raw.parent.path()), before);

        // A journal that fails validation: the journal goes, the folder it names stays.
        let raw = Raw::new();
        let documents = raw.parent.path().join("Documents");
        raw.make(&documents, "docs");
        let forged = RestoreJournal {
            version: RESTORE_JOURNAL_VERSION,
            step: JournalStep::Extracting,
            staging: documents.clone(),
            target: raw.t(),
            before_restore: None,
        };
        write_journal(&raw.journal(), &forged).unwrap();
        dismiss_restore_journal(&raw.journal()).unwrap();
        assert!(!raw.journal().exists());
        assert_eq!(Raw::marker(&documents).as_deref(), Some("docs"));

        // A staging link is not followed: the journal goes, the link and its target stay.
        let raw = Raw::new();
        let outside = TempDir::new();
        fs::write(outside.path().join("keep"), b"keep").unwrap();
        make_dir_link(&raw.s(), outside.path());
        raw.write(JournalStep::Extracting, false);
        dismiss_restore_journal(&raw.journal()).unwrap();
        assert!(!raw.journal().exists());
        assert!(fs::symlink_metadata(raw.s()).is_ok());
        assert_eq!(fs::read(outside.path().join("keep")).unwrap(), b"keep");
    }

    #[test]
    fn dismiss_keeps_the_journal_when_the_staging_folder_will_not_go() {
        let _reset = Cleanup;
        let raw = Raw::new();
        raw.make(&raw.s(), "S");
        raw.write(JournalStep::Extracting, false);
        failpoint::arm("restore.remove_staging");
        let got = dismiss_restore_journal(&raw.journal());
        failpoint::disarm_all();
        assert!(matches!(got, Err(CoreError::Io(_))));
        assert!(raw.s().exists() && raw.journal().exists());
    }

    /// The folder that holds S, T and B, moved aside as when the drive of the vaults folder is
    /// not plugged in. Dropping this plugs it in again. The moves retry, as the code's own do,
    /// while another program (antivirus) holds a file inside for a moment.
    struct Unplugged {
        folder: PathBuf,
        aside: PathBuf,
    }

    impl Unplugged {
        fn new(folder: &Path) -> Unplugged {
            let folder = folder.to_owned();
            let mut aside = folder.clone().into_os_string();
            aside.push("-unplugged");
            let aside = PathBuf::from(aside);
            rename_dir_no_replace(&folder, &aside).unwrap();
            Unplugged { folder, aside }
        }
    }

    impl Drop for Unplugged {
        fn drop(&mut self) {
            let _ = rename_dir_no_replace(&self.aside, &self.folder);
        }
    }

    /// With the folder that holds S, T and B gone, S and T both read as missing, which says
    /// nothing about them. Recovery decides nothing: `RestorePending`, the journal stays byte
    /// for byte, and nothing is created. Once the folder is back, recovery does its job.
    #[test]
    fn recovery_keeps_the_journal_while_the_vaults_folder_is_missing() {
        use JournalStep::{Extracting, Swapping};
        for (step, with_b, then) in [
            (Extracting, false, Recovery::StagingRemoved),
            (Swapping, false, Recovery::RolledBack),
            (Swapping, true, Recovery::RolledBack),
        ] {
            let what = format!("{step:?}, B in the journal: {with_b}");
            let raw = Raw::new();
            raw.make(&raw.t(), "T");
            raw.make(&raw.s(), "S");
            raw.write(step, with_b);
            let journal = fs::read(raw.journal()).unwrap();
            let unplugged = Unplugged::new(raw.parent.path());
            let before = tree(&unplugged.aside);

            let got = recover_restore(&raw.journal());
            assert!(
                matches!(got, Err(CoreError::RestorePending)),
                "{what}: {got:?}"
            );
            assert_eq!(fs::read(raw.journal()).unwrap(), journal, "{what}");
            assert!(!raw.parent.path().exists(), "{what}: the folder came back");
            assert!(tree(&unplugged.aside) == before, "{what}: S or T changed");
            assert_eq!(
                names(raw.journal_dir.path()),
                ["restore-journal.json", "restore-journal.json.lock"],
                "{what}"
            );

            // Plugged in again: S and the journal go, T stays.
            drop(unplugged);
            assert_eq!(recover_restore(&raw.journal()).unwrap(), then, "{what}");
            assert_eq!(Raw::marker(&raw.t()).as_deref(), Some("T"), "{what}");
            assert!(!raw.s().exists() && !raw.journal().exists(), "{what}");
        }
    }

    /// Dismissal is the user's confirmed way out, so it still works while the folder that holds
    /// S, T and B is missing (the interface says the drive is not connected): the journal goes,
    /// and nothing on the missing path is touched or created.
    #[test]
    fn dismissal_works_while_the_vaults_folder_is_missing() {
        let raw = Raw::new();
        raw.make_all();
        raw.write(JournalStep::Swapping, true);
        let unplugged = Unplugged::new(raw.parent.path());
        let before = tree(&unplugged.aside);

        dismiss_restore_journal(&raw.journal()).unwrap();
        assert!(!raw.journal().exists(), "the journal stayed");
        assert!(!raw.parent.path().exists(), "the folder was created");
        assert_eq!(names(raw.journal_dir.path()), ["restore-journal.json.lock"]);
        assert!(tree(&unplugged.aside) == before, "a folder changed");
        // Plugged in again: S, T and B are as they were.
        drop(unplugged);
        for (path, marker) in [(raw.s(), "S"), (raw.t(), "T"), (raw.b(), "B")] {
            assert_eq!(Raw::marker(&path).as_deref(), Some(marker));
        }
    }

    /// The vaults folder goes away (its drive is unplugged, say) while a prepare extracts, and
    /// the prepare then fails. Its clean-up cannot see the staging folder, and the staging
    /// folder always goes before the journal, so the journal stays byte for byte. Plugged in
    /// again, startup recovery removes the staging folder and then the journal.
    #[test]
    fn a_failed_prepare_keeps_the_journal_while_the_vaults_folder_is_missing() {
        let _reset = Cleanup;
        let (_f, backup) = backed_up();
        let d = Dest::new();
        let (folder, journal) = (d.parent().to_owned(), d.journal());
        let away: Rc<RefCell<Option<Unplugged>>> = Rc::default();
        let written: Rc<RefCell<Vec<u8>>> = Rc::default();
        let (slot, bytes) = (away.clone(), written.clone());
        // After the first entry is written and read back; the step then fails.
        failpoint::observe(
            "restore.after_entry",
            Box::new(move || {
                if slot.borrow().is_none() {
                    *bytes.borrow_mut() = fs::read(&journal).unwrap();
                    *slot.borrow_mut() = Some(Unplugged::new(&folder));
                }
            }),
        );
        failpoint::arm("restore.after_entry");
        let result = d.prepare(&backup, Credential::Password(PW));
        failpoint::disarm_all();
        assert!(matches!(error(result), CoreError::Io(_)));

        let unplugged = away.borrow_mut().take().unwrap();
        assert_eq!(
            fs::read(d.journal()).unwrap(),
            *written.borrow(),
            "the journal changed"
        );
        assert!(!d.parent().exists(), "the folder was created");
        drop(unplugged);
        let staging = staging_in(d.parent());
        assert_eq!(
            recover_restore(&d.journal()).unwrap(),
            Recovery::StagingRemoved
        );
        assert!(!staging.exists());
        d.assert_untouched();
    }

    /// The swap rewrites the journal, recovery acts and dismissal deletes only while holding
    /// the journal lock, asked through a separate handle at exactly those moments.
    #[test]
    fn the_swap_rewrites_the_journal_under_the_lock() {
        let _reset = Cleanup;
        let s = Scene::replace();
        let mut p = s.prepare();
        let at_swap = observe_lock_held("restore.swap_under_lock", &s.journal());
        let at_revert = observe_lock_held("restore.revert_under_lock", &s.journal());
        failpoint::arm("restore.fail_move_existing");
        assert!(p.commit(&CancelToken::new()).is_err());
        failpoint::disarm_all();
        assert_eq!((at_swap.get(), at_revert.get()), (1, 1));
        assert!(!lock_is_held(&s.journal()));
    }

    #[test]
    fn recovery_runs_under_the_journal_lock() {
        let _reset = Cleanup;
        let s = Scene::replace();
        crash_at(&s, "restore.after_move_existing");

        let journal = s.journal();
        let held: Vec<_> = [
            "recover.under_lock",
            "recover.fail_rename",
            "recover.after_rename",
            "restore.remove_staging",
            "journal.before_owner_delete",
        ]
        .into_iter()
        .map(|point| (point, observe_lock_held(point, &journal)))
        .collect();
        assert_eq!(recover_restore(&journal).unwrap(), Recovery::RolledBack);
        for (point, count) in held {
            assert_eq!(count.get(), 1, "{point}");
        }
        assert!(!lock_is_held(&journal));
    }

    /// The first rename reports an error after it moved the folder. Only a T still in place
    /// proves nothing moved, so this is not "nothing moved": recovery moves B back.
    #[test]
    fn error_after_the_first_rename_moved_the_folder_is_recovered() {
        let _reset = Cleanup;
        let s = Scene::replace();
        let mut p = s.prepare();
        failpoint::arm("restore.fail_after_move_existing");
        let result = p.commit(&CancelToken::new());
        failpoint::disarm_all();

        assert!(matches!(result, Err(CoreError::Io(_))), "{result:?}");
        s.assert_settled();
        s.assert_old_at(&s.target);
        assert!(!s.before("").exists());
        // Rolled back, so the restore is gone.
        assert!(matches!(
            p.commit(&CancelToken::new()),
            Err(CoreError::InvalidInput {
                what: "restore discarded"
            })
        ));
    }

    /// The pre-restore name is taken between the choice and the rename: refused before any
    /// move, so the restore stays and a retry picks the next name.
    #[test]
    fn a_pre_restore_name_taken_at_the_last_moment_keeps_restore() {
        let _reset = Cleanup;
        let s = Scene::replace();
        let mut p = s.prepare();
        let taken = s.before("");
        let intruder = taken.clone();
        failpoint::observe(
            "restore.after_journal",
            Box::new(move || fs::create_dir(&intruder).unwrap()),
        );
        let result = p.commit(&CancelToken::new());
        failpoint::disarm_all();

        assert!(matches!(
            result,
            Err(CoreError::InvalidInput {
                what: "destination exists"
            })
        ));
        let j = journal_step(&s.journal());
        assert_eq!((j.step, j.before_restore), (JournalStep::Extracting, None));
        assert!(s.target.exists() && taken.exists());
        let out = p.commit(&CancelToken::new()).unwrap();
        assert_eq!(out.before_restore, Some(s.before("-2")));
        s.assert_settled();
        s.assert_restored_at(&s.target);
        s.assert_old_at(&s.before("-2"));
    }

    /// One lock from the first look at the journal to its deletion: held at each rename, at
    /// the sync after them and at the journal delete (a separate handle's `try_lock`).
    #[test]
    fn the_renames_run_under_the_journal_lock() {
        let _reset = Cleanup;
        let s = Scene::replace();
        let mut p = s.prepare();
        let held: Vec<_> = [
            "restore.swap_under_lock",
            "restore.after_journal",
            "restore.after_move_existing",
            "restore.after_move_staging",
            "restore.before_journal_done",
            "journal.before_owner_delete",
        ]
        .into_iter()
        .map(|point| (point, observe_lock_held(point, &s.journal())))
        .collect();
        p.commit(&CancelToken::new()).unwrap();
        for (point, count) in held {
            assert_eq!(count.get(), 1, "{point}");
        }
        assert!(!lock_is_held(&s.journal()));
        s.assert_settled();
    }

    /// The folders are checked at the swap too: a staging folder that became a link after
    /// `prepare` is not renamed. The restore is disarmed, so a drop deletes nothing either.
    #[test]
    fn a_staging_link_found_at_the_swap_is_refused() {
        let s = Scene::replace();
        let mut p = s.prepare();
        let staging = staging_in(s.parent());
        let outside = TempDir::new();
        fs::write(outside.path().join("keep"), b"keep").unwrap();
        fs::remove_dir_all(&staging).unwrap();
        make_dir_link(&staging, outside.path());
        let before = snapshot(s.parent(), &s.journal());

        assert_damaged_commit(p.commit(&CancelToken::new()));
        assert!(
            snapshot(s.parent(), &s.journal()) == before,
            "something moved"
        );
        assert_eq!(journal_step(&s.journal()).step, JournalStep::Extracting);
        drop(p);
        assert!(
            snapshot(s.parent(), &s.journal()) == before,
            "the drop deleted"
        );
        assert_eq!(fs::read(outside.path().join("keep")).unwrap(), b"keep");
    }

    /// Someone else's journal at the path is "restore in progress", not "unclear" (which
    /// would offer to dismiss it): nothing is renamed, and the drop leaves their journal.
    #[test]
    fn another_operations_journal_stops_the_swap() {
        let s = Scene::replace();
        let mut p = s.prepare();
        let theirs = RestoreJournal {
            staging: new_staging_path(s.parent()),
            ..journal_step(&s.journal())
        };
        write_journal(&s.journal(), &theirs).unwrap();
        let before = snapshot(s.parent(), &s.journal());

        assert!(matches!(
            p.commit(&CancelToken::new()),
            Err(CoreError::InvalidInput {
                what: "restore in progress"
            })
        ));
        assert!(snapshot(s.parent(), &s.journal()) == before);
        drop(p);
        assert_eq!(journal_step(&s.journal()).staging, theirs.staging);
        assert!(s.target.exists() && !s.before("").exists());
    }

    /// A journal that is not exactly this restore's pre-swap state is refused with nothing
    /// renamed, and the restore is disarmed: dropping it keeps S, T and the journal as they are.
    #[track_caller]
    fn assert_swap_refused(s: &Scene, mut p: PreparedRestore) {
        let before = snapshot(s.parent(), &s.journal());
        assert_damaged_commit(p.commit(&CancelToken::new()));
        assert!(
            snapshot(s.parent(), &s.journal()) == before,
            "something moved"
        );
        drop(p);
        assert!(
            snapshot(s.parent(), &s.journal()) == before,
            "the drop deleted"
        );
        assert!(!s.before("").exists());
    }

    #[test]
    fn an_unreadable_journal_at_the_swap_is_refused_and_kept() {
        let s = Scene::replace();
        let p = s.prepare();
        // A field this version does not know: `read_journal` says `Damaged`.
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(s.journal()).unwrap()).unwrap();
        value["extra"] = 1.into();
        fs::write(s.journal(), serde_json::to_vec(&value).unwrap()).unwrap();
        assert_swap_refused(&s, p);
        staging_in(s.parent());
    }

    #[test]
    fn a_journal_past_extracting_at_the_swap_is_refused_and_kept() {
        let s = Scene::replace();
        let p = s.prepare();
        let swapping = RestoreJournal {
            step: JournalStep::Swapping,
            before_restore: Some(s.before("")),
            ..journal_step(&s.journal())
        };
        write_journal(&s.journal(), &swapping).unwrap();
        assert_swap_refused(&s, p);
        assert_eq!(journal_step(&s.journal()).step, JournalStep::Swapping);
        staging_in(s.parent());
    }

    /// The staging folder is on disk under capitals, which Windows finds under the journal's
    /// lowercase name too. Recovery refuses before it moves B, and dismissal removes the
    /// journal but not that folder.
    #[cfg(windows)]
    #[test]
    fn a_case_variant_staging_folder_is_refused_before_anything_moves() {
        let raw = Raw::new();
        let alias = raw
            .parent
            .path()
            .join(format!(".RESTORE-{}", HEX.to_uppercase()));
        raw.make(&alias, "S");
        raw.make(&raw.b(), "B");
        raw.write(JournalStep::Swapping, true);
        assert!(raw.s().exists(), "Windows finds the lowercase spelling");
        let before = snapshot(raw.parent.path(), &raw.journal());

        assert_damaged_journal(recover_restore(&raw.journal()));
        assert!(snapshot(raw.parent.path(), &raw.journal()) == before);
        assert!(!raw.t().exists(), "B was moved to T");

        dismiss_restore_journal(&raw.journal()).unwrap();
        assert!(!raw.journal().exists());
        assert_eq!(Raw::marker(&alias).as_deref(), Some("S"));
        assert_eq!(Raw::marker(&raw.b()).as_deref(), Some("B"));
        assert!(!raw.t().exists());
    }

    #[test]
    fn dismissal_runs_under_the_journal_lock() {
        let _reset = Cleanup;
        let raw = Raw::new();
        raw.make(&raw.s(), "S");
        raw.write(JournalStep::Extracting, false);
        let journal = raw.journal();
        let held: Vec<_> = ["restore.remove_staging", "dismiss.before_delete"]
            .into_iter()
            .map(|point| (point, observe_lock_held(point, &journal)))
            .collect();
        dismiss_restore_journal(&journal).unwrap();
        for (point, count) in held {
            assert_eq!(count.get(), 1, "{point}");
        }
        assert!(!lock_is_held(&journal));
    }

    // ---- Plan 3 Task 5: restore into a new folder the user names.

    use crate::vault::naming::{check_folder_name, is_reserved_device_name};

    const RESTORED: &str = "Family (restored)";

    fn new_folder() -> RestoreDestination {
        RestoreDestination::NewFolder(RESTORED.into())
    }

    /// The names in `parent` and in the journal's folder: a refusal that wrote nothing leaves
    /// both as they were (no journal, no lock file, no staging folder).
    fn listing(parent: &Path, journal: &Path) -> (Vec<String>, Vec<String>) {
        (names(parent), names(parent_dir(journal)))
    }

    impl Dest {
        /// A prepare into `parent` with `destination`, journaled at this destination's journal.
        fn prepare_to(
            &self,
            archive: &Path,
            parent: &Path,
            destination: RestoreDestination,
        ) -> Result<PreparedRestore> {
            let credential = Credential::Password(PW);
            let journal = self.journal();
            PreparedRestore::prepare(
                archive,
                parent,
                credential,
                destination,
                &journal,
                &CancelToken::new(),
            )
        }
    }

    /// Both header copies of the vault are unreadable, so restore cannot tell its folder is that
    /// vault: in place it stops at the taken name, and a new folder the user names restores
    /// beside it, leaving the damaged folder byte for byte as it was.
    #[test]
    fn new_folder_restore_beside_unreadable_vault() {
        let (f, backup) = backed_up();
        let backup_titles = sorted_titles(&f.vault);
        let Fixture { parent, vault, .. } = f;
        let damaged = vault.dir().to_owned();
        drop(vault);
        for file in [HEADER_FILE, HEADER_BACKUP] {
            fs::write(damaged.join(file), b"damaged in place").unwrap();
        }
        let damaged_before = tree(&damaged);
        let d = Dest::new();
        let before = listing(parent.path(), &d.journal());

        let same = d.prepare_to(&backup, parent.path(), RestoreDestination::SameVault);
        assert_eq!(invalid(same), "destination exists");
        assert_eq!(listing(parent.path(), &d.journal()), before);
        assert_eq!(d.reached_journal.get(), 0, "the journal write was reached");

        let mut p = d.prepare_to(&backup, parent.path(), new_folder()).unwrap();
        assert_eq!(p.existing(), None);
        let restored = parent.path().join(RESTORED);
        let journal = read_journal(&d.journal()).unwrap().unwrap();
        assert_eq!(
            (journal.target, journal.before_restore),
            (restored.clone(), None)
        );
        let out = p.commit(&CancelToken::new()).unwrap();
        assert_eq!(out.dir, restored);
        assert_eq!(out.before_restore, None);
        drop(p);
        assert!(!d.journal().exists(), "journal left behind");
        assert_eq!(titles(&restored), backup_titles);
        assert!(
            tree(&damaged) == damaged_before,
            "the damaged folder changed"
        );
    }

    /// A readable copy of the same vault in the parent (either header copy readable): a second
    /// writable copy would make every later restore there refuse "several copies".
    #[test]
    fn new_folder_refused_beside_a_readable_copy() {
        let (f, backup) = backed_up();
        let Fixture { parent, vault, .. } = f;
        let live = vault.dir().to_owned();
        let d = Dest::new();
        let check = |what: &str| {
            let before = (listing(parent.path(), &d.journal()), tree(&live));
            let result = d.prepare_to(&backup, parent.path(), new_folder());
            assert_eq!(invalid(result), "vault already here", "{what}");
            let after = (listing(parent.path(), &d.journal()), tree(&live));
            assert!(after == before, "{what}: something was written");
            assert_eq!(
                d.reached_journal.get(),
                0,
                "{what}: the journal write was reached"
            );
        };
        check("open vault");
        drop(vault);
        fs::write(live.join(HEADER_FILE), b"damaged in place").unwrap();
        check("only the .bak readable");
    }

    /// Anything at the chosen name is refused before anything is written: a file, a folder, a
    /// link, and on Windows a folder whose name differs only in letter case.
    #[test]
    fn new_folder_name_taken_refused_before_writing() {
        let _reset = Cleanup;
        let (_f, backup) = backed_up();
        let outside = TempDir::new();
        fs::write(outside.path().join("keep"), b"keep").unwrap();
        type Plant<'a> = Box<dyn Fn(&Path) + 'a>;
        let mut cases: Vec<(&str, Plant)> = vec![
            (
                "file",
                Box::new(|p| fs::write(p.join(RESTORED), b"mine").unwrap()),
            ),
            (
                "folder",
                Box::new(|p| {
                    fs::create_dir(p.join(RESTORED)).unwrap();
                    fs::write(p.join(RESTORED).join("mine"), b"mine").unwrap();
                }),
            ),
            (
                "link",
                Box::new(|p| make_dir_link(&p.join(RESTORED), outside.path())),
            ),
        ];
        if cfg!(windows) {
            cases.push((
                "folder in other letter case",
                Box::new(|p| fs::create_dir(p.join(RESTORED.to_uppercase())).unwrap()),
            ));
        }
        for (what, plant) in cases {
            let d = Dest::new();
            plant(d.parent());
            let before = (listing(d.parent(), &d.journal()), tree(d.parent()));
            let result = d.prepare_to(&backup, d.parent(), new_folder());
            assert_eq!(invalid(result), "destination exists", "{what}");
            let after = (listing(d.parent(), &d.journal()), tree(d.parent()));
            assert!(after == before, "{what}: something was written");
            assert_eq!(
                d.reached_journal.get(),
                0,
                "{what}: the journal write was reached"
            );
            failpoint::disarm_all();
        }
        assert_eq!(fs::read(outside.path().join("keep")).unwrap(), b"keep");
    }

    #[test]
    fn check_folder_name_table() {
        let (ascii_200, astral_200_units) = ("x".repeat(200), "𝒳".repeat(100));
        for ok in [
            "Family (restored)",
            "Clients 2",
            "a.b",
            &ascii_200,
            &astral_200_units,
        ] {
            assert!(check_folder_name(ok).is_ok(), "{ok:?}");
        }
        for bad in [
            "",
            ".hidden",
            "a/b",
            "a\\b",
            "..",
            "x.",
            "x ",
            "CON",
            "con.txt",
            "LPT9",
            "COM¹",
            "conin$",
            "a:b",
            "ab:c",
            "a*b",
            "a?b",
            "a\"b",
            "a<b",
            "a>b",
            "a|b",
            "nul.tar.gz",
            "v.before-restore",
            "v.BEFORE-RESTORE-2",
            "\u{1}",
            &"x".repeat(201),
            &"𝒳".repeat(101),
        ] {
            assert!(
                matches!(
                    check_folder_name(bad),
                    Err(CoreError::InvalidInput {
                        what: "folder name"
                    })
                ),
                "{bad:?}"
            );
        }
        // The one copy of the reserved list: any case, the superscript forms, a whole name (only
        // the part before the first `.` counts) and a stem with spaces after it (dropped before
        // the match, so `NUL .txt` is refused too).
        for reserved in [
            "CON",
            "prn",
            "Aux",
            "nul",
            "CONIN$",
            "Conout$",
            "COM0",
            "com9",
            "LPT0",
            "lpt9",
            "COM²",
            "LPT³",
            "lpt¹",
            "NUL ",
            "nul.txt",
            "NUL.tar.gz",
            "nul .txt",
        ] {
            assert!(is_reserved_device_name(reserved), "{reserved:?}");
        }
        for not_reserved in [
            "", "CONSOLE", "COM", "COM10", "LPT⁴", "NUL1", " NUL", "CON$", "a.nul", ".nul",
        ] {
            assert!(!is_reserved_device_name(not_reserved), "{not_reserved:?}");
        }
        assert!(check_folder_name("NUL .txt").is_err());
    }

    #[track_caller]
    fn assert_folder_name_refused(result: Result<PreparedRestore>, what: &str) {
        let error = error(result);
        assert!(
            matches!(
                error,
                CoreError::InvalidInput {
                    what: "folder name"
                }
            ),
            "{what}: {error:?}"
        );
    }

    /// `prepare` applies the name rule, first of all: each bad name is refused with nothing
    /// written, and even before the archive is opened (a missing archive is not reached).
    #[test]
    fn prepare_refuses_bad_folder_names_before_anything() {
        let _reset = Cleanup;
        let (_f, backup) = backed_up();
        let long = "x".repeat(201);
        for bad in [
            "CON",
            "nul.tar.gz",
            "x.",
            "x ",
            ".hidden",
            "v.before-restore",
            "ab:c",
            "D:x",
            "a\\b",
            &long,
        ] {
            let d = Dest::new();
            let before = listing(d.parent(), &d.journal());
            let destination = RestoreDestination::NewFolder(bad.into());
            assert_folder_name_refused(d.prepare_to(&backup, d.parent(), destination), bad);
            assert_eq!(listing(d.parent(), &d.journal()), before, "{bad:?}");
            assert_eq!(
                d.reached_journal.get(),
                0,
                "{bad:?}: the journal write was reached"
            );
            failpoint::disarm_all();
        }
        let d = Dest::new();
        let missing = d.parent().join("no such backup.lockbox-backup");
        let destination = RestoreDestination::NewFolder("CON".into());
        assert_folder_name_refused(d.prepare_to(&missing, d.parent(), destination), "first");
    }

    /// A parent `units` UTF-16 units long, made of folders under `base`.
    fn deep_parent(base: &Path, units: usize) -> PathBuf {
        let len = |p: &Path| p.as_os_str().to_string_lossy().encode_utf16().count();
        let mut dir = base.to_owned();
        while len(&dir) < units {
            // One separator and at most 60 characters, never leaving exactly one unit to fill.
            let left = units - len(&dir);
            let mut name = (left - 1).min(60);
            if left - (name + 1) == 1 {
                name -= 1;
            }
            dir.push("d".repeat(name));
        }
        assert_eq!(len(&dir), units, "cannot build the parent at that length");
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Every path the restored vault needs must fit Windows' 259 units: in a parent where a
    /// name of `n` characters just fits, `n + 1` is refused with nothing written, and `n` is
    /// restored and opens.
    #[test]
    fn new_folder_path_too_long_refused_before_writing() {
        use crate::vault::naming::{DEEPEST_IN_VAULT_UNITS, MAX_PATH_UNITS};
        let (f, backup) = backed_up();
        let backup_titles = sorted_titles(&f.vault);
        let d = Dest::new();
        let fits = 45;
        // parent + `\` + name + the deepest file = the limit exactly.
        let parent = deep_parent(
            d.parent(),
            MAX_PATH_UNITS - DEEPEST_IN_VAULT_UNITS - 1 - fits,
        );
        let before = listing(&parent, &d.journal());
        let too_long = RestoreDestination::NewFolder("n".repeat(fits + 1));
        assert_folder_name_refused(d.prepare_to(&backup, &parent, too_long), "too long");
        assert_eq!(listing(&parent, &d.journal()), before);
        assert_eq!(d.reached_journal.get(), 0, "the journal write was reached");

        let name = "n".repeat(fits);
        let destination = RestoreDestination::NewFolder(name.clone());
        let mut p = d.prepare_to(&backup, &parent, destination).unwrap();
        let out = p.commit(&CancelToken::new()).unwrap();
        drop(p);
        assert_eq!(out.dir, parent.join(&name));
        assert_eq!(titles(&out.dir), backup_titles);
    }

    /// A vault never goes inside a vault folder: not the damaged one it is restored beside, not
    /// a live one. Refused with nothing written.
    #[test]
    fn new_folder_inside_a_vault_folder_refused() {
        let _reset = Cleanup;
        let (f, backup) = backed_up();
        let live = f.vault.dir().to_owned();
        let elsewhere = TempDir::new();
        let damaged = plant_vault(&f, elsewhere.path(), "Family-damaged");
        for file in [HEADER_FILE, HEADER_BACKUP] {
            fs::write(damaged.join(file), b"damaged in place").unwrap();
        }
        for (what, inside) in [("damaged vault", &damaged), ("live vault", &live)] {
            let d = Dest::new();
            let before = (listing(inside, &d.journal()), tree(inside));
            let result = d.prepare_to(&backup, inside, new_folder());
            assert!(
                matches!(
                    result,
                    Err(CoreError::InvalidInput {
                        what: "destination in a vault folder"
                    })
                ),
                "{what}"
            );
            let after = (listing(inside, &d.journal()), tree(inside));
            assert!(after == before, "{what}: something was written");
            assert_eq!(
                d.reached_journal.get(),
                0,
                "{what}: the journal write was reached"
            );
            failpoint::disarm_all();
        }
    }
}
