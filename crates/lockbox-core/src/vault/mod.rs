//! The vault's life cycle (spec 5.3, 6.3): create, unlock, change password, regenerate
//! the recovery key. Items and files are added on top of [`Vault`] by later modules.

mod cleanup;
mod files;
mod items;
mod naming;
mod unlock;

use crate::fsio;
use crate::header::{
    CONTAINER_VERSION, HEADER_FILE, VaultHeader, header_mac, write_headers,
    write_headers_backup_first,
};
use crate::ids::{ItemId, VaultId};
use crate::item::Item;
use crate::kdf::{Argon2Params, check_new_password, derive_password_key};
use crate::lockfile::VaultLock;
use crate::recovery::{RecoverySecret, derive_recovery_key};
use crate::search::SearchIndex;
use crate::secret::{Key32, random_bytes};
use crate::slots::{KeySlot, SlotType, wrap_slot};
use crate::{CoreError, Result};
use naming::{created_at_now, validate_name};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use unlock::Credential;

pub(crate) use naming::folder_name;
pub use unlock::read_vault_name;

/// How long one password check should take on this machine.
const KDF_TARGET: Duration = Duration::from_secs(1);
const STAGING_PREFIX: &str = ".creating-";

/// What the cleanup at unlock did (spec 6.4). Cleanup never fails an unlock: anything it
/// could not do is counted in `failed` and tried again at the next unlock.
#[derive(Debug, Default)]
pub struct CleanupReport {
    /// `*.partial` files removed (interrupted imports).
    pub partials_removed: usize,
    /// `*.tmp` files removed (interrupted writes).
    pub temps_removed: usize,
    /// Entries cleared from `retired_blobs` lists (the blob is deleted, or no longer exists).
    pub retired_deleted: usize,
    /// Items whose interrupted purge was finished.
    pub purges_finished: usize,
    /// Unreferenced blobs moved to `files/orphaned/` (never deleted).
    pub orphans_quarantined: usize,
    /// Quarantined blobs that an item references again, moved back to `files/`.
    pub orphans_restored: usize,
    /// Damaged item files: when not zero, no blob was quarantined.
    pub skipped_damaged: usize,
    /// Actions that failed and will be tried again at the next unlock.
    pub failed: usize,
}

/// What unlocking noticed. The caller shows a warning for each flag that is set.
#[derive(Debug)]
pub struct UnlockReport {
    /// `vault.json` could not be used, so the vault opened from `vault.json.bak`
    /// (which may still need the previous password).
    pub used_backup_header: bool,
    /// The header was changed outside Lockbox; see [`Vault::accept_header`].
    pub header_mac_mismatch: bool,
    /// The other header copy needed repair but writing it failed (disk full, read-only
    /// media). The vault is open anyway; the next unlock retries the repair.
    pub header_repair_failed: bool,
    pub cleanup: CleanupReport,
}

/// A new vault, open, with the recovery secret to show the user once.
#[derive(Debug)]
pub struct CreatedVault {
    pub vault: Vault,
    pub recovery: RecoverySecret,
}

/// An open vault. Holds the vault's lock until dropped, and the vault key (wiped on drop).
#[derive(Debug)]
pub struct Vault {
    dir: PathBuf,
    header: VaultHeader,
    vault_key: Arc<Key32>,
    /// Every item that opened at unlock, trashed ones included.
    items: BTreeMap<ItemId, Item>,
    /// Search entries for `items`; rebuilt by `reindex` after every change to them.
    index: SearchIndex,
    /// Item files that did not open; never deleted or overwritten.
    damaged: Vec<ItemId>,
    _lock: VaultLock,
}

impl Vault {
    /// Creates a vault named `name` in a new folder inside `parent`. All or nothing: the
    /// folder is built under a hidden name and renamed into place once complete, so a
    /// failure leaves only a staging folder, which the next `create` in `parent` removes.
    pub fn create(parent: &Path, name: &str, password: &str) -> Result<CreatedVault> {
        Self::create_with_id(parent, name, password, VaultId::random())
    }

