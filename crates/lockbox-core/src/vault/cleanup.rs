//! Cleanup at unlock (spec 6.4): runs once, inside `open`, before the session accepts any
//! command, so it cannot race an import. It never fails an unlock: every action is best
//! effort, counted in [`CleanupReport::failed`] when it did not work, and tried again next time.
//!
//! Nothing without a recorded intent is ever deleted. Unreferenced blobs are moved to
//! `files/orphaned/`; only `retired_blobs` lists and `purging` items (both written by an
//! authenticated item) lead to deletion.

use super::files::{BLOB_EXT, FILES_DIR, blob_in};
use super::items::ITEMS_DIR;
use super::{CleanupReport, Vault};
use crate::fsio::{remove_file_retry, rename_dir_no_replace};
use crate::ids::{FileId, ItemId};
use crate::{CoreError, Result};
use std::collections::HashSet;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

const ORPHANED_DIR: &str = "orphaned";

/// Deletes the regular files directly inside `dir` whose names end in `.partial` or `.tmp`
/// (folders and links are never touched), counting them in `report`.
pub(super) fn remove_scraps(dir: &Path, report: &mut CleanupReport) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return,
        Err(_) => return report.failed += 1,
    };
    for entry in entries {
        let Ok(entry) = entry else {
            report.failed += 1;
            continue;
        };
        let name = entry.file_name();
        let counter = match name.to_string_lossy() {
            n if n.ends_with(".partial") => &mut report.partials_removed,
            n if n.ends_with(".tmp") => &mut report.temps_removed,
            _ => continue,
        };
        if entry.file_type().is_ok_and(|t| t.is_file()) {
            match remove_file_retry(&entry.path()) {
                Ok(()) => *counter += 1,
                Err(_) => report.failed += 1,
            }
        }
    }
}

/// The canonical blobs directly inside `folder` (regular files named `<32 lowercase hex>.blob`)
/// with their sizes, sorted by ID. A missing folder holds none; a link is an error.
pub(super) fn list_blobs(folder: &Path) -> Result<Vec<(FileId, u64)>> {
    check_folder(folder)?;
    let entries = match fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut blobs = Vec::new();
    for entry in entries {
        let entry = entry?;
        let id = entry
            .file_name()
            .to_str()
            .and_then(|n| n.strip_suffix(BLOB_EXT))
            .and_then(|hex| FileId::from_hex(hex).ok());
        // `DirEntry::metadata` does not follow links, so a link named like a blob is skipped.
        if let Some(id) = id {
            let meta = entry.metadata()?;
            if meta.is_file() {
                blobs.push((id, meta.len()));
            }
        }
    }
    blobs.sort();
    Ok(blobs)
}

/// Moves each blob from `from` to `to`, never replacing one that is there. Returns how many
/// moved; the caller counts the rest as failed.
fn move_blobs(ids: &[FileId], from: &Path, to: &Path) -> usize {
    let moved = |id| rename_dir_no_replace(&blob_in(from, id), &blob_in(to, id)).is_ok();
    ids.iter().filter(|id| moved(*id)).count()
}

