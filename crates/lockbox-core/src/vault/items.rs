//! The items of an unlocked vault (spec 5.4): one sealed file each in `items/`, all of them
//! also held in memory while the vault is open.
//!
//! Every change is written first, then the in-memory copy is replaced. After a failed write,
//! memory adopts the item file when it reads back and opens (the write may have landed before
//! the error); otherwise memory is unchanged. Collections are flat (a collection holds items, never collections), and
//! "deleting" anything only moves it to the trash; purging is a later task's job.

use super::Vault;
use super::naming::{created_at_now, now_secs, rfc3339_utc};
use crate::fsio::{atomic_write, read_retry};
use crate::ids::{ItemId, VaultId};
use crate::item::{Item, ItemKind, MAX_ITEM_FILE, open_item, seal_item};
use crate::secret::Key32;
use crate::{CoreError, Result};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

pub(super) const ITEMS_DIR: &str = "items";
const ITEM_EXT: &str = ".item";
const SECS_PER_DAY: u64 = 86_400;
const ID_ATTEMPTS: u32 = 8;
/// An item whose purge was started is frozen: only `purge_item` may touch it again.
pub(super) const BEING_DELETED: CoreError = CoreError::InvalidInput {
    what: "being deleted",
};
const REVISION_OVERFLOW: CoreError = CoreError::InvalidInput {
    what: "revision overflow",
};

#[cfg(test)]
thread_local! {
    /// IDs the next `new_item` calls must try first (last one first), to force collisions.
    static FORCED_IDS: std::cell::RefCell<Vec<ItemId>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn random_item_id() -> ItemId {
    #[cfg(test)]
    if let Some(id) = FORCED_IDS.with(|ids| ids.borrow_mut().pop()) {
        return id;
    }
    ItemId::random()
}

/// The ID in an item file name: exactly 32 lowercase hex characters plus `.item`.
pub(super) fn item_id_from_file_name(name: &str) -> Option<ItemId> {
    name.strip_suffix(ITEM_EXT)
        .and_then(|hex| ItemId::from_hex(hex).ok())
}

/// Opens every item file in `dir/items`. Files that do not open are listed as damaged
/// (sorted) and left alone; names that are not item file names, and folders, are ignored.
/// A missing `items` folder is an empty vault, and the next write recreates it.
pub(super) fn load_all(
    dir: &Path,
    vault_id: &VaultId,
    key: &Key32,
) -> Result<(BTreeMap<ItemId, Item>, Vec<ItemId>)> {
    let (mut items, mut damaged) = (BTreeMap::new(), Vec::new());
    let entries = match fs::read_dir(dir.join(ITEMS_DIR)) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((items, damaged)),
        Err(e) => return Err(e.into()),
    };
    for entry in entries {
        let entry = entry?;
        let Some(id) = entry.file_name().to_str().and_then(item_id_from_file_name) else {
            continue;
        };
        if !entry.file_type()?.is_file() {
            continue;
        }
        let opened = read_retry(&entry.path(), MAX_ITEM_FILE)
            .and_then(|bytes| open_item(&bytes, &id, vault_id, key));
        match opened {
            Ok(item) => {
                items.insert(id, item);
            }
            Err(_) => damaged.push(id),
        }
    }
    damaged.sort();
    Ok((items, damaged))
}

fn write_item_file(path: &Path, bytes: &[u8]) -> Result<()> {
    atomic_write(path, bytes)?;
    #[cfg(test)]
    crate::fsio::failpoint::check("items.after_write")?;
    Ok(())
}

/// A new item with nothing attached, at revision 0 ("never edited").
pub(super) fn blank_item(
    id: ItemId,
    kind: ItemKind,
    title: &str,
    collection: Option<ItemId>,
) -> Item {
    let now = created_at_now();
    Item {
        id,
        kind,
        title: title.to_owned(),
        notes: Zeroizing::new(String::new()),
        collection,
        attachments: Vec::new(),
        revision: 0,
        created_at: now.clone(),
        modified_at: now,
        trashed_at: None,
        purging: false,
        retired_blobs: Vec::new(),
    }
}

/// A copy of `stored` counted as one more edit: next revision, modified now.
pub(super) fn edited(stored: &Item) -> Result<Item> {
    let mut next = stored.clone();
    next.revision = next.revision.checked_add(1).ok_or(REVISION_OVERFLOW)?;
    next.modified_at = created_at_now();
    Ok(next)
}

/// Where the item file for `id` lives in the vault folder `dir`.
pub(super) fn item_file_in(dir: &Path, id: &ItemId) -> PathBuf {
    dir.join(ITEMS_DIR)
        .join(format!("{}{ITEM_EXT}", id.to_hex()))
}