    fn create_with_id(
        parent: &Path,
        name: &str,
        password: &str,
        id: VaultId,
    ) -> Result<CreatedVault> {
        validate_name(name)?;
        check_new_password(password)?;

        let vault_key = Key32::random();
        let params = Argon2Params::calibrate(KDF_TARGET);
        let (password_salt, recovery_salt) = (random_bytes::<16>(), random_bytes::<16>());
        let password_key = derive_password_key(password, &password_salt, &params)?;
        let recovery = RecoverySecret::generate();
        let recovery_key = derive_recovery_key(&recovery, &recovery_salt);
        let mut header = VaultHeader {
            container_version: CONTAINER_VERSION,
            vault_id: id,
            name: name.to_owned(),
            slots: vec![
                wrap_slot(
                    SlotType::Password,
                    &id,
                    password_salt,
                    Some(params),
                    &password_key,
                    &vault_key,
                ),
                wrap_slot(
                    SlotType::Recovery,
                    &id,
                    recovery_salt,
                    None,
                    &recovery_key,
                    &vault_key,
                ),
            ],
            migration: None,
            created_at: created_at_now(),
            header_mac: None,
        };
        header.header_mac = Some(header_mac(&header, &vault_key));

        remove_stale_staging(parent)?;
        // Any random 32 hex characters will do; a vault ID is what is at hand.
        let staging = parent.join(format!("{STAGING_PREFIX}{}", VaultId::random().to_hex()));
        fs::create_dir(&staging)?;
        fsio::set_hidden(&staging)?;
        fs::create_dir(staging.join("items"))?;
        fs::create_dir_all(staging.join("files").join("orphaned"))?;
        write_headers(&staging, &header)?;
        fsio::sync_dir(&staging)?;
        #[cfg(test)]
        fsio::failpoint::check("create.before_rename")?;

        // The final folder must not be hidden (Windows keeps a folder's attributes when it is renamed).
        let dir = parent.join(folder_name(name, &id));
        fsio::clear_hidden(&staging)?;
        if let Err(e) = fsio::rename_dir_no_replace(&staging, &dir) {
            let _ = fsio::set_hidden(&staging); // best effort: only keeps the leftover out of sight
            return Err(e);
        }
        // shortcut: if another instance opens the brand-new folder in this instant, create returns Err after publishing; the password still unlocks and recovery can be regenerated — revisit if create gets a UI retry.
        let vault = Vault {
            _lock: VaultLock::acquire(&dir)?,
            dir,
            header,
            vault_key: Arc::new(vault_key),
            items: BTreeMap::new(),
            index: SearchIndex::default(),
            damaged: Vec::new(),
        };
        Ok(CreatedVault { vault, recovery })
    }

    pub fn unlock_with_password(dir: &Path, password: &str) -> Result<(Vault, UnlockReport)> {
        unlock::open(dir, Credential::Password(password))
    }

    pub fn unlock_with_recovery(
        dir: &Path,
        secret: &RecoverySecret,
    ) -> Result<(Vault, UnlockReport)> {
        unlock::open(dir, Credential::Recovery(secret))
    }

    /// Sets a new password (checked against the minimum length) with a fresh salt. The
    /// vault key and the recovery slot stay as they are.
    ///
    /// An `Err` may leave `vault.json.bak` one version behind: the old password may then
    /// still open the vault, from `.bak`, until the next successful unlock repairs it.
    pub fn change_password(&mut self, new_password: &str) -> Result<()> {
        check_new_password(new_password)?;
        let old = self
            .header
            .slots
            .iter()
            .find(|s| s.slot_type == SlotType::Password);
        // Same cost settings as before: they were calibrated for this vault and are in bounds.
        let params = old
            .and_then(|slot| slot.kdf)
            .ok_or(CoreError::Damaged { what: "key slots" })?;
        let salt = random_bytes::<16>();
        let key = derive_password_key(new_password, &salt, &params)?;
        let slot = wrap_slot(
            SlotType::Password,
            &self.header.vault_id,
            salt,
            Some(params),
            &key,
            &self.vault_key,
        );
        self.replace_slot(slot, write_headers)
    }

