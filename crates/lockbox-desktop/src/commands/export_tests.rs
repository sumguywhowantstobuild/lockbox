//! Task 2's tests: a vault exported to a readable CSV (`Shell::export_csv`, `export_repick`, the writer behind
//! `write_readable`, and `export_csv::rows`). Every value a test makes carries a plain marker (`MU-` or `MU_`: made
//! up), the typed password, stored values, titles, the file names and the paths of the files, so that a leak anywhere is
//! found by searching for the marker.
//!
//! The lock tests make a real lock win: the barrier hooks (`export_temp_written`, `export_before_publish`) run on the
//! thread that makes the export, at the named point, and call `Sessions::lock` there, so the vault really is locked
//! when the export goes on; what the export does next is what a lock that arrived at that instant gets.

use std::cell::{Cell, RefCell};
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use lockbox_core::blob::{CancelToken, NoProgress};
use lockbox_core::internals::fsio::failpoint;
use lockbox_core::internals::fsio::testutil::{make_dir_link, names};
use lockbox_core::item::{Item, ItemKind};
use lockbox_core::{CoreError, Credential, ReadOnlyVault, Vault};
use serde_json::{Value, json};
use tauri::ipc::InvokeBody;
use zeroize::Zeroizing;

use super::env::at;
use super::items::{NewKind, item_id};
use super::readable::{ConfirmArgs, ExportArgs, ReadableJob, ReadableKind};
use super::{MALFORMED, parse};
use crate::error::{Confirm, Outcome, ShellError, ShellResult};
use crate::export_csv::{self, HEADER, counted};
use crate::pending::{PendingChoice, Token};
use crate::restore::shown;
use crate::session::{Location, LockReason, OpenStep, Opened, SessionId, Tagged};
use crate::testing::{TEST_PASSWORD, TestShell, heavy};
use crate::views::SavedView;

const PW: &str = TEST_PASSWORD;
const VAULT: &str = "MU-vault";
const NAME: &str = "MU-out.csv";
/// What is at the destination before an export: sentinel bytes, to see them byte for byte after a refusal.
const OLD: &[u8] = b"MU-sentinel-the-earlier-file\r\nsecond line";
const WRONG: &str = "MU-typed-wrong-password";
const LOCKED: Option<ShellError> = Some(ShellError::Locked);
const NOT_FOUND: Option<ShellError> = Some(ShellError::NotFound);

type Saved = ShellResult<Tagged<Outcome<SavedView>>>;

fn secret(text: &str) -> Zeroizing<String> {
    Zeroizing::new(text.to_owned())
}

fn wrong_password() -> Option<ShellError> {
    Some(ShellError::from(CoreError::WrongPassword))
}

fn in_a_vault_folder() -> Option<ShellError> {
    Some(ShellError::from(CoreError::InvalidInput {
        what: "destination in a vault folder",
    }))
}

// ---- The values: every kind of item, and the hard ones

/// One item as the export should show it. `kind` is the CSV's `type` column.
#[derive(Clone)]
struct Want {
    folder: &'static str,
    kind: &'static str,
    name: String,
    notes: String,
    urls: Vec<String>,
    username: String,
    secret: String,
}

fn login(name: &str, folder: &'static str, username: &str, password: &str, notes: &str) -> Want {
    Want {
        folder,
        kind: "login",
        name: name.to_owned(),
        notes: notes.to_owned(),
        urls: Vec::new(),
        username: username.to_owned(),
        secret: password.to_owned(),
    }
}

fn with_urls(mut want: Want, urls: &[&str]) -> Want {
    want.urls = urls.iter().map(|url| (*url).to_owned()).collect();
    want
}

fn note(name: &str, folder: &'static str, text: &str) -> Want {
    Want {
        kind: "note",
        ..login(name, folder, "", "", text)
    }
}

/// A key: a `login` row with the key's name in `name` and its value in the password column.
fn key(name: &str, folder: &'static str, value: &str, notes: &str) -> Want {
    login(name, folder, "", value, notes)
}

const ONE: &str = "MU-folder-one";
const TWO: &str = "MU-folder-two, with \"quotes\"";

/// Logins, notes and keys, in folders and out of them, with commas, quotes, CR, LF, CRLF, each leading character a
/// spreadsheet treats as a formula, characters outside the Basic Multilingual Plane, and empty fields.
fn wants() -> Vec<Want> {
    vec![
        with_urls(
            login(
                "MU-login-plain",
                ONE,
                "MU-user-1",
                "MU-pw-plain-1",
                "MU-notes-1",
            ),
            &["https://MU-site-1.invalid/"],
        ),
        with_urls(
            login(
                "MU-login,comma \"quoted\"",
                ONE,
                "MU-user,comma",
                "MU-pw,comma\"quote",
                "MU-notes first\nMU-notes second",
            ),
            &[
                "https://MU-site-2.invalid/a,b",
                "https://MU-site-3.invalid/q?x=\"y\"",
                "https://MU-site-4.invalid/plain",
            ],
        ),
        login(
            "MU-login-crlf",
            TWO,
            "MU-user-crlf",
            "MU-pw-a\r\nMU-pw-b",
            "MU-notes-a\rMU-notes-b\r\nMU-notes-c",
        ),
        login("MU-title-crlf\r\nsecond line", "", "", "MU-pw-title", ""),
        // A CR on its own, with no LF anywhere in the field: only a quote keeps a reader from ending the line there.
        login(
            "MU-login-cr-only",
            "",
            "MU-user-cr\ronly",
            "MU-pw-a\rMU-pw-b",
            "MU-notes-cr\ronly",
        ),
        login("=MU-eq", ONE, "=MU-user-eq", "=MU-pw-eq", "=MU-notes-eq"),
        login(
            "+MU-plus",
            "",
            "+MU-user-plus",
            "+MU-pw-plus",
            "+MU-notes-plus",
        ),
        login(
            "-MU-minus",
            TWO,
            "-MU-user-minus",
            "-MU-pw-minus",
            "-MU-notes-minus",
        ),
        login("@MU-at", "", "@MU-user-at", "@MU-pw-at", "@MU-notes-at"),
        login(
            "MU-t\u{ed}tulo-\u{1F600}-\u{1D11E}",
            ONE,
            "MU-\u{7528}\u{6237}",
            "MU-pw-\u{1F600}\u{1D11E}",
            "MU-notes-\u{1F680}",
        ),
        login("MU-empty-login", "", "", "", ""),
        note(
            "MU-note-one",
            TWO,
            "MU-note text, with comma\nline 2\r\nline \"3\"",
        ),
        note("MU-note-unfiled", "", "MU-note-plain"),
        note("MU-note-empty", "", ""),
        note("=MU-note-eq", ONE, "@MU-note-at"),
        key("MU_KEY_ONE", ONE, "MU-key-value-1", "MU-key-notes"),
        key("MU_KEY_MULTI", "", "MU-k1\nMU-k2", ""),
        key("MU_KEY_PLAIN", TWO, "=MU-key-eq", ""),
        key("MU_KEY_EMPTY", "", "", ""),
    ]
}

/// Makes the items of `wants` in the session's vault, and the folders they are in; returns the folders' IDs by title.
fn fill(ts: &TestShell, s: SessionId, g: u64, wants: &[Want]) {
    let mut folders: Vec<(&str, String)> = Vec::new();
    for want in wants {
        if !want.folder.is_empty() && !folders.iter().any(|(title, _)| *title == want.folder) {
            let made = ts
                .shell
                .new_item(
                    s,
                    g,
                    NewKind::Collection,
                    want.folder.to_owned(),
                    None,
                    None,
                )
                .unwrap();
            folders.push((want.folder, made.data));
        }
        let folder = folders
            .iter()
            .find(|(title, _)| *title == want.folder)
            .map(|(_, id)| item_id(id).unwrap());
        put(ts, s, g, want, folder);
    }
}

fn put(
    ts: &TestShell,
    s: SessionId,
    g: u64,
    want: &Want,
    folder: Option<lockbox_core::ids::ItemId>,
) {
    let kind = match (want.kind, want.name.starts_with("MU_KEY")) {
        ("note", _) => ItemKind::Note,
        (_, true) => ItemKind::Key {
            value: secret(&want.secret),
        },
        _ => ItemKind::Login {
            username: want.username.clone(),
            password: secret(&want.secret),
            urls: want.urls.clone(),
            previous_passwords: Vec::new(),
        },
    };
    ts.shell
        .sessions
        .write(s, g, |vault, _| {
            vault.new_item_with_notes(kind, &want.name, folder, secret(&want.notes))?;
            Ok(())
        })
        .unwrap();
}

// ---- A strict RFC 4180 reader, made for these tests (no dependency)

/// Reads `bytes` as RFC 4180 and nothing looser: UTF-8, no byte-order mark, CRLF between records and after the last,
/// a quote only at the start of a field or doubled inside a quoted one, nothing after a closing quote but a comma or the
/// end of the record. The error says which rule was broken, never what was read.
fn strict(bytes: &[u8]) -> Result<Vec<Vec<String>>, &'static str> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Err("byte-order mark");
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "not UTF-8")?;
    #[derive(Clone, Copy, PartialEq)]
    enum State {
        Start,
        Plain,
        Quoted,
        Closed,
    }
    let (mut records, mut record, mut field) = (Vec::new(), Vec::new(), String::new());
    let mut state = State::Start;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match (state, c) {
            (State::Start, '"') => state = State::Quoted,
            (State::Start | State::Plain | State::Closed, ',') => {
                record.push(std::mem::take(&mut field));
                state = State::Start;
            }
            (State::Start | State::Plain | State::Closed, '\r') => {
                if chars.next() != Some('\n') {
                    return Err("a CR that is not CRLF");
                }
                record.push(std::mem::take(&mut field));
                records.push(std::mem::take(&mut record));
                state = State::Start;
            }
            (State::Start | State::Plain, '\n') => return Err("an LF that is not CRLF"),
            (State::Plain, '"') => return Err("a quote in an unquoted field"),
            (State::Start | State::Plain, c) => {
                field.push(c);
                state = State::Plain;
            }
            (State::Quoted, '"') => match chars.peek() {
                Some('"') => {
                    chars.next();
                    field.push('"');
                }
                _ => state = State::Closed,
            },
            (State::Quoted, c) => field.push(c),
            (State::Closed, _) => return Err("text after a closing quote"),
        }
    }
    match state {
        State::Quoted => Err("a quote never closed"),
        State::Start if field.is_empty() && record.is_empty() => Ok(records),
        _ => Err("no CRLF after the last record"),
    }
}

