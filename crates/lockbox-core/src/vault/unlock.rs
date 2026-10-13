//! Opening a vault (spec 6.3): `vault.json` first, `.bak` as the fallback, then a careful repair.

use super::{UnlockReport, Vault, items};
use crate::fsio::atomic_write;
use crate::header::{
    HEADER_BACKUP, HEADER_FILE, MAX_HEADER_BYTES, VaultHeader, parse_header, verify_header_mac,
};
use crate::kdf::{Argon2Params, derive_password_key};
use crate::lockfile::VaultLock;
use crate::recovery::{RecoverySecret, derive_recovery_key};
use crate::search::SearchIndex;
use crate::secret::Key32;
use crate::slots::{KeySlot, SlotType, unwrap_slot};
use crate::{CoreError, Result};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;

/// What the user typed to open the vault.
pub(super) enum Credential<'a> {
    Password(&'a str),
    Recovery(&'a RecoverySecret),
}

impl Credential<'_> {
    /// The slot this credential does not open, so unlocking cannot vouch for it.
    fn unused_slot(&self) -> SlotType {
        match self {
            Credential::Password(_) => SlotType::Recovery,
            Credential::Recovery(_) => SlotType::Password,
        }
    }
}

/// The password key from the last Argon2 run, kept so a second header with the same
/// salt and settings (`.bak`) does not cost a second ~1 s derivation.
struct Derived {
    salt: [u8; 16],
    params: Argon2Params,
    key: Key32,
}

/// A header file as read: the exact bytes (for copying) and what they parse to.
pub(super) struct HeaderFile {
    bytes: Vec<u8>,
    pub(super) header: VaultHeader,
}

/// Reads and parses one header file. Reads at most `MAX_HEADER_BYTES + 1` bytes, so an
/// oversized file is noticed (`parse_header` refuses it) without loading all of it.
pub(super) fn load(path: &Path) -> Result<HeaderFile> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(MAX_HEADER_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    let header = parse_header(&bytes)?;
    Ok(HeaderFile { bytes, header })
}

/// A newer vault must say "update Lockbox", never be opened from an older `.bak`
/// (which would then overwrite a half-finished upgrade).
fn may_try_backup(error: &CoreError) -> bool {
    !matches!(error, CoreError::UnsupportedVersion)
}

fn slot_of(header: &VaultHeader, slot_type: SlotType) -> Result<&KeySlot> {
    header
        .slots
        .iter()
        .find(|s| s.slot_type == slot_type)
        .ok_or(CoreError::Damaged { what: "key slots" })
}

/// Unwraps the vault key from `header`'s slot for `credential`.
fn unwrap_with(
    header: &VaultHeader,
    credential: &Credential,
    cache: &mut Option<Derived>,
) -> Result<Key32> {
    match credential {
        Credential::Password(password) => {
            let slot = slot_of(header, SlotType::Password)?;
            let params = slot.kdf.ok_or(CoreError::Damaged { what: "key slots" })?;
            let derived = match cache.take() {
                Some(d) if d.salt == slot.salt && d.params == params => d,
                _ => Derived {
                    salt: slot.salt,
                    params,
                    key: derive_password_key(password, &slot.salt, &params)?,
                },
            };
            let unwrapped = unwrap_slot(slot, &header.vault_id, &derived.key);
            *cache = Some(derived);
            unwrapped
        }
        Credential::Recovery(secret) => {
            let slot = slot_of(header, SlotType::Recovery)?;
            unwrap_slot(
                slot,
                &header.vault_id,
                &derive_recovery_key(secret, &slot.salt),
            )
        }
    }
}

/// Whether the copy that did not unlock may be overwritten with the one that did. Only
/// when that cannot destroy anything unverified: the other file is missing or unparseable,
/// or it is the same vault and byte-identical in `unused`, the slot this unlock could not
/// check (a differing one could be the good copy of a damaged slot).
fn may_overwrite(other: &Result<HeaderFile>, used: &HeaderFile, unused: SlotType) -> bool {
    match other {
        Ok(other) => {
            other.bytes != used.bytes
                && other.header.vault_id == used.header.vault_id
                && slot_of(&other.header, unused).ok() == slot_of(&used.header, unused).ok()
        }
        // A newer-format file or an unreadable one (not "missing") is not ours to replace.
        Err(CoreError::UnsupportedVersion) => false,
        Err(CoreError::Io(e)) => e.kind() == std::io::ErrorKind::NotFound,
        Err(_) => true,
    }
}

