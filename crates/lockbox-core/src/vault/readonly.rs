//! Read-only vaults (spec 6.9): a backup archive or a `.before-restore` folder opened to look
//! at its items and copy files out of it. No method changes the source (the folder or the
//! backup): exports write only a decrypted copy, to a place the caller picks. Opening takes no
//! lock and repairs, cleans and creates nothing, so a folder is exactly as it was afterwards.

use super::files::{check_export_space, export_blob, refuse_inside};
use super::items::BEING_DELETED;
use super::naming::created_at_now;
use super::source::{HEADER_MAC, VaultSource, unlock_source};
use super::{Credential, Vault};
use crate::archive::BackupArchive;
use crate::blob::{CancelToken, OutputJournal, decrypt_stream};
use crate::fsio::parent_dir;
use crate::header::{HEADER_BACKUP, HEADER_FILE, VaultHeader, verify_header_mac};
use crate::ids::{FileId, ItemId, VaultId};
use crate::item::{FileRef, Item, ItemKind};
use crate::search::SearchIndex;
use crate::{CoreError, Result};
use std::collections::BTreeMap;
use std::fs;
#[cfg(any(test, feature = "test-internals"))]
use std::io::Read;
use std::io::{self, ErrorKind};
use std::path::Path;

const DESTINATION_IS_BACKUP: CoreError = CoreError::InvalidInput {
    what: "destination is the backup",
};
const DESTINATION_IN_VAULT: CoreError = CoreError::InvalidInput {
    what: "destination in a vault folder",
};

/// Refuses `dest` when its folder, or any folder above it, holds `vault.json` or
/// `vault.json.bak`: that is a vault folder (a live vault, a pre-restore copy, a staging folder)
/// or a folder inside one, where the decrypted copy could replace one of that vault's files.
/// The folder is resolved first (links, junctions, `..`, short names), and each name is looked
/// up with `symlink_metadata`, so a link named `vault.json` counts too.
fn refuse_vault_folder(dest: &Path) -> Result<()> {
    let folder = fs::canonicalize(parent_dir(dest))?;
    for dir in folder.ancestors() {
        for name in [HEADER_FILE, HEADER_BACKUP] {
            match fs::symlink_metadata(dir.join(name)) {
                Ok(_) => return Err(DESTINATION_IN_VAULT),
                Err(e) if e.kind() == ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
    }
    Ok(())
}

/// A vault that can only be read: its items, a search over them, and decrypted copies of its
/// files. Damaged item files are listed, not hidden and not fatal.
pub struct ReadOnlyVault {
    source: VaultSource,
    header: VaultHeader,
    items: BTreeMap<ItemId, Item>,
    index: SearchIndex,
    damaged: Vec<ItemId>,
    header_mac_ok: bool,
}

impl ReadOnlyVault {
    /// Opens a backup archive. The manifest MAC and the header and item hashes are checked
    /// (see `unlock_source`), and the header MAC must hold. Blobs are authenticated when
    /// they are exported.
    pub fn open_backup(
        archive: &Path,
        credential: Credential,
        cancel: &CancelToken,
    ) -> Result<ReadOnlyVault> {
        let source = VaultSource::Archive(BackupArchive::open(archive, cancel)?);
        let vault = Self::open(source, &credential, cancel)?;
        if !vault.header_mac_ok {
            return Err(HEADER_MAC);
        }
        Ok(vault)
    }

    /// Opens a vault folder, such as a `.before-restore` folder. A header whose MAC does not
    /// match still opens; [`header_mac_ok`](Self::header_mac_ok) says so.
    pub fn open_folder(
        dir: &Path,
        credential: Credential,
        cancel: &CancelToken,
    ) -> Result<ReadOnlyVault> {
        Self::open(VaultSource::Folder(dir.to_path_buf()), &credential, cancel)
    }

    fn open(
        source: VaultSource,
        credential: &Credential,
        cancel: &CancelToken,
    ) -> Result<ReadOnlyVault> {
        // The vault key is not kept: exporting needs only each file's own key.
        let opened = unlock_source(&source, credential, cancel)?;
        Ok(ReadOnlyVault {
            index: SearchIndex::build(opened.items.values()),
            header_mac_ok: verify_header_mac(&opened.header, &opened.key),
            header: opened.header,
            items: opened.items,
            damaged: opened.damaged,
            source,
        })
    }

    pub fn name(&self) -> &str {
        &self.header.name
    }

    pub fn id(&self) -> VaultId {
        self.header.vault_id
    }

    /// Whether the header MAC holds. Always true for a backup, which is refused otherwise.
    pub fn header_mac_ok(&self) -> bool {
        self.header_mac_ok
    }

    /// Every item, trashed ones included.
    pub fn items(&self) -> impl Iterator<Item = &Item> {
        self.items.values()
    }

    pub fn get_item(&self, id: &ItemId) -> Result<&Item> {
        self.items.get(id).ok_or(CoreError::NotFound)
    }

    /// Item files that did not open.
    pub fn damaged_items(&self) -> &[ItemId] {
        &self.damaged
    }

    /// Items matching `q`, best first, at most `limit` (see [`SearchIndex::query`]).
    pub fn search(&self, q: &str, limit: usize) -> Vec<ItemId> {
        self.index.query(q, limit)
    }

    /// Saves a decrypted copy of an attachment at `dest`, as [`Vault::export_file`] does. A
    /// `dest` that is the backup itself, or inside the folder being viewed, or in any vault
    /// folder (one whose folder, or a folder above it, holds `vault.json` or `vault.json.bak`: a
    /// live vault, a pre-restore copy, a staging folder) is refused before anything is created.
    ///
    /// [`Vault::export_file`]: super::Vault::export_file
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
        match &self.source {
            VaultSource::Folder(dir) => refuse_inside(parent_dir(dest), dir)?,
            VaultSource::Archive(a) if a.is_same_file(dest)? => return Err(DESTINATION_IS_BACKUP),
            VaultSource::Archive(_) => {}
        }
        refuse_vault_folder(dest)?;
        check_export_space(fref, dest)?;
        let (mut blob, blob_size) = self.source.blob(file)?;
        let vault_id = &self.header.vault_id;
        export_blob(&mut blob, blob_size, vault_id, fref, dest, journal, cancel)
    }
}

impl Vault {
    /// Copies the item `id` of a read-only vault into this one (spec 6.9) and returns the new
    /// item's ID. The copy has a new ID, revision 0 and the time of now, and is never trashed;
    /// each attachment is decrypted with the source's key and re-encrypted under a new file ID
    /// and key, through a pipe, so no plaintext is written anywhere. The copy keeps the item's
    /// collection only if this vault has that collection and it is not in the trash. A trashed
    /// source item may be copied; a collection or an item being purged may not.
    ///
    /// A failed copy deletes the blobs it published, unless its item may have reached the disk.
    /// A blob that could not be deleted stays unreferenced, and the cleanup at unlock sets it aside.
    pub fn copy_item_from(
        &mut self,
        source: &ReadOnlyVault,
        id: &ItemId,
        cancel: &CancelToken,
    ) -> Result<ItemId> {
        let stored = source.get_item(id)?;
        if matches!(stored.kind, ItemKind::Collection) {
            return Err(CoreError::InvalidInput { what: "collection" });
        }
        if stored.purging {
            return Err(BEING_DELETED);
        }
        let new_id = self.fresh_item_id()?;
        // This vault's own rule: the collection must exist here and not be in the trash.
        let collection = stored.collection.filter(|_| {
            let fits = self.check_collection(&new_id, &stored.kind, stored.collection, None);
            fits.is_ok()
        });
        let mut published = Vec::new();
        let built = self.build_copy(source, stored, new_id, collection, cancel, &mut published);
        // Whether `commit_item` was reached: only then may the new item be on the disk.
        let (committed, reached_commit) = match built {
            Ok(item) => (self.commit_item(item), true),
            Err(error) => (Err(error), false),
        };
        let Err(error) = committed else {
            return Ok(new_id);
        };
        // `commit_item` has put the item in memory if its file reads back and opens; a file
        // that is there but does not, or cannot be looked for, counts as on the disk.
        let may_exist = reached_commit
            && (self.items.contains_key(&new_id)
                || !matches!(self.item_path(&new_id).try_exists(), Ok(false)));
        if !may_exist {
            for blob in &published {
                // Best effort: whatever stays is unreferenced, and unlock cleanup sets it aside.
                let _ = self.delete_published_blob(blob);
            }
        }
        Err(error)
    }

    /// Everything of the copy up to, not including, writing the item: the attachments, the last
    /// chance to cancel, and the item itself. Each blob published is listed in `published`.
    fn build_copy(
        &self,
        source: &ReadOnlyVault,
        stored: &Item,
        new_id: ItemId,
        collection: Option<ItemId>,
        cancel: &CancelToken,
        published: &mut Vec<FileId>,
    ) -> Result<Item> {
        let mut attachments = Vec::with_capacity(stored.attachments.len());
        for old in &stored.attachments {
            attachments.push(self.copy_attachment(source, old, cancel, published)?);
        }
        // The failpoint first: `arm_cancel` cancels and lets the step succeed.
        #[cfg(any(test, feature = "test-internals"))]
        crate::fsio::failpoint::check("copy.before_commit")?;
        cancel.check()?;
        let now = created_at_now();
        let mut item = stored.clone();
        item.id = new_id;
        item.collection = collection;
        item.attachments = attachments;
        item.revision = 0;
        item.created_at = now.clone();
        item.modified_at = now;
        item.trashed_at = None;
        item.purging = false;
        item.retired_blobs = Vec::new();
        Ok(item)
    }

    /// Streams one attachment of `source` into a new blob of this vault and returns its record.
    /// A worker thread decrypts into one end of a pipe while this thread encrypts from the other.
    /// The import stays on the calling thread, which is where its space check and tests' per-thread
    /// overrides and failpoints apply.
    fn copy_attachment(
        &self,
        source: &ReadOnlyVault,
        old: &FileRef,
        cancel: &CancelToken,
        published: &mut Vec<FileId>,
    ) -> Result<FileRef> {
        let (mut blob, blob_size) = source.source.blob(&old.file_id)?;
        let vault_id = &source.header.vault_id;
        let (reader, mut writer) = io::pipe()?;
        #[cfg(any(test, feature = "test-internals"))]
        let panic_in_worker = PANIC_IN_WORKER.with(std::cell::Cell::get);
        std::thread::scope(|scope| {
            let worker = std::thread::Builder::new().spawn_scoped(scope, move || {
                #[cfg(any(test, feature = "test-internals"))]
                {
                    use crate::fsio::failpoint;
                    if panic_in_worker {
                        failpoint::arm("copy.worker_panic");
                    }
                    if failpoint::check("copy.worker_panic").is_err() {
                        panic!("copy.worker_panic");
                    }
                }
                // `writer` drops when this ends, which ends the stream for the reader.
                decrypt_stream(&mut blob, blob_size, &mut writer, vault_id, old, cancel)
            })?;
            let imported = {
                // `reader` is moved into this block: when the import stops early, it drops, and
                // a worker blocked on a full pipe gets `BrokenPipe` instead of waiting forever.
                #[cfg(any(test, feature = "test-internals"))]
                let mut reader = MidStream::new(reader);
                #[cfg(not(any(test, feature = "test-internals")))]
                let mut reader = reader;
                let (len, name) = (old.length, old.name.clone());
                self.import_stream_tracked(&mut reader, len, name, cancel, published)
            };
            // A panic is reported as it is, ahead of the import's error: the import only saw the
            // stream end early because of it.
            let decrypted = worker
                .join()
                .map_err(|_| CoreError::Io(io::Error::other("copy worker stopped")))?;
            match (imported, decrypted) {
                // Damage or a cancel in the worker is the cause; the import only saw a short stream.
                (_, Err(error @ (CoreError::Damaged { .. } | CoreError::Cancelled))) => Err(error),
                (Err(error), _) => Err(error),
                // The worker's other errors are mostly the `BrokenPipe` of a stopped import.
                (Ok(_), Err(error)) => Err(error),
                (Ok(fref), Ok(())) => Ok(fref),
            }
        })
    }
}

/// Reads from `inner` and, once 1 MiB has passed, reaches the failpoint `copy.mid_stream` (once),
/// so a test can look at the disk while a copy is half done.
#[cfg(any(test, feature = "test-internals"))]
struct MidStream<R> {
    inner: R,
    passed: u64,
    fired: bool,
}

#[cfg(any(test, feature = "test-internals"))]
impl<R> MidStream<R> {
    fn new(inner: R) -> Self {
        MidStream {
            inner,
            passed: 0,
            fired: false,
        }
    }
}

#[cfg(any(test, feature = "test-internals"))]
impl<R: Read> Read for MidStream<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.passed += n as u64;
        if !self.fired && self.passed >= 1 << 20 {
            self.fired = true;
            crate::fsio::failpoint::check("copy.mid_stream").map_err(io::Error::other)?;
        }
        Ok(n)
    }
}