#[test]
fn the_strict_reader_refuses_what_rfc_4180_does_not_allow() {
    let bad: &[(&[u8], &str)] = &[
        (b"a,b\nc,d\r\n", "an LF that is not CRLF"),
        (b"a,b\rc,d\r\n", "a CR that is not CRLF"),
        (b"a,b\r\nc,d", "no CRLF after the last record"),
        (b"a,b\"c\r\n", "a quote in an unquoted field"),
        (b"\"a\"b,c\r\n", "text after a closing quote"),
        (b"\"a,b\r\n", "a quote never closed"),
        (b"\xEF\xBB\xBFa,b\r\n", "byte-order mark"),
        (b"a,\xFF\r\n", "not UTF-8"),
    ];
    let mut refused = 0;
    for (input, rule) in bad {
        assert_eq!(strict(input).err(), Some(*rule));
        refused += 1;
    }
    assert_eq!(refused, bad.len());
    let good = strict(b"a,\"b,\"\"c\"\"\r\nd\",\r\n,\"\r\n\"\r\n").unwrap();
    assert_eq!(
        good,
        [
            vec!["a".to_owned(), "b,\"c\"\r\nd".to_owned(), String::new()],
            vec![String::new(), "\r\n".to_owned()],
        ]
    );
}

// ---- Rows, read from the vault as the writer reads them

/// The items of the session's vault, as copies.
fn items_of(ts: &TestShell, s: SessionId, g: u64) -> Vec<Item> {
    ts.shell
        .sessions
        .read(s, g, |vault, _| match vault {
            crate::session::VaultRef::Writable(vault) => Ok(vault.items().cloned().collect()),
            crate::session::VaultRef::ReadOnly(_) => Err(ShellError::ReadOnly),
        })
        .unwrap()
        .data
}

/// `rows` over copies of the vault's items, with the folder titles looked up among them (a live folder only).
fn rows_of(items: &[Item]) -> (Zeroizing<Vec<u8>>, crate::views::ExportSummary) {
    export_csv::rows(items.iter(), |id| {
        items
            .iter()
            .find(|f| {
                f.id == id && matches!(f.kind, ItemKind::Collection) && f.trashed_at.is_none()
            })
            .map(|f| Zeroizing::new(f.title.clone()))
    })
}

/// A parsed CSV: the header and the rows, every row 11 wide.
fn parsed(bytes: &[u8]) -> (Vec<String>, Vec<Vec<String>>) {
    let mut records = strict(bytes).expect("the file is RFC 4180");
    assert!(!records.is_empty(), "no header");
    let header = records.remove(0);
    for row in &records {
        assert_eq!(row.len(), header.len(), "a row's width is the header's");
    }
    (header, records)
}

#[test]
fn csv_header_is_bitwardens() {
    let (bytes, summary) = export_csv::rows(std::iter::empty(), |_| None);
    let expected = "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\r\n";
    assert_eq!(bytes.as_slice(), expected.as_bytes());
    assert_eq!(HEADER, expected.trim_end());
    assert_eq!(
        (
            summary.items,
            summary.left_out_files,
            summary.line_breaks.len()
        ),
        (0, 0, 0)
    );
    let (header, rows) = parsed(&bytes);
    assert_eq!(header.len(), 11);
    assert!(rows.is_empty());
    assert!(
        !bytes.starts_with(&[0xEF, 0xBB, 0xBF]),
        "no byte-order mark"
    );

    // And the same header on a real export, ahead of the rows, with the exact capacity the text needs (a buffer that
    // grew would leave unwiped copies behind).
    let ts = TestShell::new();
    let (s, g) = ts.open_vault(VAULT);
    fill(&ts, s, g, &wants());
    let items = items_of(&ts, s, g);
    let (bytes, _) = rows_of(&items);
    assert!(bytes.starts_with(expected.as_bytes()));
    assert!(bytes.ends_with(b"\r\n"));
    assert_eq!(bytes.capacity(), bytes.len(), "made at its exact size");
}

#[test]
fn csv_round_trips_every_value_through_a_strict_reader() {
    let ts = TestShell::new();
    let (s, g) = ts.open_vault(VAULT);
    let wants = wants();
    fill(&ts, s, g, &wants);
    let items = items_of(&ts, s, g);
    let (bytes, summary) = rows_of(&items);
    let (header, rows) = parsed(&bytes);
    assert_eq!(
        header,
        HEADER.split(',').map(str::to_owned).collect::<Vec<_>>()
    );
    assert_eq!(
        rows.len(),
        wants.len(),
        "one row for each item, and no other"
    );
    assert_eq!(summary.items as usize, wants.len());

    let mut checked = 0;
    for want in &wants {
        let found: Vec<&Vec<String>> = rows.iter().filter(|row| row[3] == want.name).collect();
        assert_eq!(found.len(), 1, "exactly one row is named {:?}", want.name);
        let row = found[0];
        assert_eq!(row[0], want.folder, "folder of {:?}", want.name);
        assert_eq!(row[1], "", "favorite");
        assert_eq!(row[2], want.kind, "type of {:?}", want.name);
        assert_eq!(row[4], want.notes, "notes of {:?}", want.name);
        assert_eq!(row[5], "", "fields");
        assert_eq!(row[6], "", "reprompt");
        // The websites are one CSV row of their own, read back by the same strict reader.
        let sites = match row[7].is_empty() {
            true => Vec::new(),
            false => {
                let mut inner = strict(format!("{}\r\n", row[7]).as_bytes()).expect("inner row");
                assert_eq!(inner.len(), 1);
                inner.remove(0)
            }
        };
        assert_eq!(sites, want.urls, "login_uri of {:?}", want.name);
        assert_eq!(row[8], want.username, "login_username of {:?}", want.name);
        assert_eq!(row[9], want.secret, "login_password of {:?}", want.name);
        assert_eq!(row[10], "", "login_totp");
        checked += 1;
    }
    assert_eq!(checked, wants.len());
    // A value that starts with a formula character is written as it is.
    for lead in ["=MU-eq", "+MU-plus", "-MU-minus", "@MU-at"] {
        assert!(
            String::from_utf8_lossy(&bytes).contains(&format!(",{lead},")),
            "{lead} is not written unchanged"
        );
    }
    // The vault's own values are as they were.
    assert_eq!(items.len(), items_of(&ts, s, g).len());
}

#[test]
fn csv_leaves_out_trash_earlier_passwords_and_files() {
    let ts = TestShell::new();
    let (s, g) = ts.open_vault(VAULT);
    let live = [
        login("MU-live-login", "", "", "MU-new-pw-1", ""),
        login("MU-live-login-two", "", "", "MU-pw-two", ""),
        note("MU-live-note", "", "MU-live-note-text"),
    ];
    for want in &live {
        put(&ts, s, g, want, None);
    }
    let id_of = |ts: &TestShell, name: &str| -> lockbox_core::ids::ItemId {
        items_of(ts, s, g)
            .into_iter()
            .find(|item| item.title == name)
            .unwrap()
            .id
    };
    // An earlier password: the engine moves the old one aside when the password changes.
    ts.shell
        .sessions
        .write(s, g, |vault, _| {
            let id = id_of_in(vault, "MU-live-login");
            let mut next = vault.get_item(&id)?.clone();
            next.kind = ItemKind::Login {
                username: String::new(),
                password: secret("MU-changed-pw"),
                urls: Vec::new(),
                previous_passwords: Vec::new(),
            };
            vault.update_item(next)?;
            let mut again = vault.get_item(&id)?.clone();
            again.kind = ItemKind::Login {
                username: String::new(),
                password: secret("MU-new-pw-1"),
                urls: Vec::new(),
                previous_passwords: Vec::new(),
            };
            vault.update_item(again)?;
            Ok(())
        })
        .unwrap();
    // Trash: a login and a note with a file on it; none of it is a row, and its file is not counted.
    for (name, kind) in [("MU-trashed-login", "login"), ("MU-trashed-note", "note")] {
        let want = match kind {
            "note" => note(name, "", "MU-trashed-text"),
            _ => login(
                name,
                "",
                "MU-trashed-user",
                "MU-trashed-pw",
                "MU-trashed-notes",
            ),
        };
        put(&ts, s, g, &want, None);
        let id = id_of(&ts, name);
        let source = ts.temp.path().join("MU-trashed-attachment.txt");
        fs::write(&source, b"MU-trashed-file-bytes").unwrap();
        ts.shell
            .sessions
            .write(s, g, |vault, cancel| {
                vault.attach_file(&id, &source, cancel, &NoProgress)?;
                Ok(())
            })
            .unwrap();
        ts.shell.trash_item(s, g, &id.to_hex()).unwrap();
    }
    // Files: a file item, and a file attached to a live login.
    ts.stored_file(s, g, "MU-stored.txt", b"MU-stored-file-bytes");
    let target = id_of(&ts, "MU-live-login-two");
    let source = ts.temp.path().join("MU-attached.txt");
    fs::write(&source, b"MU-attached-file-bytes").unwrap();
    ts.shell
        .sessions
        .write(s, g, |vault, cancel| {
            vault.attach_file(&target, &source, cancel, &NoProgress)?;
            Ok(())
        })
        .unwrap();

    let items = items_of(&ts, s, g);
    assert!(
        items.iter().any(|item| item.trashed_at.is_some()),
        "the trash has items"
    );
    assert!(
        items.iter().any(|item| matches!(&item.kind,
            ItemKind::Login { previous_passwords, .. } if !previous_passwords.is_empty())),
        "a login has an earlier password"
    );
    let (bytes, summary) = rows_of(&items);
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    for gone in [
        "MU-trashed",
        "MU-changed-pw",
        "MU-stored",
        "MU-attached",
        "MU-trashed-file-bytes",
    ] {
        assert!(!text.contains(gone), "{gone} is in the export");
    }
    let (_, rows) = parsed(&bytes);
    let mut named: Vec<&str> = rows.iter().map(|row| row[3].as_str()).collect();
    named.sort_unstable();
    assert_eq!(
        named,
        ["MU-live-login", "MU-live-login-two", "MU-live-note"]
    );
    assert!(text.contains("MU-new-pw-1") && text.contains("MU-pw-two"));
    assert_eq!(summary.items, 3);
    assert_eq!(
        summary.left_out_files, 2,
        "the file item's file and the login's attachment; not the trashed items' files"
    );

    // An item being deleted for good is left out, with its files.
    let mut items = items;
    let deleted = items
        .iter_mut()
        .find(|item| item.title == "MU-live-login-two")
        .unwrap();
    deleted.purging = true;
    let (bytes, summary) = rows_of(&items);
    assert!(!String::from_utf8_lossy(&bytes).contains("MU-pw-two"));
    assert_eq!((summary.items, summary.left_out_files), (2, 1));

    // A folder is not a row, and a login in a folder that is in the trash shows no folder.
    let folder = ts
        .shell
        .new_item(
            s,
            g,
            NewKind::Collection,
            "MU-gone-folder".to_owned(),
            None,
            None,
        )
        .unwrap()
        .data;
    let folder_id = item_id(&folder).unwrap();
    put(
        &ts,
        s,
        g,
        &login("MU-in-gone", "", "", "MU-pw-in-gone", ""),
        Some(folder_id),
    );
    let mut items = items_of(&ts, s, g);
    items
        .iter_mut()
        .find(|item| item.id == folder_id)
        .unwrap()
        .trashed_at = Some("2026-01-01T00:00:00Z".to_owned());
    let (bytes, _) = rows_of(&items);
    let (_, rows) = parsed(&bytes);
    let row = rows.iter().find(|row| row[3] == "MU-in-gone").unwrap();
    assert_eq!(row[0], "", "a folder in the trash is not shown");
    assert!(rows.iter().all(|row| row[3] != "MU-gone-folder"));
}

