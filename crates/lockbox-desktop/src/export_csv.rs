//! The rows of a vault's readable export (design decision B): one CSV in the shape Bitwarden's importer reads (its
//! header, `type`, `folder`, quoted line breaks, UTF-8 with no byte-order mark; read at the source, the task's notes).
//! No I/O: the items go in and the bytes come out, in a buffer that is wiped when dropped.
//!
//! Fields follow RFC 4180: a field with a comma, a quote, a CR or an LF is quoted and its quotes are doubled; lines end
//! in CRLF, the last one included. A value that starts with `=`, `+`, `-` or `@` is written as it is (the design's
//! decision: a spreadsheet is not the reader this file is for).
//!
//! The text is made in two passes over the same code, the first only counting, so the buffer is allocated once at its
//! exact size: a buffer that grew would leave earlier, smaller copies of the vault's secrets behind, unwiped.
//!
//! Nothing here prints, logs or fails with text: the one error path is none at all (R5).

use lockbox_core::ids::ItemId;
use lockbox_core::item::{Item, ItemKind};
use zeroize::Zeroizing;

use crate::views::ExportSummary;

/// The header row, exactly Bitwarden's column names in its order.
pub const HEADER: &str = "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp";

/// The export's rows for `items` (every item of one vault, in the order given; trashed ones, ones being deleted, stored
/// files and folders are left out), as the file's bytes, and what the page may be told about them. `folder_title` is the
/// title of a live folder, or `None` for one that is not; a copy of it is plaintext too, so it is wiped as it drops.
pub fn rows<'a>(
    items: impl Iterator<Item = &'a Item>,
    folder_title: impl Fn(ItemId) -> Option<Zeroizing<String>>,
) -> (Zeroizing<Vec<u8>>, ExportSummary) {
    // Live items only, whatever their kind: the files on them are counted below.
    let live: Vec<&Item> = items
        .filter(|item| item.trashed_at.is_none() && !item.purging)
        .collect();
    let left_out_files = live
        .iter()
        .map(|item| item.attachments.len())
        .sum::<usize>();
    let mut summary = ExportSummary {
        items: 0,
        left_out_files: small(left_out_files),
        // Items the vault could not open are not among the ones given: the caller, which has the list, sets this.
        unreadable: 0,
        line_breaks: Vec::new(),
    };

    let mut size = Counter(0);
    write_all(&live, &folder_title, &mut size, Some(&mut summary));

    // Zeroizing wipes the final allocation: the buffer must never move, so it starts as big as it will be.
    let mut bytes = Zeroizing::new(Vec::with_capacity(size.0));
    write_all(&live, &folder_title, &mut bytes, None);
    (bytes, summary)
}

/// A count of anything for the page: saturates.
fn small(count: usize) -> u32 {
    u32::try_from(count).unwrap_or(u32::MAX)
}

/// Where the text goes: counted, or written.
trait Out {
    fn put(&mut self, bytes: &[u8]);
}

/// The size of the text, without making any.
struct Counter(usize);

impl Out for Counter {
    fn put(&mut self, bytes: &[u8]) {
        self.0 += bytes.len();
    }
}

impl Out for Zeroizing<Vec<u8>> {
    fn put(&mut self, bytes: &[u8]) {
        self.extend_from_slice(bytes);
    }
}

/// Writes whatever is put into it with every `"` doubled: the inside of a quoted field.
struct Doubling<'a, O: Out>(&'a mut O);

impl<O: Out> Out for Doubling<'_, O> {
    fn put(&mut self, bytes: &[u8]) {
        let mut rest = bytes;
        while let Some(at) = rest.iter().position(|&b| b == b'"') {
            self.0.put(&rest[..at]);
            self.0.put(b"\"\"");
            rest = &rest[at + 1..];
        }
        self.0.put(rest);
    }
}