    /// Replaces the recovery secret; the old one stops working. Returns the new one, to
    /// be shown to the user once.
    ///
    /// `vault.json.bak` is written first, so `vault.json` never holds a secret that was
    /// not delivered. An `Err` therefore leaves the old secret working, but after a
    /// failure on `vault.json`, `.bak` may hold an undelivered recovery slot until the next
    /// recovery unlock or header write. If `vault.json` is lost before then, the vault
    /// opens with the password only, and recovery must be regenerated.
    pub fn regenerate_recovery(&mut self) -> Result<RecoverySecret> {
        let secret = RecoverySecret::generate();
        let salt = random_bytes::<16>();
        let slot = wrap_slot(
            SlotType::Recovery,
            &self.header.vault_id,
            salt,
            None,
            &derive_recovery_key(&secret, &salt),
            &self.vault_key,
        );
        self.replace_slot(slot, write_headers_backup_first)?;
        Ok(secret)
    }

    /// Writes the header with `slot` in place of the slot of the same type, using `write`
    /// to pick the file order, then removes leftover `*.tmp` files (which may hold the old slot).
    fn replace_slot(
        &mut self,
        slot: KeySlot,
        write: fn(&Path, &VaultHeader) -> Result<()>,
    ) -> Result<()> {
        let mut header = self.header.clone();
        let target = header
            .slots
            .iter_mut()
            .find(|s| s.slot_type == slot.slot_type)
            .ok_or(CoreError::Damaged { what: "key slots" })?;
        *target = slot;
        self.commit(header, write)?;
        remove_leftover_tmp(&self.dir);
        Ok(())
    }

    /// Accepts a header changed outside Lockbox (after [`UnlockReport::header_mac_mismatch`]):
    /// signs the current header again and saves it. Call only after the user agreed.
    pub fn accept_header(&mut self) -> Result<()> {
        let mut header = self.header.clone();
        header.header_mac = Some(header_mac(&header, &self.vault_key));
        self.commit(header, write_headers)
    }

    /// Writes `header` and makes it the live one. If the write fails part-way, the live
    /// header becomes whatever `vault.json` now holds (the primary is the truth), so a
    /// later change never rebuilds from a header that no file has.
    fn commit(
        &mut self,
        header: VaultHeader,
        write: fn(&Path, &VaultHeader) -> Result<()>,
    ) -> Result<()> {
        match write(&self.dir, &header) {
            Ok(()) => {
                self.header = header;
                Ok(())
            }
            Err(e) => {
                if let Ok(on_disk) = unlock::load(&self.dir.join(HEADER_FILE)) {
                    self.header = on_disk.header;
                }
                Err(e)
            }
        }
    }

