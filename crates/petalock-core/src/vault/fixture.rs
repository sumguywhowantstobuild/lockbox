//! Backups made for tests of the shell (the `test-internals` feature, and this crate's own tests): real ones, written
//! by the engine, that a live vault can be made to fail to hold a file of.

use super::Vault;
use crate::blob::{CancelToken, NoJournal, NoProgress};
use crate::header::write_headers;
use crate::ids::{FileId, ItemId};
use crate::item::ItemKind;
use crate::kdf::derive_password_key;
use crate::secret::{Key32, random_bytes};
use crate::slots::{SlotType, wrap_slot};
use std::fs;
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

/// The name of the vault the backup was made from.
pub const SOURCE_VAULT: &str = "Source";
/// The item's title.
pub const ITEM_TITLE: &str = "Photos";
/// The attached file the backup holds, and the one it does not.
pub const KEPT_FILE: &str = "kept.txt";
pub const LOST_FILE: &str = "lost.txt";
/// The backup's file name, in the folder it is made in.
pub const BACKUP_NAME: &str = "missing-a-file.petalock-backup";

/// A vault, and a backup of one, made by the engine at commit 009c52d, before the product was renamed to Petalock
/// (made-up data only: `MU-`). Kept as text, one `FILE <path> <hex>` line per file, so the bytes in the repository are
/// the bytes the old engine wrote.
const VAULT_BEFORE_THE_RENAME: &str = include_str!("../fixtures/vault-before-the-rename.txt");
const BACKUP_BEFORE_THE_RENAME: &str = include_str!("../fixtures/backup-before-the-rename.txt");

/// What a "before the rename" fixture was made with, and where it was written.
#[derive(Debug)]
pub struct BeforeTheRename {
    /// The vault's folder, or the backup file.
    pub path: PathBuf,
    /// The vault's password.
    pub password: String,
    /// The vault's recovery key, as shown to the person (a vault fixture only).
    pub recovery: Option<String>,
    /// The vault's name.
    pub vault_name: String,
    /// The title of the one item in it.
    pub title: String,
}

fn fixture_field<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    text.lines()
        .find_map(|line| line.strip_prefix(name)?.strip_prefix(' '))
}

fn unhex(hex: &str) -> Vec<u8> {
    assert_eq!(hex.len() % 2, 0, "an odd number of hex digits");
    (0..hex.len() / 2)
        .map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).expect("hex"))
        .collect()
}

/// Writes the `FILE` lines of `text` under `root`, creating the folders they need; how many were written.
fn write_fixture_files(text: &str, root: &Path, rename: &dyn Fn(&str) -> String) -> usize {
    let mut written = 0;
    for line in text.lines().filter_map(|l| l.strip_prefix("FILE ")) {
        let (name, hex) = line
            .split_once(' ')
            .expect("a file line has a name and bytes");
        let target = root.join(rename(name));
        fs::create_dir_all(target.parent().expect("a parent")).expect("the folder is made");
        fs::write(&target, unhex(hex)).expect("the fixture file is written");
        written += 1;
    }
    written
}

fn described(text: &str, path: PathBuf, vault_name: &str) -> BeforeTheRename {
    let field = |name: &str| fixture_field(text, name).map(str::to_owned);
    BeforeTheRename {
        path,
        password: field("PASSWORD").expect("the fixture names its password"),
        recovery: field("RECOVERY"),
        vault_name: vault_name.to_owned(),
        title: field("TITLE").expect("the fixture names its item"),
    }
}

/// Writes the vault made before the rename into a new folder inside `parent`, as it was written (nothing locked,
/// nothing opened), and says how to unlock it.
pub fn vault_before_the_rename(parent: &Path) -> BeforeTheRename {
    let text = VAULT_BEFORE_THE_RENAME;
    let folder = parent.join(fixture_field(text, "FOLDER").expect("the fixture names its folder"));
    let written = write_fixture_files(text, &folder, &|name| name.to_owned());
    assert!(written > 0, "the vault fixture holds no files");
    let name = fixture_field(text, "NAME").expect("the fixture names the vault");
    described(text, folder, name)
}

/// Writes the backup made before the rename to `dir/file_name` (a test gives it the `.petalock-backup` ending, as a
/// person would who renamed an old file), and says how to open it.
pub fn backup_before_the_rename(dir: &Path, file_name: &str) -> BeforeTheRename {
    let text = BACKUP_BEFORE_THE_RENAME;
    let written = write_fixture_files(text, dir, &|_| file_name.to_owned());
    assert_eq!(written, 1, "the backup fixture is one file");
    let name = fixture_field(text, "VAULT").expect("the fixture names the vault");
    described(text, dir.join(file_name), name)
}

