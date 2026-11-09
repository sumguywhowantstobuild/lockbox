//! Items, search and links (spec §4.1): what crosses to the page, and when. Every answer is built from the views in
//! [`crate::views`]: a password crosses only through `reveal_password`, never a file key or a nonce.
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
/// The search query's limit, in characters.
const MAX_QUERY_CHARS: usize = 256;
/// The most results one vault gives a search.
const SEARCH_LIMIT: usize = 100;

/// A password, username or link asked of an item that is not a login.
const NOT_A_LOGIN: ShellError = ShellError::InvalidInput {
    what: "not a login",
};

/// A link number past the login's links (`copy_field`).
const NO_SUCH_LINK: ShellError = ShellError::InvalidInput { what: "link" };

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
    Note,
    Collection,
}

/// The fields a new item starts with, saved with it in one write (`new_item`). No `Debug`: it holds item content and
/// maybe a password. Any field may be left out. Only a login takes them: any sent for another kind are refused.
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct ItemFields {
    pub username: String,
    pub password: Zeroizing<String>,
    pub urls: Vec<String>,
    pub notes: Zeroizing<String>,
}

impl ItemFields {
    /// The page's limits, checked before anything is written (and before a website is looked at).
    fn check(&self) -> ShellResult<()> {
        at_most(&self.username, MAX_USERNAME, "username")?;
        at_most(&self.password, MAX_PASSWORD, "password")?;
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

/// The field `copy_field` copies: `"password"`, `"username"`, `"notes"`, or `{ "url": <index> }`, the index into the
/// login's links.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CopyField {
    Password,
    Username,
    Url(u8),
    Notes,
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
        } = self;
        match &mut stored.kind {
            ItemKind::Login {
                username: stored_username,
                password: stored_password,
                urls: stored_urls,
            } => {
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
            _ if username.is_some() || password.is_some() || urls.is_some() => {
                return Err(NOT_A_LOGIN);
            }
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

    /// A login's password, on the user's "Reveal" (spec §4.1): the one command that sends it to the page.
    pub fn reveal_password(
        &self,
        session: SessionId,
        generation: u64,
        id: &str,
    ) -> ShellResult<Tagged<Zeroizing<String>>> {
        let id = item_id(id)?;
        self.sessions.read(session, generation, |vault, _| {
            let password = match &items(&vault).item(&id)?.kind {
                ItemKind::Login { password, .. } => password.clone(),
                _ => return Err(NOT_A_LOGIN),
            };
            read_done()?;
            Ok(password)
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
        let (kind, notes) = match (kind, fields) {
            (NewKind::Login, fields) => {
                let ItemFields {
                    username,
                    password,
                    urls,
                    notes,
                } = fields.unwrap_or_default();
                let urls = urls.iter().map(|url| normalise_url(url));
                let urls = urls.collect::<ShellResult<Vec<String>>>()?;
                let login = ItemKind::Login {
                    username,
                    password,
                    urls,
                };
                (login, notes)
            }
            // Only a login starts with fields (a note's come with its own task): any sent for another kind are refused.
            (NewKind::Note, None) => (ItemKind::Note, Zeroizing::default()),
            (NewKind::Collection, None) => (ItemKind::Collection, Zeroizing::default()),
            (NewKind::Note | NewKind::Collection, Some(_)) => return Err(NOT_A_LOGIN),
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
        edit: ItemEdit,
    ) -> ShellResult<Tagged<()>> {
        edit.check()?;
        let id = item_id(&edit.id)?;
        let collection = collection_id(edit.collection.as_deref())?;
        self.sessions.write(session, generation, |vault, _| {
            let next = edit.applied_to(vault.get_item(&id)?.clone(), collection)?;
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
    let ItemArgs {
        session,
        generation,
        id,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.reveal_password(session, generation, &id)).await
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
            "trashed": false, "site": "bank.example",
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
                "has_password": true,
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
            "trashed": false, "site": "bank.example",
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
                "has_password": true,
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
        let revealed = ts.shell.reveal_password(s, g, &id).unwrap();
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
            ts.shell.reveal_password(s, g, &note).err(),
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
        assert_eq!(shell.reveal_password(a, ga, &foreign).err(), not_found);
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
        assert_eq!(
            ts.shell.reveal_password(s, g, &id).unwrap().data.as_str(),
            LOGIN_PW
        );
        let detail = ts.shell.get_item(s, g, &id).unwrap().data;
        assert_eq!(detail.summary.title, "Bank (old)");
        assert_eq!(detail.revision, 2);
        assert!(detail.has_password);
        // A new password replaces it.
        ts.shell
            .update_item(s, g, edit(&id, 2, "Bank", Some("another one")))
            .unwrap();
        assert_eq!(
            ts.shell.reveal_password(s, g, &id).unwrap().data.as_str(),
            "another one"
        );
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
                urls: Some(vec![long(2048); 32]),
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
        let revealed = ts.shell.reveal_password(family, gf, &id);
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
        let urls = Some(links.iter().map(|link| link.to_string()).collect());
        ts.shell
            .update_item(
                s,
                g,
                ItemEdit {
                    urls,
                    ..edit(&id, 1, "Links", None)
                },
            )
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
            shell.reveal_password(r, gr, &id).unwrap().data.as_str(),
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
        assert_eq!(
            ts.shell.reveal_password(s, g, &id).unwrap().data.as_str(),
            LOGIN_PW
        );

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

        // Only a login starts with fields. A note or a folder made as before (no fields) is still made, and any fields
        // sent for either, a login's own or notes alone, are refused with nothing written.
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
                try_kind(NewKind::Note, notes_only()),
                try_kind(NewKind::Note, ItemFields::default()),
                try_kind(NewKind::Collection, ItemFields::default()),
                try_kind(NewKind::Collection, notes_only()),
            ]
        });
        assert_eq!(refused, [Some(NOT_A_LOGIN); 5]);
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
}
