//! What the page sees of items (spec §4.1). The engine's `Item` has no serde of its own; each view here is built
//! field by field from it and never holds a password or a key's value (only whether there is one), a file key or a
//! nonce. A password or a key's value crosses only through `reveal_password`. IDs are 32 lowercase hex characters. No `Debug`: titles, usernames, names
//! and notes are item content (R5).

use lockbox_core::ids::{FileId, ItemId};
use lockbox_core::item::{FileRef, Item, ItemKind};
use serde::Serialize;
use tauri::Url;
use zeroize::Zeroizing;

use crate::session::{SessionId, Tagged};

/// An attached file: what the page shows of it, never what opens it.
#[derive(Serialize)]
pub struct FileView {
    pub file_id: String,
    pub name: String,
    pub length: u64,
    pub media_type: String,
}

impl FileView {
    pub fn of(file: &FileRef) -> FileView {
        FileView {
            file_id: file.file_id.to_hex(),
            name: file.name.clone(),
            length: file.length,
            media_type: file.media_type.clone(),
        }
    }
}

/// One item in a list or a search result.
#[derive(Serialize)]
pub struct ItemSummary {
    pub id: String,
    /// `"login"`, `"key"`, `"note"`, `"file"` or `"collection"`.
    pub kind: &'static str,
    pub title: String,
    /// A login's username; `None` for every other kind.
    pub username: Option<String>,
    /// The ID of the collection the item is in.
    pub collection: Option<String>,
    pub trashed: bool,
    /// The host of a login's first website, for a search result to say where the login is for: nothing else of the
    /// address (no scheme, port, login, path or query). `None` when there is no website, it does not parse, or it is
    /// not an `http` or `https` one, which is exactly when `open_url` would not open link 0.
    pub site: Option<String>,
    /// When the item was made and when it last changed: RFC 3339, UTC, whole seconds, as the engine keeps them. The
    /// page says "changed 2 days ago" from the second, and later sorts by it.
    pub created_at: String,
    pub modified_at: String,
    pub attachments: Vec<FileView>,
}

/// A stored website as a link the shell would open: only `http` and `https` ones parse to one (spec §4.2).
pub fn web_url(stored: &str) -> Option<Url> {
    Url::parse(stored)
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https"))
}

impl ItemSummary {
    pub fn of(item: &Item) -> ItemSummary {
        let (kind, username, site) = match &item.kind {
            ItemKind::Login { username, urls, .. } => {
                let site = urls
                    .first()
                    .and_then(|first| web_url(first))
                    .and_then(|url| url.host_str().map(str::to_owned));
                ("login", Some(username.clone()), site)
            }
            // A key's name is its title; its value is not here, in this view or any other but Reveal's.
            ItemKind::Key { .. } => ("key", None, None),
            ItemKind::Note => ("note", None, None),
            ItemKind::File => ("file", None, None),
            ItemKind::Collection => ("collection", None, None),
        };
        ItemSummary {
            id: item.id.to_hex(),
            kind,
            title: item.title.clone(),
            username,
            collection: item.collection.as_ref().map(ItemId::to_hex),
            trashed: item.trashed_at.is_some(),
            site,
            created_at: item.created_at.clone(),
            modified_at: item.modified_at.clone(),
            attachments: item.attachments.iter().map(FileView::of).collect(),
        }
    }
}

/// One item opened: its summary, notes and links, and whether it has a password or a key's value to reveal.
#[derive(Serialize)]
pub struct ItemDetail {
    pub summary: ItemSummary,
    /// Sent back with an edit: a change made meanwhile makes the edit stale.
    pub revision: u64,
    pub notes: Zeroizing<String>,
    pub urls: Vec<String>,
    pub has_password: bool,
    /// A key has a value to reveal. Only whether: the value crosses through `reveal_password` alone.
    pub has_value: bool,
}

impl ItemDetail {
    pub fn of(item: &Item) -> ItemDetail {
        let (urls, has_password, has_value) = match &item.kind {
            ItemKind::Login { urls, password, .. } => (urls.clone(), !password.is_empty(), false),
            ItemKind::Key { value } => (Vec::new(), false, !value.is_empty()),
            _ => (Vec::new(), false, false),
        };
        ItemDetail {
            summary: ItemSummary::of(item),
            revision: item.revision,
            notes: item.notes.clone(),
            urls,
            has_password,
            has_value,
        }
    }
}

