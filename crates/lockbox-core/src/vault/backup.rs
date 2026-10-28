//! Making a backup (spec 6.7): one `.lockbox-backup` file holding `vault.json`, every
//! current item and the blobs those items attach, each blob authenticated as it is copied.
//! The file is built hidden beside the destination, re-read and checked against its
//! manifest, and only then renamed over the destination (spec 7.2, verify then publish).

use super::Vault;
use super::files::{FILES_DIR, attachments, blob_in, refuse_inside};
use super::naming::created_at_now;
use super::source::{ENTRY_HASH, blob_name, item_name};
use crate::archive::{ArchiveWriter, BackupArchive, copy_hashed};
use crate::blob::{CancelToken, OutputJournal, authenticate_copy};
use crate::fsio::{
    check_space, clear_hidden, create_hidden_file, hidden_temp_path, open_shared_read, parent_dir,
    read_retry, remove_file_retry, replace_file, volume_info,
};
use crate::header::{
    HEADER_FILE, MAX_HEADER_BYTES, parse_header, serialize_header, verify_header_mac,
};
use crate::ids::FileId;
use crate::item::{FileRef, Item, MAX_ITEM_FILE, open_item, same_item};
use crate::manifest::{
    BackupManifest, MANIFEST_FILE, MANIFEST_VERSION, MAX_ENTRIES, ManifestEntry,
    manifest_mac_cancellable, serialize_manifest,
};
use crate::{CoreError, Result};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, ErrorKind};
use std::path::Path;

const NOT_WRITABLE: CoreError = CoreError::InvalidInput {
    what: "destination not writable",
};
const HEADER_CHANGED: CoreError = CoreError::Damaged {
    what: "header changed on disk",
};
/// The finished temp does not read back as the manifest that was written. Its own text, apart
/// from the archive reader's "backup: manifest mismatch" for a malformed archive.
const MANIFEST_READBACK: CoreError = CoreError::Damaged {
    what: "backup: manifest readback",
};
/// Room per entry for its local header, central record and manifest line.
const PER_ENTRY: u64 = 512;
const SLACK: u64 = 64 * 1024;

pub(super) fn not_found(e: &CoreError) -> bool {
    matches!(e, CoreError::Io(e) if e.kind() == ErrorKind::NotFound)
}

/// What a backup holds and what it left out (spec 6.7).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct BackupReport {
    /// Items written.
    pub items: usize,
    /// Blobs written.
    pub files: usize,
    /// Bytes of `vault.json`, the item files and the blobs written (the manifest not counted).
    /// So it includes `vault.json`, which `BackupSummary::bytes` does not.
    pub bytes: u64,
    /// Items left out: damaged at unlock, or whose file no longer opens to the loaded revision.
    pub skipped_damaged_items: usize,
    /// Attached blobs left out because they failed authentication.
    pub skipped_damaged_files: usize,
    /// Attached blobs left out because they are not on disk.
    pub missing_files: usize,
}

#[cfg(test)]
thread_local! {
    /// Replaces [`MAX_ENTRIES`] on this thread, so the limit can be tested with a few items.
    static ENTRY_LIMIT: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
}

fn entry_limit() -> usize {
    #[cfg(test)]
    if let Some(limit) = ENTRY_LIMIT.with(|l| l.get()) {
        return limit;
    }
    MAX_ENTRIES
}

