//! Read-only vaults (spec 6.9): a backup archive or a `.before-restore` folder opened to look
//! at its items and copy files out of it. The type has no method that writes. Opening takes no
//! lock and repairs, cleans and creates nothing, so a folder is exactly as it was afterwards.

use super::Credential;
use super::files::{export_blob, refuse_inside};
use super::source::{HEADER_MAC, VaultSource, unlock_source};
use crate::archive::BackupArchive;
use crate::blob::{CancelToken, OutputJournal};
use crate::fsio::parent_dir;
use crate::header::{VaultHeader, verify_header_mac};
use crate::ids::{FileId, ItemId, VaultId};
use crate::item::Item;
use crate::search::SearchIndex;
use crate::{CoreError, Result};
use std::collections::BTreeMap;
use std::path::Path;

const DESTINATION_IS_BACKUP: CoreError = CoreError::InvalidInput {
    what: "destination is the backup",
};

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
    /// `dest` that is the backup itself, or inside the folder being viewed, is refused before
    /// anything is created.
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
        let (mut blob, blob_size) = self.source.blob(file)?;
        let vault_id = &self.header.vault_id;
        export_blob(&mut blob, blob_size, vault_id, fref, dest, journal, cancel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::testkit::{ManifestMode, rewrite_backup};
    use crate::blob::NoJournal;
    use crate::fsio::failpoint;
    use crate::fsio::testutil::{flip_byte, names};
    use crate::header::{HEADER_BACKUP, HEADER_FILE, parse_header, serialize_header};
    use crate::item::ItemKind;
    use crate::recovery::RecoverySecret;
    use crate::vault::Vault;
    use crate::vault::restore::tests::tree;
    use crate::vault::source::tests::{Fixture, MIB, PW, flip_blob_second_chunk, flip_item};
    use std::cell::RefCell;
    use std::fs;
    use std::path::{Path, PathBuf};
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

    /// Always disarms, so a failing test cannot leak a failpoint into the next one on this thread.
    struct Disarm;
    impl Drop for Disarm {
        fn drop(&mut self) {
            failpoint::disarm_all();
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
        let opens = |token: &CancelToken| {
            [
                ReadOnlyVault::open_backup(&backup, Credential::Password(PW), token),
                ReadOnlyVault::open_folder(&copy, Credential::Password(PW), token),
            ]
        };

        let cancelled = CancelToken::new();
        cancelled.cancel();
        for result in opens(&cancelled) {
            assert!(matches!(result, Err(CoreError::Cancelled)));
        }
        // A cancel that arrives while the items are being opened.
        let token = CancelToken::new();
        failpoint::arm_cancel("source.item", token.clone());
        for result in opens(&token) {
            assert!(matches!(result, Err(CoreError::Cancelled)));
        }
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
}
