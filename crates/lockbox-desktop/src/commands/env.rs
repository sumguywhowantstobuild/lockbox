//! `.env` in and out (spec §4.1; the design's "`.env` rules"). A pasted `.env` goes page to Rust once, like a typed
//! password, and comes back as rows with names only: the values wait in [`Pending`](crate::pending::Pending) behind a
//! one-time token until `env_save` writes them as key items (or a lock, five minutes or Cancel lets them go). A folder's
//! keys go out in Rust, as a clipboard copy or a saved file: no text of theirs reaches the page.
//!
//! The rules the page relies on are worked out here and nowhere else: which rows clash in which place, the name Keep both
//! gives (`NAME_2`, or the next free number), and what each choice does. The engine's `.env` reader and writer
//! (`lockbox_core::env_file`) do the reading and the writing; the writer trusts its names, and every name handed to it
//! here is a key item's, which the engine checked when it was saved.
//!
//! Refusals carry fixed text and numbers only (R5): never a value, a name, a path or a line. The one answer that names
//! something is `EnvOut::Duplicate`, the person's own key name in a tagged answer (like `MissingFiles`), never in a
//! `ShellError`.

use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::sync::{Arc, Weak};

use lockbox_core::Vault;
use lockbox_core::blob::{CancelToken, OutputJournal};
use lockbox_core::env_file::{self, EnvEntry};
use lockbox_core::fsio::{hidden_temp_path, publish_readable};
use lockbox_core::ids::ItemId;
use lockbox_core::item::{Item, ItemKind};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Request;
use zeroize::Zeroizing;

use super::items::{MAX_KEY_VALUE, MAX_TITLE, at_most, collection_id, item_id};
use super::readable::ReadableJob;
use super::{args, blocking};
use crate::error::{Outcome, ShellError, ShellResult};
use crate::outputs::LAUNCH_OPEN_TRIES;
use crate::pending::{PendingChoice, Token};
use crate::restore::shown;
use crate::session::{LockHook, SessionId, Sessions, Tagged, VaultRef};
use crate::shell::Shell;
use crate::views::SavedView;

/// The most pasted text `env_read` takes, in bytes.
const MAX_TEXT: usize = 1_048_576;
/// The most keys one paste may hold.
const MAX_KEYS: usize = 500;

/// The pasted text is over [`MAX_TEXT`].
const TEXT_TOO_LARGE: ShellError = ShellError::TooLarge { what: "env text" };
/// The paste holds more than [`MAX_KEYS`] keys.
const TOO_MANY_KEYS: ShellError = ShellError::TooLarge { what: "env keys" };
/// The choices do not fit the folder as it is now.
const BAD_ROWS: ShellError = ShellError::InvalidInput { what: "env rows" };
/// Replace found the name twice in the folder, or the folder gained a second key of one name.
const TWICE: ShellError = ShellError::InvalidInput { what: "env twice" };
/// The folder has no key to take out.
const NO_KEYS: ShellError = ShellError::InvalidInput { what: "no keys" };

/// One key read from a pasted `.env`: its place among the keys read (from 0) and its name. Never its value. No `Debug`:
/// a name is item content (R5).
#[derive(Serialize)]
pub struct EnvRow {
    pub index: u32,
    pub name: String,
}

/// A row whose name is already taken in one place, and the name Keep both saves it under there.
#[derive(Serialize)]
pub struct EnvClash {
    pub index: u32,
    pub saved_as: String,
}

/// The rows that clash in one place: a live folder (its id as the page knows it), or no folder (`None`).
#[derive(Serialize)]
pub struct EnvClashes {
    pub collection: Option<String>,
    pub rows: Vec<EnvClash>,
}

/// What a pasted `.env` came to: the token its values wait under (`None` when no key was read, and then nothing waits),
/// the keys' names, the numbers of the lines that could not be read, and the clashes in every place.
#[derive(Serialize)]
pub struct EnvRows {
    pub token: Option<Token>,
    pub rows: Vec<EnvRow>,
    pub bad_lines: Vec<u32>,
    pub clashes: Vec<EnvClashes>,
}

/// What to do with one row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvAction {
    /// Make a key under the row's name: only for a row that does not clash.
    Save,
    /// Put the row's value into the key of that name in the place, or make the key when there is none.
    Replace,
    /// Make a key under the name Keep both gave the row: only for a row that clashes.
    KeepBoth,
    /// Write nothing for the row.
    LeaveOut,
}

/// The choice for the row at `index`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvChoice {
    pub index: u32,
    pub action: EnvAction,
}

/// What taking a folder's keys out came to.
#[derive(Serialize)]
pub enum EnvOut {
    /// Copied to the clipboard.
    Done,
    /// The save dialog's outcome, as `save_recovery_pdf` answers it.
    Saved(Outcome<SavedView>),
    /// Two keys in the folder share a name: nothing was copied or written. The name is the person's own.
    Duplicate { name: String },
}

/// The live key items of a vault by place (a live folder's id, or `None`), each name with the ids of the keys that have
/// it, and the ids of the live folders. Keys and folders in the trash are left out.
struct Places {
    keys: HashMap<Option<ItemId>, HashMap<String, Vec<ItemId>>>,
    /// The live folders, in id order.
    folders: Vec<ItemId>,
    /// What a place with no key has.
    none: HashMap<String, Vec<ItemId>>,
}

impl Places {
    fn of<'a>(items: impl Iterator<Item = &'a Item>) -> Places {
        let mut places = Places {
            keys: HashMap::new(),
            folders: Vec::new(),
            none: HashMap::new(),
        };
        for item in items.filter(|item| item.trashed_at.is_none()) {
            match &item.kind {
                ItemKind::Collection => places.folders.push(item.id),
                ItemKind::Key { .. } => places
                    .keys
                    .entry(item.collection)
                    .or_default()
                    .entry(item.title.clone())
                    .or_default()
                    .push(item.id),
                _ => {}
            }
        }
        places.folders.sort_unstable();
        places
    }

    /// The live keys in `place` by name.
    fn live(&self, place: Option<ItemId>) -> &HashMap<String, Vec<ItemId>> {
        self.keys.get(&place).unwrap_or(&self.none)
    }
}

/// A row's place among the keys read: at most [`MAX_KEYS`] rows, so it always fits.
fn row_number(row: usize) -> u32 {
    u32::try_from(row).unwrap_or(u32::MAX)
}

/// The items of either kind of vault.
fn all_items<'a>(vault: &'a VaultRef<'_>) -> Box<dyn Iterator<Item = &'a Item> + 'a> {
    match vault {
        VaultRef::Writable(vault) => Box::new(vault.items()),
        VaultRef::ReadOnly(vault) => Box::new(vault.items()),
    }
}

/// For each row, `Some(saved_as)` when it clashes in a place whose live keys are `live`, `None` when it does not.
///
/// A row clashes when a live key of exactly its name is in the place, or an earlier row (a lower index) of the paste has
/// the same name. `saved_as` is the first of `NAME_2`, `NAME_3`, ... that is not the name of a live key there, not the
/// name of any row of the paste (`paste`: every row, later ones too) and not the name already given to an earlier row
/// here. It depends only on the place's keys and the paste, never on the choices, so what a row shows is what the save does.
fn clashes_in(
    live: &HashMap<String, Vec<ItemId>>,
    names: &[&str],
    paste: &HashSet<&str>,
) -> Vec<Option<String>> {
    let mut earlier: HashSet<&str> = HashSet::new();
    let mut given: HashSet<String> = HashSet::new();
    names
        .iter()
        .map(|&name| {
            let repeats = !earlier.insert(name);
            if !repeats && !live.contains_key(name) {
                return None;
            }
            let free = |candidate: &str| {
                !live.contains_key(candidate)
                    && !paste.contains(candidate)
                    && !given.contains(candidate)
            };
            let saved_as = (2u32..)
                .map(|number| format!("{name}_{number}"))
                .find(|candidate| free(candidate))?;
            given.insert(saved_as.clone());
            Some(saved_as)
        })
        .collect()
}

/// The folder's keys as the engine's writer makes them, wiped when dropped. Tests count how many are alive on the
/// thread ([`alive_export_texts`]), to see that none waits while a dialog is open.
struct ExportText(Zeroizing<String>);

impl ExportText {
    fn new(text: Zeroizing<String>) -> ExportText {
        #[cfg(test)]
        ALIVE.with(|alive| alive.set(alive.get() + 1));
        ExportText(text)
    }

    fn as_bytes(&self) -> &[u8] {
        self.0.as_bytes()
    }

    /// The text itself, for the clipboard to take.
    fn into_text(mut self) -> Zeroizing<String> {
        std::mem::take(&mut self.0)
    }
}

#[cfg(test)]
impl Drop for ExportText {
    fn drop(&mut self) {
        ALIVE.with(|alive| alive.set(alive.get() - 1));
    }
}

#[cfg(test)]
thread_local! {
    /// Tests only: how many [`ExportText`]s this thread has made and not yet dropped.
    static ALIVE: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Tests only: the export texts alive on this thread.
#[cfg(test)]
fn alive_export_texts() -> usize {
    ALIVE.with(std::cell::Cell::get)
}

/// The folder's keys as the engine's writer makes them, or the first name two keys share.
enum FolderKeys {
    Text(ExportText),
    Twice(String),
}

/// The live keys filed in the live folder `folder`, sorted by name (byte order), as borrows of the vault: no value is
/// copied. `NotFound` for a folder that is not a live folder of this vault; `no keys` for one with none.
fn sorted_keys<'a>(
    vault: &'a VaultRef<'_>,
    folder: ItemId,
) -> ShellResult<Vec<(&'a str, &'a str)>> {
    let is_live_folder = |item: &&Item| {
        item.id == folder && matches!(item.kind, ItemKind::Collection) && item.trashed_at.is_none()
    };
    if all_items(vault).find(is_live_folder).is_none() {
        return Err(ShellError::NotFound);
    }
    let mut keys: Vec<(&str, &str)> = all_items(vault)
        .filter(|item| item.trashed_at.is_none() && item.collection == Some(folder))
        .filter_map(|item| match &item.kind {
            ItemKind::Key { value } => Some((item.title.as_str(), value.as_str())),
            _ => None,
        })
        .collect();
    if keys.is_empty() {
        return Err(NO_KEYS);
    }
    // Byte order, as `str` compares.
    keys.sort_unstable_by(|a, b| a.0.cmp(b.0));
    Ok(keys)
}

