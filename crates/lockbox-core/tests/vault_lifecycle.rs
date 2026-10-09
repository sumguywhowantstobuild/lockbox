//! Vault lifecycle through the public API only: create, unlock, change password,
//! regenerate recovery, and the header fallbacks. Every create and unlock runs a real
//! ~1 s Argon2id derivation, so each test keeps its derivations to a minimum.

use lockbox_core::header::{
    HEADER_BACKUP, HEADER_FILE, VaultHeader, parse_header, serialize_header,
};
use lockbox_core::recovery::RecoverySecret;
use lockbox_core::slots::SlotType;
use lockbox_core::{CoreError, Vault, read_vault_name};
use std::fs;
use std::path::{Path, PathBuf};

const PW: &str = "correct horse battery";
const NEW_PW: &str = "a different long password";

/// Creates a vault, closes it, and returns its folder and recovery secret.
fn make(parent: &Path, name: &str) -> (PathBuf, RecoverySecret) {
    let created = Vault::create(parent, name, PW).unwrap();
    (created.vault.dir().to_path_buf(), created.recovery)
}

fn read_header(dir: &Path, file: &str) -> VaultHeader {
    parse_header(&fs::read(dir.join(file)).unwrap()).unwrap()
}

fn write_header(dir: &Path, file: &str, header: &VaultHeader) {
    fs::write(dir.join(file), serialize_header(header)).unwrap();
}

fn files_identical(dir: &Path) -> bool {
    fs::read(dir.join(HEADER_FILE)).unwrap() == fs::read(dir.join(HEADER_BACKUP)).unwrap()
}

fn is_wrong_password<T>(r: Result<T, CoreError>) -> bool {
    matches!(r, Err(CoreError::WrongPassword))
}

#[test]
fn create_then_unlock() {
    let parent = tempfile::tempdir().unwrap();
    let (dir, _recovery) = make(parent.path(), "Family");
    let (vault, report) = Vault::unlock_with_password(&dir, PW).unwrap();
    assert_eq!(vault.name(), "Family");
    assert_eq!(vault.dir(), dir);
    assert!(!report.used_backup_header && !report.header_mac_mismatch);
}

#[test]
fn wrong_password() {
    let parent = tempfile::tempdir().unwrap();
    let (dir, _recovery) = make(parent.path(), "Family");
    let result = Vault::unlock_with_password(&dir, "not the password");
    assert!(is_wrong_password(result));
}

#[test]
fn short_password_refused_when_set() {
    let parent = tempfile::tempdir().unwrap();
    assert!(matches!(
        Vault::create(parent.path(), "Family", "elevenchars"),
        Err(CoreError::PasswordTooShort { .. })
    ));
    assert_eq!(fs::read_dir(parent.path()).unwrap().count(), 0);

    let mut vault = Vault::create(parent.path(), "Family", PW).unwrap().vault;
    let dir = vault.dir().to_path_buf();
    assert!(matches!(
        vault.change_password("elevenchars"),
        Err(CoreError::PasswordTooShort { .. })
    ));
    drop(vault);
    // Unlock never checks length: a short guess is just a wrong password.
    assert!(is_wrong_password(Vault::unlock_with_password(
        &dir, "short"
    )));
    Vault::unlock_with_password(&dir, PW).unwrap();
}

#[test]
fn folder_layout() {
    let parent = tempfile::tempdir().unwrap();
    let (dir, _recovery) = make(parent.path(), "Family");
    for file in [HEADER_FILE, HEADER_BACKUP, ".lock"] {
        assert!(dir.join(file).is_file(), "{file}");
    }
    for folder in ["items", "files", "files/orphaned"] {
        assert!(dir.join(folder).is_dir(), "{folder}");
    }
    assert!(files_identical(&dir));
    // Only the vault folder is left in the parent: no staging folder.
    assert_eq!(fs::read_dir(parent.path()).unwrap().count(), 1);
}