impl Vault {
    pub(super) fn item_path(&self, id: &ItemId) -> PathBuf {
        item_file_in(&self.dir, id)
    }

    /// An ID no loaded, damaged or existing file uses. Random IDs never collide in practice;
    /// this is the guard that a broken random source must not turn into an overwritten file.
    /// After [`ID_ATTEMPTS`] taken IDs in a row the source is treated as broken and this fails.
    pub(super) fn fresh_item_id(&self) -> Result<ItemId> {
        for _ in 0..ID_ATTEMPTS {
            let id = random_item_id();
            let taken = self.items.contains_key(&id)
                || self.damaged.contains(&id)
                || self.item_path(&id).try_exists()?;
            if !taken {
                return Ok(id);
            }
        }
        Err(std::io::Error::other("no free item id").into())
    }

    /// Seals `item` into its file, then (only once that worked) replaces the in-memory copy.
    /// If the write reports an error after the new file may already be in place (for example
    /// the folder sync failed), memory takes whatever the file now holds, so the two agree.
    /// The original error is returned either way.
    pub(super) fn commit_item(&mut self, item: Item) -> Result<()> {
        fs::create_dir_all(self.dir.join(ITEMS_DIR))?;
        let bytes = seal_item(&item, &self.header.vault_id, &self.vault_key)?;
        let path = self.item_path(&item.id);
        if let Err(error) = write_item_file(&path, &bytes) {
            let on_disk = read_retry(&path, MAX_ITEM_FILE).and_then(|bytes| {
                open_item(&bytes, &item.id, &self.header.vault_id, &self.vault_key)
            });
            if let Ok(on_disk) = on_disk {
                self.items.insert(on_disk.id, on_disk);
                self.reindex();
            }
            return Err(error);
        }
        self.items.insert(item.id, item);
        self.reindex();
        Ok(())
    }

    /// Puts an item in or out of the trash. A real change counts as an edit (revision and
    /// `modified_at`); an item already in that state is left alone and nothing is written.
    fn set_trashed(&mut self, id: &ItemId, at: Option<String>) -> Result<()> {
        let stored = self.get_item(id)?;
        if stored.trashed_at.is_some() == at.is_some() {
            return Ok(());
        }
        let mut next = edited(stored)?;
        next.trashed_at = at;
        self.commit_item(next)
    }

    /// Whether the item `id`, as it will be (`kind`, in `new`; it was in `old`), may sit
    /// there: a collection never sits in one, nothing sits in itself, and a collection newly
    /// named must exist and not be in the trash.
    pub(super) fn check_collection(
        &self,
        id: &ItemId,
        kind: &ItemKind,
        new: Option<ItemId>,
        old: Option<ItemId>,
    ) -> Result<()> {
        let Some(target) = new else { return Ok(()) };
        if target == *id {
            return Err(CoreError::InvalidInput { what: "collection" });
        }
        if matches!(kind, ItemKind::Collection) {
            return Err(CoreError::InvalidInput {
                what: "collection inside a collection",
            });
        }
        let usable = |c: &Item| matches!(c.kind, ItemKind::Collection) && c.trashed_at.is_none();
        if new != old && !self.items.get(&target).is_some_and(usable) {
            return Err(CoreError::InvalidInput { what: "collection" });
        }
        Ok(())
    }

    /// Adds an empty item of `kind` with `title`, in `collection` if given. Revision 0 means
    /// "never edited"; each `update_item` adds one.
    pub fn new_item(
        &mut self,
        kind: ItemKind,
        title: &str,
        collection: Option<ItemId>,
    ) -> Result<ItemId> {
        let id = self.fresh_item_id()?;
        self.check_collection(&id, &kind, collection, None)?;
        self.commit_item(blank_item(id, kind, title, collection))?;
        Ok(id)
    }

    /// Saves the user-editable fields of `item` (`kind`, `title`, `notes`, `collection`) over
    /// the stored item with the same ID. Everything else is kept from the stored copy. The
    /// revision must be the stored one, else `InvalidInput { "stale revision" }`.
    pub fn update_item(&mut self, item: Item) -> Result<()> {
        let stored = self.get_item(&item.id)?;
        if stored.purging {
            return Err(BEING_DELETED);
        }
        if item.revision != stored.revision {
            return Err(CoreError::InvalidInput {
                what: "stale revision",
            });
        }
        self.check_collection(&item.id, &item.kind, item.collection, stored.collection)?;
        let was_collection = matches!(stored.kind, ItemKind::Collection);
        let has_members = || self.items.values().any(|m| m.collection == Some(item.id));
        if was_collection && !matches!(item.kind, ItemKind::Collection) && has_members() {
            return Err(CoreError::InvalidInput {
                what: "collection has items",
            });
        }
        let mut next = edited(stored)?;
        next.kind = item.kind;
        next.title = item.title;
        next.notes = item.notes;
        next.collection = item.collection;
        self.commit_item(next)
    }

