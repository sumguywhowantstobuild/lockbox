//! One way to unlock and check a vault, whether it sits in a folder or inside a backup
//! archive (spec 6.7 "Test a backup", 6.8 steps 1 to 2). The same header rule, the same item
//! opening and the same blob authentication serve "Test a backup" and restore. Nothing here
//! writes: a folder source is only read, and an archive is held open read-only.

use super::cleanup::{check_folder, list_blobs};
use super::files::{FILES_DIR, attachments, blob_in};
use super::items::{ITEMS_DIR, item_file_in, item_id_from_file_name};
use super::unlock::{Credential, HeaderFile, choose_header, load};
use crate::archive::{BackupArchive, EntryKind};
use crate::blob::{CancelToken, authenticate_copy};
use crate::fsio::{open_shared_read, read_retry};
use crate::header::{HEADER_BACKUP, HEADER_FILE, VaultHeader, verify_header_mac};
use crate::ids::{FileId, ItemId, VaultId};
use crate::item::{FileRef, Item, MAX_ITEM_FILE, open_item};
use crate::manifest::verify_manifest_mac_cancellable;
use crate::secret::Key32;
use crate::{CoreError, Result};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{self, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};

const MANIFEST_MAC: CoreError = CoreError::Damaged {
    what: "backup: manifest mac",
};
const WRONG_VAULT: CoreError = CoreError::Damaged {
    what: "backup: wrong vault",
};
pub(super) const ENTRY_HASH: CoreError = CoreError::Damaged {
    what: "backup: entry hash",
};
pub(super) const HEADER_MAC: CoreError = CoreError::Damaged {
    what: "backup: header mac",
};
const DAMAGED_ITEM: CoreError = CoreError::Damaged {
    what: "backup: damaged item",
};
pub(super) const UNEXPECTED_FILE: CoreError = CoreError::Damaged {
    what: "backup: unexpected file",
};
const DAMAGED_FILE: CoreError = CoreError::Damaged {
    what: "backup: damaged file",
};
const NO_HEADER: CoreError = CoreError::Damaged {
    what: "backup: no header",
};
const FILE_MISSING: CoreError = CoreError::Damaged {
    what: "file missing",
};

/// Where a vault's files are read from.
pub(super) enum VaultSource {
    Folder(PathBuf),
    Archive(BackupArchive),
}

/// The archive entry name of an item file.
pub(super) fn item_name(id: &ItemId) -> String {
    format!("items/{}.item", id.to_hex())
}

/// The archive entry name of a blob.
pub(super) fn blob_name(id: &FileId) -> String {
    format!("files/{}.blob", id.to_hex())
}

impl VaultSource {
    /// `vault.json` and the fallback copy. A folder has `vault.json.bak`; an archive holds one
    /// header and no fallback.
    pub(super) fn header(&self) -> (Result<HeaderFile>, Result<HeaderFile>) {
        match self {
            // The root itself too: a linked vault folder could lead anywhere.
            Self::Folder(dir) => match check_folder(dir) {
                Ok(()) => (load(&dir.join(HEADER_FILE)), load(&dir.join(HEADER_BACKUP))),
                Err(e) => (Err(e), Err(CoreError::NotFound)),
            },
            Self::Archive(a) => (
                a.entry(HEADER_FILE)
                    .ok_or(NO_HEADER)
                    .and_then(|e| a.read_entry(e))
                    .and_then(HeaderFile::from_bytes),
                Err(CoreError::NotFound),
            ),
        }
    }

    /// The IDs of the item files present, sorted. A folder lists regular files named like item
    /// files (a linked `items` folder is refused, a missing one is empty).
    pub(super) fn item_ids(&self) -> Result<Vec<ItemId>> {
        match self {
            Self::Folder(dir) => {
                let items = dir.join(ITEMS_DIR);
                check_folder(&items)?;
                let entries = match fs::read_dir(&items) {
                    Ok(entries) => entries,
                    Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
                    Err(e) => return Err(e.into()),
                };
                let mut ids = Vec::new();
                for entry in entries {
                    let entry = entry?;
                    let id = entry.file_name().to_str().and_then(item_id_from_file_name);
                    if let Some(id) = id.filter(|_| entry.file_type().is_ok_and(|t| t.is_file())) {
                        ids.push(id);
                    }
                }
                ids.sort();
                Ok(ids)
            }
            Self::Archive(a) => Ok(a
                .entries()
                .iter()
                .filter_map(|e| match e.kind {
                    EntryKind::Item(id) => Some(id),
                    _ => None,
                })
                .collect()),
        }
    }

    pub(super) fn item_bytes(&self, id: &ItemId) -> Result<Vec<u8>> {
        match self {
            Self::Folder(dir) => read_retry(&item_file_in(dir, id), MAX_ITEM_FILE),
            Self::Archive(a) => a
                .entry(&item_name(id))
                .ok_or(FILE_MISSING)
                .and_then(|e| a.read_entry(e)),
        }
    }

