//! The in-memory search index. It lives in Rust: the UI sends a query and receives only the
//! IDs of the matching items, and the name of the attached file a match was in, when it was one.
//!
//! Indexed: every live item's title; a login's username and URLs; the title of the item's
//! collection (a key's name is its title); and the names of its attached files. Never indexed:
//! passwords, a key's value, notes. Trashed and purging items are left out, and so are their
//! files. The index holds plain strings, like the items themselves (the vault is unlocked while
//! it exists). The vault rebuilds it whole after every change to its items.

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
    /// The attached files' names as they are, each once, with the normalised form that is searched.
    files: Vec<(String, String)>,
}

/// One search result: the item, and when the match was in the name of one of its attached files, that file's name. An
/// item that matches in its own fields and in a file's name gives two hits, one without a file and one with.
#[derive(Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub id: ItemId,
    pub matched_file: Option<String>,
}

// Only whether a file matched: the name is item content (R5).
impl fmt::Debug for SearchHit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SearchHit")
            .field("id", &self.id)
            .field("in_a_file", &self.matched_file.is_some())
            .finish()
    }
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
                // Each name once: two files that share one are one result.
                let mut files: Vec<(String, String)> = Vec::new();
                for file in &item.attachments {
                    if !files.iter().any(|(_, name)| *name == file.name) {
                        files.push((normalise(&file.name), file.name.clone()));
                    }
                }
                Entry {
                    id: item.id,
                    title: normalise(&item.title),
                    others: others.into_iter().map(normalise).collect(),
                    files,
                }
            })
            .collect();
        Self { entries }
    }

    /// The hits for the trimmed query as one substring, best first: title starts with it, title
    /// contains it, then a match only in another field or in an attached file's name (one hit for
    /// each file); ties by normalised title, then ID, then the item's own hit before its files',
    /// those by normalised name. At most `limit`; an empty query or a limit of 0 gives nothing.
    pub fn query(&self, q: &str, limit: usize) -> Vec<SearchHit> {
        let q = normalise(q.trim());
        if q.is_empty() || limit == 0 {
            return Vec::new();
        }
        let mut hits: Vec<Found> = Vec::new();
        for e in &self.entries {
            let rank = if e.title.starts_with(&q) {
                Some(0)
            } else if e.title.contains(&q) {
                Some(1)
            } else if e.others.iter().any(|o| o.contains(&q)) {
                Some(2)
            } else {
                None
            };
            if let Some(rank) = rank {
                hits.push(Found {
                    rank,
                    title: &e.title,
                    id: e.id,
                    file: None,
                });
            }
            for (searched, name) in &e.files {
                if searched.contains(&q) {
                    hits.push(Found {
                        rank: 2,
                        title: &e.title,
                        id: e.id,
                        file: Some((searched, name)),
                    });
                }
            }
        }
        hits.sort_unstable();
        hits.into_iter()
            .take(limit)
            .map(|found| SearchHit {
                id: found.id,
                matched_file: found.file.map(|(_, name)| name.to_owned()),
            })
            .collect()
    }
}

