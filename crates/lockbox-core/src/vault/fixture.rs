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
pub const BACKUP_NAME: &str = "missing-a-file.lockbox-backup";

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
    use crate::vault::{Credential, ReadOnlyVault, verify_backup};
    use crate::{CoreError, Result};

    const PW: &str = "correct horse battery";

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