fn repair(file: &Path, bytes: &[u8]) -> Result<()> {
    #[cfg(test)]
    crate::fsio::failpoint::check("unlock.repair_write")?;
    atomic_write(file, bytes)
}

/// Opens the vault in `dir`. A folder with no header at all is `NotFound`, checked
/// before anything is created in it. The lock comes next, so nothing is read from a
/// vault another process has open.
///
/// Fallback: if `vault.json` does not parse, or its slot rejects the secret, `.bak` is
/// tried, but a parseable `vault.json` only falls back to a `.bak` of the same vault.
/// Repair: the other copy is rewritten only when the header that unlocked passes its MAC
/// and the rewrite can lose nothing unverified (see [`may_overwrite`]). Otherwise both
/// files are left as they are. A repair that fails to write is reported in
/// `header_repair_failed` and does not fail the unlock. A MAC mismatch is only reported,
/// and `accept_header` writes after the user agrees.
pub(super) fn open(dir: &Path, credential: Credential) -> Result<(Vault, UnlockReport)> {
    if !dir.join(HEADER_FILE).try_exists()? && !dir.join(HEADER_BACKUP).try_exists()? {
        return Err(CoreError::NotFound);
    }
    let lock = VaultLock::acquire(dir)?;
    let main = load(&dir.join(HEADER_FILE));
    let backup = load(&dir.join(HEADER_BACKUP));
    let mut cache = None;

    // `used_backup` is true when the copy that unlocked is `.bak`.
    let (used, key, used_backup) = match (&main, &backup) {
        (Ok(m), _) => match unwrap_with(&m.header, &credential, &mut cache) {
            Ok(key) => (m, key, false),
            Err(error) => {
                let same_vault = backup.as_ref().ok().filter(|b| {
                    may_try_backup(&error)
                        && b.bytes != m.bytes
                        && b.header.vault_id == m.header.vault_id
                });
                match same_vault.map(|b| (b, unwrap_with(&b.header, &credential, &mut cache))) {
                    Some((b, Ok(key))) => (b, key, true),
                    _ => return Err(error),
                }
            }
        },
        (Err(error), Ok(b)) if may_try_backup(error) => {
            // A parsed header that rejects the secret is a wrong password, not damage.
            (b, unwrap_with(&b.header, &credential, &mut cache)?, true)
        }
        (Err(_), _) => return Err(main.err().unwrap_or(CoreError::NotFound)),
    };

    // Before any repair write: an items folder that cannot be listed fails the unlock cleanly.
    let (items, damaged) = items::load_all(dir, &used.header.vault_id, &key)?;
    let mac_ok = verify_header_mac(&used.header, &key);
    let (other, other_file) = if used_backup {
        (&main, HEADER_FILE)
    } else {
        (&backup, HEADER_BACKUP)
    };
    // A failed repair is reported, not fatal: the next unlock tries again.
    let header_repair_failed = mac_ok
        && may_overwrite(other, used, credential.unused_slot())
        && repair(&dir.join(other_file), &used.bytes).is_err();
    let mut vault = Vault {
        dir: dir.to_path_buf(),
        header: used.header.clone(),
        vault_key: Arc::new(key),
        index: SearchIndex::build(items.values()),
        items,
        damaged,
        _lock: lock,
    };
    // Last, once the vault is built: nothing else can run before cleanup has finished.
    let report = UnlockReport {
        used_backup_header: used_backup,
        header_mac_mismatch: !mac_ok,
        header_repair_failed,
        cleanup: vault.run_cleanup(),
    };
    Ok((vault, report))
}

/// The vault's name, read without unlocking (for the list of vaults). Falls back to
/// `.bak` like unlocking does; if both fail, the `vault.json` error is returned.
pub fn read_vault_name(dir: &Path) -> Result<String> {
    match load(&dir.join(HEADER_FILE)) {
        Ok(copy) => Ok(copy.header.name),
        Err(e) if may_try_backup(&e) => load(&dir.join(HEADER_BACKUP))
            .map(|c| c.header.name)
            .or(Err(e)),
        Err(e) => Err(e),
    }
}