/// A match before it is ranked. Its fields are in the order hits are sorted by: rank, normalised title, ID, then an item's
/// own hit (no file) before its files', those by their normalised name.
#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct Found<'a> {
    rank: u8,
    title: &'a str,
    id: ItemId,
    /// A file's normalised name and its name as stored.
    file: Option<(&'a str, &'a str)>,
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
            trashed_with: None,
            purging: false,
            retired_blobs: Vec::new(),
        }
    }

    fn login(n: u8, title: &str, username: &str, urls: &[&str]) -> Item {
        let kind = ItemKind::Login {
            username: username.to_owned(),
            password: Zeroizing::new("hunter2zz".to_owned()),
            urls: urls.iter().map(|u| (*u).to_owned()).collect(),
            previous_passwords: Vec::new(),
        };
        item(n, kind, title)
    }

    fn find(items: &[Item], q: &str) -> Vec<ItemId> {
        found(SearchIndex::build(items.iter()).query(q, 100))
    }

    fn hits(items: &[Item], q: &str) -> Vec<SearchHit> {
        SearchIndex::build(items.iter()).query(q, 100)
    }

    /// The items of some hits, whichever file they matched in.
    fn found(hits: Vec<SearchHit>) -> Vec<ItemId> {
        hits.into_iter().map(|hit| hit.id).collect()
    }

    fn file(name: &str) -> FileRef {
        FileRef {
            file_id: FileId::random(),
            blob_version: 1,
            chunk_size: 1,
            file_key: Key32::random(),
            nonce_prefix: [0; 19],
            length: 0,
            chunk_count: 0,
            name: name.to_owned(),
            media_type: "application/pdf".to_owned(),
        }
    }

    fn with_files(mut item: Item, names: &[&str]) -> Item {
        item.attachments = names.iter().map(|name| file(name)).collect();
        item
    }

    fn in_file(n: u8, name: &str) -> SearchHit {
        SearchHit {
            id: id(n),
            matched_file: Some(name.to_owned()),
        }
    }

    fn plain(n: u8) -> SearchHit {
        SearchHit {
            id: id(n),
            matched_file: None,
        }
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

    /// Lowercasing can change a text's length ("İ" becomes "i" + U+0307); both sides must agree.
    #[test]
    fn expanding_lowercase_matches_both_ways() {
        let items = [
            item(1, ItemKind::Note, "\u{130}stanbul trip"),
            item(2, ItemKind::Note, "i\u{307}zmir hotel"),
        ];
        assert_eq!(find(&items, "i\u{307}stanbul"), [id(1)]);
        assert_eq!(find(&items, "\u{130}zmir"), [id(2)]);
        assert_eq!(find(&items, "\u{130}stanbul"), [id(1)]);
    }

    /// Notes and passwords are still not indexed now that file names are, and a file's own name does not open a note's
    /// text to search: only the title, username, links, folder and file names are in the index.
    #[test]
    fn search_still_never_indexes_notes_or_values() {
        let mut one = login(1, "Site", "bob", &[]);
        one.notes = Zeroizing::new("secretnote".to_owned());
        let items = [with_files(one, &["passport.pdf"])];
        assert!(find(&items, "hunter2").is_empty());
        assert!(find(&items, "secretnote").is_empty());
        assert_eq!(find(&items, "site"), [id(1)]);
        // A key's value and a note's text, on items that hold files too, whatever the query.
        let mut note = item(2, ItemKind::Note, "Plans");
        note.notes = Zeroizing::new("demo-note-text-zzz".to_owned());
        let items = [
            with_files(note, &["plans.pdf"]),
            with_files(key(3, "OPENAI_API_KEY", "demo-zzz-qqq-one"), &["k.txt"]),
        ];
        for query in ["demo-note", "note-text", "zzz", "qqq-one", "demo-zzz"] {
            assert!(find(&items, query).is_empty(), "{query}");
        }
        // The file is not indexed by its media type, its length or its key either.
        assert!(find(&items, "application").is_empty());
    }

    /// An attached file's name is found, in any case and in part, like the other fields; it ranks with the other
    /// non-title fields, below a title match; the hit says which file; and only a file name matching gives a file hit.
    #[test]
    fn file_names_are_indexed() {
        let items = [
            with_files(login(1, "Bank", "bob", &[]), &["Passport scan.PDF"]),
            item(2, ItemKind::Note, "Passport notes"),
            with_files(item(3, ItemKind::File, "Contract"), &["contract-demo.pdf"]),
        ];
        assert_eq!(find(&items, "passport"), [id(2), id(1)]);
        assert_eq!(find(&items, "SCAN.pdf"), [id(1)]);
        assert_eq!(find(&items, "demo.pd"), [id(3)]);
        // A decomposed query finds a composed file name, as for titles.
        let accents = [with_files(
            item(4, ItemKind::File, "Menu"),
            &["caf\u{e9}.pdf"],
        )];
        assert_eq!(find(&accents, "cafe\u{301}"), [id(4)]);
        // Ranked with the other non-title fields: a username match and a file name match tie, then title, then id.
        let tied = [
            with_files(login(7, "Zed", "x", &[]), &["shared.txt"]),
            login(6, "Alpha", "shared-user", &[]),
        ];
        assert_eq!(find(&tied, "shared"), [id(6), id(7)]);
    }

    /// The hit holds the file's name as it is stored, for the file that matched; an item that matches in its own
    /// fields and in a file's name gives both hits, the item's first; a name found twice in one item is one hit.
    #[test]
    fn hit_says_which_file_matched() {
        let items = [with_files(
            login(1, "Passport", "bob", &[]),
            &["Visa copy.pdf", "passport scan.pdf", "visa-two.pdf"],
        )];
        // A file name only: one hit, with that file.
        assert_eq!(hits(&items, "scan"), [in_file(1, "passport scan.pdf")]);
        // Two files match: a hit for each, in the files' order of their names.
        assert_eq!(
            hits(&items, "visa"),
            [in_file(1, "Visa copy.pdf"), in_file(1, "visa-two.pdf")]
        );
        // The title and a file name: the item's own hit, then the file's.
        assert_eq!(
            hits(&items, "passport"),
            [plain(1), in_file(1, "passport scan.pdf")]
        );
        // Two files with one name are one hit.
        let twins = [with_files(
            item(2, ItemKind::Note, "Docs"),
            &["a.pdf", "a.pdf"],
        )];
        assert_eq!(hits(&twins, "a.pdf"), [in_file(2, "a.pdf")]);
        // No file matched: no file in the hit.
        assert_eq!(hits(&items, "bob"), [plain(1)]);
        // The name never shows in `Debug`.
        let shown = format!("{:?}", hits(&items, "scan"));
        assert!(!shown.contains("scan") && !shown.contains("pdf"), "{shown}");
    }

    /// A trashed or purging item's files are not found, nor are the files of a live item in a trashed folder found by
    /// the folder; and the files come back with the item.
    #[test]
    fn trashed_files_not_found() {
        let mut trashed = with_files(item(1, ItemKind::File, "Old"), &["gone-scan.pdf"]);
        trashed.trashed_at = Some("2026-01-01T00:00:00Z".to_owned());
        let mut purging = with_files(item(2, ItemKind::File, "Older"), &["gone-two.pdf"]);
        purging.trashed_at = trashed.trashed_at.clone();
        purging.purging = true;
        let live = with_files(item(3, ItemKind::File, "Kept"), &["kept-scan.pdf"]);
        let items = [trashed, purging, live];
        assert!(find(&items, "gone").is_empty());
        assert_eq!(hits(&items, "scan"), [in_file(3, "kept-scan.pdf")]);
        // Through a vault: the file's item in and out of the trash, and a purge.
        let (parent, mut vault) = new_vault();
        let source = parent.path().join("passport.pdf");
        std::fs::write(&source, b"demo").unwrap();
        let made = vault
            .new_file_item(None, &source, &crate::blob::CancelToken::new())
            .unwrap();
        let named = |vault: &Vault| {
            let found = vault.search("passport", 10);
            found
                .iter()
                .filter(|hit| hit.matched_file.is_some())
                .count()
        };
        assert_eq!(named(&vault), 1);
        vault.trash_item(&made).unwrap();
        assert!(vault.search("passport", 10).is_empty());
        vault.restore_item(&made).unwrap();
        assert_eq!(named(&vault), 1);
        vault.trash_item(&made).unwrap();
        vault.purge_item(&made).unwrap();
        assert!(vault.search("passport", 10).is_empty());
    }

    fn key(n: u8, name: &str, value: &str) -> Item {
        let kind = ItemKind::Key {
            value: Zeroizing::new(value.to_owned()),
        };
        item(n, kind, name)
    }

    /// A key's value is never in the index, in whole or in part, however it is found; the name is, like any title.
    #[test]
    fn key_value_never_indexed() {
        let mut one = key(1, "OPENAI_API_KEY", "demo-zzz-qqq-one");
        one.notes = Zeroizing::new("rotate monthly".to_owned());
        let items = [one];
        for query in [
            "demo-zzz",
            "qqq-one",
            "demo-",
            "zzz-qqq",
            "q-on",
            "DEMO-ZZZ-QQQ-ONE",
        ] {
            assert!(
                find(&items, query).is_empty(),
                "{query} found a key by its value"
            );
        }
        // Nor does the engine's own search, through a vault that is saved and unlocked again.
        let (_parent, mut vault) = new_vault();
        let kind = ItemKind::Key {
            value: Zeroizing::new("demo-zzz-qqq-one".to_owned()),
        };
        let made = vault.new_item(kind, "OPENAI_API_KEY", None).unwrap();
        assert!(vault.search("demo-zzz", 10).is_empty());
        assert_eq!(found(vault.search("openai", 10)), [made]);
        let dir = vault.dir().to_path_buf();
        drop(vault);
        let (vault, _) = Vault::unlock_with_password(&dir, PW).unwrap();
        assert!(vault.search("qqq-one", 10).is_empty());
        assert_eq!(found(vault.search("openai", 10)), [made]);
    }

    #[test]
    fn key_name_is_indexed() {
        let mut in_folder = key(3, "STRIPE_SECRET_KEY", "v3");
        in_folder.collection = Some(id(9));
        let items = [
            item(9, ItemKind::Collection, "Lineproof"),
            key(1, "OPENAI_API_KEY", "v1"),
            key(2, "TELEGRAM_BOT_TOKEN", "v2"),
            in_folder,
        ];
        // The whole name, a part of it, in any case, and what follows an underscore.
        assert_eq!(find(&items, "OPENAI_API_KEY"), [id(1)]);
        assert_eq!(find(&items, "openai"), [id(1)]);
        assert_eq!(find(&items, "bot_tok"), [id(2)]);
        assert_eq!(find(&items, "api_key"), [id(1)]);
        // A key in a folder is found by the folder's name, like any item, and still not by its value.
        assert_eq!(find(&items, "lineproof"), [id(9), id(3)]);
        assert!(find(&items, "v1").is_empty());
        // A trashed key is not found.
        let mut gone = key(4, "OLD_KEY", "v4");
        gone.trashed_at = Some("2026-01-01T00:00:00Z".to_owned());
        assert!(find(&[gone], "old_key").is_empty());
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

    /// `trashed_with` is a folder's ID and is never indexed: not the ID in hex, nor a part of it, even on an item that is
    /// live with the field set (which the engine never writes).
    #[test]
    fn trashed_with_is_never_indexed() {
        let mut member = item(4, ItemKind::Note, "member");
        member.trashed_with = Some(id(0xAB));
        let items = [member];
        assert_eq!(find(&items, "member"), [id(4)]);
        assert!(find(&items, &"ab".repeat(16)).is_empty());
        assert!(find(&items, "abab").is_empty());
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
        assert_eq!(found(index.query("note", 3)), [id(1), id(2), id(3)]);
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
            previous_passwords: Vec::new(),
        };
        let one = vault.new_item(kind, "Alpha", None).unwrap();
        assert_eq!(found(vault.search("alpha", 10)), [one]);

        retitle(&mut vault, &one, "Beta");
        assert!(vault.search("alpha", 10).is_empty());
        assert_eq!(found(vault.search("beta", 10)), [one]);

        vault.trash_item(&one).unwrap();
        assert!(vault.search("beta", 10).is_empty());
        vault.restore_item(&one).unwrap();
        assert_eq!(found(vault.search("carol", 10)), [one]);

        // Unlock builds the index from what is on disk.
        let dir = vault.dir().to_path_buf();
        drop(vault);
        let (mut vault, _) = Vault::unlock_with_password(&dir, PW).unwrap();
        assert_eq!(found(vault.search("beta", 10)), [one]);

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
        assert_eq!(found(vault.search("taxes", 10)), [folder, member]);

        retitle(&mut vault, &folder, "Invoices");
        assert!(vault.search("taxes", 10).is_empty());
        assert_eq!(found(vault.search("invoices", 10)), [folder, member]);

        vault.delete_collection(&folder).unwrap();
        assert!(vault.search("invoices", 10).is_empty());
    }
}
