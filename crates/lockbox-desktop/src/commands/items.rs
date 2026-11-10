//! Items, search and links (spec §4.1): what crosses to the page, and when. Every answer is built from the views in
//! [`crate::views`]: a password or a key's value crosses only through `reveal_password`, never a file key or a nonce.
//!
//! Each command is a thin wrapper that parses its request and runs a [`Shell`] method below on the blocking pool. The
//! page's limits are checked before the session is touched, so a refused edit writes nothing. Permanent deletes
//! (`purge_item`, `delete_orphans`) are confirmed by the page, with no question of the shell's own (Ariel's option A).

use std::sync::Arc;

use lockbox_core::Vault;
use lockbox_core::ids::ItemId;
use lockbox_core::item::{Item, ItemKind};
use lockbox_core::{ReadOnlyVault, Result as CoreResult};
use serde::Deserialize;
use tauri::ipc::Request;
use tauri::{State, Url};
use zeroize::Zeroizing;

use super::{args, blocking};
use crate::error::{ShellError, ShellResult};
use crate::session::{SessionId, SessionState, Tagged, VaultRef};
use crate::shell::Shell;
use crate::views::{ItemDetail, ItemList, ItemSummary, OrphanView, SearchResults, web_url};

/// The page's limits (`TooLarge`), in bytes; the engine's own 1 MiB item cap stays behind them.
const MAX_TITLE: usize = 1024;
const MAX_USERNAME: usize = 1024;
const MAX_URL: usize = 2048;
const MAX_URLS: usize = 32;
const MAX_NOTES: usize = 524_288;
const MAX_PASSWORD: usize = 4096;
/// A key's value: room for a certificate or a private key as well as a token.
const MAX_KEY_VALUE: usize = 16_384;
/// The search query's limit, in characters.
const MAX_QUERY_CHARS: usize = 256;
/// The most results one vault gives a search.
const SEARCH_LIMIT: usize = 100;

/// A password, username or link asked of an item that is not a login.
const NOT_A_LOGIN: ShellError = ShellError::InvalidInput {
    what: "not a login",
};

/// A key's value asked of an item that is not a key, or given for a kind that has none.
const NOT_A_KEY: ShellError = ShellError::InvalidInput { what: "not a key" };

/// A folder named with nothing but spaces, or with nothing.
const NO_FOLDER_NAME: ShellError = ShellError::InvalidInput {
    what: "folder name",
};

/// A folder's name as it is kept: trimmed, and refused when nothing is left. The same name as another folder is fine,
/// as it is for any item; the length limit is the title's, checked before this.
fn folder_name(title: &str) -> ShellResult<String> {
    let name = title.trim();
    match name.is_empty() {
        true => Err(NO_FOLDER_NAME),
        false => Ok(name.to_owned()),
    }
}

/// A link number past the login's links (`copy_field`).
const NO_SUCH_LINK: ShellError = ShellError::InvalidInput { what: "link" };

/// An earlier password's number past the login's list (`reveal_password`, `copy_field`).
const NO_SUCH_EARLIER: ShellError = ShellError::InvalidInput {
    what: "earlier password",
};

/// Tests only: the last step of a read that returns item data, after the vault work and before the answer.
#[cfg(test)]
const READ_DONE: &str = "shell.items.read_done";

/// The last step of a read that returns item data: a test can lock the vault here (§9: nothing read before a lock is
/// returned after it).
fn read_done() -> ShellResult<()> {
    #[cfg(test)]
    lockbox_core::internals::fsio::failpoint::check(READ_DONE)?;
    Ok(())
}

/// Refuses `text` longer than `max` bytes (`TooLarge { what }`).
fn at_most(text: &str, max: usize, what: &'static str) -> ShellResult<()> {
    match text.len() > max {
        true => Err(ShellError::TooLarge { what }),
        false => Ok(()),
    }
}

/// An item ID the page sent: 32 lowercase hex characters.
fn item_id(text: &str) -> ShellResult<ItemId> {
    Ok(ItemId::from_hex(text)?)
}

fn collection_id(text: Option<&str>) -> ShellResult<Option<ItemId>> {
    text.map(item_id).transpose()
}

/// What the item commands read, from a writable or a read-only vault alike.
trait Items {
    fn item(&self, id: &ItemId) -> CoreResult<&Item>;
    fn all(&self) -> Box<dyn Iterator<Item = &Item> + '_>;
    fn damaged(&self) -> &[ItemId];
    fn find(&self, query: &str, limit: usize) -> Vec<ItemId>;
}

impl Items for Vault {
    fn item(&self, id: &ItemId) -> CoreResult<&Item> {
        self.get_item(id)
    }
    fn all(&self) -> Box<dyn Iterator<Item = &Item> + '_> {
        Box::new(self.items())
    }
    fn damaged(&self) -> &[ItemId] {
        self.damaged_items()
    }
    fn find(&self, query: &str, limit: usize) -> Vec<ItemId> {
        self.search(query, limit)
    }
}

impl Items for ReadOnlyVault {
    fn item(&self, id: &ItemId) -> CoreResult<&Item> {
        self.get_item(id)
    }
    fn all(&self) -> Box<dyn Iterator<Item = &Item> + '_> {
        Box::new(self.items())
    }
    fn damaged(&self) -> &[ItemId] {
        self.damaged_items()
    }
    fn find(&self, query: &str, limit: usize) -> Vec<ItemId> {
        self.search(query, limit)
    }
}

fn items<'a>(vault: &'a VaultRef<'_>) -> &'a dyn Items {
    match vault {
        VaultRef::Writable(vault) => *vault,
        VaultRef::ReadOnly(vault) => *vault,
    }
}

/// The writable vault behind `vault`, for the reads only a live vault has (the old trash, the orphans).
fn writable<'a>(vault: &'a VaultRef<'_>) -> ShellResult<&'a Vault> {
    match vault {
        VaultRef::Writable(vault) => Ok(vault),
        VaultRef::ReadOnly(_) => Err(ShellError::ReadOnly),
    }
}

/// The kind of item `new_item` makes. A file item is made by attaching a file (a later task), never here.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NewKind {
    Login,
    Key,
    Note,
    Collection,
}

/// The fields a new item starts with, saved with it in one write (`new_item`). No `Debug`: it holds item content and
/// maybe a password or a key's value. Any field may be left out. Each belongs to a kind: `username`, `password` and
/// `urls` to a login, `value` to a key, `notes` to a login, a key or a note (a folder takes none); one sent for a kind
/// that has no use for it is refused.
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct ItemFields {
    pub username: String,
    pub password: Zeroizing<String>,
    pub urls: Vec<String>,
    pub notes: Zeroizing<String>,
    pub value: Zeroizing<String>,
}

impl ItemFields {
    /// The page's limits, checked before anything is written (and before a website is looked at).
    fn check(&self) -> ShellResult<()> {
        at_most(&self.username, MAX_USERNAME, "username")?;
        at_most(&self.password, MAX_PASSWORD, "password")?;
        at_most(&self.value, MAX_KEY_VALUE, "value")?;
        at_most(&self.notes, MAX_NOTES, "notes")?;
        if self.urls.len() > MAX_URLS {
            return Err(ShellError::TooLarge { what: "urls" });
        }
        for url in &self.urls {
            at_most(url, MAX_URL, "url")?;
        }
        Ok(())
    }
}

/// A website the page sent that is not an `http` or `https` address.
const NOT_A_WEBSITE: ShellError = ShellError::InvalidInput { what: "website" };

/// Whether `text` begins with a scheme of its own (`http:`, `mailto:`, `C:`), as opposed to a host and port
/// (`localhost:3000`, `example.com:8080/a`), which have none. A scheme is a letter then letters, digits, `+`, `-` or
/// `.`, then a colon; what follows the colon is a port only when it is digits and then the end or `/`, `?` or `#`.
fn has_scheme(text: &str) -> bool {
    let Some((head, rest)) = text.split_once(':') else {
        return false;
    };
    let mut letters = head.chars();
    let shaped = letters
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && letters.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    if !shaped {
        return false;
    }
    // The two schemes a website may have are never a host name, so `https:80` is not host `https` and port 80.
    if head.eq_ignore_ascii_case("http") || head.eq_ignore_ascii_case("https") {
        return true;
    }
    // Digits are ASCII, so the count is a character boundary.
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    let after = &rest[digits..];
    let is_port = digits > 0 && (after.is_empty() || after.starts_with(['/', '?', '#']));
    !is_port
}

/// A website as it is saved: trimmed, with `https://` in front when it has no scheme of its own, and only an `http` or
/// `https` address at all (`InvalidInput { what: "website" }` otherwise). One rule with [`web_url`], the one that decides
/// whether the shell opens it: whatever this answers, `web_url` parses. It allows only that shape: an empty address,
/// a control character anywhere (a parser would drop it silently), an address that starts with a slash (a network
/// path), and every other scheme are refused. The address is kept as typed, not rewritten.
pub fn normalise_url(text: &str) -> ShellResult<String> {
    let typed = text.trim();
    if typed.is_empty() || typed.chars().any(char::is_control) {
        return Err(NOT_A_WEBSITE);
    }
    let saved = match has_scheme(typed) {
        true => typed.to_owned(),
        false if typed.starts_with(['/', '\\']) => return Err(NOT_A_WEBSITE),
        false => format!("https://{typed}"),
    };
    // The address grew by `https://`: the page's limit counts what is saved.
    at_most(&saved, MAX_URL, "url")?;
    // The two shapes that pass: `http://…` or `https://…`, as written. A parser forgives more (`https:example.com`,
    // `http:/a`), but what is kept is what the person can read as an address.
    let starts = |scheme: &str| {
        saved
            .get(..scheme.len())
            .is_some_and(|start| start.eq_ignore_ascii_case(scheme))
    };
    if !(starts("http://") || starts("https://")) {
        return Err(NOT_A_WEBSITE);
    }
    web_url(&saved).ok_or(NOT_A_WEBSITE)?;
    Ok(saved)
}

/// The field `copy_field` copies: `"password"`, `"username"`, `"notes"`, `"key_value"` (a key's value), `{ "url": <index> }`,
/// the index into the login's links, or `{ "previous": <index> }`, one of the login's earlier passwords, newest first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CopyField {
    Password,
    Username,
    Url(u8),
    Notes,
    KeyValue,
    Previous(u8),
}

/// What `reveal_password` sends to the page: a login's `"password"`, a key's `"key_value"`, or `{ "previous": <index> }`,
/// one of a login's earlier passwords, newest first. Asked of the other kind it is refused, so no field gives a value its
/// kind does not have.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RevealField {
    Password,
    KeyValue,
    Previous(u8),
}

/// An item's user-editable fields, as the page sends them back. No `Debug`: it holds item content and maybe a
/// password.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ItemEdit {
    pub id: String,
    /// The revision the page read: a change made meanwhile makes the edit stale (`Core(InvalidInput)`).
    pub revision: u64,
    pub title: String,
    pub notes: Zeroizing<String>,
    /// The collection's ID; `None` takes the item out of its collection.
    pub collection: Option<String>,
    /// A login's fields; `None` keeps the stored one. Any of them on another kind is refused.
    pub username: Option<String>,
    pub password: Option<Zeroizing<String>>,
    pub urls: Option<Vec<String>>,
    /// A key's value; `None` keeps the stored one, byte for byte. Refused on any other kind. There is no field for a
    /// login's earlier passwords: only the engine writes that list, when a password really changes.
    pub key_value: Option<Zeroizing<String>>,
}

impl ItemEdit {
    /// The page's limits, checked before anything is written.
    fn check(&self) -> ShellResult<()> {
        at_most(&self.title, MAX_TITLE, "title")?;
        at_most(&self.notes, MAX_NOTES, "notes")?;
        if let Some(username) = &self.username {
            at_most(username, MAX_USERNAME, "username")?;
        }
        if let Some(password) = &self.password {
            at_most(password, MAX_PASSWORD, "password")?;
        }
        if let Some(value) = &self.key_value {
            at_most(value, MAX_KEY_VALUE, "value")?;
        }
        if let Some(urls) = &self.urls {
            if urls.len() > MAX_URLS {
                return Err(ShellError::TooLarge { what: "urls" });
            }
            for url in urls {
                at_most(url, MAX_URL, "url")?;
            }
        }
        Ok(())
    }

    /// The stored item `stored` with this edit's fields, for the engine's `update_item` (which keeps everything else
    /// from its own copy and refuses a stale revision).
    fn applied_to(self, mut stored: Item, collection: Option<ItemId>) -> ShellResult<Item> {
        let ItemEdit {
            id: _,
            revision,
            title,
            notes,
            collection: _,
            username,
            password,
            urls,
            key_value,
        } = self;
        let login_fields = username.is_some() || password.is_some() || urls.is_some();
        match &mut stored.kind {
            // The stored earlier passwords are left as they are: the engine moves the old password there when the new
            // one differs, and takes the list from its own copy whatever this item holds.
            ItemKind::Login {
                username: stored_username,
                password: stored_password,
                urls: stored_urls,
                ..
            } => {
                if key_value.is_some() {
                    return Err(NOT_A_KEY);
                }
                if let Some(username) = username {
                    *stored_username = username;
                }
                if let Some(password) = password {
                    *stored_password = password;
                }
                if let Some(urls) = urls {
                    *stored_urls = urls;
                }
            }
            ItemKind::Key { value } => {
                if login_fields {
                    return Err(NOT_A_LOGIN);
                }
                if let Some(new) = key_value {
                    *value = new;
                }
            }
            _ if login_fields => return Err(NOT_A_LOGIN),
            _ if key_value.is_some() => return Err(NOT_A_KEY),
            _ => {}
        }
        stored.revision = revision;
        stored.title = title;
        stored.notes = notes;
        stored.collection = collection;
        Ok(stored)
    }
}

/// A stored link the launcher may open: parsed, and only `http` or `https` (spec §4.2). Anything else, a link that
/// does not parse among them, is refused as `"link type"`.
fn web_link(stored: &str) -> ShellResult<Url> {
    web_url(stored).ok_or(ShellError::InvalidInput { what: "link type" })
}

impl Shell {
    /// Every item of the session's vault, and its damaged ones.
    pub fn list_items(&self, session: SessionId, generation: u64) -> ShellResult<Tagged<ItemList>> {
        self.sessions.read(session, generation, |vault, _| {
            let vault = items(&vault);
            let list = ItemList::of(vault.all(), vault.damaged());
            read_done()?;
            Ok(list)
        })
    }

    /// One item of the session's vault (an ID from another vault: `Core(NotFound)`).
    pub fn get_item(
        &self,
        session: SessionId,
        generation: u64,
        id: &str,
    ) -> ShellResult<Tagged<ItemDetail>> {
        let id = item_id(id)?;
        self.sessions.read(session, generation, |vault, _| {
            let detail = ItemDetail::of(items(&vault).item(&id)?);
            read_done()?;
            Ok(detail)
        })
    }

    /// A login's password or a key's value, on the user's "Reveal" (spec §4.1): the one command that sends either to the
    /// page. The field must be the item's own: `password` of a login, `key_value` of a key.
    pub fn reveal_password(
        &self,
        session: SessionId,
        generation: u64,
        id: &str,
        field: RevealField,
    ) -> ShellResult<Tagged<Zeroizing<String>>> {
        let id = item_id(id)?;
        self.sessions.read(session, generation, |vault, _| {
            let value = match (field, &items(&vault).item(&id)?.kind) {
                (RevealField::Password, ItemKind::Login { password, .. }) => password.clone(),
                (RevealField::KeyValue, ItemKind::Key { value }) => value.clone(),
                (
                    RevealField::Previous(index),
                    ItemKind::Login {
                        previous_passwords, ..
                    },
                ) => previous_passwords
                    .get(usize::from(index))
                    .ok_or(NO_SUCH_EARLIER)?
                    .password
                    .clone(),
                (RevealField::Password | RevealField::Previous(_), _) => return Err(NOT_A_LOGIN),
                (RevealField::KeyValue, _) => return Err(NOT_A_KEY),
            };
            read_done()?;
            Ok(value)
        })
    }

    /// Copies one field of an item to the clipboard (spec §7.3), entirely in Rust: the value never crosses to the
    /// page. Cleared after the clear delay, or when the session locks, while it is still on the clipboard.
    pub fn copy_field(
        &self,
        session: SessionId,
        generation: u64,
        id: &str,
        field: CopyField,
    ) -> ShellResult<Tagged<()>> {
        let id = item_id(id)?;
        let value = self.sessions.read(session, generation, |vault, _| {
            let item = items(&vault).item(&id)?;
            let value = match (field, &item.kind) {
                (CopyField::Notes, _) => item.notes.clone(),
                (CopyField::Password, ItemKind::Login { password, .. }) => password.clone(),
                (CopyField::KeyValue, ItemKind::Key { value }) => value.clone(),
                (CopyField::KeyValue, _) => return Err(NOT_A_KEY),
                (
                    CopyField::Previous(index),
                    ItemKind::Login {
                        previous_passwords, ..
                    },
                ) => previous_passwords
                    .get(usize::from(index))
                    .ok_or(NO_SUCH_EARLIER)?
                    .password
                    .clone(),
                (CopyField::Username, ItemKind::Login { username, .. }) => {
                    Zeroizing::new(username.clone())
                }
                (CopyField::Url(index), ItemKind::Login { urls, .. }) => {
                    let url = urls.get(usize::from(index)).ok_or(NO_SUCH_LINK)?;
                    Zeroizing::new(url.clone())
                }
                _ => return Err(NOT_A_LOGIN),
            };
            Ok(value)
        })?;
        self.clipboard
            .copy(&self.sessions, value.session, value.generation, value.data)?;
        // The generation once more before answering (spec §7.4): a lock after the write (whose hook clears the copy)
        // answers `Locked`, as `open_url` does.
        if !self.unlocked().contains(&(session, generation)) {
            return Err(ShellError::Locked);
        }
        Ok(Tagged {
            session,
            generation,
            data: (),
        })
    }

    /// A new item: its ID. Revision 0 until its first edit. With `fields` it starts whole and is written once.
    pub fn new_item(
        &self,
        session: SessionId,
        generation: u64,
        kind: NewKind,
        title: String,
        collection: Option<String>,
        fields: Option<ItemFields>,
    ) -> ShellResult<Tagged<String>> {
        // Every limit first, then the websites, then the session: nothing is written unless all of it holds.
        at_most(&title, MAX_TITLE, "title")?;
        if let Some(fields) = &fields {
            fields.check()?;
        }
        let collection = collection_id(collection.as_deref())?;
        // Each field belongs to a kind (see `ItemFields`): one sent for a kind with no use for it is refused, before
        // anything is written.
        let (kind, notes) = match (kind, fields) {
            (NewKind::Login, fields) => {
                let ItemFields {
                    username,
                    password,
                    urls,
                    notes,
                    value,
                } = fields.unwrap_or_default();
                if !value.is_empty() {
                    return Err(NOT_A_KEY);
                }
                let urls = urls.iter().map(|url| normalise_url(url));
                let urls = urls.collect::<ShellResult<Vec<String>>>()?;
                let login = ItemKind::Login {
                    username,
                    password,
                    urls,
                    previous_passwords: Vec::new(),
                };
                (login, notes)
            }
            (NewKind::Key, fields) => {
                let ItemFields {
                    username,
                    password,
                    urls,
                    notes,
                    value,
                } = fields.unwrap_or_default();
                if !username.is_empty() || !password.is_empty() || !urls.is_empty() {
                    return Err(NOT_A_LOGIN);
                }
                (ItemKind::Key { value }, notes)
            }
            (NewKind::Note, fields) => {
                let ItemFields {
                    username,
                    password,
                    urls,
                    notes,
                    value,
                } = fields.unwrap_or_default();
                if !username.is_empty() || !password.is_empty() || !urls.is_empty() {
                    return Err(NOT_A_LOGIN);
                }
                if !value.is_empty() {
                    return Err(NOT_A_KEY);
                }
                (ItemKind::Note, notes)
            }
            // A folder has a name and nothing else: any fields sent for one are refused.
            (NewKind::Collection, None) => (ItemKind::Collection, Zeroizing::default()),
            (NewKind::Collection, Some(_)) => return Err(NOT_A_LOGIN),
        };
        let title = match kind {
            ItemKind::Collection => folder_name(&title)?,
            _ => title,
        };
        self.sessions.write(session, generation, |vault, _| {
            Ok(vault
                .new_item_with_notes(kind, &title, collection, notes)?
                .to_hex())
        })
    }

