//! What the page sees of items (spec §4.1). The engine's `Item` has no serde of its own; each view here is built
//! field by field from it and never holds a password (only whether there is one), a file key or a nonce. A password
//! crosses only through `reveal_password`. IDs are 32 lowercase hex characters. No `Debug`: titles, usernames, names
//! and notes are item content (R5).

use lockbox_core::ids::{FileId, ItemId};
use lockbox_core::item::{FileRef, Item, ItemKind};
use serde::Serialize;
use zeroize::Zeroizing;

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
    /// `"login"`, `"note"`, `"file"` or `"collection"`.
    pub kind: &'static str,
    pub title: String,
    /// A login's username; `None` for every other kind.
    pub username: Option<String>,
    /// The ID of the collection the item is in.
    pub collection: Option<String>,
    pub trashed: bool,
    pub attachments: Vec<FileView>,
}

impl ItemSummary {
    pub fn of(item: &Item) -> ItemSummary {
        let (kind, username) = match &item.kind {
            ItemKind::Login { username, .. } => ("login", Some(username.clone())),
            ItemKind::Note => ("note", None),
            ItemKind::File => ("file", None),
            ItemKind::Collection => ("collection", None),
        };
        ItemSummary {
            id: item.id.to_hex(),
            kind,
            title: item.title.clone(),
            username,
            collection: item.collection.as_ref().map(ItemId::to_hex),
            trashed: item.trashed_at.is_some(),
            attachments: item.attachments.iter().map(FileView::of).collect(),
        }
    }
}

/// One item opened: its summary, notes and links, and whether it has a password to reveal.
#[derive(Serialize)]
pub struct ItemDetail {
    pub summary: ItemSummary,
    /// Sent back with an edit: a change made meanwhile makes the edit stale.
    pub revision: u64,
    pub notes: Zeroizing<String>,
    pub urls: Vec<String>,
    pub has_password: bool,
}

impl ItemDetail {
    pub fn of(item: &Item) -> ItemDetail {
        let (urls, has_password) = match &item.kind {
            ItemKind::Login { urls, password, .. } => (urls.clone(), !password.is_empty()),
            _ => (Vec::new(), false),
        };
        ItemDetail {
            summary: ItemSummary::of(item),
            revision: item.revision,
            notes: item.notes.clone(),
            urls,
            has_password,
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