fn id_of_in(vault: &Vault, name: &str) -> lockbox_core::ids::ItemId {
    vault.items().find(|item| item.title == name).unwrap().id
}

#[test]
fn items_with_line_breaks_are_named() {
    let ts = TestShell::new();
    let (s, g) = ts.open_vault(VAULT);
    let breaking = [
        login("MU-lb-cr-pw", "", "", "MU-a\rMU-b", ""),
        login("MU-lb-lf-notes", ONE, "", "MU-pw", "MU-a\nMU-b"),
        login("MU-lb-crlf-pw", "", "", "MU-a\r\nMU-b", ""),
        key("MU_KEY_LB", "", "MU-a\nMU-b", ""),
        note("MU-lb-crlf-note", "", "MU-a\r\nMU-b"),
    ];
    let quiet = [
        login(
            "MU-quiet-comma",
            "",
            "MU-user\nMU-name",
            "MU-pw,with,commas",
            "MU-n,\"q\"",
        ),
        note("MU-quiet-note", "", "MU-single line"),
        key("MU_KEY_QUIET", "", "MU-value", ""),
    ];
    let all: Vec<Want> = breaking.iter().chain(&quiet).cloned().collect();
    fill(&ts, s, g, &all);
    // A line break in something in the trash is not named.
    put(
        &ts,
        s,
        g,
        &login("MU-lb-trashed", "", "", "MU-a\nMU-b", ""),
        None,
    );
    let trashed = items_of(&ts, s, g)
        .into_iter()
        .find(|item| item.title == "MU-lb-trashed")
        .unwrap()
        .id;
    ts.shell.trash_item(s, g, &trashed.to_hex()).unwrap();

    let before = values_of(&items_of(&ts, s, g));
    let items = items_of(&ts, s, g);
    let (bytes, summary) = rows_of(&items);
    let (_, rows) = parsed(&bytes);
    // In row order.
    let expected: Vec<String> = rows
        .iter()
        .filter(|row| {
            [&row[4], &row[9]]
                .iter()
                .any(|v| v.contains('\r') || v.contains('\n'))
        })
        .map(|row| row[3].clone())
        .collect();
    assert_eq!(summary.line_breaks, expected);
    let mut sorted = summary.line_breaks.clone();
    sorted.sort();
    let mut want: Vec<String> = breaking.iter().map(|w| w.name.clone()).collect();
    want.sort();
    assert_eq!(
        sorted, want,
        "exactly the items whose password, key value or notes break"
    );
    assert_eq!(
        values_of(&items_of(&ts, s, g)),
        before,
        "the vault's values are unchanged"
    );
}

/// Every item's content, sorted, to compare the vault before and after.
fn values_of(items: &[Item]) -> Vec<(String, String, String, String)> {
    let mut all: Vec<_> = items
        .iter()
        .map(|item| {
            let secret = match &item.kind {
                ItemKind::Login { password, .. } => password.to_string(),
                ItemKind::Key { value } => value.to_string(),
                _ => String::new(),
            };
            (
                item.title.clone(),
                item.notes.to_string(),
                secret,
                item.revision.to_string(),
            )
        })
        .collect();
    all.sort();
    all
}

// ---- The command: the password, the session and the destination

/// A vault with `wants()`, and a `Documents` folder holding the earlier file.
struct World {
    ts: TestShell,
    s: SessionId,
    g: u64,
    docs: PathBuf,
    dest: PathBuf,
}

impl World {
    fn new() -> World {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault(VAULT);
        fill(&ts, s, g, &wants());
        let docs = ts.folder("Documents");
        let dest = docs.join(NAME);
        fs::write(&dest, OLD).unwrap();
        World {
            ts,
            s,
            g,
            docs,
            dest,
        }
    }

    fn export(&self) -> Saved {
        self.export_as(self.s, self.g, PW)
    }

    fn export_as(&self, s: SessionId, g: u64, password: &str) -> Saved {
        heavy(|| self.ts.shell.export_csv(s, g, secret(password)))
    }

    /// The dialog will answer the destination.
    fn pick(&self) {
        self.ts.dialogs.answer(Some(self.dest.clone()));
    }

    fn lock(&self) {
        self.ts.shell.sessions.lock(self.s, LockReason::Manual);
    }

    /// Only the destination is in its folder, as it was, and nothing is in the journal.
    fn untouched(&self) {
        assert_eq!(fs::read(&self.dest).unwrap(), OLD);
        assert_eq!(names(&self.docs), [NAME]);
        assert_eq!(self.ts.journal(), Vec::<PathBuf>::new());
    }

