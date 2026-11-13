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
    /// When the item went to the trash (RFC 3339, UTC, whole seconds, as the engine keeps it), for the Trash view's
    /// "deleted <when>"; `None` for an item that is not in the trash.
    pub trashed_at: Option<String>,
    /// The folder the item went to the trash with, when it went because that folder was deleted: the same kind of ID as
    /// `collection`. `None` for an item trashed on its own and for one that is not in the trash. Not a secret.
    pub trashed_with: Option<String>,
    /// The item is being deleted for good (its delete started and has not finished): the page leaves it out of the number
    /// a folder's restore brings back, since the restore does not bring it back.
    pub purging: bool,
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
            trashed_at: item.trashed_at.clone(),
            trashed_with: item.trashed_with.as_ref().map(ItemId::to_hex),
            purging: item.purging,
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
    /// A login's earlier passwords, newest first: each one's number and when it was replaced, never the password.
    pub previous: Vec<PreviousView>,
}

/// One of a login's earlier passwords, as the page sees it. `index` is what Reveal and Copy send back
/// (`RevealField::Previous`, `CopyField::Previous`); the password itself crosses only through those.
#[derive(Serialize)]
pub struct PreviousView {
    pub index: u8,
    /// RFC 3339, UTC, whole seconds.
    pub replaced_at: String,
}

