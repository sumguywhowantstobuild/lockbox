//! The save box's commands (the design's "How a copied key gets saved").

use std::collections::HashSet;
use std::sync::Arc;

use lockbox_core::Vault;
use lockbox_core::ids::ItemId;
use lockbox_core::item::{ItemKind, check_key_name};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Request;
use zeroize::Zeroizing;

use super::env::{EnvRows, Places, TWICE, clashes_in, make_key};
use super::items::{MAX_KEY_VALUE, MAX_TITLE, at_most, collection_id};
use super::{NoArgs, args, blocking};
use crate::capture::{CaptureEvent, CaptureState, ClipboardAfter};
use crate::error::{ShellError, ShellResult};
use crate::session::{SessionId, Tagged};
use crate::shell::Shell;

/// The value to save was not given the way the slot needs: nothing typed for a captured value, or nothing (or only
/// spaces) typed when none was captured.
pub(crate) const CAPTURE_VALUE: ShellError = ShellError::InvalidInput {
    what: "capture value",
};

/// What `capture_save` does when a live key of the name is already in the place.
#[derive(Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum OnClash {
    /// Write nothing and answer the name Keep both would use.
    Ask,
    /// Put the value in the old key, keeping its notes.
    Replace,
    /// Save under this name, which the page was shown, if it still holds.
    KeepBoth(String),
}

/// What `capture_save` came to.
#[derive(Serialize)]
pub enum CaptureSaved {
    Saved {
        id: String,
        name: String,
        clipboard: ClipboardAfter,
    },
    Clash {
        saved_as: String,
    },
}

/// What the person chose in the save box.
pub struct SaveWhat {
    pub name: String,
    pub collection: Option<String>,
    pub on_clash: OnClash,
    pub clear_clipboard: bool,
    pub typed: Option<Zeroizing<String>>,
}

/// What the write found in the place: a key made or changed (its id and name), or a clash to ask about.
enum Written {
    Saved { id: ItemId, name: String },
    Clash { saved_as: String },
}

/// The write of `capture_save`, in one `Sessions::write`: the folder, the clash and then the key.
fn write_key(
    vault: &mut Vault,
    name: &str,
    place: Option<ItemId>,
    on_clash: &OnClash,
    value: Zeroizing<String>,
) -> ShellResult<Written> {
    if let Some(folder) = place {
        let live = vault.get_item(&folder).is_ok_and(|item| {
            matches!(item.kind, ItemKind::Collection) && item.trashed_at.is_none()
        });
        if !live {
            return Err(ShellError::NotFound);
        }
    }
    // A clash is a live key of exactly this name in this place: the same rule `env_save` holds its rows to (a paste of one
    // row with no earlier ones), so the name Keep both gives is the same too.
    let (saved_as, old) = {
        let places = Places::of(vault.items());
        let live = places.live(place);
        let saved_as = clashes_in(live, &[name], &HashSet::new()).swap_remove(0);
        (saved_as, live.get(name).cloned().unwrap_or_default())
    };
    let made =
        |vault: &mut Vault, name: String, value: Zeroizing<String>| -> ShellResult<Written> {
            let id = make_key(vault, &name, place, value)?;
            Ok(Written::Saved { id, name })
        };
    let Some(saved_as) = saved_as else {
        return made(vault, name.to_owned(), value);
    };
    at_most(&saved_as, MAX_TITLE, "title")?;
    match on_clash {
        OnClash::Ask => Ok(Written::Clash { saved_as }),
        // Only the name the page was shown, and only while it is still what the rule gives: a name never lands on a number
        // the person did not see.
        OnClash::KeepBoth(shown) if *shown == saved_as => made(vault, saved_as, value),
        OnClash::KeepBoth(_) => Ok(Written::Clash { saved_as }),
        OnClash::Replace => match old.as_slice() {
            [id] => {
                let mut next = vault.get_item(id)?.clone();
                next.kind = ItemKind::Key { value };
                vault.update_item(next)?;
                Ok(Written::Saved {
                    id: *id,
                    name: name.to_owned(),
                })
            }
            _ => Err(TWICE),
        },
    }
}

impl Shell {
    /// The slot as an event would say it, for a page that has just loaded.
    pub fn capture_state(&self) -> Option<CaptureEvent> {
        self.capture.state()
    }

    /// Hands the capture to the session's vault: its lock empties the slot. Recorded inside the session's publish guard, so
    /// a lock of that vault either refuses first or waits for this and then empties the slot through its hook.
    pub fn capture_choose(
        &self,
        session: SessionId,
        generation: u64,
        capture_id: &str,
    ) -> ShellResult<Tagged<()>> {
        self.sessions.publish(session, generation, || {
            self.capture.choose(capture_id, session)
        })?;
        self.still_current(session, generation, ())
    }

    /// The copied value (trimmed), for Reveal: only once a vault is chosen, and only while that vault is unlocked.
    pub fn capture_reveal(&self, capture_id: &str) -> ShellResult<Zeroizing<String>> {
        let (chosen, value) = self.capture.reveal(capture_id)?;
        // Its lock empties the slot, but a Reveal between the two must not show the value.
        let unlocked = self.sessions.unlocked();
        match unlocked.iter().any(|(session, _, _)| *session == chosen) {
            true => Ok(value),
            false => Err(ShellError::Locked),
        }
    }

    /// Saves the copied value as a key named `what.name` in `what.collection`, in Rust: the value never crosses.
    ///
    /// Refused first for the name (as a new key's), then for a session that is locked, stale, not ours or read-only, then
    /// for a capture id that is not the slot's, then for the typed value. A clash with a live key answers
    /// [`CaptureSaved::Clash`] and writes nothing. The clipboard is cleared only after the write succeeded, against the
    /// text the slot holds, and then the slot empties: a save that does not write leaves both as they were.
    pub fn capture_save(
        &self,
        session: SessionId,
        generation: u64,
        capture_id: &str,
        what: SaveWhat,
    ) -> ShellResult<Tagged<CaptureSaved>> {
        let SaveWhat {
            name,
            collection,
            on_clash,
            clear_clipboard,
            typed,
        } = what;
        // The key's name, checked as `new_item` checks a key's title: its length, and the engine's rule for its letters.
        at_most(&name, MAX_TITLE, "title")?;
        check_key_name(&name)?;
        self.live_writable(session, generation)?;
        let (state, raw) = self.capture.snapshot(capture_id)?;
        let value = match (state, &raw, typed) {
            (CaptureState::Value, Some(raw), None) => Zeroizing::new(raw.trim().to_owned()),
            (CaptureState::Empty | CaptureState::TooLarge, _, Some(typed))
                if !typed.trim().is_empty() =>
            {
                Zeroizing::new(typed.trim().to_owned())
            }
            _ => return Err(CAPTURE_VALUE),
        };
        at_most(&value, MAX_KEY_VALUE, "value")?;
        let place = collection_id(collection.as_deref())?;
        let written = self.sessions.write(session, generation, |vault, _| {
            write_key(vault, &name, place, &on_clash, value)
        })?;
        let (session, generation) = (written.session, written.generation);
        let (id, name) = match written.data {
            Written::Clash { saved_as } => {
                let data = CaptureSaved::Clash { saved_as };
                return Ok(Tagged {
                    session,
                    generation,
                    data,
                });
            }
            Written::Saved { id, name } => (id.to_hex(), name),
        };
        // After the write, and while the slot still holds what it compares with. A typed value has nothing on the clipboard
        // to clear.
        let clipboard = match (clear_clipboard, state, &raw) {
            (true, CaptureState::Value, Some(raw)) => {
                ClipboardAfter::of_clear(self.os.clipboard.clear_if_text(raw, None))
            }
            _ => ClipboardAfter::NotAsked,
        };
        drop(raw);
        self.capture.empty(self.notifier(), capture_id);
        Ok(Tagged {
            session,
            generation,
            data: CaptureSaved::Saved {
                id,
                name,
                clipboard,
            },
        })
    }