    pub fn get_item(&self, id: &ItemId) -> Result<&Item> {
        self.items.get(id).ok_or(CoreError::NotFound)
    }

    /// Every item, trashed ones included (the UI filters).
    pub fn items(&self) -> impl Iterator<Item = &Item> {
        self.items.values()
    }

    /// Item files that failed to open at unlock.
    pub fn damaged_items(&self) -> &[ItemId] {
        &self.damaged
    }

    /// Moves an item to the trash. A collection goes through `delete_collection` instead.
    pub fn trash_item(&mut self, id: &ItemId) -> Result<()> {
        if self.get_item(id)?.purging {
            return Err(BEING_DELETED);
        }
        if matches!(self.get_item(id)?.kind, ItemKind::Collection) {
            return Err(CoreError::InvalidInput {
                what: "use delete_collection",
            });
        }
        self.set_trashed(id, Some(created_at_now()))
    }

    /// Takes an item out of the trash, and its collection too if that is in the trash
    /// (collection first, so a crash in between leaves a valid state). The link to the
    /// collection is kept even if that collection is missing or damaged; the UI treats it as "no collection".
    pub fn restore_item(&mut self, id: &ItemId) -> Result<()> {
        let item = self.get_item(id)?;
        if item.purging {
            return Err(BEING_DELETED);
        }
        if item.trashed_at.is_none() {
            return Ok(());
        }
        // A collection that is gone altogether is not this call's problem.
        let collection = item.collection.filter(|c| self.items.contains_key(c));
        // Checked before anything changes, so there is no half-restore: a collection that is
        // being purged is never brought back as a side effect of restoring one of its items.
        if collection.is_some_and(|c| self.items[&c].purging) {
            return Err(BEING_DELETED);
        }
        if let Some(collection) = collection {
            self.set_trashed(&collection, None)?;
        }
        self.set_trashed(id, None)
    }

    /// Trashes a collection and its items; returns how many items were newly trashed.
    /// Items go first and the collection last, so a crash leaves a state that a retry finishes.
    pub fn delete_collection(&mut self, id: &ItemId) -> Result<usize> {
        if !matches!(self.get_item(id)?.kind, ItemKind::Collection) {
            return Err(CoreError::InvalidInput {
                what: "not a collection",
            });
        }
        let now = created_at_now();
        let members: Vec<ItemId> = self
            .items
            .values()
            .filter(|m| m.collection == Some(*id) && m.trashed_at.is_none())
            .map(|m| m.id)
            .collect();
        for member in &members {
            self.set_trashed(member, Some(now.clone()))?;
        }
        self.set_trashed(id, Some(now))?;
        Ok(members.len())
    }

