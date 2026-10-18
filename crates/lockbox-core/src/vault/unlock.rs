//! Opening a vault (spec 6.3): `vault.json` first, `.bak` as the fallback, then a careful repair.

use super::{HeaderGuard, UnlockReport, Unverified, Vault, items};
use crate::fsio::{atomic_write, read_retry};
use crate::header::{
    HEADER_BACKUP, HEADER_FILE, MAX_HEADER_BYTES, VaultHeader, parse_header, verify_header_mac,
};
use crate::kdf::{Argon2Params, derive_password_key};
use crate::lockfile::VaultLock;
use crate::recovery::{RecoverySecret, derive_recovery_key};
use crate::search::SearchIndex;
use crate::secret::Key32;
use crate::slots::{KeySlot, SlotType, check_slot_version, unwrap_slot};
use crate::{CoreError, Result};
use std::path::Path;
use std::sync::Arc;

/// What the user typed to open the vault.
pub enum Credential<'a> {
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
    pub(super) bytes: Vec<u8>,
    pub(super) header: VaultHeader,
}

impl HeaderFile {
    /// Parses `bytes` (a folder's `vault.json` or an archive's), keeping them for copying.
    pub(super) fn from_bytes(bytes: Vec<u8>) -> Result<HeaderFile> {
        let header = parse_header(&bytes)?;
        Ok(HeaderFile { bytes, header })
    }
}

/// Reads and parses one header file, retrying while another program holds it. `read_retry`
/// reads at most `MAX_HEADER_BYTES + 1` bytes, so an oversized file is noticed
/// (`parse_header` refuses it) without loading all of it.
pub(super) fn load(path: &Path) -> Result<HeaderFile> {
    HeaderFile::from_bytes(read_retry(path, MAX_HEADER_BYTES)?)
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
            check_slot_version(slot)?;
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
            check_slot_version(slot)?;
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
                && differing_slot(other, used, unused).is_none()
        }
        // A newer-format file or an unreadable one (not "missing") is not ours to replace.
        Err(CoreError::UnsupportedVersion) => false,
        Err(CoreError::Io(e)) => e.kind() == std::io::ErrorKind::NotFound,
        Err(_) => true,
    }
}

/// The other copy's `unused` slot, when it is the same vault yet holds a different one.
fn differing_slot<'a>(
    other: &'a HeaderFile,
    used: &HeaderFile,
    unused: SlotType,
) -> Option<&'a KeySlot> {
    let theirs = slot_of(&other.header, unused).ok()?;
    (other.header.vault_id == used.header.vault_id
        && Some(theirs) != slot_of(&used.header, unused).ok())
    .then_some(theirs)
}

fn repair(file: &Path, bytes: &[u8]) -> Result<()> {
    #[cfg(test)]
    crate::fsio::failpoint::check("unlock.repair_write")?;
    atomic_write(file, bytes)
}

/// An owned copy of an error held by reference. An I/O error keeps its OS code, else its kind.
fn copy_error(error: &CoreError) -> CoreError {
    match error {
        CoreError::WrongPassword => CoreError::WrongPassword,
        CoreError::RecoveryKeyTypo => CoreError::RecoveryKeyTypo,
        CoreError::InvalidRecoveryKey => CoreError::InvalidRecoveryKey,
        CoreError::Damaged { what } => CoreError::Damaged { what },
        CoreError::PasswordTooShort { min } => CoreError::PasswordTooShort { min: *min },
        CoreError::NotEnoughSpace { needed, available } => CoreError::NotEnoughSpace {
            needed: *needed,
            available: *available,
        },
        CoreError::FileSystemLimit { max_file } => CoreError::FileSystemLimit {
            max_file: *max_file,
        },
        CoreError::UnsupportedVersion => CoreError::UnsupportedVersion,
        CoreError::ParamsOutOfBounds => CoreError::ParamsOutOfBounds,
        CoreError::TooLarge { what } => CoreError::TooLarge { what },
        CoreError::InvalidInput { what } => CoreError::InvalidInput { what },
        CoreError::VaultInUse => CoreError::VaultInUse,
        CoreError::NotFound => CoreError::NotFound,
        CoreError::Cancelled => CoreError::Cancelled,
        CoreError::Io(e) => CoreError::Io(match e.raw_os_error() {
            Some(code) => std::io::Error::from_raw_os_error(code),
            None => e.kind().into(),
        }),
    }
}