#[test]
fn weird_names() {
    const RESERVED: [&str; 6] = ["CON", "PRN", "AUX", "NUL", "COM1", "LPT1"];
    let parent = tempfile::tempdir().unwrap();
    let long = "x".repeat(200);
    for name in ["Clients 🔐", "a<b>:c\"d/e\\f|g?h*", "CON", long.as_str()] {
        let vault = Vault::create(parent.path(), name, PW).unwrap().vault;
        let folder = vault.dir().file_name().unwrap().to_str().unwrap();
        assert!(folder.len() <= 64, "{folder}");
        assert!(
            folder
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || " _-".contains(c)),
            "{folder}"
        );
        assert!(!RESERVED.contains(&folder.to_ascii_uppercase().as_str()));
        assert!(folder.ends_with(&format!("-{}", &vault.id().to_hex()[..8])));
        assert_eq!(read_vault_name(vault.dir()).unwrap(), name);
    }
    for bad in ["", "   \t", &"x".repeat(201)] {
        assert!(matches!(
            Vault::create(parent.path(), bad, PW),
            Err(CoreError::InvalidInput { .. })
        ));
    }
    assert_eq!(fs::read_dir(parent.path()).unwrap().count(), 4);
}

#[test]
fn recovery_survives_password_changes() {
    let parent = tempfile::tempdir().unwrap();
    let created = Vault::create(parent.path(), "Family", PW).unwrap();
    let original = created.recovery.to_display();
    let mut vault = created.vault;
    let dir = vault.dir().to_path_buf();
    for pw in ["first new password", "second new password", NEW_PW] {
        vault.change_password(pw).unwrap();
    }
    drop(vault);
    let secret = RecoverySecret::parse(&original).unwrap();
    let (mut vault, _) = Vault::unlock_with_recovery(&dir, &secret).unwrap();
    vault.change_password("set after recovering").unwrap();
    drop(vault);
    Vault::unlock_with_password(&dir, "set after recovering").unwrap();
}

#[test]
fn old_password_fails_against_both_headers() {
    let parent = tempfile::tempdir().unwrap();
    let mut vault = Vault::create(parent.path(), "Family", PW).unwrap().vault;
    let dir = vault.dir().to_path_buf();
    let leftover = dir.join(".0123456789abcdef.tmp");
    fs::write(&leftover, b"crashed header write").unwrap();
    vault.change_password(NEW_PW).unwrap();
    drop(vault);
    assert!(!leftover.exists());
    assert!(files_identical(&dir));
    assert!(is_wrong_password(Vault::unlock_with_password(&dir, PW)));
    // With vault.json gone only .bak is left, and it holds no old password slot either.
    fs::remove_file(dir.join(HEADER_FILE)).unwrap();
    assert!(is_wrong_password(Vault::unlock_with_password(&dir, PW)));
    let (_, report) = Vault::unlock_with_password(&dir, NEW_PW).unwrap();
    assert!(report.used_backup_header);
    assert!(files_identical(&dir));
}

#[test]
fn regenerate_recovery() {
    let parent = tempfile::tempdir().unwrap();
    let created = Vault::create(parent.path(), "Family", PW).unwrap();
    let old = RecoverySecret::parse(&created.recovery.to_display()).unwrap();
    let mut vault = created.vault;
    let dir = vault.dir().to_path_buf();
    let leftover = dir.join(".0123456789abcdef.tmp");
    fs::write(&leftover, b"crashed header write").unwrap();
    let new = vault.regenerate_recovery().unwrap();
    drop(vault);
    assert!(!leftover.exists());
    assert!(is_wrong_password(Vault::unlock_with_recovery(&dir, &old)));
    Vault::unlock_with_recovery(&dir, &new).unwrap();
    Vault::unlock_with_password(&dir, PW).unwrap();
}

#[test]
fn bak_used_when_vault_json_unparseable() {
    let parent = tempfile::tempdir().unwrap();
    let (dir, _recovery) = make(parent.path(), "Family");
    fs::write(dir.join(HEADER_FILE), b"{\"container_ver").unwrap();
    assert_eq!(read_vault_name(&dir).unwrap(), "Family");
    let (vault, report) = Vault::unlock_with_password(&dir, PW).unwrap();
    assert!(report.used_backup_header);
    drop(vault);
    assert!(files_identical(&dir));
    let (_, report) = Vault::unlock_with_password(&dir, PW).unwrap();
    assert!(!report.used_backup_header);
}