fn write_all<O: Out>(
    live: &[&Item],
    folder_title: &impl Fn(ItemId) -> Option<Zeroizing<String>>,
    out: &mut O,
    mut summary: Option<&mut ExportSummary>,
) {
    out.put(HEADER.as_bytes());
    out.put(b"\r\n");
    for item in live {
        let row = match &item.kind {
            ItemKind::Login {
                username,
                password,
                urls,
                ..
            } => Row {
                kind: "login",
                uris: urls,
                username,
                secret: password,
            },
            ItemKind::Key { value } => Row {
                kind: "login",
                uris: &[],
                username: "",
                secret: value,
            },
            ItemKind::Note => Row {
                kind: "note",
                uris: &[],
                username: "",
                secret: "",
            },
            // Stored files and folders are not rows.
            ItemKind::File | ItemKind::Collection => continue,
        };
        if let Some(summary) = summary.as_deref_mut() {
            summary.items = summary.items.saturating_add(1);
            if has_line_break(row.secret) || has_line_break(&item.notes) {
                summary.line_breaks.push(item.title.clone());
            }
        }
        let folder = item.collection.and_then(folder_title).unwrap_or_default();
        // folder, favorite, type, name, notes, fields, reprompt, login_uri, login_username, login_password, login_totp
        field(out, &folder);
        out.put(b",");
        out.put(b",");
        field(out, row.kind);
        out.put(b",");
        field(out, &item.title);
        out.put(b",");
        field(out, &item.notes);
        out.put(b",");
        out.put(b",");
        out.put(b",");
        uri_field(out, row.uris);
        out.put(b",");
        field(out, row.username);
        out.put(b",");
        field(out, row.secret);
        out.put(b",");
        out.put(b"\r\n");
    }
}

/// What one row takes from its item's kind.
struct Row<'a> {
    kind: &'static str,
    uris: &'a [String],
    username: &'a str,
    /// A login's password, a key's value; empty for a note.
    secret: &'a str,
}

fn has_line_break(text: &str) -> bool {
    text.bytes().any(|b| b == b'\r' || b == b'\n')
}

/// Whether RFC 4180 has `text` quoted: a comma, a quote, a CR or an LF in it.
fn needs_quotes(text: &str) -> bool {
    text.bytes()
        .any(|b| matches!(b, b',' | b'"' | b'\r' | b'\n'))
}

/// One field as RFC 4180 writes it.
fn field<O: Out>(out: &mut O, text: &str) {
    if !needs_quotes(text) {
        out.put(text.as_bytes());
        return;
    }
    out.put(b"\"");
    Doubling(&mut *out).put(text.as_bytes());
    out.put(b"\"");
}

/// A login's websites: Bitwarden reads `login_uri` as one CSV row of its own (several sites, comma-separated, each
/// quoted by the same rules), so the sites are written as that inner row, which is then a field of the outer row like
/// any other: quoted again when it holds a comma, a quote, a CR or an LF.
fn uri_field<O: Out>(out: &mut O, urls: &[String]) {
    // The inner row has a comma whenever there are two sites, and a quote whenever a site needed one.
    let quoted = urls.len() > 1 || urls.iter().any(|url| needs_quotes(url));
    if quoted {
        out.put(b"\"");
        inner_row(&mut Doubling(&mut *out), urls);
        out.put(b"\"");
    } else {
        inner_row(out, urls);
    }
}

fn inner_row<O: Out>(out: &mut O, urls: &[String]) {
    for (at, url) in urls.iter().enumerate() {
        if at > 0 {
            out.put(b",");
        }
        field(out, url);
    }
}

/// The export's bytes while they wait to be written: wiped when dropped, whichever way the export ends. Tests count the
/// ones made and the ones alive on the thread ([`counted`]), to see that none waits while a dialog is open or after a
/// lock, and that every one is dropped.
pub struct Plaintext(Zeroizing<Vec<u8>>);

impl Plaintext {
    pub fn new(bytes: Zeroizing<Vec<u8>>) -> Plaintext {
        #[cfg(test)]
        {
            counted::MADE.with(|made| made.set(made.get() + 1));
            counted::ALIVE.with(|alive| alive.set(alive.get() + 1));
        }
        Plaintext(bytes)
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

#[cfg(test)]
impl Drop for Plaintext {
    fn drop(&mut self) {
        counted::ALIVE.with(|alive| alive.set(alive.get() - 1));
    }
}

/// Tests only: how many plaintext buffers ([`Plaintext`]) this thread has made, and how many are alive now.
#[cfg(test)]
pub(crate) mod counted {
    use std::cell::Cell;

    thread_local! {
        pub(super) static MADE: Cell<usize> = const { Cell::new(0) };
        pub(super) static ALIVE: Cell<usize> = const { Cell::new(0) };
    }

    /// The buffers made on this thread since it began.
    pub(crate) fn made() -> usize {
        MADE.with(Cell::get)
    }

    /// The buffers made on this thread and not yet dropped (and so not yet wiped).
    pub(crate) fn alive() -> usize {
        ALIVE.with(Cell::get)
    }
}