    pub fn update_item(
        &self,
        session: SessionId,
        generation: u64,
        mut edit: ItemEdit,
    ) -> ShellResult<Tagged<()>> {
        edit.check()?;
        // Websites are completed and checked as a new login's are, before anything is written.
        edit.urls = edit
            .urls
            .take()
            .map(|urls| urls.iter().map(|url| normalise_url(url)).collect())
            .transpose()?;
        let id = item_id(&edit.id)?;
        let collection = collection_id(edit.collection.as_deref())?;
        self.sessions.write(session, generation, |vault, _| {
            let stored = vault.get_item(&id)?.clone();
            // A folder's new name is trimmed and never empty, as a new folder's.
            if matches!(stored.kind, ItemKind::Collection) {
                edit.title = folder_name(&edit.title)?;
            }
            let next = edit.applied_to(stored, collection)?;
            Ok(vault.update_item(next)?)
        })
    }

    /// Runs `change` on the item `id` of the session's writable vault.
    fn change_item<T>(
        &self,
        session: SessionId,
        generation: u64,
        id: &str,
        change: impl FnOnce(&mut Vault, &ItemId) -> CoreResult<T>,
    ) -> ShellResult<Tagged<T>> {
        let id = item_id(id)?;
        self.sessions
            .write(session, generation, |vault, _| Ok(change(vault, &id)?))
    }

    pub fn trash_item(
        &self,
        session: SessionId,
        generation: u64,
        id: &str,
    ) -> ShellResult<Tagged<()>> {
        self.change_item(session, generation, id, Vault::trash_item)
    }

    /// Takes an item out of the trash, and its collection with it.
    pub fn restore_item(
        &self,
        session: SessionId,
        generation: u64,
        id: &str,
    ) -> ShellResult<Tagged<()>> {
        self.change_item(session, generation, id, Vault::restore_item)
    }

    /// Moves a collection and its items to the trash: how many items went with it.
    pub fn delete_collection(
        &self,
        session: SessionId,
        generation: u64,
        id: &str,
    ) -> ShellResult<Tagged<usize>> {
        self.change_item(session, generation, id, Vault::delete_collection)
    }

    /// Deletes a trashed item and its files for good, once the page has asked the user.
    pub fn purge_item(
        &self,
        session: SessionId,
        generation: u64,
        id: &str,
    ) -> ShellResult<Tagged<()>> {
        self.change_item(session, generation, id, Vault::purge_item)
    }

    /// The items in the trash for more than `days` days, for "Delete permanently?" (spec §6.1). Lists only: Lockbox
    /// never purges by itself.
    pub fn old_trash(
        &self,
        session: SessionId,
        generation: u64,
        days: u32,
    ) -> ShellResult<Tagged<Vec<String>>> {
        self.sessions.read(session, generation, |vault, _| {
            let old = writable(&vault)?.trash_older_than(days);
            Ok(old.iter().map(ItemId::to_hex).collect())
        })
    }

    /// Each unlocked session with its current generation, read in one step.
    pub(super) fn unlocked(&self) -> Vec<(SessionId, u64)> {
        let sessions = self.sessions.list().into_iter();
        sessions
            .filter(|info| info.state == SessionState::Unlocked)
            .map(|info| (info.session, info.generation))
            .collect()
    }

    /// Searches every unlocked vault (Ctrl+K): one answer per vault, tagged with its generation, and the vaults that
    /// were busy (a long change held them past the short wait; any other refusal is counted there too, never
    /// hidden). A vault that locks while the search runs is in neither: once every vault was searched, every answer
    /// is checked again in one step, so nothing read before a lock is returned after it (§9). The page checks each
    /// answer's generation as well.
    pub fn search_all(&self, query: &str) -> ShellResult<SearchResults> {
        if query.chars().count() > MAX_QUERY_CHARS {
            return Err(ShellError::TooLarge { what: "search" });
        }
        let (mut hits, mut busy) = (Vec::new(), Vec::new());
        for (session, generation) in self.unlocked() {
            let answer = self.sessions.read(session, generation, |vault, _| {
                let vault = items(&vault);
                let ids = vault.find(query, SEARCH_LIMIT);
                let found = ids.iter().filter_map(|id| vault.item(id).ok());
                let summaries = found.map(ItemSummary::of).collect();
                read_done()?;
                Ok(summaries)
            });
            match answer {
                Ok(tagged) => hits.push(tagged),
                // Locked since the list was read, or gone: left out.
                Err(ShellError::Locked | ShellError::NotFound) => {}
                Err(_) => busy.push((session, generation)),
            }
        }
        let current = self.unlocked();
        hits.retain(|tagged: &Tagged<_>| current.contains(&(tagged.session, tagged.generation)));
        busy.retain(|asked| current.contains(asked));
        Ok(SearchResults {
            hits,
            busy: busy.into_iter().map(|(session, _)| session).collect(),
        })
    }

    /// Opens the login's link number `index` in the default browser, only an `http` or `https` one (spec §4.2). The
    /// launch happens after the session is let go (it may wait for Windows); the generation is checked once more after
    /// it, so a lock during the launch answers `Locked`.
    pub fn open_url(
        &self,
        session: SessionId,
        generation: u64,
        id: &str,
        index: usize,
    ) -> ShellResult<Tagged<()>> {
        let id = item_id(id)?;
        let link = self.sessions.read(session, generation, |vault, _| {
            let stored = match &items(&vault).item(&id)?.kind {
                ItemKind::Login { urls, .. } => urls.get(index),
                _ => None,
            };
            web_link(stored.ok_or(ShellError::NotFound)?)
        })?;
        self.os.launcher.open_url(&link.data)?;
        if !self.unlocked().contains(&(link.session, link.generation)) {
            return Err(ShellError::Locked);
        }
        Ok(Tagged {
            session: link.session,
            generation: link.generation,
            data: (),
        })
    }

    /// The vault's quarantined files no item references (spec §6.4).
    pub fn list_orphans(
        &self,
        session: SessionId,
        generation: u64,
    ) -> ShellResult<Tagged<Vec<OrphanView>>> {
        self.sessions.read(session, generation, |vault, _| {
            let orphans = writable(&vault)?.orphans()?;
            Ok(orphans.iter().map(OrphanView::of).collect())
        })
    }