    /// Items that have been in the trash for more than `days` days. Lists only.
    pub fn trash_older_than(&self, days: u32) -> Vec<ItemId> {
        // String order is time order: Lockbox writes every timestamp in this one fixed UTC format.
        let cutoff = rfc3339_utc(now_secs().saturating_sub(u64::from(days) * SECS_PER_DAY));
        self.items
            .values()
            .filter(|i| i.trashed_at.as_deref().is_some_and(|t| t < cutoff.as_str()))
            .map(|i| i.id)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsio::{failpoint, testutil::TempDir};

    const PW: &str = "correct horse battery";

    fn new_vault() -> (TempDir, Vault) {
        let parent = TempDir::new();
        let vault = Vault::create(parent.path(), "Family", PW).unwrap().vault;
        (parent, vault)
    }

    fn reopen(vault: Vault) -> Vault {
        let dir = vault.dir().to_path_buf();
        drop(vault);
        Vault::unlock_with_password(&dir, PW).unwrap().0
    }

    fn item_path(vault: &Vault, id: &ItemId) -> std::path::PathBuf {
        vault
            .dir()
            .join("items")
            .join(format!("{}.item", id.to_hex()))
    }

    fn login(password: &str) -> ItemKind {
        ItemKind::Login {
            username: "ariel".into(),
            password: Zeroizing::new(password.into()),
            urls: vec!["https://example.com".into()],
        }
    }

    fn invalid(r: Result<impl std::fmt::Debug>, what: &str) {
        match r {
            Err(CoreError::InvalidInput { what: w }) => assert_eq!(w, what),
            other => panic!("expected InvalidInput({what}), got {other:?}"),
        }
    }

    #[test]
    fn create_update_persist_across_unlock() {
        let (_parent, mut vault) = new_vault();
        let id = vault.new_item(login("hunter2"), "Mail", None).unwrap();
        let fresh = vault.get_item(&id).unwrap();
        assert_eq!(fresh.revision, 0);
        assert_eq!(fresh.created_at, fresh.modified_at);
        assert!(fresh.notes.is_empty() && fresh.trashed_at.is_none() && !fresh.purging);

        let mut edit = fresh.clone();
        edit.title = "Mail (work)".into();
        edit.notes = Zeroizing::new("backup code in the safe".into());
        edit.kind = login("hunter3");
        vault.update_item(edit).unwrap();
        assert_eq!(vault.get_item(&id).unwrap().revision, 1);

        let vault = reopen(vault);
        assert!(vault.damaged_items().is_empty());
        let item = vault.get_item(&id).unwrap();
        assert_eq!((item.title.as_str(), item.revision), ("Mail (work)", 1));
        assert_eq!(&**item.notes, "backup code in the safe");
        match &item.kind {
            ItemKind::Login { password, .. } => assert_eq!(&***password, "hunter3"),
            other => panic!("wrong kind {other:?}"),
        }
        assert_eq!(vault.items().count(), 1);
    }

    #[test]
    fn stale_revision_rejected() {
        let (_parent, mut vault) = new_vault();
        let id = vault.new_item(ItemKind::Note, "Plans", None).unwrap();
        let first = vault.get_item(&id).unwrap().clone();
        let mut second = first.clone();
        second.title = "Plans v2".into();
        vault.update_item(second).unwrap();

        let mut late = first;
        late.title = "Lost update".into();
        invalid(vault.update_item(late), "stale revision");
        assert_eq!(vault.get_item(&id).unwrap().title, "Plans v2");

        let mut ghost = vault.get_item(&id).unwrap().clone();
        ghost.id = ItemId::random();
        assert!(matches!(vault.update_item(ghost), Err(CoreError::NotFound)));
        assert!(matches!(
            vault.get_item(&ItemId::random()),
            Err(CoreError::NotFound)
        ));
    }

    #[test]
    fn update_keeps_everything_the_caller_may_not_set() {
        let (_parent, mut vault) = new_vault();
        let id = vault.new_item(ItemKind::Note, "Plans", None).unwrap();
        vault.trash_item(&id).unwrap();
        let stored = vault.get_item(&id).unwrap().clone();

        let mut forged = stored.clone();
        forged.trashed_at = None;
        forged.created_at = "1999-01-01T00:00:00Z".into();
        forged.purging = true;
        forged.retired_blobs = vec![crate::ids::FileId([9; 16])];
        forged.modified_at = "1999-01-01T00:00:00Z".into();
        forged.title = "Renamed".into();
        vault.update_item(forged).unwrap();

        let now = vault.get_item(&id).unwrap();
        assert_eq!(now.title, "Renamed");
        assert_eq!(now.trashed_at, stored.trashed_at);
        assert_eq!(now.created_at, stored.created_at);
        assert!(!now.purging && now.retired_blobs.is_empty());
        assert_ne!(now.modified_at, "1999-01-01T00:00:00Z");
        assert_eq!(now.revision, stored.revision + 1);
    }

    #[test]
    fn a_failed_write_leaves_memory_and_disk_as_they_were() {
        let (_parent, mut vault) = new_vault();
        let id = vault.new_item(ItemKind::Note, "Plans", None).unwrap();
        let before = fs::read(item_path(&vault, &id)).unwrap();
        let mut edit = vault.get_item(&id).unwrap().clone();
        edit.title = "Changed".into();

        failpoint::arm("atomic_write.before_replace");
        let update = vault.update_item(edit);
        let trash = vault.trash_item(&id);
        let create = vault.new_item(ItemKind::Note, "New", None);
        failpoint::disarm_all();

        assert!(matches!(update, Err(CoreError::Io(_))));
        assert!(matches!(trash, Err(CoreError::Io(_))));
        assert!(matches!(create, Err(CoreError::Io(_))));
        let item = vault.get_item(&id).unwrap();
        assert_eq!((item.title.as_str(), item.revision), ("Plans", 0));
        assert!(item.trashed_at.is_none());
        assert_eq!(vault.items().count(), 1);
        assert_eq!(fs::read(item_path(&vault, &id)).unwrap(), before);
    }

    #[test]
    fn trash_and_restore() {
        let (_parent, mut vault) = new_vault();
        let id = vault.new_item(ItemKind::Note, "Plans", None).unwrap();
        let revision = vault.get_item(&id).unwrap().revision;
        vault.trash_item(&id).unwrap();
        let trashed_at = vault.get_item(&id).unwrap().trashed_at.clone().unwrap();
        assert_eq!(trashed_at.len(), 20);
        vault.trash_item(&id).unwrap(); // already trashed: nothing changes
        assert_eq!(vault.get_item(&id).unwrap().trashed_at, Some(trashed_at));

        let mut vault = reopen(vault);
        assert!(vault.get_item(&id).unwrap().trashed_at.is_some());
        assert_eq!(vault.items().count(), 1, "trashed items are still listed");
        vault.restore_item(&id).unwrap();
        vault.restore_item(&id).unwrap(); // already active: fine
        let vault = reopen(vault);
        let item = vault.get_item(&id).unwrap();
        assert!(item.trashed_at.is_none());
        assert_eq!(
            item.revision,
            revision + 2,
            "one for trash, one for restore"
        );

        let mut vault = vault;
        let ghost = ItemId::random();
        assert!(matches!(vault.trash_item(&ghost), Err(CoreError::NotFound)));
        assert!(matches!(
            vault.restore_item(&ghost),
            Err(CoreError::NotFound)
        ));
    }

    /// A vault with collection "Work" holding two notes and one note outside.
    fn with_collection(vault: &mut Vault) -> (ItemId, ItemId, ItemId, ItemId) {
        let work = vault.new_item(ItemKind::Collection, "Work", None).unwrap();
        let a = vault.new_item(ItemKind::Note, "A", Some(work)).unwrap();
        let b = vault.new_item(login("pw"), "B", Some(work)).unwrap();
        let loose = vault.new_item(ItemKind::Note, "Loose", None).unwrap();
        (work, a, b, loose)
    }

    fn is_trashed(vault: &Vault, id: &ItemId) -> bool {
        vault.get_item(id).unwrap().trashed_at.is_some()
    }

    #[test]
    fn delete_collection_trashes_members() {
        let (_parent, mut vault) = new_vault();
        let (work, a, b, loose) = with_collection(&mut vault);
        // A member trashed earlier keeps its own date and is not counted again.
        vault.trash_item(&a).unwrap();
        let a_date = vault.get_item(&a).unwrap().trashed_at.clone();

        assert_eq!(vault.delete_collection(&work).unwrap(), 1);
        for id in [&work, &a, &b] {
            assert!(is_trashed(&vault, id));
        }
        assert!(!is_trashed(&vault, &loose));
        assert_eq!(vault.get_item(&a).unwrap().trashed_at, a_date);
        assert_eq!(vault.get_item(&b).unwrap().collection, Some(work));

        let vault = reopen(vault);
        assert!(is_trashed(&vault, &work) && is_trashed(&vault, &b));
        assert!(!is_trashed(&vault, &loose));
    }

    #[test]
    fn collections_cannot_be_trashed_directly_or_deleted_as_something_else() {
        let (_parent, mut vault) = new_vault();
        let (work, a, ..) = with_collection(&mut vault);
        invalid(vault.trash_item(&work), "use delete_collection");
        assert!(!is_trashed(&vault, &work));
        invalid(vault.delete_collection(&a), "not a collection");
        assert!(matches!(
            vault.delete_collection(&ItemId::random()),
            Err(CoreError::NotFound)
        ));
        assert_eq!(vault.delete_collection(&work).unwrap(), 2);
    }

    #[test]
    fn restoring_a_member_restores_its_collection_but_not_the_reverse() {
        let (_parent, mut vault) = new_vault();
        let (work, a, b, _) = with_collection(&mut vault);
        vault.delete_collection(&work).unwrap();

        vault.restore_item(&work).unwrap();
        assert!(!is_trashed(&vault, &work));
        assert!(
            is_trashed(&vault, &a) && is_trashed(&vault, &b),
            "only itself"
        );

        vault.delete_collection(&work).unwrap();
        vault.restore_item(&a).unwrap();
        assert!(!is_trashed(&vault, &a) && !is_trashed(&vault, &work));
        assert!(is_trashed(&vault, &b));
        let vault = reopen(vault);
        assert!(!is_trashed(&vault, &work) && is_trashed(&vault, &b));
    }

    #[test]
    fn collections_are_flat_and_must_exist() {
        let (_parent, mut vault) = new_vault();
        let (work, a, _, _) = with_collection(&mut vault);
        let count = vault.items().count();

        invalid(
            vault.new_item(ItemKind::Note, "x", Some(ItemId::random())),
            "collection",
        );
        invalid(vault.new_item(ItemKind::Note, "x", Some(a)), "collection");
        invalid(
            vault.new_item(ItemKind::Collection, "x", Some(work)),
            "collection inside a collection",
        );
        let trashed = vault.new_item(ItemKind::Collection, "Old", None).unwrap();
        vault.delete_collection(&trashed).unwrap();
        invalid(
            vault.new_item(ItemKind::Note, "x", Some(trashed)),
            "collection",
        );
        assert_eq!(vault.items().count(), count + 1, "nothing was added");

        // The same rules for update_item.
        let mut edit = vault.get_item(&a).unwrap().clone();
        edit.collection = Some(a);
        invalid(vault.update_item(edit), "collection");
        let mut edit = vault.get_item(&a).unwrap().clone();
        edit.kind = ItemKind::Collection; // still inside "Work"
        invalid(vault.update_item(edit), "collection inside a collection");
        let mut edit = vault.get_item(&work).unwrap().clone();
        edit.kind = ItemKind::Note; // would orphan its members
        invalid(vault.update_item(edit), "collection has items");

        // Moving out of and between collections works.
        let other = vault.new_item(ItemKind::Collection, "Home", None).unwrap();
        let mut edit = vault.get_item(&a).unwrap().clone();
        edit.collection = Some(other);
        vault.update_item(edit).unwrap();
        let mut edit = vault.get_item(&a).unwrap().clone();
        edit.collection = None;
        vault.update_item(edit).unwrap();
        assert_eq!(vault.get_item(&a).unwrap().collection, None);
    }

    #[test]
    fn damaged_item_isolated() {
        let (_parent, mut vault) = new_vault();
        let ids: Vec<ItemId> = (0..3)
            .map(|n| {
                vault
                    .new_item(ItemKind::Note, &format!("n{n}"), None)
                    .unwrap()
            })
            .collect();
        let bad = item_path(&vault, &ids[1]);
        let mut bytes = fs::read(&bad).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        fs::write(&bad, &bytes).unwrap();
        // An item file that is valid but sits under another item's name is damaged too.
        let swapped = vault.new_item(ItemKind::Note, "n3", None).unwrap();
        let swapped_path = item_path(&vault, &swapped);
        fs::copy(item_path(&vault, &ids[0]), &swapped_path).unwrap();

        let mut vault = reopen(vault);
        assert_eq!(vault.items().count(), 2);
        assert!(vault.get_item(&ids[0]).is_ok() && vault.get_item(&ids[2]).is_ok());
        let mut expected = vec![ids[1], swapped];
        expected.sort();
        assert_eq!(vault.damaged_items(), expected);
        // Damaged files are never touched, and the rest of the vault keeps working.
        assert_eq!(fs::read(&bad).unwrap(), bytes);
        vault.new_item(ItemKind::Note, "later", None).unwrap();
        assert_eq!(fs::read(&bad).unwrap(), bytes);
    }

    #[test]
    fn only_canonical_names_are_item_files() {
        let hex = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            item_id_from_file_name(&format!("{hex}.item")),
            Some(ItemId::from_hex(hex).unwrap())
        );
        // Uppercase is not the canonical form (and a Windows disk would not tell the two apart).
        for bad in [
            format!("{}.item", hex.to_uppercase()),
            format!("{}.ITEM", hex),
            format!("{}.item", &hex[1..]),
            format!("{hex}.item.bak"),
            ".item".to_owned(),
        ] {
            assert_eq!(item_id_from_file_name(&bad), None, "{bad}");
        }
    }