/// Refuses a `dest` that exists and could not simply be replaced: a folder, a link or a
/// read-only file.
fn check_destination(dest: &Path) -> Result<()> {
    match fs::symlink_metadata(dest) {
        Ok(m) if m.is_file() && !m.permissions().readonly() => Ok(()),
        Ok(_) => Err(NOT_WRITABLE),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Re-reads the finished temp: structure, the manifest as written, and every entry's
/// SHA-256. The archive, and with it the only handle on `temp`, is dropped on return.
fn verify(temp: &Path, manifest: &BackupManifest, cancel: &CancelToken) -> Result<()> {
    let archive = BackupArchive::open(temp, cancel)?;
    if archive.manifest() != manifest {
        return Err(MANIFEST_READBACK);
    }
    for m in &manifest.entries {
        let e = archive.entry(&m.path).ok_or(MANIFEST_READBACK)?;
        if copy_hashed(&mut archive.reader(e), e.size, &mut io::sink(), cancel)? != m.sha256 {
            return Err(ENTRY_HASH);
        }
    }
    Ok(())
}

/// Test hook: once the temp is written and closed, flips one data byte inside it, so the
/// re-read must catch it: in `vault.json` (`backup.corrupt_temp`) or in the first digit of the
/// manifest's `created_at` (`backup.corrupt_manifest`), which leaves the manifest valid JSON.
#[cfg(any(test, feature = "test-internals"))]
fn corrupt_if_armed(temp: &Path) -> Result<()> {
    use crate::fsio::failpoint;
    let header = failpoint::check("backup.corrupt_temp").is_err();
    let manifest = failpoint::check("backup.corrupt_manifest").is_err();
    if !header && !manifest {
        return Ok(());
    }
    let at = if header {
        let archive = BackupArchive::open(temp, &CancelToken::new())?;
        archive.entry(HEADER_FILE).ok_or(MANIFEST_READBACK)?.offset
    } else {
        // The manifest is the last entry, so its text is the last `created_at` in the file.
        let key = br#""created_at":""#;
        let bytes = fs::read(temp)?;
        let found = bytes.windows(key.len()).rposition(|w| w == key);
        (found.ok_or(MANIFEST_READBACK)? + key.len()) as u64
    };
    Ok(crate::fsio::testutil::flip_byte(temp, at)?)
}

impl Vault {
    /// Writes a backup of the open vault to `dest` (spec 6.7): built in a hidden temp beside
    /// it (recorded in `journal` before it exists), re-read and checked, then renamed over
    /// `dest`. A failed or cancelled backup never touches an existing `dest`.
    ///
    /// `&self` is deliberate: no vault write can run while a backup borrows the vault, so the
    /// snapshot is consistent. Refused while a header change awaits the user's OK, while the
    /// header copies disagree on a key slot, or while the header state is unknown; also when
    /// `vault.json` on disk is not the open header, which includes an unlock from
    /// `vault.json.bak` whose repair failed.
    pub fn backup(
        &self,
        dest: &Path,
        journal: &dyn OutputJournal,
        cancel: &CancelToken,
    ) -> Result<BackupReport> {
        self.refuse_backup()?;
        let folder = parent_dir(dest);
        refuse_inside(folder, &self.dir)?;
        check_destination(dest)?;
        let blobs = attachments(self.items.values());
        if self.items.len() + blobs.len() > entry_limit() {
            return Err(CoreError::TooLarge {
                what: "backup entries",
            });
        }
        let estimate = self.estimate(&blobs, cancel)?;
        check_space(estimate, estimate, &volume_info(folder)?)?;

        let temp = hidden_temp_path(folder, ".lockbox-backup-partial");
        journal.record(&temp);
        // Owned only once this succeeds; if the name is taken, the other file is not ours to delete.
        let file = match create_hidden_file(&temp) {
            Ok(file) => file,
            Err(error) => {
                journal.clear(&temp);
                return Err(error);
            }
        };
        let published = (|| {
            // Returns only after the writer and the file are dropped.
            let (manifest, report) = self.write_archive(file, cancel)?;
            #[cfg(any(test, feature = "test-internals"))]
            corrupt_if_armed(&temp)?;
            verify(&temp, &manifest, cancel)?;
            // Windows keeps a file's attributes when it replaces another: unhide first.
            clear_hidden(&temp)?;
            #[cfg(any(test, feature = "test-internals"))]
            crate::fsio::failpoint::check("backup.before_publish")?;
            // Last chance to stop: once the rename starts, publication completes.
            cancel.check()?;
            replace_file(&temp, dest)?;
            Ok(report)
        })();
        // Every handle on the temp is closed by now. Only a temp that is really gone leaves
        // the journal; otherwise launch cleanup retries.
        if published.is_ok() || remove_file_retry(&temp).is_ok() {
            journal.clear(&temp);
        }
        published
    }

    fn refuse_backup(&self) -> Result<()> {
        let refuse = |what| Err(CoreError::InvalidInput { what });
        if self.guard.consent_pending {
            return refuse("accept the header change first");
        }
        if self.guard.uncertain {
            return refuse("header state unknown; reopen the vault");
        }
        if !verify_header_mac(&self.header, &self.vault_key) {
            return refuse("accept the header change first");
        }
        if self.guard.unverified.is_some() {
            return refuse("header copies disagree; replace the unchecked credential first");
        }
        Ok(())
    }

    /// `vault.json`, every item file and every attached blob as they are on disk now, plus
    /// room for the archive's own records. A file that cannot be measured counts as empty.
    /// `cancel` is checked before each file is measured.
    fn estimate(&self, blobs: &BTreeMap<FileId, &FileRef>, cancel: &CancelToken) -> Result<u64> {
        let files = self.dir.join(FILES_DIR);
        let entries = (self.items.len() + blobs.len() + 2) as u64;
        let paths = std::iter::once(self.dir.join(HEADER_FILE))
            .chain(self.items.keys().map(|id| self.item_path(id)))
            .chain(blobs.keys().map(|id| blob_in(&files, id)));
        let mut total = entries
            .checked_mul(PER_ENTRY)
            .and_then(|n| n.checked_add(SLACK));
        for path in paths {
            cancel.check()?;
            let size = fs::metadata(path).map_or(0, |m| m.len());
            total = total.and_then(|sum| sum.checked_add(size));
        }
        total.ok_or(CoreError::TooLarge { what: "backup" })
    }

    /// The on-disk `vault.json`, which must hold exactly the open header.
    fn header_file(&self) -> Result<Vec<u8>> {
        let bytes = match read_retry(&self.dir.join(HEADER_FILE), MAX_HEADER_BYTES) {
            Err(e) if not_found(&e) => return Err(HEADER_CHANGED),
            other => other?,
        };
        let same = parse_header(&bytes)
            .is_ok_and(|h| serialize_header(&h) == serialize_header(&self.header));
        if !same {
            return Err(HEADER_CHANGED);
        }
        Ok(bytes)
    }

    /// The item file on disk, if it still opens to exactly the loaded `item` (every field, not
    /// only the revision: the blobs a backup carries come from the loaded item, so the file
    /// has to say the same).
    fn current_item_file(&self, item: &Item) -> Result<Option<Vec<u8>>> {
        let bytes = match read_retry(&self.item_path(&item.id), MAX_ITEM_FILE) {
            Err(e) if not_found(&e) => return Ok(None),
            other => other?,
        };
        let current = open_item(&bytes, &item.id, &self.header.vault_id, &self.vault_key)
            .is_ok_and(|on_disk| same_item(&on_disk, item));
        Ok(current.then_some(bytes))
    }

    /// Writes every entry and the signed manifest into `file`, then syncs and closes it.
    /// On an error the writer (and the file inside it) is dropped before this returns.
    fn write_archive(
        &self,
        file: File,
        cancel: &CancelToken,
    ) -> Result<(BackupManifest, BackupReport)> {
        let mut w = ArchiveWriter::new(file);
        let mut report = BackupReport {
            skipped_damaged_items: self.damaged.len(),
            ..BackupReport::default()
        };
        let mut entries = Vec::new();
        let mut listed = |path: String, size: u64, sha256, report: &mut BackupReport| {
            report.bytes += size;
            entries.push(ManifestEntry { path, size, sha256 });
        };

        let header = self.header_file()?;
        let size = header.len() as u64;
        let sha = w.add(HEADER_FILE, &mut &header[..], size, cancel)?;
        listed(HEADER_FILE.to_owned(), size, sha, &mut report);

        let mut included = Vec::new();
        for (id, item) in &self.items {
            cancel.check()?;
            let Some(bytes) = self.current_item_file(item)? else {
                report.skipped_damaged_items += 1;
                continue;
            };
            let name = item_name(id);
            let size = bytes.len() as u64;
            let sha = w.add(&name, &mut &bytes[..], size, cancel)?;
            listed(name, size, sha, &mut report);
            report.items += 1;
            included.push(item);
        }

        let files = self.dir.join(FILES_DIR);
        let vault_id = &self.header.vault_id;
        for (id, fref) in attachments(included.into_iter()) {
            let mut src = match open_shared_read(&blob_in(&files, &id)) {
                Err(e) if not_found(&e) => {
                    report.missing_files += 1;
                    continue;
                }
                other => other?,
            };
            let size = src.metadata()?.len();
            let name = blob_name(&id);
            let copied = w.add_with(&name, |dst| {
                authenticate_copy(&mut src, size, &mut &mut *dst, vault_id, fref, cancel)
            })?;
            match copied {
                Some(sha) => {
                    listed(name, size, sha, &mut report);
                    report.files += 1;
                }
                None => report.skipped_damaged_files += 1,
            }
        }

        let mut manifest = BackupManifest {
            manifest_version: MANIFEST_VERSION,
            vault_id: *vault_id,
            created_at: created_at_now(),
            entries,
            mac: None,
        };
        manifest.mac = Some(manifest_mac_cancellable(
            &manifest,
            &self.vault_key,
            cancel,
        )?);
        let bytes = serialize_manifest(&manifest);
        w.add(MANIFEST_FILE, &mut &bytes[..], bytes.len() as u64, cancel)?;
        let file = w.finish()?;
        file.sync_all()?;
        drop(file); // Windows cannot replace or delete a file that is still open.
        Ok((manifest, report))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CoreError;
    use crate::archive::BackupArchive;
    use crate::blob::NoJournal;
    use crate::fsio::testutil::{TempDir, names};
    use crate::fsio::{VolumeInfo, failpoint, set_volume_override};
    use crate::header::{HEADER_FILE, parse_header, serialize_header};
    use crate::ids::{FileId, ItemId};
    use crate::item::{ItemKind, seal_item};
    use crate::manifest::verify_manifest_mac;
    use crate::vault::{Credential, verify_backup};
    use std::cell::RefCell;
    use std::fs;
    use std::path::PathBuf;

    const PW: &str = "correct horse battery";
    const MIB: usize = 1 << 20;

    /// Always resets, so a failing test cannot leak a failpoint, volume or limit on this thread.
    struct Cleanup;
    impl Drop for Cleanup {
        fn drop(&mut self) {
            failpoint::disarm_all();
            set_volume_override(None);
            ENTRY_LIMIT.with(|l| l.set(None));
        }
    }

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

    impl Recorder {
        /// Asserts one `record` then one `clear` of the same backup temp.
        #[track_caller]
        fn assert_recorded_then_cleared(&self) {
            let calls = self.0.borrow();
            assert_eq!(
                calls.iter().map(|c| c.0).collect::<Vec<_>>(),
                ["record", "clear"]
            );
            assert_eq!(calls[0].1, calls[1].1);
            let name = calls[0].1.file_name().unwrap().to_string_lossy();
            assert!(name.ends_with(".lockbox-backup-partial"), "{name}");
        }
    }

    fn new_vault() -> (TempDir, Vault) {
        let parent = TempDir::new();
        let vault = Vault::create(parent.path(), "Family", PW).unwrap().vault;
        (parent, vault)
    }

    /// A folder beside the vault to back up into.
    fn out_dir(parent: &TempDir) -> PathBuf {
        let out = parent.path().join("out");
        fs::create_dir(&out).unwrap();
        out
    }

    /// Adds a file item holding `bytes`; returns the item's and the file's IDs.
    fn file_item(parent: &TempDir, vault: &mut Vault, bytes: &[u8]) -> (ItemId, FileId) {
        let src = parent.path().join("src.bin");
        fs::write(&src, bytes).unwrap();
        let id = vault
            .new_file_item(None, &src, &CancelToken::new())
            .unwrap();
        (id, vault.get_item(&id).unwrap().attachments[0].file_id)
    }

    fn attach(parent: &TempDir, vault: &mut Vault, item: &ItemId, bytes: &[u8]) -> FileId {
        let src = parent.path().join("attach.bin");
        fs::write(&src, bytes).unwrap();
        vault.attach_file(item, &src, &CancelToken::new()).unwrap()
    }

    fn blob_file(vault: &Vault, id: &FileId) -> PathBuf {
        vault
            .dir()
            .join("files")
            .join(format!("{}.blob", id.to_hex()))
    }

    fn item_entry(id: &ItemId) -> String {
        format!("items/{}.item", id.to_hex())
    }

    fn blob_entry(id: &FileId) -> String {
        format!("files/{}.blob", id.to_hex())
    }

    /// The archive's entry names (manifest excluded), sorted; opening it must succeed.
    fn entry_names(path: &Path) -> Vec<String> {
        let archive = BackupArchive::open(path, &CancelToken::new()).unwrap();
        archive.entries().iter().map(|e| e.name.clone()).collect()
    }

    fn sorted(mut v: Vec<String>) -> Vec<String> {
        v.sort();
        v
    }

    #[track_caller]
    fn refused<T: std::fmt::Debug>(r: Result<T>) -> &'static str {
        match r {
            Err(CoreError::InvalidInput { what }) => what,
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    fn flip(path: &Path, at: usize) {
        let mut bytes = fs::read(path).unwrap();
        bytes[at] ^= 1;
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn backup_round_trip_contents() {
        let (parent, mut vault) = new_vault();
        vault.new_item(ItemKind::Note, "a", None).unwrap();
        let login = ItemKind::Login {
            username: "u".to_owned(),
            password: zeroize::Zeroizing::new("p".to_owned()),
            urls: Vec::new(),
        };
        vault.new_item(login, "b", None).unwrap();
        let (id, empty) = file_item(&parent, &mut vault, b"");
        let large = attach(&parent, &mut vault, &id, &vec![7u8; 3 * MIB + 7]);
        let dest = parent.path().join("v.lockbox-backup");

        let report = vault
            .backup(&dest, &NoJournal, &CancelToken::new())
            .unwrap();

        let archive = BackupArchive::open(&dest, &CancelToken::new()).unwrap();
        let mut expected = vec![HEADER_FILE.to_owned()];
        expected.extend(vault.items().map(|i| item_entry(&i.id)));
        expected.extend([blob_entry(&empty), blob_entry(&large)]);
        let got: Vec<String> = archive.entries().iter().map(|e| e.name.clone()).collect();
        assert_eq!(got, sorted(expected));
        assert!(verify_manifest_mac(archive.manifest(), &vault.vault_key));
        assert_eq!(archive.manifest().vault_id, vault.id());
        assert_eq!(
            report,
            BackupReport {
                items: 3,
                files: 2,
                bytes: archive.total_size(),
                ..BackupReport::default()
            }
        );
        // The entries are the vault's own files, byte for byte.
        let header = archive.entry(HEADER_FILE).unwrap();
        assert_eq!(
            archive.read_entry(header).unwrap(),
            fs::read(vault.dir().join(HEADER_FILE)).unwrap()
        );
        let size = |e: &str| archive.entry(e).unwrap().size;
        assert_eq!(
            size(&blob_entry(&large)),
            fs::metadata(blob_file(&vault, &large)).unwrap().len()
        );
    }

    #[test]
    fn leaves_out_orphans_retired_and_damaged_items() {
        let cancel = CancelToken::new();
        let (parent, mut vault) = new_vault();
        let (keep, retired) = file_item(&parent, &mut vault, b"first");
        let second = parent.path().join("second.bin");
        fs::write(&second, b"second").unwrap();
        let current = vault
            .replace_attachment(&keep, &retired, &second, &cancel)
            .unwrap();
        // An item whose file is damaged after unlock: neither it nor its blob goes in.
        let (broken, _) = file_item(&parent, &mut vault, b"broken's file");
        let broken_file = vault.item_path(&broken);
        flip(
            &broken_file,
            fs::metadata(&broken_file).unwrap().len() as usize / 2,
        );
        let orphaned = vault.dir().join("files").join("orphaned");
        fs::write(
            orphaned.join(format!("{}.blob", FileId::random().to_hex())),
            b"orphan",
        )
        .unwrap();
        assert!(blob_file(&vault, &retired).exists());
        let dest = parent.path().join("v.lockbox-backup");
        let expected = sorted(vec![
            HEADER_FILE.to_owned(),
            item_entry(&keep),
            blob_entry(&current),
        ]);

        let report = vault.backup(&dest, &NoJournal, &cancel).unwrap();
        assert_eq!(entry_names(&dest), expected);
        assert_eq!(
            (report.items, report.files, report.skipped_damaged_items),
            (1, 1, 1)
        );

        // Reopened, the item is listed as damaged at unlock, and still left out.
        let dir = vault.dir().to_path_buf();
        drop(vault);
        let (vault, _) = Vault::unlock_with_password(&dir, PW).unwrap();
        assert_eq!(vault.damaged_items(), [broken]);
        let report = vault.backup(&dest, &NoJournal, &cancel).unwrap();
        assert_eq!(entry_names(&dest), expected);
        assert_eq!(
            (report.items, report.files, report.skipped_damaged_items),
            (1, 1, 1)
        );
    }

    /// Review Focus 5, first part. The damage is in the second chunk, so the entry is aborted
    /// after part of it was written; the next blob still lands where the reader expects it.
    #[test]
    fn damaged_blob_left_out() {
        let (parent, mut vault) = new_vault();
        let (id, bad) = file_item(&parent, &mut vault, &vec![1u8; 2 * MIB]);
        let good = attach(&parent, &mut vault, &id, b"good");
        flip(&blob_file(&vault, &bad), MIB + 100);
        let dest = parent.path().join("v.lockbox-backup");

        let report = vault
            .backup(&dest, &NoJournal, &CancelToken::new())
            .unwrap();
        assert_eq!(
            (
                report.items,
                report.files,
                report.skipped_damaged_files,
                report.missing_files
            ),
            (1, 1, 1, 0)
        );
        let entries = entry_names(&dest);
        assert!(entries.contains(&blob_entry(&good)));
        assert!(!entries.contains(&blob_entry(&bad)));
    }

    #[test]
    fn missing_attached_blob_is_counted() {
        let (parent, mut vault) = new_vault();
        let (id, file) = file_item(&parent, &mut vault, b"gone");
        fs::remove_file(blob_file(&vault, &file)).unwrap();
        let dest = parent.path().join("v.lockbox-backup");

        let report = vault
            .backup(&dest, &NoJournal, &CancelToken::new())
            .unwrap();
        assert_eq!(
            (report.items, report.files, report.missing_files),
            (1, 0, 1)
        );
        assert_eq!(
            entry_names(&dest),
            sorted(vec![HEADER_FILE.to_owned(), item_entry(&id)])
        );
    }

    /// An item file that opens and has the loaded revision but holds other content (here, the
    /// attachment of another item) is not what the vault shows: it is left out, and the backup
    /// still verifies. Forged with the vault's own key, so only a full comparison catches it.
    #[test]
    fn disk_item_that_differs_at_the_same_revision_is_left_out() {
        let (parent, mut vault) = new_vault();
        let (swapped, _) = file_item(&parent, &mut vault, b"first");
        let (other, _) = file_item(&parent, &mut vault, b"second");
        let mut forged = vault.get_item(&swapped).unwrap().clone();
        forged.attachments = vault.get_item(&other).unwrap().attachments.clone();
        assert_eq!(forged.revision, vault.get_item(&swapped).unwrap().revision);
        let sealed = seal_item(&forged, &vault.header.vault_id, &vault.vault_key).unwrap();
        fs::write(vault.item_path(&swapped), sealed).unwrap();
        let dest = parent.path().join("v.lockbox-backup");

        let report = vault
            .backup(&dest, &NoJournal, &CancelToken::new())
            .unwrap();
        assert_eq!(
            (report.items, report.files, report.skipped_damaged_items),
            (1, 1, 1)
        );
        assert!(!entry_names(&dest).contains(&item_entry(&swapped)));
        let summary = verify_backup(&dest, Credential::Password(PW), &CancelToken::new()).unwrap();
        assert_eq!((summary.items, summary.files), (1, 1));
    }

    /// Unlocks after `edit` changed the closed vault's `vault.json`, then backs up into an
    /// empty folder. Returns what the backup was refused with; asserts nothing was written.
    fn refused_after(edit: impl FnOnce(&mut crate::header::VaultHeader)) -> &'static str {
        let (parent, vault) = new_vault();
        let dir = vault.dir().to_path_buf();
        drop(vault);
        let path = dir.join(HEADER_FILE);
        let mut header = parse_header(&fs::read(&path).unwrap()).unwrap();
        edit(&mut header);
        fs::write(&path, serialize_header(&header)).unwrap();
        let (vault, _) = Vault::unlock_with_password(&dir, PW).unwrap();
        let out = out_dir(&parent);
        let journal = Recorder::default();
        let what =
            refused(vault.backup(&out.join("v.lockbox-backup"), &journal, &CancelToken::new()));
        assert!(names(&out).is_empty());
        assert!(journal.0.borrow().is_empty());
        what
    }

    #[test]
    fn refused_while_header_change_pending() {
        let what = refused_after(|h| h.name = "Renamed".to_owned());
        assert_eq!(what, "accept the header change first");
    }

    #[test]
    fn refused_while_header_copies_disagree() {
        let what = refused_after(|h| h.slots[1].ciphertext[0] ^= 1);
        assert_eq!(
            what,
            "header copies disagree; replace the unchecked credential first"
        );
    }

    /// A failed header write that leaves the on-disk state unknown blocks backups too.
    #[test]
    fn refused_while_header_state_unknown() {
        let _cleanup = Cleanup;
        let (parent, vault) = new_vault();
        let dir = vault.dir().to_path_buf();
        drop(vault);
        let path = dir.join(HEADER_FILE);
        let mut header = parse_header(&fs::read(&path).unwrap()).unwrap();
        header.slots[0].ciphertext[0] ^= 1;
        fs::write(&path, serialize_header(&header)).unwrap();
        failpoint::arm("unlock.repair_write");
        let (mut vault, _) = Vault::unlock_with_password(&dir, PW).unwrap();
        failpoint::disarm_all();
        failpoint::arm("write_headers.before_first");
        assert!(vault.change_password("a different long password").is_err());
        failpoint::disarm_all();
        assert!(vault.guard.uncertain);

        let out = out_dir(&parent);
        let journal = Recorder::default();
        let what =
            refused(vault.backup(&out.join("v.lockbox-backup"), &journal, &CancelToken::new()));
        assert_eq!(what, "header state unknown; reopen the vault");
        assert!(names(&out).is_empty());
        assert!(journal.0.borrow().is_empty());
    }

    #[test]
    fn too_many_entries_refused() {
        let _cleanup = Cleanup;
        ENTRY_LIMIT.with(|l| l.set(Some(3)));
        let (parent, mut vault) = new_vault();
        vault.new_item(ItemKind::Note, "a", None).unwrap();
        file_item(&parent, &mut vault, b"x");
        let report = vault
            .backup(
                &parent.path().join("ok.lockbox-backup"),
                &NoJournal,
                &CancelToken::new(),
            )
            .unwrap();
        assert_eq!((report.items, report.files), (2, 1));

        vault.new_item(ItemKind::Note, "b", None).unwrap();
        let out = out_dir(&parent);
        let journal = Recorder::default();
        let result = vault.backup(&out.join("v.lockbox-backup"), &journal, &CancelToken::new());
        assert!(matches!(
            result,
            Err(CoreError::TooLarge {
                what: "backup entries"
            })
        ));
        assert!(names(&out).is_empty());
        assert!(journal.0.borrow().is_empty());
    }

    #[test]
    fn destination_inside_vault_refused() {
        let (_parent, vault) = new_vault();
        let before = names(vault.dir());
        let journal = Recorder::default();
        let inside = [
            vault.dir().join("v.lockbox-backup"),
            vault.dir().join("files").join("v.lockbox-backup"),
            vault
                .dir()
                .join("items")
                .join("..")
                .join("v.lockbox-backup"),
        ];
        for dest in &inside {
            assert_eq!(
                refused(vault.backup(dest, &journal, &CancelToken::new())),
                "destination inside vault"
            );
        }
        assert_eq!(names(vault.dir()), before);
        assert!(journal.0.borrow().is_empty());
    }

    #[test]
    fn space_checked_first() {
        let _cleanup = Cleanup;
        let (parent, mut vault) = new_vault();
        let note = vault.new_item(ItemKind::Note, "a", None).unwrap();
        let (id, file) = file_item(&parent, &mut vault, &[5u8; 10_000]);
        let out = out_dir(&parent);
        let dest = out.join("v.lockbox-backup");
        fs::write(&dest, b"OLD").unwrap();
        let journal = Recorder::default();

        // Worked out here from the files on disk: vault.json, 2 item files, one blob, plus
        // 512 bytes for each of the 5 entries (manifest included) and 64 KiB.
        let len = |p: PathBuf| fs::metadata(p).unwrap().len();
        let blob = len(blob_file(&vault, &file));
        assert_eq!(blob, crate::blob::blob_len(10_000));
        let estimate = len(vault.dir().join(HEADER_FILE))
            + len(vault.item_path(&note))
            + len(vault.item_path(&id))
            + blob
            + 5 * 512
            + 64 * 1024;
        // `check_space` keeps a 64 MiB margin on top of what is needed.
        let just_enough = estimate + 64 * MIB as u64;
        let volume = |free_bytes, max_file_bytes| {
            set_volume_override(Some(VolumeInfo {
                free_bytes: Some(free_bytes),
                max_file_bytes,
            }))
        };

        volume(just_enough - 1, None);
        let result = vault.backup(&dest, &journal, &CancelToken::new());
        assert!(
            matches!(result, Err(CoreError::NotEnoughSpace { needed, available })
                if needed == estimate && available == just_enough - 1),
            "{result:?}"
        );

        // Stands in for FAT32's 4 GiB file limit: the estimate alone is over 64 KiB.
        volume(u64::MAX, Some(1024));
        let result = vault.backup(&dest, &journal, &CancelToken::new());
        assert!(matches!(result, Err(CoreError::FileSystemLimit { .. })));

        assert_eq!(names(&out), ["v.lockbox-backup"]);
        assert_eq!(fs::read(&dest).unwrap(), b"OLD");
        assert!(journal.0.borrow().is_empty());

        // Exactly enough room: the backup goes ahead.
        volume(just_enough, Some(estimate));
        let report = vault.backup(&dest, &journal, &CancelToken::new()).unwrap();
        assert_eq!((report.items, report.files), (2, 1));
        assert_eq!(names(&out), ["v.lockbox-backup"]);
    }

    /// Review Focus 3: an existing backup stays byte-identical until the new one verified.
    #[test]
    fn existing_destination_kept_until_verified() {
        let _cleanup = Cleanup;
        let (parent, vault) = new_vault();
        let out = out_dir(&parent);
        let dest = out.join("v.lockbox-backup");
        fs::write(&dest, b"OLD").unwrap();

        let journal = Recorder::default();
        failpoint::arm("backup.before_publish");
        let result = vault.backup(&dest, &journal, &CancelToken::new());
        failpoint::disarm_all();
        assert!(matches!(result, Err(CoreError::Io(_))));
        assert_eq!(fs::read(&dest).unwrap(), b"OLD");
        assert_eq!(names(&out), ["v.lockbox-backup"], "no temp left");
        journal.assert_recorded_then_cleared();

        vault
            .backup(&dest, &NoJournal, &CancelToken::new())
            .unwrap();
        assert_eq!(entry_names(&dest), [HEADER_FILE]);
        assert_eq!(names(&out), ["v.lockbox-backup"]);
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            let attrs = fs::metadata(&dest).unwrap().file_attributes();
            assert_eq!(attrs & 0x2, 0, "published backup is hidden");
        }
    }

    /// Review Focus 3: a destination that could never be replaced fails before any temp.
    #[test]
    fn unusable_destination_refused_up_front() {
        let (parent, vault) = new_vault();
        let out = out_dir(&parent);
        let folder = out.join("folder.lockbox-backup");
        fs::create_dir(&folder).unwrap();
        // Windows cannot replace a read-only file, so only there is it an unusable destination.
        let read_only = cfg!(windows).then(|| {
            let path = out.join("ro.lockbox-backup");
            fs::write(&path, b"OLD").unwrap();
            let mut perms = fs::metadata(&path).unwrap().permissions();
            perms.set_readonly(true);
            fs::set_permissions(&path, perms).unwrap();
            path
        });
        let unusable: Vec<PathBuf> = std::iter::once(folder).chain(read_only.clone()).collect();
        let before = names(&out);
        let journal = Recorder::default();
        for dest in &unusable {
            assert_eq!(
                refused(vault.backup(dest, &journal, &CancelToken::new())),
                "destination not writable"
            );
        }
        assert_eq!(names(&out), before);
        assert!(journal.0.borrow().is_empty());
        if let Some(path) = &read_only {
            crate::fsio::remove_file_retry(path).unwrap();
        }
    }

    #[test]
    fn cancel_mid_blob_stops() {
        let _cleanup = Cleanup;
        let (parent, mut vault) = new_vault();
        file_item(&parent, &mut vault, &vec![3u8; 50 * MIB]);
        let out = out_dir(&parent);
        let token = CancelToken::new();
        failpoint::arm_cancel("tee.after_chunk", token.clone());
        let journal = Recorder::default();

        let result = vault.backup(&out.join("v.lockbox-backup"), &journal, &token);
        assert!(matches!(result, Err(CoreError::Cancelled)));
        assert!(names(&out).is_empty(), "no temp left");
        journal.assert_recorded_then_cleared();
    }

    /// The cancel is seen while the space estimate stats the files, before any temp exists.
    #[test]
    fn cancel_during_the_space_estimate_stops_before_any_temp() {
        let (parent, mut vault) = new_vault();
        file_item(&parent, &mut vault, b"x");
        let out = out_dir(&parent);
        let token = CancelToken::new();
        token.cancel();
        let journal = Recorder::default();

        let result = vault.backup(&out.join("v.lockbox-backup"), &journal, &token);
        assert!(matches!(result, Err(CoreError::Cancelled)));
        assert!(names(&out).is_empty());
        assert!(journal.0.borrow().is_empty(), "no temp was ever named");
    }

    /// Signing the manifest checks the cancel too: stopped there, nothing is published.
    #[test]
    fn cancel_while_signing_the_manifest_stops() {
        let _cleanup = Cleanup;
        let (parent, mut vault) = new_vault();
        file_item(&parent, &mut vault, b"x");
        let out = out_dir(&parent);
        let token = CancelToken::new();
        failpoint::arm_cancel("manifest.mac_piece", token.clone());
        let journal = Recorder::default();

        let result = vault.backup(&out.join("v.lockbox-backup"), &journal, &token);
        assert!(matches!(result, Err(CoreError::Cancelled)));
        assert!(names(&out).is_empty(), "no temp left");
        journal.assert_recorded_then_cleared();
    }

    /// Both read-back failures publish nothing, and an existing destination is left as it was.
    #[test]
    fn verify_failure_never_publishes() {
        let _cleanup = Cleanup;
        let (parent, mut vault) = new_vault();
        file_item(&parent, &mut vault, b"x");
        let out = out_dir(&parent);
        let dest = out.join("v.lockbox-backup");
        for (failpoint_name, what) in [
            ("backup.corrupt_temp", "backup: entry hash"),
            ("backup.corrupt_manifest", "backup: manifest readback"),
        ] {
            for old in [false, true] {
                if old {
                    fs::write(&dest, b"OLD").unwrap();
                }
                let journal = Recorder::default();
                failpoint::arm(failpoint_name);

                let result = vault.backup(&dest, &journal, &CancelToken::new());
                failpoint::disarm_all();
                assert!(
                    matches!(result, Err(CoreError::Damaged { what: w }) if w == what),
                    "{failpoint_name}: {result:?}"
                );
                if old {
                    assert_eq!(fs::read(&dest).unwrap(), b"OLD");
                    assert_eq!(names(&out), ["v.lockbox-backup"], "no temp left");
                    fs::remove_file(&dest).unwrap();
                } else {
                    assert!(names(&out).is_empty(), "nothing published, no temp left");
                }
                journal.assert_recorded_then_cleared();
            }
        }
    }
}