    /// Deletes the quarantined files for good, once the page has asked the user: how many.
    pub fn delete_orphans(
        &self,
        session: SessionId,
        generation: u64,
    ) -> ShellResult<Tagged<usize>> {
        self.sessions
            .write(session, generation, |vault, _| Ok(vault.delete_orphans()?))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionArgs {
    session: SessionId,
    generation: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ItemArgs {
    session: SessionId,
    generation: u64,
    id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RevealArgs {
    session: SessionId,
    generation: u64,
    id: String,
    field: RevealField,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CopyFieldArgs {
    session: SessionId,
    generation: u64,
    id: String,
    field: CopyField,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NewItemArgs {
    session: SessionId,
    generation: u64,
    kind: NewKind,
    title: String,
    collection: Option<String>,
    fields: Option<ItemFields>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateItem {
    session: SessionId,
    generation: u64,
    edit: ItemEdit,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OldTrash {
    session: SessionId,
    generation: u64,
    days: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchAll {
    query: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenUrl {
    session: SessionId,
    generation: u64,
    id: String,
    index: usize,
}

#[tauri::command]
pub(super) async fn list_items(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<ItemList>> {
    let SessionArgs {
        session,
        generation,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.list_items(session, generation)).await
}

#[tauri::command]
pub(super) async fn get_item(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<ItemDetail>> {
    let ItemArgs {
        session,
        generation,
        id,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.get_item(session, generation, &id)).await
}

#[tauri::command]
pub(super) async fn reveal_password(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<Zeroizing<String>>> {
    let RevealArgs {
        session,
        generation,
        id,
        field,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.reveal_password(session, generation, &id, field)).await
}

#[tauri::command]
pub(super) async fn copy_field(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<()>> {
    let CopyFieldArgs {
        session,
        generation,
        id,
        field,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.copy_field(session, generation, &id, field)).await
}

#[tauri::command]
pub(super) async fn new_item(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<String>> {
    let NewItemArgs {
        session,
        generation,
        kind,
        title,
        collection,
        fields,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.new_item(session, generation, kind, title, collection, fields)).await
}

#[tauri::command]
pub(super) async fn update_item(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<()>> {
    let UpdateItem {
        session,
        generation,
        edit,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.update_item(session, generation, edit)).await
}

#[tauri::command]
pub(super) async fn trash_item(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<()>> {
    let ItemArgs {
        session,
        generation,
        id,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.trash_item(session, generation, &id)).await
}

#[tauri::command]
pub(super) async fn restore_item(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<()>> {
    let ItemArgs {
        session,
        generation,
        id,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.restore_item(session, generation, &id)).await
}

#[tauri::command]
pub(super) async fn delete_collection(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<usize>> {
    let ItemArgs {
        session,
        generation,
        id,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.delete_collection(session, generation, &id)).await
}

#[tauri::command]
pub(super) async fn purge_item(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<()>> {
    let ItemArgs {
        session,
        generation,
        id,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.purge_item(session, generation, &id)).await
}

#[tauri::command]
pub(super) async fn old_trash(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<Vec<String>>> {
    let OldTrash {
        session,
        generation,
        days,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.old_trash(session, generation, days)).await
}

#[tauri::command]
pub(super) async fn search_all(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<SearchResults> {
    let SearchAll { query } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.search_all(&query)).await
}

#[tauri::command]
pub(super) async fn open_url(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<()>> {
    let OpenUrl {
        session,
        generation,
        id,
        index,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.open_url(session, generation, &id, index)).await
}

#[tauri::command]
pub(super) async fn list_orphans(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<Vec<OrphanView>>> {
    let SessionArgs {
        session,
        generation,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.list_orphans(session, generation)).await
}

#[tauri::command]
pub(super) async fn delete_orphans(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<usize>> {
    let SessionArgs {
        session,
        generation,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.delete_orphans(session, generation)).await
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::rc::Rc;
    use std::sync::{Arc, mpsc};
    use std::thread;
    use std::time::Duration;

    use lockbox_core::blob::CancelToken;
    use lockbox_core::ids::{FileId, ItemId, VaultId};
    use lockbox_core::internals::fsio::failpoint;
    use lockbox_core::internals::header::parse_header;
    use lockbox_core::internals::item::{FileRefParts, file_key, open_item, seal_item};
    use lockbox_core::internals::kdf::derive_password_key;
    use lockbox_core::internals::secret::Key32;
    use lockbox_core::internals::slots::{SlotType, unwrap_slot};
    use lockbox_core::item::{Item, ItemKind};
    use lockbox_core::{CoreError, Credential, ReadOnlyVault};
    use serde_json::{Value, json};
    use tauri::ipc::InvokeBody;
    use zeroize::Zeroizing;

    use super::super::{MALFORMED, parse};
    use super::*;
    use crate::error::{Outcome, ShellError};
    use crate::os::{Clock, EXCLUSION_FORMATS};
    use crate::session::{Location, LockReason, OpenStep, Opened, SessionId};
    use crate::testing::{TestShell, heavy};
    use crate::views::{ItemDetail, ItemList, ItemSummary, SearchResults};

    const PW: &str = "correct horse battery";
    /// How long a test thread waits for the other before it fails instead of hanging.
    const GIVE_UP: Duration = Duration::from_secs(60);
    /// The login's password: it must never reach a view.
    const LOGIN_PW: &str = "Pw-0123456789-xyz";

    fn secret(text: &str) -> Zeroizing<String> {
        Zeroizing::new(text.to_owned())
    }

    /// A new vault named `name`, created and unlocked through the shell: its session and generation.
    fn open_vault(ts: &TestShell, name: &str) -> (SessionId, u64) {
        let created = heavy(|| ts.shell.create_vault(name.into(), secret(PW), false));
        let Outcome::Done(tagged) = created.unwrap() else {
            panic!("the vault did not open");
        };
        (tagged.session, tagged.generation)
    }

    /// The folder of the `n`th vault on the vault list.
    fn vault_dir(ts: &TestShell, n: usize) -> PathBuf {
        ts.shell.registry.entries()[n].1.clone()
    }

    /// An edit of the item `id` at `revision`: a title, notes, a username, one link and `password`.
    fn edit(id: &str, revision: u64, title: &str, password: Option<&str>) -> ItemEdit {
        ItemEdit {
            id: id.to_owned(),
            revision,
            title: title.to_owned(),
            notes: secret("a note"),
            collection: None,
            username: Some("ada@example.com".to_owned()),
            password: password.map(secret),
            urls: Some(vec!["https://bank.example".to_owned()]),
            key_value: None,
        }
    }

    /// A login titled `title` with [`LOGIN_PW`] as its password, at revision 1: its ID.
    fn login(ts: &TestShell, session: SessionId, generation: u64, title: &str) -> String {
        let id = ts
            .shell
            .new_item(
                session,
                generation,
                NewKind::Login,
                title.to_owned(),
                None,
                None,
            )
            .unwrap()
            .data;
        ts.shell
            .update_item(session, generation, edit(&id, 0, title, Some(LOGIN_PW)))
            .unwrap();
        id
    }

    fn item_file(ts: &TestShell, n: usize, id: &str) -> PathBuf {
        vault_dir(ts, n).join("items").join(format!("{id}.item"))
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Standard padded base64, the item format's encoding of a file key and a nonce prefix.
    fn base64(bytes: &[u8]) -> String {
        const DIGITS: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let at = |i: usize| u32::from(chunk.get(i).copied().unwrap_or(0));
            let n = at(0) << 16 | at(1) << 8 | at(2);
            for i in 0..4 {
                match i <= chunk.len() {
                    true => out.push(char::from(DIGITS[(n >> (18 - 6 * i)) as usize & 63])),
                    false => out.push('='),
                }
            }
        }
        out
    }

    /// Fails when `json` holds the login's password, or `bytes` (a key or a nonce prefix) in hex or base64.
    fn assert_clean(json: &str, bytes: &[&[u8]]) {
        assert!(!json.contains(LOGIN_PW), "a view holds the password");
        for secret in bytes {
            assert!(!json.contains(&hex(secret)), "a view holds a key in hex");
            assert!(
                !json.contains(&base64(secret)),
                "a view holds a key in base64"
            );
        }
        for field in ["\"file_key\"", "\"nonce_prefix\"", "\"password\""] {
            assert!(!json.contains(field), "a view has a {field} field");
        }
    }

    /// Review Focus 2: no view carries a password, a file key or a nonce.
    #[test]
    fn views_never_carry_keys_or_unrevealed_password() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let id = login(&ts, s, g, "Bank");
        let src = ts.temp.path().join("statement.pdf");
        fs::write(&src, b"statement").unwrap();
        let item_id = ItemId::from_hex(&id).unwrap();
        let (file_id, key) = ts
            .shell
            .sessions
            .write(s, g, |vault, cancel| {
                let file_id = vault.attach_file(&item_id, &src, cancel)?;
                let item = vault.get_item(&item_id)?;
                Ok((file_id, *file_key(&item.attachments[0]).as_bytes()))
            })
            .unwrap()
            .data;

        let list = serde_json::to_value(ts.shell.list_items(s, g).unwrap()).unwrap();
        let detail = serde_json::to_value(ts.shell.get_item(s, g, &id).unwrap()).unwrap();
        let found = serde_json::to_value(ts.shell.search_all("Bank").unwrap()).unwrap();
        for json in [&list, &detail, &found] {
            assert_clean(&json.to_string(), &[&key]);
        }
        // Every field and value, whatever a secret's encoding would be: an added field fails here. The two dates are
        // the item's own, read back from the list (`summary_carries_dates` pins what they are).
        let item_dates = &list["data"]["items"][0];
        let summary = json!({
            "id": id, "kind": "login", "title": "Bank", "username": "ada@example.com", "collection": null,
            "trashed": false, "trashed_at": null, "trashed_with": null, "purging": false, "site": "bank.example",
            "created_at": item_dates["created_at"], "modified_at": item_dates["modified_at"],
            "attachments": [{
                "file_id": file_id.to_hex(), "name": "statement.pdf", "length": 9,
                "media_type": "application/octet-stream",
            }],
        });
        let tagged = |data: Value| json!({ "session": s.0, "generation": g, "data": data });
        assert_eq!(list, tagged(json!({ "items": [summary], "damaged": [] })));
        assert_eq!(
            detail,
            tagged(json!({
                "summary": summary, "revision": 2, "notes": "a note", "urls": ["https://bank.example"],
                "has_password": true, "has_value": false, "previous": [],
            }))
        );
        assert_eq!(
            found,
            json!({ "hits": [tagged(json!([summary]))], "busy": [] })
        );

        // The nonce prefix is never shown by the engine: an item built by hand, with a known key and prefix.
        let (file_key, nonce) = ([0xC3; 32], [0x5A; 19]);
        let item = Item {
            id: ItemId([7; 16]),
            kind: ItemKind::Login {
                username: "ada".into(),
                password: secret(LOGIN_PW),
                urls: vec!["https://bank.example".into()],
                previous_passwords: Vec::new(),
            },
            title: "Bank".into(),
            notes: secret("a note"),
            collection: None,
            attachments: vec![
                FileRefParts {
                    file_id: FileId([9; 16]),
                    blob_version: 1,
                    chunk_size: 1_048_576,
                    file_key: Key32::from_bytes(file_key),
                    nonce_prefix: nonce,
                    length: 9,
                    chunk_count: 1,
                    name: "statement.pdf".into(),
                    media_type: "application/pdf".into(),
                }
                .into(),
            ],
            revision: 1,
            created_at: "2026-10-29T00:00:00Z".into(),
            modified_at: "2026-10-29T00:00:00Z".into(),
            trashed_at: None,
            trashed_with: None,
            purging: false,
            retired_blobs: Vec::new(),
        };
        let summary = serde_json::to_value(ItemSummary::of(&item)).unwrap();
        let detail = serde_json::to_value(ItemDetail::of(&item)).unwrap();
        let list = serde_json::to_value(ItemList::of([&item].into_iter(), &[item.id])).unwrap();
        for json in [&summary, &detail, &list] {
            assert_clean(&json.to_string(), &[&file_key, &nonce]);
        }
        let expected = json!({
            "id": "07".repeat(16), "kind": "login", "title": "Bank", "username": "ada", "collection": null,
            "trashed": false, "trashed_at": null, "trashed_with": null, "purging": false, "site": "bank.example",
            "created_at": "2026-10-29T00:00:00Z", "modified_at": "2026-10-29T00:00:00Z",
            "attachments": [{
                "file_id": "09".repeat(16), "name": "statement.pdf", "length": 9,
                "media_type": "application/pdf",
            }],
        });
        assert_eq!(summary, expected);
        assert_eq!(
            detail,
            json!({
                "summary": expected, "revision": 1, "notes": "a note", "urls": ["https://bank.example"],
                "has_password": true, "has_value": false, "previous": [],
            })
        );
        assert_eq!(
            list,
            json!({ "items": [expected], "damaged": ["07".repeat(16)] })
        );
    }

    /// The list, a single item and a search carry the item's two dates, as the engine keeps them (RFC 3339, UTC, whole
    /// seconds), so the page can say when an item changed.
    #[test]
    fn summary_carries_dates() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let id = login(&ts, s, g, "Bank");
        let item_id = ItemId::from_hex(&id).unwrap();
        let (created, modified) = ts
            .shell
            .sessions
            .read(s, g, |vault, _| {
                let item = items(&vault).item(&item_id)?;
                Ok((item.created_at.clone(), item.modified_at.clone()))
            })
            .unwrap()
            .data;
        assert!(created.ends_with('Z') && modified.ends_with('Z'));
        assert!(created <= modified);

        let list = serde_json::to_value(ts.shell.list_items(s, g).unwrap()).unwrap();
        let detail = serde_json::to_value(ts.shell.get_item(s, g, &id).unwrap()).unwrap();
        let found = serde_json::to_value(ts.shell.search_all("Bank").unwrap()).unwrap();
        for summary in [
            &list["data"]["items"][0],
            &detail["data"]["summary"],
            &found["hits"][0]["data"][0],
        ] {
            assert_eq!(summary["created_at"], json!(created));
            assert_eq!(summary["modified_at"], json!(modified));
        }

        // A hand-built item: the view copies both strings as they are.
        let item = Item {
            id: ItemId([7; 16]),
            kind: ItemKind::Note,
            title: "Diary".into(),
            notes: secret(""),
            collection: None,
            attachments: Vec::new(),
            revision: 1,
            created_at: "2026-01-02T03:04:05Z".into(),
            modified_at: "2026-02-03T04:05:06Z".into(),
            trashed_at: None,
            trashed_with: None,
            purging: false,
            retired_blobs: Vec::new(),
        };
        let summary = serde_json::to_value(ItemSummary::of(&item)).unwrap();
        assert_eq!(summary["created_at"], "2026-01-02T03:04:05Z");
        assert_eq!(summary["modified_at"], "2026-02-03T04:05:06Z");
    }

    #[test]
    fn reveal_returns_password_tagged() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let id = login(&ts, s, g, "Bank");
        let revealed = ts
            .shell
            .reveal_password(s, g, &id, RevealField::Password)
            .unwrap();
        assert_eq!((revealed.session, revealed.generation), (s, g));
        assert_eq!(revealed.data.as_str(), LOGIN_PW);
        assert_eq!(
            serde_json::to_value(&revealed).unwrap(),
            json!({ "session": s.0, "generation": g, "data": LOGIN_PW })
        );
        // A note has no password to reveal.
        let note = ts
            .shell
            .new_item(s, g, NewKind::Note, "Diary".into(), None, None)
            .unwrap()
            .data;
        assert_eq!(
            ts.shell
                .reveal_password(s, g, &note, RevealField::Password)
                .err(),
            Some(NOT_A_LOGIN)
        );
    }

    /// An item of vault B, sent with vault A's session, is refused by every command that names an item.
    #[test]
    fn foreign_item_id_refused() {
        let ts = TestShell::new();
        let (a, ga) = open_vault(&ts, "Family");
        let (b, gb) = open_vault(&ts, "Work");
        let foreign = login(&ts, b, gb, "Bank");
        let not_found = Some(ShellError::from(CoreError::NotFound));
        let shell = &ts.shell;
        assert_eq!(shell.get_item(a, ga, &foreign).err(), not_found);
        for field in [RevealField::Password, RevealField::KeyValue] {
            assert_eq!(
                shell.reveal_password(a, ga, &foreign, field).err(),
                not_found
            );
        }
        assert_eq!(
            shell
                .update_item(a, ga, edit(&foreign, 1, "Mine now", None))
                .err(),
            not_found
        );
        assert_eq!(shell.trash_item(a, ga, &foreign).err(), not_found);
        assert_eq!(shell.restore_item(a, ga, &foreign).err(), not_found);
        assert_eq!(shell.purge_item(a, ga, &foreign).err(), not_found);
        assert_eq!(shell.delete_collection(a, ga, &foreign).err(), not_found);
        assert_eq!(shell.open_url(a, ga, &foreign, 0).err(), not_found);
        assert!(ts.launcher.opened().is_empty());
        // Untouched in its own vault.
        let detail = shell.get_item(b, gb, &foreign).unwrap().data;
        assert_eq!(
            (detail.summary.title.as_str(), detail.revision),
            ("Bank", 1)
        );
        assert!(!detail.summary.trashed);
    }

    #[test]
    fn edit_keeps_password_when_none() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let id = login(&ts, s, g, "Bank");
        ts.shell
            .update_item(s, g, edit(&id, 1, "Bank (old)", None))
            .unwrap();
        assert_eq!(revealed(&ts, s, g, &id).as_str(), LOGIN_PW);
        let detail = ts.shell.get_item(s, g, &id).unwrap().data;
        assert_eq!(detail.summary.title, "Bank (old)");
        assert_eq!(detail.revision, 2);
        assert!(detail.has_password);
        // A new password replaces it.
        ts.shell
            .update_item(s, g, edit(&id, 2, "Bank", Some("another one")))
            .unwrap();
        assert_eq!(revealed(&ts, s, g, &id).as_str(), "another one");
    }

    #[test]
    fn stale_revision_refused() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let id = login(&ts, s, g, "Bank");
        let before = fs::read(item_file(&ts, 0, &id)).unwrap();
        let stale = ts.shell.update_item(s, g, edit(&id, 0, "Other", Some("x")));
        assert_eq!(
            stale.err(),
            Some(
                CoreError::InvalidInput {
                    what: "stale revision"
                }
                .into()
            )
        );
        assert_eq!(fs::read(item_file(&ts, 0, &id)).unwrap(), before);
        let detail = ts.shell.get_item(s, g, &id).unwrap().data;
        assert_eq!(
            (detail.summary.title.as_str(), detail.revision),
            ("Bank", 1)
        );
    }

    /// §8: a damaged item shows as damaged; the rest of the vault works.
    #[test]
    fn damaged_items_listed() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let good = login(&ts, s, g, "Bank");
        let bad = login(&ts, s, g, "Mail");
        let (registry_id, _) = ts.shell.registry.entries()[0].clone();
        ts.shell.sessions.lock_all(LockReason::Manual);
        let file = item_file(&ts, 0, &bad);
        let mut bytes = fs::read(&file).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        fs::write(&file, bytes).unwrap();

        let unlocked = heavy(|| ts.shell.unlock_vault(registry_id, secret(PW))).unwrap();
        let list = ts
            .shell
            .list_items(unlocked.session, unlocked.generation)
            .unwrap()
            .data;
        assert_eq!(list.damaged, std::slice::from_ref(&bad));
        let ids: Vec<&str> = list.items.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, [good.as_str()]);
        assert_eq!(
            ts.shell
                .get_item(unlocked.session, unlocked.generation, &bad)
                .err(),
            Some(CoreError::NotFound.into())
        );
    }

    #[test]
    fn limits_table() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let id = login(&ts, s, g, "Bank");
        let file = item_file(&ts, 0, &id);
        let before = fs::read(&file).unwrap();
        let too_large = |what| Some(ShellError::TooLarge { what });
        // Every limit but the query's counts bytes: each is tried in ASCII and in "é" (2 bytes, 1 character), where
        // one byte over the limit is far fewer characters than the limit.
        for unit in ["a", "é"] {
            let long = |n: usize| bytes_of(unit, n);
            let over: [(ItemEdit, &str); 6] = [
                (
                    ItemEdit {
                        title: long(1025),
                        ..edit(&id, 1, "", None)
                    },
                    "title",
                ),
                (
                    ItemEdit {
                        username: Some(long(1025)),
                        ..edit(&id, 1, "Bank", None)
                    },
                    "username",
                ),
                (
                    ItemEdit {
                        urls: Some(vec![long(2049)]),
                        ..edit(&id, 1, "Bank", None)
                    },
                    "url",
                ),
                (
                    ItemEdit {
                        urls: Some(vec!["https://a.example".to_owned(); 33]),
                        ..edit(&id, 1, "Bank", None)
                    },
                    "urls",
                ),
                (
                    ItemEdit {
                        notes: secret(&long(524_289)),
                        ..edit(&id, 1, "Bank", None)
                    },
                    "notes",
                ),
                (edit(&id, 1, "Bank", Some(&long(4097))), "password"),
            ];
            for (change, what) in over {
                assert_eq!(
                    ts.shell.update_item(s, g, change).err(),
                    too_large(what),
                    "{what} in {unit}"
                );
            }
            // A new item's title, a collection's name among them.
            for kind in [NewKind::Note, NewKind::Collection] {
                assert_eq!(
                    ts.shell.new_item(s, g, kind, long(1025), None, None).err(),
                    too_large("title"),
                    "{kind:?} in {unit}"
                );
            }
        }
        // The query counts characters, not bytes.
        assert_eq!(
            ts.shell.search_all(&"a".repeat(257)).err(),
            too_large("search")
        );
        assert_eq!(
            ts.shell.search_all(&"é".repeat(257)).err(),
            too_large("search")
        );
        assert!(ts.shell.search_all(&"é".repeat(256)).is_ok());

        // Nothing was written.
        assert_eq!(fs::read(&file).unwrap(), before);
        let list = ts.shell.list_items(s, g).unwrap().data;
        assert_eq!(list.items.len(), 1);
        assert_eq!(ts.shell.get_item(s, g, &id).unwrap().data.revision, 1);

        // Every field at its limit is saved (well under the engine's 1 MiB item cap), in both units.
        for (revision, unit) in [(1, "a"), (2, "é")] {
            let long = |n: usize| bytes_of(unit, n);
            let full = ItemEdit {
                id: id.clone(),
                revision,
                title: long(1024),
                notes: secret(&long(524_288)),
                collection: None,
                username: Some(long(1024)),
                password: Some(secret(&long(4096))),
                // A web address at the limit: the shell completes and checks a website, so it has to be one.
                urls: Some(vec![format!("https://a.example/{}", long(2048 - 18)); 32]),
                key_value: None,
            };
            ts.shell.update_item(s, g, full).unwrap();
            let detail = ts.shell.get_item(s, g, &id).unwrap().data;
            assert_eq!((detail.revision, detail.urls.len()), (revision + 1, 32));
            assert_eq!(detail.notes.len(), 524_288);
            assert!(detail.summary.title.starts_with(unit));
            let collection = ts
                .shell
                .new_item(s, g, NewKind::Collection, long(1024), None, None)
                .unwrap();
            assert_eq!(collection.session, s);
        }
    }

    /// `n` bytes of `unit` repeated, made up with one `a` when `unit`'s length does not divide `n`.
    fn bytes_of(unit: &str, n: usize) -> String {
        let mut text = unit.repeat(n / unit.len());
        while text.len() < n {
            text.push('a');
        }
        text
    }

    /// §9: a lock between the vault work and the answer returns no data. The lock lands at the read's last step
    /// ([`READ_DONE`]), after the password or the search results were taken from the vault.
    #[test]
    fn lock_during_search_and_reveal() {
        let ts = TestShell::new();
        let (family, gf) = open_vault(&ts, "Family");
        let id = login(&ts, family, gf, "Bank");

        let shell = Arc::clone(&ts.shell);
        failpoint::observe(
            READ_DONE,
            Box::new(move || shell.sessions.lock_all(LockReason::WindowsLocked)),
        );
        let revealed = ts
            .shell
            .reveal_password(family, gf, &id, RevealField::Password);
        failpoint::disarm_all();
        assert_eq!(revealed.err(), Some(ShellError::Locked));

        // Two vaults with a match each, Family searched first, then Work.
        let (registry_id, _) = ts.shell.registry.entries()[0].clone();
        let unlock_family = || {
            heavy(|| ts.shell.unlock_vault(registry_id, secret(PW)))
                .unwrap()
                .session
        };
        let family = unlock_family();
        let (work, gw) = open_vault(&ts, "Work");
        login(&ts, work, gw, "Bank");
        let hits = |found: &SearchResults| -> Vec<SessionId> {
            found.hits.iter().map(|tagged| tagged.session).collect()
        };

        // Family locks during its own search: nothing from it.
        let shell = Arc::clone(&ts.shell);
        let found = search_locking(&ts, 1, move || {
            shell.sessions.lock(family, LockReason::Manual)
        });
        assert_eq!(hits(&found), [work], "nothing from the vault that locked");

        // Family locks after its search, during Work's: its hits, already collected, are dropped; Work's kept.
        unlock_family();
        let shell = Arc::clone(&ts.shell);
        let found = search_locking(&ts, 2, move || {
            shell.sessions.lock(family, LockReason::Manual)
        });
        assert_eq!(hits(&found), [work], "nothing read before the lock");
        assert!(found.busy.is_empty());

        // Every vault locks during the second search: nothing at all, the first vault's hits included.
        unlock_family();
        let shell = Arc::clone(&ts.shell);
        let found = search_locking(&ts, 2, move || {
            shell.sessions.lock_all(LockReason::WindowsLocked)
        });
        assert!(found.hits.is_empty());
        assert!(found.busy.is_empty());
    }

    /// Searches every vault for "Bank", running `lock` at the end of the `at`th vault's read; both vaults read.
    fn search_locking(ts: &TestShell, at: usize, lock: impl Fn() + 'static) -> SearchResults {
        let searched = Rc::new(Cell::new(0));
        let count = Rc::clone(&searched);
        failpoint::observe(
            READ_DONE,
            Box::new(move || {
                count.set(count.get() + 1);
                if count.get() == at {
                    lock();
                }
            }),
        );
        let found = ts.shell.search_all("Bank");
        failpoint::disarm_all();
        assert_eq!(searched.get(), 2, "both vaults were searched");
        found.unwrap()
    }

    /// A vault held by a long change past the short wait is reported busy, never silently left out.
    #[test]
    fn search_all_reports_busy_vaults() {
        let ts = TestShell::new();
        let (family, gf) = open_vault(&ts, "Family");
        let (work, gw) = open_vault(&ts, "Work");
        login(&ts, family, gf, "Bank");
        login(&ts, work, gw, "Bank");
        let (held, is_held) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        let shell = &ts.shell;
        let found = thread::scope(|scope| {
            let holder = scope.spawn(move || {
                shell.sessions.write_long(family, gf, |_, _| {
                    held.send(()).unwrap();
                    released.recv_timeout(GIVE_UP).unwrap();
                    Ok(())
                })
            });
            is_held.recv_timeout(GIVE_UP).expect("the change started");
            let found = shell.search_all("Bank");
            release.send(()).unwrap();
            assert!(holder.join().unwrap().is_ok());
            found.unwrap()
        });
        assert_eq!(found.busy, [family]);
        let hits: Vec<SessionId> = found.hits.iter().map(|tagged| tagged.session).collect();
        assert_eq!(hits, [work]);
        assert_eq!(found.hits[0].data.len(), 1);
    }

    #[test]
    fn search_all_skips_locked_sessions() {
        let ts = TestShell::new();
        let (family, gf) = open_vault(&ts, "Family");
        let (work, gw) = open_vault(&ts, "Work");
        login(&ts, family, gf, "Bank");
        let work_bank = login(&ts, work, gw, "Bank");
        ts.shell
            .new_item(work, gw, NewKind::Note, "Mail".into(), None, None)
            .unwrap();

        let found = ts.shell.search_all("bank").unwrap();
        assert_eq!(found.hits.len(), 2);

        ts.shell.sessions.lock(family, LockReason::Manual);
        let found = ts.shell.search_all("bank").unwrap().hits;
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].session, found[0].generation), (work, gw));
        let ids: Vec<&str> = found[0].data.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, [work_bank.as_str()]);
    }

    /// Spec §4.2: only `http` and `https` links open, and the launcher gets the parsed URL, never the stored text.
    #[test]
    fn only_http_and_https_urls_open() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let id = login(&ts, s, g, "Links");
        let links = [
            "https://a.example",
            "http://b.example/a b",
            "file:///C:/x",
            "javascript:x",
            "ms-settings:",
            r"\\server\s",
            r"C:\x.exe",
            "mailto:a@b",
        ];
        // An edit only saves web addresses now, so the others are put in the way an older Lockbox or another program could
        // have left them: straight through the engine. `open_url` must refuse them whatever wrote them.
        let urls: Vec<String> = links.iter().map(|link| link.to_string()).collect();
        ts.shell
            .sessions
            .write(s, g, |vault, _| {
                let id = ItemId::from_hex(&id).unwrap();
                let mut item = vault.get_item(&id)?.clone();
                if let ItemKind::Login { urls: stored, .. } = &mut item.kind {
                    *stored = urls;
                }
                Ok(vault.update_item(item)?)
            })
            .unwrap();

        let opened = ts.shell.open_url(s, g, &id, 0).unwrap();
        assert_eq!((opened.session, opened.generation), (s, g));
        ts.shell.open_url(s, g, &id, 1).unwrap();
        assert_eq!(
            ts.launcher.opened(),
            ["https://a.example/", "http://b.example/a%20b"]
        );
        for (index, link) in links.iter().enumerate().skip(2) {
            assert_eq!(
                ts.shell.open_url(s, g, &id, index).err(),
                Some(ShellError::InvalidInput { what: "link type" }),
                "{link}"
            );
        }
        assert_eq!(
            ts.shell.open_url(s, g, &id, links.len()).err(),
            Some(ShellError::NotFound)
        );
        assert_eq!(ts.launcher.opened().len(), 2, "nothing else was launched");
    }

    /// §7.4: the answer is checked once more after the launch, which runs with no session held.
    #[test]
    fn lock_during_link_launch_answers_locked() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let id = login(&ts, s, g, "Bank");
        let shell = Arc::clone(&ts.shell);
        ts.launcher
            .during_next_open(Box::new(move || shell.sessions.lock(s, LockReason::Manual)));
        assert_eq!(
            ts.shell.open_url(s, g, &id, 0).err(),
            Some(ShellError::Locked)
        );
        assert_eq!(ts.launcher.opened(), ["https://bank.example/"]);
    }

    #[test]
    fn read_only_session_refuses_every_edit() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let id = login(&ts, s, g, "Bank");
        ts.shell.trash_item(s, g, &id).unwrap();
        let dir = vault_dir(&ts, 0);
        ts.shell.sessions.lock_all(LockReason::Manual);
        let vault = heavy(|| {
            ReadOnlyVault::open_folder(&dir, Credential::Password(PW), &CancelToken::new())
        })
        .unwrap();
        let location = Location::folder(&dir).unwrap();
        let opened = ts.shell.sessions.open(Some(location.clone()), None, |_| {
            Ok(OpenStep::Session(location, Opened::ReadOnly(vault), ()))
        });
        let Ok(Outcome::Done(tagged)) = opened else {
            panic!("the read-only session did not open");
        };
        let (r, gr) = (tagged.session, tagged.generation);

        let read_only = Some(ShellError::ReadOnly);
        let shell = &ts.shell;
        assert_eq!(
            shell
                .new_item(r, gr, NewKind::Note, "x".into(), None, None)
                .err(),
            read_only
        );
        assert_eq!(
            shell.update_item(r, gr, edit(&id, 2, "x", None)).err(),
            read_only
        );
        assert_eq!(shell.trash_item(r, gr, &id).err(), read_only);
        assert_eq!(shell.restore_item(r, gr, &id).err(), read_only);
        assert_eq!(shell.purge_item(r, gr, &id).err(), read_only);
        assert_eq!(shell.delete_collection(r, gr, &id).err(), read_only);
        assert_eq!(shell.delete_orphans(r, gr).err(), read_only);
        // Reading still works, and nothing changed.
        let list = shell.list_items(r, gr).unwrap().data;
        assert_eq!(list.items.len(), 1);
        assert!(list.items[0].trashed);
        assert_eq!(
            shell
                .reveal_password(r, gr, &id, RevealField::Password)
                .unwrap()
                .data
                .as_str(),
            LOGIN_PW
        );
    }

    /// The trash lists what is old enough and never purges by itself; a purge is the page's explicit call.
    #[test]
    fn trash_restore_and_purge() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let collection = ts
            .shell
            .new_item(s, g, NewKind::Collection, "Banking".into(), None, None)
            .unwrap()
            .data;
        let member = ts
            .shell
            .new_item(
                s,
                g,
                NewKind::Note,
                "PIN".into(),
                Some(collection.clone()),
                None,
            )
            .unwrap()
            .data;
        assert_eq!(
            ts.shell.delete_collection(s, g, &collection).unwrap().data,
            1
        );
        let list = ts.shell.list_items(s, g).unwrap().data;
        assert!(list.items.iter().all(|item| item.trashed));
        assert_eq!(
            list.items
                .iter()
                .find(|item| item.id == member)
                .unwrap()
                .collection
                .as_deref(),
            Some(collection.as_str())
        );
        ts.shell.restore_item(s, g, &member).unwrap();
        let list = ts.shell.list_items(s, g).unwrap().data;
        assert!(
            list.items.iter().all(|item| !item.trashed),
            "with its collection"
        );

        ts.shell.trash_item(s, g, &member).unwrap();
        ts.shell.purge_item(s, g, &member).unwrap();
        let list = ts.shell.list_items(s, g).unwrap().data;
        assert_eq!(list.items.len(), 1);
    }

    /// The vault key, from the vault's password slot: for a test that writes an item file by hand.
    fn vault_key(dir: &Path) -> (VaultId, Key32) {
        let header = parse_header(&fs::read(dir.join("vault.json")).unwrap()).unwrap();
        let slot = header
            .slots
            .iter()
            .find(|slot| slot.slot_type == SlotType::Password)
            .unwrap();
        let params = slot.kdf.as_ref().unwrap();
        let slot_key = heavy(|| derive_password_key(PW, &slot.salt, params)).unwrap();
        let key = unwrap_slot(slot, &header.vault_id, &slot_key).unwrap();
        (header.vault_id, key)
    }

    /// `old_trash` lists only what has been in the trash long enough, and removes nothing.
    #[test]
    fn old_trash_lists_only_old_items() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let old = ts
            .shell
            .new_item(s, g, NewKind::Note, "Old".into(), None, None)
            .unwrap()
            .data;
        let fresh = ts
            .shell
            .new_item(s, g, NewKind::Note, "Fresh".into(), None, None)
            .unwrap()
            .data;
        ts.shell.trash_item(s, g, &old).unwrap();
        ts.shell.trash_item(s, g, &fresh).unwrap();
        let (registry_id, dir) = ts.shell.registry.entries()[0].clone();
        ts.shell.sessions.lock_all(LockReason::Manual);

        // "Old" went to the trash in 2020: rewritten by hand, sealed with the vault's own key.
        let (vault_id, key) = vault_key(&dir);
        let file = item_file(&ts, 0, &old);
        let id = ItemId::from_hex(&old).unwrap();
        let mut item = open_item(&fs::read(&file).unwrap(), &id, &vault_id, &key).unwrap();
        item.trashed_at = Some("2020-01-01T00:00:00Z".into());
        fs::write(&file, seal_item(&item, &vault_id, &key).unwrap()).unwrap();

        let unlocked = heavy(|| ts.shell.unlock_vault(registry_id, secret(PW))).unwrap();
        let (s, g) = (unlocked.session, unlocked.generation);
        assert_eq!(ts.shell.old_trash(s, g, 30).unwrap().data, [old]);
        assert_eq!(ts.shell.list_items(s, g).unwrap().data.items.len(), 2);
    }

    /// The orphans listed are the quarantined files, and only unreferenced ones are deleted.
    #[test]
    fn orphans_listed_and_only_unreferenced_deleted() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let id = login(&ts, s, g, "Bank");
        let src = ts.temp.path().join("statement.pdf");
        fs::write(&src, b"statement").unwrap();
        let item_id = ItemId::from_hex(&id).unwrap();
        let kept = ts
            .shell
            .sessions
            .write(s, g, |vault, cancel| {
                Ok(vault.attach_file(&item_id, &src, cancel)?)
            })
            .unwrap()
            .data;
        // In the quarantine: a file no item references, and a copy of one the login still attaches.
        let files = vault_dir(&ts, 0).join("files");
        let orphaned = files.join("orphaned");
        fs::create_dir_all(&orphaned).unwrap();
        let stray = FileId([0xAB; 16]);
        fs::write(orphaned.join(format!("{}.blob", stray.to_hex())), b"12345").unwrap();
        let kept_blob = format!("{}.blob", kept.to_hex());
        fs::copy(files.join(&kept_blob), orphaned.join(&kept_blob)).unwrap();
        let kept_len = fs::metadata(files.join(&kept_blob)).unwrap().len();

        let listed = serde_json::to_value(ts.shell.list_orphans(s, g).unwrap().data).unwrap();
        let mut expected = vec![
            json!({ "file_id": stray.to_hex(), "length": 5 }),
            json!({ "file_id": kept.to_hex(), "length": kept_len }),
        ];
        expected.sort_by_key(|orphan| orphan["file_id"].as_str().unwrap().to_owned());
        assert_eq!(listed, Value::Array(expected));

        assert_eq!(ts.shell.delete_orphans(s, g).unwrap().data, 1);
        assert!(!orphaned.join(format!("{}.blob", stray.to_hex())).exists());
        assert!(
            orphaned.join(&kept_blob).exists(),
            "a referenced file stays"
        );
        assert!(files.join(&kept_blob).exists());
        let left: Vec<String> = ts
            .shell
            .list_orphans(s, g)
            .unwrap()
            .data
            .iter()
            .map(|orphan| orphan.file_id.clone())
            .collect();
        assert_eq!(left, [kept.to_hex()]);
    }

    /// Each field reaches the clipboard, and only the clipboard: the answer carries no value. A link index out of
    /// range, a login field of a note and a foreign item are refused with fixed errors and nothing written.
    #[test]
    fn copy_field_copies_each_field() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let id = login(&ts, s, g, "Bank");
        let copied = |field: CopyField| {
            let answer = ts.shell.copy_field(s, g, &id, field).unwrap();
            assert_eq!((answer.session, answer.generation), (s, g));
            ts.clipboard.text()
        };
        assert_eq!(copied(CopyField::Password).as_deref(), Some(LOGIN_PW));
        assert_eq!(
            copied(CopyField::Username).as_deref(),
            Some("ada@example.com")
        );
        assert_eq!(
            copied(CopyField::Url(0)).as_deref(),
            Some("https://bank.example")
        );
        assert_eq!(copied(CopyField::Notes).as_deref(), Some("a note"));
        let json =
            serde_json::to_string(&ts.shell.copy_field(s, g, &id, CopyField::Password).unwrap())
                .unwrap();
        assert!(!json.contains(LOGIN_PW), "the answer holds the password");

        assert!(ts.clipboard.user_copy("theirs"));
        let opens = ts.clipboard.opens();
        let note = ts
            .shell
            .new_item(s, g, NewKind::Note, "Plans".into(), None, None)
            .unwrap()
            .data;
        let foreign = ItemId::random().to_hex();
        let refused = [
            (
                id.as_str(),
                CopyField::Url(1),
                ShellError::InvalidInput { what: "link" },
            ),
            (
                id.as_str(),
                CopyField::Url(u8::MAX),
                ShellError::InvalidInput { what: "link" },
            ),
            (note.as_str(), CopyField::Password, NOT_A_LOGIN),
            (note.as_str(), CopyField::Url(0), NOT_A_LOGIN),
            (
                foreign.as_str(),
                CopyField::Notes,
                CoreError::NotFound.into(),
            ),
        ];
        for (item, field, expected) in refused {
            assert_eq!(
                ts.shell.copy_field(s, g, item, field).err(),
                Some(expected),
                "{field:?}"
            );
        }
        assert_eq!(ts.clipboard.text().as_deref(), Some("theirs"));
        assert_eq!(
            ts.clipboard.opens(),
            opens,
            "a refusal opened the clipboard"
        );
        // A note's notes are copied like a login's.
        ts.shell.copy_field(s, g, &note, CopyField::Notes).unwrap();
        assert_eq!(ts.clipboard.text().as_deref(), Some(""));

        // A stale generation: `Locked`, nothing written.
        ts.shell.sessions.lock(s, LockReason::Manual);
        assert!(ts.clipboard.user_copy("theirs"));
        assert_eq!(
            ts.shell.copy_field(s, g, &id, CopyField::Password).err(),
            Some(ShellError::Locked)
        );
        assert_eq!(ts.clipboard.text().as_deref(), Some("theirs"));
    }

    /// Fix round 1 (6): a lock that comes after the write, before the command answers: `Locked`, as every command
    /// answers once its session has locked, and the copy is cleared by the lock.
    #[test]
    fn copy_field_answers_locked_when_a_lock_follows_the_write() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let id = login(&ts, s, g, "Bank");
        let shell = Arc::clone(&ts.shell);
        ts.shell.clipboard.after_next_write(Box::new(move || {
            shell.sessions.lock_all(LockReason::Manual);
        }));
        assert_eq!(
            ts.shell.copy_field(s, g, &id, CopyField::Password).err(),
            Some(ShellError::Locked)
        );
        assert_eq!(ts.clipboard.text(), None);
    }

    #[test]
    fn copy_field_request_is_strict() {
        let body = |value: Value| InvokeBody::Json(value);
        let id = "0".repeat(32);
        for field in [
            json!("password"),
            json!("username"),
            json!("notes"),
            json!({ "url": 3 }),
        ] {
            let request = json!({ "session": 1, "generation": 1, "id": id, "field": field });
            assert!(parse::<CopyFieldArgs>(&body(request)).is_ok(), "{field}");
        }
        for field in [
            json!("title"),
            json!({ "url": 256 }),
            json!({ "url": -1 }),
            json!("Password"),
        ] {
            let request = json!({ "session": 1, "generation": 1, "id": id, "field": field });
            assert_eq!(
                parse::<CopyFieldArgs>(&body(request)).err(),
                Some(MALFORMED),
                "{field}"
            );
        }
        let extra =
            json!({ "session": 1, "generation": 1, "id": id, "field": "password", "text": "x" });
        assert_eq!(parse::<CopyFieldArgs>(&body(extra)).err(), Some(MALFORMED));
    }

    /// The fields a new login starts with: a website with no scheme, which the shell completes.
    fn login_fields() -> ItemFields {
        ItemFields {
            username: "ada@example.com".to_owned(),
            password: secret(LOGIN_PW),
            urls: vec!["support.example.com".to_owned()],
            notes: secret("a note"),
            ..ItemFields::default()
        }
    }

    /// Item files written while `work` runs, counted at the engine's own step after each write.
    fn item_writes<T>(work: impl FnOnce() -> T) -> (T, usize) {
        let writes = Rc::new(Cell::new(0));
        let seen = Rc::clone(&writes);
        failpoint::observe(
            "items.after_write",
            Box::new(move || seen.set(seen.get() + 1)),
        );
        let result = work();
        failpoint::disarm_all();
        (result, writes.get())
    }

    /// How many item files the `n`th vault holds on disk.
    fn item_files(ts: &TestShell, n: usize) -> usize {
        match fs::read_dir(vault_dir(ts, n).join("items")) {
            Ok(entries) => entries.count(),
            Err(_) => 0,
        }
    }

    /// A new login starts whole and is written once, so a lock between two calls can never leave an empty item.
    #[test]
    fn new_item_with_fields_is_one_write() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let folder = ts
            .shell
            .new_item(s, g, NewKind::Collection, "Banking".into(), None, None)
            .unwrap()
            .data;
        let (made, writes) = item_writes(|| {
            ts.shell.new_item(
                s,
                g,
                NewKind::Login,
                "Bank".into(),
                Some(folder.clone()),
                Some(login_fields()),
            )
        });
        let id = made.unwrap().data;
        assert_eq!(writes, 1, "more than one item write");
        assert_eq!(item_files(&ts, 0), 2, "the folder and the login");

        let detail = ts.shell.get_item(s, g, &id).unwrap().data;
        assert_eq!(detail.revision, 0, "never edited");
        assert_eq!(detail.summary.username.as_deref(), Some("ada@example.com"));
        assert_eq!(detail.summary.collection.as_deref(), Some(folder.as_str()));
        assert_eq!(detail.summary.site.as_deref(), Some("support.example.com"));
        assert_eq!(detail.urls, ["https://support.example.com"]);
        assert_eq!(detail.notes.as_str(), "a note");
        assert!(detail.has_password);
        assert_eq!(revealed(&ts, s, g, &id).as_str(), LOGIN_PW);

        // The write is the item's only: a write that fails before it lands leaves nothing, not an empty login.
        failpoint::arm("atomic_write.before_replace");
        let failed = ts.shell.new_item(
            s,
            g,
            NewKind::Login,
            "Mail".into(),
            None,
            Some(login_fields()),
        );
        failpoint::disarm_all();
        assert!(failed.is_err());
        let titles: Vec<String> = ts
            .shell
            .list_items(s, g)
            .unwrap()
            .data
            .items
            .into_iter()
            .map(|item| item.title)
            .collect();
        assert!(!titles.contains(&"Mail".to_owned()), "{titles:?}");
        assert_eq!(item_files(&ts, 0), 2);

        // A login's own fields are for a login alone. A note or a folder made as before (no fields) is still made; a note
        // may start with its text (`a_new_note_carries_its_text_in_one_write`), and a folder takes no fields at all.
        let notes_only = || ItemFields {
            notes: secret("steps"),
            ..ItemFields::default()
        };
        let plain = ts
            .shell
            .new_item(s, g, NewKind::Note, "Steps".into(), None, None)
            .unwrap()
            .data;
        assert_eq!(
            ts.shell.get_item(s, g, &plain).unwrap().data.notes.as_str(),
            ""
        );
        let (refused, writes) = item_writes(|| {
            let try_kind = |kind, fields| {
                ts.shell
                    .new_item(s, g, kind, "x".into(), None, Some(fields))
                    .err()
            };
            [
                try_kind(NewKind::Note, login_fields()),
                try_kind(NewKind::Collection, login_fields()),
                try_kind(NewKind::Collection, ItemFields::default()),
                try_kind(NewKind::Collection, notes_only()),
            ]
        });
        assert_eq!(refused, [Some(NOT_A_LOGIN); 4]);
        assert_eq!(writes, 0);
    }

    /// A new item with fields is refused as every item command is: a stale generation (`Locked`), a folder of another
    /// vault, and a read-only session, and none of them writes.
    #[test]
    fn new_item_with_fields_is_refused_stale_foreign_and_read_only() {
        let ts = TestShell::new();
        let (a, ga) = open_vault(&ts, "Family");
        let (b, gb) = open_vault(&ts, "Work");
        let foreign = ts
            .shell
            .new_item(b, gb, NewKind::Collection, "Theirs".into(), None, None)
            .unwrap()
            .data;
        let (refused, writes) = item_writes(|| {
            (
                ts.shell.new_item(
                    a,
                    ga,
                    NewKind::Login,
                    "Bank".into(),
                    Some(foreign),
                    Some(login_fields()),
                ),
                ts.shell.new_item(
                    a,
                    ga + 1,
                    NewKind::Login,
                    "Bank".into(),
                    None,
                    Some(login_fields()),
                ),
            )
        });
        assert_eq!(
            refused.0.err(),
            Some(CoreError::InvalidInput { what: "collection" }.into())
        );
        assert_eq!(refused.1.err(), Some(ShellError::Locked));
        assert_eq!(writes, 0);
        assert_eq!(item_files(&ts, 0), 0);

        // A session that locked: its old generation is refused.
        let (_, dir) = ts.shell.registry.entries()[0].clone();
        ts.shell.sessions.lock(a, LockReason::Manual);
        assert_eq!(
            ts.shell
                .new_item(
                    a,
                    ga,
                    NewKind::Login,
                    "Bank".into(),
                    None,
                    Some(login_fields())
                )
                .err(),
            Some(ShellError::Locked)
        );

        // Read-only: refused where it writes.
        ts.shell.sessions.lock_all(LockReason::Manual);
        let vault = heavy(|| {
            ReadOnlyVault::open_folder(&dir, Credential::Password(PW), &CancelToken::new())
        })
        .unwrap();
        let location = Location::folder(&dir).unwrap();
        let opened = ts.shell.sessions.open(Some(location.clone()), None, |_| {
            Ok(OpenStep::Session(location, Opened::ReadOnly(vault), ()))
        });
        let Ok(Outcome::Done(tagged)) = opened else {
            panic!("the read-only session did not open");
        };
        let (made, writes) = item_writes(|| {
            ts.shell.new_item(
                tagged.session,
                tagged.generation,
                NewKind::Login,
                "Bank".into(),
                None,
                Some(login_fields()),
            )
        });
        assert_eq!(made.err(), Some(ShellError::ReadOnly));
        assert_eq!(writes, 0);
        assert_eq!(item_files(&ts, 0), 0);
    }

    /// Every field's limit is checked before anything is written, and before a website is looked at: an over-long
    /// field is `TooLarge` even when another field is a bad website.
    #[test]
    fn new_item_limits_checked_first() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let too_large = |what| Some(ShellError::TooLarge { what });
        for unit in ["a", "é"] {
            let long = |n: usize| bytes_of(unit, n);
            let with = |change: &dyn Fn(&mut ItemFields)| {
                let mut fields = ItemFields {
                    urls: vec!["javascript:x".to_owned()],
                    ..login_fields()
                };
                change(&mut fields);
                fields
            };
            let over: Vec<(String, ItemFields, &str)> = vec![
                (long(1025), with(&|_| {}), "title"),
                (
                    "Bank".to_owned(),
                    with(&|f| f.username = long(1025)),
                    "username",
                ),
                (
                    "Bank".to_owned(),
                    with(&|f| f.password = secret(&long(4097))),
                    "password",
                ),
                (
                    "Bank".to_owned(),
                    with(&|f| f.notes = secret(&long(524_289))),
                    "notes",
                ),
                (
                    "Bank".to_owned(),
                    with(&|f| f.urls = vec![long(2049)]),
                    "url",
                ),
                (
                    "Bank".to_owned(),
                    with(&|f| f.urls = vec!["https://a.example".to_owned(); 33]),
                    "urls",
                ),
            ];
            for (title, fields, what) in over {
                let (made, writes) = item_writes(|| {
                    ts.shell
                        .new_item(s, g, NewKind::Login, title, None, Some(fields))
                });
                assert_eq!(made.err(), too_large(what), "{what} in {unit}");
                assert_eq!(writes, 0, "{what} in {unit}");
            }
        }
        assert_eq!(item_files(&ts, 0), 0, "something was written");
        assert!(ts.shell.list_items(s, g).unwrap().data.items.is_empty());

        // Every field at its limit is saved whole, in one write.
        let full = ItemFields {
            username: bytes_of("é", 1024),
            password: secret(&bytes_of("é", 4096)),
            urls: vec![format!("https://{}", bytes_of("a", 2040)); 32],
            notes: secret(&bytes_of("é", 524_288)),
            ..ItemFields::default()
        };
        let (made, writes) = item_writes(|| {
            ts.shell
                .new_item(s, g, NewKind::Login, bytes_of("é", 1024), None, Some(full))
        });
        let id = made.unwrap().data;
        assert_eq!(writes, 1);
        let detail = ts.shell.get_item(s, g, &id).unwrap().data;
        assert_eq!((detail.urls.len(), detail.notes.len()), (32, 524_288));

        // A website that grows past its limit once `https://` is in front is refused too, with nothing written.
        let (made, writes) = item_writes(|| {
            ts.shell.new_item(
                s,
                g,
                NewKind::Login,
                "Edge".into(),
                None,
                Some(ItemFields {
                    urls: vec![bytes_of("a", 2048)],
                    ..ItemFields::default()
                }),
            )
        });
        assert_eq!(made.err(), too_large("url"));
        assert_eq!(writes, 0);
    }

    /// A website with no scheme gets `https://`; one that has `http` or `https` is kept as typed, trimmed. Whatever
    /// comes out is what `web_url`, the shell's one rule for opening a link, accepts.
    #[test]
    fn https_added_when_missing() {
        for (typed, saved) in [
            ("support.example.com", "https://support.example.com"),
            ("  support.example.com \t", "https://support.example.com"),
            ("localhost:3000", "https://localhost:3000"),
            ("192.168.0.1/login", "https://192.168.0.1/login"),
            (
                "example.com:8080/a?b=c#d",
                "https://example.com:8080/a?b=c#d",
            ),
            ("www.example.com/a b", "https://www.example.com/a b"),
            ("http://plain.example", "http://plain.example"),
            ("https://secure.example/x", "https://secure.example/x"),
            ("HTTPS://Example.com/Path", "HTTPS://Example.com/Path"),
            ("https://ada:pw@host.example", "https://ada:pw@host.example"),
        ] {
            let said = normalise_url(typed).unwrap();
            assert_eq!(said, saved, "{typed}");
            assert!(web_url(&said).is_some(), "{said} would not open");
        }

        // `new_item` saves the completed address, and the shell can open it.
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let fields = ItemFields {
            urls: vec!["support.example.com".to_owned(), "http://b.example".into()],
            ..ItemFields::default()
        };
        let id = ts
            .shell
            .new_item(s, g, NewKind::Login, "Site".into(), None, Some(fields))
            .unwrap()
            .data;
        let detail = ts.shell.get_item(s, g, &id).unwrap().data;
        assert_eq!(
            detail.urls,
            ["https://support.example.com", "http://b.example"]
        );
        ts.shell.open_url(s, g, &id, 0).unwrap();
        assert_eq!(ts.launcher.opened(), ["https://support.example.com/"]);
    }

    /// Only `http` and `https` are websites. Every other scheme, a path, an empty or half address, and anything with a
    /// control character is refused as `InvalidInput { what: "website" }`, by `normalise_url` and by `new_item`, which
    /// then writes nothing.
    #[test]
    fn other_schemes_refused() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let refusal = Some(ShellError::InvalidInput { what: "website" });
        for typed in [
            "javascript:alert(1)",
            "JaVaScRiPt:alert(1)",
            "file:///C:/x",
            "ftp://files.example.com",
            "mailto:ada@example.com",
            "ms-settings:",
            "ms-settings:network",
            "tel:+15551234",
            "data:text/html,<b>x</b>",
            "vbscript:x",
            "view-source:https://a.example",
            r"\\server\share",
            r"C:\x.exe",
            // A parser forgives these; what is kept has to read as an address.
            "https:example.com",
            "http:/a.example",
            "https:80",
            "",
            "   ",
            "http://",
            "https://",
            "http://exa mple.com",
            "https://exa\nmple.com",
            "https://exa\tmple.com",
            "exa\u{0}mple.com",
            "https://a.example/\u{7f}",
        ] {
            assert_eq!(normalise_url(typed).err(), refusal, "{typed:?}");
            let fields = ItemFields {
                urls: vec!["https://fine.example".to_owned(), typed.to_owned()],
                ..login_fields()
            };
            let (made, writes) = item_writes(|| {
                ts.shell
                    .new_item(s, g, NewKind::Login, "Bank".into(), None, Some(fields))
            });
            assert_eq!(made.err(), refusal, "{typed:?}");
            assert_eq!(writes, 0, "{typed:?}");
        }
        assert_eq!(item_files(&ts, 0), 0, "something was written");
        // The refusal says nothing of the address.
        let said = format!("{:?}", normalise_url("javascript:secret-token").err());
        assert!(!said.contains("secret-token"), "{said}");
    }

    /// The check keeps everything but a web address out, whatever it is given: a generated mass of odd text (schemes,
    /// ports, slashes, `@`, brackets, percent signs, control characters, non-ASCII) never gives an answer that is not
    /// an `http` or `https` address `web_url` opens, a trimmed address that already is one comes back unchanged, and
    /// the slowest input is measured (no pattern engine to hang, but the bound is pinned).
    #[test]
    fn normalise_url_only_ever_answers_web_addresses() {
        use std::time::{Duration, Instant};

        #[rustfmt::skip]
        const PIECES: &[&str] = &[
            "http", "https", "HTTP", "ftp", "file", "javascript", "mailto", "localhost", "example", "com", "a", "1",
            "80", "65535", "://", ":", "/", "//", "///", "\\", "@", ".", "..", "-", "_", "%", "%20", "%zz", "?", "#",
            "[", "]", "::1", "é", "日本", " ", "\t", "\n", "\r", "\u{0}", "\u{7f}", "\u{200b}", "xn--",
        ];
        let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        let (mut accepted, mut slowest) = (0, Duration::ZERO);
        for _ in 0..30_000 {
            let pieces = 1 + (next() % 12) as usize;
            let typed: String = (0..pieces)
                .map(|_| PIECES[(next() % PIECES.len() as u64) as usize])
                .collect();
            let started = Instant::now();
            let answer = normalise_url(&typed);
            slowest = slowest.max(started.elapsed());
            if let Ok(saved) = answer {
                accepted += 1;
                let lower = saved.to_ascii_lowercase();
                assert!(
                    lower.starts_with("http://") || lower.starts_with("https://"),
                    "{typed:?} gave {saved:?}"
                );
                assert!(web_url(&saved).is_some(), "{typed:?} gave {saved:?}");
                assert!(!saved.chars().any(char::is_control), "{typed:?}");
                assert_eq!(saved.trim(), saved, "{typed:?}");
            }
            // Already a web address once trimmed, written out as one: kept as it is.
            let trimmed = typed.trim();
            let written = trimmed.to_ascii_lowercase();
            let written_out = written.starts_with("http://") || written.starts_with("https://");
            if written_out && !trimmed.chars().any(char::is_control) && web_url(trimmed).is_some() {
                assert_eq!(normalise_url(&typed).as_deref(), Ok(trimmed), "{typed:?}");
            }
        }
        assert!(
            accepted > 100,
            "only {accepted} were accepted: the mass is not varied enough"
        );
        assert!(
            slowest < Duration::from_millis(100),
            "the slowest input took {slowest:?}"
        );
    }

    #[test]
    fn new_item_request_is_strict() {
        let body = |value: Value| InvokeBody::Json(value);
        let base = json!({ "session": 1, "generation": 1, "kind": "login", "title": "t", "collection": null });
        // Today's callers send no `fields`.
        assert!(parse::<NewItemArgs>(&body(base.clone())).is_ok());
        let mut with = base.clone();
        with["fields"] = json!({
            "username": "ada", "password": "pw", "urls": ["a.example"], "notes": "n",
        });
        assert!(parse::<NewItemArgs>(&body(with.clone())).is_ok());
        with["fields"] = json!({ "notes": "n" });
        assert!(parse::<NewItemArgs>(&body(with)).is_ok());
        for bad in [
            json!({ "username": "ada", "kind": "key" }),
            json!({ "urls": "a.example" }),
            json!({ "password": 5 }),
        ] {
            let mut request = base.clone();
            request["fields"] = bad;
            assert_eq!(parse::<NewItemArgs>(&body(request)).err(), Some(MALFORMED));
        }
        let mut extra = base;
        extra["extra"] = json!(1);
        assert_eq!(parse::<NewItemArgs>(&body(extra)).err(), Some(MALFORMED));
    }

    #[test]
    fn item_requests_refuse_unknown_fields() {
        let body = |value: Value| InvokeBody::Json(value);
        let edit = json!({
            "id": "00", "revision": 1, "title": "t", "notes": "", "collection": null,
            "username": null, "password": null, "urls": null,
        });
        let good = json!({ "session": 1, "generation": 1, "edit": edit });
        assert!(parse::<UpdateItem>(&body(good.clone())).is_ok());
        let mut extra = good;
        extra["edit"]["kind"] = json!("file");
        assert_eq!(parse::<UpdateItem>(&body(extra)).err(), Some(MALFORMED));
        // A file item is made by attaching a file, never by `new_item`.
        let file = json!({ "session": 1, "generation": 1, "kind": "file", "title": "t" });
        assert_eq!(parse::<NewItemArgs>(&body(file)).err(), Some(MALFORMED));
    }

    /// A key's value, made up for these tests (never a real key).
    const KEY_VALUE: &str = "demo-zzz-qqq-one";

    /// What a field over its limit is refused with.
    fn too_large_in(field: &'static str) -> Option<ShellError> {
        Some(ShellError::TooLarge { what: field })
    }

    /// A key's fields: the value alone.
    fn key_fields() -> ItemFields {
        ItemFields {
            value: secret(KEY_VALUE),
            ..ItemFields::default()
        }
    }

    /// A key named `name` holding [`KEY_VALUE`]: its ID.
    fn key(ts: &TestShell, session: SessionId, generation: u64, name: &str) -> String {
        ts.shell
            .new_item(
                session,
                generation,
                NewKind::Key,
                name.to_owned(),
                None,
                Some(key_fields()),
            )
            .unwrap()
            .data
    }

    /// A login's password, as `reveal_password` gives it.
    fn revealed(
        ts: &TestShell,
        session: SessionId,
        generation: u64,
        id: &str,
    ) -> Zeroizing<String> {
        ts.shell
            .reveal_password(session, generation, id, RevealField::Password)
            .unwrap()
            .data
    }

    /// The first vault, opened again as a read-only copy (as a backup is): its session and generation.
    fn read_only_session(ts: &TestShell) -> (SessionId, u64) {
        let dir = vault_dir(ts, 0);
        ts.shell.sessions.lock_all(LockReason::Manual);
        let vault = heavy(|| {
            ReadOnlyVault::open_folder(&dir, Credential::Password(PW), &CancelToken::new())
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

    /// A key is made whole in one write with its name as its title and its value inside, and Reveal is the one way the
    /// value reaches the page: tagged like a password's, refused for a stale generation and a foreign item, and
    /// dropped when a lock lands between the read and the answer.
    #[test]
    fn reveal_key_value() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let folder = ts
            .shell
            .new_item(s, g, NewKind::Collection, "Agency".into(), None, None)
            .unwrap()
            .data;
        let (made, writes) = item_writes(|| {
            ts.shell.new_item(
                s,
                g,
                NewKind::Key,
                "OPENAI_API_KEY".into(),
                Some(folder.clone()),
                Some(key_fields()),
            )
        });
        let id = made.unwrap().data;
        assert_eq!(writes, 1, "more than one item write");
        assert_eq!(item_files(&ts, 0), 2, "the folder and the key");

        let shown = ts
            .shell
            .reveal_password(s, g, &id, RevealField::KeyValue)
            .unwrap();
        assert_eq!((shown.session, shown.generation), (s, g));
        assert_eq!(shown.data.as_str(), KEY_VALUE);
        assert_eq!(
            serde_json::to_value(&shown).unwrap(),
            json!({ "session": s.0, "generation": g, "data": KEY_VALUE })
        );

        // Opened, the key says it has a value and gives none; its name is its title.
        let detail = ts.shell.get_item(s, g, &id).unwrap().data;
        assert_eq!(detail.summary.title, "OPENAI_API_KEY");
        assert_eq!(detail.summary.collection.as_deref(), Some(folder.as_str()));
        assert_eq!(detail.revision, 0, "never edited");
        assert!(detail.has_value && !detail.has_password);
        assert_eq!((detail.notes.as_str(), detail.urls.len()), ("", 0));
        assert_eq!(
            serde_json::to_value(&detail.summary).unwrap()["kind"],
            "key"
        );

        // A key made with no fields has no value, and Reveal gives the empty text.
        let bare = ts
            .shell
            .new_item(s, g, NewKind::Key, "EMPTY_ONE".into(), None, None)
            .unwrap()
            .data;
        assert!(!ts.shell.get_item(s, g, &bare).unwrap().data.has_value);
        assert_eq!(
            ts.shell
                .reveal_password(s, g, &bare, RevealField::KeyValue)
                .unwrap()
                .data
                .as_str(),
            ""
        );

        // The key asked for is the one named, never the newest: a newer key, made after this one, gives its own value
        // under its own ID, and the first still gives its own, to Reveal and to Copy alike.
        let newer = ts
            .shell
            .new_item(
                s,
                g,
                NewKind::Key,
                "NEWER_KEY".into(),
                None,
                Some(ItemFields {
                    value: secret("newer-value-0042"),
                    ..ItemFields::default()
                }),
            )
            .unwrap()
            .data;
        let value_of = |item: &str| {
            ts.shell
                .reveal_password(s, g, item, RevealField::KeyValue)
                .unwrap()
                .data
        };
        assert_eq!(value_of(&id).as_str(), KEY_VALUE);
        assert_eq!(value_of(&newer).as_str(), "newer-value-0042");
        ts.shell.copy_field(s, g, &id, CopyField::KeyValue).unwrap();
        assert_eq!(ts.clipboard.text().as_deref(), Some(KEY_VALUE));

        // §9: a lock between the read and the answer returns nothing.
        let shell = Arc::clone(&ts.shell);
        failpoint::observe(
            READ_DONE,
            Box::new(move || shell.sessions.lock_all(LockReason::WindowsLocked)),
        );
        let during = ts.shell.reveal_password(s, g, &id, RevealField::KeyValue);
        failpoint::disarm_all();
        assert_eq!(during.err(), Some(ShellError::Locked));
        // The old generation stays refused after the lock, whatever field is asked.
        for field in [RevealField::KeyValue, RevealField::Password] {
            assert_eq!(
                ts.shell.reveal_password(s, g, &id, field).err(),
                Some(ShellError::Locked)
            );
        }
    }

    /// A key's value is copied in Rust like a password: the same marks, the same timer (the settings' own, read at each
    /// copy), cleared with its vault's lock, and the answer carries no value.
    #[test]
    fn copy_key_value_stays_in_rust() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let id = key(&ts, s, g, "OPENAI_API_KEY");
        let start = ts.clock.now();
        let answer = ts.shell.copy_field(s, g, &id, CopyField::KeyValue).unwrap();
        assert_eq!((answer.session, answer.generation), (s, g));
        let json = serde_json::to_value(&answer).unwrap();
        assert_eq!(
            json,
            json!({ "session": s.0, "generation": g, "data": null })
        );
        assert!(!json.to_string().contains("demo-zzz"));
        assert_eq!(ts.clipboard.text().as_deref(), Some(KEY_VALUE));
        assert_eq!(ts.clipboard.formats(), EXCLUSION_FORMATS, "the marks");
        assert_eq!(ts.shell.clipboard.owner(), Some(s));
        let at = |secs: u64| {
            let when = start + Duration::from_secs(secs);
            ts.clock.set(when);
            ts.timer.run_due(when);
        };
        at(29);
        assert_eq!(
            ts.clipboard.text().as_deref(),
            Some(KEY_VALUE),
            "cleared early"
        );
        at(30);
        assert_eq!(ts.clipboard.text(), None, "not cleared at 30 s");
        assert_eq!(ts.shell.clipboard.owner(), None);

        // Something the person copied since is left alone, as for any copy.
        let start = ts.clock.now();
        ts.shell.copy_field(s, g, &id, CopyField::KeyValue).unwrap();
        assert!(ts.clipboard.user_copy("mine"));
        let when = start + Duration::from_secs(30);
        ts.clock.set(when);
        ts.timer.run_due(when);
        assert_eq!(ts.clipboard.text().as_deref(), Some("mine"));

        // The vault's lock clears it.
        ts.shell.copy_field(s, g, &id, CopyField::KeyValue).unwrap();
        ts.shell.sessions.lock(s, LockReason::Manual);
        assert_eq!(ts.clipboard.text(), None, "the lock left it");
        assert_eq!(ts.shell.clipboard.owner(), None);
    }

    /// A key's own fields go with a key, a login's with a login: each asked of the other is refused with a fixed
    /// error and nothing is read, copied or opened on the clipboard.
    #[test]
    fn reveal_field_refused_on_wrong_kind() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let login_id = login(&ts, s, g, "Bank");
        let key_id = key(&ts, s, g, "OPENAI_API_KEY");
        let note = ts
            .shell
            .new_item(s, g, NewKind::Note, "Plans".into(), None, None)
            .unwrap()
            .data;
        let folder = ts
            .shell
            .new_item(s, g, NewKind::Collection, "Agency".into(), None, None)
            .unwrap()
            .data;
        let revealing = [
            (login_id.as_str(), RevealField::KeyValue, NOT_A_KEY),
            (note.as_str(), RevealField::KeyValue, NOT_A_KEY),
            (folder.as_str(), RevealField::KeyValue, NOT_A_KEY),
            (key_id.as_str(), RevealField::Password, NOT_A_LOGIN),
            (note.as_str(), RevealField::Password, NOT_A_LOGIN),
        ];
        for (id, field, refusal) in revealing {
            assert_eq!(
                ts.shell.reveal_password(s, g, id, field).err(),
                Some(refusal),
                "{field:?}"
            );
        }
        assert!(ts.clipboard.user_copy("theirs"));
        let opens = ts.clipboard.opens();
        let copying = [
            (login_id.as_str(), CopyField::KeyValue, NOT_A_KEY),
            (note.as_str(), CopyField::KeyValue, NOT_A_KEY),
            (key_id.as_str(), CopyField::Password, NOT_A_LOGIN),
            (key_id.as_str(), CopyField::Username, NOT_A_LOGIN),
            (key_id.as_str(), CopyField::Url(0), NOT_A_LOGIN),
        ];
        for (id, field, refusal) in copying {
            assert_eq!(
                ts.shell.copy_field(s, g, id, field).err(),
                Some(refusal),
                "{field:?}"
            );
        }
        assert_eq!(ts.clipboard.text().as_deref(), Some("theirs"));
        assert_eq!(
            ts.clipboard.opens(),
            opens,
            "a refusal opened the clipboard"
        );

        // A foreign item of another vault, and an item that is not there, are `NotFound` for both commands.
        let (b, gb) = open_vault(&ts, "Work");
        let foreign = key(&ts, b, gb, "THEIR_KEY");
        let not_found = Some(ShellError::from(CoreError::NotFound));
        for id in [foreign.clone(), ItemId::random().to_hex()] {
            assert_eq!(
                ts.shell
                    .reveal_password(s, g, &id, RevealField::KeyValue)
                    .err(),
                not_found
            );
            assert_eq!(
                ts.shell.copy_field(s, g, &id, CopyField::KeyValue).err(),
                not_found
            );
        }
        // A stale generation is `Locked` for both, and nothing reaches the clipboard.
        assert_eq!(
            ts.shell
                .reveal_password(s, g + 1, &key_id, RevealField::KeyValue)
                .err(),
            Some(ShellError::Locked)
        );
        assert_eq!(
            ts.shell
                .copy_field(s, g + 1, &key_id, CopyField::KeyValue)
                .err(),
            Some(ShellError::Locked)
        );
        assert_eq!(ts.clipboard.text().as_deref(), Some("theirs"));
        // The item itself is untouched in its own vault.
        assert_eq!(
            ts.shell
                .reveal_password(b, gb, &foreign, RevealField::KeyValue)
                .unwrap()
                .data
                .as_str(),
            KEY_VALUE
        );
    }

    /// A key's value is read, not written, so a read-only copy (a backup opened to look) reveals and copies it; every
    /// write on it is refused.
    #[test]
    fn a_key_in_a_read_only_copy_can_be_read_but_not_made() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let id = key(&ts, s, g, "OPENAI_API_KEY");
        let (r, gr) = read_only_session(&ts);

        let shown = ts
            .shell
            .reveal_password(r, gr, &id, RevealField::KeyValue)
            .unwrap();
        assert_eq!(shown.data.as_str(), KEY_VALUE);
        ts.shell
            .copy_field(r, gr, &id, CopyField::KeyValue)
            .unwrap();
        assert_eq!(ts.clipboard.text().as_deref(), Some(KEY_VALUE));
        let detail = ts.shell.get_item(r, gr, &id).unwrap().data;
        assert!(detail.has_value);

        let (refused, writes) = item_writes(|| {
            [
                ts.shell
                    .new_item(
                        r,
                        gr,
                        NewKind::Key,
                        "NEW_KEY".into(),
                        None,
                        Some(key_fields()),
                    )
                    .err(),
                ts.shell
                    .new_item(
                        r,
                        gr,
                        NewKind::Note,
                        "Plans".into(),
                        None,
                        Some(ItemFields {
                            notes: secret("text"),
                            ..ItemFields::default()
                        }),
                    )
                    .err(),
                ts.shell
                    .update_item(r, gr, edit(&id, 0, "RENAMED", None))
                    .err(),
            ]
        });
        assert_eq!(refused, [Some(ShellError::ReadOnly); 3]);
        assert_eq!(writes, 0);
    }