/// A backup whose one item refers to a file the backup does not hold.
#[derive(Debug)]
pub struct BackupMissingAFile {
    /// The backup file.
    pub backup: PathBuf,
    /// The login that has both files attached, in the order [`KEPT_FILE`], [`LOST_FILE`].
    pub item: ItemId,
    pub kept: FileId,
    pub lost: FileId,
}

/// Makes a vault named [`SOURCE_VAULT`] in a new folder inside `dir`, with `password`; stores in it one login, [`ITEM_TITLE`],
/// with two files attached; loses the blob of [`LOST_FILE`] from the vault's folder, as a disk fault or a failed sync would;
/// and writes the engine's own backup of it to `dir/`[`BACKUP_NAME`]. The backup opens, with the item and [`KEPT_FILE`], and
/// only [`LOST_FILE`] is missing from it (its entry was never written). The vault is closed again before this returns.
pub fn backup_missing_a_file(dir: &Path, password: &str) -> BackupMissingAFile {
    let mut vault = Vault::create(dir, SOURCE_VAULT, password)
        .expect("the source vault is made")
        .vault;
    let kind = ItemKind::Login {
        username: "ariel".to_owned(),
        password: Zeroizing::new("hunter22".to_owned()),
        urls: Vec::new(),
        previous_passwords: Vec::new(),
    };
    let item = vault
        .new_item(kind, ITEM_TITLE, None)
        .expect("the item is stored");
    let cancel = CancelToken::new();
    let mut attach = |name: &str, bytes: &[u8]| {
        let source = dir.join(name);
        fs::write(&source, bytes).expect("the file is written");
        let file = vault
            .attach_file(&item, &source, &cancel, &NoProgress)
            .expect("the file is attached");
        fs::remove_file(&source).expect("the source file is removed");
        file
    };
    let kept = attach(KEPT_FILE, b"the file the backup holds");
    let lost = attach(LOST_FILE, b"the file the backup lost");
    let blob = vault
        .dir()
        .join("files")
        .join(format!("{}.blob", lost.to_hex()));
    fs::remove_file(blob).expect("the blob is lost");
    let backup = dir.join(BACKUP_NAME);
    vault
        .backup(&backup, &NoJournal, &cancel, &NoProgress)
        .expect("the backup is written");
    BackupMissingAFile {
        backup,
        item,
        kept,
        lost,
    }
}

