//! The vault's life cycle (spec 5.3, 6.3): create, unlock, change password, regenerate
//! the recovery key. Items and files are added on top of [`Vault`] by later modules.

mod backup;
mod cleanup;
mod files;
mod items;
mod naming;
mod source;
mod unlock;

use crate::fsio;
use crate::header::{
    CONTAINER_VERSION, HEADER_FILE, VaultHeader, header_mac, serialize_header, write_headers,
    write_headers_backup_first, write_headers_each,
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

pub use backup::BackupReport;
pub(crate) use naming::folder_name;
pub use source::{BackupSummary, verify_backup};
pub use unlock::{Credential, read_vault_name};

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

/// Whether, and why, header writes are held back (final review 1 to 3). Every header write
/// asks [`HeaderGuard::check`] first. A credential change that goes through clears it;
/// accepting clears only the pending consent.
#[derive(Debug, Default)]
struct HeaderGuard {
    /// `header_mac_mismatch` is pending: the user has not accepted the changed header, so
    /// only `accept_header` may write (anything else would overwrite the authentic `.bak`).
    // shortcut: no "decline" path; only accept_header resolves this, until Plan 3's UI can ask the user.
    consent_pending: bool,
    /// The other header copy differs in a slot the unlock could not check, so only a write
    /// that replaces that slot may go ahead (any other would copy the unverified slot over
    /// the other file's, possibly good, one). `accept_header` is the exception: it keeps
    /// each file's own copy of that slot.
    unverified: Option<Unverified>,
    /// A header write failed and `vault.json` now holds a header Lockbox cannot vouch for.
    uncertain: bool,
}

/// The slot an unlock could not check, as the other header file holds it.
#[derive(Debug)]
struct Unverified {
    slot_type: SlotType,
    other: KeySlot,
    /// Whether the other file is `vault.json.bak` (else `vault.json`).
    other_is_backup: bool,
}

impl HeaderGuard {
    /// `replacing` is the slot type the write replaces; `None` is `accept_header`, the only
    /// write the pending consent lets through, and which never spreads a slot.
    fn check(&self, replacing: Option<SlotType>) -> Result<()> {
        let refuse = |what| Err(CoreError::InvalidInput { what });
        if self.uncertain {
            return refuse("header state unknown; reopen the vault");
        }
        if self.consent_pending && replacing.is_some() {
            return refuse("accept the header change first");
        }
        match &self.unverified {
            Some(u) if replacing.is_some_and(|t| t != u.slot_type) => {
                refuse("header copies disagree; replace the unchecked credential first")
            }
            _ => Ok(()),
        }
    }
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
    guard: HeaderGuard,
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
            guard: HeaderGuard::default(),
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
        self.guard.check(Some(SlotType::Password))?;
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
        self.guard.check(Some(SlotType::Recovery))?;
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
        let primary = header.clone();
        self.commit(header, &primary, |dir| write(dir, &primary))?;
        // The guard let this write through, so it replaced the unverified slot (if any), and
        // no consent was pending.
        self.guard = HeaderGuard::default();
        remove_leftover_tmp(&self.dir);
        Ok(())
    }

    /// Accepts a header changed outside Lockbox (after [`UnlockReport::header_mac_mismatch`]):
    /// signs the current header again and saves it. Call only after the user agreed.
    ///
    /// If the unlock left a key slot unchecked (the two copies differ in it), each file gets
    /// the accepted header with its OWN version of that slot: the MAC does not cover slots,
    /// so nothing unverified is lost and no choice between the copies is made. The
    /// slot block stays until a credential change replaces that slot.
    pub fn accept_header(&mut self) -> Result<()> {
        self.guard.check(None)?;
        let mut header = self.header.clone();
        header.header_mac = Some(header_mac(&header, &self.vault_key));
        let mut other = header.clone();
        let mut other_is_primary = false;
        if let Some(u) = &self.guard.unverified {
            if let Some(slot) = other.slots.iter_mut().find(|s| s.slot_type == u.slot_type) {
                *slot = u.other.clone();
            }
            other_is_primary = !u.other_is_backup;
        }
        let (primary, backup) = if other_is_primary {
            (other, header.clone())
        } else {
            (header.clone(), other)
        };
        self.commit(header, &primary, |dir| {
            write_headers_each(dir, &primary, &backup)
        })?;
        self.guard.consent_pending = false;
        Ok(())
    }

    /// Runs `write` (which saves `header`, or the pair of headers whose `vault.json` half is
    /// `primary`) and makes `header` the live one. If it fails part-way, `vault.json` is read
    /// back: it is accepted only when it holds `primary` (the write landed) or the header
    /// from before. Anything else, or a failed read-back, blocks every later header write on
    /// this `Vault`, so a header whose state Lockbox cannot establish is never copied over a
    /// good one. While a slot is unverified (each file holds its own version of it), any
    /// failed write blocks without a read-back: the saved per-file slots cannot be kept in
    /// step with a half-written pair, and reopening re-reads both files. (When the open
    /// header came from `.bak` and a pair write failed before touching `vault.json`, that
    /// file holds neither state, so this errs on the side of blocking.) The original error
    /// is returned either way.
    fn commit(
        &mut self,
        header: VaultHeader,
        primary: &VaultHeader,
        write: impl FnOnce(&Path) -> Result<()>,
    ) -> Result<()> {
        let result = write(&self.dir);
        if result.is_ok() {
            self.header = header;
        } else if self.guard.unverified.is_some() {
            self.guard.uncertain = true;
        } else {
            let on_disk = unlock::load(&self.dir.join(HEADER_FILE))
                .ok()
                .map(|f| serialize_header(&f.header));
            if on_disk == Some(serialize_header(primary)) {
                self.header = header;
            } else if on_disk != Some(serialize_header(&self.header)) {
                self.guard.uncertain = true;
            }
        }
        result
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
    use crate::header::{HEADER_BACKUP, HEADER_FILE, parse_header, serialize_header};

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

    /// Final review, Important 3: a write that fails on an unverified disk state must not
    /// let a later change spread that state. Unlock falls back to a good `.bak` (primary
    /// password slot damaged), the repair fails, then the password change fails before it
    /// writes anything: `vault.json` holds a header Lockbox cannot vouch for.
    #[test]
    fn failed_write_on_an_unknown_header_blocks_later_header_writes() {
        let parent = TempDir::new();
        let created = Vault::create(parent.path(), "Family", PW).unwrap();
        let dir = created.vault.dir().to_path_buf();
        drop(created);
        let mut header = parse_header(&fs::read(dir.join(HEADER_FILE)).unwrap()).unwrap();
        header.slots[0].ciphertext[0] ^= 1;
        fs::write(dir.join(HEADER_FILE), serialize_header(&header)).unwrap();

        failpoint::arm("unlock.repair_write");
        let (mut vault, report) = Vault::unlock_with_password(&dir, PW).unwrap();
        failpoint::disarm_all();
        assert!(report.used_backup_header && report.header_repair_failed);
        let before = read_pair(&dir);

        failpoint::arm("write_headers.before_first");
        assert!(matches!(
            vault.change_password("a different long password"),
            Err(CoreError::Io(_))
        ));
        failpoint::disarm_all();

        for result in [
            vault.regenerate_recovery().map(|_| ()),
            vault.change_password("a different long password"),
            vault.accept_header(),
        ] {
            assert!(matches!(result, Err(CoreError::InvalidInput { .. })));
        }
        assert_eq!(read_pair(&dir), before);
    }

    const NEW: &str = "a different long password";

    fn what<T>(r: Result<T>) -> &'static str {
        match r {
            Err(CoreError::InvalidInput { what }) => what,
            _ => "not refused",
        }
    }

    /// Edits the name in `vault.json` and damages its slot `n` (0 password, 1 recovery).
    fn edit_and_damage(dir: &Path, n: usize) {
        let mut header = parse_header(&fs::read(dir.join(HEADER_FILE)).unwrap()).unwrap();
        header.name = "Renamed".to_owned();
        header.slots[n].ciphertext[0] ^= 1;
        fs::write(dir.join(HEADER_FILE), serialize_header(&header)).unwrap();
    }

    /// A failed read-back after a failed write also blocks every later header write.
    #[test]
    fn failed_read_back_blocks_later_header_writes() {
        let parent = TempDir::new();
        let mut vault = Vault::create(parent.path(), "Family", PW).unwrap().vault;
        let dir = vault.dir().to_path_buf();
        fs::remove_file(dir.join(HEADER_FILE)).unwrap();
        let bak = fs::read(dir.join(HEADER_BACKUP)).unwrap();

        failpoint::arm("write_headers.before_first");
        let result = vault.change_password("a different long password");
        failpoint::disarm_all();
        assert!(matches!(result, Err(CoreError::Io(_))));

        for result in [
            what(vault.regenerate_recovery()),
            what(vault.change_password("a different long password")),
            what(vault.accept_header()),
        ] {
            assert!(result.contains("reopen the vault"), "{result}");
        }
        assert!(!dir.join(HEADER_FILE).exists());
        assert_eq!(fs::read(dir.join(HEADER_BACKUP)).unwrap(), bak);
    }

    /// A failed accept in the combined state blocks every header write until reopened;
    /// reopening re-reads both files and the accept can then be repeated.
    #[test]
    fn failed_accept_requires_reopen_then_can_be_retried() {
        let parent = TempDir::new();
        let created = Vault::create(parent.path(), "Family", PW).unwrap();
        let dir = created.vault.dir().to_path_buf();
        drop(created);
        edit_and_damage(&dir, 1);
        let primary = fs::read(dir.join(HEADER_FILE)).unwrap();
        let (mut vault, report) = Vault::unlock_with_password(&dir, PW).unwrap();
        assert!(report.header_mac_mismatch);

        failpoint::arm("write_headers.before_second");
        assert!(matches!(vault.accept_header(), Err(CoreError::Io(_))));
        failpoint::disarm_all();

        assert!(what(vault.accept_header()).contains("reopen the vault"));
        assert!(what(vault.change_password(NEW)).contains("reopen the vault"));
        assert!(what(vault.regenerate_recovery()).contains("reopen the vault"));
        assert_eq!(fs::read(dir.join(HEADER_FILE)).unwrap(), primary);
        drop(vault);

        let (mut vault, report) = Vault::unlock_with_password(&dir, PW).unwrap();
        assert!(report.header_mac_mismatch);
        vault.accept_header().unwrap();
        assert!(what(vault.change_password(NEW)).contains("copies disagree"));
        vault.regenerate_recovery().unwrap();
        assert_eq!(read_pair(&dir).0, read_pair(&dir).1);
    }

    /// A failed replacement while a slot is unverified blocks until reopened; the reopened
    /// vault still has the slot block, and the replacement then works.
    #[test]
    fn failed_replacement_requires_reopen_and_keeps_the_slot_block() {
        let parent = TempDir::new();
        let created = Vault::create(parent.path(), "Family", PW).unwrap();
        let dir = created.vault.dir().to_path_buf();
        drop(created);
        let mut header = parse_header(&fs::read(dir.join(HEADER_FILE)).unwrap()).unwrap();
        header.slots[1].ciphertext[0] ^= 1;
        fs::write(dir.join(HEADER_FILE), serialize_header(&header)).unwrap();
        let (mut vault, _) = Vault::unlock_with_password(&dir, PW).unwrap();
        let before = read_pair(&dir);

        failpoint::arm("write_headers.before_first");
        assert!(vault.regenerate_recovery().is_err());
        failpoint::disarm_all();

        assert!(what(vault.change_password(NEW)).contains("reopen the vault"));
        assert_eq!(read_pair(&dir), before);
        drop(vault);

        let (mut vault, _) = Vault::unlock_with_password(&dir, PW).unwrap();
        assert!(what(vault.change_password(NEW)).contains("copies disagree"));
        vault.regenerate_recovery().unwrap();
    }

    /// Accepting when the open header came from `.bak`: `vault.json` is "the other file" and
    /// keeps its own (here damaged) recovery slot. A failure before it is touched cannot be
    /// reconciled, so it blocks; a clean accept works and the slot can then be replaced.
    #[test]
    fn accept_from_the_backup_keeps_the_primarys_own_slot() {
        let parent = TempDir::new();
        let created = Vault::create(parent.path(), "Family", PW).unwrap();
        let dir = created.vault.dir().to_path_buf();
        drop(created);
        let mut header = parse_header(&fs::read(dir.join(HEADER_FILE)).unwrap()).unwrap();
        for slot in &mut header.slots {
            slot.ciphertext[0] ^= 1;
        }
        fs::write(dir.join(HEADER_FILE), serialize_header(&header)).unwrap();
        let damaged = fs::read(dir.join(HEADER_FILE)).unwrap();

        let (mut vault, report) = Vault::unlock_with_password(&dir, PW).unwrap();
        assert!(report.used_backup_header);
        failpoint::arm("write_headers.before_second");
        assert!(vault.accept_header().is_err());
        failpoint::disarm_all();
        assert_eq!(fs::read(dir.join(HEADER_FILE)).unwrap(), damaged);
        assert!(what(vault.regenerate_recovery()).contains("reopen the vault"));
        drop(vault);

        let (mut vault, _) = Vault::unlock_with_password(&dir, PW).unwrap();
        vault.accept_header().unwrap();
        let after = parse_header(&fs::read(dir.join(HEADER_FILE)).unwrap()).unwrap();
        assert_eq!(after.slots[1], header.slots[1]); // its own, still damaged
        assert_eq!(after.name, header.name);
        vault.regenerate_recovery().unwrap();
        assert_eq!(read_pair(&dir).0, read_pair(&dir).1);
    }

    /// Round 3: with per-file slots in play, a failed header write must not leave a vault
    /// that can still write. Backup unlock with both primary slots damaged, a password
    /// change that dies between the two writes, then nothing may write until reopened.
    #[test]
    fn failed_write_with_unverified_slots_requires_reopen() {
        const NEW_PW: &str = "a different long password";
        let parent = TempDir::new();
        let created = Vault::create(parent.path(), "Family", PW).unwrap();
        let dir = created.vault.dir().to_path_buf();
        let recovery = created.recovery;
        drop(created.vault);
        let mut header = parse_header(&fs::read(dir.join(HEADER_FILE)).unwrap()).unwrap();
        for slot in &mut header.slots {
            slot.ciphertext[0] ^= 1;
        }
        fs::write(dir.join(HEADER_FILE), serialize_header(&header)).unwrap();

        let (mut vault, report) = Vault::unlock_with_recovery(&dir, &recovery).unwrap();
        assert!(report.used_backup_header);
        failpoint::arm("write_headers.before_second");
        assert!(matches!(
            vault.change_password(NEW_PW),
            Err(CoreError::Io(_))
        ));
        failpoint::disarm_all();
        let before = read_pair(&dir);

        for result in [
            what(vault.accept_header()),
            what(vault.change_password(NEW_PW)),
            what(vault.regenerate_recovery().map(|_| ())),
        ] {
            assert!(result.contains("reopen the vault"), "{result}");
        }
        assert_eq!(read_pair(&dir), before);
        drop(vault);

        // Reopened, the state matches the files: vault.json has the new password slot and
        // .bak the old one, which stays unverified until a supported change replaces it.
        let (mut vault, _) = Vault::unlock_with_recovery(&dir, &recovery).unwrap();
        assert!(what(vault.regenerate_recovery().map(|_| ())).contains("copies disagree"));
        vault.change_password(NEW_PW).unwrap();
        drop(vault);
        assert_eq!(read_pair(&dir).0, read_pair(&dir).1);
        assert!(Vault::unlock_with_password(&dir, NEW_PW).is_ok());
    }
}