    /// A bad name is refused by the engine whichever way a key's title is set (created through the shell, or
    /// renamed), with the one fixed refusal the page puts in words, and nothing is written or changed. A note keeps
    /// any title.
    #[test]
    fn bad_key_name_refused() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let bad_name = Some(ShellError::from(CoreError::InvalidInput {
            what: "key name",
        }));
        for bad in [
            "",
            " ",
            "1KEY",
            "OPENAI-API-KEY",
            "OPENAI API KEY",
            "A.B",
            "A=B",
            "é",
            "KEY\n",
            "日本",
            " KEY",
        ] {
            let (made, writes) = item_writes(|| {
                ts.shell
                    .new_item(s, g, NewKind::Key, bad.to_owned(), None, Some(key_fields()))
            });
            assert_eq!(made.err(), bad_name, "{bad:?}");
            assert_eq!(writes, 0, "{bad:?}");
            // Without fields too.
            assert_eq!(
                ts.shell
                    .new_item(s, g, NewKind::Key, bad.to_owned(), None, None)
                    .err(),
                bad_name,
                "{bad:?}"
            );
        }
        assert_eq!(item_files(&ts, 0), 0, "something was written");
        assert!(ts.shell.list_items(s, g).unwrap().data.items.is_empty());
        // What the page gets: fixed words only, never the name.
        let refusal = serde_json::to_value(bad_name).unwrap();
        assert_eq!(
            refusal,
            json!({ "code": "core", "kind": "invalid_input", "what": "key name" })
        );

