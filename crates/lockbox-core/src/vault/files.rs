//! Files stored in the vault (spec 5.5, 6.4, 7.2): import as an encrypted blob, replace,
//! save a decrypted copy, and purge.
//!
//! The item file is the commit point. A blob is written and published first, then the item
//! that points to it; a crash or error in between leaves an unreferenced blob, which the
//! cleanup at unlock sets aside. Nothing is ever deleted inline except by `purge_item`,
//! which first records its intent in the item, and by a failed item copy
//! (`copy_item_from`), which removes from `files/` (never the quarantine) the blobs it
//! published itself, none of which any item has ever referenced, and only when its new item
//! is certainly not in the vault.

use super::Vault;
use super::items::{BEING_DELETED, blank_item, edited};
use super::source::FILE_MISSING;
use crate::blob::{
    CancelToken, OutputJournal, blob_len, check_length, decrypt_stream, encrypt_stream,
    new_file_ref,
};
use crate::fsio::{
    check_space, clear_hidden, create_hidden_file, hidden_temp_path, parent_dir, remove_file_retry,
    replace_file, volume_info,
};
use crate::ids::{FileId, ItemId, VaultId};
use crate::item::{FileRef, Item, ItemKind};
use crate::{CoreError, Result};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};

pub(super) const FILES_DIR: &str = "files";
pub(super) const BLOB_EXT: &str = ".blob";
// shortcut: every file is labelled "application/octet-stream" (no MIME table); upgrade when
// Plan 3 decides how files are opened and shown.
const MEDIA_TYPE: &str = "application/octet-stream";
const NOT_FILE_HOLDER: CoreError = CoreError::InvalidInput {
    what: "item cannot hold files",
};

/// Where the blob `id` lives (or would live) inside the folder `folder`.
pub(super) fn blob_in(folder: &Path, id: &FileId) -> PathBuf {
    folder.join(format!("{}{BLOB_EXT}", id.to_hex()))
}

/// Every attachment of `items`, once each, sorted by ID.
pub(super) fn attachments<'a>(
    items: impl Iterator<Item = &'a Item>,
) -> BTreeMap<FileId, &'a FileRef> {
    items
        .flat_map(|i| &i.attachments)
        .map(|f| (f.file_id, f))
        .collect()
}

/// Refuses an output folder that is the vault folder `dir` or inside it. Both paths are
/// resolved first (links, junctions, `..`, short names), so an alias cannot get past the check.
pub(super) fn refuse_inside(folder: &Path, dir: &Path) -> Result<()> {
    if fs::canonicalize(folder)?.starts_with(fs::canonicalize(dir)?) {
        return Err(CoreError::InvalidInput {
            what: "destination inside vault",
        });
    }
    Ok(())
}

/// Refuses an export whose decrypted copy would not fit beside `dest`. Checked before the blob
/// is opened.
pub(super) fn check_export_space(fref: &FileRef, dest: &Path) -> Result<()> {
    check_space(fref.length, fref.length, &volume_info(parent_dir(dest))?)
}

/// The verify-then-publish half of an export, shared by [`Vault`] and the read-only vault: the
/// decrypted copy is built in a hidden temp file beside `dest`, and an existing `dest` is
/// replaced only once every chunk has authenticated. The caller has refused a `dest` that must
/// not be written and has checked the space. The temp is recorded in `journal` before it exists.
pub(super) fn export_blob(
    blob: &mut impl Read,
    blob_size: u64,
    vault_id: &VaultId,
    fref: &FileRef,
    dest: &Path,
    journal: &dyn OutputJournal,
    cancel: &CancelToken,
) -> Result<()> {
    let temp = hidden_temp_path(parent_dir(dest), ".lockbox-partial");
    journal.record(&temp);
    // Owned only once this succeeds; if the name is taken, the other file is not ours to delete.
    let mut out = match create_hidden_file(&temp) {
        Ok(out) => out,
        Err(error) => {
            journal.clear(&temp);
            return Err(error);
        }
    };
    let published = (|| {
        decrypt_stream(blob, blob_size, &mut out, vault_id, fref, cancel)?;
        out.sync_all()?;
        drop(out);
        // Windows keeps a file's attributes when it replaces another: unhide first.
        clear_hidden(&temp)?;
        #[cfg(any(test, feature = "test-internals"))]
        crate::fsio::failpoint::check("export.before_publish")?;
        // Last chance to stop: once the rename starts, publication completes.
        cancel.check()?;
        replace_file(&temp, dest)
    })();
    // Only a temp that is really gone leaves the journal; otherwise launch cleanup retries.
    if published.is_ok() || remove_file_retry(&temp).is_ok() {
        journal.clear(&temp);
    }
    published
}