    pub fn name(&self) -> &str {
        &self.header.name
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn id(&self) -> VaultId {
        self.header.vault_id
    }

    /// Items matching `q`, best first, at most `limit` (see [`SearchIndex::query`]).
    pub fn search(&self, q: &str, limit: usize) -> Vec<ItemId> {
        self.index.query(q, limit)
    }

    /// Rebuilds the whole search index. Call after every change to `items`: a collection
    /// rename then reaches its members without any per-entry bookkeeping.
    fn reindex(&mut self) {
        self.index = SearchIndex::build(self.items.values());
    }
}

/// Removes folders named exactly `.creating-` plus 32 lowercase hex characters: the
/// staging folders of vaults whose creation never finished. Nothing else is touched.
// shortcut: two Lockbox instances creating vaults in the same parent at the same moment could
// remove each other's staging folder; upgrade if concurrent creation ever becomes possible.
fn remove_stale_staging(parent: &Path) -> Result<()> {
    for entry in fs::read_dir(parent)? {
        let entry = entry?;
        let name = entry.file_name();
        let is_staging = name.to_str().is_some_and(|n| {
            n.strip_prefix(STAGING_PREFIX).is_some_and(|hex| {
                hex.len() == 32 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            })
        });
        if is_staging && entry.file_type()?.is_dir() {
            // Best effort: a leftover that cannot be removed now is tried again next time.
            let _ = fs::remove_dir_all(entry.path());
        }
    }
    Ok(())
}

/// Deletes leftover `*.tmp` (and `*.partial`) files directly inside the vault folder (crashed
/// header writes). Best effort: the change that called this has succeeded, and unlock cleanup
/// repeats it.
fn remove_leftover_tmp(dir: &Path) {
    cleanup::remove_scraps(dir, &mut CleanupReport::default());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsio::{failpoint, testutil::TempDir};
    use crate::header::{HEADER_BACKUP, HEADER_FILE};

    const PW: &str = "correct horse battery";

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn create_is_all_or_nothing() {
        let parent = TempDir::new();
        failpoint::arm("create.before_rename");
        let result = Vault::create(parent.path(), "Family", PW);
        failpoint::disarm_all();
        assert!(matches!(result, Err(CoreError::Io(_))));
        let left = names(parent.path());
        assert_eq!(left.len(), 1, "{left:?}");
        assert!(left[0].starts_with(STAGING_PREFIX));
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            let attrs = fs::metadata(parent.path().join(&left[0]))
                .unwrap()
                .file_attributes();
            assert_ne!(attrs & 0x2, 0, "staging folder is not hidden");
        }

        // The next create removes the leftover and succeeds with a visible folder.
        let created = Vault::create(parent.path(), "Family", PW).unwrap();
        let after = names(parent.path());
        assert_eq!(after.len(), 1, "{after:?}");
        assert_eq!(after[0], folder_name("Family", &created.vault.id()));
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            let attrs = fs::metadata(created.vault.dir()).unwrap().file_attributes();
            assert_eq!(attrs & 0x2, 0, "final folder is hidden");
        }
    }

    #[test]
    fn existing_final_folder_is_refused_and_untouched() {
        let parent = TempDir::new();
        let id = VaultId([7; 16]);
        let existing = parent.path().join(folder_name("Family", &id));
        fs::create_dir(&existing).unwrap();
        fs::write(existing.join("keep.txt"), b"mine").unwrap();
        let result = Vault::create_with_id(parent.path(), "Family", PW, id);
        assert!(matches!(
            result,
            Err(CoreError::InvalidInput {
                what: "destination exists"
            })
        ));
        assert_eq!(fs::read(existing.join("keep.txt")).unwrap(), b"mine");
        assert_eq!(names(&existing), ["keep.txt"]);
    }

    #[test]
    fn only_exact_staging_folders_are_removed() {
        let parent = TempDir::new();
        let hex = "0123456789abcdef0123456789abcdef";
        let stale = format!("{STAGING_PREFIX}{hex}");
        let keep = [
            format!("{STAGING_PREFIX}{}", &hex[1..]), // 31 characters
            format!("{STAGING_PREFIX}{hex}0"),        // 33 characters
            format!("{STAGING_PREFIX}ABCDEF0123456789ABCDEF0123456789"), // not lowercase
            format!("{STAGING_PREFIX}{}g", &hex[1..]), // not hex
            format!(" {stale}"),
            format!("{stale}.bak"),
            "Family-0123abcd".to_owned(),
        ];
        fs::create_dir(parent.path().join(&stale)).unwrap();
        fs::write(parent.path().join(&stale).join("vault.json"), b"x").unwrap();
        for name in &keep {
            fs::create_dir(parent.path().join(name)).unwrap();
        }
        // A plain file with the staging name is not a folder and stays too.
        let file_named_like_staging = format!("{STAGING_PREFIX}{}", "f".repeat(32));
        fs::write(parent.path().join(&file_named_like_staging), b"x").unwrap();

        remove_stale_staging(parent.path()).unwrap();

        let mut expected: Vec<String> = keep.to_vec();
        expected.push(file_named_like_staging);
        expected.sort();
        assert_eq!(names(parent.path()), expected);
    }

    #[test]
    fn leftover_tmp_files_removed_from_vault_root_only() {
        let dir = TempDir::new();
        fs::create_dir(dir.path().join("items")).unwrap();
        fs::write(dir.path().join(".0123456789abcdef.tmp"), b"old slot").unwrap();
        fs::write(dir.path().join("vault.json"), b"x").unwrap();
        fs::write(dir.path().join("items").join("deep.tmp"), b"x").unwrap();
        remove_leftover_tmp(dir.path());
        assert_eq!(names(dir.path()), ["items", "vault.json"]);
        assert_eq!(names(&dir.path().join("items")), ["deep.tmp"]);
    }

    #[test]
    fn debug_output_hides_the_key() {
        let parent = TempDir::new();
        let created = Vault::create(parent.path(), "Family", PW).unwrap();
        let out = format!("{created:?}");
        assert!(out.contains("Key32(<redacted>)"), "{out}");
        assert!(out.contains("RecoverySecret(<redacted>)"), "{out}");
        assert!(!out.contains(&*created.recovery.to_display()));
    }

    /// Spec 6.3: a failed `.bak` write leaves `.bak` one version behind. The new password
    /// still works, the next unlock repairs `.bak`, and only then is the old password gone.
    #[test]
    fn failed_bak_write_is_repaired_by_the_next_unlock() {
        const NEW_PW: &str = "a different long password";
        let parent = TempDir::new();
        let mut vault = Vault::create(parent.path(), "Family", PW).unwrap().vault;
        let dir = vault.dir().to_path_buf();
        let old_bak = fs::read(dir.join(HEADER_BACKUP)).unwrap();

        failpoint::arm("write_headers.before_second");
        let result = vault.change_password(NEW_PW);
        failpoint::disarm_all();
        assert!(matches!(result, Err(CoreError::Io(_))));
        drop(vault);
        // vault.json is new, .bak is still the old header.
        assert_ne!(fs::read(dir.join(HEADER_FILE)).unwrap(), old_bak);
        assert_eq!(fs::read(dir.join(HEADER_BACKUP)).unwrap(), old_bak);

        let (vault, report) = Vault::unlock_with_password(&dir, NEW_PW).unwrap();
        assert!(!report.used_backup_header);
        drop(vault);
        let (main, bak) = (
            fs::read(dir.join(HEADER_FILE)).unwrap(),
            fs::read(dir.join(HEADER_BACKUP)).unwrap(),
        );
        assert_eq!(main, bak);
        assert_ne!(bak, old_bak);

        // Against the repaired pair the old password fails, with vault.json gone too.
        assert!(matches!(
            Vault::unlock_with_password(&dir, PW),
            Err(CoreError::WrongPassword)
        ));
        // With vault.json gone, .bak is the only copy: the old password still fails
        // (the error reported is the vault.json one, as ruled for "both copies failed").
        fs::remove_file(dir.join(HEADER_FILE)).unwrap();
        assert!(Vault::unlock_with_password(&dir, PW).is_err());
    }

    fn read_pair(dir: &Path) -> (Vec<u8>, Vec<u8>) {
        (
            fs::read(dir.join(HEADER_FILE)).unwrap(),
            fs::read(dir.join(HEADER_BACKUP)).unwrap(),
        )
    }

    fn is_wrong_password<T>(r: Result<T>) -> bool {
        matches!(r, Err(CoreError::WrongPassword))
    }

    /// The vault object stays correct after a half-written change: a later change must
    /// build on what vault.json holds, not on the header from before the failure.
    #[test]
    fn vault_stays_usable_after_a_partial_header_write() {
        const NEW_PW: &str = "a different long password";
        let parent = TempDir::new();
        let mut vault = Vault::create(parent.path(), "Family", PW).unwrap().vault;
        let dir = vault.dir().to_path_buf();

        failpoint::arm("write_headers.before_second");
        assert!(vault.change_password(NEW_PW).is_err());
        failpoint::disarm_all();
        let new_recovery = vault.regenerate_recovery().unwrap();
        drop(vault);

        let (main, bak) = read_pair(&dir);
        assert_eq!(main, bak);
        let (vault, _) = Vault::unlock_with_password(&dir, NEW_PW).unwrap();
        drop(vault);
        let (vault, _) = Vault::unlock_with_recovery(&dir, &new_recovery).unwrap();
        drop(vault);
        assert!(is_wrong_password(Vault::unlock_with_password(&dir, PW)));
        fs::remove_file(dir.join(HEADER_FILE)).unwrap();
        assert!(is_wrong_password(Vault::unlock_with_password(&dir, PW)));
    }

    #[test]
    fn failed_backup_write_during_regeneration_changes_nothing() {
        let parent = TempDir::new();
        let created = Vault::create(parent.path(), "Family", PW).unwrap();
        let old = RecoverySecret::parse(&created.recovery.to_display()).unwrap();
        let mut vault = created.vault;
        let dir = vault.dir().to_path_buf();
        let before = read_pair(&dir);

        failpoint::arm("write_headers.before_first");
        assert!(vault.regenerate_recovery().is_err());
        failpoint::disarm_all();
        drop(vault);

        assert_eq!(read_pair(&dir), before);
        let (vault, report) = Vault::unlock_with_recovery(&dir, &old).unwrap();
        assert!(!report.used_backup_header);
        drop(vault);
        assert_eq!(read_pair(&dir), before);
    }

    /// `.bak` is written first, so a failure on vault.json leaves the primary on the old
    /// recovery secret. Password unlock cannot tell the two recovery slots apart and
    /// leaves both files alone; a recovery unlock with the old secret repairs `.bak`.
    #[test]
    fn failed_primary_write_during_regeneration_keeps_the_old_secret() {
        let parent = TempDir::new();
        let created = Vault::create(parent.path(), "Family", PW).unwrap();
        let old = RecoverySecret::parse(&created.recovery.to_display()).unwrap();
        let mut vault = created.vault;
        let dir = vault.dir().to_path_buf();
        let (main_before, bak_before) = read_pair(&dir);

        failpoint::arm("write_headers.before_second");
        assert!(vault.regenerate_recovery().is_err());
        failpoint::disarm_all();
        drop(vault);
        let (main, bak) = read_pair(&dir);
        assert_eq!(main, main_before);
        assert_ne!(bak, bak_before);

        let (vault, report) = Vault::unlock_with_password(&dir, PW).unwrap();
        assert!(!report.used_backup_header);
        drop(vault);
        assert_eq!(read_pair(&dir), (main.clone(), bak));

        let (vault, report) = Vault::unlock_with_recovery(&dir, &old).unwrap();
        assert!(!report.used_backup_header);
        drop(vault);
        assert_eq!(read_pair(&dir), (main.clone(), main));
    }

    /// A repair that cannot be written must not lock the user out of a healthy vault.
    #[test]
    fn failed_repair_write_does_not_block_unlock() {
        let parent = TempDir::new();
        let dir = Vault::create(parent.path(), "Family", PW)
            .unwrap()
            .vault
            .dir()
            .to_path_buf();
        fs::write(dir.join(HEADER_BACKUP), b"{\"truncated").unwrap();
        let before = read_pair(&dir);

        failpoint::arm("unlock.repair_write");
        let (vault, report) = Vault::unlock_with_password(&dir, PW).unwrap();
        failpoint::disarm_all();
        drop(vault);
        assert!(report.header_repair_failed && !report.used_backup_header);
        assert_eq!(read_pair(&dir), before);

        let (vault, report) = Vault::unlock_with_password(&dir, PW).unwrap();
        drop(vault);
        assert!(!report.header_repair_failed);
        let (main, bak) = read_pair(&dir);
        assert_eq!(main, bak);
    }
}