    #[test]
    fn foreign_files_in_items_dir_ignored() {
        let (_parent, mut vault) = new_vault();
        let id = vault.new_item(ItemKind::Note, "Plans", None).unwrap();
        let real = item_path(&vault, &id);
        let items = real.parent().unwrap().to_path_buf();
        let hex = id.to_hex();
        let junk = [
            format!("{}.item", &hex[1..]),
            format!("{hex}0.item"),
            format!("{hex}.item.bak"),
            format!(".{hex}.item"),
            "notes.txt".to_owned(),
            "desktop.ini".to_owned(),
        ];
        // (`*.tmp` and `*.partial` names are not junk but scraps: cleanup at unlock removes them.)
        for name in &junk {
            fs::write(items.join(name), b"not an item").unwrap();
        }
        // A folder with an item's name is not an item file either.
        fs::create_dir(items.join(format!("{}.item", "a".repeat(32)))).unwrap();
        let vault = reopen(vault);
        assert_eq!(vault.items().count(), 1);
        for name in &junk {
            assert_eq!(fs::read(items.join(name)).unwrap(), b"not an item");
        }
        assert!(vault.get_item(&id).is_ok());
        assert!(vault.damaged_items().is_empty());
    }

    #[test]
    fn trash_older_than_lists_but_keeps() {
        let (_parent, mut vault) = new_vault();
        let old = vault.new_item(ItemKind::Note, "old", None).unwrap();
        let recent = vault.new_item(ItemKind::Note, "recent", None).unwrap();
        let live = vault.new_item(ItemKind::Note, "live", None).unwrap();
        vault.trash_item(&old).unwrap();
        vault.trash_item(&recent).unwrap();
        let ago = |days: u64| Some(rfc3339_utc(now_secs() - days * SECS_PER_DAY));
        vault.items.get_mut(&old).unwrap().trashed_at = ago(31);
        vault.items.get_mut(&recent).unwrap().trashed_at = ago(29);

        assert_eq!(vault.trash_older_than(30), [old]);
        assert_eq!(vault.trash_older_than(28).len(), 2);
        assert!(vault.trash_older_than(32).is_empty());
        assert_eq!(vault.items().count(), 3, "listing never removes");
        assert!(vault.get_item(&live).unwrap().trashed_at.is_none());
        assert!(vault.get_item(&old).is_ok());
    }

