//! The in-memory search index. It lives in Rust: the UI sends a query and receives only the
//! IDs of the matching items.
//!
//! Indexed: every live item's title; a login's username and URLs; and the title of the item's
//! collection. Never indexed: passwords, notes, attached file names. Trashed and purging items
//! are left out. The index holds plain strings, like the items themselves (the vault is
//! unlocked while it exists). The vault rebuilds it whole after every change to its items.

use crate::ids::ItemId;
use crate::item::{Item, ItemKind};
use std::collections::HashMap;
use std::fmt;
use unicode_normalization::UnicodeNormalization;

/// Lower-case, then NFC. Used for indexed text and for queries alike, so "é" typed as one
/// character or as "e" + accent finds the same entries.
fn normalise(text: &str) -> String {
    text.to_lowercase().nfc().collect()
}

#[derive(Default)]
pub struct SearchIndex {
    entries: Vec<Entry>,
}

struct Entry {
    id: ItemId,
    title: String,
    /// Username, URLs and collection title: matches here rank below title matches.
    others: Vec<String>,
}

// Only the count: the indexed text is item content (R5).
impl fmt::Debug for SearchIndex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SearchIndex")
            .field("entries", &self.entries.len())
            .finish()
    }
}

impl SearchIndex {
    pub fn build<'a>(items: impl Iterator<Item = &'a Item>) -> Self {
        let live: Vec<&Item> = items
            .filter(|i| i.trashed_at.is_none() && !i.purging)
            .collect();
        let collections: HashMap<ItemId, &str> = live
            .iter()
            .filter(|i| matches!(i.kind, ItemKind::Collection))
            .map(|i| (i.id, i.title.as_str()))
            .collect();
        let entries = live
            .iter()
            .map(|item| {
                let mut others: Vec<&str> = Vec::new();
                if let ItemKind::Login { username, urls, .. } = &item.kind {
                    others.push(username);
                    others.extend(urls.iter().map(String::as_str));
                }
                others.extend(item.collection.and_then(|c| collections.get(&c)));
                Entry {
                    id: item.id,
                    title: normalise(&item.title),
                    others: others.into_iter().map(normalise).collect(),
                }
            })
            .collect();
        Self { entries }
    }

    /// IDs of the entries containing the trimmed query as one substring, best first: title
    /// starts with it, title contains it, then a match only in another field; ties by
    /// normalised title, then ID. At most `limit`; an empty query or a limit of 0 gives nothing.
    pub fn query(&self, q: &str, limit: usize) -> Vec<ItemId> {
        let q = normalise(q.trim());
        if q.is_empty() || limit == 0 {
            return Vec::new();
        }
        let mut hits: Vec<(u8, &str, ItemId)> = self
            .entries
            .iter()
            .filter_map(|e| {
                let rank = if e.title.starts_with(&q) {
                    0
                } else if e.title.contains(&q) {
                    1
                } else if e.others.iter().any(|o| o.contains(&q)) {
                    2
                } else {
                    return None;
                };
                Some((rank, e.title.as_str(), e.id))
            })
            .collect();
        hits.sort_unstable();
        hits.into_iter().take(limit).map(|(_, _, id)| id).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Vault;
    use crate::fsio::{failpoint, testutil::TempDir};
    use crate::ids::FileId;
    use crate::item::{FileRef, ItemKind};
    use crate::secret::Key32;
    use zeroize::Zeroizing;

    const PW: &str = "correct horse battery";

    fn id(n: u8) -> ItemId {
        ItemId([n; 16])
    }

    fn item(n: u8, kind: ItemKind, title: &str) -> Item {
        Item {
            id: id(n),
            kind,
            title: title.to_owned(),
            notes: Zeroizing::new(String::new()),
            collection: None,
            attachments: Vec::new(),
            revision: 0,
            created_at: String::new(),
            modified_at: String::new(),
            trashed_at: None,
            purging: false,
            retired_blobs: Vec::new(),
        }
    }

    fn login(n: u8, title: &str, username: &str, urls: &[&str]) -> Item {
        let kind = ItemKind::Login {
            username: username.to_owned(),
            password: Zeroizing::new("hunter2zz".to_owned()),
            urls: urls.iter().map(|u| (*u).to_owned()).collect(),
        };
        item(n, kind, title)
    }

    fn find(items: &[Item], q: &str) -> Vec<ItemId> {
        SearchIndex::build(items.iter()).query(q, 100)
    }

    #[test]
    fn matches_title_username_url_collection() {
        let mut bank = login(2, "Bank", "Alice", &["https://Example.com/login"]);
        bank.collection = Some(id(1));
        let items = [item(1, ItemKind::Collection, "Family Vault"), bank];
        assert_eq!(find(&items, "bank"), [id(2)]);
        assert_eq!(find(&items, "ALICE"), [id(2)]);
        assert_eq!(find(&items, "example.com/lo"), [id(2)]);
        // The collection matches by its own title; its member by the collection's title.
        assert_eq!(find(&items, "family"), [id(1), id(2)]);
        assert!(find(&items, "nothing").is_empty());
    }

    #[test]
    fn unicode_case_and_normalisation() {
        let items = [
            item(1, ItemKind::Note, "école"),
            item(2, ItemKind::Note, "\u{e9}t\u{e9}"),
        ];
        assert_eq!(find(&items, "ÉCOLE"), [id(1)]);
        let upper = [item(1, ItemKind::Note, "ÉCOLE")];
        assert_eq!(find(&upper, "école"), [id(1)]);
        // A decomposed query ("e" + U+0301) finds a composed title, and the reverse.
        assert_eq!(find(&items, "e\u{301}te\u{301}"), [id(2)]);
        let decomposed = [item(3, ItemKind::Note, "cafe\u{301}")];
        assert_eq!(find(&decomposed, "caf\u{e9}"), [id(3)]);
    }

    #[test]
    fn passwords_and_notes_not_indexed() {
        let mut one = login(1, "Site", "bob", &[]);
        one.notes = Zeroizing::new("secretnote".to_owned());
        one.attachments.push(FileRef {
            file_id: FileId::random(),
            blob_version: 1,
            chunk_size: 1,
            file_key: Key32::random(),
            nonce_prefix: [0; 19],
            length: 0,
            chunk_count: 0,
            name: "passport.pdf".to_owned(),
            media_type: "application/pdf".to_owned(),
        });
        let items = [one];
        assert!(find(&items, "hunter2").is_empty());
        assert!(find(&items, "secretnote").is_empty());
        assert!(find(&items, "passport").is_empty());
        assert_eq!(find(&items, "site"), [id(1)]);
    }

    #[test]
    fn trashed_and_purging_items_excluded() {
        let mut trashed = item(1, ItemKind::Note, "gone one");
        trashed.trashed_at = Some("2026-01-01T00:00:00Z".to_owned());
        let mut purging = item(2, ItemKind::Note, "gone two");
        purging.trashed_at = trashed.trashed_at.clone();
        purging.purging = true;
        // A live member of a trashed collection is found, but not by the collection's title.
        let mut folder = item(3, ItemKind::Collection, "old folder");
        folder.trashed_at = trashed.trashed_at.clone();
        let mut member = item(4, ItemKind::Note, "member");
        member.collection = Some(id(3));
        let items = [trashed, purging, folder, member];
        assert!(find(&items, "gone").is_empty());
        assert!(find(&items, "folder").is_empty());
        assert_eq!(find(&items, "member"), [id(4)]);
    }

    #[test]
    fn ranking_title_prefix_first() {
        let items = [
            login(1, "Other", "my bank", &[]),
            item(2, ItemKind::Note, "My bank"),
            item(3, ItemKind::Note, "Bank of Mars"),
            item(4, ItemKind::Note, "bank a"),
            item(5, ItemKind::Note, "bank a"),
        ];
        // prefix (title order, then id), then contains, then other fields.
        assert_eq!(find(&items, "bank"), [id(4), id(5), id(3), id(2), id(1)]);
    }

    #[test]
    fn limit_respected() {
        let items: Vec<Item> = (1..=5).map(|n| item(n, ItemKind::Note, "note")).collect();
        let index = SearchIndex::build(items.iter());
        assert_eq!(index.query("note", 3), [id(1), id(2), id(3)]);
        assert!(index.query("note", 0).is_empty());
        assert_eq!(index.query("note", 99).len(), 5);
    }

    #[test]
    fn empty_query_returns_nothing() {
        let items = [item(1, ItemKind::Note, "note")];
        assert!(find(&items, "").is_empty());
        assert!(find(&items, "  \t ").is_empty());
        assert_eq!(find(&items, "  note "), [id(1)]);
    }

    #[test]
    fn debug_shows_no_indexed_text() {
        let items = [login(
            1,
            "Zebra title",
            "zebra-user",
            &["https://zebra.test"],
        )];
        let out = format!("{:?}", SearchIndex::build(items.iter()));
        assert!(!out.to_lowercase().contains("zebra"), "{out}");
        assert!(out.contains('1'), "{out}");
    }

    fn new_vault() -> (TempDir, Vault) {
        let parent = TempDir::new();
        let vault = Vault::create(parent.path(), "Family", PW).unwrap().vault;
        (parent, vault)
    }

    fn retitle(vault: &mut Vault, id: &ItemId, title: &str) {
        let mut item = vault.get_item(id).unwrap().clone();
        item.title = title.to_owned();
        vault.update_item(item).unwrap();
    }

    #[test]
    fn index_updates_after_edit_and_trash() {
        let (_parent, mut vault) = new_vault();
        let kind = ItemKind::Login {
            username: "carol".to_owned(),
            password: Zeroizing::new("pw".to_owned()),
            urls: vec![],
        };
        let one = vault.new_item(kind, "Alpha", None).unwrap();
        assert_eq!(vault.search("alpha", 10), [one]);

        retitle(&mut vault, &one, "Beta");
        assert!(vault.search("alpha", 10).is_empty());
        assert_eq!(vault.search("beta", 10), [one]);

        vault.trash_item(&one).unwrap();
        assert!(vault.search("beta", 10).is_empty());
        vault.restore_item(&one).unwrap();
        assert_eq!(vault.search("carol", 10), [one]);

        // Unlock builds the index from what is on disk.
        let dir = vault.dir().to_path_buf();
        drop(vault);
        let (mut vault, _) = Vault::unlock_with_password(&dir, PW).unwrap();
        assert_eq!(vault.search("beta", 10), [one]);

        // A purge that stops half-way leaves the item frozen and unlisted; finishing it removes it.
        vault.trash_item(&one).unwrap();
        failpoint::arm("purge.after_mark");
        assert!(vault.purge_item(&one).is_err());
        failpoint::disarm_all();
        assert!(vault.search("carol", 10).is_empty());
        vault.purge_item(&one).unwrap();
        assert!(vault.search("beta", 10).is_empty());
    }

    #[test]
    fn collection_rename_updates_members() {
        let (_parent, mut vault) = new_vault();
        let folder = vault.new_item(ItemKind::Collection, "Taxes", None).unwrap();
        let member = vault
            .new_item(ItemKind::Note, "Receipt", Some(folder))
            .unwrap();
        assert_eq!(vault.search("taxes", 10), [folder, member]);

        retitle(&mut vault, &folder, "Invoices");
        assert!(vault.search("taxes", 10).is_empty());
        assert_eq!(vault.search("invoices", 10), [folder, member]);

        vault.delete_collection(&folder).unwrap();
        assert!(vault.search("invoices", 10).is_empty());
    }
}