    fn shown(&self) -> String {
        self.docs
            .to_str()
            .unwrap()
            .trim_start_matches(r"\\?\")
            .to_owned()
    }
}

/// A failure for a test to make happen at one step of an export.
type Inject = Box<dyn Fn(&World)>;

/// The folder and summary of a finished export.
fn finished(answer: Saved) -> SavedView {
    match answer {
        Ok(Tagged {
            data: Outcome::Done(view),
            ..
        }) => view,
        Ok(_) => panic!("a question or a closed dialog, not a save"),
        Err(error) => panic!("refused: {error:?}"),
    }
}

fn cloud_token(answer: Saved) -> Token {
    match answer {
        Ok(Tagged {
            data: Outcome::Confirm(Confirm::CloudFolder { token, .. }),
            ..
        }) => token,
        Ok(_) => panic!("not the cloud question"),
        Err(error) => panic!("refused: {error:?}"),
    }
}

fn made_up_token() -> Token {
    serde_json::from_value(Value::String("0123456789abcdef".repeat(2))).unwrap()
}

/// Every file inside `dir`, with its bytes, for the before and after of a refusal.
fn snapshot(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut found = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(next) = stack.pop() {
        for entry in fs::read_dir(&next).unwrap().flatten() {
            let path = entry.path();
            match entry.file_type().unwrap().is_dir() {
                true => stack.push(path),
                // The vault's lock file is held open by the running vault and cannot be read: its name stands for it.
                false => found.push((
                    path.clone(),
                    fs::read(&path).unwrap_or_else(|_| b"<held open>".to_vec()),
                )),
            }
        }
    }
    found.sort();
    found
}

#[test]
fn export_refused_with_a_wrong_password_writes_nothing() {
    let w = World::new();
    w.pick();
    let before = snapshot(w.ts.temp.path());
    let mut refused = 0;
    for wrong in [WRONG, "correct horse batter", "CORRECT HORSE BATTERY"] {
        assert_eq!(
            w.export_as(w.s, w.g, wrong).err(),
            wrong_password(),
            "{wrong}"
        );
        refused += 1;
    }
    // An empty password is the engine's own refusal of an empty one, which no password check gets past.
    assert_eq!(
        w.export_as(w.s, w.g, "").err(),
        Some(ShellError::from(CoreError::InvalidInput {
            what: "password is empty"
        }))
    );
    refused += 1;
    assert_eq!(refused, 4);
    assert_eq!(w.ts.dialogs.opened(), 0, "no dialog opened");
    assert_eq!(counted::made(), 0);
    assert_eq!(
        snapshot(w.ts.temp.path()),
        before,
        "no file, and the vault's folder as it was"
    );
    assert!(!w.ts.shell.paths.outputs.exists(), "no journal");
    w.untouched();
    // The session is as it was: the right password goes on.
    assert!(matches!(w.export().unwrap().data, Outcome::Done(_)));
}

#[test]
fn another_vaults_password_is_refused() {
    let w = World::new();
    let other_password = "MU-another-vault-password";
    let created = heavy(|| {
        w.ts.shell
            .create_vault("MU-other-vault".into(), secret(other_password), false)
    });
    let Ok(Outcome::Done(other)) = created else {
        panic!("the second vault did not open");
    };
    // The picker would answer if it were opened: it is not.
    w.pick();
    assert_eq!(
        w.export_as(w.s, w.g, other_password).err(),
        wrong_password(),
        "the other vault's password"
    );
    assert_eq!(
        w.export_as(other.session, other.generation, PW).err(),
        wrong_password(),
        "this vault's password, for the other"
    );
    assert_eq!(w.ts.dialogs.opened(), 0, "no dialog");
    assert!(counted::made() == 0);
    w.untouched();
    // Each vault's own password is the one that counts: the dialog opens, and takes the answer queued first.
    let opened = w.export_as(other.session, other.generation, other_password);
    assert!(matches!(opened.unwrap().data, Outcome::Done(_)));
    assert_eq!(w.ts.dialogs.opened(), 1);
    assert_eq!(
        parsed(&fs::read(&w.dest).unwrap()).1.len(),
        0,
        "the other vault has no items"
    );
}

/// The same rule as 4C's change of password and new recovery key (`check_password`'s): a vault opened with its recovery
/// key has the new password the person set in that recovery, and the old one no longer counts.
#[test]
fn export_after_a_recovery_key_unlock_follows_4cs_password_rule() {
    let ts = TestShell::new();
    let created = heavy(|| Vault::create(&ts.vaults(), "MU-recovered", PW)).unwrap();
    let dir = fs::canonicalize(created.vault.dir()).unwrap();
    let recovery = created.recovery.to_display();
    drop(created);
    let id = ts.shell.registry.add(&dir).unwrap().id;
    let new_password = "MU-password-set-in-the-recovery";
    let checked = ts
        .shell
        .recover_check(ts.vault(id), secret(&recovery))
        .unwrap();
    let opened = heavy(|| {
        ts.shell
            .recover_finish(&checked.choice, secret(new_password), true)
    });
    let Ok(Outcome::Done(session)) = opened else {
        panic!("the recovery did not open the vault");
    };
    let (s, g) = (session.session, session.generation);
    let docs = ts.folder("Documents");
    let dest = docs.join(NAME);

    ts.dialogs.answer(Some(dest.clone()));
    let old = heavy(|| ts.shell.export_csv(s, g, secret(PW)));
    assert_eq!(
        old.err(),
        wrong_password(),
        "the password from before the recovery"
    );
    assert_eq!(ts.dialogs.opened(), 0);
    let recovery_words = heavy(|| ts.shell.export_csv(s, g, secret(&recovery)));
    assert_eq!(
        recovery_words.err(),
        wrong_password(),
        "the recovery key is not a password"
    );
    let new = heavy(|| ts.shell.export_csv(s, g, secret(new_password)));
    assert!(finished(new).export.is_some());
    assert!(dest.is_file());
}

/// A read-only session over the vault listed first: a backup or an older copy opens like this.
fn read_only_session(ts: &TestShell) -> (SessionId, u64) {
    let dir = ts.shell.registry.entries()[0].1.clone();
    ts.shell.sessions.lock_all(LockReason::Manual);
    let vault = heavy(|| {
        ReadOnlyVault::open_folder(
            &dir,
            Credential::Password(TEST_PASSWORD),
            &CancelToken::new(),
            &NoProgress,
        )
    })
    .unwrap();
    let location = Location::folder(&dir).unwrap();
    let opened = ts.shell.sessions.open(Some(location.clone()), None, |_| {
        Ok(OpenStep::Session(location, Opened::ReadOnly(vault), ()))
    });
    let Ok(Outcome::Done(tagged)) = opened else {
        panic!("the read-only session did not open");
    };
    (tagged.session, tagged.generation)
}

#[test]
fn export_refused_on_a_read_only_session() {
    let w = World::new();
    w.pick();
    let (r, gr) = read_only_session(&w.ts);
    assert_eq!(
        w.export_as(r, gr, PW).err(),
        Some(ShellError::ReadOnly),
        "refused before the password is looked at"
    );
    assert_eq!(
        w.export_as(r, gr, WRONG).err(),
        Some(ShellError::ReadOnly),
        "a wrong password does not change the refusal"
    );
    assert_eq!(w.ts.dialogs.opened(), 0);
    assert_eq!(counted::made(), 0);
    w.untouched();
}

#[test]
fn export_refused_with_a_stale_generation() {
    let w = World::new();
    w.pick();
    assert_eq!(w.export_as(w.s, w.g + 1, PW).err(), LOCKED);
    assert_eq!(w.export_as(w.s, w.g.wrapping_sub(1), PW).err(), LOCKED);
    w.lock();
    assert_eq!(w.export_as(w.s, w.g, PW).err(), LOCKED, "a locked session");
    assert_eq!(w.ts.dialogs.opened(), 0);
    assert_eq!(counted::made(), 0);
    w.untouched();
}

#[test]
fn export_refused_a_foreign_session() {
    let w = World::new();
    w.pick();
    assert_eq!(
        w.export_as(SessionId(w.s.0 + 100), w.g, PW).err(),
        NOT_FOUND
    );
    assert_eq!(w.ts.dialogs.opened(), 0);
    w.untouched();
}

#[test]
fn export_refused_in_a_vault_folder() {
    let w = World::new();
    let vault = w.ts.shell.registry.entries()[0].1.clone();
    let before = names(&vault);
    for dest in [vault.join(NAME), vault.join("files").join(NAME)] {
        w.ts.dialogs.answer(Some(dest));
        assert_eq!(w.export().err(), in_a_vault_folder());
    }
    assert_eq!(
        names(&vault),
        before,
        "nothing was written in the vault's folder"
    );
    assert_eq!(counted::made(), 0);
    assert!(!w.ts.shell.paths.outputs.exists(), "no journal change");
}

#[test]
fn export_refused_in_the_state_folder() {
    let w = World::new();
    fs::create_dir_all(&w.ts.shell.paths.root).unwrap();
    let before = names(&w.ts.shell.paths.root);
    w.ts.dialogs.answer(Some(w.ts.shell.paths.root.join(NAME)));
    assert_eq!(
        w.export().err(),
        Some(ShellError::InvalidInput {
            what: "state folder"
        })
    );
    assert_eq!(names(&w.ts.shell.paths.root), before);
    assert_eq!(counted::made(), 0);
}

/// A junction to a vault's folder, and the `\\?\` spelling of the folder, are the vault's folder.
#[test]
fn export_refused_through_a_folder_alias() {
    let w = World::new();
    let vault = w.ts.shell.registry.entries()[0].1.clone();
    let before = names(&vault);
    let link = w.ts.folder("Aliases").join("MU-link");
    make_dir_link(&link, &vault);
    let verbatim = PathBuf::from(format!(
        r"\\?\{}",
        vault.to_str().unwrap().trim_start_matches(r"\\?\")
    ));
    let mut tried = 0;
    for dest in [
        link.join(NAME),
        link.join("files").join(NAME),
        verbatim.join(NAME),
    ] {
        w.ts.dialogs.answer(Some(dest));
        assert_eq!(w.export().err(), in_a_vault_folder());
        tried += 1;
    }
    assert_eq!(tried, 3);
    assert_eq!(names(&vault), before);
    assert_eq!(counted::made(), 0);
}

// ---- The cloud question

#[test]
fn export_in_a_cloud_folder_asks_first() {
    let w = World::new();
    w.ts.volumes.add_sync_root(&w.docs);
    let (b, gb) = w.ts.open_vault("MU-second");
    put(
        &w.ts,
        b,
        gb,
        &login("MU-second-login", "", "", "MU-second-pw", ""),
        None,
    );

    w.pick();
    let token = cloud_token(w.export());
    assert_eq!(counted::made(), 0, "nothing is built until the yes");
    assert_eq!(counted::alive(), 0);
    w.untouched();
    assert_eq!(w.ts.dialogs.opened(), 1);

    // A token never given, and one that is another kind of question's, write nothing.
    assert_eq!(
        w.ts.shell.save_readable_confirm(&made_up_token()).err(),
        NOT_FOUND
    );
    assert_eq!(counted::made(), 0);

    // The second vault's own question, parked beside the first.
    w.ts.dialogs.answer(Some(w.dest.clone()));
    let second = cloud_token(w.export_as(b, gb, PW));

    // The first vault locks: its token writes nothing and is used up, while the second vault's still works.
    w.lock();
    assert_eq!(w.ts.shell.save_readable_confirm(&token).err(), LOCKED);
    assert_eq!(counted::made(), 0);
    w.untouched();
    assert_eq!(
        w.ts.shell.save_readable_confirm(&token).err(),
        NOT_FOUND,
        "used up"
    );

    let view = finished(w.ts.shell.save_readable_confirm(&second));
    assert_eq!(counted::made(), 1);
    assert_eq!(counted::alive(), 0);
    let summary = view.export.expect("an export's counts");
    assert_eq!(summary.items, 1);
    let text = fs::read(&w.dest).unwrap();
    let (_, rows) = parsed(&text);
    assert_eq!(rows.len(), 1);
    assert!(
        !String::from_utf8_lossy(&text).contains("MU-login-plain"),
        "only the vault that was asked for"
    );
    assert_eq!(
        w.ts.shell.save_readable_confirm(&second).err(),
        NOT_FOUND,
        "a token replayed"
    );
    assert_eq!(w.ts.dialogs.opened(), 2, "no dialog for a yes");
}

/// A yes on the first vault's own question writes its whole CSV.
#[test]
fn the_yes_to_the_cloud_question_writes_the_vault() {
    let w = World::new();
    w.ts.volumes.add_sync_root(&w.docs);
    w.pick();
    let token = cloud_token(w.export());
    let view = finished(w.ts.shell.save_readable_confirm(&token));
    assert_eq!(view.folder, w.shown());
    let (_, rows) = parsed(&fs::read(&w.dest).unwrap());
    assert_eq!(rows.len(), wants().len());
    assert_eq!(names(&w.docs), [NAME]);
    assert_eq!(w.ts.journal(), Vec::<PathBuf>::new());
}

#[test]
fn pick_another_folder_leaves_the_first_destination_untouched() {
    let w = World::new();
    w.ts.volumes.add_sync_root(&w.docs);
    let elsewhere = w.ts.folder("Elsewhere");
    let second = elsewhere.join("MU-second.csv");
    w.pick();
    let token = cloud_token(w.export());

    // The checks run again on the new answer: a vault's folder is refused, and the token is used up by it.
    let vault = w.ts.shell.registry.entries()[0].1.clone();
    w.ts.dialogs.answer(Some(vault.join(NAME)));
    assert_eq!(w.ts.shell.export_repick(&token).err(), in_a_vault_folder());
    assert_eq!(w.ts.shell.export_repick(&token).err(), NOT_FOUND);
    assert_eq!(w.ts.dialogs.opened(), 2, "the new dialog opened once");
    w.untouched();

    // A second cloud question, and a closed dialog.
    w.pick();
    let token = cloud_token(w.export());
    w.ts.dialogs.answer(Some(w.docs.join("MU-again.csv")));
    let again = cloud_token(w.ts.shell.export_repick(&token));
    assert_eq!(counted::made(), 0, "still nothing built");
    w.ts.dialogs.answer(None);
    assert!(matches!(
        w.ts.shell.export_repick(&again).unwrap().data,
        Outcome::Dismissed
    ));
    w.untouched();

    // A folder that is not a cloud folder: written there, and the first destination is as it was.
    w.pick();
    let token = cloud_token(w.export());
    w.ts.dialogs.answer(Some(second.clone()));
    let view = finished(w.ts.shell.export_repick(&token));
    assert_eq!(
        view.folder,
        elsewhere.to_str().unwrap().trim_start_matches(r"\\?\")
    );
    assert!(second.is_file());
    assert_eq!(parsed(&fs::read(&second).unwrap()).1.len(), wants().len());
    // The handle of the repick's answer opens the folder that was written to, and never the cloud folder declined.
    w.ts.shell
        .show_output_in_explorer(&handle_of(&view))
        .unwrap();
    let opened = w.ts.launcher.opened_folders();
    assert_eq!(opened.len(), 1);
    assert_eq!(shown(&opened[0]), shown(&elsewhere));
    assert_ne!(shown(&opened[0]), w.shown(), "not the declined folder");
    w.untouched();
    assert_eq!(counted::made(), 1);
    assert_eq!(counted::alive(), 0);

    // Another kind of question's token is no good here: refused, and used up.
    let pdf = w.ts.shell.sessions.pending().put(PendingChoice::Readable {
        session: w.s,
        generation: w.g,
        job: ReadableJob::recovery_pdf(),
        dest: w.dest.clone(),
    });
    w.ts.dialogs.answer(Some(second.clone()));
    assert_eq!(w.ts.shell.export_repick(&pdf).err(), NOT_FOUND);
    assert_eq!(
        w.ts.shell.sessions.pending().len(),
        1,
        "used up: only the handle of the export that was written is left"
    );
    assert_eq!(w.ts.shell.export_repick(&made_up_token()).err(), NOT_FOUND);
}

#[test]
fn a_lock_while_the_picker_is_open_writes_nothing_and_holds_no_plaintext() {
    let w = World::new();
    // In the picker. The dialog runs on this thread, so the count of live buffers is the export's own.
    let (seen, shell) = (
        Arc::new(AtomicUsize::new(usize::MAX)),
        Arc::clone(&w.ts.shell),
    );
    let in_dialog = Arc::clone(&seen);
    let s = w.s;
    w.ts.dialogs.during_next_dialog(Box::new(move || {
        in_dialog.store(counted::alive(), Ordering::SeqCst);
        shell.sessions.lock(s, LockReason::Manual);
    }));
    w.pick();
    assert_eq!(w.export().err(), LOCKED);
    assert_eq!(
        seen.load(Ordering::SeqCst),
        0,
        "nothing of the vault waited in the dialog"
    );
    assert_eq!(counted::made(), 0);
    w.untouched();

    // While the cloud question is open.
    let w = World::new();
    w.ts.volumes.add_sync_root(&w.docs);
    w.pick();
    let token = cloud_token(w.export());
    assert_eq!(
        counted::alive(),
        0,
        "nothing of the vault waits in the question"
    );
    w.lock();
    assert_eq!(w.ts.shell.save_readable_confirm(&token).err(), LOCKED);
    assert_eq!(counted::made(), 0);
    w.untouched();
}

#[test]
fn a_cloud_destination_that_became_a_vault_folder_is_refused_at_confirm() {
    let w = World::new();
    w.ts.volumes.add_sync_root(&w.docs);
    w.pick();
    let token = cloud_token(w.export());
    fs::write(w.docs.join("vault.json"), b"MU-not-really-a-vault").unwrap();
    assert_eq!(
        w.ts.shell.save_readable_confirm(&token).err(),
        in_a_vault_folder()
    );
    assert_eq!(counted::made(), 0, "refused before anything was built");
    assert_eq!(fs::read(&w.dest).unwrap(), OLD);
    assert_eq!(names(&w.docs), [NAME, "vault.json"], "no temp");
    assert_eq!(w.ts.journal(), Vec::<PathBuf>::new());
}

// ---- A lock at the steps of the write

/// The hidden temps in `docs` now.
fn temps_in(docs: &Path) -> usize {
    names(docs)
        .iter()
        .filter(|name| name.ends_with(".lockbox-partial"))
        .count()
}

/// A real lock at the instant the temp's bytes are on disk, for an existing destination and for a new one. The lock is
/// made by the hook, on the export's own thread, before the export looks at the session again.
#[test]
fn a_lock_after_the_temp_is_written_leaves_no_file() {
    for existing in [true, false] {
        let w = World::new();
        let dest = match existing {
            true => w.dest.clone(),
            false => w.docs.join("MU-fresh.csv"),
        };
        let (shell, s, docs) = (Arc::clone(&w.ts.shell), w.s, w.docs.clone());
        let seen = Rc::new(Cell::new(0));
        let counted_temps = Rc::clone(&seen);
        at("export_temp_written", move || {
            counted_temps.set(temps_in(&docs));
            assert_eq!(
                counted::alive(),
                0,
                "the text is not kept once it is on disk"
            );
            shell.sessions.lock(s, LockReason::Manual);
        });
        w.ts.dialogs.answer(Some(dest.clone()));
        assert_eq!(w.export().err(), LOCKED, "the answer is dropped");
        assert_eq!(seen.get(), 1, "the temp was on disk when the lock came");
        assert_eq!(counted::alive(), 0);
        assert_eq!(
            fs::read(&w.dest).unwrap(),
            OLD,
            "the earlier file is as it was"
        );
        assert!(existing || !dest.exists(), "no file appeared");
        w.untouched();
    }
}

#[test]
fn a_lock_just_before_the_rename_leaves_the_existing_file() {
    let w = World::new();
    let (shell, s, docs) = (Arc::clone(&w.ts.shell), w.s, w.docs.clone());
    let seen = Rc::new(Cell::new(0));
    let temps = Rc::clone(&seen);
    at("export_before_publish", move || {
        temps.set(temps_in(&docs));
        shell.sessions.lock(s, LockReason::Manual);
    });
    w.pick();
    assert_eq!(w.export().err(), LOCKED);
    assert_eq!(seen.get(), 1, "the finished temp was waiting to be moved");
    assert_eq!(fs::read(&w.dest).unwrap(), OLD, "byte for byte the same");
    assert_eq!(counted::alive(), 0);
    w.untouched();
}

#[test]
fn an_interrupted_export_is_swept_at_the_next_launch() {
    let w = World::new();
    let new_place = w.docs.join("MU-never.csv");
    // The process is killed with the temp on disk: the hook ends the export where it stands, running no cleanup of its
    // own (an unwind drops what is held, which is all a kill could not do either way).
    at("export_temp_written", || {
        std::panic::resume_unwind(Box::new("killed"));
    });
    w.ts.dialogs.answer(Some(new_place.clone()));
    let ended = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| w.export()));
    assert!(ended.is_err(), "the export did not finish");
    assert_eq!(temps_in(&w.docs), 1, "the temp is left");
    assert!(!new_place.exists());
    let listed = w.ts.journal();
    assert_eq!(listed.len(), 1, "and written down in the journal");
    assert_eq!(counted::alive(), 0);

    let launched = w.ts.restarted();
    let report = launched.sweep_outputs();
    assert_eq!(report.removed, 1);
    assert_eq!(names(&w.docs), [NAME], "the sweep removed the temp");
    assert_eq!(w.ts.journal(), Vec::<PathBuf>::new());
    assert_eq!(fs::read(&w.dest).unwrap(), OLD);
}

#[test]
fn export_dialog_cancel_writes_nothing_and_wipes_the_buffer() {
    let w = World::new();
    w.ts.dialogs.answer(None);
    let answer = w.export().unwrap();
    assert_eq!((answer.session, answer.generation), (w.s, w.g));
    assert!(matches!(answer.data, Outcome::Dismissed));
    assert_eq!(counted::made(), 0, "nothing was built");
    assert_eq!(counted::alive(), 0);
    assert!(!w.ts.shell.paths.outputs.exists());
    w.untouched();
    assert_eq!(w.ts.dialogs.titles(), ["Export this vault"]);
    assert_eq!(w.ts.dialogs.suggested(), [format!("{VAULT} export.csv")]);
    assert_eq!(
        w.ts.dialogs.filters(),
        [Some(("CSV".to_owned(), vec!["csv".to_owned()]))]
    );
}

#[test]
fn the_suggested_name_is_made_safe_for_a_file_name() {
    let cases = [
        ("Family", "Family export.csv"),
        ("a<b>c:d\"e/f\\g|h?i*j", "a-b-c-d-e-f-g-h-i-j export.csv"),
        ("Home. ", "Home export.csv"),
        ("tab\there", "tab-here export.csv"),
        ("...", "Lockbox export.csv"),
        ("", "Lockbox export.csv"),
        ("\u{1F600} MU-vault", "\u{1F600} MU-vault export.csv"),
    ];
    let mut checked = 0;
    for (vault, expected) in cases {
        let job = ReadableJob::export(vault);
        assert_eq!(job.file_name, expected, "{vault:?}");
        assert_eq!(job.title, "Export this vault");
        assert_eq!(job.kind, ReadableKind::Export);
        checked += 1;
    }
    assert_eq!(checked, cases.len());
}

// ---- What the export writes, end to end, and what it answers

/// The file an export wrote is the strict CSV of the vault's items, and its answer names the folder and the counts.
#[test]
fn an_export_writes_the_vault_and_answers_with_counts() {
    let w = World::new();
    w.pick();
    let answer = w.export().unwrap();
    assert_eq!((answer.session, answer.generation), (w.s, w.g));
    let Outcome::Done(view) = answer.data else {
        panic!("not saved");
    };
    assert_eq!(view.folder, w.shown());
    let summary = view.export.expect("counts");
    assert_eq!(summary.items as usize, wants().len());
    assert_eq!(summary.left_out_files, 0);
    let bytes = fs::read(&w.dest).unwrap();
    let (_, rows) = parsed(&bytes);
    assert_eq!(rows.len(), wants().len());
    assert!(!bytes.starts_with(&[0xEF, 0xBB, 0xBF]));
    assert_eq!(names(&w.docs), [NAME]);
    assert_eq!(w.ts.journal(), Vec::<PathBuf>::new());
    assert_eq!(counted::made(), 1);
    assert_eq!(counted::alive(), 0);
    // The file is not hidden once published (its temp was).
    assert!(!crate::testing::is_hidden(Some(&w.dest)));
}

#[test]
fn pdf_and_env_replies_are_unchanged() {
    let ts = TestShell::new();
    let (s, g) = ts.open_vault(VAULT);
    let docs = ts.folder("Documents");
    let shown = docs
        .to_str()
        .unwrap()
        .trim_start_matches(r"\\?\")
        .to_owned();

    // The recovery key's PDF.
    ts.print.write_on_success(b"%PDF-1.7 MU-made-up");
    let pdf = docs.join("MU-key.pdf");
    ts.dialogs.answer(Some(pdf));
    let shell = Arc::clone(&ts.shell);
    let save = std::thread::spawn(move || shell.save_readable(s, g, ReadableJob::recovery_pdf()));
    while ts.print.running() == 0 {
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    assert!(ts.print.finish(Ok(())));
    let answer = save.join().unwrap().unwrap();
    assert_eq!(
        serde_json::to_string(&answer).unwrap(),
        format!(
            "{{\"session\":{},\"generation\":{g},\"data\":{{\"Done\":{{\"folder\":{}}}}}}}",
            s.0,
            serde_json::to_string(&shown).unwrap()
        )
    );

    // A folder's keys as a `.env` file.
    let folder = ts
        .shell
        .new_item(
            s,
            g,
            NewKind::Collection,
            "MU-env-folder".to_owned(),
            None,
            None,
        )
        .unwrap()
        .data;
    put(
        &ts,
        s,
        g,
        &key("MU_KEY_ENV", "", "MU-env-value", ""),
        Some(item_id(&folder).unwrap()),
    );
    ts.dialogs.answer(Some(docs.join(".env")));
    let saved = ts.shell.env_save_file(s, g, &folder).unwrap();
    assert_eq!(
        serde_json::to_string(&saved).unwrap(),
        format!(
            "{{\"session\":{},\"generation\":{g},\"data\":{{\"Saved\":{{\"Done\":{{\"folder\":{}}}}}}}}}",
            s.0,
            serde_json::to_string(&shown).unwrap()
        )
    );
}

// ---- Show in Explorer after an export (34c): the handle

const EXPIRED: Option<ShellError> = Some(ShellError::ChoiceExpired);
const FIVE_MINUTES: Duration = Duration::from_secs(5 * 60);

/// The handle of a finished export.
fn handle_of(view: &SavedView) -> Token {
    view.output.clone().expect("a handle")
}

/// A finished export's answer carries a handle for Show in Explorer: a token the pending table holds for that session
/// and generation, with the destination's folder and nothing else, and its JSON is one more field of `Done` (32 hex
/// characters, no path). A refusal, a closed dialog, a cloud question and a lock before the move issue none.
#[test]
fn export_answer_carries_a_handle_and_never_a_path_back() {
    let w = World::new();
    w.pick();
    let answer = w.export().unwrap();
    let json = serde_json::to_value(&answer).unwrap();
    let Outcome::Done(view) = answer.data else {
        panic!("not saved");
    };
    let output = handle_of(&view);

    // The exact keys of `Done`, and the handle as the bridge writes it.
    let done = json["data"]["Done"].as_object().expect("Done");
    let mut keys: Vec<&str> = done.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["export", "folder", "output"]);
    let written = done["output"].as_str().expect("a token");
    assert!(
        written.len() == 32
            && written
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
        "{written}"
    );
    assert_eq!(serde_json::to_value(&output).unwrap(), json!(written));
    assert!(
        !json.to_string().contains(NAME),
        "the file's name is not in the answer"
    );

    // The table holds it for this session and generation, with the folder (not the file) and nothing more.
    let pending = w.ts.shell.sessions.pending();
    assert_eq!(pending.len(), 1);
    let (session, generation, folder) = pending.peek_saved_folder(&output).unwrap();
    assert_eq!((session, generation), (w.s, w.g));
    assert_eq!(shown(&folder), w.shown());
    assert!(folder.is_dir());

    // The cloud question's yes issues a handle of its own, for the same session and generation.
    w.ts.volumes.add_sync_root(&w.docs);
    w.pick();
    let asked = cloud_token(w.export());
    assert_eq!(pending.len(), 2, "the question is parked beside the handle");
    let second = handle_of(&finished(w.ts.shell.save_readable_confirm(&asked)));
    assert_eq!(pending.len(), 2, "the question is used up, a handle parked");
    assert_ne!(
        serde_json::to_value(&second).unwrap(),
        serde_json::to_value(&output).unwrap()
    );
    assert_eq!(
        pending.peek_saved_folder(&second).unwrap().0,
        w.s,
        "the yes's handle is the session's too"
    );
}

/// A lock that comes before the file is moved writes nothing and issues no handle.
#[test]
fn a_lock_before_the_move_issues_no_handle() {
    let w = World::new();
    let (shell, s) = (Arc::clone(&w.ts.shell), w.s);
    at("export_before_publish", move || {
        shell.sessions.lock(s, LockReason::Manual);
    });
    w.pick();
    assert_eq!(w.export().err(), LOCKED);
    assert_eq!(w.ts.shell.sessions.pending().len(), 0);
}

/// A lock that completes after the file is in place and before the handle is issued: the answer is dropped as `Locked`
/// (the file stays, as the lock's own rule says) and no handle is left parked for the locked session.
#[test]
fn a_lock_after_the_move_leaves_no_handle() {
    let w = World::new();
    let (shell, s) = (Arc::clone(&w.ts.shell), w.s);
    at("export_published", move || {
        shell.sessions.lock(s, LockReason::Manual);
    });
    w.pick();
    assert_eq!(w.export().err(), LOCKED);
    assert_ne!(
        fs::read(&w.dest).unwrap(),
        OLD,
        "the move had happened when the lock came"
    );
    assert_eq!(w.ts.shell.sessions.pending().len(), 0, "no stale handle");
}

/// A wrong password, a closed dialog and a refused folder issue no handle either.
#[test]
fn a_refused_export_issues_no_handle() {
    let w = World::new();
    assert_eq!(w.export_as(w.s, w.g, WRONG).err(), wrong_password());
    w.ts.dialogs.answer(None);
    assert!(matches!(w.export().unwrap().data, Outcome::Dismissed));
    let vault = w.ts.shell.registry.entries()[0].1.clone();
    w.ts.dialogs.answer(Some(vault.join(NAME)));
    assert_eq!(w.export().err(), in_a_vault_folder());
    assert_eq!(w.ts.shell.sessions.pending().len(), 0);
}

/// Show in Explorer opens only a folder, as the vault list's does: the saved folder replaced by a file of its name, or
/// gone, is refused before anything is launched (`InvalidInput { "folder" }`, `NotFound`), and the handle stays for a
/// later press once the folder is back.
#[test]
fn export_handle_opens_nothing_once_its_folder_is_a_file_or_gone() {
    let w = World::new();
    w.pick();
    let output = handle_of(&finished(w.export()));
    let aside = w.docs.with_file_name("Documents-aside");
    fs::rename(&w.docs, &aside).unwrap();
    fs::write(&w.docs, b"not a folder").unwrap();
    assert_eq!(
        w.ts.shell.show_output_in_explorer(&output).err(),
        Some(ShellError::InvalidInput { what: "folder" })
    );
    fs::remove_file(&w.docs).unwrap();
    assert_eq!(
        w.ts.shell.show_output_in_explorer(&output).err(),
        Some(ShellError::NotFound)
    );
    assert!(
        w.ts.launcher.opened_folders().is_empty() && w.ts.launcher.opened().is_empty(),
        "nothing was launched"
    );
    fs::rename(&aside, &w.docs).unwrap();
    w.ts.shell.show_output_in_explorer(&output).unwrap();
    assert_eq!(w.ts.launcher.opened_folders().len(), 1);
}

/// Show in Explorer opens exactly the folder the file went to, through the launcher, and as often as the person presses
/// it; a token of any other kind, or one never given, opens nothing; a failed launch is the `io` refusal with no path.
#[test]
fn export_handle_opens_only_the_saved_folder() {
    let w = World::new();
    w.pick();
    let output = handle_of(&finished(w.export()));
    w.ts.shell.show_output_in_explorer(&output).unwrap();
    w.ts.shell.show_output_in_explorer(&output).unwrap();
    let opened = w.ts.launcher.opened_folders();
    assert_eq!(opened.len(), 2);
    for folder in &opened {
        assert_eq!(shown(folder), w.shown(), "the destination's folder");
        assert!(folder.is_dir(), "a folder, not the file");
    }
    assert!(
        w.ts.launcher.opened_files().is_empty() && w.ts.launcher.opened().is_empty(),
        "no file and no link is opened"
    );

    w.ts.launcher.fail_next_folder();
    let failed = w.ts.shell.show_output_in_explorer(&output).err();
    assert_eq!(failed, Some(ShellError::from(std::io::Error::other("x"))));
    assert_eq!(
        serde_json::to_value(failed.unwrap()).unwrap(),
        json!({ "code": "core", "kind": "io" })
    );
    let tried = w.ts.launcher.opened_folders().len();
    assert_eq!(tried, 3, "the failed try was a launch of the same folder");

    // The cloud question's token is no handle (and stays the question's), and nor is a token never given.
    w.ts.volumes.add_sync_root(&w.docs);
    w.pick();
    let question = cloud_token(w.export());
    for token in [&question, &made_up_token()] {
        assert_eq!(w.ts.shell.show_output_in_explorer(token).err(), EXPIRED);
    }
    assert_eq!(
        w.ts.launcher.opened_folders().len(),
        tried,
        "nothing more opened"
    );
    // The question can still be answered, and its yes gives a handle of its own that opens the same folder.
    let again = handle_of(&finished(w.ts.shell.save_readable_confirm(&question)));
    w.ts.shell.show_output_in_explorer(&again).unwrap();
    assert_eq!(w.ts.launcher.opened_folders().len(), tried + 1);

    // A handle does not answer a question or start another export.
    assert_eq!(w.ts.shell.export_repick(&again).err(), NOT_FOUND);
}

/// Two exports each have their own handle: closing the older leaves the newer working, and the older is the one gone.
#[test]
fn export_handles_are_each_their_own() {
    let w = World::new();
    w.pick();
    let older = handle_of(&finished(w.export()));
    w.pick();
    let newer = handle_of(&finished(w.export()));
    w.ts.shell.close_output(&older).unwrap();
    assert_eq!(w.ts.shell.show_output_in_explorer(&older).err(), EXPIRED);
    assert!(w.ts.shell.show_output_in_explorer(&newer).is_ok());
    assert_eq!(w.ts.launcher.opened_folders().len(), 1);
}

/// The handle is dropped by the lock of its vault (another vault's lock leaves it), by Lock all, by Windows locking or
/// sleeping and by the app closing, by `close_output` (Done, closing the panel; again is no error, and a question's
/// token is not a handle), and at its five minutes.
#[test]
fn export_handle_is_dropped_by_a_lock_and_by_done() {
    // A lock of its own vault drops it; a lock of another leaves it.
    let w = World::new();
    w.pick();
    let output = handle_of(&finished(w.export()));
    let (other, _) = w.ts.open_vault("MU-other");
    w.ts.shell.sessions.lock(other, LockReason::Manual);
    assert!(
        w.ts.shell.show_output_in_explorer(&output).is_ok(),
        "another vault's lock leaves it"
    );
    w.lock();
    assert_eq!(w.ts.shell.show_output_in_explorer(&output).err(), EXPIRED);
    assert_eq!(w.ts.shell.sessions.pending().len(), 0);

    // Lock all, Windows locking or sleeping, and closing.
    for reason in [
        LockReason::Manual,
        LockReason::WindowsLocked,
        LockReason::Sleep,
        LockReason::AppClosing,
    ] {
        let w = World::new();
        w.pick();
        let output = handle_of(&finished(w.export()));
        w.ts.shell.sessions.lock_all(reason);
        assert_eq!(
            w.ts.shell.show_output_in_explorer(&output).err(),
            EXPIRED,
            "{reason:?}"
        );
        assert_eq!(w.ts.shell.sessions.pending().len(), 0, "{reason:?}");
        assert!(w.ts.launcher.opened_folders().is_empty(), "{reason:?}");
    }

    // Done (`close_output`), twice, with a question's token beside it.
    let w = World::new();
    w.pick();
    let before = Instant::now();
    let waiting = handle_of(&finished(w.export()));
    let issued = (before, Instant::now());
    w.ts.volumes.add_sync_root(&w.docs);
    w.pick();
    let question = cloud_token(w.export());
    let output = handle_of(&finished(w.ts.shell.save_readable_confirm(&question)));
    w.ts.shell.close_output(&question).unwrap();
    assert_eq!(
        w.ts.shell.sessions.pending().len(),
        2,
        "a used question closes nothing"
    );
    w.ts.shell.close_output(&output).unwrap();
    w.ts.shell.close_output(&output).unwrap();
    assert_eq!(w.ts.shell.show_output_in_explorer(&output).err(), EXPIRED);
    assert_eq!(w.ts.shell.sessions.pending().len(), 1);
    assert!(w.ts.launcher.opened_folders().is_empty());

    // Five minutes, from times that bracket the handle's issue: it was issued between `before` and `after`, so it is
    // certainly still there a moment short of five minutes after `before`, and certainly gone five minutes after `after`.
    let pending = w.ts.shell.sessions.pending();
    assert!(
        pending
            .peek_saved_folder_at(&waiting, issued.0 + FIVE_MINUTES - Duration::from_millis(1))
            .is_ok()
    );
    assert_eq!(
        pending
            .peek_saved_folder_at(&waiting, issued.1 + FIVE_MINUTES)
            .err(),
        EXPIRED
    );
}

/// The words of every answer an export gives, as the bridge serialises them: counts, the titles of items whose values
/// break a line, the folder and the Show in Explorer handle (a token); no value, no password, no file name and no path
/// beyond the folder.
#[test]
fn export_answers_carry_only_counts_titles_the_folder_and_its_handle() {
    let ts = TestShell::new();
    let (s, g) = ts.open_vault(VAULT);
    fill(
        &ts,
        s,
        g,
        &[
            login("MU-t-cr", "", "MU-shape-user", "MU-shape-a\rMU-shape-b", ""),
            note("MU-t-note", "", "MU-shape-note"),
            key("MU_KEY_SHAPE", "", "MU-shape-key", ""),
        ],
    );
    put(
        &ts,
        s,
        g,
        &login("MU-t-trashed", "", "", "MU-shape-trashed", ""),
        None,
    );
    let trashed = items_of(&ts, s, g)
        .into_iter()
        .find(|item| item.title == "MU-t-trashed")
        .unwrap();
    ts.shell.trash_item(s, g, &trashed.id.to_hex()).unwrap();
    ts.stored_file(s, g, "MU-shape-file.txt", b"MU-shape-file-bytes");
    let docs = ts.folder("Documents");
    let shown = docs
        .to_str()
        .unwrap()
        .trim_start_matches(r"\\?\")
        .to_owned();
    let dest = docs.join(NAME);
    let export = |password: &str| heavy(|| ts.shell.export_csv(s, g, secret(password)));
    let tag = |data: Value| json!({ "session": s.0, "generation": g, "data": data });
    let mut said: Vec<String> = Vec::new();

    // Direct success.
    ts.dialogs.answer(Some(dest.clone()));
    let direct = serde_json::to_value(export(PW).unwrap()).unwrap();
    let counts = json!({
        "items": 3, "left_out_files": 1, "unreadable": 0, "line_breaks": ["MU-t-cr"]
    });
    // The handle for Show in Explorer is one more field of `Done`: a token of 32 lowercase hex characters, never a path.
    let written_handle = |answer: &Value| -> String {
        let handle = answer["data"]["Done"]["output"]
            .as_str()
            .expect("a handle")
            .to_owned();
        assert!(
            handle.len() == 32
                && handle
                    .bytes()
                    .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
            "{handle}"
        );
        handle
    };
    let first_handle = written_handle(&direct);
    assert_eq!(
        direct,
        tag(json!({ "Done": { "folder": shown, "export": counts, "output": first_handle } }))
    );
    said.push(direct.to_string());

    // The cloud question, and its confirmed success.
    ts.volumes.add_sync_root(&docs);
    ts.dialogs.answer(Some(dest.clone()));
    let asked = serde_json::to_value(export(PW).unwrap()).unwrap();
    let token = asked["data"]["Confirm"]["CloudFolder"]["token"]
        .as_str()
        .expect("a token")
        .to_owned();
    assert_eq!(token.len(), 32);
    assert_eq!(
        asked,
        tag(json!({ "Confirm": { "CloudFolder": { "token": token, "provider": "Other" } } }))
    );
    said.push(asked.to_string());
    let parked: Token = serde_json::from_value(Value::String(token)).unwrap();
    let confirmed = serde_json::to_value(ts.shell.save_readable_confirm(&parked).unwrap()).unwrap();
    let second_handle = written_handle(&confirmed);
    assert_ne!(
        first_handle, second_handle,
        "each export has its own handle"
    );
    assert_eq!(
        confirmed,
        tag(json!({ "Done": { "folder": shown, "export": counts, "output": second_handle } }))
    );
    said.push(confirmed.to_string());

    // A closed dialog, and each failure.
    ts.dialogs.answer(None);
    let dismissed = serde_json::to_value(export(PW).unwrap()).unwrap();
    assert_eq!(dismissed, tag(json!("Dismissed")));
    said.push(dismissed.to_string());
    let failures = [
        (
            export(WRONG).err(),
            json!({ "code": "core", "kind": "wrong_password" }),
        ),
        (
            ts.shell.export_csv(s, g + 1, secret(PW)).err(),
            json!({ "code": "locked" }),
        ),
        (
            ts.shell
                .export_csv(SessionId(s.0 + 100), g, secret(PW))
                .err(),
            json!({ "code": "not_found" }),
        ),
        (
            ts.shell.export_repick(&made_up_token()).err(),
            json!({ "code": "not_found" }),
        ),
    ];
    for (error, shape) in failures {
        let error = error.expect("a refusal");
        assert_eq!(serde_json::to_value(error).unwrap(), shape);
        said.push(shape.to_string());
    }
    let (r, gr) = read_only_session(&ts);
    let read_only = ts.shell.export_csv(r, gr, secret(PW)).err().unwrap();
    assert_eq!(
        serde_json::to_value(read_only).unwrap(),
        json!({ "code": "read_only" })
    );
    said.push(json!({ "code": "read_only" }).to_string());

    // Nothing else is in any of them: no value, password, file name or path beyond the folder.
    let escaped = shown.replace('\\', "\\\\");
    let all = said.join("\n").replace(&escaped, "").replace("MU-t-cr", "");
    for leak in ["MU-", "MU_", ".csv", WRONG, PW, "Documents"] {
        assert!(!all.contains(leak), "an answer holds {leak:?}");
    }
    assert_eq!(said.len(), 9);
}

/// Six exports that fail (a wrong password, a read, a write, a publish, a journal and a lock in the picker), each with
/// everything that came out of it that a test can read: the refusal as the page gets it and as `Debug` shows it, the
/// lock events, notices, capture events and job events. One text for each, named by what failed.
fn run_failure_scenarios() -> Vec<(&'static str, String)> {
    let scenarios: [(&str, Inject); 6] = [
        ("wrong password", Box::new(|_| {})),
        (
            "a read that fails: locked before the rows are read",
            Box::new(|w| {
                let (shell, s) = (Arc::clone(&w.ts.shell), w.s);
                w.ts.volumes.during_next_check(Box::new(move || {
                    shell.sessions.lock(s, LockReason::Manual);
                }));
            }),
        ),
        (
            "a write that fails: the folder is gone after the temp is recorded",
            Box::new(|w| {
                let docs = w.docs.clone();
                at("export_temp_recorded", move || {
                    let _ = fs::remove_file(docs.join(NAME));
                    let _ = fs::remove_dir(&docs);
                });
            }),
        ),
        (
            "a publish that fails",
            Box::new(|_| failpoint::arm("publish.before_flush")),
        ),
        (
            "a journal that cannot be written",
            Box::new(|w| {
                let outputs = w.ts.shell.paths.outputs.clone();
                w.ts.dialogs.during_next_dialog(Box::new(move || {
                    let _ = fs::create_dir_all(outputs.parent().unwrap());
                    let _ = fs::write(&outputs, "MU-not-json");
                }));
            }),
        ),
        (
            "a lock in the picker",
            Box::new(|w| {
                let (shell, s) = (Arc::clone(&w.ts.shell), w.s);
                w.ts.dialogs.during_next_dialog(Box::new(move || {
                    shell.sessions.lock(s, LockReason::Manual);
                }));
            }),
        ),
    ];
    let mut texts = Vec::new();
    for (what, inject) in scenarios {
        let w = World::new();
        inject(&w);
        w.pick();
        let password = if what == "wrong password" { WRONG } else { PW };
        let answer = w.export_as(w.s, w.g, password);
        failpoint::disarm_all();
        let error = answer
            .err()
            .unwrap_or_else(|| panic!("{what}: it did not fail"));
        let shape = serde_json::to_string(&error).unwrap();
        let mut said = vec![shape, format!("{error:?}")];
        said.push(format!("{:?}", w.ts.events.locked()));
        said.extend(w.ts.events.notices().iter().map(Value::to_string));
        said.extend(w.ts.events.captures().iter().map(Value::to_string));
        said.extend(
            w.ts.events
                .job_events()
                .iter()
                .map(|(name, payload)| format!("{name} {payload}")),
        );
        assert_eq!(counted::alive(), 0, "{what}");
        texts.push((what, said.join("\n")));
    }
    texts
}

/// What no output of the export may hold: every marker a fixture carries, the typed password (wrong, and the vault's own,
/// which the other failures were given), the file name and the folder the dialog named.
const NO_OUTPUT_HOLDS: [&str; 6] = ["MU-", "MU_", WRONG, PW, "csv", "Documents"];

/// The test run a second time as a child process (see `export_logs_errors_and_events_carry_no_marker`): its own output is
/// what the parent reads. Ignored in a normal run, which is why it is run by name.
#[test]
#[ignore = "run by the capture test, as a child process"]
fn failure_scenarios_for_the_capture() {
    // Nothing is printed here, and an assertion's message is the only text this test can add.
    assert_eq!(run_failure_scenarios().len(), 6);
}

/// The export's source between two markers: its start and the first thing after it.
fn between<'a>(source: &'a str, from: &str, to: &str) -> &'a str {
    let start = source.find(from).expect("the start of the export's code");
    let len = source[start..]
        .find(to)
        .expect("the end of the export's code");
    &source[start..start + len]
}

/// Errors, events, and what the export prints, with a wrong password, a read, a write, a publish and a journal failure
/// and a lock injected: none holds a marker. What is captured: the refusals (as the page gets them and as `Debug` shows
/// them) and every event the shell sent; and the standard output and error of the same failures run as a child process
/// (the test harness cannot capture the process's own streams, so a child's are the real ones). Then the whole of the
/// export's source is read for anything that prints, logs or panics with a message.
#[test]
fn export_logs_errors_and_events_carry_no_marker() {
    let texts = run_failure_scenarios();
    assert_eq!(texts.len(), 6);
    for (what, all) in &texts {
        for leak in NO_OUTPUT_HOLDS {
            assert!(!all.contains(leak), "{what}: something holds {leak:?}");
        }
    }

    // The same failures in a child, with its streams captured.
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "--nocapture",
            "--test-threads=1",
            "commands::export_tests::failure_scenarios_for_the_capture",
        ])
        .output()
        .expect("the test program starts");
    let (out, err) = (
        String::from_utf8_lossy(&child.stdout).into_owned(),
        String::from_utf8_lossy(&child.stderr).into_owned(),
    );
    assert!(child.status.success(), "the child run failed");
    assert!(
        out.contains("1 passed") && out.contains("failure_scenarios_for_the_capture"),
        "the child ran nothing: it was not captured"
    );
    for (stream, text) in [("standard output", &out), ("standard error", &err)] {
        for leak in NO_OUTPUT_HOLDS {
            // The harness names the test and counts: `csv` and `Documents` are not in those words.
            assert!(
                !text.contains(leak),
                "{stream} of the export holds {leak:?}"
            );
        }
    }

    // The whole of `export_csv.rs`, and each export function of `readable.rs`, whatever comes before or after a
    // `#[cfg(test)]` line in them.
    let readable = include_str!("readable.rs");
    let sources = [
        ("export_csv.rs", include_str!("../export_csv.rs")),
        (
            "ReadableJob::export",
            between(
                readable,
                "pub fn export(vault_name",
                "/// The dialog's filter.",
            ),
        ),
        (
            "export_csv, export_repick, write_export_csv",
            between(
                readable,
                "/// Exports the vault as a readable CSV where the user picks, once `password`",
                "/// The printers Lockbox offers for the recovery key, read from Windows now",
            ),
        ),
        (
            "the commands",
            between(
                readable,
                "pub(super) async fn export_csv(",
                "/// The printers Lockbox offers for the recovery key, and the default one",
            ),
        ),
    ];
    let mut scanned = 0;
    for (what, code) in sources {
        assert!(code.len() > 200, "{what}: the scan read nothing");
        for printing in [
            "println!",
            "eprintln!",
            "print!(",
            "eprint!(",
            "dbg!",
            "log::",
            "tracing::",
            "panic!(",
            "unwrap()",
            ".expect(",
            "unreachable!",
            "todo!",
            "assert!(",
        ] {
            assert!(!code.contains(printing), "{what} holds {printing}");
        }
        scanned += 1;
    }
    assert_eq!(scanned, 4);
}

