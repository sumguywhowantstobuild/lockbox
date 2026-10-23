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
    /// Item files that did not open.
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
/// [`check_opened`].
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
        #[cfg(test)]
        crate::fsio::failpoint::check("source.item")?;
        cancel.check()?;
        let bytes = src.item_bytes(&id)?;
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
}