/// Picks the header copy that opens with `credential` (the `.bak` fallback rule, shared by
/// unlocking a folder and unlocking a backup) and returns it with the vault key and whether it
/// is `backup`. A parseable `main` only falls back to a `backup` of the same vault. Writes nothing.
pub(super) fn choose_header<'a>(
    main: &'a Result<HeaderFile>,
    backup: &'a Result<HeaderFile>,
    credential: &Credential,
) -> Result<(&'a HeaderFile, Key32, bool)> {
    let mut cache = None;
    Ok(match (main, backup) {
        (Ok(m), _) => match unwrap_with(&m.header, credential, &mut cache) {
            Ok(key) => (m, key, false),
            Err(error) => {
                let same_vault = backup.as_ref().ok().filter(|b| {
                    may_try_backup(&error)
                        && b.bytes != m.bytes
                        && b.header.vault_id == m.header.vault_id
                });
                match same_vault.map(|b| (b, unwrap_with(&b.header, credential, &mut cache))) {
                    Some((b, Ok(key))) => (b, key, true),
                    _ => return Err(error),
                }
            }
        },
        (Err(error), Ok(b)) if may_try_backup(error) => {
            // A parsed header that rejects the secret is a wrong password, not damage.
            (b, unwrap_with(&b.header, credential, &mut cache)?, true)
        }
        (Err(error), _) => return Err(copy_error(error)),
    })
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
    // `used_backup` is true when the copy that unlocked is `.bak`.
    let (used, key, used_backup) = choose_header(&main, &backup, &credential)?;

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
    // Both files are left alone then, so later header writes must not spread the unchecked slot.
    let unused = credential.unused_slot();
    let unverified = other
        .as_ref()
        .ok()
        .and_then(|o| differing_slot(o, used, unused))
        .map(|slot| Unverified {
            slot_type: unused,
            other: slot.clone(),
            other_is_backup: !used_backup,
        });
    let mut vault = Vault {
        guard: HeaderGuard {
            consent_pending: !mac_ok,
            unverified,
            uncertain: false,
        },
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsio::testutil::TempDir;

    #[test]
    fn load_refuses_an_oversized_header() {
        let dir = TempDir::new();
        let path = dir.path().join(HEADER_FILE);
        std::fs::write(&path, vec![b' '; MAX_HEADER_BYTES + 100]).unwrap();
        assert!(matches!(load(&path), Err(CoreError::TooLarge { .. })));
    }

    #[test]
    fn unknown_slot_version_is_refused_before_any_key_derivation() {
        let parent = TempDir::new();
        let created = Vault::create(parent.path(), "Family", "correct horse battery").unwrap();
        let dir = created.vault.dir().to_path_buf();
        drop(created.vault);
        let mut header = load(&dir.join(HEADER_FILE)).unwrap().header;
        for slot in &mut header.slots {
            slot.slot_version += 1;
            // Settings `derive_password_key` refuses at once: reaching it would not be
            // `UnsupportedVersion`, so this proves the version is checked first.
            slot.kdf = slot.kdf.map(|p| Argon2Params { memory_kib: 1, ..p });
        }
        let credentials = [
            Credential::Password("correct horse battery"),
            Credential::Recovery(&created.recovery),
        ];
        for credential in &credentials {
            assert!(matches!(
                unwrap_with(&header, credential, &mut None),
                Err(CoreError::UnsupportedVersion)
            ));
        }
    }

    #[test]
    fn load_reports_a_missing_file_as_not_found() {
        let dir = TempDir::new();
        let result = load(&dir.path().join(HEADER_FILE));
        assert!(
            matches!(result, Err(CoreError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound)
        );
    }

    #[cfg(windows)]
    #[test]
    fn load_retries_while_another_program_holds_the_file() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = TempDir::new();
        let path = dir.path().join(HEADER_FILE);
        std::fs::write(&path, b"{}").unwrap();
        let (opened_tx, opened_rx) = std::sync::mpsc::channel();
        let (probed_tx, probed_rx) = std::sync::mpsc::channel::<()>();
        let holder_path = path.clone();
        let holder = std::thread::spawn(move || {
            // Share nothing, so every other open fails with a sharing violation.
            let _held = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(holder_path)
                .unwrap();
            opened_tx.send(()).unwrap();
            probed_rx.recv().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(100));
        });
        opened_rx.recv().unwrap();
        assert!(std::fs::File::open(&path).is_err());
        probed_tx.send(()).unwrap();
        // `{}` is not a header, so a parse error (not an I/O one) proves the read got through.
        assert!(!matches!(load(&path), Err(CoreError::Io(_))));
        holder.join().unwrap();
    }
}