/// A lock that arrives after the journal entry is written and before the temp exists: the temp is never created, the
/// text is never written, the answer is `Locked`, and nothing is left, in the folder or the journal.
#[test]
fn a_lock_after_the_entry_is_recorded_creates_no_temp() {
    for existing in [true, false] {
        let w = World::new();
        let dest = match existing {
            true => w.dest.clone(),
            false => w.docs.join("MU-fresh.csv"),
        };
        let (shell, s, docs) = (Arc::clone(&w.ts.shell), w.s, w.docs.clone());
        let on_disk = Rc::new(Cell::new(usize::MAX));
        let temps = Rc::clone(&on_disk);
        at("export_temp_recorded", move || {
            temps.set(temps_in(&docs));
            shell.sessions.lock(s, LockReason::Manual);
        });
        // If the temp were made and written, this would run.
        let written = Rc::new(Cell::new(false));
        let was_written = Rc::clone(&written);
        at("export_temp_written", move || was_written.set(true));
        w.ts.dialogs.answer(Some(dest.clone()));
        assert_eq!(w.export().err(), LOCKED);
        assert_eq!(on_disk.get(), 0, "no temp when the lock came");
        assert!(!written.get(), "a temp was written after the lock");
        assert_eq!(fs::read(&w.dest).unwrap(), OLD);
        assert!(existing || !dest.exists());
        assert_eq!(counted::alive(), 0, "the text was dropped");
        w.untouched();
    }
}