#[test]
fn bak_used_when_password_slot_damaged() {
    let parent = tempfile::tempdir().unwrap();
    let (dir, _recovery) = make(parent.path(), "Family");
    let mut header = read_header(&dir, HEADER_FILE);
    let slot = header
        .slots
        .iter_mut()
        .find(|s| s.slot_type == SlotType::Password)
        .unwrap();
    slot.ciphertext[0] ^= 1;
    write_header(&dir, HEADER_FILE, &header);
    let (vault, report) = Vault::unlock_with_password(&dir, PW).unwrap();
    assert!(report.used_backup_header);
    drop(vault);
    assert!(files_identical(&dir));
}

#[test]
fn stale_bak_rewritten() {
    let parent = tempfile::tempdir().unwrap();
    let mut vault = Vault::create(parent.path(), "Family", PW).unwrap().vault;
    let dir = vault.dir().to_path_buf();
    let older = fs::read(dir.join(HEADER_BACKUP)).unwrap();
    vault.change_password(NEW_PW).unwrap();
    drop(vault);
    fs::write(dir.join(HEADER_BACKUP), older).unwrap();
    assert!(!files_identical(&dir));
    let (vault, report) = Vault::unlock_with_password(&dir, NEW_PW).unwrap();
    assert!(!report.used_backup_header);
    drop(vault);
    assert!(files_identical(&dir));
}

#[test]
fn header_mac_mismatch_reported() {
    let parent = tempfile::tempdir().unwrap();
    let (dir, _recovery) = make(parent.path(), "Family");
    let mut header = read_header(&dir, HEADER_FILE);
    header.name = "Renamed".to_owned();
    write_header(&dir, HEADER_FILE, &header);
    write_header(&dir, HEADER_BACKUP, &header);
    let (vault, report) = Vault::unlock_with_password(&dir, PW).unwrap();
    assert!(report.header_mac_mismatch && !report.used_backup_header);
    drop(vault);
    // Still reported until the user agrees to the new header.
    let (mut vault, report) = Vault::unlock_with_password(&dir, PW).unwrap();
    assert!(report.header_mac_mismatch);
    assert_eq!(vault.name(), "Renamed");
    vault.accept_header().unwrap();
    drop(vault);
    let (_, report) = Vault::unlock_with_password(&dir, PW).unwrap();
    assert!(!report.header_mac_mismatch);
}

#[test]
fn vault_in_use() {
    let parent = tempfile::tempdir().unwrap();
    let created = Vault::create(parent.path(), "Family", PW).unwrap();
    let dir = created.vault.dir().to_path_buf();
    // A freshly created vault is open too.
    assert!(matches!(
        Vault::unlock_with_password(&dir, PW),
        Err(CoreError::VaultInUse)
    ));
    drop(created);
    let (first, _) = Vault::unlock_with_password(&dir, PW).unwrap();
    assert!(matches!(
        Vault::unlock_with_password(&dir, PW),
        Err(CoreError::VaultInUse)
    ));
    drop(first);
}

#[test]
fn newer_vault_json_never_falls_back_to_bak() {
    let parent = tempfile::tempdir().unwrap();
    let (dir, _recovery) = make(parent.path(), "Family");
    let text = fs::read_to_string(dir.join(HEADER_FILE)).unwrap().replace(
        "\"migration\": null",
        "\"migration\": {\"from\":1,\"to\":2}",
    );
    fs::write(dir.join(HEADER_FILE), text).unwrap();
    assert!(matches!(
        Vault::unlock_with_password(&dir, PW),
        Err(CoreError::UnsupportedVersion)
    ));
}

#[test]
fn both_headers_damaged_reports_the_vault_json_error() {
    let parent = tempfile::tempdir().unwrap();
    let (dir, _recovery) = make(parent.path(), "Family");
    fs::write(dir.join(HEADER_FILE), b"nope").unwrap();
    fs::write(dir.join(HEADER_BACKUP), b"nope either").unwrap();
    assert!(matches!(
        Vault::unlock_with_password(&dir, PW),
        Err(CoreError::Damaged { .. })
    ));
    assert!(matches!(
        read_vault_name(&dir),
        Err(CoreError::Damaged { .. })
    ));
}