    /// The size of the item file, for the summary.
    fn item_len(&self, id: &ItemId) -> Result<u64> {
        match self {
            Self::Folder(dir) => Ok(fs::metadata(item_file_in(dir, id))?.len()),
            Self::Archive(a) => a.entry(&item_name(id)).map(|e| e.size).ok_or(FILE_MISSING),
        }
    }

    /// The IDs of the blobs present, sorted. A folder lists `files/` only, never `orphaned/`,
    /// and refuses a linked `files` folder.
    pub(super) fn blob_ids(&self) -> Result<Vec<FileId>> {
        match self {
            Self::Folder(dir) => Ok(list_blobs(&dir.join(FILES_DIR))?
                .into_iter()
                .map(|(id, _)| id)
                .collect()),
            Self::Archive(a) => Ok(a
                .entries()
                .iter()
                .filter_map(|e| match e.kind {
                    EntryKind::Blob(id) => Some(id),
                    _ => None,
                })
                .collect()),
        }
    }

    /// The stored blob (ciphertext) and its size. A blob that is not there is
    /// `Damaged { "file missing" }`; so is a link named like one.
    pub(super) fn blob(&self, id: &FileId) -> Result<(Box<dyn Read + Send>, u64)> {
        match self {
            Self::Folder(dir) => {
                let path = blob_in(&dir.join(FILES_DIR), id);
                match fs::symlink_metadata(&path) {
                    Ok(m) if m.is_file() => {}
                    Ok(_) => return Err(FILE_MISSING),
                    Err(e) if e.kind() == ErrorKind::NotFound => return Err(FILE_MISSING),
                    Err(e) => return Err(e.into()),
                }
                let file = open_shared_read(&path)?;
                let size = file.metadata()?.len();
                Ok((Box::new(file), size))
            }
            Self::Archive(a) => {
                let e = a.entry(&blob_name(id)).ok_or(FILE_MISSING)?;
                Ok((Box::new(a.reader(e)), e.size))
            }
        }
    }
}

/// A vault opened from a source: its header, key and every item that opened.
pub(super) struct Opened {
    pub header: VaultHeader,
    pub key: Key32,
    pub items: BTreeMap<ItemId, Item>,
    /// Item files that did not open, or (a folder only) could not be read.
    pub damaged: Vec<ItemId>,
}

/// An archive's manifest as path to SHA-256; `None` for a folder, which has no manifest.
pub(super) fn manifest_hashes(src: &VaultSource) -> Option<HashMap<&str, [u8; 32]>> {
    let VaultSource::Archive(a) = src else {
        return None;
    };
    Some(
        a.manifest()
            .entries
            .iter()
            .map(|m| (m.path.as_str(), m.sha256))
            .collect(),
    )
}

/// An archive entry must hash to what its manifest lists. A folder has nothing to compare.
pub(super) fn check_listed(
    listed: &Option<HashMap<&str, [u8; 32]>>,
    name: &str,
    hash: [u8; 32],
) -> Result<()> {
    match listed {
        Some(l) if l.get(name) != Some(&hash) => Err(ENTRY_HASH),
        _ => Ok(()),
    }
}

/// Unlocks `src` and opens every item, checking `cancel` per item. For an archive, once the key
/// is known and before any content is trusted: the manifest MAC, its vault ID, then each
/// header and item hash against the manifest. Header MAC and damaged items are left to
/// [`check_opened`]. An item that does not open is damaged; so is a folder's item file that
/// cannot be read, while a read that fails inside an archive fails the whole open.
pub(super) fn unlock_source(
    src: &VaultSource,
    credential: &Credential,
    cancel: &CancelToken,
) -> Result<Opened> {
    cancel.check()?;
    let (main, backup) = src.header();
    let listed = manifest_hashes(src);
    let (used, key, _) = match choose_header(&main, &backup, credential) {
        Ok(chosen) => chosen,
        Err(error) => {
            // A `vault.json` that no longer matches the manifest fails every credential, but
            // that is damage, not a wrong password. (A folder has no manifest to compare.)
            if let (CoreError::WrongPassword | CoreError::InvalidRecoveryKey, Ok(header)) =
                (&error, &main)
            {
                check_listed(&listed, HEADER_FILE, Sha256::digest(&header.bytes).into())?;
            }
            return Err(error);
        }
    };
    cancel.check()?;
    let vault_id = used.header.vault_id;
    if let VaultSource::Archive(a) = src {
        if !verify_manifest_mac_cancellable(a.manifest(), &key, cancel)? {
            return Err(MANIFEST_MAC);
        }
        if a.manifest().vault_id != vault_id {
            return Err(WRONG_VAULT);
        }
    }
    check_listed(&listed, HEADER_FILE, Sha256::digest(&used.bytes).into())?;

    let (mut items, mut damaged) = (BTreeMap::new(), Vec::new());
    for id in src.item_ids()? {
        #[cfg(any(test, feature = "test-internals"))]
        crate::fsio::failpoint::check("source.item")?;
        cancel.check()?;
        let bytes = match src.item_bytes(&id) {
            Ok(bytes) => bytes,
            // A folder's item file that cannot be read is one damaged item, as at unlock
            // (`items::load_all`). In an archive a failed read is the archive's, not the item's.
            Err(_) if matches!(src, VaultSource::Folder(_)) => {
                damaged.push(id);
                continue;
            }
            Err(error) => return Err(error),
        };
        check_listed(&listed, &item_name(&id), Sha256::digest(&bytes).into())?;
        match open_item(&bytes, &id, &vault_id, &key) {
            Ok(item) => {
                items.insert(id, item);
            }
            Err(_) => damaged.push(id),
        }
    }
    Ok(Opened {
        header: used.header.clone(),
        key,
        items,
        damaged,
    })
}