/// A publish that fails while the file system cannot say whether the temp is gone (any answer but "not found"): the
/// journal entry stays, for the launch sweep, however the clean-up goes. Here the clean-up fails too (another program
/// holds the temp open), so the temp is left, and the entry that names it is what lets the next launch remove it.
#[test]
fn a_temp_that_may_still_be_there_keeps_its_journal_entry() {
    let w = World::new();
    let new_place = w.docs.join("MU-fresh.csv");
    let holder = Rc::new(RefCell::new(None));
    let (hold, docs) = (Rc::clone(&holder), w.docs.clone());
    at("export_before_publish", move || {
        use std::os::windows::fs::OpenOptionsExt;
        let temp = fs::read_dir(&docs)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .find(|path| path.to_string_lossy().ends_with(".lockbox-partial"))
            .expect("the temp is there");
        // Nobody else may open it: the flush before the move fails, and so does removing it.
        let file = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(temp)
            .unwrap();
        *hold.borrow_mut() = Some(file);
        super::readable::fail_next_metadata_with(std::io::ErrorKind::PermissionDenied);
    });
    w.ts.dialogs.answer(Some(new_place.clone()));
    assert!(w.export().is_err(), "the publish fails");
    assert_eq!(temps_in(&w.docs), 1, "the temp could not be removed");
    assert!(!new_place.exists());
    let listed = w.ts.journal();
    assert_eq!(listed.len(), 1, "and its entry is kept");
    assert!(listed[0].to_string_lossy().ends_with(".lockbox-partial"));
    assert_eq!(counted::alive(), 0);

    // Released, the next launch's sweep removes it.
    drop(holder.borrow_mut().take());
    let report = w.ts.restarted().sweep_outputs();
    assert_eq!(report.removed, 1);
    assert_eq!(names(&w.docs), [NAME]);
    assert_eq!(w.ts.journal(), Vec::<PathBuf>::new());
}