    /// Lets go of the copied value, if `capture_id` is the slot's: an old id is a quiet no-op.
    pub fn capture_cancel(&self, capture_id: &str) {
        self.capture.empty(self.notifier(), capture_id);
    }

    /// Hands the copied text to a paste: the same rows `env_read` gives, the text waiting with them for `env_save` (and its
    /// clear of the clipboard), and the slot empty. Refused as `env_read` is; `NotFound` for an id that is not the slot's and
    /// for a slot with no value. A refusal leaves the text in the slot.
    pub fn capture_env(
        &self,
        session: SessionId,
        generation: u64,
        capture_id: &str,
    ) -> ShellResult<Tagged<EnvRows>> {
        self.live_writable(session, generation)?;
        let (CaptureState::Value, Some(text)) = self.capture.snapshot(capture_id)? else {
            return Err(ShellError::NotFound);
        };
        let rows = self.env_read(session, generation, text)?;
        self.capture.empty(self.notifier(), capture_id);
        Ok(rows)
    }
}

/// `capture_choose` and `capture_env`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionArgs {
    session: SessionId,
    generation: u64,
    capture_id: String,
}

/// `capture_reveal` and `capture_cancel`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdArgs {
    capture_id: String,
}

/// `capture_save`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveArgs {
    session: SessionId,
    generation: u64,
    capture_id: String,
    name: String,
    collection: Option<String>,
    on_clash: OnClash,
    clear_clipboard: bool,
    typed: Option<Zeroizing<String>>,
}