    #[test]
    fn a_missing_items_folder_loads_empty_and_is_recreated() {
        let (_parent, vault) = new_vault();
        let items = vault.dir().join("items");
        fs::remove_dir(&items).unwrap();
        let mut vault = reopen(vault);
        assert_eq!(vault.items().count(), 0);
        let id = vault.new_item(ItemKind::Note, "first", None).unwrap();
        assert!(item_path(&vault, &id).exists());
    }

    /// Sets `modified_at` far in the past so a later change to it is visible.
    fn age(vault: &mut Vault, id: &ItemId) {
        vault.items.get_mut(id).unwrap().modified_at = "2000-01-01T00:00:00Z".into();
    }

    #[test]
    fn trash_and_restore_are_real_changes_but_repeats_are_not() {
        let (_parent, mut vault) = new_vault();
        let id = vault.new_item(ItemKind::Note, "Plans", None).unwrap();
        let before = vault.get_item(&id).unwrap().clone();
        age(&mut vault, &id);

        vault.trash_item(&id).unwrap();
        let trashed = vault.get_item(&id).unwrap().clone();
        assert_eq!(trashed.revision, before.revision + 1);
        assert_ne!(trashed.modified_at, "2000-01-01T00:00:00Z");
        // A copy taken before the trash is now stale.
        invalid(vault.update_item(before), "stale revision");

        let file = fs::read(item_path(&vault, &id)).unwrap();
        vault.trash_item(&id).unwrap(); // already trashed
        assert_eq!(vault.get_item(&id).unwrap().revision, trashed.revision);
        assert_eq!(fs::read(item_path(&vault, &id)).unwrap(), file, "no write");

        age(&mut vault, &id);
        vault.restore_item(&id).unwrap();
        let restored = vault.get_item(&id).unwrap().clone();
        assert_eq!(restored.revision, trashed.revision + 1);
        assert_ne!(restored.modified_at, "2000-01-01T00:00:00Z");
        vault.restore_item(&id).unwrap(); // already active
        assert_eq!(vault.get_item(&id).unwrap().revision, restored.revision);

        // Counting past the last revision is refused and changes nothing.
        vault.items.get_mut(&id).unwrap().revision = u64::MAX;
        invalid(vault.trash_item(&id), "revision overflow");
        assert!(!is_trashed(&vault, &id));
    }