/// A vault with a damaged item is exported without it, and says how many: the export is not refused. Another vault's
/// answer, and a vault with none, say 0.
#[test]
fn a_damaged_item_is_counted_and_the_export_goes_on() {
    let ts = TestShell::new();
    let (s, g) = ts.open_vault(VAULT);
    let all = [
        login("MU-good-login", "", "", "MU-good-pw", ""),
        login("MU-bad-login-one", "", "", "MU-bad-pw-one", ""),
        login("MU-bad-login-two", "", "", "MU-bad-pw-two", ""),
        note("MU-good-note", "", "MU-good-text"),
    ];
    fill(&ts, s, g, &all);
    let ids: Vec<(String, lockbox_core::ids::ItemId)> = items_of(&ts, s, g)
        .into_iter()
        .map(|item| (item.title.clone(), item.id))
        .collect();
    let id_named = |name: &str| ids.iter().find(|(title, _)| title == name).unwrap().1;
    let registry = ts.shell.registry.entries()[0].clone();
    ts.shell.sessions.lock_all(LockReason::Manual);
    for bad in ["MU-bad-login-one", "MU-bad-login-two"] {
        let file = registry
            .1
            .join("items")
            .join(format!("{}.item", id_named(bad).to_hex()));
        let mut bytes = fs::read(&file).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        fs::write(&file, bytes).unwrap();
    }
    let unlocked = heavy(|| ts.shell.unlock_vault(ts.vault(registry.0), secret(PW))).unwrap();
    let (s, g) = (unlocked.session, unlocked.generation);
    assert_eq!(
        ts.shell.list_items(s, g).unwrap().data.damaged.len(),
        2,
        "the vault lists two damaged items"
    );
    let docs = ts.folder("Documents");
    let dest = docs.join(NAME);
    ts.dialogs.answer(Some(dest.clone()));
    let answer = heavy(|| ts.shell.export_csv(s, g, secret(PW))).unwrap();
    let Outcome::Done(view) = answer.data else {
        panic!("the export was refused or asked");
    };
    let summary = view.export.expect("counts");
    assert_eq!((summary.items, summary.unreadable), (2, 2));
    let text = fs::read(&dest).unwrap();
    let (_, rows) = parsed(&text);
    let mut named: Vec<&str> = rows.iter().map(|row| row[3].as_str()).collect();
    named.sort_unstable();
    assert_eq!(named, ["MU-good-login", "MU-good-note"]);
    assert!(!String::from_utf8_lossy(&text).contains("MU-bad"));
    assert_eq!(
        serde_json::to_value(&summary).unwrap(),
        json!({ "items": 2, "left_out_files": 0, "unreadable": 2, "line_breaks": [] })
    );
}