/// Opens the file to import and returns it with its size. On Windows other programs may
/// still read it but none can write to it while it is open.
fn open_source(path: &Path) -> Result<(File, u64)> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 1;
        options.share_mode(FILE_SHARE_READ);
    }
    let file = options.open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(CoreError::InvalidInput { what: "not a file" });
    }
    Ok((file, meta.len()))
}

impl Vault {
    fn blob_path(&self, id: &FileId) -> PathBuf {
        blob_in(&self.dir.join(FILES_DIR), id)
    }

    /// The item as it is now, if it may take part in a file change: it exists, is not in
    /// the trash (or being purged) and is not a collection.
    fn file_holder(&self, id: &ItemId) -> Result<&Item> {
        let item = self.get_item(id)?;
        if item.purging {
            return Err(BEING_DELETED);
        }
        if item.trashed_at.is_some() || matches!(item.kind, ItemKind::Collection) {
            return Err(NOT_FILE_HOLDER);
        }
        Ok(item)
    }

    /// Encrypts the file at `src` into a published blob and returns its record. The blob is
    /// not referenced by any item yet.
    fn import_file(&self, src: &Path, cancel: &CancelToken) -> Result<FileRef> {
        let name = src
            .file_name()
            .ok_or(CoreError::InvalidInput { what: "file name" })?
            .to_string_lossy()
            .into_owned();
        let (mut file, len) = open_source(src)?;
        let fref = self.import_stream(&mut file, len, name, cancel)?;
        #[cfg(any(test, feature = "test-internals"))]
        crate::fsio::failpoint::check("import.before_item_write")?;
        // A cancel here leaves the published blob as an orphan (cleanup sets it aside), no item.
        cancel.check()?;
        Ok(fref)
    }

    /// The blob side of an import (spec 6.4): `files/<id>.blob.partial`, flushed, then renamed
    /// to `files/<id>.blob`. Space and size limits are checked before anything is written.
    fn import_stream(
        &self,
        src: &mut impl Read,
        declared_len: u64,
        name: String,
        cancel: &CancelToken,
    ) -> Result<FileRef> {
        self.import_stream_tracked(src, declared_len, name, cancel, &mut Vec::new())
    }

    /// [`import_stream`](Self::import_stream) for a caller that must know which blob it may have
    /// published even when this returns an error (a rename can succeed and a later step of the
    /// publication fail). The new blob's ID is pushed to `published` just before the rename, so
    /// it is there on every outcome that may have left the blob in `files/`; a blob that was
    /// never renamed is not there to delete, which is a no-op for the caller.
    pub(super) fn import_stream_tracked(
        &self,
        src: &mut impl Read,
        declared_len: u64,
        name: String,
        cancel: &CancelToken,
        published: &mut Vec<FileId>,
    ) -> Result<FileRef> {
        check_length(declared_len)?;
        let dir = self.dir.join(FILES_DIR);
        fs::create_dir_all(&dir)?;
        let needed = blob_len(declared_len);
        check_space(needed, needed, &volume_info(&dir)?)?;
        // A fresh ID, so a broken random source can never replace an existing blob.
        let fref = loop {
            let fref = new_file_ref(declared_len, name.clone(), MEDIA_TYPE.to_owned());
            if !self.blob_path(&fref.file_id).try_exists()? {
                break fref;
            }
        };
        let partial = dir.join(format!("{}.blob.partial", fref.file_id.to_hex()));
        // Owned only once this succeeds; if the name is taken, nothing is removed.
        let mut out = File::create_new(&partial)?;
        let written = (|| {
            let vault_id = &self.header.vault_id;
            encrypt_stream(src, declared_len, &mut out, vault_id, &fref, cancel)?;
            out.sync_all()?;
            drop(out); // Windows cannot move a file that is still open.
            #[cfg(any(test, feature = "test-internals"))]
            crate::fsio::failpoint::check("import.before_publish")?;
            // Last chance to stop: once the rename starts, publication completes.
            cancel.check()?;
            published.push(fref.file_id);
            replace_file(&partial, &self.blob_path(&fref.file_id))?;
            #[cfg(any(test, feature = "test-internals"))]
            crate::fsio::failpoint::check("import.after_publish")?;
            Ok(())
        })();
        if let Err(error) = written {
            let _ = remove_file_retry(&partial);
            return Err(error);
        }
        Ok(fref)
    }

