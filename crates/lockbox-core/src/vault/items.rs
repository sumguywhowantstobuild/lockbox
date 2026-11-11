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
use crate::item::{
    Item, ItemKind, MAX_ITEM_FILE, MAX_PREVIOUS_PASSWORDS, PreviousPassword, check_key_name,
    open_item, seal_item,
};
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
    #[cfg(any(test, feature = "test-internals"))]
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
        trashed_with: None,
        purging: false,
        retired_blobs: Vec::new(),
    }
}

/// The rule for a title that depends on the kind: a key's title is its name, so it is a variable name. Every other kind
/// keeps any title. Called wherever a title is set (`new_item_with_notes`, `update_item`), before anything is written.
fn check_title(kind: &ItemKind, title: &str) -> Result<()> {
    match kind {
        ItemKind::Key { .. } => check_key_name(title),
        _ => Ok(()),
    }
}

/// The earlier passwords of a login about to be saved (`new`, as the caller sent it) over `stored`: always the stored
/// list, never the caller's, and with the stored password put at its front, stamped `at`, when the new one really
/// differs and the stored one is not empty. At most [`MAX_PREVIOUS_PASSWORDS`] stay; the oldest goes. A new kind that is
/// not a login, or a stored one that is not, leaves nothing to carry.
fn keep_earlier_passwords(stored: &ItemKind, new: &mut ItemKind, at: &str) {
    let ItemKind::Login {
        password,
        previous_passwords,
        ..
    } = new
    else {
        return;
    };
    *previous_passwords = Vec::new();
    let ItemKind::Login {
        password: was,
        previous_passwords: earlier,
        ..
    } = stored
    else {
        return;
    };
    previous_passwords.extend(earlier.iter().cloned());
    if **password != **was && !was.is_empty() {
        previous_passwords.insert(
            0,
            PreviousPassword {
                password: was.clone(),
                replaced_at: at.to_owned(),
            },
        );
        previous_passwords.truncate(MAX_PREVIOUS_PASSWORDS);
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

    /// Puts an item in or out of the trash, in one write. A real change counts as an edit (revision and `modified_at`); an
    /// item already in that state is left alone and nothing is written. Going in, `with` is the folder whose delete sends
    /// it (`trashed_with`), written in the same step as `trashed_at`; coming out always clears it.
    fn set_trashed(&mut self, id: &ItemId, at: Option<String>, with: Option<ItemId>) -> Result<()> {
        let stored = self.get_item(id)?;
        if stored.trashed_at.is_some() == at.is_some() {
            return Ok(());
        }
        let mut next = edited(stored)?;
        next.trashed_with = if at.is_some() { with } else { None };
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
        self.new_item_with_notes(kind, title, collection, Zeroizing::new(String::new()))
    }

    /// Like [`new_item`](Self::new_item), for an item that starts with its `notes`: the item (its `kind` already
    /// holding a login's fields) is sealed and written once, whole, so a lock or a crash between two calls can never
    /// leave an empty item behind.
    pub fn new_item_with_notes(
        &mut self,
        kind: ItemKind,
        title: &str,
        collection: Option<ItemId>,
        notes: Zeroizing<String>,
    ) -> Result<ItemId> {
        check_title(&kind, title)?;
        let id = self.fresh_item_id()?;
        self.check_collection(&id, &kind, collection, None)?;
        // A new login has no earlier passwords, whatever list it came with: only `update_item` writes one.
        let mut kind = kind;
        if let ItemKind::Login {
            previous_passwords, ..
        } = &mut kind
        {
            previous_passwords.clear();
        }
        let mut item = blank_item(id, kind, title, collection);
        item.notes = notes;
        self.commit_item(item)?;
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
        check_title(&item.kind, &item.title)?;
        let was_collection = matches!(stored.kind, ItemKind::Collection);
        let has_members = || self.items.values().any(|m| m.collection == Some(item.id));
        if was_collection && !matches!(item.kind, ItemKind::Collection) && has_members() {
            return Err(CoreError::InvalidInput {
                what: "collection has items",
            });
        }
        let mut next = edited(stored)?;
        let mut kind = item.kind;
        keep_earlier_passwords(&stored.kind, &mut kind, &next.modified_at);
        next.kind = kind;
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
        self.set_trashed(id, Some(created_at_now()), None)
    }

    /// Whether `member` is in the trash because of the delete of `folder`, and so comes back with it: trashed with that
    /// folder, still filed in it, and not being deleted for good. The page counts the same way (what the folder's
    /// restore will bring back).
    fn went_with(member: &Item, folder: &ItemId) -> bool {
        member.trashed_at.is_some()
            && !member.purging
            && member.trashed_with == Some(*folder)
            && member.collection == Some(*folder)
    }

    /// Takes an item out of the trash. A collection brings back the items that went to the trash with it, each in one
    /// write, **items first and the collection last**, so a crash leaves the collection in the trash and restoring it
    /// again finishes the job; items trashed on their own, or with another collection, stay where they are, and so does
    /// one being deleted for good (its purge is its own job: the rest still come back). A collection being deleted for
    /// good is refused whole, and nothing changes. Any other item comes back alone, with its collection too if that is in
    /// the trash (collection first, so a crash in between leaves a valid state), and not that collection's other items.
    /// Every restore clears the restored item's own `trashed_with`. The link to the collection is kept even if that
    /// collection is missing or damaged; the UI treats it as "no collection".
    pub fn restore_item(&mut self, id: &ItemId) -> Result<()> {
        let item = self.get_item(id)?;
        if item.purging {
            return Err(BEING_DELETED);
        }
        if item.trashed_at.is_none() {
            return Ok(());
        }
        if matches!(item.kind, ItemKind::Collection) {
            let members: Vec<ItemId> = self
                .items
                .values()
                .filter(|member| Self::went_with(member, id))
                .map(|member| member.id)
                .collect();
            for member in &members {
                self.set_trashed(member, None, None)?;
            }
            return self.set_trashed(id, None, None);
        }
        // A collection that is gone altogether is not this call's problem.
        let collection = item.collection.filter(|c| self.items.contains_key(c));
        // Checked before anything changes, so there is no half-restore: a collection that is
        // being purged is never brought back as a side effect of restoring one of its items.
        if collection.is_some_and(|c| self.items[&c].purging) {
            return Err(BEING_DELETED);
        }
        if let Some(collection) = collection {
            self.set_trashed(&collection, None, None)?;
        }
        self.set_trashed(id, None, None)
    }

    /// Trashes a collection and its items; returns how many items were newly trashed. Each of those records the
    /// collection in `trashed_with`, in the same write that trashes it; an item already in the trash is left exactly as it
    /// is. Items go first and the collection last, so a crash leaves a state that a retry finishes, writing the same value
    /// on the items still to go.
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
            self.set_trashed(member, Some(now.clone()), Some(*id))?;
        }
        self.set_trashed(id, Some(now), None)?;
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
            previous_passwords: Vec::new(),
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

    /// A new item can start with its notes and a login's fields, and is written once: no empty item exists between two
    /// writes, and a refused collection writes nothing.
    #[test]
    fn a_new_item_carries_its_notes_in_one_write() {
        let (_parent, mut vault) = new_vault();
        let writes = std::rc::Rc::new(std::cell::Cell::new(0));
        let seen = std::rc::Rc::clone(&writes);
        failpoint::observe(
            "items.after_write",
            Box::new(move || seen.set(seen.get() + 1)),
        );
        let notes = Zeroizing::new("backup code in the safe".to_string());
        let id = vault
            .new_item_with_notes(login("hunter2"), "Mail", None, notes)
            .unwrap();
        failpoint::disarm_all();
        assert_eq!(writes.get(), 1, "more than one write");

        let vault = reopen(vault);
        let item = vault.get_item(&id).unwrap();
        assert_eq!((item.title.as_str(), item.revision), ("Mail", 0));
        assert_eq!(&**item.notes, "backup code in the safe");
        match &item.kind {
            ItemKind::Login { password, .. } => assert_eq!(&***password, "hunter2"),
            other => panic!("wrong kind {other:?}"),
        }

        // The same collection rules as `new_item`, and nothing written when they refuse.
        let mut vault = vault;
        let count = vault.items().count();
        invalid(
            vault.new_item_with_notes(
                ItemKind::Note,
                "x",
                Some(ItemId::random()),
                Zeroizing::new("n".to_string()),
            ),
            "collection",
        );
        assert_eq!(vault.items().count(), count);
    }

    fn key(value: &str) -> ItemKind {
        ItemKind::Key {
            value: Zeroizing::new(value.into()),
        }
    }

    /// How many item files the vault holds on disk.
    fn files_on_disk(vault: &Vault) -> usize {
        match fs::read_dir(vault.dir().join("items")) {
            Ok(entries) => entries.count(),
            Err(_) => 0,
        }
    }

    /// A key is saved whole, in one write, with its name as its title, and is there after an unlock; it takes the
    /// folder rules of any item.
    #[test]
    fn a_key_survives_an_unlock() {
        let (_parent, mut vault) = new_vault();
        let folder = vault
            .new_item(ItemKind::Collection, "Agency", None)
            .unwrap();
        let writes = std::rc::Rc::new(std::cell::Cell::new(0));
        let seen = std::rc::Rc::clone(&writes);
        failpoint::observe(
            "items.after_write",
            Box::new(move || seen.set(seen.get() + 1)),
        );
        let id = vault
            .new_item_with_notes(
                key("demo-zzz-qqq-one"),
                "OPENAI_API_KEY",
                Some(folder),
                Zeroizing::new(String::new()),
            )
            .unwrap();
        failpoint::disarm_all();
        assert_eq!(writes.get(), 1, "more than one write");

        let vault = reopen(vault);
        assert!(vault.damaged_items().is_empty());
        let item = vault.get_item(&id).unwrap();
        assert_eq!((item.title.as_str(), item.revision), ("OPENAI_API_KEY", 0));
        assert_eq!(item.collection, Some(folder));
        match &item.kind {
            ItemKind::Key { value } => assert_eq!(&***value, "demo-zzz-qqq-one"),
            other => panic!("wrong kind {other:?}"),
        }
        // On disk the value is not in the clear.
        let bytes = fs::read(item_path(&vault, &id)).unwrap();
        assert!(!bytes.windows(8).any(|window| window == b"demo-zzz"));
    }

    /// The engine enforces a key's name wherever a key's title is set: creating one, renaming one, and turning another
    /// kind into a key. A refusal writes nothing and changes nothing; the other kinds keep any title.
    #[test]
    fn key_name_is_enforced_on_create_and_update() {
        let (_parent, mut vault) = new_vault();
        let note = vault
            .new_item(ItemKind::Note, "A note, with any title!", None)
            .unwrap();
        let before = files_on_disk(&vault);
        let key_name = "key name";
        for bad in ["", "1KEY", "A-B", "A B", "é", "A\n", " A"] {
            invalid(vault.new_item(key("v"), bad, None), key_name);
            invalid(
                vault.new_item_with_notes(key("v"), bad, None, Zeroizing::new("n".into())),
                key_name,
            );
        }
        assert_eq!(vault.items().count(), 1);
        assert_eq!(files_on_disk(&vault), before, "a refusal wrote a file");

        let id = vault.new_item(key("v"), "GOOD_NAME", None).unwrap();
        let stored = fs::read(item_path(&vault, &id)).unwrap();
        // A rename to a bad name is refused whole: the key, its revision and its file stay as they were.
        for bad in ["", "9NAME", "BAD NAME", "BAD-NAME"] {
            let mut edit = vault.get_item(&id).unwrap().clone();
            edit.title = bad.into();
            invalid(vault.update_item(edit), key_name);
        }
        let item = vault.get_item(&id).unwrap();
        assert_eq!((item.title.as_str(), item.revision), ("GOOD_NAME", 0));
        assert_eq!(fs::read(item_path(&vault, &id)).unwrap(), stored);
        let mut edit = vault.get_item(&id).unwrap().clone();
        edit.title = "BETTER_NAME".into();
        vault.update_item(edit).unwrap();
        assert_eq!(vault.get_item(&id).unwrap().title, "BETTER_NAME");

        // A note can become a key only under a good name, and a key can become a note under any title.
        let mut edit = vault.get_item(&note).unwrap().clone();
        edit.kind = key("v");
        invalid(vault.update_item(edit), key_name);
        assert!(matches!(
            vault.get_item(&note).unwrap().kind,
            ItemKind::Note
        ));
        let mut edit = vault.get_item(&note).unwrap().clone();
        edit.kind = key("v");
        edit.title = "FROM_A_NOTE".into();
        vault.update_item(edit).unwrap();
        let mut edit = vault.get_item(&note).unwrap().clone();
        edit.kind = ItemKind::Note;
        edit.title = "Back, with spaces".into();
        vault.update_item(edit).unwrap();

        // Nothing else that changes an item looks at the name: trash and restore keep a key as it is.
        vault.trash_item(&id).unwrap();
        vault.restore_item(&id).unwrap();
        assert_eq!(vault.get_item(&id).unwrap().title, "BETTER_NAME");
        // The refusal says nothing of the name.
        let said = format!("{:?}", vault.new_item(key("v"), "secret name", None));
        assert!(!said.contains("secret"), "{said}");
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
        forged.trashed_with = Some(ItemId([9; 16]));
        forged.created_at = "1999-01-01T00:00:00Z".into();
        forged.purging = true;
        forged.retired_blobs = vec![crate::ids::FileId([9; 16])];
        forged.modified_at = "1999-01-01T00:00:00Z".into();
        forged.title = "Renamed".into();
        vault.update_item(forged).unwrap();

        let now = vault.get_item(&id).unwrap();
        assert_eq!(now.title, "Renamed");
        assert_eq!(now.trashed_at, stored.trashed_at);
        assert_eq!(
            now.trashed_with, stored.trashed_with,
            "the page cannot set it"
        );
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
    fn restoring_a_member_restores_its_collection_alone() {
        let (_parent, mut vault) = new_vault();
        let (work, a, b, _) = with_collection(&mut vault);
        vault.delete_collection(&work).unwrap();

        // A folder brings back what went with it (Task 14).
        vault.restore_item(&work).unwrap();
        assert!(!is_trashed(&vault, &work));
        assert!(!is_trashed(&vault, &a) && !is_trashed(&vault, &b));

        // A member brings back its folder alone, not the other members.
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

    // Folders and the trash (Task 14): an item trashed with its folder records the folder in `trashed_with`, and restoring
    // the folder brings back the items that name it and no others.

    fn went_with(vault: &Vault, id: &ItemId) -> Option<ItemId> {
        vault.get_item(id).unwrap().trashed_with
    }

    /// Counts the item files written from now on, until `failpoint::disarm_all`.
    fn count_writes() -> std::rc::Rc<std::cell::Cell<usize>> {
        let writes = std::rc::Rc::new(std::cell::Cell::new(0));
        let seen = std::rc::Rc::clone(&writes);
        failpoint::observe(
            "items.after_write",
            Box::new(move || seen.set(seen.get() + 1)),
        );
        writes
    }

    /// Makes item write number `n` from now on (counting from 0), and every one after it, fail before it lands, as a
    /// crash does: what was written before stays, nothing after it is. Until `failpoint::disarm_all`.
    fn crash_at_write(n: usize) {
        let seen = std::cell::Cell::new(0);
        failpoint::observe(
            "atomic_write.before_replace",
            Box::new(move || {
                if seen.get() == n {
                    failpoint::arm("atomic_write.before_replace");
                }
                seen.set(seen.get() + 1);
            }),
        );
    }

    /// A folder with `n` notes in it.
    fn folder_with(vault: &mut Vault, n: usize) -> (ItemId, Vec<ItemId>) {
        let folder = vault.new_item(ItemKind::Collection, "Work", None).unwrap();
        let notes = (0..n)
            .map(|i| {
                vault
                    .new_item(ItemKind::Note, &format!("Note {i}"), Some(folder))
                    .unwrap()
            })
            .collect();
        (folder, notes)
    }

    #[test]
    fn folder_restore_brings_back_what_went_with_it() {
        let (_parent, mut vault) = new_vault();
        let (work, notes) = folder_with(&mut vault, 3);
        let loose = vault.new_item(ItemKind::Note, "Loose", None).unwrap();
        assert_eq!(vault.delete_collection(&work).unwrap(), 3);
        for note in &notes {
            assert_eq!(
                went_with(&vault, note),
                Some(work),
                "recorded in the delete"
            );
        }
        assert_eq!(went_with(&vault, &work), None, "a folder goes with nothing");
        assert_eq!(went_with(&vault, &loose), None);

        let before: Vec<u64> = notes
            .iter()
            .map(|n| vault.get_item(n).unwrap().revision)
            .collect();
        let writes = count_writes();
        vault.restore_item(&work).unwrap();
        failpoint::disarm_all();
        assert_eq!(
            writes.get(),
            4,
            "one write for each item and one for the folder"
        );
        for (note, was) in notes.iter().zip(before) {
            let item = vault.get_item(note).unwrap();
            assert!(item.trashed_at.is_none() && item.trashed_with.is_none());
            assert_eq!(item.revision, was + 1, "a real change, once");
            assert_eq!(item.collection, Some(work));
        }
        let folder = vault.get_item(&work).unwrap();
        assert!(folder.trashed_at.is_none() && folder.trashed_with.is_none());

        // It is on disk, too.
        let vault = reopen(vault);
        for id in notes.iter().chain([&work, &loose]) {
            assert!(!is_trashed(&vault, id));
            assert_eq!(went_with(&vault, id), None);
        }
    }

    #[test]
    fn folder_restore_leaves_items_trashed_earlier() {
        let (_parent, mut vault) = new_vault();
        let (work, notes) = folder_with(&mut vault, 3);
        let other = vault.new_item(ItemKind::Collection, "Home", None).unwrap();
        let elsewhere = vault.new_item(ItemKind::Note, "Else", Some(other)).unwrap();
        // One item trashed on its own before the delete, and one that went with another folder.
        vault.trash_item(&notes[0]).unwrap();
        vault.delete_collection(&other).unwrap();
        let earlier = vault.get_item(&notes[0]).unwrap().clone();
        assert_eq!(went_with(&vault, &notes[0]), None);

        assert_eq!(vault.delete_collection(&work).unwrap(), 2);
        assert_eq!(went_with(&vault, &notes[0]), None, "left exactly as it was");
        assert_eq!(
            vault.get_item(&notes[0]).unwrap().revision,
            earlier.revision
        );
        vault.restore_item(&work).unwrap();

        assert!(!is_trashed(&vault, &work));
        assert!(!is_trashed(&vault, &notes[1]) && !is_trashed(&vault, &notes[2]));
        let stayed = vault.get_item(&notes[0]).unwrap();
        assert!(stayed.trashed_at.is_some(), "trashed earlier: stays");
        assert_eq!(stayed.trashed_at, earlier.trashed_at);
        assert_eq!(stayed.revision, earlier.revision, "not written");
        assert!(is_trashed(&vault, &elsewhere) && is_trashed(&vault, &other));
        assert_eq!(went_with(&vault, &elsewhere), Some(other));

        let vault = reopen(vault);
        assert!(is_trashed(&vault, &notes[0]) && is_trashed(&vault, &elsewhere));
        assert!(!is_trashed(&vault, &work));
    }

    #[test]
    fn crash_midway_restores_the_right_items() {
        let (_parent, mut vault) = new_vault();
        let (work, notes) = folder_with(&mut vault, 3);
        vault.trash_item(&notes[0]).unwrap(); // earlier, on its own

        // A crash after the first member of the delete was written: that one carries the folder, the rest are as they were.
        crash_at_write(1);
        assert!(matches!(
            vault.delete_collection(&work),
            Err(CoreError::Io(_))
        ));
        failpoint::disarm_all();
        let mut vault = reopen(vault);
        // (The members are written in the order of their IDs, so which one went first is not fixed.)
        let gone: Vec<&ItemId> = notes[1..]
            .iter()
            .filter(|n| is_trashed(&vault, n))
            .collect();
        assert_eq!(gone.len(), 1);
        assert_eq!(went_with(&vault, gone[0]), Some(work));
        assert!(!is_trashed(&vault, &work));
        assert_eq!(went_with(&vault, &notes[0]), None);

        // The delete is tried again and finishes; the restore then brings back exactly what went with the folder.
        assert_eq!(vault.delete_collection(&work).unwrap(), 1);
        for note in &notes[1..] {
            assert_eq!(went_with(&vault, note), Some(work));
        }
        vault.restore_item(&work).unwrap();
        assert!(!is_trashed(&vault, &work));
        assert!(!is_trashed(&vault, &notes[1]) && !is_trashed(&vault, &notes[2]));
        assert!(
            is_trashed(&vault, &notes[0]),
            "trashed earlier: still there"
        );
        let vault = reopen(vault);
        assert!(is_trashed(&vault, &notes[0]) && !is_trashed(&vault, &notes[1]));
    }

    #[test]
    fn retry_writes_the_same_value() {
        let (_parent, mut vault) = new_vault();
        let (work, notes) = folder_with(&mut vault, 3);
        crash_at_write(2);
        assert!(vault.delete_collection(&work).is_err());
        failpoint::disarm_all();
        let mut vault = reopen(vault);
        let done: Vec<ItemId> = notes
            .iter()
            .copied()
            .filter(|n| is_trashed(&vault, n))
            .collect();
        assert_eq!(done.len(), 2, "two were written before the crash");
        let first = vault.get_item(&done[0]).unwrap().clone();
        assert_eq!(first.trashed_with, Some(work));
        let (revision, at) = (first.revision, first.trashed_at.clone());

        assert_eq!(
            vault.delete_collection(&work).unwrap(),
            1,
            "only the last one"
        );
        for note in &notes {
            assert_eq!(went_with(&vault, note), Some(work));
        }
        let kept = vault.get_item(&done[0]).unwrap();
        assert_eq!((kept.revision, &kept.trashed_at), (revision, &at));
        assert!(is_trashed(&vault, &work));
        // Once more changes nothing and writes nothing.
        let writes = count_writes();
        assert_eq!(vault.delete_collection(&work).unwrap(), 0);
        failpoint::disarm_all();
        assert_eq!(writes.get(), 0);
    }

    #[test]
    fn restore_retry_after_a_crash_finishes() {
        // A crash at each write of a restore in turn (three items, then the folder): restoring again always finishes.
        for crash in 0..4 {
            let (_parent, mut vault) = new_vault();
            let (work, notes) = folder_with(&mut vault, 3);
            let kept = vault.new_item(ItemKind::Note, "Kept", Some(work)).unwrap();
            vault.trash_item(&kept).unwrap();
            vault.delete_collection(&work).unwrap();
            crash_at_write(crash);
            assert!(
                matches!(vault.restore_item(&work), Err(CoreError::Io(_))),
                "{crash}"
            );
            failpoint::disarm_all();
            let mut vault = reopen(vault);
            let back = notes.iter().filter(|n| !is_trashed(&vault, n)).count();
            assert_eq!(back, crash.min(3), "items come first ({crash})");
            assert!(is_trashed(&vault, &work), "the folder goes last ({crash})");

            vault.restore_item(&work).unwrap();
            assert!(!is_trashed(&vault, &work), "{crash}");
            for note in &notes {
                assert!(!is_trashed(&vault, note) && went_with(&vault, note).is_none());
            }
            assert!(is_trashed(&vault, &kept), "trashed earlier ({crash})");
            let vault = reopen(vault);
            assert!(!is_trashed(&vault, &work) && is_trashed(&vault, &kept));
        }
    }

    #[test]
    fn restoring_an_item_clears_its_field() {
        let (_parent, mut vault) = new_vault();
        let (work, notes) = folder_with(&mut vault, 2);
        vault.delete_collection(&work).unwrap();
        assert_eq!(went_with(&vault, &notes[0]), Some(work));

        let writes = count_writes();
        vault.restore_item(&notes[0]).unwrap();
        failpoint::disarm_all();
        assert_eq!(writes.get(), 2, "its folder, then itself: nothing else");
        let item = vault.get_item(&notes[0]).unwrap();
        assert!(item.trashed_at.is_none() && item.trashed_with.is_none());
        // The other one still goes with the folder, trashed.
        assert!(is_trashed(&vault, &notes[1]));
        assert_eq!(went_with(&vault, &notes[1]), Some(work));
        let vault = reopen(vault);
        assert_eq!(went_with(&vault, &notes[0]), None);
        assert_eq!(went_with(&vault, &notes[1]), Some(work));

        // A single item trashed on its own has none, and a restore of it writes once.
        let mut vault = vault;
        let loose = vault.new_item(ItemKind::Note, "Loose", None).unwrap();
        vault.trash_item(&loose).unwrap();
        assert_eq!(went_with(&vault, &loose), None);
        let writes = count_writes();
        vault.restore_item(&loose).unwrap();
        failpoint::disarm_all();
        assert_eq!(writes.get(), 1);
        assert_eq!(went_with(&vault, &loose), None);
    }

    #[test]
    fn restoring_an_item_brings_back_its_folder() {
        let (_parent, mut vault) = new_vault();
        let (work, notes) = folder_with(&mut vault, 3);
        vault.delete_collection(&work).unwrap();

        // The folder is written first: a crash on the second write leaves the folder back and the item in the trash.
        crash_at_write(1);
        assert!(vault.restore_item(&notes[1]).is_err());
        failpoint::disarm_all();
        let mut vault = reopen(vault);
        assert!(!is_trashed(&vault, &work), "folder first");
        assert!(is_trashed(&vault, &notes[1]));
        assert_eq!(went_with(&vault, &notes[1]), Some(work));

        vault.restore_item(&notes[1]).unwrap();
        assert!(!is_trashed(&vault, &notes[1]) && went_with(&vault, &notes[1]).is_none());
        // Only the folder and that one item: the others stay in the trash, still naming the folder.
        for note in [&notes[0], &notes[2]] {
            assert!(is_trashed(&vault, note));
            assert_eq!(went_with(&vault, note), Some(work));
        }
    }

    /// The accepted edge (design, known limits): delete a folder, restore one item (the folder returns), delete the
    /// folder again, then restore it: the items still in the trash from the first delete come back too.
    #[test]
    fn a_second_delete_lets_a_folder_restore_the_first_ones_too() {
        let (_parent, mut vault) = new_vault();
        let (work, notes) = folder_with(&mut vault, 3);
        vault.delete_collection(&work).unwrap();
        vault.restore_item(&notes[0]).unwrap();
        assert_eq!(vault.delete_collection(&work).unwrap(), 1);
        vault.restore_item(&work).unwrap();
        for id in notes.iter().chain([&work]) {
            assert!(!is_trashed(&vault, id));
        }
    }

    /// A member being deleted for good is left alone by a folder's restore: the folder and the other members come back,
    /// that one stays in the trash, frozen, for its purge to finish. A folder being deleted for good is not restored,
    /// and nothing of it or its members changes.
    #[test]
    fn a_restore_never_brings_back_what_is_being_deleted() {
        let (_parent, mut vault) = new_vault();
        let (work, notes) = folder_with(&mut vault, 3);
        vault.delete_collection(&work).unwrap();
        failpoint::arm("purge.after_mark");
        assert!(vault.purge_item(&notes[1]).is_err());
        failpoint::disarm_all();
        let frozen = vault.get_item(&notes[1]).unwrap().clone();
        assert!(frozen.purging);

        vault.restore_item(&work).unwrap();
        assert!(!is_trashed(&vault, &work));
        assert!(!is_trashed(&vault, &notes[0]) && !is_trashed(&vault, &notes[2]));
        let after = vault.get_item(&notes[1]).unwrap();
        assert!(
            after.trashed_at.is_some() && after.purging,
            "stays in the trash"
        );
        assert_eq!(after.trashed_with, Some(work));
        assert_eq!(after.revision, frozen.revision, "not written");
        // Its purge still finishes.
        vault.purge_item(&notes[1]).unwrap();
        assert!(matches!(
            vault.get_item(&notes[1]),
            Err(CoreError::NotFound)
        ));

        // A folder being purged is refused whole, and its members stay where they are.
        let home = vault.new_item(ItemKind::Collection, "Home", None).unwrap();
        let homes = vault.new_item(ItemKind::Note, "H", Some(home)).unwrap();
        vault.delete_collection(&home).unwrap();
        failpoint::arm("purge.after_mark");
        assert!(vault.purge_item(&home).is_err());
        failpoint::disarm_all();
        let writes = count_writes();
        invalid(vault.restore_item(&home), "being deleted");
        failpoint::disarm_all();
        assert_eq!(writes.get(), 0, "nothing half-done");
        assert!(is_trashed(&vault, &home) && is_trashed(&vault, &homes));
        assert_eq!(went_with(&vault, &homes), Some(home));
    }

    #[test]
    fn a_folder_restore_ignores_members_it_does_not_hold() {
        // A trashed item that names the folder but was filed elsewhere since is not this folder's to bring back; and an
        // item that merely sits in the folder (never trashed with it) is not either.
        let (_parent, mut vault) = new_vault();
        let (work, notes) = folder_with(&mut vault, 2);
        let other = vault.new_item(ItemKind::Collection, "Home", None).unwrap();
        vault.delete_collection(&work).unwrap();
        let mut edit = vault.get_item(&notes[0]).unwrap().clone();
        edit.collection = Some(other);
        vault.update_item(edit).unwrap();
        assert_eq!(went_with(&vault, &notes[0]), Some(work), "an edit keeps it");
        vault.restore_item(&work).unwrap();
        assert!(is_trashed(&vault, &notes[0]));
        assert!(!is_trashed(&vault, &notes[1]));
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
        let found: Vec<_> = vault
            .search("changed", 10)
            .into_iter()
            .map(|h| h.id)
            .collect();
        assert_eq!(found, [id]);
        // Work continues from that state, and a reload agrees.
        let mut next = item.clone();
        next.title = "Changed again".into();
        vault.update_item(next).unwrap();
        let vault = reopen(vault);
        let item = vault.get_item(&id).unwrap();
        assert_eq!((item.title.as_str(), item.revision), ("Changed again", 2));
    }

    // Earlier passwords (Task 13): the engine moves the old password aside on a real change, and nothing else writes the
    // list.

    /// A login with `password` as its password and no earlier ones, as a page edit would send it.
    fn login_with(password: &str) -> ItemKind {
        ItemKind::Login {
            username: "ariel".into(),
            password: Zeroizing::new(password.into()),
            urls: vec!["https://example.com".into()],
            previous_passwords: Vec::new(),
        }
    }

    /// Sets the login `id`'s password to `password` through `update_item`, as the shell's edit does.
    fn set_password(vault: &mut Vault, id: &ItemId, password: &str) {
        let mut edit = vault.get_item(id).unwrap().clone();
        edit.kind = login_with(password);
        vault.update_item(edit).unwrap();
    }

    /// The login's password and its earlier ones, newest first, with the time each was replaced.
    fn passwords_of(vault: &Vault, id: &ItemId) -> (String, Vec<(String, String)>) {
        match &vault.get_item(id).unwrap().kind {
            ItemKind::Login {
                password,
                previous_passwords,
                ..
            } => (
                password.to_string(),
                previous_passwords
                    .iter()
                    .map(|old| (old.password.to_string(), old.replaced_at.clone()))
                    .collect(),
            ),
            other => panic!("not a login: {other:?}"),
        }
    }

    fn forged(password: &str) -> PreviousPassword {
        PreviousPassword {
            password: Zeroizing::new(password.into()),
            replaced_at: "1999-01-01T00:00:00Z".into(),
        }
    }

    /// A real change of password puts the old one at the front of the login's earlier passwords with the time it was
    /// replaced (the edit's own time), in the same write, and an unlock reads it back. A change of anything else moves
    /// nothing.
    #[test]
    fn real_change_moves_the_old_password() {
        let (_parent, mut vault) = new_vault();
        let id = vault
            .new_item(login_with("demo-pass-one"), "Mail", None)
            .unwrap();
        assert!(passwords_of(&vault, &id).1.is_empty());

        let writes = std::rc::Rc::new(std::cell::Cell::new(0));
        let seen = std::rc::Rc::clone(&writes);
        failpoint::observe(
            "items.after_write",
            Box::new(move || seen.set(seen.get() + 1)),
        );
        set_password(&mut vault, &id, "demo-pass-two");
        failpoint::disarm_all();
        assert_eq!(writes.get(), 1, "more than one write");
        let modified = vault.get_item(&id).unwrap().modified_at.clone();
        let (now, earlier) = passwords_of(&vault, &id);
        assert_eq!(now, "demo-pass-two");
        assert_eq!(earlier, [("demo-pass-one".to_owned(), modified.clone())]);

        set_password(&mut vault, &id, "demo-pass-three");
        let (now, earlier) = passwords_of(&vault, &id);
        assert_eq!(now, "demo-pass-three");
        let names: Vec<&str> = earlier.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(names, ["demo-pass-two", "demo-pass-one"], "newest first");
        assert_eq!(earlier[1].1, modified, "the first one's time did not move");

        // Another field changing, the password staying: nothing moves.
        let mut edit = vault.get_item(&id).unwrap().clone();
        edit.title = "Mail (work)".into();
        vault.update_item(edit).unwrap();
        assert_eq!(passwords_of(&vault, &id).1.len(), 2);

        let vault = reopen(vault);
        assert!(vault.damaged_items().is_empty());
        let (now, earlier) = passwords_of(&vault, &id);
        assert_eq!(now, "demo-pass-three");
        assert_eq!(earlier.len(), 2);
        assert_eq!(earlier[0].0, "demo-pass-two");
        // On disk, none of it is in the clear.
        let bytes = fs::read(item_path(&vault, &id)).unwrap();
        assert!(!bytes.windows(9).any(|window| window == b"demo-pass"));
    }

    /// Saving the same password again, over and over, moves nothing and keeps the list as it is.
    #[test]
    fn same_password_moves_nothing() {
        let (_parent, mut vault) = new_vault();
        let id = vault
            .new_item(login_with("demo-pass-one"), "Mail", None)
            .unwrap();
        set_password(&mut vault, &id, "demo-pass-one");
        set_password(&mut vault, &id, "demo-pass-one");
        assert!(passwords_of(&vault, &id).1.is_empty());
        set_password(&mut vault, &id, "demo-pass-two");
        assert_eq!(passwords_of(&vault, &id).1.len(), 1);
        set_password(&mut vault, &id, "demo-pass-two");
        assert_eq!(passwords_of(&vault, &id).1.len(), 1);
        // A change back to an older one is a real change: the one now in use goes to the front, and the older one stays
        // listed too (each row is a password that was replaced, whatever it was).
        set_password(&mut vault, &id, "demo-pass-one");
        let (now, earlier) = passwords_of(&vault, &id);
        assert_eq!(now, "demo-pass-one");
        let names: Vec<&str> = earlier.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(names, ["demo-pass-two", "demo-pass-one"]);
    }

    /// At most five are kept: the sixth change drops the oldest, whatever the number of changes after.
    #[test]
    fn at_most_five_oldest_dropped() {
        let (_parent, mut vault) = new_vault();
        let id = vault
            .new_item(login_with("demo-pw-0"), "Mail", None)
            .unwrap();
        for n in 1..=7 {
            set_password(&mut vault, &id, &format!("demo-pw-{n}"));
            let kept = passwords_of(&vault, &id).1.len();
            assert_eq!(kept, n.min(5), "after change {n}");
        }
        let (now, earlier) = passwords_of(&vault, &id);
        assert_eq!(now, "demo-pw-7");
        let names: Vec<&str> = earlier.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(
            names,
            [
                "demo-pw-6",
                "demo-pw-5",
                "demo-pw-4",
                "demo-pw-3",
                "demo-pw-2"
            ],
            "the two oldest are gone"
        );
        let vault = reopen(vault);
        assert_eq!(passwords_of(&vault, &id).1.len(), 5);
    }

    /// A password that was empty is not worth keeping: setting the first one moves nothing. Clearing one moves it.
    #[test]
    fn empty_old_password_moves_nothing() {
        let (_parent, mut vault) = new_vault();
        let id = vault.new_item(login_with(""), "Mail", None).unwrap();
        set_password(&mut vault, &id, "demo-pass-one");
        assert!(passwords_of(&vault, &id).1.is_empty());
        set_password(&mut vault, &id, "");
        let (now, earlier) = passwords_of(&vault, &id);
        assert_eq!(now, "");
        assert_eq!(earlier.len(), 1);
        assert_eq!(earlier[0].0, "demo-pass-one");
        // And the empty one now in use is not kept when the next one comes.
        set_password(&mut vault, &id, "demo-pass-two");
        assert_eq!(passwords_of(&vault, &id).1.len(), 1);
    }

    /// Nothing outside the engine writes the list: an item handed to `update_item` or `new_item` with a list of its own
    /// (a forged one, a copy of another) gets the stored list, or none on a new item, and never the caller's.
    #[test]
    fn page_cannot_write_previous_passwords() {
        let (_parent, mut vault) = new_vault();
        let forged_kind = |password: &str| ItemKind::Login {
            username: "ariel".into(),
            password: Zeroizing::new(password.into()),
            urls: Vec::new(),
            previous_passwords: vec![forged("demo-forged-one"), forged("demo-forged-two")],
        };

        // A new item starts with no earlier passwords, whatever it came with.
        let id = vault
            .new_item(forged_kind("demo-pass-one"), "Mail", None)
            .unwrap();
        assert!(passwords_of(&vault, &id).1.is_empty());
        let other = vault
            .new_item_with_notes(
                forged_kind("demo-pass-one"),
                "Other",
                None,
                Zeroizing::new(String::new()),
            )
            .unwrap();
        assert!(passwords_of(&vault, &other).1.is_empty());

        // The same password with a forged list: the stored list stays as it was (none).
        let mut edit = vault.get_item(&id).unwrap().clone();
        edit.kind = forged_kind("demo-pass-one");
        vault.update_item(edit).unwrap();
        assert!(passwords_of(&vault, &id).1.is_empty());

        // A real change with a forged list: the one the engine moved, and none of the forged.
        let mut edit = vault.get_item(&id).unwrap().clone();
        edit.kind = forged_kind("demo-pass-two");
        vault.update_item(edit).unwrap();
        let (now, earlier) = passwords_of(&vault, &id);
        assert_eq!(now, "demo-pass-two");
        assert_eq!(earlier.len(), 1);
        assert_eq!(earlier[0].0, "demo-pass-one");
        assert_ne!(earlier[0].1, "1999-01-01T00:00:00Z");

        // A forged empty list cannot erase the stored one either.
        let mut edit = vault.get_item(&id).unwrap().clone();
        edit.kind = login_with("demo-pass-two");
        vault.update_item(edit).unwrap();
        assert_eq!(passwords_of(&vault, &id).1.len(), 1);

        // A note turned into a login has none, whatever list it came with.
        let note = vault.new_item(ItemKind::Note, "Plans", None).unwrap();
        let mut edit = vault.get_item(&note).unwrap().clone();
        edit.kind = forged_kind("demo-pass-one");
        vault.update_item(edit).unwrap();
        assert!(passwords_of(&vault, &note).1.is_empty());
    }

    /// Earlier passwords are never in a search index (not by their text, whatever the query) and never in `Debug`, and
    /// they are wiped like the password in use (`Zeroizing`).
    #[test]
    fn previous_passwords_are_wiped_and_never_indexed() {
        let (_parent, mut vault) = new_vault();
        let id = vault
            .new_item(login_with("demo-oldest-secret"), "Mail", None)
            .unwrap();
        set_password(&mut vault, &id, "demo-newer-secret");
        set_password(&mut vault, &id, "demo-newest-secret");
        for query in ["demo-oldest", "oldest", "demo-newer", "secret"] {
            assert!(vault.search(query, 10).is_empty(), "{query}");
        }
        let found: Vec<_> = vault.search("mail", 10).into_iter().map(|h| h.id).collect();
        assert_eq!(found, [id], "the title is still found");

        let item = vault.get_item(&id).unwrap();
        for out in [
            format!("{item:?}"),
            format!("{item:#?}"),
            format!("{:?}", item.kind),
            format!("{:#?}", item.kind),
        ] {
            assert!(!out.contains("demo-"), "a password leaked in {out}");
        }
        match &item.kind {
            ItemKind::Login {
                previous_passwords, ..
            } => {
                // The type is the wiped one: this does not compile for a plain `String`.
                fn wiped(_: &Zeroizing<String>) {}
                for old in previous_passwords {
                    wiped(&old.password);
                    let said = format!("{old:?}");
                    assert!(!said.contains("demo-"), "{said}");
                }
            }
            other => panic!("not a login: {other:?}"),
        }
    }
}