/// The header MAC holds and no item is damaged.
pub(super) fn check_opened(opened: &Opened) -> Result<()> {
    if !verify_header_mac(&opened.header, &opened.key) {
        return Err(HEADER_MAC);
    }
    if !opened.damaged.is_empty() {
        return Err(DAMAGED_ITEM);
    }
    Ok(())
}

/// Every attachment of every loaded item, trashed ones included.
pub(super) fn attached_refs(opened: &Opened) -> BTreeMap<FileId, &FileRef> {
    attachments(opened.items.values())
}

/// The IDs of the blobs `src` holds, each of which an item attaches (`refs`); a blob nobody
/// attaches is `Damaged { "backup: unexpected file" }`.
pub(super) fn attached_blobs(
    src: &VaultSource,
    refs: &BTreeMap<FileId, &FileRef>,
) -> Result<Vec<FileId>> {
    let blobs = src.blob_ids()?;
    if blobs.iter().any(|id| !refs.contains_key(id)) {
        return Err(UNEXPECTED_FILE);
    }
    Ok(blobs)
}

/// Streams the stored blob `id` into `dst` while authenticating it against `fref`, checks its
/// hash against the manifest (an archive only) and returns its size. A blob that fails
/// authentication is `Damaged { "backup: damaged file" }`; `dst` must then be thrown away.
pub(super) fn copy_blob(
    src: &VaultSource,
    id: &FileId,
    fref: &FileRef,
    vault_id: &VaultId,
    listed: &Option<HashMap<&str, [u8; 32]>>,
    dst: &mut impl Write,
    cancel: &CancelToken,
) -> Result<u64> {
    let (mut blob, size) = src.blob(id)?;
    let hash =
        authenticate_copy(&mut blob, size, dst, vault_id, fref, cancel).map_err(|e| match e {
            CoreError::Damaged { .. } => DAMAGED_FILE,
            other => other,
        })?;
    check_listed(listed, &blob_name(id), hash)?;
    Ok(size)
}

/// What a backup holds, as found by [`verify_backup`].
#[derive(Debug, PartialEq, Eq)]
pub struct BackupSummary {
    pub name: String,
    pub vault_id: VaultId,
    pub items: usize,
    pub files: usize,
    /// Attachments whose blob the backup does not hold.
    pub missing_files: usize,
    /// Bytes of the item files plus the blobs. Not `vault.json` and not the manifest, so it is
    /// smaller than [`BackupReport::bytes`](super::BackupReport) of the backup it describes by
    /// the size of `vault.json`.
    pub bytes: u64,
    /// When the backup was made, as the manifest says (RFC 3339, UTC). The manifest's MAC has
    /// been checked, so it is the time the backup's maker signed. Empty for a vault folder,
    /// which has no manifest.
    pub created_at: String,
}

/// The checks that need the blobs, in this order: [`check_opened`]; every blob present is
/// attached by an item; every blob authenticates (and, for an archive, hashes to the manifest).
/// Attachments with no blob are counted, not refused.
pub(super) fn verify_contents(
    src: &VaultSource,
    opened: &Opened,
    cancel: &CancelToken,
) -> Result<BackupSummary> {
    check_opened(opened)?;
    let refs = attached_refs(opened);
    let blobs = attached_blobs(src, &refs)?;
    let listed = manifest_hashes(src);
    let vault_id = &opened.header.vault_id;
    let mut bytes = 0u64;
    for id in opened.items.keys() {
        cancel.check()?;
        bytes = bytes.saturating_add(src.item_len(id)?);
    }
    for id in &blobs {
        cancel.check()?;
        let sink = &mut io::sink();
        let size = copy_blob(src, id, refs[id], vault_id, &listed, sink, cancel)?;
        bytes = bytes.saturating_add(size);
    }
    Ok(BackupSummary {
        name: opened.header.name.clone(),
        vault_id: *vault_id,
        items: opened.items.len(),
        files: blobs.len(),
        // Every blob is attached and listed once, so the rest of the attachments are absent.
        missing_files: refs.len() - blobs.len(),
        bytes,
        created_at: match src {
            VaultSource::Archive(a) => a.manifest().created_at.clone(),
            VaultSource::Folder(_) => String::new(),
        },
    })
}