    /// Encrypts the file at `src` and attaches it to the item. Returns the new file's ID.
    pub fn attach_file(
        &mut self,
        item: &ItemId,
        src: &Path,
        cancel: &CancelToken,
    ) -> Result<FileId> {
        let mut next = edited(self.file_holder(item)?)?;
        let fref = self.import_file(src, cancel)?;
        let id = fref.file_id;
        next.attachments.push(fref);
        self.commit_item(next)?;
        Ok(id)
    }

    /// Adds a file item named after the file at `src`, holding that file.
    pub fn new_file_item(
        &mut self,
        collection: Option<ItemId>,
        src: &Path,
        cancel: &CancelToken,
    ) -> Result<ItemId> {
        let id = self.fresh_item_id()?;
        self.check_collection(&id, &ItemKind::File, collection, None)?;
        let fref = self.import_file(src, cancel)?;
        let mut item = blank_item(id, ItemKind::File, &fref.name, collection);
        item.attachments.push(fref);
        self.commit_item(item)?;
        Ok(id)
    }

    /// Swaps the attachment `old` of the item for the file at `src`. The old blob stays on
    /// disk, listed in the item's `retired_blobs`, until cleanup removes it.
    pub fn replace_attachment(
        &mut self,
        item: &ItemId,
        old: &FileId,
        src: &Path,
        cancel: &CancelToken,
    ) -> Result<FileId> {
        let mut next = edited(self.file_holder(item)?)?;
        let slot = next
            .attachments
            .iter()
            .position(|f| f.file_id == *old)
            .ok_or(CoreError::NotFound)?;
        let fref = self.import_file(src, cancel)?;
        let id = fref.file_id;
        next.attachments[slot] = fref;
        next.retired_blobs.push(*old);
        self.commit_item(next)?;
        Ok(id)
    }

    /// Saves a decrypted copy of an attachment at `dest`: verify fully, then publish. The
    /// copy is built in a hidden temp file beside `dest`; an existing `dest` is replaced only
    /// once every chunk has authenticated. The temp is recorded in `journal` before it exists.
    pub fn export_file(
        &self,
        item: &ItemId,
        file: &FileId,
        dest: &Path,
        journal: &dyn OutputJournal,
        cancel: &CancelToken,
    ) -> Result<()> {
        let fref = self
            .get_item(item)?
            .attachments
            .iter()
            .find(|f| f.file_id == *file)
            .ok_or(CoreError::NotFound)?;
        refuse_inside(parent_dir(dest), &self.dir)?;
        check_export_space(fref, dest)?;
        let mut blob = File::open(self.blob_path(file)).map_err(|e| match e.kind() {
            ErrorKind::NotFound => FILE_MISSING,
            _ => e.into(),
        })?;
        let blob_size = blob.metadata()?.len();
        export_blob(
            &mut blob,
            blob_size,
            &self.header.vault_id,
            fref,
            dest,
            journal,
            cancel,
        )
    }