/// Fails unless `folder` is a real folder or is missing. A link or junction (std reports both as
/// links) could lead outside the vault, so cleanup never works through one.
pub(super) fn check_folder(folder: &Path) -> Result<()> {
    match fs::symlink_metadata(folder) {
        Ok(meta) if meta.is_dir() => Ok(()),
        Ok(_) => Err(CoreError::InvalidInput {
            what: "not a plain folder",
        }),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

fn delete_blob(files: &Path, id: &FileId) -> Result<()> {
    #[cfg(test)]
    crate::fsio::failpoint::check("cleanup.delete_blob")?;
    remove_file_retry(&blob_in(files, id))
}

impl Vault {
    fn files_dir(&self) -> PathBuf {
        self.dir.join(FILES_DIR)
    }

    fn orphaned_dir(&self) -> PathBuf {
        self.files_dir().join(ORPHANED_DIR)
    }

    /// The quarantine folder for the public calls, after checking that `files/` is no link
    /// either (a real-looking `orphaned/` inside a linked `files/` is outside the vault).
    fn checked_orphaned_dir(&self) -> Result<PathBuf> {
        check_folder(&self.files_dir())?;
        Ok(self.orphaned_dir())
    }

    /// Deletes a blob from `files/` and from the quarantine, where an unlock may have moved it
    /// while its item file was missing. Nothing is deleted through a linked `files/` or
    /// quarantine (a user purge reaches here without the checks unlock cleanup makes).
    pub(super) fn delete_blob_everywhere(&self, id: &FileId) -> Result<()> {
        let orphaned = self.checked_orphaned_dir()?;
        check_folder(&orphaned)?;
        delete_blob(&self.files_dir(), id)?;
        remove_file_retry(&blob_in(&orphaned, id))
    }

    /// Blobs that some loaded item (trashed ones included) lists as an attachment, not
    /// counting the item `except`.
    pub(super) fn attached_blobs(&self, except: Option<&ItemId>) -> HashSet<FileId> {
        let others = self.items.values().filter(|i| Some(&i.id) != except);
        let attachments = others.flat_map(|i| &i.attachments);
        attachments.map(|f| f.file_id).collect()
    }

    /// Blobs that some loaded item attaches or has retired.
    fn referenced_blobs(&self) -> HashSet<FileId> {
        let mut blobs = self.attached_blobs(None);
        blobs.extend(self.items.values().flat_map(|i| &i.retired_blobs));
        blobs
    }

    /// The whole cleanup, in this order: scraps, interrupted purges, retired lists, referenced
    /// blobs back from quarantine, then quarantine of the unreferenced.
    pub(super) fn run_cleanup(&mut self) -> CleanupReport {
        let mut report = CleanupReport::default();
        remove_scraps(&self.dir, &mut report);
        // A linked `items` or `files` folder could lead outside the vault: nothing is done in
        // it, and the steps that need both folders are skipped.
        let mut folders_usable = true;
        for folder in [self.dir.join(ITEMS_DIR), self.files_dir()] {
            if check_folder(&folder).is_ok() {
                remove_scraps(&folder, &mut report);
            } else {
                report.failed += 1;
                folders_usable = false;
            }
        }
        if folders_usable {
            self.finish_purges(&mut report);
            self.clear_retired(&mut report);
            self.restore_attached(&mut report);
            self.quarantine_unreferenced(&mut report);
        }
        report
    }

    fn finish_purges(&mut self, report: &mut CleanupReport) {
        let purging: Vec<ItemId> = self
            .items
            .values()
            .filter(|i| i.purging)
            .map(|i| i.id)
            .collect();
        for id in purging {
            match self.purge_item(&id) {
                Ok(()) => report.purges_finished += 1,
                Err(_) => report.failed += 1,
            }
        }
    }

    /// Deletes the blobs in each item's `retired_blobs` and clears the entries that are done.
    /// A blob some item still attaches is only dropped from the list. Housekeeping, not an
    /// edit: the revision and modified time stay as they were.
    fn clear_retired(&mut self, report: &mut CleanupReport) {
        let attached = self.attached_blobs(None);
        let todo: Vec<_> = self
            .items
            .values()
            .filter(|i| !i.purging && !i.retired_blobs.is_empty())
            .cloned()
            .collect();
        for mut item in todo {
            let listed = item.retired_blobs.len();
            item.retired_blobs.retain(|blob| {
                let done = attached.contains(blob) || self.delete_blob_everywhere(blob).is_ok();
                report.failed += usize::from(!done);
                !done
            });
            let cleared = listed - item.retired_blobs.len();
            if cleared == 0 {
                continue;
            }
            match self.commit_item(item) {
                Ok(()) => report.retired_deleted += cleared,
                Err(_) => report.failed += 1,
            }
        }
    }

    /// Moves quarantined blobs that an item attaches again back into `files/`. Runs even when
    /// items are damaged: it only returns something to where an authenticated item expects it.
    /// (Retired blobs are not moved back: their lists were just cleared.)
    fn restore_attached(&self, report: &mut CleanupReport) {
        let Ok(found) = list_blobs(&self.orphaned_dir()) else {
            return report.failed += 1;
        };
        let attached = self.attached_blobs(None);
        let ids: Vec<FileId> = found
            .into_iter()
            .map(|(id, _)| id)
            .filter(|id| attached.contains(id))
            .collect();
        let moved = move_blobs(&ids, &self.orphaned_dir(), &self.files_dir());
        report.orphans_restored = moved;
        report.failed += ids.len() - moved;
    }

    /// Sets aside blobs nothing references. Skipped entirely while any item file is damaged:
    /// the blob may belong to an item that cannot be read right now.
    fn quarantine_unreferenced(&self, report: &mut CleanupReport) {
        if !self.damaged.is_empty() {
            report.skipped_damaged = self.damaged.len();
            return;
        }
        let referenced = self.referenced_blobs();
        let files = self.files_dir();
        let Ok(found) = list_blobs(&files) else {
            return report.failed += 1;
        };
        let ids: Vec<FileId> = found
            .into_iter()
            .map(|(id, _)| id)
            .filter(|id| !referenced.contains(id))
            .collect();
        if ids.is_empty() {
            return;
        }
        let orphaned = self.orphaned_dir();
        let ready = check_folder(&orphaned).and_then(|()| Ok(fs::create_dir_all(&orphaned)?));
        if ready.is_err() {
            return report.failed += ids.len();
        }
        let moved = move_blobs(&ids, &files, &orphaned);
        report.orphans_quarantined = moved;
        report.failed += ids.len() - moved;
    }

    /// The quarantined blobs with their sizes in bytes, sorted by ID.
    pub fn orphans(&self) -> Result<Vec<(FileId, u64)>> {
        list_blobs(&self.checked_orphaned_dir()?)
    }

    /// Permanently deletes the quarantined blobs that no item references, and returns how
    /// many. Stops at the first one that cannot be deleted.
    pub fn delete_orphans(&mut self) -> Result<usize> {
        let orphaned = self.checked_orphaned_dir()?;
        let referenced = self.referenced_blobs();
        let mut deleted = 0;
        for (id, _) in list_blobs(&orphaned)? {
            if !referenced.contains(&id) {
                remove_file_retry(&blob_in(&orphaned, &id))?;
                deleted += 1;
            }
        }
        Ok(deleted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blob::{CancelToken, NoJournal};
    use crate::fsio::{failpoint, testutil::TempDir};
    use crate::ids::ItemId;
    use crate::item::ItemKind;
    use crate::vault::items::edited;
    use std::fs;
    use std::path::{Path, PathBuf};

    const PW: &str = "correct horse battery";

    /// Always disarms, so a failing test cannot leak a failpoint into the next one on this thread.
    struct Disarm;
    impl Drop for Disarm {
        fn drop(&mut self) {
            failpoint::disarm_all();
        }
    }

    fn new_vault() -> (TempDir, Vault) {
        let parent = TempDir::new();
        let vault = Vault::create(parent.path(), "Family", PW).unwrap().vault;
        (parent, vault)
    }

    /// Closes the vault and unlocks it again, returning what cleanup did.
    fn reopen(vault: Vault) -> (Vault, CleanupReport) {
        let dir = vault.dir().to_path_buf();
        drop(vault);
        let (vault, report) = Vault::unlock_with_password(&dir, PW).unwrap();
        (vault, report.cleanup)
    }

    fn source(parent: &TempDir, name: &str, bytes: &[u8]) -> PathBuf {
        let path = parent.path().join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    fn item_file(vault: &Vault, id: &ItemId) -> PathBuf {
        vault
            .dir()
            .join("items")
            .join(format!("{}.item", id.to_hex()))
    }

    /// A file item holding `bytes`, and its attachment.
    fn file_item(parent: &TempDir, vault: &mut Vault, bytes: &[u8]) -> (ItemId, FileId) {
        let src = source(parent, "doc.bin", bytes);
        let id = vault
            .new_file_item(None, &src, &CancelToken::new())
            .unwrap();
        let file = vault.get_item(&id).unwrap().attachments[0].file_id;
        (id, file)
    }

    /// Puts a blob-shaped file nothing refers to in `folder`.
    fn plant_blob(folder: &Path, bytes: &[u8]) -> FileId {
        let id = FileId::random();
        fs::write(blob_in(folder, &id), bytes).unwrap();
        id
    }

    fn corrupt(vault: &Vault, id: &ItemId) {
        let path = item_file(vault, id);
        let mut bytes = fs::read(&path).unwrap();
        bytes[40] ^= 1;
        fs::write(&path, bytes).unwrap();
    }

    fn exported(parent: &TempDir, vault: &Vault, item: &ItemId, file: &FileId) -> Vec<u8> {
        let dest = parent.path().join("out.bin");
        vault
            .export_file(item, file, &dest, &NoJournal, &CancelToken::new())
            .unwrap();
        fs::read(dest).unwrap()
    }

    /// A file item whose first file was replaced, so the old blob is in `retired_blobs`.
    fn with_retired(parent: &TempDir, vault: &mut Vault) -> (ItemId, FileId, FileId) {
        let (id, old) = file_item(parent, vault, b"first");
        let second = source(parent, "second.bin", b"second");
        let new = vault
            .replace_attachment(&id, &old, &second, &CancelToken::new())
            .unwrap();
        (id, old, new)
    }

    #[test]
    fn partials_and_temps_removed() {
        let (_parent, vault) = new_vault();
        let dir = vault.dir().to_path_buf();
        let hex = "0123456789abcdef0123456789abcdef";
        let gone = [
            dir.join(".old.tmp"),
            dir.join("items").join(".b.tmp"),
            dir.join("items").join("c.tmp"),
            dir.join("files").join(format!("{hex}.blob.partial")),
            dir.join("files").join("d.partial"),
        ];
        let kept = [
            dir.join("notes.tmp.txt"),
            dir.join("files").join("orphaned").join("e.partial"),
            dir.join("files").join("orphaned").join("e.tmp"),
        ];
        for path in gone.iter().chain(&kept) {
            fs::write(path, b"x").unwrap();
        }
        // A folder is never removed, whatever its name.
        let folder = dir.join("items").join("keep.tmp");
        fs::create_dir(&folder).unwrap();

        let (vault, report) = reopen(vault);

        assert_eq!(report.partials_removed, 2);
        assert_eq!(report.temps_removed, 3);
        assert_eq!(report.failed, 0);
        assert!(gone.iter().all(|p| !p.exists()), "scraps are gone");
        assert!(kept.iter().all(|p| p.exists()), "everything else stays");
        assert!(folder.is_dir());
        assert!(dir.join("vault.json").exists());
        drop(vault);
    }

    #[test]
    fn retired_blobs_deleted_and_list_cleared() {
        let (parent, mut vault) = new_vault();
        let (id, old, new) = with_retired(&parent, &mut vault);
        let before = vault.get_item(&id).unwrap().clone();
        assert_eq!(before.retired_blobs, [old]);
        let (vault, report) = reopen(vault);

        assert_eq!((report.retired_deleted, report.failed), (1, 0));
        assert!(!blob_in(&vault.files_dir(), &old).exists());
        assert!(blob_in(&vault.files_dir(), &new).exists());
        // Housekeeping, not an edit: the revision and the modified time do not move.
        let after = vault.get_item(&id).unwrap();
        assert!(after.retired_blobs.is_empty());
        assert_eq!(after.revision, before.revision);
        assert_eq!(after.modified_at, before.modified_at);

        // The cleared list was written to disk.
        let (vault, report) = reopen(vault);
        assert_eq!(report.retired_deleted, 0);
        assert!(vault.get_item(&id).unwrap().retired_blobs.is_empty());
        assert_eq!(exported(&parent, &vault, &id, &new), b"second");
    }

    /// Moves `blob` from `files/` into the quarantine, as an unlock does while its item file
    /// is missing.
    fn quarantine(vault: &Vault, blob: &FileId) {
        fs::rename(
            blob_in(&vault.files_dir(), blob),
            blob_in(&vault.orphaned_dir(), blob),
        )
        .unwrap();
    }

    #[test]
    fn a_retired_blob_in_quarantine_is_deleted_too() {
        let (parent, mut vault) = new_vault();
        let (id, old, _new) = with_retired(&parent, &mut vault);
        quarantine(&vault, &old);
        let (vault, report) = reopen(vault);

        assert_eq!((report.retired_deleted, report.failed), (1, 0));
        assert!(!blob_in(&vault.orphaned_dir(), &old).exists());
        assert!(vault.get_item(&id).unwrap().retired_blobs.is_empty());
    }

    #[test]
    fn a_purging_items_blob_in_quarantine_is_deleted_too() {
        let _disarm = Disarm;
        let (parent, mut vault) = new_vault();
        let (id, file) = file_item(&parent, &mut vault, b"bye");
        vault.trash_item(&id).unwrap();
        failpoint::arm("purge.after_mark");
        assert!(vault.purge_item(&id).is_err());
        failpoint::disarm_all();
        quarantine(&vault, &file);
        let (vault, report) = reopen(vault);

        assert_eq!((report.purges_finished, report.failed), (1, 0));
        assert!(!item_file(&vault, &id).exists());
        assert!(!blob_in(&vault.orphaned_dir(), &file).exists());
    }

    #[test]
    fn a_retired_blob_is_not_deleted_through_a_linked_quarantine() {
        let (parent, mut vault) = new_vault();
        let (id, old, _new) = with_retired(&parent, &mut vault);
        let outside = TempDir::new();
        quarantine(&vault, &old);
        fs::rename(
            blob_in(&vault.orphaned_dir(), &old),
            blob_in(outside.path(), &old),
        )
        .unwrap();
        if !link_folder(&vault.orphaned_dir(), outside.path()) {
            return;
        }
        let (vault, report) = reopen(vault);

        assert!(report.failed >= 1);
        assert_eq!(report.retired_deleted, 0);
        assert!(blob_in(outside.path(), &old).exists());
        // The entry stays, so the next unlock tries again.
        assert_eq!(vault.get_item(&id).unwrap().retired_blobs, [old]);
    }

    #[test]
    fn a_blob_another_item_still_attaches_is_never_deleted() {
        let (parent, mut vault) = new_vault();
        let (keeper, shared) = file_item(&parent, &mut vault, b"shared");
        let other = vault.new_item(ItemKind::Note, "other", None).unwrap();
        let mut next = edited(vault.get_item(&other).unwrap()).unwrap();
        next.retired_blobs.push(shared);
        vault.commit_item(next).unwrap();
        let (vault, report) = reopen(vault);

        // The entry is dropped from the list, but the blob is not deleted.
        assert_eq!((report.retired_deleted, report.failed), (1, 0));
        assert!(vault.get_item(&other).unwrap().retired_blobs.is_empty());
        assert_eq!(exported(&parent, &vault, &keeper, &shared), b"shared");
    }

    #[test]
    fn purging_item_finished() {
        let _disarm = Disarm;
        let (parent, mut vault) = new_vault();
        let (id, file) = file_item(&parent, &mut vault, b"bye");
        vault.trash_item(&id).unwrap();
        failpoint::arm("purge.after_mark");
        assert!(vault.purge_item(&id).is_err());
        failpoint::disarm_all();
        assert!(vault.get_item(&id).unwrap().purging);
        let (vault, report) = reopen(vault);

        assert_eq!((report.purges_finished, report.failed), (1, 0));
        assert!(vault.get_item(&id).is_err());
        assert!(!item_file(&vault, &id).exists());
        assert!(!blob_in(&vault.files_dir(), &file).exists());
        assert_eq!(report.orphans_quarantined, 0);
    }

    #[test]
    fn a_purging_item_that_is_not_in_the_trash_is_left_alone() {
        let (_parent, mut vault) = new_vault();
        let id = vault.new_item(ItemKind::Note, "odd", None).unwrap();
        let mut odd = edited(vault.get_item(&id).unwrap()).unwrap();
        odd.purging = true;
        vault.commit_item(odd).unwrap();
        let (vault, report) = reopen(vault);

        assert_eq!((report.purges_finished, report.failed), (0, 1));
        assert!(vault.get_item(&id).unwrap().purging);
        assert!(item_file(&vault, &id).exists());
    }

    #[test]
    fn unreferenced_blob_quarantined_not_deleted() {
        let (_parent, vault) = new_vault();
        let files = vault.files_dir();
        let stray = plant_blob(&files, b"stray bytes");
        // Not a canonical blob name, or not a regular file: never touched.
        let upper = files.join("ABCDEF0123456789ABCDEF0123456789.blob");
        let short = files.join("abc.blob");
        let folder = files.join(format!("{}.blob", FileId::random().to_hex()));
        fs::write(&upper, b"x").unwrap();
        fs::write(&short, b"x").unwrap();
        fs::create_dir(&folder).unwrap();
        let (vault, report) = reopen(vault);

        assert_eq!((report.orphans_quarantined, report.failed), (1, 0));
        assert!(!blob_in(&files, &stray).exists());
        assert_eq!(
            fs::read(blob_in(&vault.orphaned_dir(), &stray)).unwrap(),
            b"stray bytes"
        );
        assert_eq!(vault.orphans().unwrap(), [(stray, 11)]);
        assert!(short.exists() && folder.is_dir());
        assert!(upper.exists());
    }

    #[test]
    fn missing_item_file_quarantines_its_blobs() {
        let (parent, mut vault) = new_vault();
        let (id, file) = file_item(&parent, &mut vault, b"original bytes");
        let item_bytes = fs::read(item_file(&vault, &id)).unwrap();
        let path = item_file(&vault, &id);
        fs::remove_file(&path).unwrap();
        let (vault, report) = reopen(vault);

        assert_eq!(report.orphans_quarantined, 1);
        assert!(!blob_in(&vault.files_dir(), &file).exists());
        assert!(blob_in(&vault.orphaned_dir(), &file).exists());
        assert_eq!(vault.orphans().unwrap().len(), 1);

        // Restore: the blob goes back and so does the item file.
        let dir = vault.dir().to_path_buf();
        drop(vault);
        fs::rename(
            blob_in(&dir.join("files").join("orphaned"), &file),
            blob_in(&dir.join("files"), &file),
        )
        .unwrap();
        fs::write(&path, item_bytes).unwrap();
        let (vault, report) = reopen_dir(&dir);
        assert_eq!(report.orphans_quarantined, 0);
        assert_eq!(exported(&parent, &vault, &id, &file), b"original bytes");
    }

    fn reopen_dir(dir: &Path) -> (Vault, CleanupReport) {
        let (vault, report) = Vault::unlock_with_password(dir, PW).unwrap();
        (vault, report.cleanup)
    }

    #[test]
    fn damaged_item_blocks_orphan_quarantine() {
        let _disarm = Disarm;
        let (parent, mut vault) = new_vault();
        let (retiring, old, _new) = with_retired(&parent, &mut vault);
        let (purging, gone) = file_item(&parent, &mut vault, b"purge me");
        vault.trash_item(&purging).unwrap();
        failpoint::arm("purge.after_mark");
        assert!(vault.purge_item(&purging).is_err());
        failpoint::disarm_all();
        let sick = vault.new_item(ItemKind::Note, "sick", None).unwrap();
        corrupt(&vault, &sick);
        let stray = plant_blob(&vault.files_dir(), b"stray");
        let (vault, report) = reopen(vault);

        assert_eq!(vault.damaged_items(), [sick]);
        assert_eq!(report.skipped_damaged, 1);
        assert_eq!(report.orphans_quarantined, 0);
        assert!(blob_in(&vault.files_dir(), &stray).exists(), "not moved");
        assert!(vault.orphans().unwrap().is_empty());
        // Intent recorded in healthy items is still carried out.
        assert_eq!(report.retired_deleted, 1);
        assert!(!blob_in(&vault.files_dir(), &old).exists());
        assert!(vault.get_item(&retiring).unwrap().retired_blobs.is_empty());
        assert_eq!(report.purges_finished, 1);
        assert!(!blob_in(&vault.files_dir(), &gone).exists());
        assert!(!item_file(&vault, &purging).exists());
    }

    #[test]
    fn referenced_orphans_are_moved_back_even_with_damaged_items() {
        let (parent, mut vault) = new_vault();
        let (id, file) = file_item(&parent, &mut vault, b"come home");
        let sick = vault.new_item(ItemKind::Note, "sick", None).unwrap();
        corrupt(&vault, &sick);
        let dir = vault.dir().to_path_buf();
        drop(vault);
        fs::rename(
            blob_in(&dir.join("files"), &file),
            blob_in(&dir.join("files").join("orphaned"), &file),
        )
        .unwrap();
        let (vault, report) = reopen_dir(&dir);

        assert_eq!((report.orphans_restored, report.failed), (1, 0));
        assert_eq!(report.skipped_damaged, 1);
        assert!(vault.orphans().unwrap().is_empty());
        assert_eq!(exported(&parent, &vault, &id, &file), b"come home");
    }

    #[test]
    fn quarantine_never_replaces_a_blob_already_set_aside() {
        let (_parent, vault) = new_vault();
        let stray = plant_blob(&vault.files_dir(), b"new one");
        fs::write(blob_in(&vault.orphaned_dir(), &stray), b"older one").unwrap();
        let (vault, report) = reopen(vault);

        assert_eq!((report.orphans_quarantined, report.failed), (0, 1));
        assert_eq!(
            fs::read(blob_in(&vault.files_dir(), &stray)).unwrap(),
            b"new one"
        );
        assert_eq!(
            fs::read(blob_in(&vault.orphaned_dir(), &stray)).unwrap(),
            b"older one"
        );
    }

    #[test]
    fn a_cleanup_failure_does_not_fail_the_unlock() {
        let _disarm = Disarm;
        let (parent, mut vault) = new_vault();
        let (id, old, _new) = with_retired(&parent, &mut vault);
        let dir = vault.dir().to_path_buf();
        drop(vault);

        failpoint::arm("cleanup.delete_blob");
        let (vault, report) = Vault::unlock_with_password(&dir, PW).unwrap();
        failpoint::disarm_all();
        let report = report.cleanup;
        assert!(report.failed >= 1);
        assert_eq!(report.retired_deleted, 0);
        // The entry stays, so the next unlock tries again.
        assert_eq!(vault.get_item(&id).unwrap().retired_blobs, [old]);
        assert!(blob_in(&vault.files_dir(), &old).exists());

        let (vault, report) = reopen(vault);
        assert_eq!((report.retired_deleted, report.failed), (1, 0));
        assert!(!blob_in(&vault.files_dir(), &old).exists());
    }

    #[test]
    fn delete_orphans_removes_quarantine() {
        let (parent, mut vault) = new_vault();
        let (_id, kept) = file_item(&parent, &mut vault, b"mine");
        let (a, b) = (
            plant_blob(&vault.files_dir(), b"aaa"),
            plant_blob(&vault.files_dir(), b"bbbbb"),
        );
        let (mut vault, report) = reopen(vault);
        assert_eq!(report.orphans_quarantined, 2);
        let size = |id| {
            fs::metadata(blob_in(&vault.orphaned_dir(), id))
                .unwrap()
                .len()
        };
        let mut expected = vec![(a, size(&a)), (b, size(&b))];
        expected.sort();
        assert_eq!(vault.orphans().unwrap(), expected);

        // A blob that an item references is not deleted, even if it sits in the quarantine.
        fs::rename(
            blob_in(&vault.files_dir(), &kept),
            blob_in(&vault.orphaned_dir(), &kept),
        )
        .unwrap();
        assert_eq!(vault.delete_orphans().unwrap(), 2);
        let kept_len = fs::metadata(blob_in(&vault.orphaned_dir(), &kept))
            .unwrap()
            .len();
        assert_eq!(vault.orphans().unwrap(), [(kept, kept_len)]);
        assert!(!blob_in(&vault.orphaned_dir(), &a).exists());

        // Without a quarantine folder there is nothing to list or delete.
        fs::remove_dir_all(vault.orphaned_dir()).unwrap();
        assert!(vault.orphans().unwrap().is_empty());
        assert_eq!(vault.delete_orphans().unwrap(), 0);
    }

    /// Makes `link` a folder link (a junction on Windows, which needs no special rights; a
    /// symlink elsewhere) to `target`. On Windows a refusal fails the test; elsewhere it
    /// returns `false` with a note (symlinks can be forbidden there).
    fn make_dir_link(link: &Path, target: &Path) -> bool {
        #[cfg(windows)]
        let made = std::process::Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(link)
            .arg(target)
            .output()
            .is_ok_and(|o| o.status.success());
        #[cfg(not(windows))]
        let made = std::os::unix::fs::symlink(target, link).is_ok();
        #[cfg(windows)]
        assert!(made, "cannot create a junction on Windows");
        #[cfg(not(windows))]
        if !made {
            eprintln!("note: cannot create a folder link here; test skipped");
        }
        made
    }

    /// Replaces the folder `path` with a link to a folder outside the vault.
    fn link_folder(path: &Path, outside: &Path) -> bool {
        fs::remove_dir_all(path).unwrap();
        make_dir_link(path, outside)
    }

    #[test]
    fn std_reports_a_folder_link_as_a_link() {
        let (outside, inside) = (TempDir::new(), TempDir::new());
        let link = inside.path().join("link");
        if make_dir_link(&link, outside.path()) {
            let meta = fs::symlink_metadata(&link).unwrap();
            assert!(meta.file_type().is_symlink() && !meta.is_dir());
            assert!(check_folder(&link).is_err());
            assert!(check_folder(outside.path()).is_ok());
            assert!(check_folder(&inside.path().join("missing")).is_ok());
        }
    }

    #[test]
    fn linked_items_or_files_folder_is_left_alone() {
        for name in ["items", "files"] {
            let (_parent, vault) = new_vault();
            let outside = TempDir::new();
            let scraps = [
                outside.path().join("a.tmp"),
                outside.path().join("b.partial"),
            ];
            let stray = plant_blob(outside.path(), b"stray");
            for scrap in &scraps {
                fs::write(scrap, b"x").unwrap();
            }
            if !link_folder(&vault.dir().join(name), outside.path()) {
                return;
            }
            let (vault, report) = reopen(vault);

            assert!(report.failed >= 1, "{name}: {report:?}");
            assert_eq!(report.partials_removed + report.temps_removed, 0);
            assert_eq!(report.orphans_quarantined + report.orphans_restored, 0);
            assert!(scraps.iter().all(|p| p.exists()), "{name}: scraps removed");
            assert!(
                blob_in(outside.path(), &stray).exists(),
                "{name}: blob moved"
            );
            assert!(!outside.path().join("orphaned").exists());
            drop(vault);
        }
    }

    #[test]
    fn linked_orphaned_folder_is_left_alone() {
        let (parent, mut vault) = new_vault();
        let (_id, file) = file_item(&parent, &mut vault, b"mine");
        let outside = TempDir::new();
        let (theirs, scrap) = (
            plant_blob(outside.path(), b"theirs"),
            outside.path().join("x.partial"),
        );
        fs::write(&scrap, b"x").unwrap();
        let stray = plant_blob(&vault.files_dir(), b"stray");
        // A referenced blob that sits in the "quarantine" must not be moved back out of it either.
        fs::rename(
            blob_in(&vault.files_dir(), &file),
            blob_in(outside.path(), &file),
        )
        .unwrap();
        if !link_folder(&vault.orphaned_dir(), outside.path()) {
            return;
        }
        let (mut vault, report) = reopen(vault);

        assert!(report.failed >= 1);
        assert_eq!(
            (report.orphans_quarantined, report.orphans_restored),
            (0, 0)
        );
        assert!(
            blob_in(&vault.files_dir(), &stray).exists(),
            "stray was moved through the link"
        );
        assert!(!blob_in(&vault.files_dir(), &file).exists());
        assert!(vault.orphans().is_err());
        assert!(vault.delete_orphans().is_err());
        assert!(blob_in(outside.path(), &theirs).exists() && scrap.exists());
        assert!(blob_in(outside.path(), &file).exists());
    }

    #[test]
    fn purge_keeps_a_blob_another_item_still_attaches() {
        let _disarm = Disarm;
        let (parent, mut vault) = new_vault();
        let (doomed, shared) = file_item(&parent, &mut vault, b"shared bytes");
        let keeper = vault.new_item(ItemKind::Note, "keeper", None).unwrap();
        let mut next = edited(vault.get_item(&keeper).unwrap()).unwrap();
        next.attachments = vault.get_item(&doomed).unwrap().attachments.clone();
        vault.commit_item(next).unwrap();
        vault.trash_item(&doomed).unwrap();
        failpoint::arm("purge.after_mark");
        assert!(vault.purge_item(&doomed).is_err());
        failpoint::disarm_all();
        let (vault, report) = reopen(vault);

        assert_eq!((report.purges_finished, report.failed), (1, 0));
        assert!(vault.get_item(&doomed).is_err());
        assert!(!item_file(&vault, &doomed).exists());
        assert!(blob_in(&vault.files_dir(), &shared).exists());
        assert_eq!(exported(&parent, &vault, &keeper, &shared), b"shared bytes");

        // The same holds for a purge the user starts.
        let (mut vault, _) = reopen(vault);
        let (other, shared2) = file_item(&parent, &mut vault, b"again");
        let keeper2 = vault.new_item(ItemKind::Note, "keeper2", None).unwrap();
        let mut next = edited(vault.get_item(&keeper2).unwrap()).unwrap();
        next.attachments = vault.get_item(&other).unwrap().attachments.clone();
        vault.commit_item(next).unwrap();
        vault.trash_item(&other).unwrap();
        vault.purge_item(&other).unwrap();
        assert_eq!(exported(&parent, &vault, &keeper2, &shared2), b"again");
    }

    /// A trashed file item, ready for the user to purge.
    fn trashed_file_item(parent: &TempDir, vault: &mut Vault) -> (ItemId, FileId) {
        let (id, file) = file_item(parent, vault, b"bye");
        vault.trash_item(&id).unwrap();
        (id, file)
    }

    #[test]
    fn purge_refuses_a_linked_files_folder() {
        let (parent, mut vault) = new_vault();
        let (id, file) = trashed_file_item(&parent, &mut vault);
        let outside = TempDir::new();
        let quarantine = outside.path().join("orphaned");
        fs::create_dir(&quarantine).unwrap();
        fs::rename(
            blob_in(&vault.files_dir(), &file),
            blob_in(outside.path(), &file),
        )
        .unwrap();
        fs::copy(blob_in(outside.path(), &file), blob_in(&quarantine, &file)).unwrap();
        if !link_folder(&vault.files_dir(), outside.path()) {
            return;
        }

        assert!(vault.purge_item(&id).is_err());
        assert!(blob_in(outside.path(), &file).exists());
        assert!(blob_in(&quarantine, &file).exists());
        assert!(vault.get_item(&id).unwrap().purging);
    }

    #[test]
    fn purge_refuses_a_linked_orphaned_folder() {
        let (parent, mut vault) = new_vault();
        let (id, file) = trashed_file_item(&parent, &mut vault);
        let outside = TempDir::new();
        let theirs = plant_blob(outside.path(), b"theirs");
        if !link_folder(&vault.orphaned_dir(), outside.path()) {
            return;
        }

        assert!(vault.purge_item(&id).is_err());
        assert!(blob_in(outside.path(), &theirs).exists());
        assert!(blob_in(&vault.files_dir(), &file).exists());
        assert!(vault.get_item(&id).unwrap().purging);
    }

    #[test]
    fn orphan_calls_refuse_a_linked_files_folder() {
        let (_parent, mut vault) = new_vault();
        let outside = TempDir::new();
        let quarantine = outside.path().join("orphaned");
        fs::create_dir(&quarantine).unwrap();
        let theirs = plant_blob(&quarantine, b"not ours");
        if !link_folder(&vault.files_dir(), outside.path()) {
            return;
        }
        // Not through `reopen`: cleanup would already refuse; this is the later calls.
        assert!(vault.orphans().is_err());
        assert!(vault.delete_orphans().is_err());
        assert!(blob_in(&quarantine, &theirs).exists());
    }
}