    #[test]
    fn delete_collection_counts_each_real_change_as_an_edit() {
        let (_parent, mut vault) = new_vault();
        let (work, a, b, loose) = with_collection(&mut vault);
        vault.trash_item(&a).unwrap(); // a: revision 1
        vault.delete_collection(&work).unwrap();
        let revision = |id| vault.get_item(&id).unwrap().revision;
        assert_eq!(revision(a), 1, "already trashed: untouched");
        assert_eq!((revision(b), revision(work), revision(loose)), (1, 1, 0));

        // Restoring a member restores the collection too: both are real changes.
        vault.restore_item(&b).unwrap();
        let revision = |id| vault.get_item(&id).unwrap().revision;
        assert_eq!((revision(b), revision(work)), (2, 2));
        vault.restore_item(&a).unwrap(); // collection already active: only a changes
        let revision = |id| vault.get_item(&id).unwrap().revision;
        assert_eq!((revision(a), revision(work)), (2, 2));
    }

    #[test]
    fn a_note_cannot_be_filed_in_itself() {
        let (_parent, mut vault) = new_vault();
        let c = vault.new_item(ItemKind::Collection, "C", None).unwrap();
        let mut edit = vault.get_item(&c).unwrap().clone();
        edit.kind = ItemKind::Note;
        edit.collection = Some(c);
        invalid(vault.update_item(edit), "collection");
        let item = vault.get_item(&c).unwrap();
        assert!(matches!(item.kind, ItemKind::Collection) && item.collection.is_none());
        assert_eq!(item.revision, 0);
        // A plain note cannot name itself either.
        let n = vault.new_item(ItemKind::Note, "N", None).unwrap();
        let mut edit = vault.get_item(&n).unwrap().clone();
        edit.collection = Some(n);
        invalid(vault.update_item(edit), "collection");
    }