    /// Permanently deletes a trashed item and its blobs, except a blob another item still
    /// attaches (spec 6.4): the item is first
    /// rewritten with `purging: true`, so a crash or error leaves an intent that a retry (or
    /// cleanup at unlock) finishes. Blobs are deleted from the quarantine too; a blob that is
    /// already gone is fine.
    pub fn purge_item(&mut self, id: &ItemId) -> Result<()> {
        let stored = self.get_item(id)?;
        if stored.trashed_at.is_none() {
            return Err(CoreError::InvalidInput {
                what: "not in trash",
            });
        }
        if !stored.purging {
            let mut marked = edited(stored)?;
            marked.purging = true;
            self.commit_item(marked)?;
        }
        #[cfg(any(test, feature = "test-internals"))]
        crate::fsio::failpoint::check("purge.after_mark")?;
        let item = self.get_item(id)?;
        // A blob that another item still attaches is not this item's to delete.
        let in_use = self.attached_blobs(Some(id));
        let blobs = item.attachments.iter().map(|f| &f.file_id);
        for blob in blobs
            .chain(&item.retired_blobs)
            .filter(|b| !in_use.contains(b))
        {
            self.delete_blob_everywhere(blob)?;
        }
        remove_file_retry(&self.item_path(id))?;
        self.items.remove(id);
        self.reindex();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blob::MAX_FILE_BYTES;
    use crate::fsio::{VolumeInfo, failpoint, set_volume_override, testutil::TempDir};
    use std::fs;
    use std::io::Cursor;
    use std::path::PathBuf;

    const PW: &str = "correct horse battery";
    const MIB: u64 = 1_048_576;
    const GIB: u64 = 1024 * MIB;

    fn new_vault() -> (TempDir, Vault) {
        let parent = TempDir::new();
        let vault = Vault::create(parent.path(), "Family", PW).unwrap().vault;
        (parent, vault)
    }

    fn source(parent: &TempDir, name: &str, bytes: &[u8]) -> PathBuf {
        let path = parent.path().join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    /// Names in the vault's `files` folder (not the `orphaned` folder).
    fn blob_files(vault: &Vault) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(vault.dir().join("files"))
            .unwrap()
            .map(|e| e.unwrap())
            .filter(|e| e.file_type().unwrap().is_file())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn blob_path(vault: &Vault, id: &FileId) -> PathBuf {
        vault
            .dir()
            .join("files")
            .join(format!("{}.blob", id.to_hex()))
    }

    /// Always disarms, so a failing test cannot leak a failpoint or volume into the next one on this thread.
    struct Cleanup;
    impl Drop for Cleanup {
        fn drop(&mut self) {
            failpoint::disarm_all();
            set_volume_override(None);
        }
    }

    #[test]
    fn commit_order() {
        let _cleanup = Cleanup;
        let (parent, mut vault) = new_vault();
        let src = source(&parent, "a.txt", b"hello");
        failpoint::arm("import.before_item_write");
        let result = vault.new_file_item(None, &src, &CancelToken::new());
        failpoint::disarm_all();
        assert!(matches!(result, Err(CoreError::Io(_))));
        assert_eq!(vault.items().count(), 0, "no item");
        let files = blob_files(&vault);
        assert_eq!(files.len(), 1, "the published blob stays as an orphan");
        assert!(files[0].ends_with(".blob") && !files[0].ends_with(".partial"));
        assert!(
            fs::read_dir(vault.dir().join("items"))
                .unwrap()
                .next()
                .is_none()
        );
    }

    #[test]
    fn failed_attach_leaves_the_item_as_it_was() {
        let _cleanup = Cleanup;
        let (parent, mut vault) = new_vault();
        let id = vault.new_item(ItemKind::Note, "n", None).unwrap();
        let src = source(&parent, "a.txt", b"hello");
        failpoint::arm("import.before_item_write");
        let result = vault.attach_file(&id, &src, &CancelToken::new());
        failpoint::disarm_all();
        assert!(result.is_err());
        let item = vault.get_item(&id).unwrap();
        assert!(item.attachments.is_empty());
        assert_eq!(item.revision, 0);
    }

    #[test]
    fn purge_marks_then_deletes() {
        let _cleanup = Cleanup;
        let (parent, mut vault) = new_vault();
        let first = source(&parent, "a.bin", b"first");
        let second = source(&parent, "b.bin", b"second");
        let id = vault
            .new_file_item(None, &first, &CancelToken::new())
            .unwrap();
        let old = vault.get_item(&id).unwrap().attachments[0].file_id;
        let new = vault
            .replace_attachment(&id, &old, &second, &CancelToken::new())
            .unwrap();
        assert!(blob_path(&vault, &old).exists() && blob_path(&vault, &new).exists());

        // Not in the trash: refused, nothing touched.
        assert!(matches!(
            vault.purge_item(&id),
            Err(CoreError::InvalidInput {
                what: "not in trash"
            })
        ));
        assert!(!vault.get_item(&id).unwrap().purging);

        vault.trash_item(&id).unwrap();
        failpoint::arm("purge.after_mark");
        let result = vault.purge_item(&id);
        failpoint::disarm_all();
        assert!(result.is_err());
        let item = vault.get_item(&id).unwrap();
        assert!(item.purging, "the intent is recorded first");
        assert!(
            blob_path(&vault, &new).exists(),
            "no blob deleted before the mark"
        );

        // A retry finishes the job, even from the marked state.
        vault.purge_item(&id).unwrap();
        assert!(matches!(vault.get_item(&id), Err(CoreError::NotFound)));
        assert!(blob_files(&vault).is_empty(), "both blobs gone");
        assert!(!vault.item_path(&id).exists());
    }

    #[test]
    fn purge_survives_a_missing_blob() {
        let (parent, mut vault) = new_vault();
        let src = source(&parent, "a.bin", b"x");
        let id = vault
            .new_file_item(None, &src, &CancelToken::new())
            .unwrap();
        let file = vault.get_item(&id).unwrap().attachments[0].file_id;
        fs::remove_file(blob_path(&vault, &file)).unwrap();
        vault.trash_item(&id).unwrap();
        vault.purge_item(&id).unwrap();
        assert!(matches!(vault.get_item(&id), Err(CoreError::NotFound)));
    }

    /// Panics if read: proves a refusal happens before any source I/O.
    struct NoRead;
    impl Read for NoRead {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            panic!("source read")
        }
    }

    fn volume(free_bytes: Option<u64>, max_file_bytes: Option<u64>) -> Option<VolumeInfo> {
        Some(VolumeInfo {
            free_bytes,
            max_file_bytes,
        })
    }

    #[test]
    fn space_checked_before_any_write() {
        let _cleanup = Cleanup;
        let (parent, mut vault) = new_vault();
        let src = source(&parent, "a.txt", b"hello");

        // Too little free space.
        set_volume_override(volume(Some(MIB), None));
        let result = vault.new_file_item(None, &src, &CancelToken::new());
        assert!(matches!(result, Err(CoreError::NotEnoughSpace { .. })));
        assert!(blob_files(&vault).is_empty(), "no .partial or .blob");
        assert_eq!(vault.items().count(), 0);

        // 5 GiB into a FAT32-style volume: refused without reading a byte.
        set_volume_override(volume(Some(100 * GIB), Some(4 * GIB - 1)));
        let result = vault.import_stream(&mut NoRead, 5 * GIB, "big".into(), &CancelToken::new());
        assert!(matches!(result, Err(CoreError::FileSystemLimit { .. })));
        assert!(blob_files(&vault).is_empty());

        // Export of a 5 GiB file to a FAT32-style destination.
        set_volume_override(None);
        let id = vault
            .new_file_item(None, &src, &CancelToken::new())
            .unwrap();
        let item = vault.items.get_mut(&id).unwrap();
        item.attachments[0].length = 5 * GIB;
        item.attachments[0].chunk_count = crate::blob::chunk_count(5 * GIB);
        let file = item.attachments[0].file_id;
        let dest = parent.path().join("out.bin");
        fs::write(&dest, b"OLD").unwrap();
        set_volume_override(volume(Some(100 * GIB), Some(4 * GIB - 1)));
        let result = vault.export_file(
            &id,
            &file,
            &dest,
            &crate::blob::NoJournal,
            &CancelToken::new(),
        );
        assert!(matches!(result, Err(CoreError::FileSystemLimit { .. })));
        assert_eq!(fs::read(&dest).unwrap(), b"OLD", "destination untouched");
        let leftovers = fs::read_dir(parent.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".lockbox-partial"))
            .count();
        assert_eq!(leftovers, 0, "no temp file");

        // Export with too little space.
        set_volume_override(volume(Some(MIB), None));
        let result = vault.export_file(
            &id,
            &file,
            &dest,
            &crate::blob::NoJournal,
            &CancelToken::new(),
        );
        assert!(matches!(result, Err(CoreError::NotEnoughSpace { .. })));
    }