        // The title's own limit holds first: one over it is `TooLarge`, one at it is a good name.
        let too_large = too_large_in("title");
        assert_eq!(
            ts.shell
                .new_item(
                    s,
                    g,
                    NewKind::Key,
                    "A".repeat(1025),
                    None,
                    Some(key_fields())
                )
                .err(),
            too_large
        );
        let long = ts
            .shell
            .new_item(
                s,
                g,
                NewKind::Key,
                "A".repeat(1024),
                None,
                Some(key_fields()),
            )
            .unwrap()
            .data;

        // A rename goes through the engine's rule too, and a refusal leaves the key as it was.
        let id = key(&ts, s, g, "GOOD_NAME");
        let before = fs::read(item_file(&ts, 0, &id)).unwrap();
        for bad in ["", "9NAME", "BAD NAME"] {
            let change = ItemEdit {
                notes: secret(""),
                username: None,
                urls: None,
                ..edit(&id, 0, bad, None)
            };
            assert_eq!(
                ts.shell.update_item(s, g, change).err(),
                bad_name,
                "{bad:?}"
            );
        }
        assert_eq!(fs::read(item_file(&ts, 0, &id)).unwrap(), before);
        let rename = ItemEdit {
            notes: secret(""),
            username: None,
            urls: None,
            ..edit(&id, 0, "BETTER_NAME", None)
        };
        ts.shell.update_item(s, g, rename).unwrap();
        assert_eq!(
            ts.shell.get_item(s, g, &id).unwrap().data.summary.title,
            "BETTER_NAME"
        );
        // The value did not move with the name.
        assert_eq!(
            ts.shell
                .reveal_password(s, g, &id, RevealField::KeyValue)
                .unwrap()
                .data
                .as_str(),
            KEY_VALUE
        );
        // A login's fields sent to a key in an edit are refused, as for a note.
        let login_edit = edit(&id, 1, "BETTER_NAME", Some("x"));
        assert_eq!(
            ts.shell.update_item(s, g, login_edit).err(),
            Some(NOT_A_LOGIN)
        );
        assert!(ts.shell.get_item(s, g, &long).is_ok());