/// Every item of a vault, trashed ones included (the page filters), and the items that did not open (spec §8: they
/// show as damaged).
#[derive(Serialize)]
pub struct ItemList {
    pub items: Vec<ItemSummary>,
    pub damaged: Vec<String>,
}

impl ItemList {
    pub fn of<'a>(items: impl Iterator<Item = &'a Item>, damaged: &[ItemId]) -> ItemList {
        ItemList {
            items: items.map(ItemSummary::of).collect(),
            damaged: damaged.iter().map(ItemId::to_hex).collect(),
        }
    }
}

/// What a search of every unlocked vault found: one tagged answer per vault searched, and the vaults that were busy
/// (a long change held them past the short wait), which the page names so the user can search again. A vault that
/// locked is in neither.
#[derive(Serialize)]
pub struct SearchResults {
    pub hits: Vec<Tagged<Vec<ItemSummary>>>,
    pub busy: Vec<SessionId>,
}

/// Where a readable file was saved (`save_recovery_pdf`, `save_readable_confirm`): the folder that holds it, as the
/// user's own path, for the page to show. No command takes it back (spec 4.1: the page never receives a path it can
/// send back).
#[derive(Serialize)]
pub struct SavedView {
    pub folder: String,
}

/// The printers Lockbox can print to (`list_printers`), by the names Windows shows, and the default one when it is
/// among them. Printers that write a file through a save box of their own are left out. No vault data.
#[derive(Serialize)]
pub struct PrinterList {
    pub printers: Vec<String>,
    pub default: Option<String>,
}

/// A quarantined file no item references (spec §6.4), with its size in bytes.
#[derive(Serialize)]
pub struct OrphanView {
    pub file_id: String,
    pub length: u64,
}