/// The first name two of `keys` (sorted by name) share.
fn first_twice(keys: &[(&str, &str)]) -> Option<String> {
    let pair = keys.windows(2).find(|pair| pair[0].0 == pair[1].0)?;
    Some(pair[0].0.to_owned())
}

/// The folder's keys in `.env` form, or the first name two keys share. Makes the text, so only a caller about to use it
/// right away asks for it.
fn folder_keys(vault: &VaultRef<'_>, folder: ItemId) -> ShellResult<FolderKeys> {
    let keys = sorted_keys(vault, folder)?;
    if let Some(name) = first_twice(&keys) {
        return Ok(FolderKeys::Twice(name));
    }
    Ok(FolderKeys::Text(ExportText::new(env_file::write(&keys))))
}

/// The check before a save dialog opens: the first name two keys share, if any. It makes no text, and what it returns is a
/// name and nothing of a value, so nothing of the keys waits while the dialog is open.
fn folder_check(vault: &VaultRef<'_>, folder: ItemId) -> ShellResult<Option<String>> {
    Ok(first_twice(&sorted_keys(vault, folder)?))
}

#[cfg(test)]
type Hooks = std::cell::RefCell<Vec<(&'static str, Box<dyn FnOnce()>)>>;

#[cfg(test)]
thread_local! {
    /// Tests only: a step to run once when the command on this thread reaches the named point.
    static AT: Hooks = const { std::cell::RefCell::new(Vec::new()) };
}

/// Tests only: runs `hook` once, the next time this thread reaches `step`.
#[cfg(test)]
fn at(step: &'static str, hook: impl FnOnce() + 'static) {
    AT.with(|hooks| hooks.borrow_mut().push((step, Box::new(hook))));
}

/// Tests only: the point `step` is reached.
#[cfg(test)]
fn reached(step: &str) {
    let hook = AT.with(|hooks| {
        let mut hooks = hooks.borrow_mut();
        let found = hooks.iter().position(|(name, _)| *name == step);
        found.map(|at| hooks.remove(at).1)
    });
    if let Some(hook) = hook {
        hook();
    }
}

/// A lock of one vault (or of all) drops the pasted keys parked for it, as Lock all does itself: a lock of one vault
/// drains nothing of its own, and a paste parked while a lock was under way is dropped by its hook.
pub(crate) fn lock_hook(sessions: Weak<Sessions>) -> LockHook {
    Box::new(move |only, _| {
        if let Some(sessions) = sessions.upgrade() {
            sessions.pending().drop_env_pastes(only);
        }
    })
}

/// What each row of a paste of `rows` rows is to do, by row: every row named exactly once, and no other.
fn actions_for(choices: &[EnvChoice], rows: usize) -> ShellResult<Vec<EnvAction>> {
    if choices.len() != rows {
        return Err(BAD_ROWS);
    }
    let mut slots: Vec<Option<EnvAction>> = vec![None; rows];
    for choice in choices {
        let slot = usize::try_from(choice.index)
            .ok()
            .and_then(|row| slots.get_mut(row))
            .ok_or(BAD_ROWS)?;
        if slot.replace(choice.action).is_some() {
            return Err(BAD_ROWS);
        }
    }
    slots.into_iter().map(|slot| slot.ok_or(BAD_ROWS)).collect()
}

/// A new key `name` in `place`, with no notes.
fn make_key(
    vault: &mut Vault,
    name: &str,
    place: Option<ItemId>,
    value: Zeroizing<String>,
) -> ShellResult<ItemId> {
    let kind = ItemKind::Key { value };
    Ok(vault.new_item_with_notes(kind, name, place, Zeroizing::default())?)
}

/// The whole save, in one write: every choice is checked against the place as it is now before anything is written, then
/// the rows are written in index order. How many keys were written (a row left out is not one).
fn save_rows(
    vault: &mut Vault,
    cancel: &CancelToken,
    place: Option<ItemId>,
    entries: Vec<EnvEntry>,
    choices: &[EnvChoice],
) -> ShellResult<u32> {
    if let Some(folder) = place {
        let live = vault.get_item(&folder).is_ok_and(|item| {
            matches!(item.kind, ItemKind::Collection) && item.trashed_at.is_none()
        });
        if !live {
            return Err(BAD_ROWS);
        }
    }
    let (actions, clashing, mut target) = {
        let places = Places::of(vault.items());
        let live = places.live(place);
        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
        let paste: HashSet<&str> = names.iter().copied().collect();
        let clashing = clashes_in(live, &names, &paste);
        let actions = actions_for(choices, entries.len())?;
        for ((action, clash), name) in actions.iter().zip(&clashing).zip(&names) {
            match (action, clash) {
                (EnvAction::Save, Some(_)) | (EnvAction::KeepBoth, None) => return Err(BAD_ROWS),
                (EnvAction::KeepBoth, Some(saved_as)) => at_most(saved_as, MAX_TITLE, "title")?,
                (EnvAction::Replace, _) if live.get(*name).is_some_and(|ids| ids.len() > 1) => {
                    return Err(TWICE);
                }
                _ => {}
            }
        }
        // The key each name stands for from here on: the one key of that name that is there, and then each one this save
        // makes. A name two keys already have is never looked up (a Replace on it was refused above).
        let target: HashMap<String, ItemId> = live
            .iter()
            .filter(|(_, ids)| ids.len() == 1)
            .map(|(name, ids)| (name.clone(), ids[0]))
            .collect();
        (actions, clashing, target)
    };
    let mut written = 0u32;
    for ((entry, action), saved_as) in entries.into_iter().zip(actions).zip(clashing) {
        if action == EnvAction::LeaveOut {
            continue;
        }
        // A lock stops the rest: nothing more is written to a vault that has locked.
        if cancel.is_cancelled() {
            return Err(ShellError::Locked);
        }
        let EnvEntry { name, value } = entry;
        match action {
            EnvAction::Save => {
                let id = make_key(vault, &name, place, value)?;
                target.insert(name, id);
            }
            EnvAction::KeepBoth => {
                let saved_as = saved_as.ok_or(BAD_ROWS)?;
                make_key(vault, &saved_as, place, value)?;
            }
            EnvAction::Replace => match target.get(&name).copied() {
                Some(id) => {
                    let mut next = vault.get_item(&id)?.clone();
                    next.kind = ItemKind::Key { value };
                    vault.update_item(next)?;
                }
                None => {
                    let id = make_key(vault, &name, place, value)?;
                    target.insert(name, id);
                }
            },
            EnvAction::LeaveOut => {}
        }
        written += 1;
        #[cfg(test)]
        reached("after_write");
    }
    Ok(written)
}

/// Makes `bytes` the new file `path`, which must not exist.
fn write_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)
}

impl Shell {
    /// Reads a pasted `.env` in Rust. Refused first for a session that is locked, stale, not ours or read-only; then
    /// for text over 1,048,576 bytes, before it is read. The keys read wait in `Pending` for [`env_save`](Self::env_save),
    /// parked inside the session's publish guard, so a lock can never slip between the check and the park.
    pub fn env_read(
        &self,
        session: SessionId,
        generation: u64,
        text: Zeroizing<String>,
    ) -> ShellResult<Tagged<EnvRows>> {
        self.live_writable(session, generation)?;
        if text.len() > MAX_TEXT {
            return Err(TEXT_TOO_LARGE);
        }
        let env_file::EnvParse { entries, bad_lines } = env_file::parse(&text);
        // The pasted text goes as soon as it is read: what waits from here on is each value, in a buffer of its own.
        drop(text);
        if entries.len() > MAX_KEYS {
            return Err(TOO_MANY_KEYS);
        }
        for entry in &entries {
            at_most(&entry.value, MAX_KEY_VALUE, "value")?;
            at_most(&entry.name, MAX_TITLE, "title")?;
        }
        let rows: Vec<EnvRow> = entries
            .iter()
            .enumerate()
            .map(|(row, entry)| EnvRow {
                index: row_number(row),
                name: entry.name.clone(),
            })
            .collect();
        let clashes = {
            let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
            let paste: HashSet<&str> = names.iter().copied().collect();
            self.sessions
                .read(session, generation, |vault, _| {
                    let places = Places::of(all_items(&vault));
                    let each =
                        std::iter::once(None).chain(places.folders.iter().copied().map(Some));
                    Ok(each
                        .map(|place| {
                            let clashing = clashes_in(places.live(place), &names, &paste);
                            EnvClashes {
                                collection: place.map(|id| id.to_hex()),
                                rows: clashing
                                    .into_iter()
                                    .enumerate()
                                    .filter_map(|(row, saved_as)| {
                                        Some(EnvClash {
                                            index: row_number(row),
                                            saved_as: saved_as?,
                                        })
                                    })
                                    .collect(),
                            }
                        })
                        .collect::<Vec<_>>())
                })?
                .data
        };
        #[cfg(test)]
        reached("before_park");
        // Parked inside the session's publish guard: a lock that has begun refuses the park, and one that begins after the
        // check waits for it and then drops the park through its hook, so no lock can slip in between.
        let parked = match entries.is_empty() {
            true => None,
            false => Some(self.sessions.publish(session, generation, || {
                #[cfg(test)]
                reached("in_park");
                let waiting = PendingChoice::EnvPaste {
                    session,
                    generation,
                    entries,
                };
                Ok(self.sessions.pending().park(waiting))
            })?),
        };
        let (token, expired) = match parked {
            Some((token, expired)) => (Some(token), expired),
            None => (None, Vec::new()),
        };
        // What had run out of time goes here, with no lock held.
        drop(expired);
        self.still_current(
            session,
            generation,
            EnvRows {
                token,
                rows,
                bad_lines,
                clashes,
            },
        )
    }