        // Any other kind keeps any title.
        for title in ["My note, with spaces!", "1 note", "é"] {
            ts.shell
                .new_item(s, g, NewKind::Note, title.into(), None, None)
                .unwrap();
        }
    }

    /// A key starts with its value alone (and notes, which any item may have): a login's fields are refused for it
    /// and its value for every other kind, each before anything is written; the value has a limit of its own, checked
    /// before the name.
    #[test]
    fn a_new_keys_fields_are_for_a_key_alone() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let (refused, writes) = item_writes(|| {
            let try_new = |kind, title: &str, fields| {
                ts.shell
                    .new_item(s, g, kind, title.into(), None, Some(fields))
                    .err()
            };
            let value_only = key_fields;
            [
                try_new(NewKind::Key, "A_KEY", login_fields()),
                try_new(
                    NewKind::Key,
                    "A_KEY",
                    ItemFields {
                        username: "ada".into(),
                        ..value_only()
                    },
                ),
                try_new(
                    NewKind::Key,
                    "A_KEY",
                    ItemFields {
                        urls: vec!["https://a.example".into()],
                        ..value_only()
                    },
                ),
                try_new(
                    NewKind::Key,
                    "A_KEY",
                    ItemFields {
                        password: secret("pw"),
                        ..value_only()
                    },
                ),
                try_new(NewKind::Login, "Bank", value_only()),
                try_new(NewKind::Note, "Plans", value_only()),
                try_new(NewKind::Collection, "Folder", value_only()),
            ]
        });
        assert_eq!(
            refused,
            [
                Some(NOT_A_LOGIN),
                Some(NOT_A_LOGIN),
                Some(NOT_A_LOGIN),
                Some(NOT_A_LOGIN),
                Some(NOT_A_KEY),
                Some(NOT_A_KEY),
                // A folder takes no fields at all, so it is refused whatever they are.
                Some(NOT_A_LOGIN),
            ]
        );
        assert_eq!(writes, 0);
        assert_eq!(item_files(&ts, 0), 0);

        // The value's limit: one byte over, in ASCII and in "é", is `TooLarge`, even with a bad name; one at it is saved.
        for unit in ["a", "é"] {
            let big = ItemFields {
                value: secret(&bytes_of(unit, MAX_KEY_VALUE + 1)),
                ..ItemFields::default()
            };
            let (made, writes) = item_writes(|| {
                ts.shell
                    .new_item(s, g, NewKind::Key, "not a name".into(), None, Some(big))
            });
            assert_eq!(made.err(), too_large_in("value"), "{unit}");
            assert_eq!(writes, 0);
        }
        let full = ItemFields {
            value: secret(&bytes_of("é", MAX_KEY_VALUE)),
            ..ItemFields::default()
        };
        let id = ts
            .shell
            .new_item(s, g, NewKind::Key, "BIG_ONE".into(), None, Some(full))
            .unwrap()
            .data;
        assert_eq!(
            ts.shell
                .reveal_password(s, g, &id, RevealField::KeyValue)
                .unwrap()
                .data
                .len(),
            MAX_KEY_VALUE
        );
        assert_eq!(item_files(&ts, 0), 1);

        // A key may carry notes like any item, and says them when opened.
        let with_notes = ItemFields {
            notes: secret("rotate monthly"),
            ..key_fields()
        };
        let noted = ts
            .shell
            .new_item(s, g, NewKind::Key, "NOTED".into(), None, Some(with_notes))
            .unwrap()
            .data;
        assert_eq!(
            ts.shell.get_item(s, g, &noted).unwrap().data.notes.as_str(),
            "rotate monthly"
        );
    }

    /// A new key is refused as every item command is: a stale generation (`Locked`) and a folder of another vault,
    /// neither of them writing (a read-only copy is in `a_key_in_a_read_only_copy_can_be_read_but_not_made`).
    #[test]
    fn new_key_is_refused_stale_and_foreign() {
        let ts = TestShell::new();
        let (a, ga) = open_vault(&ts, "Family");
        let (b, gb) = open_vault(&ts, "Work");
        let foreign = ts
            .shell
            .new_item(b, gb, NewKind::Collection, "Theirs".into(), None, None)
            .unwrap()
            .data;
        let (refused, writes) = item_writes(|| {
            (
                ts.shell.new_item(
                    a,
                    ga,
                    NewKind::Key,
                    "A_KEY".into(),
                    Some(foreign),
                    Some(key_fields()),
                ),
                ts.shell.new_item(
                    a,
                    ga + 1,
                    NewKind::Key,
                    "A_KEY".into(),
                    None,
                    Some(key_fields()),
                ),
            )
        });
        assert_eq!(
            refused.0.err(),
            Some(CoreError::InvalidInput { what: "collection" }.into())
        );
        assert_eq!(refused.1.err(), Some(ShellError::Locked));
        assert_eq!(writes, 0);
        assert_eq!(item_files(&ts, 0), 0);
    }

    /// A note starts with its text in the one write, as a login starts with its fields: nothing is left empty between
    /// two calls, the text is kept exactly (lines, quotes, other scripts), its limit is checked before anything is
    /// written, and a login's own fields are still refused for it.
    #[test]
    fn a_new_note_carries_its_text_in_one_write() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let text = "Rotate the token.\n\"Then\" tell the team — 鍵\n";
        let fields = || ItemFields {
            notes: secret(text),
            ..ItemFields::default()
        };
        let (made, writes) = item_writes(|| {
            ts.shell.new_item(
                s,
                g,
                NewKind::Note,
                "Rotation steps".into(),
                None,
                Some(fields()),
            )
        });
        let id = made.unwrap().data;
        assert_eq!(writes, 1, "more than one item write");
        let detail = ts.shell.get_item(s, g, &id).unwrap().data;
        assert_eq!(
            (detail.summary.title.as_str(), detail.revision),
            ("Rotation steps", 0)
        );
        assert_eq!(detail.notes.as_str(), text);
        assert!(!detail.has_password && !detail.has_value);
        assert_eq!(
            serde_json::to_value(&detail.summary).unwrap()["kind"],
            "note"
        );
        // The text copies in Rust like any field.
        ts.shell.copy_field(s, g, &id, CopyField::Notes).unwrap();
        assert_eq!(ts.clipboard.text().as_deref(), Some(text));

        // No text at all is an empty note, with fields given or not.
        let empty = ts
            .shell
            .new_item(
                s,
                g,
                NewKind::Note,
                "Empty".into(),
                None,
                Some(ItemFields::default()),
            )
            .unwrap()
            .data;
        assert_eq!(
            ts.shell.get_item(s, g, &empty).unwrap().data.notes.as_str(),
            ""
        );

        // The text's limit, in ASCII and in "é": over it is `TooLarge` with nothing written; at it is saved.
        for unit in ["a", "é"] {
            let big = ItemFields {
                notes: secret(&bytes_of(unit, 524_289)),
                ..ItemFields::default()
            };
            let (made, writes) = item_writes(|| {
                ts.shell
                    .new_item(s, g, NewKind::Note, "Big".into(), None, Some(big))
            });
            assert_eq!(made.err(), too_large_in("notes"), "{unit}");
            assert_eq!(writes, 0);
        }
        let full = ItemFields {
            notes: secret(&bytes_of("é", 524_288)),
            ..ItemFields::default()
        };
        let big = ts
            .shell
            .new_item(s, g, NewKind::Note, "Big".into(), None, Some(full))
            .unwrap()
            .data;
        assert_eq!(
            ts.shell.get_item(s, g, &big).unwrap().data.notes.len(),
            524_288
        );

        // A write that fails before it lands leaves no empty note; a folder of another vault, a stale generation and a
        // read-only copy are refused as for every item.
        let files = item_files(&ts, 0);
        failpoint::arm("atomic_write.before_replace");
        let failed = ts
            .shell
            .new_item(s, g, NewKind::Note, "Lost".into(), None, Some(fields()));
        failpoint::disarm_all();
        assert!(failed.is_err());
        assert_eq!(item_files(&ts, 0), files);
        let (b, gb) = open_vault(&ts, "Work");
        let foreign = ts
            .shell
            .new_item(b, gb, NewKind::Collection, "Theirs".into(), None, None)
            .unwrap()
            .data;
        let (refused, writes) = item_writes(|| {
            (
                ts.shell
                    .new_item(
                        s,
                        g,
                        NewKind::Note,
                        "x".into(),
                        Some(foreign),
                        Some(fields()),
                    )
                    .err(),
                ts.shell
                    .new_item(s, g + 1, NewKind::Note, "x".into(), None, Some(fields()))
                    .err(),
            )
        });
        assert_eq!(
            refused,
            (
                Some(CoreError::InvalidInput { what: "collection" }.into()),
                Some(ShellError::Locked)
            )
        );
        assert_eq!(writes, 0);
        let (r, gr) = read_only_session(&ts);
        let (made, writes) = item_writes(|| {
            ts.shell
                .new_item(r, gr, NewKind::Note, "x".into(), None, Some(fields()))
        });
        assert_eq!(made.err(), Some(ShellError::ReadOnly));
        assert_eq!(writes, 0);
    }

    /// A key never reaches the page but through Reveal: the list, an opened key and a search say there is one, and
    /// the search finds the key by its name, never by its value.
    #[test]
    fn summary_never_holds_a_value() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let id = key(&ts, s, g, "OPENAI_API_KEY");
        let list = serde_json::to_value(ts.shell.list_items(s, g).unwrap()).unwrap();
        let detail = serde_json::to_value(ts.shell.get_item(s, g, &id).unwrap()).unwrap();
        let by_name = ts.shell.search_all("openai").unwrap();
        let by_value = ts.shell.search_all("demo-zzz").unwrap();
        assert_eq!(by_name.hits[0].data.len(), 1);
        assert!(
            by_value.hits[0].data.is_empty(),
            "a key was found by its value"
        );
        let found = serde_json::to_value(&by_name).unwrap();
        for view in [&list, &detail, &found] {
            let text = view.to_string();
            for leaked in [KEY_VALUE, "demo-zzz", "qqq-one"] {
                assert!(!text.contains(leaked), "a view holds {leaked}");
            }
            assert!(!text.contains("\"value\""), "a view has a value field");
        }
        assert_eq!(list["data"]["items"][0]["kind"], "key");
        assert_eq!(found["hits"][0]["data"][0]["kind"], "key");
        assert_eq!(detail["data"]["has_value"], true);
        assert_eq!(detail["data"]["has_password"], false);
        assert_eq!(list["data"]["items"][0]["username"], Value::Null);
        assert_eq!(list["data"]["items"][0]["site"], Value::Null);
    }

    #[test]
    fn reveal_and_key_requests_are_strict() {
        let body = |value: Value| InvokeBody::Json(value);
        let id = "0".repeat(32);
        for field in [json!("password"), json!("key_value")] {
            let request = json!({ "session": 1, "generation": 1, "id": id, "field": field });
            assert!(parse::<RevealArgs>(&body(request)).is_ok(), "{field}");
        }
        for field in [
            json!("value"),
            json!("Password"),
            // An earlier password is asked for by its number (`edit_and_previous_requests_are_strict`), never by the word.
            json!("previous"),
            json!(null),
        ] {
            let request = json!({ "session": 1, "generation": 1, "id": id, "field": field });
            assert_eq!(
                parse::<RevealArgs>(&body(request)).err(),
                Some(MALFORMED),
                "{field}"
            );
        }
        // The field is needed, and nothing else is allowed.
        let missing = json!({ "session": 1, "generation": 1, "id": id });
        assert_eq!(parse::<RevealArgs>(&body(missing)).err(), Some(MALFORMED));
        let extra =
            json!({ "session": 1, "generation": 1, "id": id, "field": "key_value", "text": "x" });
        assert_eq!(parse::<RevealArgs>(&body(extra)).err(), Some(MALFORMED));

        // Copying a key's value is a field of `copy_field` too.
        let copy = json!({ "session": 1, "generation": 1, "id": id, "field": "key_value" });
        assert!(parse::<CopyFieldArgs>(&body(copy)).is_ok());
        let wrong = json!({ "session": 1, "generation": 1, "id": id, "field": "keyvalue" });
        assert_eq!(parse::<CopyFieldArgs>(&body(wrong)).err(), Some(MALFORMED));

        // A new key, with its value, and a new note with its text.
        let key = json!({
            "session": 1, "generation": 1, "kind": "key", "title": "A_KEY", "collection": null,
            "fields": { "value": "v" },
        });
        assert!(parse::<NewItemArgs>(&body(key.clone())).is_ok());
        let mut note = key;
        note["kind"] = json!("note");
        note["fields"] = json!({ "notes": "text" });
        assert!(parse::<NewItemArgs>(&body(note.clone())).is_ok());
        note["fields"] = json!({ "value": 5 });
        assert_eq!(
            parse::<NewItemArgs>(&body(note.clone())).err(),
            Some(MALFORMED)
        );
        note["fields"] = json!({ "secret": "x" });
        assert_eq!(parse::<NewItemArgs>(&body(note)).err(), Some(MALFORMED));
    }

    // Task 13: edit, and earlier passwords.

    /// An item's revision now, for an edit that is not stale.
    fn revision_of(ts: &TestShell, session: SessionId, generation: u64, id: &str) -> u64 {
        ts.shell
            .get_item(session, generation, id)
            .unwrap()
            .data
            .revision
    }

    /// Changes the login's password through the shell's edit, as the page's Save does (the other fields as they are).
    fn change_password(ts: &TestShell, session: SessionId, generation: u64, id: &str, to: &str) {
        let revision = revision_of(ts, session, generation, id);
        ts.shell
            .update_item(session, generation, edit(id, revision, "Bank", Some(to)))
            .unwrap();
    }

    /// A key edit: the name, no notes, and `value` when it is to change.
    fn key_edit(id: &str, revision: u64, name: &str, value: Option<&str>) -> ItemEdit {
        ItemEdit {
            notes: secret(""),
            username: None,
            urls: None,
            key_value: value.map(secret),
            ..edit(id, revision, name, None)
        }
    }

    /// What `reveal_password` gives for a login's password.
    fn password_of(ts: &TestShell, s: SessionId, g: u64, id: &str) -> Zeroizing<String> {
        revealed(ts, s, g, id)
    }

    /// An earlier password is shown by its number and the day it was replaced, never by its text; Reveal gives it and
    /// Copy puts it on the clipboard in Rust with the marks and the timer of any copy; each is refused stale, for a
    /// foreign item and for a kind that has none; the one asked for is the one named, never the newest; a read-only copy
    /// reveals and copies them too.
    #[test]
    fn reveal_and_copy_previous() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let id = login(&ts, s, g, "Bank");
        change_password(&ts, s, g, &id, "demo-pass-two");
        change_password(&ts, s, g, &id, "demo-pass-three");

        // The details say how many there are and when each was replaced, and nothing of what they were.
        let detail = ts.shell.get_item(s, g, &id).unwrap().data;
        assert_eq!(detail.previous.len(), 2);
        let view = serde_json::to_value(&detail).unwrap();
        for (at, index) in [(0, 0), (1, 1)] {
            let row = view["previous"][at].as_object().unwrap();
            let mut keys: Vec<&str> = row.keys().map(String::as_str).collect();
            keys.sort_unstable();
            assert_eq!(keys, ["index", "replaced_at"]);
            assert_eq!(row["index"], index);
            let when = row["replaced_at"].as_str().unwrap();
            assert!(when.len() == 20 && when.ends_with('Z'), "{when}");
        }
        for leaked in [LOGIN_PW, "demo-pass-two", "demo-pass-three"] {
            assert!(
                !view.to_string().contains(leaked),
                "the details hold {leaked}"
            );
        }

        // Reveal: newest first, each tagged like a password's.
        let reveal = |field| ts.shell.reveal_password(s, g, &id, field).unwrap();
        let shown = reveal(RevealField::Previous(0));
        assert_eq!((shown.session, shown.generation), (s, g));
        assert_eq!(shown.data.as_str(), "demo-pass-two");
        assert_eq!(
            serde_json::to_value(&shown).unwrap(),
            json!({ "session": s.0, "generation": g, "data": "demo-pass-two" })
        );
        assert_eq!(reveal(RevealField::Previous(1)).data.as_str(), LOGIN_PW);
        assert_eq!(
            reveal(RevealField::Password).data.as_str(),
            "demo-pass-three"
        );

        // The one named, never the newest: a second login made after this one, with an earlier password of its own.
        let second = ts
            .shell
            .new_item(
                s,
                g,
                NewKind::Login,
                "Other".into(),
                None,
                Some(ItemFields {
                    password: secret("demo-second-one"),
                    ..ItemFields::default()
                }),
            )
            .unwrap()
            .data;
        ts.shell
            .update_item(s, g, edit(&second, 0, "Other", Some("demo-second-two")))
            .unwrap();
        let earliest = |item: &str| {
            ts.shell
                .reveal_password(s, g, item, RevealField::Previous(0))
                .unwrap()
                .data
        };
        assert_eq!(earliest(&second).as_str(), "demo-second-one");
        assert_eq!(earliest(&id).as_str(), "demo-pass-two");

        // Copy: in Rust, with the marks and the timer, and the answer carries no value.
        let start = ts.clock.now();
        let answer = ts
            .shell
            .copy_field(s, g, &id, CopyField::Previous(1))
            .unwrap();
        assert_eq!((answer.session, answer.generation), (s, g));
        let json = serde_json::to_value(&answer).unwrap();
        assert_eq!(
            json,
            json!({ "session": s.0, "generation": g, "data": null })
        );
        assert_eq!(ts.clipboard.text().as_deref(), Some(LOGIN_PW));
        assert_eq!(ts.clipboard.formats(), EXCLUSION_FORMATS, "the marks");
        assert_eq!(ts.shell.clipboard.owner(), Some(s));
        let at = |secs: u64| {
            let when = start + Duration::from_secs(secs);
            ts.clock.set(when);
            ts.timer.run_due(when);
        };
        at(29);
        assert_eq!(ts.clipboard.text().as_deref(), Some(LOGIN_PW));
        at(30);
        assert_eq!(ts.clipboard.text(), None, "not cleared at 30 s");
        ts.shell
            .copy_field(s, g, &second, CopyField::Previous(0))
            .unwrap();
        assert_eq!(ts.clipboard.text().as_deref(), Some("demo-second-one"));

        // A kind with none, and an item of another vault, are refused with fixed errors and nothing is copied.
        let key_id = key(&ts, s, g, "OPENAI_API_KEY");
        let note = ts
            .shell
            .new_item(s, g, NewKind::Note, "Plans".into(), None, None)
            .unwrap()
            .data;
        let (b, gb) = open_vault(&ts, "Work");
        let theirs = login(&ts, b, gb, "Theirs");
        change_password(&ts, b, gb, &theirs, "demo-theirs-two");
        assert!(ts.clipboard.user_copy("mine"));
        let opens = ts.clipboard.opens();
        let not_found = Some(ShellError::from(CoreError::NotFound));
        for (item, refusal) in [
            (key_id.as_str(), Some(NOT_A_LOGIN)),
            (note.as_str(), Some(NOT_A_LOGIN)),
            (theirs.as_str(), not_found),
            (ItemId::random().to_hex().as_str(), not_found),
        ] {
            assert_eq!(
                ts.shell
                    .reveal_password(s, g, item, RevealField::Previous(0))
                    .err(),
                refusal
            );
            assert_eq!(
                ts.shell
                    .copy_field(s, g, item, CopyField::Previous(0))
                    .err(),
                refusal
            );
        }
        assert_eq!(ts.clipboard.text().as_deref(), Some("mine"));
        assert_eq!(
            ts.clipboard.opens(),
            opens,
            "a refusal opened the clipboard"
        );
        // Left alone in its own vault.
        assert_eq!(
            ts.shell
                .reveal_password(b, gb, &theirs, RevealField::Previous(0))
                .unwrap()
                .data
                .as_str(),
            LOGIN_PW
        );

        // A lock clears a copy, and the old generation is refused afterwards, whatever is asked.
        ts.shell
            .copy_field(s, g, &id, CopyField::Previous(0))
            .unwrap();
        ts.shell.sessions.lock(s, LockReason::Manual);
        assert_eq!(ts.clipboard.text(), None, "the lock left it");
        assert_eq!(
            ts.shell
                .reveal_password(s, g, &id, RevealField::Previous(0))
                .err(),
            Some(ShellError::Locked)
        );
        assert_eq!(
            ts.shell.copy_field(s, g, &id, CopyField::Previous(0)).err(),
            Some(ShellError::Locked)
        );

        // A read-only copy reads them too: reading is not writing.
        let (r, gr) = read_only_session(&ts);
        assert_eq!(
            ts.shell
                .reveal_password(r, gr, &id, RevealField::Previous(1))
                .unwrap()
                .data
                .as_str(),
            LOGIN_PW
        );
        ts.shell
            .copy_field(r, gr, &id, CopyField::Previous(0))
            .unwrap();
        assert_eq!(ts.clipboard.text().as_deref(), Some("demo-pass-two"));
    }

    /// A number past the end of the list is refused with a fixed error, for Reveal and Copy alike, and nothing reaches
    /// the clipboard: none when there are none, and past the fifth, which is as many as are kept.
    #[test]
    fn previous_index_past_the_end_refused() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let id = login(&ts, s, g, "Bank");
        assert!(ts.clipboard.user_copy("mine"));
        let opens = ts.clipboard.opens();
        let refused = Some(NO_SUCH_EARLIER);
        let past = |from: u8| {
            for index in [from, from + 1, u8::MAX] {
                assert_eq!(
                    ts.shell
                        .reveal_password(s, g, &id, RevealField::Previous(index))
                        .err(),
                    refused,
                    "reveal {index}"
                );
                assert_eq!(
                    ts.shell
                        .copy_field(s, g, &id, CopyField::Previous(index))
                        .err(),
                    refused,
                    "copy {index}"
                );
            }
        };
        past(0);
        change_password(&ts, s, g, &id, "demo-pass-two");
        assert!(
            ts.shell
                .reveal_password(s, g, &id, RevealField::Previous(0))
                .is_ok()
        );
        past(1);
        for n in 3..=9 {
            change_password(&ts, s, g, &id, &format!("demo-pass-{n}"));
        }
        let detail = ts.shell.get_item(s, g, &id).unwrap().data;
        assert_eq!(detail.previous.len(), 5, "as many as are kept");
        assert!(
            ts.shell
                .reveal_password(s, g, &id, RevealField::Previous(4))
                .is_ok()
        );
        past(5);
        assert_eq!(ts.clipboard.text().as_deref(), Some("mine"));
        assert_eq!(
            ts.clipboard.opens(),
            opens,
            "a refusal opened the clipboard"
        );
    }

    /// An edit's websites are completed and checked as a new login's are: `https://` where there is no scheme, and only
    /// `http` and `https` addresses; a refusal writes nothing, whichever of several it is.
    #[test]
    fn edit_normalises_the_website() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let id = login(&ts, s, g, "Bank");
        let with_urls = |ts: &TestShell, urls: &[&str]| {
            let revision = revision_of(ts, s, g, &id);
            let change = ItemEdit {
                urls: Some(urls.iter().map(|url| (*url).to_owned()).collect()),
                ..edit(&id, revision, "Bank", None)
            };
            ts.shell.update_item(s, g, change)
        };
        for (typed, saved) in [
            ("example.com", "https://example.com"),
            (" bank.example/a ", "https://bank.example/a"),
            ("HTTP://Example.com", "HTTP://Example.com"),
            ("localhost:3000", "https://localhost:3000"),
            ("https://kept.example", "https://kept.example"),
        ] {
            with_urls(&ts, &[typed]).unwrap();
            let detail = ts.shell.get_item(s, g, &id).unwrap().data;
            assert_eq!(detail.urls, [saved], "{typed}");
        }
        with_urls(&ts, &["one.example", "https://two.example"]).unwrap();
        assert_eq!(
            ts.shell.get_item(s, g, &id).unwrap().data.urls,
            ["https://one.example", "https://two.example"]
        );

        let file = item_file(&ts, 0, &id);
        let before = fs::read(&file).unwrap();
        for bad in [
            "ftp://files.example",
            "javascript:alert(1)",
            "",
            "   ",
            "//host/x",
            r"C:\x.exe",
            "https://a.exa\nmple",
        ] {
            assert_eq!(
                with_urls(&ts, &["fine.example", bad]).err(),
                Some(NOT_A_WEBSITE),
                "{bad:?}"
            );
        }
        assert_eq!(fs::read(&file).unwrap(), before, "a refusal wrote");
        // Left out, the websites stay as they were.
        let revision = revision_of(&ts, s, g, &id);
        ts.shell
            .update_item(s, g, edit(&id, revision, "Bank", None))
            .unwrap();
        let detail = ts.shell.get_item(s, g, &id).unwrap().data;
        assert_eq!(detail.urls.len(), 1, "the edit helper sets one website");
        // And a refused website changes nothing else either: the password and the earlier ones stay.
        let change = ItemEdit {
            urls: Some(vec!["ftp://x".to_owned()]),
            ..edit(&id, revision + 1, "Renamed", Some("demo-never-saved"))
        };
        assert_eq!(
            ts.shell.update_item(s, g, change).err(),
            Some(NOT_A_WEBSITE)
        );
        assert_eq!(password_of(&ts, s, g, &id).as_str(), LOGIN_PW);
        assert!(
            ts.shell
                .get_item(s, g, &id)
                .unwrap()
                .data
                .previous
                .is_empty()
        );
    }

    /// An edit made from an old read of the item (the revision the page had) is refused whole, as the engine's
    /// `stale revision`, which the page puts in words ("changed meanwhile"): the item, its password and its earlier
    /// passwords stay as they were, a key's value too.
    #[test]
    fn edit_stale_revision_says_changed_meanwhile() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let id = login(&ts, s, g, "Bank");
        ts.shell
            .update_item(s, g, edit(&id, 1, "Bank (new title)", None))
            .unwrap();
        let file = item_file(&ts, 0, &id);
        let before = fs::read(&file).unwrap();
        let stale = Some(ShellError::from(CoreError::InvalidInput {
            what: "stale revision",
        }));
        for revision in [1, 3, 99] {
            let late = edit(&id, revision, "Bank (late)", Some("demo-late-password"));
            let refused = ts.shell.update_item(s, g, late).err();
            assert_eq!(refused, stale, "revision {revision}");
        }
        assert_eq!(
            serde_json::to_value(stale).unwrap(),
            json!({ "code": "core", "kind": "invalid_input", "what": "stale revision" })
        );
        assert_eq!(fs::read(&file).unwrap(), before);
        assert_eq!(password_of(&ts, s, g, &id).as_str(), LOGIN_PW);
        let detail = ts.shell.get_item(s, g, &id).unwrap().data;
        assert_eq!(
            (
                detail.summary.title.as_str(),
                detail.revision,
                detail.previous.len()
            ),
            ("Bank (new title)", 2, 0)
        );

        let key_id = key(&ts, s, g, "OPENAI_API_KEY");
        ts.shell
            .update_item(s, g, key_edit(&key_id, 0, "OPENAI_API_KEY", None))
            .unwrap();
        let before = fs::read(item_file(&ts, 0, &key_id)).unwrap();
        let late = key_edit(&key_id, 0, "RENAMED_KEY", Some("demo-late-value"));
        assert_eq!(ts.shell.update_item(s, g, late).err(), stale);
        assert_eq!(fs::read(item_file(&ts, 0, &key_id)).unwrap(), before);
        assert_eq!(
            ts.shell
                .reveal_password(s, g, &key_id, RevealField::KeyValue)
                .unwrap()
                .data
                .as_str(),
            KEY_VALUE
        );
    }

    /// A key's value changes in an edit, and is kept, byte for byte, when the edit does not send one: a value the page
    /// could not show in one line is not lost by saving a new name. Sent for a login or a note it is refused (`not a
    /// key`), a login's fields sent for a key are refused (`not a login`), the name rule and the value's limit hold, and
    /// a refusal changes nothing.
    #[test]
    fn key_edit_changes_value() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let id = key(&ts, s, g, "OPENAI_API_KEY");
        let value_of = || {
            ts.shell
                .reveal_password(s, g, &id, RevealField::KeyValue)
                .unwrap()
                .data
        };
        assert_eq!(value_of().as_str(), KEY_VALUE);

        // A value with line breaks and spaces round-trips exactly, and a rename that sends no value keeps it.
        let odd = "line one\nline two\r\n  tab\there  ";
        ts.shell
            .update_item(s, g, key_edit(&id, 0, "OPENAI_API_KEY", Some(odd)))
            .unwrap();
        assert_eq!(value_of().as_str(), odd);
        ts.shell
            .update_item(s, g, key_edit(&id, 1, "RENAMED_KEY", None))
            .unwrap();
        assert_eq!(value_of().as_str(), odd, "kept byte for byte");
        let detail = ts.shell.get_item(s, g, &id).unwrap().data;
        assert_eq!(
            (detail.summary.title.as_str(), detail.revision),
            ("RENAMED_KEY", 2)
        );
        assert!(detail.has_value && !detail.has_password);

        // A new value, with a new name in the same edit; the copy is the new one.
        ts.shell
            .update_item(s, g, key_edit(&id, 2, "THIRD_NAME", Some("demo-new-value")))
            .unwrap();
        assert_eq!(value_of().as_str(), "demo-new-value");
        ts.shell.copy_field(s, g, &id, CopyField::KeyValue).unwrap();
        assert_eq!(ts.clipboard.text().as_deref(), Some("demo-new-value"));
        // An empty value is a value too: it says "No value saved".
        ts.shell
            .update_item(s, g, key_edit(&id, 3, "THIRD_NAME", Some("")))
            .unwrap();
        assert!(!ts.shell.get_item(s, g, &id).unwrap().data.has_value);
        ts.shell
            .update_item(s, g, key_edit(&id, 4, "THIRD_NAME", Some(KEY_VALUE)))
            .unwrap();

        // The limit holds at its edge, and a refusal changes nothing; the name rule holds with a value.
        let file = item_file(&ts, 0, &id);
        let before = fs::read(&file).unwrap();
        let big = "k".repeat(16_385);
        assert_eq!(
            ts.shell
                .update_item(s, g, key_edit(&id, 5, "THIRD_NAME", Some(&big)))
                .err(),
            too_large_in("value")
        );
        let bad_name = Some(ShellError::from(CoreError::InvalidInput {
            what: "key name",
        }));
        for name in ["", "9NAME", "BAD NAME"] {
            let change = key_edit(&id, 5, name, Some("demo-never-saved"));
            assert_eq!(
                ts.shell.update_item(s, g, change).err(),
                bad_name,
                "{name:?}"
            );
        }
        assert_eq!(fs::read(&file).unwrap(), before);
        ts.shell
            .update_item(s, g, key_edit(&id, 5, "THIRD_NAME", Some(&big[1..])))
            .unwrap();
        assert_eq!(value_of().len(), 16_384);

        // A value sent for a login or a note, a login's fields sent for a key: refused, nothing written.
        let login_id = login(&ts, s, g, "Bank");
        let note = ts
            .shell
            .new_item(s, g, NewKind::Note, "Plans".into(), None, None)
            .unwrap()
            .data;
        for (item, revision) in [(&login_id, 1), (&note, 0)] {
            let before = fs::read(item_file(&ts, 0, item)).unwrap();
            let change = ItemEdit {
                username: None,
                urls: None,
                password: None,
                ..key_edit(item, revision, "Anything", Some("demo-value"))
            };
            assert_eq!(
                ts.shell.update_item(s, g, change).err(),
                Some(NOT_A_KEY),
                "{item}"
            );
            assert_eq!(fs::read(item_file(&ts, 0, item)).unwrap(), before);
        }
        let before = fs::read(&file).unwrap();
        let change = edit(&id, 6, "THIRD_NAME", Some("demo-pw"));
        assert_eq!(ts.shell.update_item(s, g, change).err(), Some(NOT_A_LOGIN));
        assert_eq!(fs::read(&file).unwrap(), before);
    }

    /// An edit never changes what it does not send: a login saved with a password that has a line break inside (a
    /// page's one-line box cannot hold it) keeps it byte for byte when the edit leaves the password out, moves nothing
    /// when the same one is sent, and moves it, as it was, into the earlier passwords when a new one is.
    #[test]
    fn edit_leaves_what_was_not_sent_as_it_was() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let odd = "demo line one\nline two\r\n end ";
        let id = ts
            .shell
            .new_item(
                s,
                g,
                NewKind::Login,
                "Bank".into(),
                None,
                Some(ItemFields {
                    username: "ada@example.com".into(),
                    password: secret(odd),
                    urls: vec!["https://bank.example".into()],
                    notes: secret("a\r\nb"),
                    ..ItemFields::default()
                }),
            )
            .unwrap()
            .data;
        let only_title = |revision: u64, password: Option<&str>| ItemEdit {
            id: id.clone(),
            revision,
            title: "Bank, renamed".into(),
            notes: secret("a\r\nb"),
            collection: None,
            username: None,
            password: password.map(secret),
            urls: None,
            key_value: None,
        };
        ts.shell.update_item(s, g, only_title(0, None)).unwrap();
        assert_eq!(
            password_of(&ts, s, g, &id).as_str(),
            odd,
            "kept byte for byte"
        );
        ts.shell
            .update_item(s, g, only_title(1, Some(odd)))
            .unwrap();
        assert_eq!(password_of(&ts, s, g, &id).as_str(), odd);
        let detail = ts.shell.get_item(s, g, &id).unwrap().data;
        assert!(detail.previous.is_empty(), "the same password moved");
        assert_eq!(detail.urls, ["https://bank.example"]);
        assert_eq!(detail.notes.as_str(), "a\r\nb");
        assert_eq!(detail.summary.username.as_deref(), Some("ada@example.com"));

        ts.shell
            .update_item(s, g, only_title(2, Some("demo-changed")))
            .unwrap();
        assert_eq!(password_of(&ts, s, g, &id).as_str(), "demo-changed");
        let moved = ts
            .shell
            .reveal_password(s, g, &id, RevealField::Previous(0))
            .unwrap();
        assert_eq!(moved.data.as_str(), odd, "moved as it was");
    }

    /// The one write that can carry a key's value or a login's password is the edit, and it is refused where the
    /// vault cannot be written, for a stale generation and for an item of another vault, with nothing written.
    #[test]
    fn edit_with_a_value_is_refused_stale_foreign_and_read_only() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let id = key(&ts, s, g, "OPENAI_API_KEY");
        let login_id = login(&ts, s, g, "Bank");
        let (b, gb) = open_vault(&ts, "Work");
        let theirs = key(&ts, b, gb, "THEIR_KEY");
        let before = fs::read(item_file(&ts, 0, &id)).unwrap();

        let ((stale, foreign, foreign_login), writes) = item_writes(|| {
            (
                ts.shell
                    .update_item(s, g + 1, key_edit(&id, 0, "OPENAI_API_KEY", Some("demo-x")))
                    .err(),
                ts.shell
                    .update_item(s, g, key_edit(&theirs, 0, "THEIR_KEY", Some("demo-x")))
                    .err(),
                ts.shell
                    .update_item(s, g, edit(&theirs, 0, "Bank", Some("demo-x")))
                    .err(),
            )
        });
        assert_eq!(stale, Some(ShellError::Locked));
        let not_found = Some(ShellError::from(CoreError::NotFound));
        assert_eq!((foreign, foreign_login), (not_found, not_found));
        assert_eq!(writes, 0);
        assert_eq!(fs::read(item_file(&ts, 0, &id)).unwrap(), before);
        assert_eq!(
            ts.shell
                .reveal_password(b, gb, &theirs, RevealField::KeyValue)
                .unwrap()
                .data
                .as_str(),
            KEY_VALUE
        );

        let (r, gr) = read_only_session(&ts);
        let (refused, writes) = item_writes(|| {
            [
                ts.shell
                    .update_item(r, gr, key_edit(&id, 0, "OPENAI_API_KEY", Some("demo-x")))
                    .err(),
                ts.shell
                    .update_item(r, gr, edit(&login_id, 1, "Bank", Some("demo-x")))
                    .err(),
            ]
        });
        assert_eq!(
            refused,
            [Some(ShellError::ReadOnly), Some(ShellError::ReadOnly)]
        );
        assert_eq!(writes, 0);
        assert_eq!(fs::read(item_file(&ts, 0, &id)).unwrap(), before);
    }

    /// The edit request says its fields and no others: a key's value is one, an earlier password never is (nothing but
    /// the engine writes the list), and `previous` is a number in a reveal or a copy, never a bare word or a number past
    /// what fits.
    #[test]
    fn edit_and_previous_requests_are_strict() {
        let body = |value: Value| InvokeBody::Json(value);
        let id = "0".repeat(32);
        let edit = |extra: Value| {
            let mut edit = json!({
                "id": id, "revision": 1, "title": "t", "notes": "n", "collection": null,
            });
            for (name, value) in extra.as_object().unwrap() {
                edit[name] = value.clone();
            }
            json!({ "session": 1, "generation": 1, "edit": edit })
        };
        for good in [
            json!({}),
            json!({ "key_value": "v" }),
            json!({ "key_value": null }),
            json!({ "username": "u", "password": "p", "urls": ["https://a.example"] }),
        ] {
            assert!(
                parse::<UpdateItem>(&body(edit(good.clone()))).is_ok(),
                "{good}"
            );
        }
        for bad in [
            json!({ "previous_passwords": [] }),
            json!({ "previous_passwords": [{ "password": "x", "replaced_at": "t" }] }),
            json!({ "previous": [] }),
            // Where an item sits in the trash is the engine's to write: a move, a rename or an edit cannot set it.
            json!({ "trashed_with": "00".repeat(16) }),
            json!({ "trashed_at": "2026-11-10T00:00:00Z" }),
            json!({ "trashed": true }),
            json!({ "purging": false }),
            json!({ "key_value": 5 }),
            json!({ "value": "v" }),
        ] {
            assert_eq!(
                parse::<UpdateItem>(&body(edit(bad.clone()))).err(),
                Some(MALFORMED),
                "{bad}"
            );
        }

        for field in [json!({ "previous": 0 }), json!({ "previous": 255 })] {
            let request = json!({ "session": 1, "generation": 1, "id": id, "field": field });
            assert!(
                parse::<RevealArgs>(&body(request.clone())).is_ok(),
                "{field}"
            );
            assert!(parse::<CopyFieldArgs>(&body(request)).is_ok(), "{field}");
        }
        for field in [
            json!("previous"),
            json!({ "previous": 256 }),
            json!({ "previous": -1 }),
            json!({ "previous": "0" }),
            json!({ "previous": 1.5 }),
            json!({ "previous": null }),
            json!({ "previous": 0, "other": 1 }),
            json!({ "Previous": 0 }),
        ] {
            let request = json!({ "session": 1, "generation": 1, "id": id, "field": field });
            assert_eq!(
                parse::<RevealArgs>(&body(request.clone())).err(),
                Some(MALFORMED),
                "reveal {field}"
            );
            assert_eq!(
                parse::<CopyFieldArgs>(&body(request)).err(),
                Some(MALFORMED),
                "copy {field}"
            );
        }
    }

    // Move, trash and folders (Task 14). A move is `update_item` with a new folder, a rename is `update_item` on the
    // folder with a new title, a new folder is `new_item` of kind collection, and the Trash view reads what the list
    // holds: no command of its own.

    /// A folder named `name`: its ID.
    fn folder(ts: &TestShell, session: SessionId, generation: u64, name: &str) -> String {
        ts.shell
            .new_item(
                session,
                generation,
                NewKind::Collection,
                name.to_owned(),
                None,
                None,
            )
            .unwrap()
            .data
    }

    /// A note titled `title`, in `folder` when given: its ID.
    fn note_in(
        ts: &TestShell,
        session: SessionId,
        generation: u64,
        title: &str,
        folder: Option<&String>,
    ) -> String {
        ts.shell
            .new_item(
                session,
                generation,
                NewKind::Note,
                title.to_owned(),
                folder.cloned(),
                None,
            )
            .unwrap()
            .data
    }

    /// An edit of a note or a folder: its title, and the folder it is to be in.
    fn plain_edit(id: &str, revision: u64, title: &str, folder: Option<&String>) -> ItemEdit {
        ItemEdit {
            id: id.to_owned(),
            revision,
            title: title.to_owned(),
            notes: secret(""),
            collection: folder.cloned(),
            username: None,
            password: None,
            urls: None,
            key_value: None,
        }
    }

    /// The list as the page reads it, as JSON, and one item of it by ID.
    fn listed(ts: &TestShell, session: SessionId, generation: u64) -> Value {
        serde_json::to_value(ts.shell.list_items(session, generation).unwrap().data).unwrap()["items"].clone()
    }

    fn row<'a>(list: &'a Value, id: &str) -> &'a Value {
        list.as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == json!(id))
            .unwrap()
    }

    /// The number the page says a folder's restore brings back, worked out from the list the page holds as the page does
    /// (`TrashView`): the items in the trash that went with that folder, are still filed in it and are not being deleted for
    /// good.
    fn page_count(list: &Value, folder: &str) -> usize {
        list.as_array()
            .unwrap()
            .iter()
            .filter(|item| {
                item["trashed"] == json!(true)
                    && item["purging"] == json!(false)
                    && item["trashed_with"] == json!(folder)
                    && item["collection"] == json!(folder)
            })
            .count()
    }

    /// The Trash view needs when an item went there and with which folder, and gets exactly that: an item deleted with
    /// its folder names it, one trashed on its own and the folder itself name none.
    #[test]
    fn trash_view_reads_when_and_with_which_folder() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let work = folder(&ts, s, g, "Work");
        let inside = note_in(&ts, s, g, "Inside", Some(&work));
        let alone = note_in(&ts, s, g, "Alone", None);
        let live = note_in(&ts, s, g, "Live", None);
        ts.shell.trash_item(s, g, &alone).unwrap();
        assert_eq!(ts.shell.delete_collection(s, g, &work).unwrap().data, 1);

        let list = listed(&ts, s, g);
        assert_eq!(row(&list, &inside)["trashed_with"], json!(work));
        for id in [&alone, &work] {
            assert_eq!(row(&list, id)["trashed_with"], Value::Null, "{id}");
        }
        for id in [&inside, &alone, &work] {
            let when = row(&list, id)["trashed_at"].as_str().unwrap();
            assert!(when.ends_with('Z') && when.len() == 20, "{when}");
            assert_eq!(row(&list, id)["trashed"], json!(true));
            assert_eq!(row(&list, id)["purging"], json!(false));
        }
        assert_eq!(row(&list, &live)["trashed_at"], Value::Null);
        assert_eq!(row(&list, &live)["trashed_with"], Value::Null);

        // After a restore the field is gone from the list too.
        ts.shell.restore_item(s, g, &inside).unwrap();
        let list = listed(&ts, s, g);
        assert_eq!(row(&list, &inside)["trashed_with"], Value::Null);
        assert_eq!(row(&list, &inside)["trashed_at"], Value::Null);
    }

    /// The number the page shows for a folder in the Trash ("the 3 items that went with it") is what Restore brings back:
    /// the case is built through the shell, with an item trashed before the delete and one being deleted for good, and the
    /// page's own count is compared with what `restore_item` restores.
    #[test]
    fn the_page_count_is_what_a_folder_restore_brings_back() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let work = folder(&ts, s, g, "Work");
        let members: Vec<String> = (0..4)
            .map(|n| note_in(&ts, s, g, &format!("Note {n}"), Some(&work)))
            .collect();
        let earlier = note_in(&ts, s, g, "Earlier", Some(&work));
        ts.shell.trash_item(s, g, &earlier).unwrap();
        assert_eq!(ts.shell.delete_collection(s, g, &work).unwrap().data, 4);
        // One of the four is now being deleted for good: it stays in the trash whatever a restore does.
        failpoint::arm("purge.after_mark");
        assert!(ts.shell.purge_item(s, g, &members[1]).is_err());
        failpoint::disarm_all();

        let before = listed(&ts, s, g);
        assert_eq!(row(&before, &members[1])["purging"], json!(true));
        let shown = page_count(&before, &work);
        assert_eq!(shown, 3, "four went with it, one is being deleted");

        ts.shell.restore_item(s, g, &work).unwrap();
        let after = listed(&ts, s, g);
        let back = before
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["id"] != json!(work))
            .filter(|item| {
                item["trashed"] == json!(true)
                    && row(&after, item["id"].as_str().unwrap())["trashed"] == json!(false)
            })
            .count();
        assert_eq!(
            back, shown,
            "the page said {shown}, restore brought back {back}"
        );
        assert_eq!(row(&after, &work)["trashed"], json!(false));
        assert_eq!(row(&after, &earlier)["trashed"], json!(true));
        assert_eq!(row(&after, &members[1])["trashed"], json!(true));
        assert_eq!(page_count(&after, &work), 0);
    }

    /// Each command that changes the trash or the folders is refused with a stale generation (`Locked`), writes nothing,
    /// and changes nothing, before and after a real lock.
    #[test]
    fn trash_and_folder_commands_refuse_a_stale_generation() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let work = folder(&ts, s, g, "Work");
        let inside = note_in(&ts, s, g, "Inside", Some(&work));
        let gone = note_in(&ts, s, g, "Gone", None);
        ts.shell.trash_item(s, g, &gone).unwrap();
        let locked = Some(ShellError::Locked);
        let attempts = |generation: u64| {
            let shell = &ts.shell;
            [
                shell.trash_item(s, generation, &inside).err(),
                shell.restore_item(s, generation, &gone).err(),
                shell.restore_item(s, generation, &work).err(),
                shell.purge_item(s, generation, &gone).err(),
                shell.delete_collection(s, generation, &work).err(),
                shell
                    .update_item(s, generation, plain_edit(&inside, 0, "Inside", None))
                    .err(),
                shell
                    .update_item(s, generation, plain_edit(&work, 0, "Renamed", None))
                    .err(),
                shell
                    .new_item(s, generation, NewKind::Collection, "New".into(), None, None)
                    .err(),
            ]
        };
        let (refused, writes) = item_writes(|| attempts(g + 1));
        assert_eq!(refused, [locked; 8]);
        assert_eq!(writes, 0);
        let list = listed(&ts, s, g);
        assert_eq!(row(&list, &inside)["trashed"], json!(false));
        assert_eq!(row(&list, &work)["title"], json!("Work"));
        assert_eq!(row(&list, &gone)["trashed"], json!(true));

        // And the old generation after a lock.
        ts.shell.sessions.lock(s, LockReason::Manual);
        let (refused, writes) = item_writes(|| attempts(g));
        assert_eq!(refused, [locked; 8]);
        assert_eq!(writes, 0);
    }

    /// Every command of the trash and the folders is refused for an item of another vault (`NotFound`) and in a read-only
    /// copy, where nothing is written.
    #[test]
    fn trash_and_folder_commands_refuse_a_foreign_id_and_a_read_only_copy() {
        let ts = TestShell::new();
        let (a, ga) = open_vault(&ts, "Family");
        let (b, gb) = open_vault(&ts, "Work");
        let theirs = folder(&ts, b, gb, "Theirs");
        let their_note = note_in(&ts, b, gb, "Their note", Some(&theirs));
        let mine = note_in(&ts, a, ga, "Mine", None);
        let not_found = Some(ShellError::from(CoreError::NotFound));
        let (refused, writes) = item_writes(|| {
            let shell = &ts.shell;
            [
                shell.trash_item(a, ga, &their_note).err(),
                shell.restore_item(a, ga, &their_note).err(),
                shell.purge_item(a, ga, &their_note).err(),
                shell.delete_collection(a, ga, &theirs).err(),
                shell
                    .update_item(a, ga, plain_edit(&their_note, 0, "x", None))
                    .err(),
                shell
                    .update_item(a, ga, plain_edit(&theirs, 0, "x", None))
                    .err(),
            ]
        });
        assert_eq!(refused, [not_found; 6]);
        assert_eq!(writes, 0);
        // Moving my item into their folder is refused as a folder that is not here.
        let (moved, writes) = item_writes(|| {
            ts.shell
                .update_item(a, ga, plain_edit(&mine, 0, "Mine", Some(&theirs)))
                .err()
        });
        assert_eq!(
            moved,
            Some(CoreError::InvalidInput { what: "collection" }.into())
        );
        assert_eq!(writes, 0);

        // A read-only copy of the first vault: no write of any of these goes through.
        let folder_a = folder(&ts, a, ga, "Mine too");
        ts.shell.trash_item(a, ga, &mine).unwrap();
        let (r, gr) = read_only_session(&ts);
        let read_only = Some(ShellError::ReadOnly);
        let (refused, writes) = item_writes(|| {
            let shell = &ts.shell;
            [
                shell
                    .new_item(r, gr, NewKind::Collection, "New".into(), None, None)
                    .err(),
                shell
                    .update_item(r, gr, plain_edit(&folder_a, 0, "Renamed", None))
                    .err(),
                shell
                    .update_item(r, gr, plain_edit(&mine, 1, "Mine", Some(&folder_a)))
                    .err(),
                shell.delete_collection(r, gr, &folder_a).err(),
                shell.trash_item(r, gr, &folder_a).err(),
                shell.restore_item(r, gr, &mine).err(),
                shell.purge_item(r, gr, &mine).err(),
            ]
        });
        assert_eq!(refused, [read_only; 7]);
        assert_eq!(writes, 0);
        let list = serde_json::to_value(ts.shell.list_items(r, gr).unwrap().data).unwrap()["items"]
            .clone();
        assert_eq!(
            row(&list, &mine)["trashed"],
            json!(true),
            "the list still reads"
        );
    }

    /// A move is an edit with a new folder, from the revision the page read: it works into a folder and out of it, and is
    /// refused (nothing moves) into a folder that is in the trash or is not there, from a stale revision, and for a
    /// folder, which never sits in another.
    #[test]
    fn a_move_goes_into_a_live_folder_and_out_again() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let work = folder(&ts, s, g, "Work");
        let home = folder(&ts, s, g, "Home");
        let note = note_in(&ts, s, g, "Plans", Some(&work));
        let invalid = |what: &'static str| Some(ShellError::from(CoreError::InvalidInput { what }));

        // Into another folder, and out of any.
        let revision = revision_of(&ts, s, g, &note);
        ts.shell
            .update_item(s, g, plain_edit(&note, revision, "Plans", Some(&home)))
            .unwrap();
        assert_eq!(row(&listed(&ts, s, g), &note)["collection"], json!(home));
        let revision = revision_of(&ts, s, g, &note);
        assert_eq!(revision, 1, "a move counts as an edit");
        ts.shell
            .update_item(s, g, plain_edit(&note, revision, "Plans", None))
            .unwrap();
        assert_eq!(row(&listed(&ts, s, g), &note)["collection"], Value::Null);

        // A stale revision moves nothing.
        let (stale, writes) = item_writes(|| {
            ts.shell
                .update_item(s, g, plain_edit(&note, 0, "Plans", Some(&work)))
                .err()
        });
        assert_eq!(stale, invalid("stale revision"));
        assert_eq!(writes, 0);
        assert_eq!(row(&listed(&ts, s, g), &note)["collection"], Value::Null);

        // A folder in the trash, a folder that is not there, and a note that is not a folder are not places to move to.
        let revision = revision_of(&ts, s, g, &note);
        let other = note_in(&ts, s, g, "Other", None);
        let missing = "ab".repeat(16);
        ts.shell.delete_collection(s, g, &home).unwrap();
        let (refused, writes) = item_writes(|| {
            [
                ts.shell
                    .update_item(s, g, plain_edit(&note, revision, "Plans", Some(&home)))
                    .err(),
                ts.shell
                    .update_item(s, g, plain_edit(&note, revision, "Plans", Some(&missing)))
                    .err(),
                ts.shell
                    .update_item(s, g, plain_edit(&note, revision, "Plans", Some(&other)))
                    .err(),
            ]
        });
        assert_eq!(refused, [invalid("collection"); 3]);
        assert_eq!(writes, 0);
        assert_eq!(row(&listed(&ts, s, g), &note)["collection"], Value::Null);

        // A folder never sits in a folder.
        let revision = revision_of(&ts, s, g, &work);
        assert_eq!(
            ts.shell
                .update_item(s, g, plain_edit(&work, revision, "Work", Some(&work)))
                .err(),
            invalid("collection")
        );
        let inner = folder(&ts, s, g, "Inner");
        let revision = revision_of(&ts, s, g, &inner);
        assert_eq!(
            ts.shell
                .update_item(s, g, plain_edit(&inner, revision, "Inner", Some(&work)))
                .err(),
            invalid("collection inside a collection")
        );
        assert_eq!(
            ts.shell
                .new_item(
                    s,
                    g,
                    NewKind::Collection,
                    "Deep".into(),
                    Some(work.clone()),
                    None
                )
                .err(),
            invalid("collection inside a collection")
        );
    }

    /// A folder's name follows the title limit and may not be empty once trimmed; the same name as another folder is
    /// allowed, as it is for items; a rename sends the folder's revision, and a stale one changes nothing.
    #[test]
    fn folder_names_new_and_renamed() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let empty = Some(ShellError::InvalidInput {
            what: "folder name",
        });
        let new = |title: &str| {
            ts.shell
                .new_item(s, g, NewKind::Collection, title.to_owned(), None, None)
        };

        // Empty after trimming: refused, and nothing is written.
        let (refused, writes) =
            item_writes(|| ["", " ", "   ", "\t\n"].map(|title| new(title).err()));
        assert_eq!(refused, [empty; 4]);
        assert_eq!(writes, 0);
        assert_eq!(item_files(&ts, 0), 0);

        // The title limit, in bytes, as for every title; and exactly at it works.
        assert!(matches!(
            new(&"a".repeat(MAX_TITLE + 1)).err(),
            Some(ShellError::TooLarge { .. })
        ));
        assert_eq!(item_files(&ts, 0), 0);
        let long = new(&"a".repeat(MAX_TITLE)).unwrap().data;

        // Kept trimmed, and the same name twice makes two folders.
        let one = new("  Work  ").unwrap().data;
        let two = new("Work").unwrap().data;
        assert_ne!(one, two);
        let list = listed(&ts, s, g);
        assert_eq!(row(&list, &one)["title"], json!("Work"));
        assert_eq!(row(&list, &two)["title"], json!("Work"));
        assert_eq!(row(&list, &long)["kind"], json!("collection"));

        // A rename: from the revision read, trimmed, never empty, and the same name as another folder is fine.
        let revision = revision_of(&ts, s, g, &one);
        let (refused, writes) = item_writes(|| {
            ["", "  ", "\t"].map(|title| {
                ts.shell
                    .update_item(s, g, plain_edit(&one, revision, title, None))
                    .err()
            })
        });
        assert_eq!(refused, [empty; 3]);
        assert_eq!(writes, 0);
        assert!(matches!(
            ts.shell
                .update_item(
                    s,
                    g,
                    plain_edit(&one, revision, &"a".repeat(MAX_TITLE + 1), None)
                )
                .err(),
            Some(ShellError::TooLarge { .. })
        ));
        ts.shell
            .update_item(s, g, plain_edit(&one, revision, " Client work ", None))
            .unwrap();
        assert_eq!(row(&listed(&ts, s, g), &one)["title"], json!("Client work"));
        ts.shell
            .update_item(
                s,
                g,
                plain_edit(&two, revision_of(&ts, s, g, &two), "Client work", None),
            )
            .unwrap();

        // A stale revision changes nothing and says so.
        let (stale, writes) = item_writes(|| {
            ts.shell
                .update_item(s, g, plain_edit(&one, revision, "Late", None))
                .err()
        });
        assert_eq!(
            stale,
            Some(
                CoreError::InvalidInput {
                    what: "stale revision"
                }
                .into()
            )
        );
        assert_eq!(writes, 0);
        assert_eq!(row(&listed(&ts, s, g), &one)["title"], json!("Client work"));

        // A rename keeps what is in the folder.
        let held = note_in(&ts, s, g, "Held", Some(&one));
        let revision = revision_of(&ts, s, g, &one);
        ts.shell
            .update_item(s, g, plain_edit(&one, revision, "Renamed", None))
            .unwrap();
        assert_eq!(row(&listed(&ts, s, g), &held)["collection"], json!(one));
        // A folder takes no login fields.
        let mut login_edit = plain_edit(&one, revision + 1, "Renamed", None);
        login_edit.password = Some(secret("demo-zzz-qqq-one"));
        assert_eq!(
            ts.shell.update_item(s, g, login_edit).err(),
            Some(NOT_A_LOGIN)
        );
    }

    /// Restoring a folder through the shell brings back what went with it, once, and says how many went (`delete_collection`
    /// answers the number); a folder is not trashed on its own (`trash_item` says to delete it).
    #[test]
    fn delete_and_restore_a_folder_through_the_shell() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let work = folder(&ts, s, g, "Work");
        let members: Vec<String> = (0..3)
            .map(|n| note_in(&ts, s, g, &format!("Note {n}"), Some(&work)))
            .collect();
        assert_eq!(
            ts.shell.trash_item(s, g, &work).err(),
            Some(
                CoreError::InvalidInput {
                    what: "use delete_collection"
                }
                .into()
            )
        );
        assert_eq!(ts.shell.delete_collection(s, g, &work).unwrap().data, 3);
        let list = listed(&ts, s, g);
        assert_eq!(page_count(&list, &work), 3);
        let (_, writes) = item_writes(|| ts.shell.restore_item(s, g, &work).unwrap());
        assert_eq!(writes, 4);
        let list = listed(&ts, s, g);
        for id in members.iter().chain([&work]) {
            assert_eq!(row(&list, id)["trashed"], json!(false), "{id}");
            assert_eq!(row(&list, id)["trashed_with"], Value::Null);
        }
        // Once more: nothing to do.
        let (_, writes) = item_writes(|| ts.shell.restore_item(s, g, &work).unwrap());
        assert_eq!(writes, 0);
    }

    /// A trashed item is not moved into a folder by a page that sends the edit all the same: it goes with the folder it
    /// was in only while it names it, and a move of a trashed item leaves it in the trash.
    #[test]
    fn moving_a_trashed_item_leaves_it_in_the_trash_and_out_of_the_old_folders_restore() {
        let ts = TestShell::new();
        let (s, g) = open_vault(&ts, "Family");
        let work = folder(&ts, s, g, "Work");
        let home = folder(&ts, s, g, "Home");
        let a = note_in(&ts, s, g, "A", Some(&work));
        let b = note_in(&ts, s, g, "B", Some(&work));
        ts.shell.delete_collection(s, g, &work).unwrap();
        let revision = revision_of(&ts, s, g, &a);
        ts.shell
            .update_item(s, g, plain_edit(&a, revision, "A", Some(&home)))
            .unwrap();
        let list = listed(&ts, s, g);
        assert_eq!(row(&list, &a)["trashed"], json!(true));
        assert_eq!(page_count(&list, &work), 1, "only B still counts");
        ts.shell.restore_item(s, g, &work).unwrap();
        let list = listed(&ts, s, g);
        assert_eq!(row(&list, &b)["trashed"], json!(false));
        assert_eq!(row(&list, &a)["trashed"], json!(true), "A went elsewhere");
    }
}