/// Checks a backup without restoring it (spec 6.7 "Test a backup"): the manifest MAC, every
/// entry's SHA-256, every item and every file stream, and reports the files the items attach
/// that the backup lacks. Writes nothing.
pub fn verify_backup(
    archive: &Path,
    credential: Credential,
    cancel: &CancelToken,
) -> Result<BackupSummary> {
    let src = VaultSource::Archive(BackupArchive::open(archive, cancel)?);
    let opened = unlock_source(&src, &credential, cancel)?;
    verify_contents(&src, &opened, cancel)
}

#[cfg(test)]
// `pub(super)`: restore's tests build their backups with the same fixture.
pub(super) mod tests {
    use super::*;
    use crate::archive::testkit::{ManifestMode, build_backup, rewrite_backup};
    use crate::blob::NoJournal;
    use crate::fsio::failpoint;
    use crate::fsio::testutil::{TempDir, make_dir_link, names};
    use crate::item::ItemKind;
    use crate::recovery::RecoverySecret;
    use crate::vault::Vault;
    use std::cell::Cell;
    use std::rc::Rc;

    pub(in crate::vault) const PW: &str = "correct horse battery";
    pub(in crate::vault) const MIB: usize = 1 << 20;

    pub(in crate::vault) struct Fixture {
        pub(in crate::vault) parent: TempDir,
        pub(in crate::vault) vault: Vault,
        pub(in crate::vault) recovery: RecoverySecret,
    }

    impl Fixture {
        pub(in crate::vault) fn new() -> Self {
            let parent = TempDir::new();
            let created = Vault::create(parent.path(), "Family", PW).unwrap();
            fs::create_dir(parent.path().join("out")).unwrap();
            Fixture {
                parent,
                vault: created.vault,
                recovery: created.recovery,
            }
        }

        pub(in crate::vault) fn out(&self) -> PathBuf {
            self.parent.path().join("out")
        }

        /// A file item holding `bytes`: the item's and the file's IDs.
        pub(in crate::vault) fn file_item(&mut self, bytes: &[u8]) -> (ItemId, FileId) {
            let src = self.parent.path().join("src.bin");
            fs::write(&src, bytes).unwrap();
            let id = self
                .vault
                .new_file_item(None, &src, &CancelToken::new())
                .unwrap();
            (id, self.vault.get_item(&id).unwrap().attachments[0].file_id)
        }

        pub(in crate::vault) fn attach(&mut self, item: &ItemId, bytes: &[u8]) -> FileId {
            let src = self.parent.path().join("attach.bin");
            fs::write(&src, bytes).unwrap();
            self.vault
                .attach_file(item, &src, &CancelToken::new())
                .unwrap()
        }

        pub(in crate::vault) fn blob_file(&self, id: &FileId) -> PathBuf {
            self.vault
                .dir()
                .join("files")
                .join(format!("{}.blob", id.to_hex()))
        }

        /// Backs the open vault up into the output folder as `name`.
        pub(in crate::vault) fn backup(&self, name: &str) -> PathBuf {
            let dest = self.out().join(name);
            self.vault
                .backup(&dest, &NoJournal, &CancelToken::new())
                .unwrap();
            dest
        }

        pub(in crate::vault) fn key(&self) -> &Key32 {
            &self.vault.vault_key
        }
    }

    fn verify(path: &Path, credential: Credential) -> Result<BackupSummary> {
        verify_backup(path, credential, &CancelToken::new())
    }