    /// Saves the rows waiting under `token` as keys in `collection`, as `choices` say.
    pub fn env_save(
        &self,
        session: SessionId,
        generation: u64,
        token: &Token,
        choices: Vec<EnvChoice>,
        collection: Option<String>,
    ) -> ShellResult<Tagged<u32>> {
        let live = self.live_writable(session, generation);
        // The token is used up whatever the answer, a refusal for the session included.
        let taken = self.sessions.pending().take(token);
        live?;
        let PendingChoice::EnvPaste {
            session: owner,
            generation: made_in,
            entries,
        } = taken?
        else {
            return Err(ShellError::NotFound);
        };
        if (owner, made_in) != (session, generation) {
            return Err(ShellError::NotFound);
        }
        let place = collection_id(collection.as_deref())?;
        // One write for the whole save, like the folder's delete and restore, which are a few writes under one short
        // `write`: it waits up to half a second for another command using the vault (a long write would be `Busy` at
        // once, and the pasted values are already used up). Not `write_change`: its `LockedAfterChange` carries a label
        // of its own, and a lock that overtakes the save is answered `Locked`, which the page shows as nothing.
        self.sessions.write(session, generation, |vault, cancel| {
            save_rows(vault, cancel, place, entries, &choices)
        })
    }

    /// Copies the folder's keys, in `.env` form, to the clipboard.
    pub fn env_copy(
        &self,
        session: SessionId,
        generation: u64,
        collection: &str,
    ) -> ShellResult<Tagged<EnvOut>> {
        let folder = item_id(collection)?;
        let found = self
            .sessions
            .read(session, generation, |vault, _| folder_keys(&vault, folder))?;
        match found.data {
            FolderKeys::Twice(name) => {
                self.still_current(session, generation, EnvOut::Duplicate { name })
            }
            FolderKeys::Text(text) => {
                // The text goes to the clipboard in Rust and nowhere else. A read-only session may copy: nothing is
                // written to the vault.
                self.clipboard
                    .copy(&self.sessions, session, generation, text.into_text())?;
                self.still_current(session, generation, EnvOut::Done)
            }
        }
    }

    /// Saves the folder's keys as a `.env` file where the person picks. The same read comes first, so no dialog opens for
    /// a folder that is not there, one with no key, or one with two keys of a name. The job holds the folder's id only:
    /// the keys are read again when the file is written.
    pub fn env_save_file(
        &self,
        session: SessionId,
        generation: u64,
        collection: &str,
    ) -> ShellResult<Tagged<EnvOut>> {
        let folder = item_id(collection)?;
        self.live_writable(session, generation)?;
        // Only the answer is kept (a name or nothing): no export text is made before the dialog.
        let twice = self
            .sessions
            .read(session, generation, |vault, _| folder_check(&vault, folder))?;
        if let Some(name) = twice.data {
            return self.still_current(session, generation, EnvOut::Duplicate { name });
        }
        let saved = self.save_readable(session, generation, ReadableJob::env_file(folder))?;
        Ok(Tagged {
            session: saved.session,
            generation: saved.generation,
            data: EnvOut::Saved(saved.data),
        })
    }

    /// The `.env` file's part of [`save_readable`](Self::save_readable): reads the folder's keys now.
    pub(super) fn write_env_file(
        &self,
        session: SessionId,
        generation: u64,
        cancel: &CancelToken,
        dest: &Path,
        folder: ItemId,
    ) -> ShellResult<Tagged<Outcome<SavedView>>> {
        // The keys as the folder holds them now, after the dialog and after any cloud yes. A name twice now is refused: the
        // file would not say which key is which.
        let text = match self
            .sessions
            .read(session, generation, |vault, _| folder_keys(&vault, folder))?
            .data
        {
            FolderKeys::Text(text) => text,
            FolderKeys::Twice(_) => return Err(TWICE),
        };
        let docs = dest
            .parent()
            .ok_or(ShellError::InvalidInput { what: "file name" })?;
        // Written like the PDF: a temp beside the destination, journaled before it exists, then moved into place only while
        // the session is still unlocked in the generation that asked. An existing file is untouched until then.
        let journal = self.outputs.for_call(&self.sessions, session, generation);
        let temp = hidden_temp_path(docs, ".lockbox-partial");
        journal.finish(journal.record(&temp))?;
        let written = write_new(&temp, text.as_bytes());
        drop(text);
        if let Err(error) = written {
            self.discard_env_temp(&temp);
            return Err(error.into());
        }
        #[cfg(test)]
        reached("file_written");
        if cancel.is_cancelled() {
            self.discard_env_temp(&temp);
            return Err(ShellError::Locked);
        }
        let published = journal.finish(publish_readable(&temp, dest, |attempt| {
            journal.publish(attempt)
        }));
        if let Err(error) = published {
            // The move is the last thing that can fail before it happens; if the temp is gone, it happened.
            match fs::symlink_metadata(&temp).is_err() {
                true => journal.clear(&temp),
                false => self.discard_env_temp(&temp),
            }
            return Err(error);
        }
        journal.clear(&temp);
        let saved = SavedView {
            folder: shown(docs),
        };
        self.still_current(session, generation, Outcome::Done(saved))
    }

    /// Removes the `.env` file's temp by the launch sweep's own rules (no link on the way, Lockbox's own name); what cannot
    /// be removed now stays in the journal for the next launch.
    fn discard_env_temp(&self, temp: &Path) {
        self.outputs.remove_leftover(temp, LAUNCH_OPEN_TRIES);
    }
}

/// `env_read`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadArgs {
    session: SessionId,
    generation: u64,
    text: Zeroizing<String>,
}

/// `env_save`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveArgs {
    session: SessionId,
    generation: u64,
    token: Token,
    choices: Vec<EnvChoice>,
    collection: Option<String>,
}

/// `env_copy` and `env_save_file`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FolderArgs {
    session: SessionId,
    generation: u64,
    collection: String,
}

