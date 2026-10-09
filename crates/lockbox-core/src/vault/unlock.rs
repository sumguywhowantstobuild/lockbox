//! Opening a vault (spec 6.3): `vault.json` first, `.bak` as the fallback, then repair.

use super::{CleanupReport, UnlockReport, Vault};
use crate::header::{
    HEADER_BACKUP, HEADER_FILE, MAX_HEADER_BYTES, VaultHeader, parse_header, verify_header_mac,
    write_headers,
};
use crate::kdf::{Argon2Params, derive_password_key};
use crate::lockfile::VaultLock;
use crate::recovery::{RecoverySecret, derive_recovery_key};
use crate::secret::Key32;
use crate::slots::{KeySlot, SlotType, unwrap_slot};
use crate::{CoreError, Result};
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;
use std::sync::Arc;

/// What the user typed to open the vault.
pub(super) enum Credential<'a> {
    Password(&'a str),
    Recovery(&'a RecoverySecret),
}

/// The password key from the last Argon2 run, kept so a second header with the same
/// salt and settings (`.bak`) does not cost a second ~1 s derivation.
struct Derived {
    salt: [u8; 16],
    params: Argon2Params,
    key: Key32,
}

/// Reads at most `MAX_HEADER_BYTES + 1` bytes, so an oversized file is noticed
/// (`parse_header` refuses it) without loading all of it.
fn read_header_file(path: &Path) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(MAX_HEADER_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
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

/// Parses one header copy and unwraps its slot for `credential`.
fn try_copy(
    bytes: &[u8],
    credential: &Credential,
    cache: &mut Option<Derived>,
) -> Result<(VaultHeader, Key32)> {
    let header = parse_header(bytes)?;
    let key = match credential {
        Credential::Password(password) => {
            let slot = slot_of(&header, SlotType::Password)?;
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
            unwrapped?
        }
        Credential::Recovery(secret) => {
            let slot = slot_of(&header, SlotType::Recovery)?;
            unwrap_slot(
                slot,
                &header.vault_id,
                &derive_recovery_key(secret, &slot.salt),
            )?
        }
    };
    Ok((header, key))
}

/// Opens the vault in `dir`. The lock comes first, so nothing is read from a vault
/// another process has open.
pub(super) fn open(dir: &Path, credential: Credential) -> Result<(Vault, UnlockReport)> {
    let lock = VaultLock::acquire(dir)?;
    let main = read_header_file(&dir.join(HEADER_FILE));
    let backup = read_header_file(&dir.join(HEADER_BACKUP)).ok();
    let mut cache = None;

    let first = match &main {
        Ok(bytes) => try_copy(bytes, &credential, &mut cache),
        Err(e) => Err(io::Error::from(e.kind()).into()),
    };
    let (header, key, used, used_backup_header) = match first {
        Ok((header, key)) => (header, key, main.as_deref().ok(), false),
        Err(first_error) => {
            let fallback = backup
                .as_deref()
                .filter(|b| may_try_backup(&first_error) && main.as_deref().ok() != Some(*b));
            // Any failure of the backup is reported as the failure of `vault.json`.
            let Some(bytes) = fallback else {
                return Err(first_error);
            };
            let Ok((header, key)) = try_copy(bytes, &credential, &mut cache) else {
                return Err(first_error);
            };
            (header, key, Some(bytes), true)
        }
    };

    // Repair: both files must hold exactly the copy that just worked.
    let healthy = main.as_deref().ok() == used && backup.as_deref() == used;
    if !healthy {
        write_headers(dir, &header)?;
    }
    let report = UnlockReport {
        used_backup_header,
        header_mac_mismatch: !verify_header_mac(&header, &key),
        cleanup: CleanupReport::default(),
    };
    let vault = Vault {
        dir: dir.to_path_buf(),
        header,
        vault_key: Arc::new(key),
        _lock: lock,
    };
    Ok((vault, report))
}

/// The vault's name, read without unlocking (for the list of vaults). Falls back to
/// `.bak` like unlocking does; if both fail, the `vault.json` error is returned.
pub fn read_vault_name(dir: &Path) -> Result<String> {
    let read = |file| -> Result<VaultHeader> { parse_header(&read_header_file(&dir.join(file))?) };
    match read(HEADER_FILE) {
        Ok(header) => Ok(header.name),
        Err(e) if may_try_backup(&e) => read(HEADER_BACKUP).map(|h| h.name).or(Err(e)),
        Err(e) => Err(e),
    }
}