/// What the slot holds, as an event would say it, or nothing.
#[tauri::command]
pub(super) async fn capture_state(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Option<CaptureEvent>> {
    let NoArgs {} = args(&request)?;
    Ok(shell.capture_state())
}

/// Hands the slot to a vault: the one whose lock empties it.
#[tauri::command]
pub(super) async fn capture_choose(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<()>> {
    let SessionArgs {
        session,
        generation,
        capture_id,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.capture_choose(session, generation, &capture_id)).await
}

/// The copied value, once, for Reveal.
#[tauri::command]
pub(super) async fn capture_reveal(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Zeroizing<String>> {
    let IdArgs { capture_id } = args(&request)?;
    shell.capture_reveal(&capture_id)
}

/// Saves the copied value as a key.
#[tauri::command]
pub(super) async fn capture_save(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<CaptureSaved>> {
    let SaveArgs {
        session,
        generation,
        capture_id,
        name,
        collection,
        on_clash,
        clear_clipboard,
        typed,
    } = args(&request)?;
    let what = SaveWhat {
        name,
        collection,
        on_clash,
        clear_clipboard,
        typed,
    };
    let shell = Arc::clone(&shell);
    blocking(move || shell.capture_save(session, generation, &capture_id, what)).await
}

/// Lets go of the copied value.
#[tauri::command]
pub(super) async fn capture_cancel(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<()> {
    let IdArgs { capture_id } = args(&request)?;
    shell.capture_cancel(&capture_id);
    Ok(())
}

/// Moves the copied text into a paste, as its keys' rows.
#[tauri::command]
pub(super) async fn capture_env(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<EnvRows>> {
    let SessionArgs {
        session,
        generation,
        capture_id,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.capture_env(session, generation, &capture_id)).await
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use lockbox_core::blob::CancelToken;
    use lockbox_core::ids::ItemId;
    use lockbox_core::item::{ItemKind, MAX_ITEM_JSON, check_key_name};
    use lockbox_core::{Credential, ReadOnlyVault};
    use serde_json::{Value, json};
    use tauri::ipc::InvokeBody;

    use super::super::env::{BAD_ROWS, MAX_KEYS, TOO_MANY_KEYS, TWICE, all_items};
    use super::super::items::{ItemFields, MAX_KEY_VALUE, MAX_TITLE, NewKind, at_most};
    use super::super::{MALFORMED, parse};
    use super::*;
    use crate::capture::CaptureState;
    use crate::error::Outcome;
    use crate::session::{Location, LockReason, OpenStep, Opened};
    use crate::testing::{TEST_PASSWORD, TestShell, heavy};

    /// A made-up text, never a real secret.
    const COPIED: &str = "Pw-0123456789-xyz";
    const NOT_FOUND: Option<ShellError> = Some(ShellError::NotFound);
    const LOCKED: Option<ShellError> = Some(ShellError::Locked);
    const READ_ONLY: Option<ShellError> = Some(ShellError::ReadOnly);

    /// The user copies `text` and presses the shortcut: the new capture's id.
    fn press(ts: &TestShell, text: &str) -> String {
        assert!(ts.clipboard.user_copy(text));
        ts.shell.save_shortcut_pressed();
        let last = ts.events.captures().pop().expect("an event was sent");
        last["capture_id"].as_str().unwrap().to_owned()
    }

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
        place: Option<&str>,
    ) -> String {
        let fields = ItemFields {
            value: Zeroizing::new(value.to_owned()),
            notes: Zeroizing::new("kept notes".to_owned()),
            ..ItemFields::default()
        };
        let made = ts.shell.new_item(
            s,
            g,
            NewKind::Key,
            name.to_owned(),
            place.map(str::to_owned),
            Some(fields),
        );
        made.unwrap().data
    }

    /// Every live key in a place: name, value and notes, sorted.
    fn keys_in(
        ts: &TestShell,
        s: SessionId,
        g: u64,
        place: Option<&str>,
    ) -> Vec<(String, String, String)> {
        let place = place.map(|id| ItemId::from_hex(id).unwrap());
        let read = ts.shell.sessions.read(s, g, |vault, _| {
            let mut found = Vec::new();
            for item in all_items(&vault) {
                if let ItemKind::Key { value } = &item.kind
                    && item.trashed_at.is_none()
                    && item.collection == place
                {
                    found.push((
                        item.title.clone(),
                        value.to_string(),
                        item.notes.to_string(),
                    ));
                }
            }
            Ok(found)
        });
        let mut found = read.unwrap().data;
        found.sort();
        found
    }

    fn triple(name: &str, value: &str, notes: &str) -> (String, String, String) {
        (name.to_owned(), value.to_owned(), notes.to_owned())
    }

    fn what(name: &str, collection: Option<&str>, on_clash: OnClash, clear: bool) -> SaveWhat {
        SaveWhat {
            name: name.to_owned(),
            collection: collection.map(str::to_owned),
            on_clash,
            clear_clipboard: clear,
            typed: None,
        }
    }

    fn save(
        ts: &TestShell,
        (s, g): (SessionId, u64),
        id: &str,
        what: SaveWhat,
    ) -> ShellResult<Tagged<CaptureSaved>> {
        ts.shell.capture_save(s, g, id, what)
    }

    /// `(id, name, clipboard)` of a save that wrote, else a failure.
    fn saved(answer: ShellResult<Tagged<CaptureSaved>>) -> (String, String, ClipboardAfter) {
        match answer.map(|tagged| tagged.data) {
            Ok(CaptureSaved::Saved {
                id,
                name,
                clipboard,
            }) => (id, name, clipboard),
            Ok(CaptureSaved::Clash { saved_as }) => panic!("a clash was answered: {saved_as}"),
            Err(error) => panic!("the save was refused: {error:?}"),
        }
    }

    /// The name Keep both would use, of a save that wrote nothing and asked.
    fn clash(answer: ShellResult<Tagged<CaptureSaved>>) -> String {
        match answer.map(|tagged| tagged.data) {
            Ok(CaptureSaved::Clash { saved_as }) => saved_as,
            Ok(CaptureSaved::Saved { .. }) => panic!("the key was saved"),
            Err(error) => panic!("the save was refused: {error:?}"),
        }
    }

    fn state_of(ts: &TestShell) -> Option<CaptureState> {
        ts.shell.capture_state().map(|event| event.state)
    }

    fn parked(ts: &TestShell) -> usize {
        ts.shell.sessions.pending().len()
    }

    /// A read-only session over the vault listed first, as a backup opens. It locks every vault first.
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

    /// Nothing of a made-up value or name is in the refusal's text, `Debug` or JSON.
    fn assert_clean(error: &ShellError, name: &str) {
        let shown = format!("{error:?} {}", serde_json::to_string(error).unwrap());
        assert!(!shown.contains(COPIED), "a value is in {shown}");
        assert!(!shown.contains(name), "a name is in {shown}");
    }

    // ---- handing the slot to a vault

    /// Choosing records the vault the copied value goes to: Reveal is refused until a vault is chosen, then shows the
    /// trimmed value; choosing another replaces the first; the chosen vault's lock empties the slot, and then nothing is
    /// left to reveal.
    #[test]
    fn choose_records_the_vault() {
        let ts = TestShell::new();
        let (family, gf) = ts.open_vault("Family");
        let (work, gw) = ts.open_vault("Work");
        let id = press(&ts, &format!("  {COPIED} \r\n"));
        assert_eq!(
            ts.shell.capture_reveal(&id).err(),
            LOCKED,
            "no vault chosen yet"
        );

        let chosen = ts.shell.capture_choose(family, gf, &id).unwrap();
        assert_eq!((chosen.session, chosen.generation), (family, gf));
        assert_eq!(serde_json::to_value(&chosen).unwrap()["data"], Value::Null);
        assert_eq!(
            ts.shell.capture_reveal(&id).unwrap().as_str(),
            COPIED,
            "the value shown is the trimmed one"
        );

        ts.shell.capture_choose(work, gw, &id).unwrap();
        ts.shell.sessions.lock(family, LockReason::Manual);
        assert_eq!(
            state_of(&ts),
            Some(CaptureState::Value),
            "the first vault was still the chosen one"
        );
        ts.shell.sessions.lock(work, LockReason::Manual);
        assert_eq!(state_of(&ts), None);
        assert_eq!(ts.shell.capture_reveal(&id).err(), NOT_FOUND);
    }

    /// An old capture id is refused by every command that takes one, and nothing it asked for happens: after a second press
    /// the first id is not the slot's any more (the save box that held it must not save the new value under a name the
    /// person typed for the old one, or show it).
    #[test]
    fn old_capture_id_is_refused() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let old = press(&ts, COPIED);
        let new = press(&ts, "Other-value-1");
        assert_ne!(old, new);
        ts.shell.capture_choose(s, g, &new).unwrap();
        let before = ts.events.captures().len();
        let writes = || keys_in(&ts, s, g, None);

        assert_eq!(ts.shell.capture_choose(s, g, &old).err(), NOT_FOUND);
        assert_eq!(ts.shell.capture_reveal(&old).err(), NOT_FOUND);
        let asked = what("API_KEY", None, OnClash::Replace, true);
        assert_eq!(save(&ts, (s, g), &old, asked).err(), NOT_FOUND);
        assert_eq!(ts.shell.capture_env(s, g, &old).err(), NOT_FOUND);
        let nonsense = [
            String::new(),
            "nope".to_owned(),
            "0".repeat(32),
            "A".repeat(33),
            "f".repeat(31),
        ];
        for junk in nonsense {
            assert_eq!(ts.shell.capture_reveal(&junk).err(), NOT_FOUND, "{junk:?}");
            assert_eq!(
                save(
                    &ts,
                    (s, g),
                    &junk,
                    what("API_KEY", None, OnClash::Ask, false)
                )
                .err(),
                NOT_FOUND,
                "{junk:?}"
            );
        }
        ts.shell.capture_cancel(&old);

        assert_eq!(writes(), Vec::new(), "an old id wrote a key");
        assert_eq!(
            ts.clipboard.text().as_deref(),
            Some("Other-value-1"),
            "an old id cleared the clipboard"
        );
        assert_eq!(parked(&ts), 0);
        assert_eq!(
            ts.events.captures().len(),
            before,
            "an old id said something"
        );
        assert_eq!(
            ts.shell.capture_state().map(|e| e.capture_id),
            Some(new.clone())
        );
        assert_eq!(
            ts.shell.capture_reveal(&new).unwrap().as_str(),
            "Other-value-1"
        );

        // No slot at all is the same answer.
        ts.shell.capture_cancel(&new);
        assert_eq!(ts.shell.capture_reveal(&new).err(), NOT_FOUND);
        assert_eq!(ts.shell.capture_choose(s, g, &new).err(), NOT_FOUND);
        assert_eq!(
            save(
                &ts,
                (s, g),
                &new,
                what("API_KEY", None, OnClash::Ask, false)
            )
            .err(),
            NOT_FOUND
        );
    }

    /// `capture_state` describes the slot as an event would, `changed` false, for a page that has just loaded; `null` when
    /// nothing waits.
    #[test]
    fn capture_state_describes_the_slot() {
        let ts = TestShell::new();
        assert_eq!(
            serde_json::to_value(ts.shell.capture_state()).unwrap(),
            Value::Null
        );

        let id = press(&ts, "API_KEY=1\nOTHER=2\n");
        let id2 = press(&ts, "changed-value-1");
        assert_ne!(id, id2);
        assert_eq!(
            serde_json::to_value(ts.shell.capture_state()).unwrap(),
            json!({ "capture_id": id2, "state": "value", "changed": false, "env_keys": null }),
            "the second press said changed; the state does not"
        );
        let id3 = press(&ts, "API_KEY=1\nOTHER=2\n");
        assert_eq!(
            serde_json::to_value(ts.shell.capture_state()).unwrap(),
            json!({ "capture_id": id3, "state": "value", "changed": false, "env_keys": 2 })
        );

        assert!(ts.clipboard.user_copy_non_text());
        ts.shell.save_shortcut_pressed();
        assert_eq!(state_of(&ts), Some(CaptureState::Empty));
        press(&ts, &"a".repeat(MAX_ITEM_JSON + 1));
        assert_eq!(state_of(&ts), Some(CaptureState::TooLarge));
        let shown = serde_json::to_string(&ts.shell.capture_state()).unwrap();
        assert!(!shown.contains("aaaa"), "text crossed");

        ts.shell
            .capture_cancel(&ts.shell.capture_state().unwrap().capture_id);
        assert_eq!(
            serde_json::to_value(ts.shell.capture_state()).unwrap(),
            Value::Null
        );
    }

    /// Only a clean `.env` is offered as keys: its count crosses, never a name or a value.
    #[test]
    fn env_keys_counts_only_a_clean_env_file() {
        let ts = TestShell::new();
        let keys = |text: &str| {
            press(&ts, text);
            ts.shell.capture_state().unwrap().env_keys
        };
        assert_eq!(keys("A=1\nB=2\r\n# a comment\n\nC='three'\n"), Some(3));
        assert_eq!(keys("A=1"), Some(1));
        assert_eq!(keys("A=1\nthis line is bad\n"), None, "a bad line");
        assert_eq!(keys("hunter2"), None, "a bare value");
        assert_eq!(keys("# only a comment\n"), None, "no key at all");
        assert_eq!(keys("   \n"), None);
        assert_eq!(keys(COPIED), None);
    }

    // ---- saving

    /// The clear compares against the slot's text after the write, and before the slot is emptied: the clipboard is
    /// opened with the slot still full and the page not yet told `gone`.
    #[test]
    fn clear_runs_before_the_slot_empties() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let id = press(&ts, COPIED);
        let seen = Arc::new(Mutex::new(None));
        let (shell, events, noted) = (
            Arc::clone(&ts.shell),
            Arc::clone(&ts.events),
            Arc::clone(&seen),
        );
        ts.clipboard.during_next_read(Box::new(move || {
            *crate::lock(&noted) = Some((shell.capture_state(), events.captures().len()));
        }));

        let answer = saved(save(
            &ts,
            (s, g),
            &id,
            what("API_KEY", None, OnClash::Ask, true),
        ));

        assert_eq!(answer.2, ClipboardAfter::Cleared);
        assert_eq!(ts.clipboard.text(), None, "the clipboard was not cleared");
        let (slot_then, told_then) = crate::lock(&seen)
            .take()
            .expect("the clipboard was never read");
        assert_eq!(
            slot_then.map(|e| e.state),
            Some(CaptureState::Value),
            "the slot was empty at the clear"
        );
        assert_eq!(told_then, 1, "`gone` was sent before the clear");
        assert_eq!(state_of(&ts), None);
        assert_eq!(keys_in(&ts, s, g, None), [triple("API_KEY", COPIED, "")]);
    }

    /// A save that does not write leaves the clipboard (never opened) and the slot as they were: a folder that is not
    /// there, a name the engine refuses, a stale session, and the clash question.
    #[test]
    fn failed_save_leaves_the_clipboard() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        key(&ts, s, g, "TAKEN", "old", None);
        let id = press(&ts, COPIED);
        ts.clipboard.take_events();
        let before = ts.events.captures().len();
        let nowhere = "00000000000000000000000000000000";

        let refusals = [
            (
                save(
                    &ts,
                    (s, g),
                    &id,
                    what("API_KEY", Some(nowhere), OnClash::Ask, true),
                )
                .err(),
                NOT_FOUND,
            ),
            (
                save(
                    &ts,
                    (s, g),
                    &id,
                    what("not a name", None, OnClash::Ask, true),
                )
                .err(),
                Some(ShellError::from(check_key_name("not a name").unwrap_err())),
            ),
            (
                save(
                    &ts,
                    (s, g + 1),
                    &id,
                    what("API_KEY", None, OnClash::Ask, true),
                )
                .err(),
                LOCKED,
            ),
        ];
        for (found, wanted) in refusals {
            assert_eq!(found, wanted);
        }
        // The question writes nothing either.
        assert_eq!(
            clash(save(
                &ts,
                (s, g),
                &id,
                what("TAKEN", None, OnClash::Ask, true)
            )),
            "TAKEN_2"
        );

        assert_eq!(
            ts.clipboard.take_events(),
            Vec::<&str>::new(),
            "the clipboard was opened"
        );
        assert_eq!(ts.clipboard.text().as_deref(), Some(COPIED));
        assert_eq!(
            ts.events.captures().len(),
            before,
            "the slot's state was announced"
        );
        assert_eq!(state_of(&ts), Some(CaptureState::Value));
        assert_eq!(
            keys_in(&ts, s, g, None),
            [triple("TAKEN", "old", "kept notes")]
        );

        // And once it can write, the same capture saves and clears.
        let done = saved(save(
            &ts,
            (s, g),
            &id,
            what("API_KEY", None, OnClash::Ask, true),
        ));
        assert_eq!(done.2, ClipboardAfter::Cleared);
    }

    /// The clipboard is cleared only while it still holds what was captured (exactly, as read: the spaces and line breaks
    /// the value was trimmed of included) and only when asked; every other outcome is told, and the key is saved anyway.
    #[test]
    fn clear_only_when_the_clipboard_still_matches() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let at = (s, g);
        let go = |name: &str, clear: bool| {
            let id = ts.events.captures().pop().unwrap()["capture_id"]
                .as_str()
                .unwrap()
                .to_owned();
            saved(save(&ts, at, &id, what(name, None, OnClash::Ask, clear))).2
        };

        // Still there: cleared, though the saved value was trimmed and the clipboard holds the raw text.
        press(&ts, "  Pw-raw-1 \r\n");
        assert_eq!(go("K1", true), ClipboardAfter::Cleared);
        assert_eq!(ts.clipboard.text(), None);

        // Copied something else since: left alone.
        press(&ts, COPIED);
        assert!(ts.clipboard.user_copy("something newer"));
        assert_eq!(go("K2", true), ClipboardAfter::NotOurs);
        assert_eq!(ts.clipboard.text().as_deref(), Some("something newer"));

        // The same letters with one more space: not the text that was captured.
        press(&ts, COPIED);
        assert!(ts.clipboard.user_copy(&format!("{COPIED} ")));
        assert_eq!(go("K3", true), ClipboardAfter::NotOurs);
        assert_eq!(
            ts.clipboard.text().as_deref(),
            Some(format!("{COPIED} ").as_str())
        );

        // Something that is not text now.
        press(&ts, COPIED);
        assert!(ts.clipboard.user_copy_non_text());
        assert_eq!(go("K4", true), ClipboardAfter::NotOurs);
        assert!(ts.clipboard.has_non_text());

        // The clear itself fails (the clipboard stays busy, or Windows refuses the empty): told, the text stays.
        press(&ts, COPIED);
        ts.clipboard.hold_open_elsewhere(true);
        assert_eq!(go("K5", true), ClipboardAfter::Failed);
        ts.clipboard.hold_open_elsewhere(false);
        assert_eq!(ts.clipboard.text().as_deref(), Some(COPIED));
        press(&ts, COPIED);
        ts.clipboard.fail_empty_at(0);
        assert_eq!(go("K6", true), ClipboardAfter::Failed);
        assert_eq!(ts.clipboard.text().as_deref(), Some(COPIED));

        // Not asked: the clipboard is not even opened.
        press(&ts, COPIED);
        let opens = ts.clipboard.opens();
        assert_eq!(go("K7", false), ClipboardAfter::NotAsked);
        assert_eq!(
            ts.clipboard.opens(),
            opens,
            "the clipboard was opened without being asked"
        );
        assert_eq!(ts.clipboard.text().as_deref(), Some(COPIED));

        let names: Vec<String> = keys_in(&ts, s, g, None).into_iter().map(|k| k.0).collect();
        assert_eq!(
            names,
            ["K1", "K2", "K3", "K4", "K5", "K6", "K7"],
            "a key was not saved"
        );
    }

    /// The value is saved in Rust: the answer and every event name the key and say nothing of the value, and the key holds
    /// the trimmed value.
    #[test]
    fn save_in_rust_never_crosses() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let id = press(&ts, &format!("\t{COPIED}  \n"));
        let answer = save(&ts, (s, g), &id, what("API_KEY", None, OnClash::Ask, true)).unwrap();
        let json = serde_json::to_value(&answer).unwrap();
        assert!(
            !json.to_string().contains(COPIED),
            "the value crossed in the answer"
        );
        let key_id = json["data"]["Saved"]["id"].as_str().unwrap().to_owned();
        assert_eq!(
            json,
            json!({
                "session": s.0, "generation": g,
                "data": { "Saved": { "id": key_id, "name": "API_KEY", "clipboard": "cleared" } }
            })
        );
        assert_eq!(keys_in(&ts, s, g, None), [triple("API_KEY", COPIED, "")]);
        let events = serde_json::to_string(&ts.events.captures()).unwrap();
        assert!(!events.contains(COPIED), "the value crossed in an event");
        assert_eq!(ts.shell.capture.alive_texts(), 0);
    }

    /// Stale, foreign and read-only sessions are refused (a read-only one by the commands that write), with nothing
    /// written, the slot kept and nothing of the value or the name in the refusal.
    #[test]
    fn refused_stale_and_read_only() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let id = press(&ts, COPIED);
        let before = ts.events.captures().len();
        let foreign = SessionId(s.0 + 100);
        let ask = || what("SECRET_NAME", None, OnClash::Replace, true);

        assert_eq!(ts.shell.capture_choose(s, g + 1, &id).err(), LOCKED);
        assert_eq!(ts.shell.capture_choose(foreign, g, &id).err(), NOT_FOUND);
        assert_eq!(save(&ts, (s, g + 1), &id, ask()).err(), LOCKED);
        assert_eq!(save(&ts, (foreign, g), &id, ask()).err(), NOT_FOUND);
        assert_eq!(ts.shell.capture_env(s, g + 1, &id).err(), LOCKED);
        assert_eq!(ts.shell.capture_env(foreign, g, &id).err(), NOT_FOUND);

        let (r, gr) = read_only_session(&ts);
        let again = press(&ts, COPIED);
        assert_eq!(save(&ts, (r, gr), &again, ask()).err(), READ_ONLY);
        assert_eq!(ts.shell.capture_env(r, gr, &again).err(), READ_ONLY);
        assert_eq!(
            state_of(&ts),
            Some(CaptureState::Value),
            "a refused command emptied the slot"
        );
        assert_eq!(
            ts.clipboard.text().as_deref(),
            Some(COPIED),
            "a refused save cleared the clipboard"
        );
        assert_eq!(parked(&ts), 0);
        // Only what the lock for the read-only session and the second press said: `gone`, then a new value.
        assert_eq!(ts.events.captures().len(), before + 2);

        for error in [
            ShellError::Locked,
            ShellError::NotFound,
            ShellError::ReadOnly,
            CAPTURE_VALUE,
        ] {
            assert_clean(&error, "SECRET_NAME");
        }
    }

    /// A value typed in the box is for a slot that holds none (`empty`, `too_large`), trimmed, never for one that holds a
    /// captured value; blank is not a value; it is checked against a key's limit; the clipboard is not asked about.
    #[test]
    fn typed_value_rules() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let typed = |text: &str| Some(Zeroizing::new(text.to_owned()));
        let go = |id: &str, name: &str, value: Option<Zeroizing<String>>, clear: bool| {
            let mut asked = what(name, None, OnClash::Ask, clear);
            asked.typed = value;
            save(&ts, (s, g), id, asked)
        };

        // A captured value: nothing may be typed.
        let id = press(&ts, COPIED);
        assert_eq!(go(&id, "A", typed("x"), false).err(), Some(CAPTURE_VALUE));
        assert_eq!(
            go(&id, "A", typed(""), false).err(),
            Some(CAPTURE_VALUE),
            "even an empty string"
        );
        assert_eq!(state_of(&ts), Some(CaptureState::Value));

        // No value captured: one must be typed.
        assert!(ts.clipboard.user_copy_non_text());
        ts.shell.save_shortcut_pressed();
        let id = ts.shell.capture_state().unwrap().capture_id;
        for blank in [None, typed(""), typed("  \t\r\n ")] {
            assert_eq!(go(&id, "B", blank, false).err(), Some(CAPTURE_VALUE));
        }
        let too_long = "v".repeat(MAX_KEY_VALUE + 1);
        assert_eq!(
            go(&id, "B", typed(&too_long), false).err(),
            Some(at_most(&too_long, MAX_KEY_VALUE, "value").unwrap_err())
        );
        assert_eq!(
            keys_in(&ts, s, g, None),
            Vec::new(),
            "a refused save wrote a key"
        );
        assert_eq!(state_of(&ts), Some(CaptureState::Empty));

        // Typed, with the tick box on: saved trimmed, the clipboard (a picture) never opened or cleared.
        ts.clipboard.take_events();
        let done = saved(go(&id, "B", typed("  typed-value-9 \n"), true));
        assert_eq!(done.2, ClipboardAfter::NotAsked);
        assert!(ts.clipboard.has_non_text(), "the clipboard was cleared");
        assert_eq!(ts.clipboard.take_events(), Vec::<&str>::new());
        assert_eq!(keys_in(&ts, s, g, None), [triple("B", "typed-value-9", "")]);
        assert_eq!(state_of(&ts), None);

        // A text too big to hold opens `too_large`: typing is the way, with the same rules.
        press(&ts, &"a".repeat(MAX_ITEM_JSON + 1));
        let id = ts.shell.capture_state().unwrap().capture_id;
        assert_eq!(go(&id, "C", None, false).err(), Some(CAPTURE_VALUE));
        let done = saved(go(&id, "C", typed("typed-value-10"), false));
        assert_eq!(done.1, "C");
        assert_eq!(keys_in(&ts, s, g, None).len(), 2);
    }

    /// The name is checked as a new key's is (letters, digits and `_`, not starting with a digit; the title's length), and
    /// as typed: no trimming. A refusal writes nothing and keeps the slot.
    #[test]
    fn name_is_checked_like_a_new_keys() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let id = press(&ts, COPIED);
        for bad in ["", " API", "API ", "1API", "A-B", "é", "A B", "A.B"] {
            let found = save(&ts, (s, g), &id, what(bad, None, OnClash::Ask, false)).err();
            let wanted = ShellError::from(check_key_name(bad).unwrap_err());
            assert_eq!(found, Some(wanted), "{bad:?}");
            assert_clean(&wanted, "API");
        }
        let long = "N".repeat(MAX_TITLE + 1);
        assert_eq!(
            save(&ts, (s, g), &id, what(&long, None, OnClash::Ask, false)).err(),
            Some(at_most(&long, MAX_TITLE, "title").unwrap_err())
        );
        assert_eq!(keys_in(&ts, s, g, None), Vec::new());
        assert_eq!(state_of(&ts), Some(CaptureState::Value));

        let longest = "N".repeat(MAX_TITLE);
        assert_eq!(
            saved(save(
                &ts,
                (s, g),
                &id,
                what(&longest, None, OnClash::Ask, false)
            ))
            .1,
            longest
        );
    }

    /// A clash is a live key of exactly the name in that place. Ask writes nothing and gives the name Keep both would use;
    /// Replace puts the value in the old key, keeping its notes; Keep both saves under the name that was shown; no clash
    /// makes the key new whatever was asked; a key in the trash or in another folder is not a clash.
    #[test]
    fn clash_asks_then_replaces_or_keeps_both() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let work = folder(&ts, s, g, "Work");
        let other = folder(&ts, s, g, "Other");
        let old = key(&ts, s, g, "API_KEY", "old", Some(&work));
        let place = Some(work.as_str());
        let at = (s, g);

        let id = press(&ts, COPIED);
        assert_eq!(
            clash(save(
                &ts,
                at,
                &id,
                what("API_KEY", place, OnClash::Ask, true)
            )),
            "API_KEY_2"
        );
        assert_eq!(
            keys_in(&ts, s, g, place),
            [triple("API_KEY", "old", "kept notes")],
            "the question wrote"
        );
        assert_eq!(
            state_of(&ts),
            Some(CaptureState::Value),
            "the question emptied the slot"
        );
        assert_eq!(
            ts.clipboard.text().as_deref(),
            Some(COPIED),
            "the question cleared the clipboard"
        );

        // Another place, and no folder: no clash, so the key is made (the question is never asked).
        let (_, name, _) = saved(save(
            &ts,
            at,
            &id,
            what("API_KEY", Some(&other), OnClash::Ask, false),
        ));
        assert_eq!(name, "API_KEY");
        let id = press(&ts, "Second-value-2");
        saved(save(
            &ts,
            at,
            &id,
            what("API_KEY", None, OnClash::Ask, false),
        ));

        // Replace: the value moves into the old key, its notes and its place stay, no second key appears.
        let id = press(&ts, "Third-value-3");
        let (kept, name, _) = saved(save(
            &ts,
            at,
            &id,
            what("API_KEY", place, OnClash::Replace, false),
        ));
        assert_eq!(
            (kept, name),
            (old.clone(), "API_KEY".to_owned()),
            "the old key's id is the answer's"
        );
        assert_eq!(
            keys_in(&ts, s, g, place),
            [triple("API_KEY", "Third-value-3", "kept notes")]
        );

        // Keep both: under the name the question gave.
        let id = press(&ts, "Fourth-value-4");
        assert_eq!(
            clash(save(
                &ts,
                at,
                &id,
                what("API_KEY", place, OnClash::Ask, false)
            )),
            "API_KEY_2"
        );
        let (made, name, _) = saved(save(
            &ts,
            at,
            &id,
            what(
                "API_KEY",
                place,
                OnClash::KeepBoth("API_KEY_2".into()),
                false,
            ),
        ));
        assert_ne!(made, old);
        assert_eq!(name, "API_KEY_2");
        assert_eq!(
            keys_in(&ts, s, g, place),
            [
                triple("API_KEY", "Third-value-3", "kept notes"),
                triple("API_KEY_2", "Fourth-value-4", "")
            ]
        );

        // A key in the trash is no clash: Replace and Keep both just make the key.
        ts.shell.trash_item(s, g, &old).unwrap();
        let id = press(&ts, "Fifth-value-5");
        let (_, name, _) = saved(save(
            &ts,
            at,
            &id,
            what("API_KEY", place, OnClash::Replace, false),
        ));
        assert_eq!(name, "API_KEY");
        let id = press(&ts, "Sixth-value-6");
        let (_, name, _) = saved(save(
            &ts,
            at,
            &id,
            what(
                "BRAND_NEW",
                place,
                OnClash::KeepBoth("BRAND_NEW_2".into()),
                false,
            ),
        ));
        assert_eq!(name, "BRAND_NEW", "no clash: made new under its own name");
    }

    /// A name that lands on a number the person did not see is the thing to stop: Keep both is answered with the question
    /// again, and the new name, when the name it was shown no longer holds, and writes nothing.
    #[test]
    fn keep_both_is_asked_again_when_its_name_no_longer_holds() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let work = folder(&ts, s, g, "Work");
        key(&ts, s, g, "API_KEY", "old", Some(&work));
        let place = Some(work.as_str());
        let at = (s, g);
        let id = press(&ts, COPIED);
        assert_eq!(
            clash(save(
                &ts,
                at,
                &id,
                what("API_KEY", place, OnClash::Ask, false)
            )),
            "API_KEY_2"
        );

        // The folder changes while the box is open: another key takes the number.
        key(&ts, s, g, "API_KEY_2", "newcomer", place);
        let again = save(
            &ts,
            at,
            &id,
            what(
                "API_KEY",
                place,
                OnClash::KeepBoth("API_KEY_2".into()),
                true,
            ),
        );
        assert_eq!(clash(again), "API_KEY_3");
        assert_eq!(keys_in(&ts, s, g, place).len(), 2, "a key was written");
        assert_eq!(state_of(&ts), Some(CaptureState::Value));
        assert_eq!(
            ts.clipboard.text().as_deref(),
            Some(COPIED),
            "the clipboard was cleared"
        );

        // A name that was never the rule's is no better.
        let wrong = save(
            &ts,
            at,
            &id,
            what(
                "API_KEY",
                place,
                OnClash::KeepBoth("API_KEY_9".into()),
                false,
            ),
        );
        assert_eq!(clash(wrong), "API_KEY_3");
        // A name from a different base is no better either.
        let wrong = save(
            &ts,
            at,
            &id,
            what(
                "API_KEY",
                place,
                OnClash::KeepBoth("ANYTHING".into()),
                false,
            ),
        );
        assert_eq!(clash(wrong), "API_KEY_3");
        assert_eq!(keys_in(&ts, s, g, place).len(), 2);

        // The one it now gives is taken.
        let (_, name, _) = saved(save(
            &ts,
            at,
            &id,
            what(
                "API_KEY",
                place,
                OnClash::KeepBoth("API_KEY_3".into()),
                false,
            ),
        ));
        assert_eq!(name, "API_KEY_3");
    }

    /// Replace on a name the place has twice is refused (the engine does not say which); the question still answers.
    #[test]
    fn replace_on_a_name_the_folder_has_twice_is_refused() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        key(&ts, s, g, "DUP", "one", None);
        key(&ts, s, g, "DUP", "two", None);
        let id = press(&ts, COPIED);
        assert_eq!(
            clash(save(
                &ts,
                (s, g),
                &id,
                what("DUP", None, OnClash::Ask, false)
            )),
            "DUP_2"
        );
        assert_eq!(
            save(&ts, (s, g), &id, what("DUP", None, OnClash::Replace, true)).err(),
            Some(TWICE)
        );
        assert_eq!(keys_in(&ts, s, g, None).len(), 2);
        assert_eq!(state_of(&ts), Some(CaptureState::Value));
        assert_eq!(ts.clipboard.text().as_deref(), Some(COPIED));
    }

    /// A folder that is not there, is in the trash, or is not a folder is `not_found`, and nothing is written.
    #[test]
    fn a_folder_that_is_not_there_is_not_found() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let gone = folder(&ts, s, g, "Gone");
        ts.shell.delete_collection(s, g, &gone).unwrap();
        let a_key = key(&ts, s, g, "NOT_A_FOLDER", "x", None);
        let id = press(&ts, COPIED);
        for place in [
            "00000000000000000000000000000000",
            gone.as_str(),
            a_key.as_str(),
        ] {
            let found = save(
                &ts,
                (s, g),
                &id,
                what("API_KEY", Some(place), OnClash::Ask, false),
            )
            .err();
            assert_eq!(found, NOT_FOUND, "{place}");
        }
        assert_eq!(
            keys_in(&ts, s, g, None),
            [triple("NOT_A_FOLDER", "x", "kept notes")]
        );
        assert_eq!(state_of(&ts), Some(CaptureState::Value));
    }

    // ---- the copied text as a .env

    /// `capture_env` hands the copied text to a paste: the rows are the ones `env_read` gives (names only), the slot
    /// empties and says `gone`, the paste waits for `env_save`, and the save's clear compares with the raw text the slot held.
    #[test]
    fn capture_env_answers_the_rows_and_moves_the_text() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        key(&ts, s, g, "TAKEN", "old", None);
        let text = "TAKEN=new-1\r\nFRESH=new-2\r\nbad line here\r\n";
        let id = press(&ts, text);
        ts.shell.capture_choose(s, g, &id).unwrap();
        let before = ts.events.captures().len();

        let rows = ts.shell.capture_env(s, g, &id).unwrap();
        let json = serde_json::to_value(&rows).unwrap();
        assert!(!json.to_string().contains("new-1"), "a value crossed");
        assert_eq!(
            json["data"]["rows"],
            json!([{ "index": 0, "name": "TAKEN" }, { "index": 1, "name": "FRESH" }])
        );
        assert_eq!(json["data"]["bad_lines"], json!([3]));
        assert_eq!(
            json["data"]["clashes"][0]["rows"],
            json!([{ "index": 0, "saved_as": "TAKEN_2" }])
        );
        assert_eq!((rows.session, rows.generation), (s, g));
        assert_eq!(parked(&ts), 1);
        assert_eq!(
            ts.events.captures()[before..],
            [json!({ "capture_id": id, "state": "gone", "changed": false, "env_keys": null })]
        );
        assert_eq!(state_of(&ts), None);
        assert_eq!(ts.shell.capture.alive_texts(), 0);

        // The save, with the tick box on, clears what the clipboard still holds: the raw text, line breaks and all.
        let token = rows.data.token.unwrap();
        let choices = vec![
            super::super::env::EnvChoice {
                index: 0,
                action: super::super::env::EnvAction::KeepBoth,
            },
            super::super::env::EnvChoice {
                index: 1,
                action: super::super::env::EnvAction::Save,
            },
        ];
        let done = ts
            .shell
            .env_save(s, g, &token, choices, None, true)
            .unwrap();
        assert_eq!(done.data.saved, 2);
        assert_eq!(done.data.clipboard, ClipboardAfter::Cleared);
        assert_eq!(ts.clipboard.text(), None);
        assert_eq!(
            keys_in(&ts, s, g, None),
            [
                triple("FRESH", "new-2", ""),
                triple("TAKEN", "old", "kept notes"),
                triple("TAKEN_2", "new-1", "")
            ]
        );
    }

    /// Refused as `env_read` is (stale, foreign, read-only), `not_found` for an old id and for a slot with no value, and
    /// an unreadable or oversized paste: in every case the text stays in the slot and nothing is parked.
    #[test]
    fn capture_env_is_refused_and_keeps_the_slot() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let id = press(&ts, "A=1\n");
        let old = id.clone();
        let id = press(&ts, "A=1\n");
        assert_eq!(ts.shell.capture_env(s, g, &old).err(), NOT_FOUND);
        assert_eq!(ts.shell.capture_env(s, g + 1, &id).err(), LOCKED);
        assert_eq!(
            ts.shell.capture_env(SessionId(s.0 + 100), g, &id).err(),
            NOT_FOUND
        );
        assert_eq!(state_of(&ts), Some(CaptureState::Value));
        assert_eq!(parked(&ts), 0);

        // More keys than a paste takes: the engine's refusal, and the text is still in the slot.
        let many: String = (0..=MAX_KEYS).map(|i| format!("K{i}=v\n")).collect();
        let id = press(&ts, &many);
        assert_eq!(ts.shell.capture_env(s, g, &id).err(), Some(TOO_MANY_KEYS));
        assert_eq!(state_of(&ts), Some(CaptureState::Value));
        assert_eq!(parked(&ts), 0);

        // No value in the slot.
        assert!(ts.clipboard.user_copy_non_text());
        ts.shell.save_shortcut_pressed();
        let id = ts.shell.capture_state().unwrap().capture_id;
        assert_eq!(ts.shell.capture_env(s, g, &id).err(), NOT_FOUND);
        press(&ts, &"a".repeat(MAX_ITEM_JSON + 1));
        let id = ts.shell.capture_state().unwrap().capture_id;
        assert_eq!(ts.shell.capture_env(s, g, &id).err(), NOT_FOUND);

        let (r, gr) = read_only_session(&ts);
        let id = press(&ts, "A=1\n");
        assert_eq!(ts.shell.capture_env(r, gr, &id).err(), READ_ONLY);
        assert_eq!(state_of(&ts), Some(CaptureState::Value));
        assert_eq!(parked(&ts), 0);
        assert_clean(&BAD_ROWS, "A");
    }

    // ---- the requests and the answers

    /// The commands' requests refuse unknown or missing fields with the one fixed answer, take Keep both as the page sends
    /// it, and answer in the shapes the page expects.
    #[test]
    fn capture_requests_and_answers_have_the_agreed_shapes() {
        let body = |value: Value| InvokeBody::Json(value);
        let id = "0123456789abcdef0123456789abcdef";
        let save_body = |extra: Value| {
            let mut base = json!({
                "session": 1, "generation": 2, "capture_id": id, "name": "API_KEY", "collection": null,
                "on_clash": "ask", "clear_clipboard": true, "typed": null,
            });
            base.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            base
        };
        let parsed = parse::<SaveArgs>(&body(save_body(json!({})))).unwrap();
        assert!(matches!(parsed.on_clash, OnClash::Ask));
        assert!(parsed.clear_clipboard && parsed.typed.is_none() && parsed.collection.is_none());
        let parsed = parse::<SaveArgs>(&body(save_body(
            json!({ "on_clash": "replace", "typed": "v" }),
        )))
        .unwrap();
        assert!(matches!(parsed.on_clash, OnClash::Replace));
        assert_eq!(parsed.typed.as_deref().map(String::as_str), Some("v"));
        let parsed = parse::<SaveArgs>(&body(save_body(
            json!({ "on_clash": { "keep_both": "A_2" } }),
        )))
        .unwrap();
        assert!(matches!(&parsed.on_clash, OnClash::KeepBoth(name) if name == "A_2"));
        for bad in [
            save_body(json!({ "on_clash": "keep_both" })),
            save_body(json!({ "on_clash": "Ask" })),
            save_body(json!({ "on_clash": { "keep_both": "A_2", "extra": 1 } })),
            save_body(json!({ "on_clash": { "keep_both": 5 } })),
            save_body(json!({ "on_clash": { "other": "x" } })),
            save_body(json!({ "path": "C:\\x" })),
            save_body(json!({ "clear_clipboard": "yes" })),
            save_body(json!({ "typed": 5 })),
            json!({ "session": 1, "generation": 2, "capture_id": id, "name": "A", "collection": null, "on_clash": "ask" }),
        ] {
            assert_eq!(parse::<SaveArgs>(&body(bad)).err(), Some(MALFORMED));
        }
        let session = json!({ "session": 1, "generation": 2, "capture_id": id });
        assert!(parse::<SessionArgs>(&body(session)).is_ok());
        for bad in [
            json!({ "session": 1, "generation": 2 }),
            json!({ "session": 1, "capture_id": id }),
            json!({ "session": 1, "generation": 2, "capture_id": id, "path": "C:\\x" }),
        ] {
            assert_eq!(parse::<SessionArgs>(&body(bad)).err(), Some(MALFORMED));
        }
        assert!(parse::<IdArgs>(&body(json!({ "capture_id": id }))).is_ok());
        for bad in [
            json!({}),
            json!({ "capture_id": 5 }),
            json!({ "capture_id": id, "session": 1 }),
        ] {
            assert_eq!(parse::<IdArgs>(&body(bad)).err(), Some(MALFORMED));
        }

        let saved = CaptureSaved::Saved {
            id: "k".to_owned(),
            name: "A".to_owned(),
            clipboard: ClipboardAfter::Failed,
        };
        assert_eq!(
            serde_json::to_value(saved).unwrap(),
            json!({ "Saved": { "id": "k", "name": "A", "clipboard": "failed" } })
        );
        let asked = CaptureSaved::Clash {
            saved_as: "A_2".to_owned(),
        };
        assert_eq!(
            serde_json::to_value(asked).unwrap(),
            json!({ "Clash": { "saved_as": "A_2" } })
        );
        for (after, word) in [
            (ClipboardAfter::Cleared, "cleared"),
            (ClipboardAfter::NotOurs, "not_ours"),
            (ClipboardAfter::Failed, "failed"),
            (ClipboardAfter::NotAsked, "not_asked"),
        ] {
            assert_eq!(serde_json::to_value(after).unwrap(), json!(word));
        }
        assert_eq!(
            serde_json::to_value(CAPTURE_VALUE).unwrap(),
            json!({ "code": "invalid_input", "what": "capture value" })
        );
        assert_eq!(
            serde_json::to_value(crate::capture::CaptureState::TooLarge).unwrap(),
            json!("too_large")
        );
    }
}