/// Reads a pasted `.env`: the text goes once, and the answer holds names and numbers only.
#[tauri::command]
pub(super) async fn env_read(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<EnvRows>> {
    let ReadArgs {
        session,
        generation,
        text,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.env_read(session, generation, text)).await
}

/// Saves the rows a paste made as keys, as the person chose.
#[tauri::command]
pub(super) async fn env_save(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<u32>> {
    let SaveArgs {
        session,
        generation,
        token,
        choices,
        collection,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.env_save(session, generation, &token, choices, collection)).await
}

/// Copies a folder's keys in `.env` form, in Rust.
#[tauri::command]
pub(super) async fn env_copy(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<EnvOut>> {
    let FolderArgs {
        session,
        generation,
        collection,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.env_copy(session, generation, &collection)).await
}

/// Saves a folder's keys as a `.env` file where the person picks.
#[tauri::command]
pub(super) async fn env_save_file(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<EnvOut>> {
    let FolderArgs {
        session,
        generation,
        collection,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.env_save_file(session, generation, &collection)).await
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::path::PathBuf;
    use std::rc::Rc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, Instant};

    use lockbox_core::internals::fsio::testutil::names;
    use lockbox_core::{CoreError, Credential, ReadOnlyVault};
    use serde_json::{Value, json};
    use tauri::ipc::InvokeBody;

    use super::super::items::{ItemFields, NewKind};
    use super::super::{MALFORMED, parse};
    use super::*;
    use crate::error::Confirm;
    use crate::session::{Location, LockReason, OpenStep, Opened, SessionState};
    use crate::testing::{TEST_PASSWORD, TestShell, heavy};

    /// A made-up value that must never show up in an answer, an error or a `Debug`.
    const SECRET: &str = "S3NT1NEL-value";
    const LOCKED: Option<ShellError> = Some(ShellError::Locked);
    const NOT_FOUND: Option<ShellError> = Some(ShellError::NotFound);
    /// What is at the destination before a save.
    const OLD: &[u8] = b"OLD=file\n";

    use EnvAction::{KeepBoth, LeaveOut, Replace, Save};

    fn folder(ts: &TestShell, s: SessionId, g: u64, name: &str) -> String {
        let made = ts
            .shell
            .new_item(s, g, NewKind::Collection, name.to_owned(), None, None);
        made.unwrap().data
    }

    fn key(
        ts: &TestShell,
        s: SessionId,
        g: u64,
        name: &str,
        value: &str,
        collection: Option<&str>,
    ) -> String {
        let fields = ItemFields {
            value: Zeroizing::new(value.to_owned()),
            ..ItemFields::default()
        };
        let made = ts.shell.new_item(
            s,
            g,
            NewKind::Key,
            name.to_owned(),
            collection.map(str::to_owned),
            Some(fields),
        );
        made.unwrap().data
    }

    fn read(ts: &TestShell, s: SessionId, g: u64, text: &str) -> EnvRows {
        let answer = ts.shell.env_read(s, g, Zeroizing::new(text.to_owned()));
        answer.unwrap().data
    }

    fn choices(actions: &[EnvAction]) -> Vec<EnvChoice> {
        let at = |i: usize| u32::try_from(i).unwrap();
        let each = actions.iter().enumerate();
        each.map(|(i, &action)| EnvChoice {
            index: at(i),
            action,
        })
        .collect()
    }

    fn save(
        ts: &TestShell,
        (s, g): (SessionId, u64),
        rows: &EnvRows,
        actions: &[EnvAction],
        collection: Option<&str>,
    ) -> ShellResult<Tagged<u32>> {
        let token = rows.token.as_ref().expect("a token");
        let place = collection.map(str::to_owned);
        ts.shell.env_save(s, g, token, choices(actions), place)
    }

    /// Every live key in a place with its value, sorted by name then value.
    fn keys_in(ts: &TestShell, s: SessionId, g: u64, place: Option<&str>) -> Vec<(String, String)> {
        let place = place.map(|id| ItemId::from_hex(id).unwrap());
        let read = ts.shell.sessions.read(s, g, |vault, _| {
            let mut found = Vec::new();
            for item in all_items(&vault) {
                if let ItemKind::Key { value } = &item.kind
                    && item.trashed_at.is_none()
                    && item.collection == place
                {
                    found.push((item.title.clone(), value.to_string()));
                }
            }
            Ok(found)
        });
        let mut found = read.unwrap().data;
        found.sort();
        found
    }

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        let own = |(name, value): &(&str, &str)| ((*name).to_owned(), (*value).to_owned());
        list.iter().map(own).collect()
    }

    /// The names and values `.env` text reads back to, sorted.
    fn parsed(text: &str) -> Vec<(String, String)> {
        let read = env_file::parse(text);
        assert!(read.bad_lines.is_empty());
        let mut found: Vec<_> = read
            .entries
            .iter()
            .map(|e| (e.name.clone(), e.value.to_string()))
            .collect();
        found.sort();
        found
    }

    fn clashing<'a>(rows: &'a EnvRows, place: Option<&str>) -> Option<&'a EnvClashes> {
        rows.clashes
            .iter()
            .find(|c| c.collection.as_deref() == place)
    }

    /// The clashes in a place as `(row, saved_as)`; empty when the place is not listed.
    fn saved_as(rows: &EnvRows, place: Option<&str>) -> Vec<(u32, String)> {
        let found = clashing(rows, place).map(|c| &c.rows);
        let each = found.into_iter().flatten();
        each.map(|c| (c.index, c.saved_as.clone())).collect()
    }

    fn parked(ts: &TestShell) -> usize {
        ts.shell.sessions.pending().len()
    }

    /// Nothing of a made-up value or name is in the refusal's text, `Debug` or JSON.
    fn assert_clean(error: &ShellError, name: &str) {
        let shown = format!("{error:?} {}", serde_json::to_string(error).unwrap());
        assert!(!shown.contains(SECRET), "a value is in {shown}");
        assert!(!shown.contains(name), "a name is in {shown}");
    }

    /// A read-only session over the vault listed first: a backup or a pre-restore copy opens like this. It locks every
    /// vault first, so a session opened earlier is locked after it.
    fn read_only_session(ts: &TestShell) -> (SessionId, u64) {
        let dir = ts.shell.registry.entries()[0].1.clone();
        ts.shell.sessions.lock_all(LockReason::Manual);
        let vault = heavy(|| {
            ReadOnlyVault::open_folder(
                &dir,
                Credential::Password(TEST_PASSWORD),
                &CancelToken::new(),
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

    /// A token in the right form that nothing waits under.
    fn made_up_token() -> Token {
        let text = ["0123456789abcdef"; 2].concat();
        serde_json::from_value(Value::String(text)).unwrap()
    }

    // ---- reading a paste

    /// The answer holds names, numbers and a token, and no value anywhere in its JSON; nothing is saved yet; and a paste
    /// with no key in it parks nothing and answers no token.
    #[test]
    fn paste_returns_names_only() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let text = format!(
            "API_KEY={SECRET}-1\nexport DB_PASS='{SECRET}-2'\nthis line is bad\nTOKEN=\"{SECRET}-3\"\n"
        );
        let answer = ts.shell.env_read(s, g, Zeroizing::new(text)).unwrap();
        let json = serde_json::to_value(&answer).unwrap();
        assert!(!json.to_string().contains(SECRET), "a value crossed");
        assert_eq!(
            (json["session"].as_u64(), json["generation"].as_u64()),
            (Some(s.0), Some(g))
        );
        let data = json["data"].as_object().unwrap();
        let mut fields: Vec<&str> = data.keys().map(String::as_str).collect();
        fields.sort_unstable();
        assert_eq!(fields, ["bad_lines", "clashes", "rows", "token"]);
        assert_eq!(
            json["data"]["rows"],
            json!([
                { "index": 0, "name": "API_KEY" },
                { "index": 1, "name": "DB_PASS" },
                { "index": 2, "name": "TOKEN" },
            ])
        );
        assert_eq!(json["data"]["bad_lines"], json!([3]));
        let token = json["data"]["token"].as_str().unwrap();
        assert_eq!(token.len(), 32);
        assert!(keys_in(&ts, s, g, None).is_empty(), "nothing is saved yet");
        assert_eq!(parked(&ts), 1);

        let none = ts.shell.env_read(
            s,
            g,
            Zeroizing::new("# just a comment\nnot a line\n".to_owned()),
        );
        let none = serde_json::to_value(none.unwrap()).unwrap();
        assert_eq!(none["data"]["token"], Value::Null);
        assert_eq!(none["data"]["rows"], json!([]));
        assert_eq!(none["data"]["bad_lines"], json!([2]));
        assert_eq!(parked(&ts), 1, "no key read: nothing parked");
    }

    /// Clashes list every live folder and no folder, each with its clashing rows in index order, and leave out a folder
    /// in the trash and a key in the trash (alone or with its folder).
    #[test]
    fn clashes_list_every_live_folder_and_no_folder() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let (one, two, gone) = (
            folder(&ts, s, g, "One"),
            folder(&ts, s, g, "Two"),
            folder(&ts, s, g, "Gone"),
        );
        key(&ts, s, g, "SHARED", "a", Some(&one));
        let trashed_alone = key(&ts, s, g, "SHARED", "b", Some(&two));
        ts.shell.trash_item(s, g, &trashed_alone).unwrap();
        key(&ts, s, g, "SHARED", "c", Some(&gone));
        ts.shell.delete_collection(s, g, &gone).unwrap();
        key(&ts, s, g, "OTHER", "d", None);

        let rows = read(&ts, s, g, "SHARED=1\nSHARED=2\nFRESH=3\n");
        let mut listed: Vec<Option<&str>> = rows
            .clashes
            .iter()
            .map(|c| c.collection.as_deref())
            .collect();
        listed.sort_unstable();
        let mut expected = vec![None, Some(one.as_str()), Some(two.as_str())];
        expected.sort_unstable();
        assert_eq!(
            listed, expected,
            "every live folder and none, nothing in the trash"
        );

        let rows_of = |place| -> Vec<u32> {
            clashing(&rows, place)
                .unwrap()
                .rows
                .iter()
                .map(|c| c.index)
                .collect()
        };
        assert_eq!(
            rows_of(Some(&one)),
            [0, 1],
            "the key there, and the earlier row"
        );
        assert_eq!(rows_of(Some(&two)), [1], "the trashed key does not count");
        assert_eq!(rows_of(None), [1], "only the earlier row");
        assert_eq!(
            saved_as(&rows, Some(&one)),
            [(0, "SHARED_2".to_owned()), (1, "SHARED_3".to_owned())]
        );
        assert_eq!(saved_as(&rows, None), [(1, "SHARED_2".to_owned())]);
    }

    // ---- what a lock does to a paste

    /// A lock of one vault drops that vault's paste and no other's; the token is gone.
    #[test]
    fn values_wiped_on_one_vault_lock() {
        let ts = TestShell::new();
        let (a, ga) = ts.open_vault("Family");
        let (b, gb) = ts.open_vault("Work");
        let mine = read(&ts, a, ga, "FIRST=1\n");
        let theirs = read(&ts, b, gb, "SECOND=2\n");
        assert_eq!(parked(&ts), 2);

        ts.shell.sessions.lock(a, LockReason::Manual);
        assert_eq!(parked(&ts), 1, "only the locked vault's paste went");
        assert_eq!(
            ts.shell
                .sessions
                .pending()
                .take(mine.token.as_ref().unwrap())
                .err(),
            NOT_FOUND
        );
        let saved = save(&ts, (b, gb), &theirs, &[Save], None);
        assert_eq!(
            saved.unwrap().data,
            1,
            "the other vault's paste still saves"
        );
    }

    /// Lock all drops every paste.
    #[test]
    fn values_wiped_on_lock_all() {
        let ts = TestShell::new();
        let (a, ga) = ts.open_vault("Family");
        let (b, gb) = ts.open_vault("Work");
        read(&ts, a, ga, "FIRST=1\n");
        read(&ts, b, gb, "SECOND=2\n");
        assert_eq!(parked(&ts), 2);
        ts.shell.lock_all();
        assert_eq!(parked(&ts), 0);
    }

    /// A lock at either gap keeps nothing. After the check and before the park: the park is refused (`Locked`). Under way
    /// while the park happens (the lock has bumped the generation and waits for the park's guard): the park goes
    /// through, and the lock's hook drops it.
    #[test]
    fn lock_between_read_and_park_keeps_nothing() {
        let ts = TestShell::new();
        let (a, ga) = ts.open_vault("Family");
        let (b, gb) = ts.open_vault("Work");

        let shell = Arc::clone(&ts.shell);
        at("before_park", move || {
            shell.sessions.lock(a, LockReason::Manual)
        });
        let answer = ts
            .shell
            .env_read(a, ga, Zeroizing::new("KEY=1\n".to_owned()));
        assert_eq!(answer.err(), LOCKED);
        assert_eq!(parked(&ts), 0, "refused: nothing parked");

        let locker: Rc<RefCell<Option<JoinHandle<()>>>> = Rc::default();
        let (shell, slot) = (Arc::clone(&ts.shell), Rc::clone(&locker));
        at("in_park", move || {
            let locking = Arc::clone(&shell);
            *slot.borrow_mut() = Some(thread::spawn(move || {
                locking.sessions.lock(b, LockReason::Manual);
            }));
            let until = Instant::now() + Duration::from_secs(30);
            let unlocked = |shell: &Shell| {
                let list = shell.sessions.list();
                list.iter()
                    .any(|i| i.session == b && i.state == SessionState::Unlocked)
            };
            while unlocked(&shell) {
                assert!(Instant::now() < until, "the lock never started");
                thread::sleep(Duration::from_millis(2));
            }
        });
        let answer = ts
            .shell
            .env_read(b, gb, Zeroizing::new("KEY=1\n".to_owned()));
        assert_eq!(answer.err(), LOCKED);
        let locking = locker.borrow_mut().take().expect("the lock started");
        locking.join().unwrap();
        assert_eq!(parked(&ts), 0, "the lock's hook dropped the paste");
    }

    /// The token belongs to the session and generation that read the paste, is used up by its first save, and is gone
    /// after five minutes.
    #[test]
    fn tokens_of_another_session_used_up_and_expired_are_not_found() {
        let ts = TestShell::new();
        let (a, ga) = ts.open_vault("Family");
        let (b, gb) = ts.open_vault("Work");

        let rows = read(&ts, a, ga, "KEY=1\n");
        assert_eq!(save(&ts, (b, gb), &rows, &[Save], None).err(), NOT_FOUND);
        assert_eq!(parked(&ts), 0, "the token is used up by that try");
        assert_eq!(save(&ts, (a, ga), &rows, &[Save], None).err(), NOT_FOUND);

        let rows = read(&ts, a, ga, "KEY=1\n");
        assert_eq!(save(&ts, (a, ga), &rows, &[Save], None).unwrap().data, 1);
        assert_eq!(
            save(&ts, (a, ga), &rows, &[Save], None).err(),
            NOT_FOUND,
            "used up"
        );
        assert_eq!(keys_in(&ts, a, ga, None), pairs(&[("KEY", "1")]));

        let rows = read(&ts, a, ga, "OTHER=2\n");
        ts.shell
            .sessions
            .pending()
            .sweep_at(Instant::now() + Duration::from_secs(5 * 60 + 1));
        assert_eq!(
            save(&ts, (a, ga), &rows, &[Save], None).err(),
            NOT_FOUND,
            "expired"
        );
        assert_eq!(keys_in(&ts, a, ga, None), pairs(&[("KEY", "1")]));

        // A token of another kind of question is not a paste.
        let dir = ts.folder("x");
        let other = ts
            .shell
            .sessions
            .pending()
            .put(PendingChoice::AddVault { dir });
        let wrong = ts.shell.env_save(a, ga, &other, choices(&[Save]), None);
        assert_eq!(wrong.err(), NOT_FOUND);
    }

    // ---- saving

    /// Keep both saves the row as `NAME_2`, shown in its row before the save; the key that was there stays as it was.
    #[test]
    fn keep_both_saves_name_2() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let prod = folder(&ts, s, g, "Prod");
        key(&ts, s, g, "API_KEY", "old", Some(&prod));
        let rows = read(&ts, s, g, "API_KEY=new\nFRESH=f\n");
        assert_eq!(saved_as(&rows, Some(&prod)), [(0, "API_KEY_2".to_owned())]);
        assert!(
            saved_as(&rows, None).is_empty(),
            "no clash outside the folder"
        );

        let written = save(&ts, (s, g), &rows, &[KeepBoth, Save], Some(&prod)).unwrap();
        assert_eq!(written.data, 2);
        assert_eq!(
            keys_in(&ts, s, g, Some(&prod)),
            pairs(&[("API_KEY", "old"), ("API_KEY_2", "new"), ("FRESH", "f")])
        );
    }

    /// Keep both skips a number that a key there has, a name another row of the paste has, and one it gave an earlier row.
    #[test]
    fn keep_both_skips_a_taken_number() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let prod = folder(&ts, s, g, "Prod");
        key(&ts, s, g, "API_KEY", "old", Some(&prod));
        key(&ts, s, g, "API_KEY_2", "old2", Some(&prod));
        let rows = read(&ts, s, g, "API_KEY=a\nAPI_KEY_3=b\nAPI_KEY_2=c\n");
        // Row 0's name is taken, and so are _2 (a key) and _3 (a row of the paste): the first free is _4. Row 2 clashes
        // with the key of its own name there, and gets the next free one after the paste's own names: _2_2.
        assert_eq!(
            saved_as(&rows, Some(&prod)),
            [(0, "API_KEY_4".to_owned()), (2, "API_KEY_2_2".to_owned())]
        );
        let written = save(&ts, (s, g), &rows, &[KeepBoth, Save, KeepBoth], Some(&prod)).unwrap();
        assert_eq!(written.data, 3);
        assert_eq!(
            keys_in(&ts, s, g, Some(&prod)),
            pairs(&[
                ("API_KEY", "old"),
                ("API_KEY_2", "old2"),
                ("API_KEY_2_2", "c"),
                ("API_KEY_3", "b"),
                ("API_KEY_4", "a"),
            ])
        );
    }

    /// A paste may hold one name twice: each row stays a row, the later ones clash with the earlier, each gets its own
    /// Keep both name, and Replace on the later one puts its value into the key the earlier one made.
    #[test]
    fn one_name_twice_in_a_paste_keeps_each_row() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let rows = read(&ts, s, g, "TOKEN=one\nTOKEN=two\nTOKEN=three\n");
        assert_eq!(rows.rows.len(), 3);
        assert_eq!(
            saved_as(&rows, None),
            [(1, "TOKEN_2".to_owned()), (2, "TOKEN_3".to_owned())]
        );
        let written = save(&ts, (s, g), &rows, &[Save, KeepBoth, KeepBoth], None).unwrap();
        assert_eq!(written.data, 3, "the answer counts what was written");
        assert_eq!(
            keys_in(&ts, s, g, None),
            pairs(&[("TOKEN", "one"), ("TOKEN_2", "two"), ("TOKEN_3", "three")])
        );

        let (s, g) = ts.open_vault("Work");
        let rows = read(&ts, s, g, "TOKEN=one\nTOKEN=two\n");
        let written = save(&ts, (s, g), &rows, &[Save, Replace], None).unwrap();
        assert_eq!(written.data, 2);
        assert_eq!(keys_in(&ts, s, g, None), pairs(&[("TOKEN", "two")]));

        // With the first row left out, Replace on the second makes the key: there is none yet.
        let rows = read(&ts, s, g, "FRESH=one\nFRESH=two\n");
        let written = save(&ts, (s, g), &rows, &[LeaveOut, Replace], None).unwrap();
        assert_eq!(written.data, 1);
        assert_eq!(
            keys_in(&ts, s, g, None),
            pairs(&[("FRESH", "two"), ("TOKEN", "two")])
        );
    }

    /// A row left out writes nothing and does not count; when every row is left out nothing is written, the answer is 0
    /// and the token is used up (that is how Cancel lets go of the values at once).
    #[test]
    fn leave_out_skips_the_row() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let rows = read(&ts, s, g, "A=1\nB=2\nC=3\n");
        let written = save(&ts, (s, g), &rows, &[Save, LeaveOut, Save], None).unwrap();
        assert_eq!(written.data, 2);
        assert_eq!(keys_in(&ts, s, g, None), pairs(&[("A", "1"), ("C", "3")]));

        let rows = read(&ts, s, g, "D=4\nE=5\n");
        let written = save(&ts, (s, g), &rows, &[LeaveOut, LeaveOut], None).unwrap();
        assert_eq!(
            (written.data, written.session, written.generation),
            (0, s, g)
        );
        assert_eq!(parked(&ts), 0, "the values are gone at once");
        assert_eq!(keys_in(&ts, s, g, None), pairs(&[("A", "1"), ("C", "3")]));
        assert_eq!(
            save(&ts, (s, g), &rows, &[Save, Save], None).err(),
            NOT_FOUND
        );
    }

    /// Replace puts the row's value into the key of that name, keeping its notes and its place; with no key of that name
    /// it makes one.
    #[test]
    fn replace_keeps_the_notes_and_makes_the_key_when_none_is_there() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let prod = folder(&ts, s, g, "Prod");
        let fields = ItemFields {
            value: Zeroizing::new("old".to_owned()),
            notes: Zeroizing::new("used by the billing job".to_owned()),
            ..ItemFields::default()
        };
        let made = ts.shell.new_item(
            s,
            g,
            NewKind::Key,
            "API_KEY".to_owned(),
            Some(prod.clone()),
            Some(fields),
        );
        let id = made.unwrap().data;

        let rows = read(&ts, s, g, "API_KEY=new\nBRAND_NEW=made\n");
        let written = save(&ts, (s, g), &rows, &[Replace, Replace], Some(&prod)).unwrap();
        assert_eq!(written.data, 2);
        assert_eq!(
            keys_in(&ts, s, g, Some(&prod)),
            pairs(&[("API_KEY", "new"), ("BRAND_NEW", "made")])
        );
        let detail = ts.shell.get_item(s, g, &id).unwrap().data;
        assert_eq!(detail.notes.as_str(), "used by the billing job");
        assert_eq!(detail.revision, 1);
        assert_eq!(detail.summary.collection.as_deref(), Some(prod.as_str()));
    }

    /// Everything is checked before anything is written; a refusal writes nothing, and the token is used up.
    #[test]
    fn a_choice_that_does_not_fit_writes_nothing() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let prod = folder(&ts, s, g, "Prod");
        key(&ts, s, g, "TAKEN", "old", Some(&prod));
        // The paste is `FRESH`, which does not clash in `Prod`, and `TAKEN`, which does: only `[Save, KeepBoth]` (or a
        // Replace or a LeaveOut) fits it. Each of these is wrong in one way.
        let at = |choice: &mut Vec<EnvChoice>, row: usize, index: u32| choice[row].index = index;
        let mut twice = choices(&[Save, KeepBoth]);
        at(&mut twice, 1, 0);
        let mut past = choices(&[Save, KeepBoth]);
        at(&mut past, 1, 2);
        let nowhere = "00000000000000000000000000000000";
        let bad: [(&str, Vec<EnvChoice>, &str); 8] = [
            (
                "a clashing row saved plainly",
                choices(&[Save, Save]),
                &prod,
            ),
            (
                "keep both on a row that does not clash",
                choices(&[KeepBoth, KeepBoth]),
                &prod,
            ),
            ("a row named twice", twice, &prod),
            ("a row missing", choices(&[Save]), &prod),
            ("an extra row", choices(&[Save, KeepBoth, Save]), &prod),
            ("an index past the rows", past, &prod),
            ("no choices at all", Vec::new(), &prod),
            (
                "a folder that is not there",
                choices(&[Save, KeepBoth]),
                nowhere,
            ),
        ];
        for (what, wrong, place) in bad {
            let rows = read(&ts, s, g, "FRESH=new\nTAKEN=again\n");
            let token = rows.token.as_ref().unwrap();
            let refused = ts
                .shell
                .env_save(s, g, token, wrong, Some(place.to_owned()));
            assert_eq!(refused.err(), Some(BAD_ROWS), "{what}");
            assert_eq!(
                keys_in(&ts, s, g, Some(&prod)),
                pairs(&[("TAKEN", "old")]),
                "{what}"
            );
            assert_eq!(parked(&ts), 0, "{what}: the token is used up");
        }
    }

    /// A row that did not clash when the paste was read can clash by the time of the save: the save is refused with
    /// nothing written.
    #[test]
    fn a_row_that_clashes_now_is_refused_as_save() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let rows = read(&ts, s, g, "NEWLY=1\nOTHER=2\n");
        assert!(saved_as(&rows, None).is_empty());
        key(&ts, s, g, "NEWLY", "arrived", None);
        let refused = save(&ts, (s, g), &rows, &[Save, Save], None);
        assert_eq!(refused.err(), Some(BAD_ROWS));
        assert_eq!(keys_in(&ts, s, g, None), pairs(&[("NEWLY", "arrived")]));
        assert_eq!(
            save(&ts, (s, g), &rows, &[Replace, Save], None).err(),
            NOT_FOUND,
            "used up"
        );
    }

    /// Replace on a name the folder has twice is refused with nothing written, even when an earlier row would have been.
    #[test]
    fn replace_on_a_name_the_folder_has_twice_is_refused() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let prod = folder(&ts, s, g, "Prod");
        key(&ts, s, g, "DUP", "one", Some(&prod));
        key(&ts, s, g, "DUP", "two", Some(&prod));
        let rows = read(&ts, s, g, "FIRST=1\nDUP=3\n");
        let refused = save(&ts, (s, g), &rows, &[Save, Replace], Some(&prod));
        assert_eq!(refused.err(), Some(TWICE));
        assert_eq!(
            keys_in(&ts, s, g, Some(&prod)),
            pairs(&[("DUP", "one"), ("DUP", "two")])
        );
        // Keep both is not Replace: it writes under a new name and is allowed.
        let rows = read(&ts, s, g, "FIRST=1\nDUP=3\n");
        let written = save(&ts, (s, g), &rows, &[Save, KeepBoth], Some(&prod)).unwrap();
        assert_eq!(written.data, 2);
    }

    /// A lock after the first write stops the rest: nothing more is written to the vault, and the answer is `Locked`.
    #[test]
    fn a_lock_during_the_save_stops_the_writes() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let rows = read(&ts, s, g, "A=1\nB=2\nC=3\n");
        let shell = Arc::clone(&ts.shell);
        at("after_write", move || {
            shell.sessions.lock(s, LockReason::Manual)
        });
        let answer = save(&ts, (s, g), &rows, &[Save, Save, Save], None);
        assert_eq!(answer.err(), LOCKED);
        // The first key was written before the lock; the vault on disk holds only that one.
        let dir = ts.shell.registry.entries()[0].1.clone();
        let reopened = heavy(|| {
            ReadOnlyVault::open_folder(
                &dir,
                Credential::Password(TEST_PASSWORD),
                &CancelToken::new(),
            )
        })
        .unwrap();
        let found: Vec<String> = reopened.items().map(|i| i.title.clone()).collect();
        assert_eq!(found, ["A"], "the lock stopped the writes after the first");
    }

    // ---- taking keys out

    /// A folder's keys are copied in Rust, sorted by name: the clipboard holds the engine writer's text, which reads back
    /// to the folder's names and values; the answer has no text; the copy is the session's (its lock clears it); a key in
    /// the trash and a key in another place are left out; a read-only session may copy.
    #[test]
    fn copy_out_stays_in_rust() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let prod = folder(&ts, s, g, "Prod");
        let values = [
            ("b_second", "it's \"quoted\" $HOME"),
            ("A_first", "plain-value"),
            ("Z_multi", "line one\nline two\r\ttabbed"),
            ("_under", " leading and trailing "),
            ("EMPTY", ""),
        ];
        for (name, value) in values {
            key(&ts, s, g, name, value, Some(&prod));
        }
        key(&ts, s, g, "ELSEWHERE", "x", None);
        let trashed = key(&ts, s, g, "TRASHED", "y", Some(&prod));
        ts.shell.trash_item(s, g, &trashed).unwrap();

        let answer = ts.shell.env_copy(s, g, &prod).unwrap();
        assert_eq!((answer.session, answer.generation), (s, g));
        assert_eq!(serde_json::to_value(&answer.data).unwrap(), json!("Done"));
        let copied = ts.clipboard.text().expect("copied");
        let expected = {
            let mut sorted = values.to_vec();
            sorted.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
            env_file::write(&sorted)
        };
        assert_eq!(
            copied,
            expected.as_str(),
            "the writer's text, sorted by name"
        );
        assert_eq!(parsed(&copied), {
            let mut all = pairs(&values);
            all.sort();
            all
        });
        assert!(
            copied.starts_with("A_first=")
                && !copied.contains("ELSEWHERE")
                && !copied.contains("TRASHED")
        );
        assert_eq!(parked(&ts), 0);

        ts.shell.sessions.lock(s, LockReason::Manual);
        assert_eq!(ts.clipboard.text(), None, "the lock cleared the copy");

        let (r, gr) = read_only_session(&ts);
        let again = ts.shell.env_copy(r, gr, &prod).unwrap();
        assert_eq!(serde_json::to_value(&again.data).unwrap(), json!("Done"));
        assert_eq!(ts.clipboard.text().as_deref(), Some(expected.as_str()));
    }

    /// A folder that is not a live folder is `NotFound`, one with no key says so, and a key with the folder's id is not a
    /// folder.
    #[test]
    fn copy_out_refuses_a_missing_folder_and_an_empty_one() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let (empty, trashed) = (folder(&ts, s, g, "Empty"), folder(&ts, s, g, "Old"));
        let a_key = key(&ts, s, g, "SOME_KEY", "v", Some(&trashed));
        ts.shell.delete_collection(s, g, &trashed).unwrap();
        let no_keys = Some(NO_KEYS);
        assert_eq!(ts.shell.env_copy(s, g, &empty).err(), no_keys);
        for not_a_folder in [
            "00000000000000000000000000000000",
            trashed.as_str(),
            a_key.as_str(),
        ] {
            assert_eq!(ts.shell.env_copy(s, g, not_a_folder).err(), NOT_FOUND);
            assert_eq!(ts.shell.env_save_file(s, g, not_a_folder).err(), NOT_FOUND);
        }
        assert_eq!(ts.clipboard.text(), None);
        assert_eq!(ts.dialogs.opened(), 0);
        assert_eq!(ts.shell.env_save_file(s, g, &empty).err(), no_keys);
        assert_eq!(ts.dialogs.opened(), 0, "no dialog for an empty folder");
        assert!(ts.shell.env_copy(s, g, "not an id").is_err());
    }

    /// Two keys with one name stop the copy and the save with the name, in a tagged answer: nothing is copied and no
    /// dialog opens.
    #[test]
    fn two_with_one_name_stops_with_the_message() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let prod = folder(&ts, s, g, "Prod");
        key(&ts, s, g, "OPENAI_API_KEY", "one", Some(&prod));
        key(&ts, s, g, "OTHER", "x", Some(&prod));
        key(&ts, s, g, "OPENAI_API_KEY", "two", Some(&prod));

        for answer in [
            ts.shell.env_copy(s, g, &prod).unwrap(),
            ts.shell.env_save_file(s, g, &prod).unwrap(),
        ] {
            assert_eq!(
                serde_json::to_value(&answer.data).unwrap(),
                json!({ "Duplicate": { "name": "OPENAI_API_KEY" } })
            );
        }
        assert_eq!(ts.clipboard.text(), None, "nothing was copied");
        assert_eq!(ts.dialogs.opened(), 0, "no dialog opened");
    }

    // ---- saving a file

    fn docs_with_old_file(ts: &TestShell) -> (PathBuf, PathBuf) {
        let docs = ts.folder("Documents");
        let dest = docs.join(".env");
        fs::write(&dest, OLD).unwrap();
        (docs, dest)
    }

    fn saved(answer: ShellResult<Tagged<EnvOut>>) -> String {
        match answer {
            Ok(Tagged {
                data: EnvOut::Saved(Outcome::Done(view)),
                ..
            }) => view.folder,
            Ok(_) => panic!("not saved"),
            Err(error) => panic!("refused: {error:?}"),
        }
    }

    fn nothing_but(ts: &TestShell, docs: &Path, files: &[&str]) {
        assert_eq!(names(docs), files);
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    /// The file is the folder's keys as the engine writer makes them, sorted by name, written to the name the dialog
    /// gave and no other (no filter, so Windows adds no extension to a name typed without one); a name that is not
    /// `.env` stays as typed; the answer names the folder; an existing file is replaced; no temp is left.
    #[test]
    fn save_file_writes_what_the_dialog_named() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let prod = folder(&ts, s, g, "Prod");
        key(&ts, s, g, "SECOND", "it's 2", Some(&prod));
        key(&ts, s, g, "FIRST", "plain", Some(&prod));
        key(&ts, s, g, "ELSEWHERE", "x", None);
        let (docs, dest) = docs_with_old_file(&ts);

        ts.dialogs.answer(Some(dest.clone()));
        let answer = ts.shell.env_save_file(s, g, &prod);
        assert_eq!(
            saved(answer),
            docs.to_str().unwrap().trim_start_matches(r"\\?\")
        );
        let text = fs::read_to_string(&dest).unwrap();
        assert_eq!(
            text,
            env_file::write(&[("FIRST", "plain"), ("SECOND", "it's 2")]).as_str()
        );
        assert_eq!(
            parsed(&text),
            pairs(&[("FIRST", "plain"), ("SECOND", "it's 2")])
        );
        nothing_but(&ts, &docs, &[".env"]);

        let typed = docs.join("production");
        ts.dialogs.answer(Some(typed.clone()));
        saved(ts.shell.env_save_file(s, g, &prod));
        assert!(
            typed.is_file(),
            "the name the person typed is the name written"
        );
        nothing_but(&ts, &docs, &[".env", "production"]);

        assert_eq!(ts.dialogs.suggested(), [".env", ".env"]);
        assert_eq!(
            ts.dialogs.titles(),
            [ReadableJob::env_file(item_id(&prod).unwrap()).title; 2]
        );
        assert_eq!(
            ts.dialogs.filters(),
            [None, None],
            "no filter: no extension is added"
        );
    }

    /// A closed dialog writes nothing and answers `Dismissed`.
    #[test]
    fn save_file_dialog_closed_writes_nothing() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let prod = folder(&ts, s, g, "Prod");
        key(&ts, s, g, "KEY", "v", Some(&prod));
        let (docs, dest) = docs_with_old_file(&ts);
        ts.dialogs.answer(None);
        let answer = ts.shell.env_save_file(s, g, &prod).unwrap();
        assert!(matches!(answer.data, EnvOut::Saved(Outcome::Dismissed)));
        assert_eq!(fs::read(&dest).unwrap(), OLD);
        nothing_but(&ts, &docs, &[".env"]);
    }

    /// A lock while the dialog is open, and a lock after the temp file is written and before it is moved into place:
    /// either way the answer is `Locked`, the file that was there is as it was, and no temp or journal entry is left.
    #[test]
    fn save_file_lock_leaves_no_file() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let (b, gb) = ts.open_vault("Work");
        let prod = folder(&ts, s, g, "Prod");
        key(&ts, s, g, "KEY", "v", Some(&prod));
        let work = folder(&ts, b, gb, "Work");
        key(&ts, b, gb, "KEY", "v", Some(&work));
        let (docs, dest) = docs_with_old_file(&ts);
        let new_place = docs.join("fresh.env");

        // In the dialog.
        let shell = Arc::clone(&ts.shell);
        ts.dialogs
            .during_next_dialog(Box::new(move || shell.sessions.lock(s, LockReason::Manual)));
        ts.dialogs.answer(Some(dest.clone()));
        assert_eq!(ts.shell.env_save_file(s, g, &prod).err(), LOCKED);
        assert_eq!(fs::read(&dest).unwrap(), OLD);
        nothing_but(&ts, &docs, &[".env"]);

        // With the temp written, on a vault that is still unlocked.
        let shell = Arc::clone(&ts.shell);
        at("file_written", move || {
            shell.sessions.lock(b, LockReason::Manual)
        });
        ts.dialogs.answer(Some(dest.clone()));
        assert_eq!(ts.shell.env_save_file(b, gb, &work).err(), LOCKED);
        assert_eq!(fs::read(&dest).unwrap(), OLD, "the old file is as it was");
        nothing_but(&ts, &docs, &[".env"]);

        // And the same for a new name.
        let (again, ga) = ts.open_vault("Later");
        let later = folder(&ts, again, ga, "Later");
        key(&ts, again, ga, "KEY", "v", Some(&later));
        let shell = Arc::clone(&ts.shell);
        at("file_written", move || {
            shell.sessions.lock(again, LockReason::Manual)
        });
        ts.dialogs.answer(Some(new_place.clone()));
        assert_eq!(ts.shell.env_save_file(again, ga, &later).err(), LOCKED);
        assert!(!new_place.exists(), "no file appeared");
        nothing_but(&ts, &docs, &[".env"]);
    }

    /// No copy of a key's value (the export text) is alive while the save dialog is open: the check before the dialog keeps
    /// only its answer, and the text is made again when the file is written, then dropped as soon as it is on disk. The
    /// count is of the export texts made and not yet dropped on this thread, which is the thread the fake dialog runs on,
    /// read from inside the dialog. A copy to the clipboard leaves none either. Held through a lock while the dialog is
    /// open too.
    #[test]
    fn no_export_text_lives_while_the_dialog_is_open() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let (b, gb) = ts.open_vault("Work");
        let prod = folder(&ts, s, g, "Prod");
        key(&ts, s, g, "KEY", SECRET, Some(&prod));
        let work = folder(&ts, b, gb, "Work");
        key(&ts, b, gb, "KEY", SECRET, Some(&work));
        let (docs, dest) = docs_with_old_file(&ts);
        assert_eq!(alive_export_texts(), 0);

        // A lock while the dialog is open.
        let (seen, shell) = (
            Arc::new(AtomicUsize::new(usize::MAX)),
            Arc::clone(&ts.shell),
        );
        let in_dialog = Arc::clone(&seen);
        ts.dialogs.during_next_dialog(Box::new(move || {
            in_dialog.store(alive_export_texts(), Ordering::SeqCst);
            shell.sessions.lock(s, LockReason::Manual);
        }));
        ts.dialogs.answer(Some(dest.clone()));
        assert_eq!(ts.shell.env_save_file(s, g, &prod).err(), LOCKED);
        assert_eq!(
            seen.load(Ordering::SeqCst),
            0,
            "a copy waited in the dialog"
        );
        assert_eq!(alive_export_texts(), 0);

        // A save that goes through: none in the dialog, one while the file is written, none once it is.
        let in_dialog = Arc::clone(&seen);
        ts.dialogs.during_next_dialog(Box::new(move || {
            in_dialog.store(alive_export_texts(), Ordering::SeqCst);
        }));
        let written = Rc::new(Cell::new(usize::MAX));
        let on_disk = Rc::clone(&written);
        at("file_written", move || on_disk.set(alive_export_texts()));
        ts.dialogs.answer(Some(dest.clone()));
        saved(ts.shell.env_save_file(b, gb, &work));
        assert_eq!(
            seen.load(Ordering::SeqCst),
            0,
            "a copy waited in the dialog"
        );
        assert_eq!(written.get(), 0, "the text outlived its write");
        assert_eq!(alive_export_texts(), 0);
        assert!(fs::read_to_string(&dest).unwrap().contains(SECRET));
        nothing_but(&ts, &docs, &[".env"]);

        // A copy, and the answers that make no text.
        ts.shell.env_copy(b, gb, &work).unwrap();
        assert_eq!(alive_export_texts(), 0);
        key(&ts, b, gb, "KEY", "again", Some(&work));
        ts.shell.env_copy(b, gb, &work).unwrap();
        ts.shell.env_save_file(b, gb, &work).unwrap();
        assert_eq!(alive_export_texts(), 0);
    }

    /// A cloud-synced folder asks first and writes nothing; the yes goes on with the parked job and reads the keys again,
    /// so the file holds what the folder holds then; the token is used up.
    #[test]
    fn save_file_cloud_asks() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let prod = folder(&ts, s, g, "Prod");
        key(&ts, s, g, "FIRST", "1", Some(&prod));
        let (docs, dest) = docs_with_old_file(&ts);
        ts.volumes.add_sync_root(&docs);
        ts.dialogs.answer(Some(dest.clone()));

        let answer = ts.shell.env_save_file(s, g, &prod).unwrap();
        let EnvOut::Saved(Outcome::Confirm(Confirm::CloudFolder { token })) = answer.data else {
            panic!("a cloud folder asks first");
        };
        assert_eq!(
            fs::read(&dest).unwrap(),
            OLD,
            "nothing is written before the yes"
        );
        nothing_but(&ts, &docs, &[".env"]);
        assert_eq!(ts.dialogs.opened(), 1);

        // The folder changes while the question is open.
        key(&ts, s, g, "SECOND", "2", Some(&prod));
        let done = ts.shell.save_readable_confirm(&token).unwrap();
        assert!(matches!(done.data, Outcome::Done(_)));
        assert_eq!(ts.dialogs.opened(), 1, "no second dialog");
        let text = fs::read_to_string(&dest).unwrap();
        assert_eq!(parsed(&text), pairs(&[("FIRST", "1"), ("SECOND", "2")]));
        nothing_but(&ts, &docs, &[".env"]);
        assert_eq!(ts.shell.save_readable_confirm(&token).err(), NOT_FOUND);
    }

    /// A second key of one name that arrives while the dialog is open, or while the cloud question is open, stops the
    /// save with `env twice`: the file that was there is as it was.
    #[test]
    fn a_duplicate_found_when_the_file_is_written_is_refused() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let prod = folder(&ts, s, g, "Prod");
        key(&ts, s, g, "KEY", "1", Some(&prod));
        let (docs, dest) = docs_with_old_file(&ts);

        let (shell, id) = (Arc::clone(&ts.shell), prod.clone());
        ts.dialogs.during_next_dialog(Box::new(move || {
            let fields = ItemFields {
                value: Zeroizing::new("2".to_owned()),
                ..ItemFields::default()
            };
            let made = shell.new_item(s, g, NewKind::Key, "KEY".to_owned(), Some(id), Some(fields));
            made.unwrap();
        }));
        ts.dialogs.answer(Some(dest.clone()));
        let refused = ts.shell.env_save_file(s, g, &prod);
        assert_eq!(refused.err(), Some(TWICE));
        assert_eq!(fs::read(&dest).unwrap(), OLD);
        nothing_but(&ts, &docs, &[".env"]);

        // The same at the cloud yes.
        let (s, g) = ts.open_vault("Work");
        let work = folder(&ts, s, g, "Work");
        key(&ts, s, g, "KEY", "1", Some(&work));
        ts.volumes.add_sync_root(&docs);
        ts.dialogs.answer(Some(dest.clone()));
        let answer = ts.shell.env_save_file(s, g, &work).unwrap();
        let EnvOut::Saved(Outcome::Confirm(Confirm::CloudFolder { token })) = answer.data else {
            panic!("a cloud folder asks first");
        };
        key(&ts, s, g, "KEY", "2", Some(&work));
        assert_eq!(ts.shell.save_readable_confirm(&token).err(), Some(TWICE));
        assert_eq!(fs::read(&dest).unwrap(), OLD);
        nothing_but(&ts, &docs, &[".env"]);
    }

    /// A vault folder as the destination is refused by the engine's own check, as it is for the PDF.
    #[test]
    fn save_file_in_a_vault_folder_is_refused() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let prod = folder(&ts, s, g, "Prod");
        key(&ts, s, g, "KEY", "1", Some(&prod));
        let vault = ts.shell.registry.entries()[0].1.clone();
        let before = names(&vault);
        ts.dialogs.answer(Some(vault.join(".env")));
        let refused = ts.shell.env_save_file(s, g, &prod);
        assert_eq!(
            refused.err(),
            Some(ShellError::from(CoreError::InvalidInput {
                what: "destination in a vault folder"
            }))
        );
        assert_eq!(names(&vault), before);
    }

    // ---- every command

    /// A stale generation and a foreign session are refused by all four; a read-only session by the three that write
    /// (it may copy); the refusals carry no value or name.
    #[test]
    fn env_commands_refused_stale_foreign_read_only() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let prod = folder(&ts, s, g, "SECRET_FOLDER");
        key(&ts, s, g, "SOME_NAME", SECRET, Some(&prod));
        let text = || Zeroizing::new(format!("SOME_NAME={SECRET}\n"));
        let foreign = SessionId(s.0 + 100);
        let rows = read(&ts, s, g, "SOME_NAME=1\n");
        let token = rows.token.as_ref().unwrap();
        let go = |sid, gen_| ts.shell.env_save(sid, gen_, token, choices(&[Save]), None);

        assert_eq!(ts.shell.env_read(s, g + 1, text()).err(), LOCKED);
        assert_eq!(ts.shell.env_read(foreign, g, text()).err(), NOT_FOUND);
        assert_eq!(go(s, g + 1).err(), LOCKED);
        assert_eq!(parked(&ts), 0, "a refused save still used the token up");
        let rows = read(&ts, s, g, "SOME_NAME=1\n");
        let token = rows.token.as_ref().unwrap();
        let go = |sid, gen_| ts.shell.env_save(sid, gen_, token, choices(&[Save]), None);
        assert_eq!(go(foreign, g).err(), NOT_FOUND);
        assert_eq!(parked(&ts), 0);
        assert_eq!(ts.shell.env_copy(s, g + 1, &prod).err(), LOCKED);
        assert_eq!(ts.shell.env_copy(foreign, g, &prod).err(), NOT_FOUND);
        assert_eq!(ts.shell.env_save_file(s, g + 1, &prod).err(), LOCKED);
        assert_eq!(ts.shell.env_save_file(foreign, g, &prod).err(), NOT_FOUND);
        assert_eq!((ts.dialogs.opened(), ts.clipboard.text()), (0, None));

        let (r, gr) = read_only_session(&ts);
        assert_eq!(
            ts.shell.env_read(r, gr, text()).err(),
            Some(ShellError::ReadOnly)
        );
        let other = made_up_token();
        let refused = ts.shell.env_save(r, gr, &other, choices(&[Save]), None);
        assert_eq!(refused.err(), Some(ShellError::ReadOnly));
        assert_eq!(
            ts.shell.env_save_file(r, gr, &prod).err(),
            Some(ShellError::ReadOnly)
        );
        assert_eq!(ts.dialogs.opened(), 0);
        assert!(
            ts.shell.env_copy(r, gr, &prod).is_ok(),
            "a read-only vault may copy"
        );
        assert_eq!(parked(&ts), 0);

        for error in [
            ShellError::Locked,
            ShellError::NotFound,
            ShellError::ReadOnly,
            TEXT_TOO_LARGE,
            TOO_MANY_KEYS,
            BAD_ROWS,
            TWICE,
            NO_KEYS,
        ] {
            assert_clean(&error, "SOME_NAME");
        }
    }

    /// The limits come with a label and no text: 1,048,576 bytes of text, 500 keys, a value of a key's limit and a name of
    /// a title's. The limit itself passes. A refusal parks nothing.
    #[test]
    fn oversized_paste_refused_with_a_number() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let refuse = |text: String| ts.shell.env_read(s, g, Zeroizing::new(text)).err();

        let comment = |len: usize| format!("#{}", "x".repeat(len - 1));
        assert_eq!(refuse(comment(MAX_TEXT + 1)), Some(TEXT_TOO_LARGE));
        let at_the_limit = ts.shell.env_read(s, g, Zeroizing::new(comment(MAX_TEXT)));
        assert!(at_the_limit.unwrap().data.token.is_none());
        let bytes_not_chars = "é".repeat(MAX_TEXT / 2 + 1);
        assert_eq!(
            refuse(bytes_not_chars),
            Some(TEXT_TOO_LARGE),
            "bytes, not characters"
        );

        let keys = |n: usize| (0..n).map(|i| format!("K{i}=v\n")).collect::<String>();
        assert_eq!(refuse(keys(MAX_KEYS + 1)), Some(TOO_MANY_KEYS));
        assert_eq!(read(&ts, s, g, &keys(MAX_KEYS)).rows.len(), MAX_KEYS);

        let too_long = "v".repeat(MAX_KEY_VALUE + 1);
        // The refusals `at_most` gives a value and a name over their limits, as every other form's are.
        let value_too_long = at_most("ab", 1, "value").unwrap_err();
        assert_eq!(refuse(format!("K={too_long}\n")), Some(value_too_long));
        read(&ts, s, g, &format!("K={}\n", "v".repeat(MAX_KEY_VALUE)));
        let name_too_long = at_most("ab", 1, "title").unwrap_err();
        assert_eq!(
            refuse(format!("{}=v\n", "N".repeat(MAX_TITLE + 1))),
            Some(name_too_long)
        );
        read(&ts, s, g, &format!("{}=v\n", "N".repeat(MAX_TITLE)));

        let before = parked(&ts);
        refuse(comment(MAX_TEXT + 1));
        refuse(keys(MAX_KEYS + 1));
        assert_eq!(parked(&ts), before, "a refusal parks nothing");
        assert_eq!(
            serde_json::to_value(TEXT_TOO_LARGE).unwrap(),
            json!({ "code": "too_large", "what": "env text" })
        );
    }

    /// Whatever the text, a read never panics, and neither the answer nor a refusal shows a value.
    #[test]
    fn any_paste_never_panics_and_never_leaks_a_value() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let pieces = [
            "A=", "export ", "'", "\"", "\\", "\n", "\r\n", "\r", "#", " ", "\t", "=", "$", "é",
            "NAME", "9", "\u{feff}", SECRET, "A", "=\"", "'\n", "\\n",
        ];
        let mut state = 0x2545_f491_4f6c_dd1d_u64;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            usize::try_from(state >> 33).unwrap()
        };
        for _ in 0..300 {
            let count = next() % 40;
            let text: String = (0..count).map(|_| pieces[next() % pieces.len()]).collect();
            let shown = match ts.shell.env_read(s, g, Zeroizing::new(text)) {
                Ok(answer) => serde_json::to_string(&answer).unwrap(),
                Err(error) => format!("{error:?}"),
            };
            assert!(!shown.contains(SECRET), "a value is in {shown}");
        }
    }

    /// The commands' requests refuse unknown or missing fields with the one fixed answer, take the choices as the page
    /// sends them, and answer in the shapes the page expects.
    #[test]
    fn env_requests_and_answers_have_the_agreed_shapes() {
        let body = |value: Value| InvokeBody::Json(value);
        // Built here, not written out, so no key-shaped literal sits in the source.
        let token = ["0123456789abcdef"; 2].concat();
        let ok = json!({ "session": 1, "generation": 2, "text": "A=1" });
        assert!(parse::<ReadArgs>(&body(ok)).is_ok());
        for bad in [
            json!({ "session": 1, "generation": 2 }),
            json!({ "session": 1, "generation": 2, "text": 5 }),
            json!({ "session": 1, "generation": 2, "text": "A=1", "path": "C:\\x" }),
        ] {
            assert_eq!(parse::<ReadArgs>(&body(bad)).err(), Some(MALFORMED));
        }
        let save = |extra: Value| {
            let mut base = json!({
                "session": 1, "generation": 2, "token": token, "collection": null,
                "choices": [{ "index": 0, "action": "keep_both" }, { "index": 1, "action": "leave_out" }],
            });
            base.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            base
        };
        let parsed_save = parse::<SaveArgs>(&body(save(json!({})))).unwrap();
        let actions: Vec<_> = parsed_save
            .choices
            .iter()
            .map(|c| (c.index, c.action))
            .collect();
        assert_eq!(actions, [(0, KeepBoth), (1, LeaveOut)]);
        assert_eq!(parsed_save.collection, None);
        let with_folder = save(json!({ "collection": "00000000000000000000000000000001" }));
        assert!(
            parse::<SaveArgs>(&body(with_folder))
                .unwrap()
                .collection
                .is_some()
        );
        for bad in [
            save(json!({ "token": "not a token" })),
            save(json!({ "path": "C:\\x" })),
            save(json!({ "choices": [{ "index": 0, "action": "Save" }] })),
            save(json!({ "choices": [{ "index": 0, "action": "save", "value": "x" }] })),
            save(json!({ "choices": [{ "index": -1, "action": "save" }] })),
            json!({ "session": 1, "generation": 2, "token": token, "collection": null }),
        ] {
            assert_eq!(parse::<SaveArgs>(&body(bad)).err(), Some(MALFORMED));
        }
        let folder = json!({ "session": 1, "generation": 2, "collection": "abc" });
        assert!(parse::<FolderArgs>(&body(folder)).is_ok());
        for bad in [
            json!({ "session": 1, "generation": 2 }),
            json!({ "session": 1, "generation": 2, "collection": null }),
            json!({ "session": 1, "generation": 2, "collection": "abc", "path": "C:\\x" }),
        ] {
            assert_eq!(parse::<FolderArgs>(&body(bad)).err(), Some(MALFORMED));
        }

        assert_eq!(serde_json::to_value(EnvOut::Done).unwrap(), json!("Done"));
        let duplicate = EnvOut::Duplicate {
            name: "A".to_owned(),
        };
        assert_eq!(
            serde_json::to_value(duplicate).unwrap(),
            json!({ "Duplicate": { "name": "A" } })
        );
        let saved = EnvOut::Saved(Outcome::Done(SavedView {
            folder: "C:\\Docs".to_owned(),
        }));
        assert_eq!(
            serde_json::to_value(saved).unwrap(),
            json!({ "Saved": { "Done": { "folder": "C:\\Docs" } } })
        );
        assert_eq!(
            serde_json::to_value(EnvOut::Saved(Outcome::Dismissed)).unwrap(),
            json!({ "Saved": "Dismissed" })
        );
        let rows = EnvRows {
            token: None,
            rows: vec![EnvRow {
                index: 0,
                name: "A".to_owned(),
            }],
            bad_lines: vec![4],
            clashes: vec![EnvClashes {
                collection: None,
                rows: vec![EnvClash {
                    index: 0,
                    saved_as: "A_2".to_owned(),
                }],
            }],
        };
        assert_eq!(
            serde_json::to_value(rows).unwrap(),
            json!({
                "token": null,
                "rows": [{ "index": 0, "name": "A" }],
                "bad_lines": [4],
                "clashes": [{ "collection": null, "rows": [{ "index": 0, "saved_as": "A_2" }] }],
            })
        );
    }
}
