//! The vault's life cycle (spec 5.3, 6.3): create, unlock, change password, regenerate
//! the recovery key. Items and files are added on top of [`Vault`] by later modules.

mod backup;
mod cleanup;
mod files;
#[cfg(any(test, feature = "test-internals"))]
pub(crate) mod fixture;
mod items;
mod journal;
mod naming;
mod readonly;
mod restore;
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
use crate::search::{SearchHit, SearchIndex};
use crate::secret::{Key32, random_bytes};
use crate::slots::{KeySlot, SlotType, check_slot_version, unwrap_slot, wrap_slot};
use crate::{CoreError, Result};
use ctutils::CtEq;
use naming::{created_at_now, validate_name};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

pub use backup::{BackupPlan, BackupReport};
pub use files::{NewExportError, refuse_vault_folder};
pub use journal::{JournalStep, JournalView, inspect_restore_journal};
pub use naming::folder_name;
pub use naming::is_reserved_device_name;
pub use readonly::{CopiedItem, ReadOnlyVault};
pub use restore::{
    PreparedRestore, Recovery, RestoreDestination, RestoreOutcome, dismiss_restore_journal,
    recover_restore,
};
pub use source::{BackupSummary, verify_backup};
pub use unlock::{Credential, header_is_damaged, read_vault_id, read_vault_name};

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

/// What a read-only look at a vault's headers with a recovery key found ([`Vault::check_recovery_key`]). No `Debug`: the
/// name is the user's own.
pub struct RecoveryCheck {
    /// The header that opened failed its MAC: it was changed outside Lockbox (see [`UnlockReport`]).
    pub header_mac_mismatch: bool,
    /// The vault's name, from the header that opened.
    pub name: String,
    /// `vault.json` exactly as read; `None` when the file is not there or could not be read.
    pub main: Option<Vec<u8>>,
    /// `vault.json.bak` exactly as read; `None` when the file is not there or could not be read.
    pub backup: Option<Vec<u8>>,
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

/// Which credential's key slot the header copies disagree on ([`Vault::unverified_slot`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnverifiedSlot {
    Password,
    Recovery,
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