impl ItemDetail {
    pub fn of(item: &Item) -> ItemDetail {
        let (urls, has_password, has_value, previous) = match &item.kind {
            ItemKind::Login {
                urls,
                password,
                previous_passwords,
                ..
            } => {
                let previous = previous_passwords.iter().enumerate();
                let previous = previous.filter_map(|(at, old)| {
                    Some(PreviousView {
                        index: u8::try_from(at).ok()?,
                        replaced_at: old.replaced_at.clone(),
                    })
                });
                (
                    urls.clone(),
                    !password.is_empty(),
                    false,
                    previous.collect(),
                )
            }
            ItemKind::Key { value } => (Vec::new(), false, !value.is_empty(), Vec::new()),
            _ => (Vec::new(), false, false, Vec::new()),
        };
        ItemDetail {
            summary: ItemSummary::of(item),
            revision: item.revision,
            notes: item.notes.clone(),
            urls,
            has_password,
            has_value,
            previous,
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

/// One search result: the item as a list shows it, and when the match was in the name of one of its attached files, that
/// file as the item's details show it (its ID is what Open and Save a copy send back). `None` when the item matched in
/// its own fields. No path, key or text of the file.
#[derive(Serialize)]
pub struct SearchHitView {
    #[serde(flatten)]
    pub item: ItemSummary,
    pub matched_file: Option<FileView>,
}

impl SearchHitView {
    /// The hit for `item`, the file being the one named `matched_file` (the first when two share the name). A name the
    /// item no longer holds gives no file: the hit is then the item's own.
    pub fn of(item: &Item, matched_file: Option<&str>) -> SearchHitView {
        let file =
            matched_file.and_then(|name| item.attachments.iter().find(|file| file.name == name));
        SearchHitView {
            item: ItemSummary::of(item),
            matched_file: file.map(FileView::of),
        }
    }
}

/// What a search of every unlocked vault found: one tagged answer per vault searched, and the vaults that were busy
/// (a long change held them past the short wait), which the page names so the user can search again. A vault that
/// locked is in neither.
#[derive(Serialize)]
pub struct SearchResults {
    pub hits: Vec<Tagged<Vec<SearchHitView>>>,
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
            trashed_with: None,
            purging: false,
            retired_blobs: Vec::new(),
        }
    }

    fn login(urls: &[&str]) -> Item {
        item(ItemKind::Login {
            username: "ada".into(),
            password: secret("Pw-0123456789-xyz"),
            urls: urls.iter().map(|url| (*url).to_owned()).collect(),
            previous_passwords: Vec::new(),
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
            "collection": null, "trashed": false, "trashed_at": null, "trashed_with": null, "purging": false,
            "site": null,
            "created_at": "2026-10-29T00:00:00Z", "modified_at": "2026-10-29T00:00:00Z",
            "attachments": [],
        });
        assert_eq!(summary, expected);
        assert_eq!(
            detail,
            json!({
                "summary": expected, "revision": 1, "notes": "rotate monthly", "urls": [],
                "has_password": false, "has_value": true, "previous": [],
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

    /// A login's earlier passwords reach the page as a number and a date each, newest first, and as nothing else: not in
    /// the details, the summary or a list, whole or in part. A key, a note and the rest have none.
    #[test]
    fn earlier_passwords_cross_as_numbers_and_dates_only() {
        use lockbox_core::item::PreviousPassword;
        let old = |password: &str, at: &str| PreviousPassword {
            password: secret(password),
            replaced_at: at.into(),
        };
        let mut with_earlier = login(&["https://bank.example"]);
        if let ItemKind::Login {
            previous_passwords, ..
        } = &mut with_earlier.kind
        {
            *previous_passwords = vec![
                old("demo-old-one", "2026-11-09T10:00:00Z"),
                old("demo-old-two", "2026-03-12T08:00:00Z"),
            ];
        }
        let detail = serde_json::to_value(ItemDetail::of(&with_earlier)).unwrap();
        assert_eq!(
            detail["previous"],
            json!([
                { "index": 0, "replaced_at": "2026-11-09T10:00:00Z" },
                { "index": 1, "replaced_at": "2026-03-12T08:00:00Z" },
            ])
        );
        let summary = serde_json::to_value(ItemSummary::of(&with_earlier)).unwrap();
        let list = serde_json::to_value(ItemList::of([&with_earlier].into_iter(), &[])).unwrap();
        for view in [&detail, &summary, &list] {
            let text = view.to_string();
            for leaked in ["demo-old", "old-one", "old-two", "Pw-0123456789-xyz"] {
                assert!(!text.contains(leaked), "a view holds {leaked}: {text}");
            }
        }
        assert!(summary.get("previous").is_none() && list.to_string().find("previous").is_none());
        // One without any, and the other kinds, say so with an empty list.
        for item in [
            login(&[]),
            key(),
            item(ItemKind::Note),
            item(ItemKind::File),
        ] {
            let detail = serde_json::to_value(ItemDetail::of(&item)).unwrap();
            assert_eq!(detail["previous"], json!([]));
        }
    }

    /// What the Trash view reads of a trashed item: when it went there (the engine's own RFC 3339 text), the folder it
    /// went with (an ID, like `collection`), and whether it is being deleted for good (so the page leaves it out of the
    /// number a folder's restore brings back). A live item has the first two as null, present and not missing. Nothing
    /// else of the item crosses for it.
    #[test]
    fn trash_fields_cross_as_a_date_and_an_id() {
        let mut gone = item(ItemKind::Note);
        gone.notes = secret("demo-note-text");
        gone.collection = Some(ItemId([9; 16]));
        gone.trashed_at = Some("2026-11-08T10:00:00Z".into());
        gone.trashed_with = Some(ItemId([9; 16]));
        let summary = serde_json::to_value(ItemSummary::of(&gone)).unwrap();
        assert_eq!(summary["trashed"], json!(true));
        assert_eq!(summary["trashed_at"], json!("2026-11-08T10:00:00Z"));
        assert_eq!(summary["trashed_with"], json!("09".repeat(16)));
        assert_eq!(summary["purging"], json!(false));
        assert!(!summary.to_string().contains("demo-note"));

        gone.purging = true;
        let summary = serde_json::to_value(ItemSummary::of(&gone)).unwrap();
        assert_eq!(summary["purging"], json!(true));

        let live = serde_json::to_value(ItemSummary::of(&item(ItemKind::Note))).unwrap();
        let fields = live.as_object().unwrap();
        for name in ["trashed_at", "trashed_with"] {
            assert_eq!(fields.get(name), Some(&Value::Null), "{name}");
        }
        assert_eq!(fields["trashed"], json!(false));
    }

    /// A search hit is the summary's fields with the matched file beside them: `null` for an item's own match and for a
    /// file name the item does not hold (it changed since the index was read), never an error.
    #[test]
    fn a_hit_is_the_summary_and_the_file_that_matched() {
        let plain = serde_json::to_value(SearchHitView::of(&login(&[]), None)).unwrap();
        let mut expected = serde_json::to_value(ItemSummary::of(&login(&[]))).unwrap();
        expected["matched_file"] = Value::Null;
        assert_eq!(plain, expected);
        let gone = serde_json::to_value(SearchHitView::of(&login(&[]), Some("old.pdf"))).unwrap();
        assert_eq!(gone, expected);
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