    #[test]
    fn file_over_256_gib_rejected_without_io() {
        let _cleanup = Cleanup;
        let (_parent, vault) = new_vault();
        set_volume_override(volume(Some(u64::MAX), None));
        let result = vault.import_stream(
            &mut NoRead,
            MAX_FILE_BYTES + 1,
            "huge".into(),
            &CancelToken::new(),
        );
        assert!(matches!(result, Err(CoreError::TooLarge { .. })));
        assert!(blob_files(&vault).is_empty());
    }

    /// Claims fewer bytes than it then delivers: a file that grows during import.
    struct Growing(Cursor<Vec<u8>>);
    impl Read for Growing {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.0.read(buf)
        }
    }

    #[test]
    fn source_size_change_fails_cleanly() {
        let (_parent, vault) = new_vault();
        let cancel = CancelToken::new();
        // Declared 2 MiB, source yields only 1 MiB.
        let mut short = Growing(Cursor::new(vec![7u8; MIB as usize]));
        let result = vault.import_stream(&mut short, 2 * MIB, "a".into(), &cancel);
        assert!(matches!(
            result,
            Err(CoreError::InvalidInput {
                what: "source size changed"
            })
        ));
        // Declared 1 MiB, source delivers one byte more.
        let mut long = Growing(Cursor::new(vec![7u8; MIB as usize + 1]));
        let result = vault.import_stream(&mut long, MIB, "a".into(), &cancel);
        assert!(matches!(
            result,
            Err(CoreError::InvalidInput {
                what: "source size changed"
            })
        ));
        assert!(blob_files(&vault).is_empty(), "no .partial or .blob left");
    }

    /// Names that Windows cannot hold as file names (`:` `?`, 300 characters) still reach the
    /// item intact, so a file imported on another system keeps its name.
    #[test]
    fn odd_names_preserved() {
        let (parent, mut vault) = new_vault();
        let long = "\u{e9}".repeat(300);
        let names = ["Q3 report: final?.pdf", long.as_str(), "README"];
        let mut ids = Vec::new();
        for name in names {
            let mut data = Cursor::new(b"x".to_vec());
            let fref = vault
                .import_stream(&mut data, 1, name.to_owned(), &CancelToken::new())
                .unwrap();
            let id = vault.fresh_item_id().unwrap();
            let mut item = blank_item(id, ItemKind::File, name, None);
            item.attachments.push(fref);
            vault.commit_item(item).unwrap();
            ids.push(id);
        }
        let dir = vault.dir().to_path_buf();
        drop(vault);
        let vault = Vault::unlock_with_password(&dir, PW).unwrap().0;
        for (id, name) in ids.iter().zip(names) {
            let item = vault.get_item(id).unwrap();
            assert_eq!(item.attachments[0].name, name);
            let dest = parent.path().join(format!("out-{}", id.to_hex()));
            let file = item.attachments[0].file_id;
            let journal = crate::blob::NoJournal;
            vault
                .export_file(id, &file, &dest, &journal, &CancelToken::new())
                .unwrap();
            assert_eq!(fs::read(&dest).unwrap(), b"x");
        }
    }

    #[test]
    fn cancelled_import_leaves_nothing() {
        let (parent, mut vault) = new_vault();
        let src = source(&parent, "a.txt", b"hello");
        let cancel = CancelToken::new();
        cancel.cancel();
        let result = vault.new_file_item(None, &src, &cancel);
        assert!(matches!(result, Err(CoreError::Cancelled)));
        assert!(blob_files(&vault).is_empty());
        assert_eq!(vault.items().count(), 0);
    }

    #[cfg(windows)]
    #[test]
    fn source_is_locked_against_writers_during_import() {
        let parent = TempDir::new();
        let src = source(&parent, "a.txt", b"hello");
        let (_held, len) = open_source(&src).unwrap();
        assert_eq!(len, 5);
        assert!(fs::OpenOptions::new().write(true).open(&src).is_err());
    }

    // ---- review fixes (round 1) ----

    use crate::blob::{NoJournal, OutputJournal, force_next_file_id};
    use crate::fsio::force_next_temp_name;
    use std::cell::RefCell;

    /// Remembers every journal call, in order.
    #[derive(Default)]
    struct Recorder(RefCell<Vec<(&'static str, PathBuf)>>);

    impl OutputJournal for Recorder {
        fn record(&self, temp: &Path) {
            self.0.borrow_mut().push(("record", temp.to_path_buf()));
        }
        fn clear(&self, temp: &Path) {
            self.0.borrow_mut().push(("clear", temp.to_path_buf()));
        }
    }

    fn file_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// A vault holding one file item, plus a folder to export into.
    fn vault_with_file() -> (TempDir, Vault, ItemId, FileId) {
        let (parent, mut vault) = new_vault();
        let src = source(&parent, "a.txt", b"hello");
        let id = vault
            .new_file_item(None, &src, &CancelToken::new())
            .unwrap();
        let file = vault.get_item(&id).unwrap().attachments[0].file_id;
        (parent, vault, id, file)
    }

    // A. A cancel that arrives after streaming still stops publication.

    #[test]
    fn cancel_before_import_publish_leaves_nothing() {
        let _cleanup = Cleanup;
        let (parent, mut vault) = new_vault();
        let src = source(&parent, "a.txt", b"hello");
        let cancel = CancelToken::new();
        failpoint::arm_cancel("import.before_publish", cancel.clone());
        let result = vault.new_file_item(None, &src, &cancel);
        assert!(matches!(result, Err(CoreError::Cancelled)));
        assert!(blob_files(&vault).is_empty(), "no .partial, no .blob");
        assert_eq!(vault.items().count(), 0);
    }

    #[test]
    fn cancel_before_item_commit_commits_no_item() {
        let _cleanup = Cleanup;
        let (parent, mut vault) = new_vault();
        let src = source(&parent, "a.txt", b"hello");
        let note = vault.new_item(ItemKind::Note, "n", None).unwrap();
        let cancel = CancelToken::new();
        failpoint::arm_cancel("import.before_item_write", cancel.clone());
        let result = vault.attach_file(&note, &src, &cancel);
        assert!(matches!(result, Err(CoreError::Cancelled)));
        let item = vault.get_item(&note).unwrap();
        assert!(item.attachments.is_empty() && item.revision == 0);

        let result = vault.new_file_item(None, &src, &cancel);
        assert!(matches!(result, Err(CoreError::Cancelled)));
        assert_eq!(vault.items().count(), 1, "no new item");
        // The blob had been published already: it stays as an orphan for cleanup. No .partial.
        let files = blob_files(&vault);
        assert!(!files.is_empty() && files.iter().all(|f| f.ends_with(".blob")));
    }

    #[test]
    fn cancel_before_export_publish_keeps_the_destination() {
        let _cleanup = Cleanup;
        let (parent, vault, id, file) = vault_with_file();
        let out = parent.path().join("out");
        fs::create_dir(&out).unwrap();
        let dest = out.join("a.txt");
        fs::write(&dest, b"OLD").unwrap();
        let cancel = CancelToken::new();
        failpoint::arm_cancel("export.before_publish", cancel.clone());
        let journal = Recorder::default();
        let result = vault.export_file(&id, &file, &dest, &journal, &cancel);
        assert!(matches!(result, Err(CoreError::Cancelled)));
        assert_eq!(fs::read(&dest).unwrap(), b"OLD");
        assert_eq!(file_names(&out), ["a.txt"], "no temp left");
        let calls = journal.0.borrow();
        assert_eq!(
            calls.iter().map(|c| c.0).collect::<Vec<_>>(),
            ["record", "clear"]
        );
    }

    // B. Only a temp this call created is ever removed.

    #[test]
    fn import_temp_collision_leaves_the_other_file_alone() {
        let _cleanup = Cleanup;
        let (parent, mut vault) = new_vault();
        let src = source(&parent, "a.txt", b"hello");
        let id = FileId([0x5A; 16]);
        let stale = vault
            .dir()
            .join("files")
            .join(format!("{}.blob.partial", id.to_hex()));
        fs::write(&stale, b"someone else's").unwrap();
        force_next_file_id(id);
        let result = vault.new_file_item(None, &src, &CancelToken::new());
        assert!(matches!(result, Err(CoreError::Io(_))));
        assert_eq!(fs::read(&stale).unwrap(), b"someone else's");
        assert_eq!(vault.items().count(), 0);
    }

    #[test]
    fn export_temp_collision_leaves_the_other_file_alone() {
        let _cleanup = Cleanup;
        let (parent, vault, id, file) = vault_with_file();
        let out = parent.path().join("out");
        fs::create_dir(&out).unwrap();
        let name = ".0123456789abcdef.lockbox-partial";
        fs::write(out.join(name), b"someone else's").unwrap();
        force_next_temp_name(name);
        let journal = Recorder::default();
        let dest = out.join("a.txt");
        let result = vault.export_file(&id, &file, &dest, &journal, &CancelToken::new());
        assert!(matches!(result, Err(CoreError::Io(_))));
        assert_eq!(fs::read(out.join(name)).unwrap(), b"someone else's");
        assert!(!dest.exists());
        let calls = journal.0.borrow();
        assert_eq!(
            calls.iter().map(|c| c.0).collect::<Vec<_>>(),
            ["record", "clear"]
        );
        assert_eq!(calls[0].1, out.join(name));
        assert_eq!(calls[1].1, out.join(name));
    }

    // C. An item being purged is frozen.

    fn being_deleted<T: std::fmt::Debug>(r: Result<T>) -> bool {
        matches!(
            r,
            Err(CoreError::InvalidInput {
                what: "being deleted"
            })
        )
    }

    #[test]
    fn purging_items_are_frozen_until_the_purge_is_retried() {
        let _cleanup = Cleanup;
        let (parent, mut vault, id, file) = vault_with_file();
        let src = source(&parent, "b.txt", b"b");
        vault.trash_item(&id).unwrap();
        failpoint::arm("purge.after_mark");
        assert!(vault.purge_item(&id).is_err());
        failpoint::disarm_all();
        assert!(vault.get_item(&id).unwrap().purging);

        let before = vault.get_item(&id).unwrap().revision;
        assert!(being_deleted(vault.restore_item(&id)));
        assert!(being_deleted(vault.trash_item(&id)));
        assert!(being_deleted(
            vault.update_item(vault.get_item(&id).unwrap().clone())
        ));
        let cancel = CancelToken::new();
        assert!(being_deleted(vault.attach_file(&id, &src, &cancel)));
        assert!(being_deleted(
            vault.replace_attachment(&id, &file, &src, &cancel)
        ));
        let item = vault.get_item(&id).unwrap();
        assert!(item.trashed_at.is_some() && item.purging && item.revision == before);

        vault.purge_item(&id).unwrap();
        assert!(matches!(vault.get_item(&id), Err(CoreError::NotFound)));
        assert!(blob_files(&vault).is_empty());
    }

    #[test]
    fn restoring_a_member_never_restores_a_purging_collection() {
        let _cleanup = Cleanup;
        let (_parent, mut vault) = new_vault();
        let collection = vault.new_item(ItemKind::Collection, "C", None).unwrap();
        let member = vault
            .new_item(ItemKind::Note, "m", Some(collection))
            .unwrap();
        vault.delete_collection(&collection).unwrap();
        failpoint::arm("purge.after_mark");
        assert!(vault.purge_item(&collection).is_err());
        failpoint::disarm_all();
        assert!(being_deleted(vault.restore_item(&member)));
        let c = vault.get_item(&collection).unwrap();
        assert!(c.trashed_at.is_some() && c.purging, "collection untouched");
        assert!(vault.get_item(&member).unwrap().trashed_at.is_some());
        vault.purge_item(&collection).unwrap();
    }

    #[test]
    fn missing_blob_and_too_little_space_is_a_space_error() {
        let _cleanup = Cleanup;
        let (parent, vault, id, file) = vault_with_file();
        fs::remove_file(blob_path(&vault, &file)).unwrap();
        let dest = parent.path().join("out.txt");
        let cancel = CancelToken::new();
        let result = vault.export_file(&id, &file, &dest, &NoJournal, &cancel);
        assert!(matches!(
            result,
            Err(CoreError::Damaged {
                what: "file missing"
            })
        ));
        set_volume_override(volume(Some(MIB), None));
        let result = vault.export_file(&id, &file, &dest, &NoJournal, &cancel);
        assert!(matches!(result, Err(CoreError::NotEnoughSpace { .. })));
    }

    // D. Export never writes into the vault itself.

    #[test]
    fn export_into_the_vault_is_refused() {
        let (_parent, vault, id, file) = vault_with_file();
        let blob = blob_path(&vault, &file);
        let header = vault.dir().join("vault.json");
        let (blob_before, header_before) = (fs::read(&blob).unwrap(), fs::read(&header).unwrap());
        let journal = Recorder::default();
        let aliased = vault.dir().join("files").join("..").join("vault.json");
        for dest in [&blob, &header, &aliased] {
            let result = vault.export_file(&id, &file, dest, &journal, &CancelToken::new());
            assert!(matches!(
                result,
                Err(CoreError::InvalidInput {
                    what: "destination inside vault"
                })
            ));
        }
        assert_eq!(fs::read(&blob).unwrap(), blob_before);
        assert_eq!(fs::read(&header).unwrap(), header_before);
        assert!(
            journal.0.borrow().is_empty(),
            "refused before any journal call"
        );
        assert!(
            file_names(vault.dir())
                .iter()
                .all(|n| !n.ends_with(".lockbox-partial"))
        );
        // Beside the vault folder is fine.
        let outside = vault.dir().parent().unwrap().join("copy.txt");
        vault
            .export_file(&id, &file, &outside, &NoJournal, &CancelToken::new())
            .unwrap();
        assert_eq!(fs::read(&outside).unwrap(), b"hello");
    }
}