    /// Like [`create`](Self::create), with the vault's ID chosen by the caller. The ID decides the folder's name
    /// ([`folder_name`]), so a caller can write down where the vault will be (the shell's "recovery key not
    /// confirmed" mark) before it exists. Use a fresh [`VaultId::random`]: the ID is bound into the vault's key slots,
    /// and two different vaults should not share one.
    pub fn create_with_id(
        parent: &Path,
        name: &str,
        password: &str,
        id: VaultId,
    ) -> Result<CreatedVault> {
        validate_name(name)?;
        check_new_password(password)?;
        // A vault never goes inside another vault's folder (a later restore over the outer one would carry it along).
        files::refuse_vault_folder(&parent.join(folder_name(name, &id)))?;

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
        #[cfg(any(test, feature = "test-internals"))]
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

    /// Whether `secret` opens the recovery slot of the vault in `dir`, and whether the header that opened passes its
    /// MAC, without opening the vault: no `.lock` is taken, nothing is cleaned or repaired, nothing is written, and no
    /// Argon2 runs (the recovery key's derivation is HKDF). Picks the header as unlocking does (`vault.json`, else
    /// `.bak` of the same vault) and answers with both files' bytes as read, so the caller can tell later whether
    /// either changed. A key that opens no slot is [`CoreError::WrongPassword`]: another vault's key and an old key
    /// look alike to the cipher.
    pub fn check_recovery_key(dir: &Path, secret: &RecoverySecret) -> Result<RecoveryCheck> {
        unlock::check_recovery(dir, secret)
    }

    /// Sets a new password (checked against the minimum length) with a fresh salt. The
    /// vault key and the recovery slot stay as they are.
    ///
    /// An `Err` may leave `vault.json.bak` one version behind: the old password may then
    /// still open the vault, from `.bak`, until the next successful unlock repairs it.
    pub fn change_password(&mut self, new_password: &str) -> Result<()> {
        self.change_password_with(new_password, || Ok(()))
    }

    /// Whether `password` is the one that opens this vault, for a caller that must be sure before it changes
    /// something (the shell's change of password, a new recovery key). Derives the password key from the open
    /// header's password slot (its own salt and settings, within the read bounds), unwraps the slot and compares
    /// what it holds with the live vault key in constant time: a slot that unwraps to another key is
    /// [`CoreError::WrongPassword`] too. When the two header copies disagree on the password slot (the vault was
    /// opened with the recovery key, so the other copy's slot is unverified), that slot is tried the same way: either
    /// password opens the vault. Writes nothing; the temporary keys are wiped when dropped.
    pub fn check_password(&self, password: &str) -> Result<()> {
        let own = self
            .header
            .slots
            .iter()
            .find(|s| s.slot_type == SlotType::Password)
            .ok_or(CoreError::Damaged { what: "key slots" })?;
        let spare = self
            .guard
            .unverified
            .as_ref()
            .filter(|u| u.slot_type == SlotType::Password)
            .map(|u| &u.other);
        // The key from the last Argon2 run, kept for a spare with the same salt and settings.
        let mut derived: Option<(&KeySlot, Key32)> = None;
        let mut first_error = None;
        for slot in std::iter::once(own).chain(spare) {
            let outcome = self.slot_holds_live_key(slot, password, &mut derived);
            match outcome {
                Ok(()) => return Ok(()),
                // A newer vault says so, whichever copy it is.
                Err(CoreError::UnsupportedVersion) => return Err(CoreError::UnsupportedVersion),
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
        Err(first_error.unwrap_or(CoreError::WrongPassword))
    }

    /// Whether `slot` opens with `password` and wraps the live vault key.
    fn slot_holds_live_key<'a>(
        &self,
        slot: &'a KeySlot,
        password: &str,
        derived: &mut Option<(&'a KeySlot, Key32)>,
    ) -> Result<()> {
        check_slot_version(slot)?;
        let params = slot.kdf.ok_or(CoreError::Damaged { what: "key slots" })?;
        let reusable = derived
            .as_ref()
            .is_some_and(|(from, _)| from.salt == slot.salt && from.kdf == Some(params));
        if !reusable {
            let key = derive_password_key(password, &slot.salt, &params)?;
            *derived = Some((slot, key));
        }
        let Some((_, key)) = derived.as_ref() else {
            return Err(CoreError::WrongPassword);
        };
        let unwrapped = unwrap_slot(slot, &self.header.vault_id, key)?;
        // Authentic is not enough: the slot must hold this vault's key.
        let same = unwrapped.as_bytes().ct_eq(self.vault_key.as_bytes());
        match same.to_bool() {
            true => Ok(()),
            false => Err(CoreError::WrongPassword),
        }
    }

    /// [`change_password`](Self::change_password) with `before_write` run once the new password key is derived
    /// (the slow part), immediately before the header files are written: an `Err` from it changes nothing on disk
    /// and is returned. The shell stops a change here when a lock has come.
    pub fn change_password_with(
        &mut self,
        new_password: &str,
        before_write: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
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
        before_write()?;
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
    ///
    /// That order needs a `vault.json` to fall back on. After an unlock from `.bak` whose
    /// repair failed, `vault.json` may be missing or not read as a header at all, so the old
    /// secret opens only `.bak`, and a failure on `vault.json` after `.bak` landed would leave
    /// it opening neither file. So such a `vault.json` is first rewritten with the open header
    /// (which `.bak` already holds): a failure there changes nothing, and then the order above
    /// keeps its promise. (A `vault.json` that reads but keeps its own recovery slot is the
    /// unverified slot this write replaces: `.bak` first, as above.)
    pub fn regenerate_recovery(&mut self) -> Result<RecoverySecret> {
        self.guard.check(Some(SlotType::Recovery))?;
        let primary = self.dir.join(HEADER_FILE);
        if unlock::load(&primary).is_err() {
            unlock::repair(&primary, &serialize_header(&self.header))?;
        }
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

    /// Gives the vault a new name (18d): checked as `create` checks it, refused exactly when a backup is (a changed header
    /// not accepted, a header MAC that does not verify, a header state left unknown, a key slot the copies disagree on),
    /// then the header is signed again and written `vault.json` first, then `vault.json.bak`. Slots, ID, creation time and
    /// the folder's name stay. An `Err` after `vault.json` landed leaves the new name live (`commit` reads it back); the
    /// next writable unlock repairs `.bak`.
    ///
    /// Not through [`HeaderGuard::check`]: it has no argument that refuses all of these (`check(None)` lets a pending
    /// consent through, and `check(Some(_))` lets a disagreeing slot of that type through). When the refusal passes the
    /// guard is all clear, so it is neither read nor reset here; a failed write sets `uncertain` in `commit`.
    pub fn rename(&mut self, name: &str) -> Result<()> {
        validate_name(name)?;
        self.refuse_backup()?;
        let mut header = self.header.clone();
        header.name = name.to_owned();
        header.header_mac = Some(header_mac(&header, &self.vault_key));
        let primary = header.clone();
        self.commit(header, &primary, |dir| write_headers(dir, &primary))
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

    /// When the vault was made, as its header says (`YYYY-MM-DDTHH:MM:SSZ`, RFC 3339 UTC). Read-only.
    pub fn created_at(&self) -> &str {
        &self.header.created_at
    }

    /// The credential whose key slot the two header copies disagree on, which this unlock could not check (a password
    /// unlock cannot check the recovery slot, and the other way round); `None` when the copies agree. While it is
    /// set, a backup is refused and only a change that replaces that credential goes ahead. Read-only.
    pub fn unverified_slot(&self) -> Option<UnverifiedSlot> {
        self.guard
            .unverified
            .as_ref()
            .map(|unverified| match unverified.slot_type {
                SlotType::Password => UnverifiedSlot::Password,
                SlotType::Recovery => UnverifiedSlot::Recovery,
            })
    }

    /// Items matching `q`, best first, at most `limit` (see [`SearchIndex::query`]).
    pub fn search(&self, q: &str, limit: usize) -> Vec<SearchHit> {
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
    fn create_inside_a_vault_folder_refused() {
        let parent = TempDir::new();
        let outer = Vault::create(parent.path(), "Family", PW).unwrap().vault;
        let before = names(outer.dir());
        // A display name may hold separators: the folder's name is what counts.
        for name in ["Nested", "AC/DC", "..\\up"] {
            let nested = Vault::create(outer.dir(), name, PW);
            assert!(
                matches!(
                    nested,
                    Err(CoreError::InvalidInput {
                        what: "destination in a vault folder"
                    })
                ),
                "{name}"
            );
        }
        assert_eq!(names(outer.dir()), before);
        assert!(Vault::create(parent.path(), "AC/DC", PW).is_ok());
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

    /// 4C end review (astra3-3): after an unlock from `.bak` whose repair failed (a damaged
    /// `vault.json` that could not be rewritten), the old recovery secret opens only `.bak`.
    /// A new secret first repairs `vault.json` from the open header, then writes `.bak` first
    /// as always, so a failure at any of the three writes leaves the old secret working (without
    /// the repair, a failure on `vault.json` after `.bak` would leave it opening neither), and
    /// `vault.json` never holds the undelivered slot, so a later change in the same session
    /// can't spread it. With no failure the new one works at once and the old one stops.
    #[test]
    fn new_recovery_after_a_failed_repair_keeps_the_old_secret_through_any_failure() {
        let parent = TempDir::new();
        let created = Vault::create(parent.path(), "Family", PW).unwrap();
        let dir = created.vault.dir().to_path_buf();
        let old = created.recovery;
        drop(created.vault);
        let degraded = || {
            fs::write(dir.join(HEADER_FILE), b"{\"truncated").unwrap();
            failpoint::arm("unlock.repair_write");
            let (vault, report) = Vault::unlock_with_password(&dir, PW).unwrap();
            failpoint::disarm_all();
            assert!(report.used_backup_header && report.header_repair_failed);
            vault
        };

        // A failure at the repair, at `.bak`, then at `vault.json`: each is an `Err`, and the old
        // secret still opens, also after a password change in the same session.
        for point in [
            "unlock.repair_write",
            "write_headers.before_first",
            "write_headers.before_second",
        ] {
            let mut vault = degraded();
            failpoint::arm(point);
            let failed = vault.regenerate_recovery().map(|_| ());
            failpoint::disarm_all();
            assert!(failed.is_err(), "{point}");
            if vault.change_password("a different long password").is_ok() {
                vault.change_password(PW).unwrap();
            }
            drop(vault);
            let (vault, _) = Vault::unlock_with_recovery(&dir, &old)
                .unwrap_or_else(|e| panic!("{point}: the old secret stopped working: {e:?}"));
            drop(vault);
        }

        // No failure: the new secret works and the old one stops.
        let mut vault = degraded();
        let fresh = vault.regenerate_recovery().unwrap();
        drop(vault);
        assert_eq!(read_pair(&dir).0, read_pair(&dir).1);
        assert!(Vault::unlock_with_recovery(&dir, &old).is_err());
        assert!(Vault::unlock_with_recovery(&dir, &fresh).is_ok());
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

    /// The shell tells a person which credential to renew: the accessor names the slot the two header copies
    /// disagree on, and nothing when they agree.
    #[test]
    fn unverified_slot_names_the_slot_the_copies_disagree_on() {
        let parent = TempDir::new();
        let created = Vault::create(parent.path(), "Family", PW).unwrap();
        let dir = created.vault.dir().to_path_buf();
        drop(created.vault);
        let (vault, _) = Vault::unlock_with_password(&dir, PW).unwrap();
        assert_eq!(vault.unverified_slot(), None);
        drop(vault);

        // The recovery slot differs: a password unlock cannot check it.
        let mut header = parse_header(&fs::read(dir.join(HEADER_FILE)).unwrap()).unwrap();
        header.slots[1].ciphertext[0] ^= 1;
        fs::write(dir.join(HEADER_FILE), serialize_header(&header)).unwrap();
        let (vault, _) = Vault::unlock_with_password(&dir, PW).unwrap();
        assert_eq!(vault.unverified_slot(), Some(UnverifiedSlot::Recovery));
        drop(vault);

        // A fresh vault whose password slot differs: a recovery unlock cannot check it.
        let other = Vault::create(parent.path(), "Work", PW).unwrap();
        let dir = other.vault.dir().to_path_buf();
        let secret = other.recovery;
        drop(other.vault);
        let mut header = parse_header(&fs::read(dir.join(HEADER_FILE)).unwrap()).unwrap();
        header.slots[0].ciphertext[0] ^= 1;
        fs::write(dir.join(HEADER_FILE), serialize_header(&header)).unwrap();
        let (vault, _) = Vault::unlock_with_recovery(&dir, &secret).unwrap();
        assert_eq!(vault.unverified_slot(), Some(UnverifiedSlot::Password));
    }

    /// The header's creation time, as written when the vault was made.
    #[test]
    fn created_at_is_the_headers() {
        let parent = TempDir::new();
        let created = Vault::create(parent.path(), "Family", PW).unwrap();
        let on_disk = parse_header(&fs::read(created.vault.dir().join(HEADER_FILE)).unwrap())
            .unwrap()
            .created_at;
        assert_eq!(created.vault.created_at(), on_disk);
        assert_eq!(created.vault.created_at().len(), 20);
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

    // ---- The current password, checked against the open vault (Plan 4C, Task 2) ----

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

    /// Opens `dir` read-only with `credential`: whether it opened. Nothing is written by a read-only open.
    fn opens_read_only(dir: &Path, credential: Credential) -> bool {
        use crate::blob::{CancelToken, NoProgress};
        ReadOnlyVault::open_folder(dir, credential, &CancelToken::new(), &NoProgress).is_ok()
    }

    #[test]
    fn check_password_accepts_the_current_password() {
        let parent = TempDir::new();
        let vault = Vault::create(parent.path(), "Family", PW).unwrap().vault;
        assert!(vault.check_password(PW).is_ok());
        // Checking writes nothing and changes nothing: the same password is accepted again.
        let before = read_pair(vault.dir());
        assert!(vault.check_password(PW).is_ok());
        assert_eq!(read_pair(vault.dir()), before);
    }

    #[test]
    fn check_password_refuses_a_wrong_password() {
        let parent = TempDir::new();
        let vault = Vault::create(parent.path(), "Family", PW).unwrap().vault;
        let before = read_pair(vault.dir());
        for wrong in [
            "another long password",
            "correct horse batter",
            "CORRECT HORSE BATTERY",
        ] {
            assert!(is_wrong_password(vault.check_password(wrong)), "{wrong}");
        }
        assert_eq!(read_pair(vault.dir()), before);
    }

    /// The slot's tag verifies (it is authentic, and opens with the typed password) but it holds another key than
    /// the live vault's: the password is not this vault's, so it is refused. Without the comparison with the live
    /// key this test fails.
    #[test]
    fn check_password_refuses_a_slot_wrapping_another_key() {
        let parent = TempDir::new();
        let mut vault = Vault::create(parent.path(), "Family", PW).unwrap().vault;
        assert!(
            vault.check_password(PW).is_ok(),
            "before the slot is swapped"
        );
        fixture::password_slot_wrapping_another_key(&mut vault, PW);
        // The fixture's slot does open with PW and unwraps to a key (not a decryption failure).
        let on_disk = parse_header(&fs::read(vault.dir().join(HEADER_FILE)).unwrap()).unwrap();
        let slot = &on_disk.slots[0];
        let key = derive_password_key(PW, &slot.salt, &slot.kdf.unwrap()).unwrap();
        let unwrapped = crate::slots::unwrap_slot(slot, &vault.id(), &key).unwrap();
        assert_ne!(unwrapped.as_bytes(), vault.vault_key.as_bytes());
        assert!(is_wrong_password(vault.check_password(PW)));
    }

    #[test]
    fn check_password_after_a_change_accepts_only_the_new_one() {
        let parent = TempDir::new();
        let mut vault = Vault::create(parent.path(), "Family", PW).unwrap().vault;
        vault.change_password(NEW).unwrap();
        assert!(vault.check_password(NEW).is_ok());
        assert!(is_wrong_password(vault.check_password(PW)));
    }

    #[test]
    fn check_password_on_a_vault_opened_with_the_recovery_key() {
        let parent = TempDir::new();
        let created = Vault::create(parent.path(), "Family", PW).unwrap();
        let dir = created.vault.dir().to_path_buf();
        let recovery = created.recovery;
        drop(created.vault);

        // The pair agrees: the password slot is the open header's own.
        let (vault, _) = Vault::unlock_with_recovery(&dir, &recovery).unwrap();
        assert_eq!(vault.unverified_slot(), None);
        assert!(vault.check_password(PW).is_ok());
        assert!(is_wrong_password(vault.check_password(NEW)));
        drop(vault);

        // A password change that died between the two files: vault.json holds the new password slot, `.bak` the old.
        // The recovery unlock could not check either, and both passwords open the vault (the old one through the
        // spare): the open slot and the other copy's slot are each tried, and a wrong one is still refused.
        let mut vault = Vault::unlock_with_password(&dir, PW).unwrap().0;
        failpoint::arm("write_headers.before_second");
        assert!(vault.change_password(NEW).is_err());
        failpoint::disarm_all();
        drop(vault);
        let (vault, report) = Vault::unlock_with_recovery(&dir, &recovery).unwrap();
        assert!(!report.used_backup_header);
        assert_eq!(vault.unverified_slot(), Some(UnverifiedSlot::Password));
        assert!(vault.check_password(NEW).is_ok(), "the open header's slot");
        assert!(vault.check_password(PW).is_ok(), "the other copy's slot");
        assert!(is_wrong_password(
            vault.check_password("another long password")
        ));
    }

    /// A password change that died after `vault.json`, before `.bak` (the partial-write hook of
    /// `vault_stays_usable_after_a_partial_header_write`), opened on its own copy with the new password: `vault.json`
    /// opens, the spare is repaired, and the old password is then refused.
    #[test]
    fn change_password_interrupted_opens_with_the_new_password_on_its_own_copy() {
        let parent = TempDir::new();
        let mut vault = Vault::create(parent.path(), "Family", PW).unwrap().vault;
        let dir = vault.dir().to_path_buf();
        failpoint::arm("write_headers.before_second");
        assert!(vault.change_password(NEW).is_err());
        failpoint::disarm_all();
        drop(vault);
        let (main, bak) = read_pair(&dir);
        assert_ne!(main, bak, "interrupted: vault.json is ahead of .bak");

        let copy = parent.path().join("interrupted-new");
        copy_folder(&dir, &copy);
        // A read-only open writes nothing.
        assert!(opens_read_only(&copy, Credential::Password(NEW)));
        assert_eq!(read_pair(&copy), (main.clone(), bak.clone()));
        // A writable unlock opens vault.json (no Ask 9) and repairs the spare.
        let (vault, report) = Vault::unlock_with_password(&copy, NEW).unwrap();
        assert!(!report.used_backup_header && !report.header_repair_failed);
        drop(vault);
        assert_eq!(read_pair(&copy), (main.clone(), main));
        // Once the pair agrees, the old password is refused.
        assert!(is_wrong_password(Vault::unlock_with_password(&copy, PW)));
        assert!(!opens_read_only(&copy, Credential::Password(PW)));
    }

    /// The same interrupted folder, opened on its own copy with the old password: it opens through the spare (Ask 9),
    /// a read-only open writes nothing, and a writable unlock puts the old header back over vault.json, so the new
    /// password is refused until the change is made again, which then refuses the old one.
    #[test]
    fn change_password_interrupted_opens_with_the_old_password_through_the_spare_on_its_own_copy() {
        let parent = TempDir::new();
        let mut vault = Vault::create(parent.path(), "Family", PW).unwrap().vault;
        let dir = vault.dir().to_path_buf();
        failpoint::arm("write_headers.before_second");
        assert!(vault.change_password(NEW).is_err());
        failpoint::disarm_all();
        drop(vault);
        let (main, bak) = read_pair(&dir);
        assert_ne!(main, bak);

        let copy = parent.path().join("interrupted-old");
        copy_folder(&dir, &copy);
        assert!(opens_read_only(&copy, Credential::Password(PW)));
        assert_eq!(
            read_pair(&copy),
            (main, bak.clone()),
            "read-only writes nothing"
        );
        let (vault, report) = Vault::unlock_with_password(&copy, PW).unwrap();
        assert!(report.used_backup_header, "Ask 9: the spare opened");
        drop(vault);
        assert_eq!(
            read_pair(&copy),
            (bak.clone(), bak),
            "vault.json repaired from the spare"
        );
        assert!(is_wrong_password(Vault::unlock_with_password(&copy, NEW)));

        // Making the change again completes it: the new password opens, the old one is refused.
        let (mut vault, _) = Vault::unlock_with_password(&copy, PW).unwrap();
        vault.change_password(NEW).unwrap();
        drop(vault);
        assert!(Vault::unlock_with_password(&copy, NEW).is_ok());
        assert!(is_wrong_password(Vault::unlock_with_password(&copy, PW)));
    }

    /// A new recovery key writes `.bak` first. Interrupted after `.bak`, before `vault.json`: the old key is still
    /// the one in vault.json. Each credential is tried on its own copy of that folder.
    #[test]
    fn new_recovery_key_interrupted_after_the_spare_keeps_the_old_key() {
        let parent = TempDir::new();
        let created = Vault::create(parent.path(), "Family", PW).unwrap();
        let old_key = created.recovery;
        let mut vault = created.vault;
        let dir = vault.dir().to_path_buf();
        let (main_before, bak_before) = read_pair(&dir);
        failpoint::arm("write_headers.before_second");
        assert!(vault.regenerate_recovery().is_err());
        failpoint::disarm_all();
        drop(vault);
        let (main, bak) = read_pair(&dir);
        assert_eq!(
            main, main_before,
            "vault.json still holds the old key's slot"
        );
        assert_ne!(
            bak, bak_before,
            "the spare holds the key that was never delivered"
        );

        // A password unlock opens, keeps the unverified recovery slot in `.bak` and so leads to 21f (the shell's
        // mark is written before this header write; the engine's part is that nothing is repaired).
        let by_password = parent.path().join("by-password");
        copy_folder(&dir, &by_password);
        assert!(opens_read_only(&by_password, Credential::Password(PW)));
        assert_eq!(read_pair(&by_password), (main.clone(), bak.clone()));
        let (vault, report) = Vault::unlock_with_password(&by_password, PW).unwrap();
        assert!(!report.used_backup_header);
        assert_eq!(vault.unverified_slot(), Some(UnverifiedSlot::Recovery));
        drop(vault);
        assert_eq!(
            read_pair(&by_password),
            (main.clone(), bak.clone()),
            "not repaired"
        );

        // An unlock with the old key opens vault.json and repairs the spare.
        let by_key = parent.path().join("by-old-key");
        copy_folder(&dir, &by_key);
        assert!(opens_read_only(&by_key, Credential::Recovery(&old_key)));
        assert_eq!(read_pair(&by_key), (main.clone(), bak.clone()));
        let (vault, report) = Vault::unlock_with_recovery(&by_key, &old_key).unwrap();
        assert!(!report.used_backup_header);
        assert_eq!(vault.unverified_slot(), None);
        drop(vault);
        assert_eq!(
            read_pair(&by_key),
            (main.clone(), main.clone()),
            "the spare is repaired"
        );

        // If vault.json is then lost (here: lost before any repair), the password still opens through the spare.
        let lost = parent.path().join("main-lost");
        copy_folder(&dir, &lost);
        fs::remove_file(lost.join(HEADER_FILE)).unwrap();
        let (vault, report) = Vault::unlock_with_password(&lost, PW).unwrap();
        assert!(report.used_backup_header);
        drop(vault);
        // The spare's recovery slot was never delivered: the old key does not open it.
        assert!(Vault::unlock_with_recovery(&lost, &old_key).is_err());
    }

    // ---- Rename (Plan 4C, Task 8) ----

    /// Disarms every failpoint when a test ends, also when it fails part-way.
    struct Cleanup;
    impl Drop for Cleanup {
        fn drop(&mut self) {
            failpoint::disarm_all();
        }
    }

    fn header_on_disk(dir: &Path, file: &str) -> crate::header::VaultHeader {
        parse_header(&fs::read(dir.join(file)).unwrap()).unwrap()
    }

    /// The renamed vault's header is whole: both slots exactly as they were, the same ID and creation time, a new MAC
    /// that verifies (the MAC covers the name), the same bytes in both files, and no Ask 3 at the next unlock with
    /// either credential. Skipping the new MAC fails this.
    #[test]
    fn rename_keeps_both_slots_and_rewrites_the_mac() {
        let parent = TempDir::new();
        let created = Vault::create(parent.path(), "Family", PW).unwrap();
        let recovery = created.recovery;
        let mut vault = created.vault;
        let dir = vault.dir().to_path_buf();
        let before = header_on_disk(&dir, HEADER_FILE);
        assert_eq!(before.slots.len(), 2);

        vault.rename("Work and home").unwrap();
        assert_eq!(vault.name(), "Work and home");
        drop(vault);

        let (main, bak) = read_pair(&dir);
        assert_eq!(main, bak, "both files hold the same header");
        for file in [HEADER_FILE, HEADER_BACKUP] {
            let after = header_on_disk(&dir, file);
            assert_eq!(after.name, "Work and home", "{file}");
            assert_eq!(after.slots, before.slots, "{file}: both slots, unchanged");
            assert_eq!(after.vault_id, before.vault_id, "{file}");
            assert_eq!(after.created_at, before.created_at, "{file}");
            assert!(after.header_mac.is_some(), "{file}");
            assert_ne!(after.header_mac, before.header_mac, "{file}: signed again");
        }

        let (vault, report) = Vault::unlock_with_password(&dir, PW).unwrap();
        assert!(!report.header_mac_mismatch, "no Ask 3");
        assert!(!report.used_backup_header && !report.header_repair_failed);
        assert_eq!(vault.name(), "Work and home");
        assert_eq!(vault.unverified_slot(), None);
        for file in [HEADER_FILE, HEADER_BACKUP] {
            assert!(
                crate::header::verify_header_mac(&header_on_disk(&dir, file), &vault.vault_key),
                "{file}: the MAC verifies with the vault's key"
            );
        }
        drop(vault);
        let (vault, report) = Vault::unlock_with_recovery(&dir, &recovery).unwrap();
        assert!(
            !report.header_mac_mismatch,
            "no Ask 3 with the recovery key"
        );
        assert_eq!(vault.name(), "Work and home");
    }

    /// The name is changed in `vault.json` only, outside Lockbox, and the vault opened with its password: Ask 3 is
    /// pending.
    fn unlocked_after_an_outside_name_change(dir: &Path) -> Vault {
        let mut header = header_on_disk(dir, HEADER_FILE);
        header.name = "Renamed".to_owned();
        fs::write(dir.join(HEADER_FILE), serialize_header(&header)).unwrap();
        let (vault, report) = Vault::unlock_with_password(dir, PW).unwrap();
        assert!(report.header_mac_mismatch);
        vault
    }

    /// A rename is refused exactly as a backup is, and the words are the backup's. Whatever the refusal, both
    /// header files, the folder's listing and the open name are as they were.
    fn assert_rename_refused(vault: &mut Vault, expected: &str) {
        let before = (read_pair(vault.dir()), names(vault.dir()));
        let name = vault.name().to_owned();
        assert_eq!(what(vault.rename("Another name")), expected);
        assert_eq!(vault.name(), name);
        assert_eq!((read_pair(vault.dir()), names(vault.dir())), before);
        // The backup's own check says the same thing: one rule, shared.
        assert_eq!(what(vault.refuse_backup()), expected);
    }

    #[test]
    fn rename_refused_as_a_backup_is_with_both_files_unchanged() {
        let _cleanup = Cleanup;
        let parent = TempDir::new();

        // An unaccepted header change. Accepting it lifts the refusal.
        let dir = Vault::create(parent.path(), "Accept", PW)
            .unwrap()
            .vault
            .dir()
            .to_path_buf();
        let mut vault = unlocked_after_an_outside_name_change(&dir);
        assert!(vault.guard.consent_pending);
        assert_rename_refused(&mut vault, "accept the header change first");
        vault.accept_header().unwrap();
        vault.rename("After accepting").unwrap();
        drop(vault);

        // A header whose MAC does not verify, with no consent pending (the MAC test alone).
        let dir = Vault::create(parent.path(), "Mac", PW)
            .unwrap()
            .vault
            .dir()
            .to_path_buf();
        let mut vault = unlocked_after_an_outside_name_change(&dir);
        vault.guard.consent_pending = false;
        assert_rename_refused(&mut vault, "accept the header change first");
        drop(vault);

        // A header state left unknown by a failed write.
        let dir = Vault::create(parent.path(), "Unknown", PW)
            .unwrap()
            .vault
            .dir()
            .to_path_buf();
        let mut header = header_on_disk(&dir, HEADER_FILE);
        header.slots[0].ciphertext[0] ^= 1;
        fs::write(dir.join(HEADER_FILE), serialize_header(&header)).unwrap();
        failpoint::arm("unlock.repair_write");
        let (mut vault, _) = Vault::unlock_with_password(&dir, PW).unwrap();
        failpoint::disarm_all();
        failpoint::arm("write_headers.before_first");
        assert!(vault.change_password(NEW).is_err());
        failpoint::disarm_all();
        assert!(vault.guard.uncertain);
        assert_rename_refused(&mut vault, "header state unknown; reopen the vault");
        drop(vault);

        // The copies disagree on a key slot. Replacing that credential lifts the refusal.
        let dir = Vault::create(parent.path(), "Disagree", PW)
            .unwrap()
            .vault
            .dir()
            .to_path_buf();
        let mut header = header_on_disk(&dir, HEADER_FILE);
        header.slots[1].ciphertext[0] ^= 1;
        fs::write(dir.join(HEADER_FILE), serialize_header(&header)).unwrap();
        let (mut vault, _) = Vault::unlock_with_password(&dir, PW).unwrap();
        assert_eq!(vault.unverified_slot(), Some(UnverifiedSlot::Recovery));
        assert_rename_refused(
            &mut vault,
            "header copies disagree; replace the unchecked credential first",
        );
        vault.regenerate_recovery().unwrap();
        vault.rename("After the new key").unwrap();
    }

    /// A name is checked as `create` checks it: nothing but spaces, or over 200 characters, is refused with the same
    /// words, before anything else is looked at; any other name is kept exactly as given, spaces and all.
    #[test]
    fn rename_checks_the_name_as_create_does() {
        let parent = TempDir::new();
        let mut vault = Vault::create(parent.path(), "Family", PW).unwrap().vault;
        let dir = vault.dir().to_path_buf();
        let before = (read_pair(&dir), names(&dir));

        let too_long = "x".repeat(201);
        let too_long_wide = "é".repeat(201);
        for bad in ["", " ", "\t\r\n", "   \u{a0}  ", &too_long, &too_long_wide] {
            assert_eq!(what(vault.rename(bad)), "vault name", "{bad:?}");
            assert_eq!(
                what(Vault::create(parent.path(), bad, PW).map(|_| ())),
                "vault name",
                "create says the same for {bad:?}"
            );
            assert_eq!(vault.name(), "Family");
            assert_eq!((read_pair(&dir), names(&dir)), before, "{bad:?}");
        }

        // The name is looked at first: a refused backup state does not hide it.
        let other = Vault::create(parent.path(), "Other", PW).unwrap().vault;
        let other_dir = other.dir().to_path_buf();
        drop(other);
        let mut pending = unlocked_after_an_outside_name_change(&other_dir);
        assert_eq!(what(pending.rename("   ")), "vault name");
        assert_eq!(
            what(pending.rename("Fine")),
            "accept the header change first"
        );
        drop(pending);

        // 200 characters (of any width) are kept, as is a name with spaces round it.
        let longest = "é".repeat(200);
        for good in [
            "x".repeat(200),
            longest,
            "  Padded  ".to_owned(),
            "AC/DC: a \"name\"".to_owned(),
        ] {
            assert!(validate_name(&good).is_ok());
            vault.rename(&good).unwrap();
            assert_eq!(vault.name(), good);
            assert_eq!(header_on_disk(&dir, HEADER_FILE).name, good);
            assert_eq!(header_on_disk(&dir, HEADER_BACKUP).name, good);
        }
    }

    /// The folder keeps the name it was made with, whatever the vault is called now.
    #[test]
    fn rename_leaves_the_folder_name() {
        let parent = TempDir::new();
        let mut vault = Vault::create(parent.path(), "Family", PW).unwrap().vault;
        let dir = vault.dir().to_path_buf();
        let id = vault.id();
        let listing = names(parent.path());
        assert_eq!(listing.len(), 1);

        vault.rename("Something else entirely").unwrap();
        assert_eq!(vault.dir(), dir);
        assert!(
            !parent
                .path()
                .join(folder_name("Something else entirely", &id))
                .exists()
        );
        drop(vault);
        assert_eq!(names(parent.path()), listing, "no folder made or renamed");
        assert_eq!(read_vault_name(&dir).unwrap(), "Something else entirely");
        assert!(Vault::unlock_with_password(&dir, PW).is_ok());
    }

    /// The MAC still covers the name after a rename: a name changed outside Lockbox, on a vault Lockbox renamed, is
    /// still Ask 3 at the next unlock (so the rename did not weaken what the MAC checks).
    #[test]
    fn a_name_changed_outside_lockbox_still_shows_ask_3() {
        let parent = TempDir::new();
        let mut vault = Vault::create(parent.path(), "Family", PW).unwrap().vault;
        let dir = vault.dir().to_path_buf();
        vault.rename("Renamed in Lockbox").unwrap();
        drop(vault);
        let (vault, report) = Vault::unlock_with_password(&dir, PW).unwrap();
        assert!(!report.header_mac_mismatch);
        assert_eq!(vault.name(), "Renamed in Lockbox");
        drop(vault);

        // Outside Lockbox, in both files, the name is changed again.
        let mut header = header_on_disk(&dir, HEADER_FILE);
        header.name = "Changed outside".to_owned();
        for file in [HEADER_FILE, HEADER_BACKUP] {
            fs::write(dir.join(file), serialize_header(&header)).unwrap();
        }
        let (vault, report) = Vault::unlock_with_password(&dir, PW).unwrap();
        assert!(report.header_mac_mismatch, "Ask 3");
        assert_eq!(vault.name(), "Changed outside");
        drop(vault);
        let (vault, report) = Vault::unlock_with_password(&dir, PW).unwrap();
        assert!(
            report.header_mac_mismatch,
            "still pending: nothing accepted"
        );
        drop(vault);
    }

    /// A rename that dies between the two files (the write hook between `vault.json` and `.bak`): `vault.json` is
    /// ahead, with the new name, and the vault in the session already says so. Each credential is tried on its own
    /// copy of the interrupted folder: a read-only open writes nothing, a writable unlock opens `vault.json` (no
    /// Ask 9) and repairs the spare, and both credentials still work. A third copy that lost `vault.json` opens the
    /// spare (Ask 9) with the old name.
    #[test]
    fn rename_interrupted_is_repaired_at_the_next_writable_unlock() {
        let parent = TempDir::new();
        let created = Vault::create(parent.path(), "Family", PW).unwrap();
        let recovery = created.recovery;
        let mut vault = created.vault;
        let dir = vault.dir().to_path_buf();
        let (old_main, old_bak) = read_pair(&dir);
        assert_eq!(old_main, old_bak);

        failpoint::arm("write_headers.before_second");
        let result = vault.rename("Renamed");
        failpoint::disarm_all();
        assert!(matches!(result, Err(CoreError::Io(_))));
        assert_eq!(
            vault.name(),
            "Renamed",
            "vault.json landed: the name is live"
        );
        assert_eq!(vault.unverified_slot(), None);
        assert!(!vault.guard.uncertain);
        drop(vault);
        let (main, bak) = read_pair(&dir);
        assert_ne!(main, bak, "interrupted: vault.json is ahead of .bak");
        assert_eq!(bak, old_bak);
        assert_eq!(header_on_disk(&dir, HEADER_FILE).name, "Renamed");

        let by_password = parent.path().join("by-password");
        copy_folder(&dir, &by_password);
        assert!(opens_read_only(&by_password, Credential::Password(PW)));
        assert_eq!(read_pair(&by_password), (main.clone(), bak.clone()));
        let (vault, report) = Vault::unlock_with_password(&by_password, PW).unwrap();
        assert!(!report.used_backup_header, "no Ask 9");
        assert!(!report.header_mac_mismatch, "no Ask 3");
        assert!(!report.header_repair_failed);
        assert_eq!(vault.name(), "Renamed");
        drop(vault);
        assert_eq!(read_pair(&by_password), (main.clone(), main.clone()));
        assert!(Vault::unlock_with_recovery(&by_password, &recovery).is_ok());

        let by_key = parent.path().join("by-recovery-key");
        copy_folder(&dir, &by_key);
        assert!(opens_read_only(&by_key, Credential::Recovery(&recovery)));
        assert_eq!(read_pair(&by_key), (main.clone(), bak.clone()));
        let (vault, report) = Vault::unlock_with_recovery(&by_key, &recovery).unwrap();
        assert!(!report.used_backup_header && !report.header_mac_mismatch);
        assert_eq!(vault.name(), "Renamed");
        drop(vault);
        assert_eq!(read_pair(&by_key), (main.clone(), main.clone()));
        assert!(Vault::unlock_with_password(&by_key, PW).is_ok());

        // vault.json lost before any repair: the spare opens, with the old name (Ask 9), and the new name is gone
        // with the file; nothing else is lost.
        let lost = parent.path().join("main-lost");
        copy_folder(&dir, &lost);
        fs::remove_file(lost.join(HEADER_FILE)).unwrap();
        let (vault, report) = Vault::unlock_with_password(&lost, PW).unwrap();
        assert!(report.used_backup_header, "Ask 9: the spare opened");
        assert!(!report.header_mac_mismatch);
        assert_eq!(vault.name(), "Family");
        drop(vault);
        assert!(Vault::unlock_with_recovery(&lost, &recovery).is_ok());
    }

    /// A write that dies before `vault.json` is touched changes nothing: the old name stays live, both files are as
    /// they were, and a retry goes through.
    #[test]
    fn rename_failed_before_vault_json_changes_nothing() {
        let parent = TempDir::new();
        let mut vault = Vault::create(parent.path(), "Family", PW).unwrap().vault;
        let dir = vault.dir().to_path_buf();
        let before = read_pair(&dir);
        failpoint::arm("write_headers.before_first");
        let result = vault.rename("Renamed");
        failpoint::disarm_all();
        assert!(matches!(result, Err(CoreError::Io(_))));
        assert_eq!(vault.name(), "Family");
        assert_eq!(read_pair(&dir), before);
        vault.rename("Renamed").unwrap();
        assert_eq!(read_vault_name(&dir).unwrap(), "Renamed");
        let (main, bak) = read_pair(&dir);
        assert_eq!(main, bak);
    }
}