    #[track_caller]
    fn refused(result: Result<BackupSummary>) -> &'static str {
        match result {
            Err(CoreError::Damaged { what }) => what,
            other => panic!("expected Damaged, got {other:?}"),
        }
    }

    /// Bytes of the regular files directly inside `dir`.
    fn file_bytes(dir: &Path) -> u64 {
        fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().metadata().unwrap())
            .filter(|m| m.is_file())
            .map(|m| m.len())
            .sum()
    }

    pub(in crate::vault) fn flip_item(m: &mut BTreeMap<String, Vec<u8>>) {
        let (_, bytes) = m.iter_mut().find(|(n, _)| n.starts_with("items/")).unwrap();
        // Past the 30-byte header, inside the sealed part.
        bytes[40] ^= 1;
    }

    pub(in crate::vault) fn flip_blob_second_chunk(m: &mut BTreeMap<String, Vec<u8>>) {
        let (_, bytes) = m.iter_mut().find(|(n, _)| n.starts_with("files/")).unwrap();
        bytes[MIB + 100] ^= 1;
    }

    #[test]
    fn verify_good_backup_with_password_and_recovery() {
        let mut f = Fixture::new();
        f.vault.new_item(ItemKind::Note, "note", None).unwrap();
        let (item, _) = f.file_item(b"hello");
        f.attach(&item, &vec![7u8; MIB + 5]);
        let dest = f.backup("a.lockbox-backup");

        // The expected size comes from the vault's own files, not from the backup.
        let dir = f.vault.dir();
        let want = BackupSummary {
            name: "Family".to_owned(),
            vault_id: f.vault.id(),
            items: 2,
            files: 2,
            missing_files: 0,
            bytes: file_bytes(&dir.join("items")) + file_bytes(&dir.join("files")),
            // Read from the archive's manifest, which the MAC check has just authenticated.
            created_at: BackupArchive::open(&dest, &CancelToken::new())
                .unwrap()
                .manifest()
                .created_at
                .clone(),
        };
        assert!(want.created_at.ends_with('Z'), "{}", want.created_at);
        assert_eq!(verify(&dest, Credential::Password(PW)).unwrap(), want);
        assert_eq!(
            verify(&dest, Credential::Recovery(&f.recovery)).unwrap(),
            want
        );
    }

    #[test]
    fn wrong_password_is_wrong_password() {
        let mut f = Fixture::new();
        f.file_item(b"x");
        let dest = f.backup("a.lockbox-backup");
        let result = verify(&dest, Credential::Password("not the password"));
        assert!(
            matches!(result, Err(CoreError::WrongPassword)),
            "{result:?}"
        );
    }

    /// The MAC is checked before any content, so a forger without the key learns nothing
    /// about which entry was changed.
    #[test]
    fn rewritten_manifest_refused() {
        let mut f = Fixture::new();
        f.file_item(b"x");
        let dest = f.backup("a.lockbox-backup");
        rewrite_backup(&dest, flip_item, ManifestMode::Rehash { key: None });
        let result = verify(&dest, Credential::Password(PW));
        assert_eq!(refused(result), "backup: manifest mac");
    }

    /// A `vault.json` that was damaged inside the archive fails every credential. The manifest
    /// knows its hash, so that is damage, not a wrong password; a genuinely wrong password
    /// (see `wrong_password_is_wrong_password`) still is one.
    #[test]
    fn damaged_header_in_archive_is_damage_not_a_wrong_password() {
        let mut f = Fixture::new();
        f.file_item(b"x");
        let dest = f.backup("a.lockbox-backup");
        rewrite_backup(
            &dest,
            |m| {
                let bytes = m.get_mut(HEADER_FILE).unwrap();
                let mut header = crate::header::parse_header(bytes).unwrap();
                header.slots[0].ciphertext[0] ^= 1;
                let damaged = crate::header::serialize_header(&header);
                assert_eq!(damaged.len(), bytes.len());
                *bytes = damaged;
            },
            ManifestMode::Keep,
        );
        let result = verify(&dest, Credential::Password(PW));
        assert_eq!(refused(result), "backup: entry hash");
        let result = verify(&dest, Credential::Password("not the password"));
        assert_eq!(refused(result), "backup: entry hash");
    }

    #[test]
    fn tampered_item_found() {
        let mut f = Fixture::new();
        f.file_item(b"x");
        let dest = f.backup("a.lockbox-backup");
        let key = f.key();
        rewrite_backup(&dest, flip_item, ManifestMode::Rehash { key: Some(key) });
        let result = verify(&dest, Credential::Password(PW));
        assert_eq!(refused(result), "backup: damaged item");
    }

    /// An older, valid item swapped in under the newer manifest: it opens, so only its hash
    /// gives it away.
    #[test]
    fn rolled_back_item_found() {
        let mut f = Fixture::new();
        let id = f.vault.new_item(ItemKind::Note, "first", None).unwrap();
        let first = f.backup("first.lockbox-backup");
        let name = item_name(&id);
        let old = {
            let archive = BackupArchive::open(&first, &CancelToken::new()).unwrap();
            archive.read_entry(archive.entry(&name).unwrap()).unwrap()
        };
        let mut edited = f.vault.get_item(&id).unwrap().clone();
        edited.title = "second".to_owned();
        f.vault.update_item(edited).unwrap();
        let second = f.backup("second.lockbox-backup");

        let put_back = old.clone();
        rewrite_backup(
            &second,
            |m| {
                let current = m.insert(name.clone(), put_back).unwrap();
                // Same 512-byte bucket, so the archive still matches its manifest's sizes.
                assert_eq!(current.len(), old.len());
                assert_ne!(current, old);
            },
            ManifestMode::Keep,
        );
        let result = verify(&second, Credential::Password(PW));
        assert_eq!(refused(result), "backup: entry hash");
    }

    #[test]
    fn tampered_blob_found() {
        let mut f = Fixture::new();
        f.file_item(&vec![1u8; 2 * MIB]);
        let dest = f.backup("a.lockbox-backup");
        let key = f.key();
        let mode = ManifestMode::Rehash { key: Some(key) };
        rewrite_backup(&dest, flip_blob_second_chunk, mode);
        let result = verify(&dest, Credential::Password(PW));
        assert_eq!(refused(result), "backup: damaged file");
    }

    #[test]
    fn extra_blob_found() {
        let mut f = Fixture::new();
        f.file_item(b"x");
        let dest = f.backup("a.lockbox-backup");
        let key = f.key();
        let extra = blob_name(&FileId::random());
        rewrite_backup(
            &dest,
            |m| {
                m.insert(extra, vec![1, 2, 3]);
            },
            ManifestMode::Rehash { key: Some(key) },
        );
        let result = verify(&dest, Credential::Password(PW));
        assert_eq!(refused(result), "backup: unexpected file");
    }

    /// A manifest signed with the right key but naming another vault.
    #[test]
    fn manifest_of_another_vault_refused() {
        let mut f = Fixture::new();
        f.file_item(b"x");
        let dest = f.backup("a.lockbox-backup");
        let entries: Vec<(String, Vec<u8>)> = {
            let archive = BackupArchive::open(&dest, &CancelToken::new()).unwrap();
            archive
                .entries()
                .iter()
                .map(|e| {
                    let mut bytes = Vec::new();
                    archive.reader(e).read_to_end(&mut bytes).unwrap();
                    (e.name.clone(), bytes)
                })
                .collect()
        };
        let refs: Vec<(&str, &[u8])> = entries.iter().map(|(n, b)| (n.as_str(), &b[..])).collect();
        // `build_backup` writes a manifest for a fixed vault ID that is not this vault's.
        fs::write(&dest, build_backup(&refs, Some(f.key()))).unwrap();
        let result = verify(&dest, Credential::Password(PW));
        assert_eq!(refused(result), "backup: wrong vault");
    }

    #[test]
    fn missing_file_reported() {
        let mut f = Fixture::new();
        let (_, file) = f.file_item(b"gone");
        fs::remove_file(f.blob_file(&file)).unwrap();
        let dest = f.backup("a.lockbox-backup");
        let summary = verify(&dest, Credential::Password(PW)).unwrap();
        assert_eq!(
            (summary.items, summary.files, summary.missing_files),
            (1, 0, 1)
        );
    }

    /// Task 4's `damaged_blob_left_out`: the damaged blob is left out of the backup, and the
    /// backup still verifies, reporting the file as missing.
    #[test]
    fn damaged_blob_backup_verifies() {
        let mut f = Fixture::new();
        let (item, bad) = f.file_item(&vec![1u8; 2 * MIB]);
        f.attach(&item, b"good");
        let path = f.blob_file(&bad);
        let mut bytes = fs::read(&path).unwrap();
        bytes[MIB + 100] ^= 1;
        fs::write(&path, bytes).unwrap();
        let dest = f.backup("a.lockbox-backup");

        let summary = verify(&dest, Credential::Password(PW)).unwrap();
        assert_eq!(
            (summary.items, summary.files, summary.missing_files),
            (1, 1, 1)
        );
    }

    #[test]
    fn verify_writes_nothing() {
        let mut f = Fixture::new();
        f.file_item(&vec![5u8; MIB + 1]);
        let dest = f.backup("a.lockbox-backup");
        let (bytes, listing) = (fs::read(&dest).unwrap(), names(&f.out()));
        let others = names(f.parent.path());

        verify(&dest, Credential::Password(PW)).unwrap();
        verify(&dest, Credential::Recovery(&f.recovery)).unwrap();
        // A refused one too.
        assert!(verify(&dest, Credential::Password("not the password")).is_err());

        assert_eq!(fs::read(&dest).unwrap(), bytes);
        assert_eq!(names(&f.out()), listing);
        assert_eq!(names(f.parent.path()), others);
    }

    #[test]
    fn verify_cancel() {
        let mut f = Fixture::new();
        for title in ["a", "b", "c"] {
            f.vault.new_item(ItemKind::Note, title, None).unwrap();
        }
        let dest = f.backup("a.lockbox-backup");
        let token = CancelToken::new();
        let seen = Rc::new(Cell::new(0));
        let (counter, cancel) = (seen.clone(), token.clone());
        failpoint::observe(
            "source.item",
            Box::new(move || {
                counter.set(counter.get() + 1);
                if counter.get() == 2 {
                    cancel.cancel();
                }
            }),
        );
        let result = verify_backup(&dest, Credential::Password(PW), &token);
        failpoint::disarm_all();
        assert!(matches!(result, Err(CoreError::Cancelled)), "{result:?}");
        assert_eq!(seen.get(), 2, "stopped at the second item");
    }

    /// A folder whose `vault.json` slot is damaged opens from `.bak`: `choose_header` is the
    /// rule `Vault::unlock_with_password` uses, so both agree.
    #[test]
    fn folder_source_matches_unlock() {
        let mut f = Fixture::new();
        f.file_item(b"x");
        let dir = f.vault.dir().to_path_buf();
        drop(f.vault);
        let main = dir.join(HEADER_FILE);
        let mut header = crate::header::parse_header(&fs::read(&main).unwrap()).unwrap();
        header.slots[0].ciphertext[0] ^= 1;
        fs::write(&main, crate::header::serialize_header(&header)).unwrap();

        let src = VaultSource::Folder(dir.clone());
        let (main_copy, backup_copy) = src.header();
        let credential = Credential::Password(PW);
        let (used, _, used_backup) = choose_header(&main_copy, &backup_copy, &credential).unwrap();
        assert!(used_backup);
        assert_eq!(used.bytes, fs::read(dir.join(HEADER_BACKUP)).unwrap());
        let opened = unlock_source(&src, &credential, &CancelToken::new()).unwrap();
        assert_eq!(opened.items.len(), 1);

        // The same folder through the real unlock (which also repairs `vault.json`).
        let (vault, report) = Vault::unlock_with_password(&dir, PW).unwrap();
        assert!(report.used_backup_header);
        assert_eq!(vault.id(), opened.header.vault_id);
    }

    /// The folder paths (item and blob listing, reads) give the summary the archive does.
    #[test]
    fn folder_source_verifies_like_its_backup() {
        let mut f = Fixture::new();
        f.vault.new_item(ItemKind::Note, "note", None).unwrap();
        let (item, _) = f.file_item(b"hello");
        f.attach(&item, &vec![7u8; MIB + 5]);
        let dest = f.backup("a.lockbox-backup");

        let src = VaultSource::Folder(f.vault.dir().to_path_buf());
        let token = CancelToken::new();
        let opened = unlock_source(&src, &Credential::Password(PW), &token).unwrap();
        let summary = verify_contents(&src, &opened, &token).unwrap();
        // A folder has no manifest, so no creation time.
        assert_eq!(summary.created_at, "");
        let from_archive = verify(&dest, Credential::Password(PW)).unwrap();
        assert_eq!(
            summary,
            BackupSummary {
                created_at: String::new(),
                ..from_archive
            }
        );
    }

    #[track_caller]
    fn not_plain<T>(result: Result<T>) {
        let error = result.err();
        let ok = matches!(
            error,
            Some(CoreError::InvalidInput {
                what: "not a plain folder"
            })
        );
        assert!(ok, "{error:?}");
    }

    /// "No linked folders": a vault folder that is itself a link to a real vault is refused.
    #[test]
    fn linked_source_root_refused() {
        let mut f = Fixture::new();
        f.file_item(b"x");
        let link = f.parent.path().join("link");
        make_dir_link(&link, f.vault.dir());
        let src = VaultSource::Folder(link);
        let token = CancelToken::new();
        not_plain(unlock_source(&src, &Credential::Password(PW), &token));
    }

    #[test]
    fn linked_items_or_files_child_refused() {
        for name in ["items", "files"] {
            let mut f = Fixture::new();
            f.file_item(b"x");
            let dir = f.vault.dir().to_path_buf();
            let outside = TempDir::new();
            fs::remove_dir_all(dir.join(name)).unwrap();
            make_dir_link(&dir.join(name), outside.path());
            let src = VaultSource::Folder(dir);
            let token = CancelToken::new();
            let opened = unlock_source(&src, &Credential::Password(PW), &token);
            if name == "items" {
                not_plain(opened);
            } else {
                // Items load; the linked `files` folder stops the check that needs the blobs.
                not_plain(verify_contents(&src, &opened.unwrap(), &token));
            }
        }
    }

    /// Property test (spec 5.4): a real backup with one edit anywhere in the file (a byte
    /// replaced, added or removed), or with up to three edits inside one entry that is then
    /// listed again in a correctly signed manifest, is read by the whole chain (the archive
    /// parser, the manifest MAC, every hash, the item and header checks). Each outcome is `Ok`
    /// or a fixed-text error, never a panic.
    mod never_panics {
        use super::*;
        use crate::archive::testkit::{assert_text_is_fixed, mutated};
        use proptest::prelude::*;
        use std::sync::LazyLock;

        /// Words that exist only in the fixture's vault, with the IDs as lowercase hex.
        const VAULT_NAME: &str = "Quokka Meadow";
        const ITEM_TITLE: &str = "Marmoset Ledger";
        const FILE_NAME: &str = "wallaby-notes.bin";

        struct Tiny {
            /// The backup file.
            backup: Vec<u8>,
            /// The recovery key as typed; it is not `Sync`, so it is parsed per case.
            recovery: String,
            /// Lowercase: the vault ID, the item and file IDs, the names.
            secrets: Vec<String>,
            /// The vault key, so a changed entry can be listed in the manifest under a valid MAC.
            key: [u8; 32],
            /// Each entry of the backup, manifest excluded: its name and bytes.
            entries: Vec<(String, Vec<u8>)>,
        }

        /// One test case: a change anywhere in the backup file, or a change inside one entry
        /// whose new bytes are then listed in the manifest, correctly signed.
        #[derive(Debug)]
        enum Case {
            File(Vec<u8>),
            Entry(usize, Vec<u8>),
        }

        /// A vault of a note and a file item, backed up once for all cases.
        static TINY: LazyLock<Tiny> = LazyLock::new(|| {
            let parent = TempDir::new();
            let created = Vault::create(parent.path(), VAULT_NAME, PW).unwrap();
            let mut vault = created.vault;
            let note = vault.new_item(ItemKind::Note, ITEM_TITLE, None).unwrap();
            let src = parent.path().join(FILE_NAME);
            fs::write(&src, b"a few bytes of file").unwrap();
            let cancel = CancelToken::new();
            let file_item = vault.new_file_item(None, &src, &cancel).unwrap();
            let file = vault.get_item(&file_item).unwrap().attachments[0].file_id;
            let dest = parent.path().join("tiny.lockbox-backup");
            vault.backup(&dest, &NoJournal, &cancel).unwrap();
            let secrets = [
                vault.id().to_hex(),
                note.to_hex(),
                file_item.to_hex(),
                file.to_hex(),
                VAULT_NAME.to_owned(),
                ITEM_TITLE.to_owned(),
                FILE_NAME.to_owned(),
            ];
            let archive = BackupArchive::open(&dest, &cancel).unwrap();
            let entries = archive
                .entries()
                .iter()
                .filter(|e| e.kind != EntryKind::Manifest)
                .map(|e| {
                    let mut bytes = Vec::new();
                    archive.reader(e).read_to_end(&mut bytes).unwrap();
                    (e.name.clone(), bytes)
                })
                .collect();
            drop(archive);
            Tiny {
                backup: fs::read(&dest).unwrap(),
                recovery: created.recovery.to_display().to_string(),
                secrets: secrets.map(|s| s.to_lowercase()).to_vec(),
                key: *vault.vault_key.as_bytes(),
                entries,
            }
        });

        /// Half the cases change the backup file anywhere, which the hash and structure checks
        /// stop. Half change one entry (the header, an item or the blob) and re-sign the
        /// manifest, so the changed bytes get past the hash check into the header MAC, the
        /// item decryption and the blob authentication.
        fn cases() -> impl Strategy<Value = Case> {
            let in_entry = (0..TINY.entries.len()).prop_flat_map(|i| {
                mutated(&TINY.entries[i].1, 3).prop_map(move |bytes| Case::Entry(i, bytes))
            });
            prop_oneof![mutated(&TINY.backup, 1).prop_map(Case::File), in_entry]
        }

        /// The 8-byte rule of `assert_text_is_fixed` against the whole backup file (with its
        /// allowlist of fixed words), and a check that nothing of the vault itself is named: its
        /// ID, the item and file IDs, its name, an item title or a file name, in `Display` or
        /// `Debug` text, in any letter case.
        fn check_text(error: &CoreError, input: &[u8]) -> std::result::Result<(), TestCaseError> {
            assert_text_is_fixed(error, input)?;
            let message = format!("{error} {error:?}").to_lowercase();
            for secret in &TINY.secrets {
                prop_assert!(
                    !message.contains(secret.as_str()),
                    "message {message:?} names something of the vault"
                );
            }
            Ok(())
        }

        #[test]
        fn the_tiny_backup_verifies() {
            let dir = TempDir::new();
            let path = dir.path().join("t.lockbox-backup");
            fs::write(&path, &TINY.backup).unwrap();
            let recovery = RecoverySecret::parse(&TINY.recovery).unwrap();
            let summary = verify(&path, Credential::Recovery(&recovery)).unwrap();
            assert_eq!((summary.items, summary.files), (2, 1));
        }

        proptest! {
            #![proptest_config(ProptestConfig::with_cases(256))]

            #[test]
            fn mutated_backup_never_panics(case in cases()) {
                let dir = TempDir::new();
                let path = dir.path().join("m.lockbox-backup");
                match case {
                    Case::File(bytes) => fs::write(&path, bytes).unwrap(),
                    Case::Entry(i, bytes) => {
                        fs::write(&path, &TINY.backup).unwrap();
                        let key = Key32::from_bytes(TINY.key);
                        let name = &TINY.entries[i].0;
                        let edit = |m: &mut BTreeMap<String, Vec<u8>>| {
                            m.insert(name.clone(), bytes);
                        };
                        rewrite_backup(&path, edit, ManifestMode::Rehash { key: Some(&key) });
                    }
                }
                // The input is the whole file the parsers read, so the entries a case leaves
                // unchanged and the re-signed manifest count as input too.
                let input = fs::read(&path).unwrap();
                let cancel = CancelToken::new();
                if let Err(error) = BackupArchive::open(&path, &cancel) {
                    check_text(&error, &input)?;
                }
                // The recovery key (HKDF), not the password (Argon2id at 64 MiB per case).
                let recovery = RecoverySecret::parse(&TINY.recovery).unwrap();
                if let Err(error) = verify_backup(&path, Credential::Recovery(&recovery), &cancel) {
                    check_text(&error, &input)?;
                }
            }
        }
    }
}
