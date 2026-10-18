//! Restore, part 1 (spec 6.8 steps 1 to 4): unlock the backup, choose the destination and
//! extract into a hidden staging folder, with every check done.

use super::cleanup::{ORPHANED_DIR, check_folder};
use super::files::FILES_DIR;
use super::folder_name;
use super::items::ITEMS_DIR;
use super::journal::{
    IN_PROGRESS, JournalStep, RESTORE_JOURNAL_VERSION, RestoreJournal, create_journal,
    is_pre_restore_name, journal_exists, new_staging_path, plain_absolute, remove_journal_if_owner,
    remove_staging_then_journal, validate_journal,
};
use super::source::{
    VaultSource, attached_blobs, attached_refs, check_listed, check_opened, copy_blob,
    manifest_hashes, unlock_source,
};
use super::unlock::{Credential, load};
use crate::archive::{BackupArchive, EntryKind, copy_hashed};
use crate::blob::CancelToken;
use crate::fsio::{
    DESTINATION_EXISTS, atomic_write, check_space, open_shared_read, read_retry, set_hidden,
    sync_dir, volume_info,
};
use crate::header::{HEADER_BACKUP, HEADER_FILE, MAX_HEADER_BYTES};
use crate::ids::{FileId, VaultId};
use crate::item::FileRef;
use crate::{CoreError, Result};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

const BAD_PATH: CoreError = CoreError::InvalidInput {
    what: "restore path",
};
const SEVERAL_COPIES: CoreError = CoreError::InvalidInput {
    what: "several copies of this vault",
};

/// A backup that is unlocked, checked and extracted into a hidden staging folder beside its
/// destination, ready to be swapped in. Dropping it discards the staging folder.
pub struct PreparedRestore {
    /// Held open (read-only) until the restore is done, so the backup cannot change meanwhile.
    archive: VaultSource,
    staging: PathBuf,
    /// The folder the restored vault takes: `existing`, or a new `<name>-<short id>`.
    #[allow(dead_code)] // read by the swap step
    target: PathBuf,
    existing: Option<PathBuf>,
    journal: PathBuf,
    name: String,
    vault_id: VaultId,
    armed: bool,
}

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
        // A link is not a folder here (`file_type` does not follow it), nor is any other
        // reparse point (`check_folder`).
        if name.starts_with('.') || is_pre_restore_name(&name) || !entry.file_type()?.is_dir() {
            continue;
        }
        let dir = entry.path();
        if check_folder(&dir).is_err() {
            continue;
        }
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

/// Test hook: once an entry is written, closed and synced, flips one data byte of it, so the
/// read-back that follows must catch it.
#[cfg(test)]
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
    /// and the destination. Only then is the journal written (before the staging folder
    /// exists) and the backup extracted into `parent/.restore-<hex>`, each entry hashed
    /// against the manifest as it is written and again as it is read back from disk, each blob
    /// authenticated as it is written. Any error after the journal removes the staging folder
    /// and then the journal.
    pub fn prepare(
        archive: &Path,
        parent: &Path,
        credential: Credential,
        journal: &Path,
        cancel: &CancelToken,
    ) -> Result<PreparedRestore> {
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
        let target = match &existing {
            Some(dir) => dir.clone(),
            None => {
                let target = parent.join(folder_name(&name, &vault_id));
                match fs::symlink_metadata(&target) {
                    Ok(_) => return Err(DESTINATION_EXISTS),
                    Err(e) if e.kind() == ErrorKind::NotFound => target,
                    Err(e) => return Err(e.into()),
                }
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
        #[cfg(test)]
        crate::fsio::failpoint::check("restore.before_journal")?;
        // Fails, touching nothing, if another restore published its journal meanwhile.
        create_journal(journal, &entry)?;
        // Until the folder exists it is not ours to remove: whatever is at that path stays, and
        // only this operation's journal goes.
        let created: Result<()> = (|| {
            #[cfg(test)]
            crate::fsio::failpoint::check("restore.before_staging")?;
            Ok(fs::create_dir(&staging)?)
        })();
        if let Err(e) = created {
            let _ = remove_journal_if_owner(journal, &staging);
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
            #[cfg(test)]
            corrupt_if_armed(&path)?;
            let hash = copy_hashed(
                &mut open_shared_read(&path)?,
                e.size,
                &mut io::sink(),
                cancel,
            )?;
            check_listed(&listed, &e.name, hash)?;
            #[cfg(test)]
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
}

impl Drop for PreparedRestore {
    fn drop(&mut self) {
        if self.armed {
            let _ = remove_staging_then_journal(&self.staging, &self.journal);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::testkit::{
        ManifestMode, central_offset, patch, resize_entry, rewrite_backup,
    };
    use crate::fsio::testutil::{TempDir, make_dir_link, names};
    use crate::fsio::{VolumeInfo, failpoint, set_volume_override};
    use crate::item::ItemKind;
    use crate::vault::folder_name;
    use crate::vault::journal::{
        JournalStep, RESTORE_JOURNAL_VERSION, RestoreJournal, plain_absolute, read_journal,
        write_journal,
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
            PreparedRestore::prepare(archive, self.parent(), credential, &self.journal(), cancel)
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
                let p = PreparedRestore::prepare(&archive, &parent, credential, &journal, &cancel);
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

        let result = d.prepare(&backup, Credential::Password(PW));
        assert!(matches!(error(result), CoreError::Io(_)));
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
        let result =
            PreparedRestore::prepare(&backup, &odd, credential, &d.journal(), &CancelToken::new());
        match result {
            Err(e) => {
                assert!(matches!(
                    e,
                    CoreError::InvalidInput {
                        what: "restore path"
                    }
                ));
                d.assert_not_written();
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
}