#[cfg(any(test, feature = "test-internals"))]
thread_local! {
    /// Makes the copy worker of this thread's next copies panic (the worker cannot be armed
    /// directly: failpoints are per thread, and the worker is another thread).
    static PANIC_IN_WORKER: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::testkit::{ManifestMode, rewrite_backup};
    use crate::blob::NoJournal;
    use crate::fsio::testutil::{TempDir, flip_byte, make_dir_link, names};
    use crate::fsio::{VolumeInfo, failpoint, set_volume_override};
    use crate::header::{HEADER_BACKUP, HEADER_FILE, parse_header, serialize_header};
    use crate::item::ItemKind;
    use crate::recovery::RecoverySecret;
    use crate::vault::Vault;
    use crate::vault::restore::tests::tree;
    use crate::vault::source::tests::{Fixture, MIB, PW, flip_blob_second_chunk, flip_item};
    use std::cell::{Cell, RefCell};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::rc::Rc;
    use zeroize::Zeroizing;

    const NEW_PW: &str = "another long passphrase";

    fn open_backup(path: &Path) -> Result<ReadOnlyVault> {
        ReadOnlyVault::open_backup(path, Credential::Password(PW), &CancelToken::new())
    }

    fn open_folder(dir: &Path) -> Result<ReadOnlyVault> {
        ReadOnlyVault::open_folder(dir, Credential::Password(PW), &CancelToken::new())
    }

    /// What identifies an item and its files, for comparing two views of the same vault.
    fn summary<'a>(
        items: impl Iterator<Item = &'a Item>,
    ) -> Vec<(ItemId, String, u64, Vec<FileId>)> {
        items
            .map(|i| {
                let files = i.attachments.iter().map(|a| a.file_id).collect();
                (i.id, i.title.clone(), i.revision, files)
            })
            .collect()
    }

    /// Copies a vault folder, leaving out the `.lock` a live vault holds (it cannot be read).
    fn copy_folder(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for entry in fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_folder(&entry.path(), &target);
            } else if entry.file_name() != ".lock" {
                fs::copy(entry.path(), target).unwrap();
            }
        }
    }

    /// The header bytes with another name, so the header MAC no longer matches.
    fn renamed(bytes: &[u8]) -> Vec<u8> {
        let mut header = parse_header(bytes).unwrap();
        header.name = "Renamed".to_owned();
        serialize_header(&header)
    }

    #[derive(Default)]
    struct Recorder {
        recorded: RefCell<Vec<PathBuf>>,
        cleared: RefCell<Vec<PathBuf>>,
    }

    impl OutputJournal for Recorder {
        fn record(&self, temp: &Path) {
            self.recorded.borrow_mut().push(temp.to_path_buf());
        }
        fn clear(&self, temp: &Path) {
            self.cleared.borrow_mut().push(temp.to_path_buf());
        }
    }

    /// Always disarms, so a failing test cannot leak a failpoint or volume into the next one on this thread.
    struct Disarm;
    impl Drop for Disarm {
        fn drop(&mut self) {
            failpoint::disarm_all();
            set_volume_override(None);
            PANIC_IN_WORKER.with(|flag| flag.set(false));
        }
    }

    #[test]
    fn open_backup_lists_and_searches() {
        let mut f = Fixture::new();
        let login = ItemKind::Login {
            username: "ariel".to_owned(),
            password: Zeroizing::new("hunter22".to_owned()),
            urls: vec!["https://bank.example".to_owned()],
        };
        f.vault.new_item(login, "Bank", None).unwrap();
        let (item, file) = f.file_item(b"hello world");
        let backup = f.backup("a.lockbox-backup");

        let ro = open_backup(&backup).unwrap();
        assert_eq!(ro.name(), "Family");
        assert_eq!(ro.id(), f.vault.id());
        assert!(ro.header_mac_ok());
        assert!(ro.damaged_items().is_empty());
        assert_eq!(summary(ro.items()).len(), 2);
        assert_eq!(summary(ro.items()), summary(f.vault.items()));
        for q in ["bank", "BANK", "ariel", "bank.example", "src", "nothing"] {
            assert_eq!(ro.search(q, 10), f.vault.search(q, 10), "{q}");
        }
        assert_eq!(ro.search("bank", 10).len(), 1);
        assert!(ro.search("nothing", 10).is_empty());
        assert_eq!(ro.get_item(&item).unwrap().title, "src.bin");
        let unknown = ro.get_item(&ItemId::random());
        assert!(matches!(unknown, Err(CoreError::NotFound)));

        let (from_backup, from_vault) = (f.out().join("ro.bin"), f.out().join("live.bin"));
        let cancel = CancelToken::new();
        ro.export_file(&item, &file, &from_backup, &NoJournal, &cancel)
            .unwrap();
        f.vault
            .export_file(&item, &file, &from_vault, &NoJournal, &cancel)
            .unwrap();
        assert_eq!(fs::read(&from_backup).unwrap(), b"hello world");
        assert_eq!(
            fs::read(&from_backup).unwrap(),
            fs::read(&from_vault).unwrap()
        );
        let no_such_file = FileId::random();
        let result = ro.export_file(&item, &no_such_file, &from_backup, &NoJournal, &cancel);
        assert!(matches!(result, Err(CoreError::NotFound)));
    }

    #[test]
    fn open_folder_writes_nothing() {
        let mut f = Fixture::new();
        let (item, file) = f.file_item(b"inside the folder");
        f.vault.new_item(ItemKind::Note, "note", None).unwrap();
        let (dir, out) = (f.vault.dir().to_path_buf(), f.out());
        let old_header = fs::read(dir.join(HEADER_FILE)).unwrap();
        f.vault.change_password(NEW_PW).unwrap();
        drop(f.vault);

        // What an unlock would tidy: a stale `.bak`, a `.tmp` scrap and a blob nobody attaches.
        fs::write(dir.join(HEADER_BACKUP), old_header).unwrap();
        fs::write(dir.join("x.tmp"), b"half written").unwrap();
        let orphan = format!("{}.blob", FileId::random().to_hex());
        fs::write(dir.join("files").join(orphan), b"orphan").unwrap();
        fs::remove_file(dir.join(".lock")).unwrap();

        // Control: a real unlock does change this folder, so the check below means something.
        let control = out.join("control");
        copy_folder(&dir, &control);
        Vault::unlock_with_password(&control, NEW_PW).unwrap();
        assert!(
            tree(&control) != tree(&dir),
            "an unlock changes nothing here"
        );
        fs::remove_dir_all(&control).unwrap();

        let before = tree(&dir);
        let credential = Credential::Password(NEW_PW);
        let ro = ReadOnlyVault::open_folder(&dir, credential, &CancelToken::new()).unwrap();
        assert!(ro.header_mac_ok());
        assert_eq!(ro.items().count(), 2);
        let dest = out.join("copy.bin");
        let cancel = CancelToken::new();
        ro.export_file(&item, &file, &dest, &NoJournal, &cancel)
            .unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"inside the folder");
        assert!(
            tree(&dir) == before,
            "opening or exporting changed the folder"
        );
        assert!(!dir.join(".lock").exists());
        drop(ro);
        assert!(tree(&dir) == before, "closing changed the folder");
        assert!(!dir.join(".lock").exists());
    }

    #[test]
    fn live_and_readonly_side_by_side() {
        let mut f = Fixture::new();
        let (item, file) = f.file_item(b"shared contents");
        let backup = f.backup("a.lockbox-backup");
        let copy = f.parent.path().join("copy");
        copy_folder(f.vault.dir(), &copy);

        let from_backup = open_backup(&backup).unwrap();
        let from_copy = open_folder(&copy).unwrap();
        // The live vault keeps working, and neither view sees what it adds.
        let later = f.vault.new_item(ItemKind::Note, "later", None).unwrap();
        assert_eq!(f.vault.items().count(), 2);
        for ro in [&from_backup, &from_copy] {
            assert_eq!(ro.items().count(), 1);
            assert!(matches!(ro.get_item(&later), Err(CoreError::NotFound)));
        }
        let live = Vault::unlock_with_password(f.vault.dir(), PW);
        assert!(matches!(live, Err(CoreError::VaultInUse)));
        for (n, ro) in [&from_backup, &from_copy].into_iter().enumerate() {
            let dest = f.out().join(format!("{n}.bin"));
            ro.export_file(&item, &file, &dest, &NoJournal, &CancelToken::new())
                .unwrap();
            assert_eq!(fs::read(&dest).unwrap(), b"shared contents");
        }
        // The folder view holds no lock: the copy can be unlocked while it is open.
        Vault::unlock_with_password(&copy, PW).unwrap();
        assert_eq!(from_copy.items().count(), 1);
    }

    #[test]
    fn export_over_the_backup_refused() {
        let mut f = Fixture::new();
        let (item, file) = f.file_item(b"data");
        let backup = f.backup("a.lockbox-backup");
        let ro = open_backup(&backup).unwrap();
        let before = fs::read(&backup).unwrap();
        let roundabout = f.out().join("..").join("out").join("a.lockbox-backup");
        // The same file in other capitals is the same file on Windows only.
        let capitals = cfg!(windows).then(|| backup.to_str().unwrap().to_uppercase().into());
        let aliases: Vec<PathBuf> = [backup.clone(), roundabout]
            .into_iter()
            .chain(capitals)
            .collect();
        let journal = Recorder::default();
        for dest in &aliases {
            let result = ro.export_file(&item, &file, dest, &journal, &CancelToken::new());
            assert!(
                matches!(
                    result,
                    Err(CoreError::InvalidInput {
                        what: "destination is the backup"
                    })
                ),
                "{dest:?}: {result:?}"
            );
        }
        assert_eq!(fs::read(&backup).unwrap(), before);
        assert_eq!(names(&f.out()), ["a.lockbox-backup"]);
        assert!(
            journal.recorded.borrow().is_empty(),
            "refused before any output"
        );
        // Beside it is fine.
        let beside = f.out().join("copy.bin");
        ro.export_file(&item, &file, &beside, &journal, &CancelToken::new())
            .unwrap();
        assert_eq!(fs::read(&beside).unwrap(), b"data");
    }

    /// A second name for the same file is the backup too: the path differs, the file does not.
    #[test]
    fn export_over_a_hard_link_of_the_backup_refused() {
        let mut f = Fixture::new();
        let (item, file) = f.file_item(b"data");
        let backup = f.backup("a.lockbox-backup");
        let link = f.out().join("alias.lockbox-backup");
        fs::hard_link(&backup, &link).unwrap();
        let ro = open_backup(&backup).unwrap();
        let before = fs::read(&backup).unwrap();
        let journal = Recorder::default();
        let result = ro.export_file(&item, &file, &link, &journal, &CancelToken::new());
        assert!(matches!(
            result,
            Err(CoreError::InvalidInput {
                what: "destination is the backup"
            })
        ));
        assert_eq!(fs::read(&backup).unwrap(), before);
        assert_eq!(fs::read(&link).unwrap(), before);
        assert!(journal.recorded.borrow().is_empty(), "no temp was created");
        assert_eq!(
            names(&f.out()),
            ["a.lockbox-backup", "alias.lockbox-backup"]
        );
    }

    /// As before Task 8: the space check comes before the blob is opened, so a missing blob on
    /// a full disk is a space error.
    #[test]
    fn missing_blob_and_too_little_space_is_a_space_error() {
        let _disarm = Disarm;
        let mut f = Fixture::new();
        let (item, file) = f.file_item(b"data");
        let copy = f.parent.path().join("copy");
        copy_folder(f.vault.dir(), &copy);
        fs::remove_file(copy.join("files").join(format!("{}.blob", file.to_hex()))).unwrap();
        let ro = open_folder(&copy).unwrap();
        let dest = f.out().join("copy.bin");
        let cancel = CancelToken::new();
        let result = ro.export_file(&item, &file, &dest, &NoJournal, &cancel);
        assert!(matches!(
            result,
            Err(CoreError::Damaged {
                what: "file missing"
            })
        ));
        set_volume_override(Some(VolumeInfo {
            free_bytes: Some(MIB as u64),
            max_file_bytes: None,
        }));
        let result = ro.export_file(&item, &file, &dest, &NoJournal, &cancel);
        assert!(
            matches!(result, Err(CoreError::NotEnoughSpace { .. })),
            "{result:?}"
        );
    }

    #[test]
    fn export_into_the_viewed_folder_refused() {
        let mut f = Fixture::new();
        let (item, file) = f.file_item(b"data");
        let copy = f.parent.path().join("copy");
        copy_folder(f.vault.dir(), &copy);
        let ro = open_folder(&copy).unwrap();
        let before = tree(&copy);
        let aliased = copy.join("files").join("..").join("vault.json");
        let inside = [
            copy.join("vault.json"),
            copy.join("items").join("x"),
            aliased,
        ];
        let journal = Recorder::default();
        for dest in &inside {
            let result = ro.export_file(&item, &file, dest, &journal, &CancelToken::new());
            assert!(
                matches!(
                    result,
                    Err(CoreError::InvalidInput {
                        what: "destination inside vault"
                    })
                ),
                "{dest:?}: {result:?}"
            );
        }
        assert!(tree(&copy) == before);
        assert!(
            journal.recorded.borrow().is_empty(),
            "refused before any output"
        );
    }

    #[track_caller]
    fn assert_in_vault_folder(result: Result<()>, what: &str) {
        assert!(
            matches!(
                result,
                Err(CoreError::InvalidInput {
                    what: "destination in a vault folder"
                })
            ),
            "{what}: {result:?}"
        );
    }

    /// Saving out of a read-only vault never lands in a vault folder, where the decrypted copy
    /// could replace an item file, a blob or a header: not in the live vault, from a backup or
    /// from a folder view, and not under any folder that holds `vault.json` or `vault.json.bak`,
    /// a link of that name included. Beside a vault is fine.
    #[test]
    fn export_into_a_vault_folder_refused() {
        let mut f = Fixture::new();
        let (item, file) = f.file_item(b"plaintext");
        let backup = f.backup("a.lockbox-backup");
        let copy = f.parent.path().join("copy");
        copy_folder(f.vault.dir(), &copy);
        let live = f.vault.dir().to_path_buf();
        let views = [open_backup(&backup).unwrap(), open_folder(&copy).unwrap()];
        let in_live = [
            live.join("items").join(format!("{}.item", item.to_hex())),
            f.blob_file(&file),
            live.join("vault.json"),
            live.join("files").join("orphaned").join("new.bin"),
        ];
        let before = tree(&live);
        for (n, ro) in views.iter().enumerate() {
            let journal = Recorder::default();
            for dest in &in_live {
                let result = ro.export_file(&item, &file, dest, &journal, &CancelToken::new());
                assert_in_vault_folder(result, &format!("view {n}, {dest:?}"));
            }
            let recorded = journal.recorded.borrow();
            assert!(recorded.is_empty(), "view {n}: refused before any output");
        }
        assert!(tree(&live) == before, "the live vault changed");

        // A folder with only `vault.json.bak`, or with a link named `vault.json` (a dangling
        // one), is a vault folder too, and so is every folder under one.
        let bak_only = f.parent.path().join("bak-only");
        fs::create_dir_all(bak_only.join("deeper")).unwrap();
        fs::write(bak_only.join("vault.json.bak"), b"x").unwrap();
        let linked = f.parent.path().join("linked");
        fs::create_dir(&linked).unwrap();
        let gone = TempDir::new();
        make_dir_link(&linked.join("vault.json"), gone.path());
        drop(gone);
        for dest in [bak_only.join("deeper").join("a.bin"), linked.join("a.bin")] {
            for (n, ro) in views.iter().enumerate() {
                let result = ro.export_file(&item, &file, &dest, &NoJournal, &CancelToken::new());
                assert_in_vault_folder(result, &format!("view {n}, {dest:?}"));
            }
            assert!(!dest.exists());
        }
        assert_eq!(names(&bak_only.join("deeper")), Vec::<String>::new());
        assert_eq!(names(&linked), ["vault.json"]);

        // In the folder that holds the vault, beside it, is fine.
        let beside = f.parent.path().join("beside.bin");
        for ro in &views {
            fs::write(&beside, b"OLD").unwrap();
            ro.export_file(&item, &file, &beside, &NoJournal, &CancelToken::new())
                .unwrap();
            assert_eq!(fs::read(&beside).unwrap(), b"plaintext");
        }
    }

    #[test]
    fn tampered_blob_export_refused() {
        let mut f = Fixture::new();
        let (item, file) = f.file_item(&vec![1u8; 2 * MIB]);
        let backup = f.backup("a.lockbox-backup");
        let copy = f.parent.path().join("copy");
        copy_folder(f.vault.dir(), &copy);
        let mode = ManifestMode::Rehash { key: Some(f.key()) };
        rewrite_backup(&backup, flip_blob_second_chunk, mode);
        let blob = copy.join("files").join(format!("{}.blob", file.to_hex()));
        flip_byte(&blob, MIB as u64 + 100).unwrap();

        // Blobs are authenticated when they are read, so both views open.
        let views = [open_backup(&backup).unwrap(), open_folder(&copy).unwrap()];
        let dest = f.out().join("copy.bin");
        for ro in &views {
            fs::write(&dest, b"OLD").unwrap();
            let journal = Recorder::default();
            let result = ro.export_file(&item, &file, &dest, &journal, &CancelToken::new());
            assert!(
                matches!(result, Err(CoreError::Damaged { .. })),
                "{result:?}"
            );
            assert_eq!(fs::read(&dest).unwrap(), b"OLD", "destination untouched");
            assert_eq!(names(&f.out()), ["a.lockbox-backup", "copy.bin"]);
            let recorded = journal.recorded.borrow();
            assert_eq!(recorded.len(), 1);
            assert!(
                *recorded == *journal.cleared.borrow(),
                "temp left in the journal"
            );
        }
    }

    #[test]
    fn wrong_credential_refused() {
        let mut f = Fixture::new();
        f.file_item(b"x");
        let backup = f.backup("a.lockbox-backup");
        let copy = f.parent.path().join("copy");
        copy_folder(f.vault.dir(), &copy);
        let stranger = RecoverySecret::generate();
        let cancel = CancelToken::new();
        let wrong = || {
            [
                Credential::Password("not the password"),
                Credential::Recovery(&stranger),
            ]
        };
        for credential in wrong() {
            let result = ReadOnlyVault::open_backup(&backup, credential, &cancel);
            assert!(matches!(result, Err(CoreError::WrongPassword)));
        }
        for credential in wrong() {
            let result = ReadOnlyVault::open_folder(&copy, credential, &cancel);
            assert!(matches!(result, Err(CoreError::WrongPassword)));
        }
    }

    #[test]
    fn recovery_key_opens_backup() {
        let mut f = Fixture::new();
        f.file_item(b"x");
        let backup = f.backup("a.lockbox-backup");
        let copy = f.parent.path().join("copy");
        copy_folder(f.vault.dir(), &copy);
        let cancel = CancelToken::new();
        let credential = Credential::Recovery(&f.recovery);
        let ro = ReadOnlyVault::open_backup(&backup, credential, &cancel).unwrap();
        assert_eq!(ro.items().count(), 1);
        let credential = Credential::Recovery(&f.recovery);
        let ro = ReadOnlyVault::open_folder(&copy, credential, &cancel).unwrap();
        assert_eq!(ro.items().count(), 1);
    }

    #[test]
    fn open_cancel() {
        let _disarm = Disarm;
        let mut f = Fixture::new();
        f.file_item(b"x");
        let backup = f.backup("a.lockbox-backup");
        let copy = f.parent.path().join("copy");
        copy_folder(f.vault.dir(), &copy);
        let backup_open = |token: &CancelToken| {
            ReadOnlyVault::open_backup(&backup, Credential::Password(PW), token)
        };
        let folder_open = |token: &CancelToken| {
            ReadOnlyVault::open_folder(&copy, Credential::Password(PW), token)
        };

        let cancelled = CancelToken::new();
        cancelled.cancel();
        assert!(matches!(backup_open(&cancelled), Err(CoreError::Cancelled)));
        assert!(matches!(folder_open(&cancelled), Err(CoreError::Cancelled)));
        cancel_while_opening_items(backup_open);
        cancel_while_opening_items(folder_open);
    }

    /// A cancel that arrives at the per-item checkpoint stops `open`, which must have reached it.
    #[track_caller]
    fn cancel_while_opening_items(open: impl Fn(&CancelToken) -> Result<ReadOnlyVault>) {
        let token = CancelToken::new();
        let reached = Rc::new(Cell::new(0));
        let seen = Rc::clone(&reached);
        failpoint::observe("source.item", Box::new(move || seen.set(seen.get() + 1)));
        failpoint::arm_cancel("source.item", token.clone());
        let result = open(&token);
        failpoint::disarm_all();
        assert!(matches!(result, Err(CoreError::Cancelled)));
        assert_eq!(reached.get(), 1, "never reached the per-item checkpoint");
    }

    #[test]
    fn backup_with_a_bad_header_mac_is_refused() {
        let mut f = Fixture::new();
        f.file_item(b"x");
        let backup = f.backup("a.lockbox-backup");
        let mode = ManifestMode::Rehash { key: Some(f.key()) };
        let rename = |m: &mut BTreeMap<String, Vec<u8>>| {
            let header = m.get_mut(HEADER_FILE).unwrap();
            *header = renamed(header);
        };
        rewrite_backup(&backup, rename, mode);
        let result = open_backup(&backup);
        assert!(matches!(
            result,
            Err(CoreError::Damaged {
                what: "backup: header mac"
            })
        ));
    }

    #[test]
    fn folder_with_a_bad_header_mac_opens_and_says_so() {
        let mut f = Fixture::new();
        f.file_item(b"x");
        let copy = f.parent.path().join("copy");
        copy_folder(f.vault.dir(), &copy);
        let header = copy.join(HEADER_FILE);
        fs::write(&header, renamed(&fs::read(&header).unwrap())).unwrap();
        let before = tree(&copy);

        let ro = open_folder(&copy).unwrap();
        assert!(!ro.header_mac_ok());
        assert_eq!(ro.name(), "Renamed");
        assert_eq!(ro.items().count(), 1);
        assert!(tree(&copy) == before);
    }

    #[test]
    fn a_damaged_item_is_listed_and_the_rest_opens() {
        let mut f = Fixture::new();
        f.vault.new_item(ItemKind::Note, "one", None).unwrap();
        f.vault.new_item(ItemKind::Note, "two", None).unwrap();
        let backup = f.backup("a.lockbox-backup");
        let copy = f.parent.path().join("copy");
        copy_folder(f.vault.dir(), &copy);
        let mode = ManifestMode::Rehash { key: Some(f.key()) };
        rewrite_backup(&backup, flip_item, mode);
        let item_file = &names(&copy.join("items"))[0];
        flip_byte(&copy.join("items").join(item_file), 40).unwrap();

        for ro in [open_backup(&backup).unwrap(), open_folder(&copy).unwrap()] {
            assert_eq!(ro.damaged_items().len(), 1);
            assert_eq!(ro.items().count(), 1);
            assert!(ro.items().all(|i| !ro.damaged_items().contains(&i.id)));
        }
    }

    /// An item file of a folder that cannot be read is one damaged item, as at unlock: the rest
    /// of the folder still opens, and nothing is written. Here the file goes between the listing
    /// and the read (the per-item checkpoint comes first), which fails the read on every system.
    #[test]
    fn an_unreadable_item_file_is_listed_and_the_rest_opens() {
        let _disarm = Disarm;
        let mut f = Fixture::new();
        let kept = f.vault.new_item(ItemKind::Note, "kept", None).unwrap();
        let lost = f.vault.new_item(ItemKind::Note, "lost", None).unwrap();
        let copy = f.parent.path().join("copy");
        copy_folder(f.vault.dir(), &copy);
        let lost_name = format!("items/{}.item", lost.to_hex());
        let expected: Vec<_> = tree(&copy)
            .into_iter()
            .filter(|(path, _)| *path != lost_name)
            .collect();
        // Retried like the code's own deletes; a file that is already gone counts as deleted.
        let gone = copy.join(&lost_name);
        let vanish = move || crate::fsio::remove_file_retry(&gone).unwrap();
        failpoint::observe("source.item", Box::new(vanish));

        let ro = open_folder(&copy).unwrap();
        failpoint::disarm_all();
        assert_eq!(ro.damaged_items(), [lost]);
        assert_eq!(ro.items().count(), 1);
        assert_eq!(ro.get_item(&kept).unwrap().title, "kept");
        assert!(matches!(ro.get_item(&lost), Err(CoreError::NotFound)));
        assert!(tree(&copy) == expected, "opening changed the folder");
        assert!(!copy.join(".lock").exists());
    }

    // ---- Copying an item into the live vault (spec 6.9) ----

    const SMALL: &[u8] = b"first attachment";

    /// A live vault of its own: another vault ID, so a copy must decrypt with the source's ID
    /// and encrypt with this one's.
    fn live_vault() -> (TempDir, Vault) {
        let parent = TempDir::new();
        let vault = Vault::create(parent.path(), "Live", PW).unwrap().vault;
        (parent, vault)
    }

    /// More than one chunk, so a flipped byte in the second chunk is found only after the
    /// first chunk has already gone through the pipe.
    fn big_bytes() -> Vec<u8> {
        (0..2 * MIB + 777).map(|i| (i % 251) as u8).collect()
    }

    /// A login in the source vault holding two attachments, `SMALL` and `big_bytes()`.
    fn two_file_login(f: &mut Fixture) -> (ItemId, FileId, FileId) {
        let kind = ItemKind::Login {
            username: "ariel".to_owned(),
            password: Zeroizing::new("hunter22".to_owned()),
            urls: vec!["https://bank.example".to_owned()],
        };
        let item = f.vault.new_item(kind, "Bank", None).unwrap();
        let small = f.attach(&item, SMALL);
        let big = f.attach(&item, &big_bytes());
        (item, small, big)
    }

    /// A copy of the source vault's folder in which the big blob has one flipped byte.
    fn tampered_folder(f: &Fixture, big: &FileId) -> ReadOnlyVault {
        let copy = f.parent.path().join("tampered");
        copy_folder(f.vault.dir(), &copy);
        let blob = copy.join("files").join(format!("{}.blob", big.to_hex()));
        flip_byte(&blob, MIB as u64 + 100).unwrap();
        open_folder(&copy).unwrap()
    }

    /// The files directly in the live vault's `files` folder (and the quarantine folder).
    fn files_listing(vault: &Vault) -> Vec<String> {
        match fs::read_dir(vault.dir().join("files")) {
            Ok(_) => names(&vault.dir().join("files")),
            Err(_) => Vec::new(),
        }
    }

    fn blob_count(vault: &Vault) -> usize {
        let listing = files_listing(vault);
        listing.iter().filter(|n| n.ends_with(".blob")).count()
    }

    /// What the live vault's attachment decrypts to, saved beside the source vault's output.
    fn saved(vault: &Vault, out: &Path, item: &ItemId, file: &FileId) -> Vec<u8> {
        let dest = out.join(format!("{}.saved", file.to_hex()));
        let cancel = CancelToken::new();
        vault
            .export_file(item, file, &dest, &NoJournal, &cancel)
            .unwrap();
        fs::read(dest).unwrap()
    }

    #[track_caller]
    fn invalid(result: Result<ItemId>, what: &str) {
        match result {
            Err(CoreError::InvalidInput { what: w }) => assert_eq!(w, what),
            other => panic!("expected InvalidInput({what}), got {other:?}"),
        }
    }

    fn login_fields(item: &Item) -> (String, String, Vec<String>) {
        match &item.kind {
            ItemKind::Login {
                username,
                password,
                urls,
            } => (username.clone(), (**password).clone(), urls.clone()),
            other => panic!("not a login: {other:?}"),
        }
    }

    #[test]
    fn copy_login_with_attachments() {
        let mut f = Fixture::new();
        let (item, small, _big) = two_file_login(&mut f);
        let mut edit = f.vault.get_item(&item).unwrap().clone();
        edit.notes = Zeroizing::new("security answer: blue".to_owned());
        f.vault.update_item(edit).unwrap();
        // A replaced file leaves a retired blob in the item, and a trashed item can be copied.
        let replacement = f.parent.path().join("new.bin");
        fs::write(&replacement, b"replacement").unwrap();
        let cancel = CancelToken::new();
        let replaced = f
            .vault
            .replace_attachment(&item, &small, &replacement, &cancel);
        replaced.unwrap();
        f.vault.trash_item(&item).unwrap();
        let backup = f.backup("a.lockbox-backup");
        let ro = open_backup(&backup).unwrap();
        let from = ro.get_item(&item).unwrap();
        assert!(from.revision > 0 && from.trashed_at.is_some());
        assert_eq!(from.retired_blobs.len(), 1);

        let (_parent, mut live) = live_vault();
        let new = live.copy_item_from(&ro, &item, &cancel).unwrap();
        assert_ne!(new, item);
        let copy = live.get_item(&new).unwrap();
        assert_eq!(copy.id, new);
        assert_eq!(copy.title, from.title);
        assert_eq!(*copy.notes, *from.notes);
        assert_eq!(&**copy.notes, "security answer: blue");
        assert_eq!(login_fields(copy), login_fields(from));
        assert_eq!(copy.revision, 0);
        assert!(copy.trashed_at.is_none() && !copy.purging);
        assert!(copy.retired_blobs.is_empty());
        assert_eq!(copy.created_at, copy.modified_at);
        assert_eq!(copy.collection, None);

        let wanted: [&[u8]; 2] = [b"replacement", &big_bytes()];
        assert_eq!(copy.attachments.len(), 2);
        for ((new_ref, old_ref), bytes) in
            copy.attachments.iter().zip(&from.attachments).zip(wanted)
        {
            assert_ne!(new_ref.file_id, old_ref.file_id);
            assert_ne!(new_ref.file_key.as_bytes(), old_ref.file_key.as_bytes());
            assert_ne!(new_ref.nonce_prefix, old_ref.nonce_prefix);
            assert_eq!(new_ref.name, old_ref.name);
            assert_eq!(new_ref.length, old_ref.length);
            assert_eq!(saved(&live, &f.out(), &new, &new_ref.file_id), bytes);
        }
        // Reaches the disk: the copy survives an unlock.
        let dir = live.dir().to_path_buf();
        drop(live);
        let (live, _) = Vault::unlock_with_password(&dir, PW).unwrap();
        assert_eq!(live.get_item(&new).unwrap().attachments.len(), 2);
        // The source is untouched.
        assert_eq!(ro.get_item(&item).unwrap().attachments.len(), 2);
    }

    #[test]
    fn collection_kept_only_if_live_has_it() {
        let mut f = Fixture::new();
        let c = f
            .vault
            .new_item(ItemKind::Collection, "Work", None)
            .unwrap();
        let note = f.vault.new_item(ItemKind::Note, "n", Some(c)).unwrap();
        let backup = f.backup("a.lockbox-backup");
        let ro = open_backup(&backup).unwrap();
        let cancel = CancelToken::new();

        // A vault without that collection: the copy sits outside any collection.
        let (_parent, mut other) = live_vault();
        let new = other.copy_item_from(&ro, &note, &cancel).unwrap();
        assert_eq!(other.get_item(&new).unwrap().collection, None);

        // The vault the backup came from has it: kept.
        let new = f.vault.copy_item_from(&ro, &note, &cancel).unwrap();
        assert_eq!(f.vault.get_item(&new).unwrap().collection, Some(c));

        // In the trash there: not kept.
        f.vault.delete_collection(&c).unwrap();
        assert!(f.vault.get_item(&c).unwrap().trashed_at.is_some());
        let new = f.vault.copy_item_from(&ro, &note, &cancel).unwrap();
        let copy = f.vault.get_item(&new).unwrap();
        assert_eq!(copy.collection, None);
        assert!(copy.trashed_at.is_none());
    }

    #[test]
    fn collections_and_purging_items_refused() {
        let _disarm = Disarm;
        let mut f = Fixture::new();
        let c = f
            .vault
            .new_item(ItemKind::Collection, "Work", None)
            .unwrap();
        let (purging, _) = f.file_item(b"being deleted");
        f.vault.trash_item(&purging).unwrap();
        failpoint::arm("purge.after_mark");
        assert!(f.vault.purge_item(&purging).is_err());
        failpoint::disarm_all();
        assert!(f.vault.get_item(&purging).unwrap().purging);
        let copy = f.parent.path().join("copy");
        copy_folder(f.vault.dir(), &copy);
        let ro = open_folder(&copy).unwrap();

        let (_parent, mut live) = live_vault();
        let before = files_listing(&live);
        let cancel = CancelToken::new();
        invalid(live.copy_item_from(&ro, &c, &cancel), "collection");
        invalid(live.copy_item_from(&ro, &purging, &cancel), "being deleted");
        let unknown = live.copy_item_from(&ro, &ItemId::random(), &cancel);
        assert!(matches!(unknown, Err(CoreError::NotFound)));
        assert_eq!(live.items().count(), 0);
        assert_eq!(files_listing(&live), before, "nothing written");
    }

    #[test]
    fn tampered_blob_aborts_copy() {
        let mut f = Fixture::new();
        let (item, _, big) = two_file_login(&mut f);
        let ro = tampered_folder(&f, &big);
        let (_parent, mut live) = live_vault();
        let before = files_listing(&live);
        let result = live.copy_item_from(&ro, &item, &CancelToken::new());
        assert!(
            matches!(result, Err(CoreError::Damaged { .. })),
            "{result:?}"
        );
        assert_eq!(live.items().count(), 0);
        let after = files_listing(&live);
        assert!(after.iter().all(|n| !n.ends_with(".partial")), "{after:?}");
        assert_eq!(after, before);
    }

    /// A failed copy takes back the blobs it published; they were never referenced.
    #[test]
    fn failed_copy_removes_its_blobs() {
        let _disarm = Disarm;
        let mut f = Fixture::new();
        let (item, _, big) = two_file_login(&mut f);
        let backup = f.backup("a.lockbox-backup");
        let good = open_backup(&backup).unwrap();
        let tampered = tampered_folder(&f, &big);
        let (_parent, mut live) = live_vault();
        let existing = f.out().join("existing.bin");
        fs::write(&existing, b"already in the live vault").unwrap();
        let cancel = CancelToken::new();
        live.new_file_item(None, &existing, &cancel).unwrap();
        let before = files_listing(&live);
        assert_eq!(blob_count(&live), 1);

        let published = Rc::new(Cell::new(0));
        let watch = |point: &'static str, vault: &Vault| {
            let (seen, dir) = (Rc::clone(&published), vault.dir().join("files"));
            let count = move || {
                let blobs = names(&dir).into_iter().filter(|n| n.ends_with(".blob"));
                seen.set(blobs.count());
            };
            failpoint::observe(point, Box::new(count));
        };

        // The second attachment fails: the first one's new blob is already published.
        published.set(0);
        watch("copy.mid_stream", &live);
        let result = live.copy_item_from(&tampered, &item, &cancel);
        failpoint::disarm_all();
        assert!(
            matches!(result, Err(CoreError::Damaged { .. })),
            "{result:?}"
        );
        assert_eq!(
            published.get(),
            2,
            "the first attachment's blob was published"
        );
        assert_eq!(files_listing(&live), before);
        assert_eq!(live.items().count(), 1);

        // A cancel after the last attachment.
        published.set(0);
        watch("copy.before_commit", &live);
        let token = CancelToken::new();
        failpoint::arm_cancel("copy.before_commit", token.clone());
        let result = live.copy_item_from(&good, &item, &token);
        failpoint::disarm_all();
        assert!(matches!(result, Err(CoreError::Cancelled)), "{result:?}");
        assert_eq!(published.get(), 3, "both new blobs were published");
        assert_eq!(files_listing(&live), before);
        assert_eq!(live.items().count(), 1);

        // A commit that fails before the item file is in place.
        published.set(0);
        watch("copy.before_commit", &live);
        failpoint::arm("atomic_write.before_replace");
        let result = live.copy_item_from(&good, &item, &cancel);
        failpoint::disarm_all();
        assert!(matches!(result, Err(CoreError::Io(_))), "{result:?}");
        assert_eq!(published.get(), 3, "both new blobs were published");
        assert_eq!(files_listing(&live), before);
        assert_eq!(live.items().count(), 1);
        let items = names(&live.dir().join("items"));
        assert_eq!(items.len(), 1, "no item file or temp left: {items:?}");

        // Still works afterwards.
        live.copy_item_from(&good, &item, &cancel).unwrap();
        assert_eq!(live.items().count(), 2);
    }

    /// A new blob can share its ID with an older one in the quarantine (the import only looks in
    /// `files/`); rolling back the copy must leave the older blob alone.
    #[test]
    fn failed_copy_spares_a_quarantined_blob_with_the_same_id() {
        let _disarm = Disarm;
        let mut f = Fixture::new();
        let (item, _) = f.file_item(b"copied file");
        let backup = f.backup("a.lockbox-backup");
        let ro = open_backup(&backup).unwrap();
        let (_parent, mut live) = live_vault();
        let old_file = f.out().join("old.bin");
        fs::write(&old_file, b"older file, quarantined").unwrap();
        let cancel = CancelToken::new();
        let old = live.new_file_item(None, &old_file, &cancel).unwrap();
        let quarantined_id = live.get_item(&old).unwrap().attachments[0].file_id;
        // Its item file goes missing, so the next unlock quarantines the blob.
        let dir = live.dir().to_path_buf();
        drop(live);
        fs::remove_file(dir.join("items").join(format!("{}.item", old.to_hex()))).unwrap();
        let (mut live, _) = Vault::unlock_with_password(&dir, PW).unwrap();
        let blob = format!("{}.blob", quarantined_id.to_hex());
        let (quarantined, primary) = (
            dir.join("files").join("orphaned").join(&blob),
            dir.join("files").join(&blob),
        );
        assert!(quarantined.exists() && !primary.exists());
        let before = fs::read(&quarantined).unwrap();

        crate::blob::force_next_file_id(quarantined_id);
        let published = Rc::new(Cell::new(false));
        let (seen, path) = (Rc::clone(&published), primary.clone());
        let look = move || seen.set(path.exists());
        failpoint::observe("copy.before_commit", Box::new(look));
        let token = CancelToken::new();
        failpoint::arm_cancel("copy.before_commit", token.clone());
        let result = live.copy_item_from(&ro, &item, &token);
        failpoint::disarm_all();
        assert!(matches!(result, Err(CoreError::Cancelled)), "{result:?}");
        assert!(published.get(), "the new blob took the quarantined ID");
        assert!(!primary.exists(), "the copy's own blob is gone");
        assert_eq!(fs::read(&quarantined).unwrap(), before);
        assert_eq!(live.items().count(), 0);
    }

    /// A rename that succeeds followed by an error in publication has still published the blob.
    #[test]
    fn blob_published_then_failed_is_rolled_back() {
        let _disarm = Disarm;
        let mut f = Fixture::new();
        let (item, _, _) = two_file_login(&mut f);
        let backup = f.backup("a.lockbox-backup");
        let ro = open_backup(&backup).unwrap();
        let (_parent, mut live) = live_vault();
        let before = files_listing(&live);
        let published = Rc::new(Cell::new(0));
        let (seen, dir) = (Rc::clone(&published), live.dir().join("files"));
        let count = move || {
            let blobs = names(&dir).into_iter().filter(|n| n.ends_with(".blob"));
            seen.set(blobs.count());
        };
        failpoint::observe("import.after_publish", Box::new(count));
        failpoint::arm("import.after_publish");
        let result = live.copy_item_from(&ro, &item, &CancelToken::new());
        failpoint::disarm_all();
        assert!(matches!(result, Err(CoreError::Io(_))), "{result:?}");
        assert_eq!(published.get(), 1, "the blob was in place when it failed");
        assert_eq!(files_listing(&live), before);
        assert_eq!(live.items().count(), 0);
    }

    /// A commit that reports an error after the item file is in place has made the copy, so
    /// its blobs must stay.
    #[test]
    fn committed_copy_keeps_its_blobs() {
        let _disarm = Disarm;
        let mut f = Fixture::new();
        let (item, small, big) = two_file_login(&mut f);
        let backup = f.backup("a.lockbox-backup");
        let ro = open_backup(&backup).unwrap();
        let (_parent, mut live) = live_vault();
        failpoint::arm("items.after_write");
        let result = live.copy_item_from(&ro, &item, &CancelToken::new());
        failpoint::disarm_all();
        assert!(matches!(result, Err(CoreError::Io(_))), "{result:?}");
        assert_eq!(live.items().count(), 1, "the item is in the vault");
        let new = live.items().next().unwrap().id;
        let copy = live.get_item(&new).unwrap();
        assert_eq!(copy.attachments.len(), 2);
        assert_eq!(blob_count(&live), 2);
        let (first, second) = (copy.attachments[0].file_id, copy.attachments[1].file_id);
        assert_ne!((first, second), (small, big));
        assert_eq!(saved(&live, &f.out(), &new, &first), SMALL);
        assert_eq!(saved(&live, &f.out(), &new, &second), big_bytes());
    }

    /// The item file is in place but does not read back (so memory does not take it): the item
    /// may still be there for the next unlock, and it must keep its blobs.
    #[test]
    fn unreadable_committed_item_keeps_its_blobs() {
        let _disarm = Disarm;
        let mut f = Fixture::new();
        let (item, _, _) = two_file_login(&mut f);
        let backup = f.backup("a.lockbox-backup");
        let ro = open_backup(&backup).unwrap();
        let (_parent, mut live) = live_vault();
        let items = live.dir().join("items");
        let damage = move || {
            let written = names(&items);
            assert_eq!(written.len(), 1, "the item file is in place");
            flip_byte(&items.join(&written[0]), 40).unwrap();
        };
        failpoint::observe("items.after_write", Box::new(damage));
        failpoint::arm("items.after_write");
        let result = live.copy_item_from(&ro, &item, &CancelToken::new());
        failpoint::disarm_all();
        assert!(matches!(result, Err(CoreError::Io(_))), "{result:?}");
        assert_eq!(live.items().count(), 0, "memory could not take the item");
        assert_eq!(names(&live.dir().join("items")).len(), 1);
        assert_eq!(blob_count(&live), 2, "its blobs stay");
    }

    /// The pipe has a small buffer, so an import that stops early leaves the decrypting side
    /// blocked unless the reading end is dropped.
    #[test]
    fn low_space_aborts_copy_without_hanging() {
        let _disarm = Disarm;
        let mut f = Fixture::new();
        let (item, _) = f.file_item(&vec![5u8; 5 * MIB]);
        let backup = f.backup("a.lockbox-backup");
        let ro = open_backup(&backup).unwrap();
        let (_parent, mut live) = live_vault();
        let before = files_listing(&live);

        // A hang would otherwise stall the whole test run: end the process with a message.
        let (done, waiting) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            if waiting
                .recv_timeout(std::time::Duration::from_secs(60))
                .is_err()
            {
                eprintln!("low_space_aborts_copy_without_hanging: the copy hung");
                std::process::abort();
            }
        });
        set_volume_override(Some(VolumeInfo {
            free_bytes: Some(MIB as u64),
            max_file_bytes: None,
        }));
        let started = std::time::Instant::now();
        let result = live.copy_item_from(&ro, &item, &CancelToken::new());
        done.send(()).unwrap();
        assert!(
            matches!(result, Err(CoreError::NotEnoughSpace { .. })),
            "{result:?}"
        );
        assert!(
            started.elapsed().as_secs() < 30,
            "took {:?}",
            started.elapsed()
        );
        assert_eq!(live.items().count(), 0);
        assert_eq!(files_listing(&live), before);
    }

    #[test]
    fn worker_panic_is_an_error() {
        let _disarm = Disarm;
        let mut f = Fixture::new();
        let (item, _) = f.file_item(&vec![5u8; 3 * MIB]);
        let backup = f.backup("a.lockbox-backup");
        let ro = open_backup(&backup).unwrap();
        let (_parent, mut live) = live_vault();
        let before = files_listing(&live);
        PANIC_IN_WORKER.with(|flag| flag.set(true));
        let result = live.copy_item_from(&ro, &item, &CancelToken::new());
        PANIC_IN_WORKER.with(|flag| flag.set(false));
        assert!(matches!(result, Err(CoreError::Io(_))), "{result:?}");
        assert_eq!(live.items().count(), 0);
        assert_eq!(files_listing(&live), before);
        // The vault is fine afterwards.
        live.copy_item_from(&ro, &item, &CancelToken::new())
            .unwrap();
        assert_eq!(live.items().count(), 1);
    }

    #[test]
    fn cancel_before_commit() {
        let _disarm = Disarm;
        let mut f = Fixture::new();
        let (item, _, _) = two_file_login(&mut f);
        let note = f.vault.new_item(ItemKind::Note, "plain", None).unwrap();
        let backup = f.backup("a.lockbox-backup");
        let ro = open_backup(&backup).unwrap();
        let (_parent, mut live) = live_vault();
        let before = files_listing(&live);

        // Cancelled after the last attachment went through.
        let token = CancelToken::new();
        failpoint::arm_cancel("copy.before_commit", token.clone());
        let result = live.copy_item_from(&ro, &item, &token);
        failpoint::disarm_all();
        assert!(matches!(result, Err(CoreError::Cancelled)), "{result:?}");
        assert!(token.is_cancelled());
        assert_eq!(live.items().count(), 0);
        assert_eq!(files_listing(&live), before);

        // Nothing to stream: the token is still looked at before the item is written.
        let token = CancelToken::new();
        token.cancel();
        let result = live.copy_item_from(&ro, &note, &token);
        assert!(matches!(result, Err(CoreError::Cancelled)), "{result:?}");
        assert_eq!(live.items().count(), 0);
        let items = names(&live.dir().join("items"));
        assert!(items.is_empty(), "{items:?}");
    }

    #[test]
    fn copy_from_same_vault_backup_works() {
        let mut f = Fixture::new();
        let (item, small, big) = two_file_login(&mut f);
        let backup = f.backup("a.lockbox-backup");
        let ro = open_backup(&backup).unwrap();
        let new = f.vault.copy_item_from(&ro, &item, &CancelToken::new());
        let new = new.unwrap();
        assert_ne!(new, item);
        assert_eq!(f.vault.items().count(), 2);
        let (old, copy) = (
            f.vault.get_item(&item).unwrap(),
            f.vault.get_item(&new).unwrap(),
        );
        assert_eq!(login_fields(old), login_fields(copy));
        assert_eq!(copy.attachments.len(), 2);
        assert_ne!(copy.attachments[0].file_id, small);
        assert_ne!(copy.attachments[1].file_id, big);
        for (n, bytes) in [SMALL.to_vec(), big_bytes()].into_iter().enumerate() {
            let (old_file, new_file) = (old.attachments[n].file_id, copy.attachments[n].file_id);
            assert_eq!(saved(&f.vault, &f.out(), &item, &old_file), bytes);
            assert_eq!(saved(&f.vault, &f.out(), &new, &new_file), bytes);
        }
        assert_eq!(blob_count(&f.vault), 4);
    }

    /// Where a 4 KiB run of `run` sits in a file under `roots`; unreadable files (the vault's
    /// held `.lock`) are skipped, and the number of files read is returned too.
    fn scan(run: &[u8], roots: &[PathBuf]) -> (usize, Vec<PathBuf>) {
        let (mut read, mut hits) = (0, Vec::new());
        let mut todo: Vec<PathBuf> = roots.to_vec();
        while let Some(path) = todo.pop() {
            if path.is_dir() {
                let entries = fs::read_dir(&path).unwrap();
                todo.extend(entries.map(|e| e.unwrap().path()));
            } else if let Ok(bytes) = fs::read(&path) {
                read += 1;
                if bytes.windows(run.len()).any(|w| w == run) {
                    hits.push(path);
                }
            }
        }
        (read, hits)
    }

    #[test]
    fn no_plaintext_on_disk() {
        let _disarm = Disarm;
        const MARK: &[u8] = b"LOCKBOX-PLAINTEXT-MARKER:";
        let data: Vec<u8> = (0..3 * MIB).map(|i| MARK[i % MARK.len()]).collect();
        let run = &data[..4096];
        let mut f = Fixture::new();
        let (item, file) = f.file_item(&data);
        // The only plaintext copy on disk was the file attached from; it is gone.
        fs::remove_file(f.parent.path().join("src.bin")).unwrap();
        let backup = f.backup("a.lockbox-backup");
        let ro = open_backup(&backup).unwrap();
        let (live_parent, mut live) = live_vault();
        let roots = vec![
            f.parent.path().to_path_buf(),
            live_parent.path().to_path_buf(),
        ];

        // The scan finds a plaintext file when there is one.
        let control = f.out().join("control.bin");
        fs::write(&control, &data).unwrap();
        let (read, hits) = scan(run, &roots);
        assert!(read > 3 && hits == [control.clone()], "{read} {hits:?}");
        fs::remove_file(&control).unwrap();
        assert!(scan(run, &roots).1.is_empty());

        let scans = Rc::new(RefCell::new(Vec::new()));
        let (seen, watched, owned_run) = (Rc::clone(&scans), roots.clone(), run.to_vec());
        let at_mid_stream = move || seen.borrow_mut().push(scan(&owned_run, &watched));
        failpoint::observe("copy.mid_stream", Box::new(at_mid_stream));
        let result = live.copy_item_from(&ro, &item, &CancelToken::new());
        failpoint::disarm_all();
        let new = result.unwrap();

        let scans = scans.borrow();
        assert_eq!(scans.len(), 1, "the mid-stream point is reached once");
        let (read, hits) = &scans[0];
        assert!(
            *read > 3 && hits.is_empty(),
            "{read} files, found in {hits:?}"
        );
        let (read, hits) = scan(run, &roots);
        assert!(
            read > 3 && hits.is_empty(),
            "{read} files, found in {hits:?}"
        );
        let new_file = live.get_item(&new).unwrap().attachments[0].file_id;
        assert_ne!(new_file, file);
        assert_eq!(saved(&live, &f.out(), &new, &new_file), data);
    }
}