    fn force_next_id(id: ItemId) {
        FORCED_IDS.with(|ids| ids.borrow_mut().push(id));
    }

    #[test]
    fn a_colliding_id_never_overwrites_a_healthy_or_damaged_file() {
        let (_parent, mut vault) = new_vault();
        let healthy = vault.new_item(ItemKind::Note, "healthy", None).unwrap();
        let sick = vault.new_item(ItemKind::Note, "sick", None).unwrap();
        let (healthy_path, sick_path) = (item_path(&vault, &healthy), item_path(&vault, &sick));
        let mut broken = fs::read(&sick_path).unwrap();
        broken[40] ^= 1;
        fs::write(&sick_path, &broken).unwrap();
        let mut vault = reopen(vault);
        assert_eq!(vault.damaged_items(), [sick]);
        let healthy_bytes = fs::read(&healthy_path).unwrap();

        // A folder with an item file's name is not loaded either, but its path is taken.
        let squatter = ItemId([0xEE; 16]);
        fs::create_dir(item_path(&vault, &squatter)).unwrap();
        // Last pushed is tried first.
        for id in [squatter, sick, healthy] {
            force_next_id(id);
        }
        let first = vault.new_item(ItemKind::Note, "first", None).unwrap();
        assert!(![healthy, sick, squatter].contains(&first));
        assert_eq!(vault.get_item(&first).unwrap().title, "first");
        FORCED_IDS.with(|ids| assert!(ids.borrow().is_empty(), "all forced IDs were tried"));

        assert_eq!(fs::read(&healthy_path).unwrap(), healthy_bytes);
        assert_eq!(fs::read(&sick_path).unwrap(), broken);
        assert!(item_path(&vault, &squatter).is_dir());
        assert_eq!(vault.get_item(&healthy).unwrap().title, "healthy");
        assert_eq!(vault.damaged_items(), [sick]);
    }

    #[test]
    fn a_broken_random_source_gives_up_after_eight_taken_ids() {
        let (_parent, mut vault) = new_vault();
        let taken: Vec<ItemId> = (0..8)
            .map(|i| {
                vault
                    .new_item(ItemKind::Note, &format!("n{i}"), None)
                    .unwrap()
            })
            .collect();
        // Seven taken IDs, then a free one: found on the eighth try. The last ID queued is
        // tried first, so the free one goes in first.
        let free = ItemId([0xAB; 16]);
        force_next_id(free);
        for id in taken[..7].iter().rev() {
            force_next_id(*id);
        }
        assert_eq!(vault.fresh_item_id().unwrap(), free);
        FORCED_IDS.with(|ids| assert!(ids.borrow().is_empty(), "all eight were tried"));

        // Eight taken IDs in a row: a fixed-text error, not an endless loop.
        for id in &taken {
            force_next_id(*id);
        }
        assert!(matches!(vault.fresh_item_id(), Err(CoreError::Io(_))));
        FORCED_IDS.with(|ids| assert!(ids.borrow().is_empty(), "all eight were tried"));
    }

    #[test]
    fn an_error_after_the_file_landed_leaves_memory_matching_disk() {
        let (_parent, mut vault) = new_vault();
        let id = vault.new_item(ItemKind::Note, "Plans", None).unwrap();
        let mut edit = vault.get_item(&id).unwrap().clone();
        edit.title = "Changed".into();

        failpoint::arm("items.after_write");
        let result = vault.update_item(edit);
        failpoint::disarm_all();

        // The caller sees the error, but memory has the version the file now holds.
        assert!(matches!(result, Err(CoreError::Io(_))));
        let item = vault.get_item(&id).unwrap();
        assert_eq!((item.title.as_str(), item.revision), ("Changed", 1));
        // Search follows memory, not the error.
        assert!(vault.search("plans", 10).is_empty());
        assert_eq!(vault.search("changed", 10), [id]);
        // Work continues from that state, and a reload agrees.
        let mut next = item.clone();
        next.title = "Changed again".into();
        vault.update_item(next).unwrap();
        let vault = reopen(vault);
        let item = vault.get_item(&id).unwrap();
        assert_eq!((item.title.as_str(), item.revision), ("Changed again", 2));
    }
}