impl OrphanView {
    pub fn of((file_id, length): &(FileId, u64)) -> OrphanView {
        OrphanView {
            file_id: file_id.to_hex(),
            length: *length,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn secret(text: &str) -> Zeroizing<String> {
        Zeroizing::new(text.to_owned())
    }

    fn item(kind: ItemKind) -> Item {
        Item {
            id: ItemId([7; 16]),
            kind,
            title: "Bank".into(),
            notes: secret(""),
            collection: None,
            attachments: Vec::new(),
            revision: 1,
            created_at: "2026-10-29T00:00:00Z".into(),
            modified_at: "2026-10-29T00:00:00Z".into(),
            trashed_at: None,
            purging: false,
            retired_blobs: Vec::new(),
        }
    }

    fn login(urls: &[&str]) -> Item {
        item(ItemKind::Login {
            username: "ada".into(),
            password: secret("Pw-0123456789-xyz"),
            urls: urls.iter().map(|url| (*url).to_owned()).collect(),
        })
    }

    /// The summary's `site`, as the page gets it: the field must be there (null, not missing).
    fn site(item: &Item) -> Value {
        let summary = serde_json::to_value(ItemSummary::of(item)).unwrap();
        let fields = summary.as_object().unwrap();
        assert!(fields.contains_key("site"), "the summary has no site field");
        fields["site"].clone()
    }

    /// A login's summary carries the host of its first website, and nothing of the rest of the address: no scheme, no
    /// port, no login in front of the host, no path, no query, no fragment.
    #[test]
    fn site_is_the_host_and_nothing_after_it() {
        for (stored, host) in [
            ("https://support.example.com", "support.example.com"),
            ("http://support.example.com/", "support.example.com"),
            (
                "https://Support.Example.COM/a/b?token=abc#part",
                "support.example.com",
            ),
            (
                "https://support.example.com:8443/admin",
                "support.example.com",
            ),
            (
                "https://ada:hunter2@support.example.com/",
                "support.example.com",
            ),
            ("https://192.168.0.1/login", "192.168.0.1"),
        ] {
            assert_eq!(site(&login(&[stored])), json!(host), "{stored}");
        }
        // Only the first website counts: the page opens link number 0, so a host from a later one would not open.
        assert_eq!(
            site(&login(&["https://one.example", "https://two.example"])),
            json!("one.example")
        );
        // Nothing but the host reaches the page in the summary: no path, query, port or password.
        let summary = serde_json::to_value(ItemSummary::of(&login(&[
            "https://ada:hunter2@support.example.com:8443/a/b?token=abc#part",
        ])))
        .unwrap()
        .to_string();
        for leaked in ["hunter2", "token", "8443", "/a/b", "part", "https://"] {
            assert!(!summary.contains(leaked), "the summary holds {leaked}");
        }
    }

    /// A key's value, made up for these tests.
    const KEY_VALUE: &str = "demo-zzz-qqq-one";

    fn key() -> Item {
        let mut item = item(ItemKind::Key {
            value: secret(KEY_VALUE),
        });
        item.title = "OPENAI_API_KEY".into();
        item.notes = secret("rotate monthly");
        item
    }

    /// No view of a key carries its value, whole or in part, in any field or under any name: a summary, a detail
    /// and a list say there is one (`has_value`) and nothing else. The shapes are pinned field by field.
    #[test]
    fn summary_never_holds_a_value() {
        let key = key();
        let summary = serde_json::to_value(ItemSummary::of(&key)).unwrap();
        let detail = serde_json::to_value(ItemDetail::of(&key)).unwrap();
        let list = serde_json::to_value(ItemList::of([&key].into_iter(), &[])).unwrap();
        for view in [&summary, &detail, &list] {
            let text = view.to_string();
            for leaked in [KEY_VALUE, "demo-zzz", "qqq-one", "\"value\"", "\"key\":{"] {
                assert!(!text.contains(leaked), "a view holds {leaked}: {text}");
            }
        }
        let expected = json!({
            "id": "07".repeat(16), "kind": "key", "title": "OPENAI_API_KEY", "username": null,
            "collection": null, "trashed": false, "site": null,
            "created_at": "2026-10-29T00:00:00Z", "modified_at": "2026-10-29T00:00:00Z",
            "attachments": [],
        });
        assert_eq!(summary, expected);
        assert_eq!(
            detail,
            json!({
                "summary": expected, "revision": 1, "notes": "rotate monthly", "urls": [],
                "has_password": false, "has_value": true,
            })
        );
        assert_eq!(list, json!({ "items": [expected], "damaged": [] }));

        // An empty value is no value; every other kind has none.
        let empty = item(ItemKind::Key { value: secret("") });
        assert_eq!(
            serde_json::to_value(ItemDetail::of(&empty)).unwrap()["has_value"],
            false
        );
        for kind in [ItemKind::Note, ItemKind::File, ItemKind::Collection] {
            let detail = serde_json::to_value(ItemDetail::of(&item(kind))).unwrap();
            assert_eq!(detail["has_value"], false);
        }
        let login = serde_json::to_value(ItemDetail::of(&login(&[]))).unwrap();
        assert_eq!(
            (&login["has_value"], &login["has_password"]),
            (&json!(false), &json!(true))
        );
    }

    #[test]
    fn no_site_when_no_url() {
        assert_eq!(site(&login(&[])), Value::Null);
        for kind in [ItemKind::Note, ItemKind::File, ItemKind::Collection] {
            assert_eq!(site(&item(kind)), Value::Null);
        }
    }

    /// An address that does not parse, or that the shell would not open (only `http` and `https` open), gives none; so
    /// does a first website like that even when a later one is fine.
    #[test]
    fn a_url_that_does_not_parse_gives_none() {
        for stored in [
            "",
            "support.example.com",
            "not a url",
            "https://",
            "https://exa mple.com",
            "javascript:alert(1)",
            "mailto:ada@example.com",
            "ftp://files.example.com",
            "file:///C:/x",
            r"\\server\share",
            r"C:\x.exe",
            "ms-settings:",
        ] {
            assert_eq!(site(&login(&[stored])), Value::Null, "{stored}");
        }
        assert_eq!(
            site(&login(&["not a url", "https://two.example"])),
            Value::Null
        );
    }
}