/// A buffer of the vault's secrets is dropped (and so wiped: it is a `Zeroizing`) whichever way the export ends.
#[test]
fn the_plaintext_buffer_is_wiped_on_every_exit() {
    // Success: none alive once the file is on disk, one made, none alive after.
    let w = World::new();
    let during = Rc::new(Cell::new(usize::MAX));
    let on_disk = Rc::clone(&during);
    at("export_temp_written", move || on_disk.set(counted::alive()));
    w.pick();
    finished(w.export());
    assert_eq!((counted::made(), counted::alive()), (1, 0));
    assert_eq!(during.get(), 0, "the text outlived its write");

    // Each failure after the rows are made: a write that fails, a publish that fails, a lock at the temp and a lock at
    // the rename. The buffer is dropped each time.
    let after_rows: [(&str, Inject); 4] = [
        (
            "write",
            Box::new(|w| {
                let docs = w.docs.clone();
                at("export_temp_recorded", move || {
                    let _ = fs::remove_file(docs.join(NAME));
                    let _ = fs::remove_dir(&docs);
                });
            }),
        ),
        (
            "publish",
            Box::new(|_| failpoint::arm("publish.before_flush")),
        ),
        (
            "lock at the temp",
            Box::new(|w| {
                let (shell, s) = (Arc::clone(&w.ts.shell), w.s);
                at("export_temp_written", move || {
                    shell.sessions.lock(s, LockReason::Manual);
                });
            }),
        ),
        (
            "lock at the rename",
            Box::new(|w| {
                let (shell, s) = (Arc::clone(&w.ts.shell), w.s);
                at("export_before_publish", move || {
                    shell.sessions.lock(s, LockReason::Manual);
                });
            }),
        ),
    ];
    let mut failed = 0;
    for (what, inject) in after_rows {
        let w = World::new();
        inject(&w);
        w.pick();
        let made = counted::made();
        assert!(w.export().is_err(), "{what}");
        failpoint::disarm_all();
        assert_eq!(counted::made(), made + 1, "{what}: the rows were built");
        assert_eq!(counted::alive(), 0, "{what}: the buffer was dropped");
        failed += 1;
    }
    assert_eq!(failed, 4);

    // A revocation before the rows are read (a lock in the picker), a closed dialog and a cloud choice that is dropped:
    // nothing is built.
    let w = World::new();
    let made = counted::made();
    let (shell, s) = (Arc::clone(&w.ts.shell), w.s);
    w.ts.dialogs.during_next_dialog(Box::new(move || {
        shell.sessions.lock(s, LockReason::Manual);
    }));
    w.pick();
    assert_eq!(w.export().err(), LOCKED);
    let w = World::new();
    w.ts.volumes.add_sync_root(&w.docs);
    w.pick();
    let token = cloud_token(w.export());
    drop(token);
    w.ts.dialogs.answer(None);
    w.export().unwrap();
    assert_eq!(counted::made(), made, "nothing was built");
    assert_eq!(counted::alive(), 0);
}

/// An export's requests: the session, the generation and the password, or the token, and nothing else.
#[test]
fn export_commands_refuse_malformed_requests() {
    let body = InvokeBody::Json;
    let good = json!({ "session": 1, "generation": 2, "password": "MU-typed" });
    assert!(parse::<ExportArgs>(&body(good)).is_ok());
    let mut refused = 0;
    for bad in [
        json!({ "session": 1, "generation": 2 }),
        json!({ "session": 1, "generation": 2, "password": 7 }),
        json!({ "session": 1, "generation": 2, "password": "MU-typed", "path": "C:\\x" }),
        json!({ "session": 1, "generation": 2, "password": "MU-typed", "dest": "C:\\x" }),
        json!({ "generation": 2, "password": "MU-typed" }),
        json!("MU-typed"),
    ] {
        assert_eq!(parse::<ExportArgs>(&body(bad)).err(), Some(MALFORMED));
        refused += 1;
    }
    let well_formed = "0123456789abcdef".repeat(2);
    assert!(parse::<ConfirmArgs>(&body(json!({ "token": well_formed }))).is_ok());
    for bad in [
        json!({}),
        json!({ "token": "not a token" }),
        json!({ "token": well_formed, "dest": "C:\\x" }),
        json!({ "token": well_formed, "password": "MU-typed" }),
    ] {
        assert_eq!(parse::<ConfirmArgs>(&body(bad)).err(), Some(MALFORMED));
        refused += 1;
    }
    assert_eq!(refused, 10);
    // Both are commands, granted to the window.
    for command in ["export_csv", "export_repick"] {
        assert!(
            super::COMMANDS.contains(&command),
            "{command} is not listed"
        );
    }
}