/// Swaps the open vault's password slot, in memory and in both header files, for an authentic one: it opens with
/// `password` (its own salt and the old settings, a tag that verifies) but wraps a different, random key than the
/// vault's. What a check of the current password must still refuse: the slot is genuine, only its key is not this
/// vault's. Nothing else in the header changes.
pub fn password_slot_wrapping_another_key(vault: &mut Vault, password: &str) {
    let params = vault
        .header
        .slots
        .iter()
        .find(|s| s.slot_type == SlotType::Password)
        .and_then(|s| s.kdf)
        .expect("the vault has a password slot");
    let salt = random_bytes::<16>();
    let key = derive_password_key(password, &salt, &params).expect("the password key is derived");
    let slot = wrap_slot(
        SlotType::Password,
        &vault.header.vault_id,
        salt,
        Some(params),
        &key,
        &Key32::random(),
    );
    let mut header = vault.header.clone();
    let target = header
        .slots
        .iter_mut()
        .find(|s| s.slot_type == SlotType::Password)
        .expect("the vault has a password slot");
    *target = slot;
    write_headers(&vault.dir, &header).expect("the headers are written");
    vault.header = header;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsio::testutil::TempDir;
    use crate::recovery::RecoverySecret;
    use crate::vault::{Credential, ReadOnlyVault, verify_backup};
    use crate::{CoreError, Result};

    const PW: &str = "correct horse battery";

    /// Plan 5, Task 0c, `format_labels_unchanged`: the product's rename touched no label of the vault and backup
    /// format. A vault and a backup written by the engine at 009c52d, before the rename, still unlock and open: by
    /// password and by recovery key (the labels `lockbox/header`, `lockbox header mac v1`, `lockbox/slot`,
    /// `lockbox/item`, `lockbox/chunk`, `lockbox/backup-manifest`, `lockbox backup manifest v1` and
    /// `lockbox recovery key v1` all go into these checks), and the attached file reads back whole. The known-answer
    /// tests of each label stay in their own modules, unchanged.
    #[test]
    fn format_labels_unchanged() {
        let parent = TempDir::new();
        let cancel = CancelToken::new();

        let old = vault_before_the_rename(parent.path());
        let (vault, report) = Vault::unlock_with_password(&old.path, &old.password).unwrap();
        assert!(!report.used_backup_header && !report.header_mac_mismatch);
        assert_eq!(vault.name(), old.vault_name);
        let items: Vec<_> = vault.items().collect();
        assert_eq!(items.len(), 1, "the one item of the old vault");
        assert_eq!(items[0].title, old.title);
        assert_eq!(items[0].attachments.len(), 1, "and its one file");
        let copy = parent.path().join("MU-copy.txt");
        vault
            .export_file(
                &items[0].id,
                &items[0].attachments[0].file_id,
                &copy,
                &NoJournal,
                &cancel,
                &NoProgress,
            )
            .unwrap();
        assert_eq!(fs::read(&copy).unwrap(), b"MU-attached-file-bytes");
        drop(vault);
        let recovery = RecoverySecret::parse(old.recovery.as_deref().unwrap()).unwrap();
        let (vault, _) = Vault::unlock_with_recovery(&old.path, &recovery).unwrap();
        assert_eq!(vault.name(), old.vault_name);
        drop(vault);
        assert!(matches!(
            Vault::unlock_with_password(&old.path, "not the password"),
            Err(CoreError::WrongPassword)
        ));

        let backup = backup_before_the_rename(parent.path(), "made-before.petalock-backup");
        let found = verify_backup(
            &backup.path,
            Credential::Password(&backup.password),
            &cancel,
            &NoProgress,
        )
        .unwrap();
        assert_eq!(
            (
                found.name.as_str(),
                found.items,
                found.files,
                found.missing_files
            ),
            (backup.vault_name.as_str(), 1, 1, 0)
        );
        let opened = ReadOnlyVault::open_backup(
            &backup.path,
            Credential::Password(&backup.password),
            &cancel,
            &NoProgress,
        )
        .unwrap();
        assert_eq!(opened.items().count(), 1);
        assert_eq!(opened.items().next().unwrap().title, backup.title);
        // The vault fixture's recovery key opens the backup too: the same vault, the same recovery slot.
        ReadOnlyVault::open_backup(
            &backup.path,
            Credential::Recovery(&recovery),
            &cancel,
            &NoProgress,
        )
        .unwrap();
    }

    /// The backup is the engine's own, opens with the password, counts one missing file, and lacks exactly that one:
    /// copying without it asks, and copying with the question answered leaves it out.
    #[test]
    fn the_backup_opens_and_lacks_only_the_lost_file() {
        let parent = TempDir::new();
        let made = backup_missing_a_file(parent.path(), PW);
        let found = verify_backup(
            &made.backup,
            Credential::Password(PW),
            &CancelToken::new(),
            &NoProgress,
        )
        .unwrap();
        assert_eq!((found.items, found.files, found.missing_files), (1, 1, 1));

        let opened = ReadOnlyVault::open_backup(
            &made.backup,
            Credential::Password(PW),
            &CancelToken::new(),
            &NoProgress,
        )
        .unwrap();
        let item = opened.get_item(&made.item).unwrap();
        assert_eq!(item.title, ITEM_TITLE);
        let names: Vec<&str> = item.attachments.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, [KEPT_FILE, LOST_FILE]);
        assert_eq!(item.attachments[0].file_id, made.kept);
        assert_eq!(item.attachments[1].file_id, made.lost);
        assert_eq!(opened.missing_attachments(&made.item).unwrap(), [made.lost]);

        let live_parent = TempDir::new();
        let mut live = Vault::create(live_parent.path(), "Live", PW).unwrap().vault;
        let cancel = CancelToken::new();
        let asked: Result<_> = live.copy_item_from(&opened, &made.item, None, false, &cancel);
        assert!(
            matches!(
                asked,
                Err(CoreError::Damaged {
                    what: "file missing"
                })
            ),
            "{asked:?}"
        );
        let copied = live
            .copy_item_from(&opened, &made.item, None, true, &cancel)
            .unwrap();
        assert_eq!(copied.left_out, [made.lost]);
        assert_eq!(live.get_item(&copied.id).unwrap().attachments.len(), 1);
    }
}