fn damage_slot(dir: &Path, file: &str, slot_type: SlotType) {
    let mut header = read_header(dir, file);
    let slot = header
        .slots
        .iter_mut()
        .find(|s| s.slot_type == slot_type)
        .unwrap();
    slot.ciphertext[0] ^= 1;
    write_header(dir, file, &header);
}

fn bytes_of(dir: &Path) -> (Vec<u8>, Vec<u8>) {
    (
        fs::read(dir.join(HEADER_FILE)).unwrap(),
        fs::read(dir.join(HEADER_BACKUP)).unwrap(),
    )
}

#[test]
fn foreign_backup_is_never_used() {
    let parent = tempfile::tempdir().unwrap();
    let (dir_a, _) = make(parent.path(), "Alpha");
    let (dir_b, _) = make(parent.path(), "Beta"); // same password, other vault
    fs::copy(dir_b.join(HEADER_FILE), dir_a.join(HEADER_BACKUP)).unwrap();
    damage_slot(&dir_a, HEADER_FILE, SlotType::Password);
    let before = bytes_of(&dir_a);
    assert!(is_wrong_password(Vault::unlock_with_password(&dir_a, PW)));
    assert_eq!(bytes_of(&dir_a), before);
}

#[test]
fn name_edited_in_vault_json_only_leaves_backup_untouched() {
    let parent = tempfile::tempdir().unwrap();
    let (dir, _recovery) = make(parent.path(), "Family");
    let mut header = read_header(&dir, HEADER_FILE);
    header.name = "Renamed".to_owned();
    write_header(&dir, HEADER_FILE, &header);
    let before = bytes_of(&dir);
    let (vault, report) = Vault::unlock_with_password(&dir, PW).unwrap();
    assert!(report.header_mac_mismatch && !report.used_backup_header);
    drop(vault);
    assert_eq!(bytes_of(&dir), before);
}

#[test]
fn damaged_recovery_slot_in_vault_json_does_not_overwrite_the_good_backup() {
    let parent = tempfile::tempdir().unwrap();
    let (dir, recovery) = make(parent.path(), "Family");
    damage_slot(&dir, HEADER_FILE, SlotType::Recovery);
    let before = bytes_of(&dir);
    let (vault, report) = Vault::unlock_with_password(&dir, PW).unwrap();
    assert!(!report.used_backup_header && !report.header_mac_mismatch);
    drop(vault);
    assert_eq!(bytes_of(&dir), before);
    // The recovery secret still works, from .bak.
    let (vault, report) = Vault::unlock_with_recovery(&dir, &recovery).unwrap();
    assert!(report.used_backup_header);
    drop(vault);
}

#[test]
fn damaged_password_slot_in_one_copy_does_not_overwrite_the_good_one_on_recovery_unlock() {
    let parent = tempfile::tempdir().unwrap();
    let (dir, recovery) = make(parent.path(), "Family");
    damage_slot(&dir, HEADER_FILE, SlotType::Password);
    let before = bytes_of(&dir);
    let (vault, report) = Vault::unlock_with_recovery(&dir, &recovery).unwrap();
    assert!(!report.used_backup_header);
    drop(vault);
    assert_eq!(bytes_of(&dir), before);
    // The password still works, from .bak.
    let (_, report) = Vault::unlock_with_password(&dir, PW).unwrap();
    assert!(report.used_backup_header);
}

#[test]
fn truncated_vault_json_with_wrong_password_is_wrong_password() {
    let parent = tempfile::tempdir().unwrap();
    let (dir, _recovery) = make(parent.path(), "Family");
    fs::write(dir.join(HEADER_FILE), b"{\"container_ver").unwrap();
    assert!(is_wrong_password(Vault::unlock_with_password(
        &dir,
        "not the password"
    )));
}

#[test]
fn folder_without_headers_is_not_found_and_gets_no_lock_file() {
    let dir = tempfile::tempdir().unwrap();
    assert!(matches!(
        Vault::unlock_with_password(dir.path(), PW),
        Err(CoreError::NotFound)
    ));
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
}
