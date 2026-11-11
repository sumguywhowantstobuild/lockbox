//! The capture slot (the design's "How a copied key gets saved"): the text the save shortcut read from the clipboard,
//! waiting in Rust for the save box. One slot, one id, one wiped copy of the text. The page is told its id and what state it
//! is in ([`CaptureEvent`]) and never the text, which crosses only through Reveal (`capture_reveal`).
//!
//! The slot empties (and the page is told `gone`) when the capture is saved, cancelled or handed to a paste, when every
//! vault locks (a lock of all vaults, the window's close, idle, Windows' lock and sleep, Quit: each runs the lock hooks
//! with `None`, even with no vault open) and when the vault it was handed to locks. A second press replaces it.
//!
//! The slot's mutex is held for the replacing and the emptying and for the events they send, so the page hears of a
//! capture and of its end in the order they happened. It is never held across the clipboard or the vault.

use std::sync::{Arc, Mutex, Weak};

use lockbox_core::env_file;
use serde::Serialize;
use zeroize::Zeroizing;

use crate::commands::items::MAX_KEY_VALUE;
use crate::error::{ShellError, ShellResult};
use crate::lock;
use crate::os::CLIPBOARD_TOO_LARGE;
use crate::session::{LockHook, Notifier, SessionId, Sessions};

/// What the page may know of the slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureState {
    Value,
    Empty,
    TooLarge,
    Gone,
}

/// `lockbox://capture`: never the value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CaptureEvent {
    pub capture_id: String,
    pub state: CaptureState,
    pub changed: bool,
    pub env_keys: Option<u32>,
}

/// What became of the clipboard after a save that asked to clear it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClipboardAfter {
    Cleared,
    NotOurs,
    Failed,
    NotAsked,
}

/// One clipboard read, as the slot takes it.
pub(crate) struct Read {
    pub(crate) text: Option<Zeroizing<String>>,
    pub(crate) state: CaptureState,
    pub(crate) env_keys: Option<u32>,
}

impl Read {
    /// What a press makes of the clipboard's answer: a text with something in it is a value; a blank text, no text
    /// (a picture), a clipboard another program kept busy and any other failure are `empty`; a text over the item limit is
    /// `too_large`, and so is one whose trimmed text is over a key's limit unless it reads as a `.env` (it could only ever
    /// be refused as a key; a `.env` goes to the paste). A value is looked at once for `.env` keys: only their count is kept.
    pub(crate) fn of(read: ShellResult<Option<Zeroizing<String>>>) -> Read {
        const TOO_LARGE: Read = Read {
            text: None,
            state: CaptureState::TooLarge,
            env_keys: None,
        };
        match read {
            Ok(Some(text)) if !text.trim().is_empty() => {
                let env_keys = env_keys(&text);
                if env_keys.is_none() && text.trim().len() > MAX_KEY_VALUE {
                    return TOO_LARGE;
                }
                Read {
                    env_keys,
                    text: Some(text),
                    state: CaptureState::Value,
                }
            }
            Err(error) if error == CLIPBOARD_TOO_LARGE => TOO_LARGE,
            _ => Read {
                text: None,
                state: CaptureState::Empty,
                env_keys: None,
            },
        }
    }
}

/// How many keys `text` holds as a `.env` file, when it holds at least one and no line that cannot be read: a lone
/// password with an `=` in it can pass for one line, which is why the page only offers it. Nothing else of it is kept.
fn env_keys(text: &str) -> Option<u32> {
    let env_file::EnvParse { entries, bad_lines } = env_file::parse(text);
    match entries.is_empty() || !bad_lines.is_empty() {
        true => None,
        false => Some(u32::try_from(entries.len()).unwrap_or(u32::MAX)),
    }
}

/// A new capture's id: 16 bytes from the OS random source, as a copy's tag is made. `None` only when Windows has none to
/// give, which the press takes as nothing to keep.
fn new_id() -> Option<[u8; 16]> {
    let mut id = [0u8; 16];
    getrandom::fill(&mut id).ok()?;
    Some(id)
}

/// An id as the page knows it: 32 lowercase hex characters.
fn hex(id: &[u8; 16]) -> String {
    id.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The text held in a slot, wiped when dropped. Tests count how many of a [`Capture`]'s are alive
/// ([`Capture::alive_texts`]), to see that a replaced or emptied slot lets go of its text at once, whichever thread drops it.
struct Held {
    text: Zeroizing<String>,
    #[cfg(test)]
    alive: Arc<std::sync::atomic::AtomicUsize>,
}

impl Held {
    #[cfg_attr(not(test), allow(unused_variables))]
    fn new(text: Zeroizing<String>, capture: &Capture) -> Held {
        #[cfg(test)]
        capture
            .alive
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Held {
            text,
            #[cfg(test)]
            alive: Arc::clone(&capture.alive),
        }
    }
}

#[cfg(test)]
impl Drop for Held {
    fn drop(&mut self) {
        self.alive.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// What the slot holds. No `Debug`: it holds the copied text (R5).
struct Slot {
    id: [u8; 16],
    /// The clipboard text exactly as read, for the clear's comparison. `None` for `empty` and `too_large`.
    text: Option<Held>,
    state: CaptureState,
    /// [`Sessions::epoch`] as it was before the clipboard read began.
    epoch: u64,
    /// The vault the page handed the capture to: its lock empties the slot.
    chosen: Option<SessionId>,
    env_keys: Option<u32>,
}

impl Slot {
    /// The value to save and show: the text without the spaces, tabs and line breaks round it (copying from a terminal
    /// or a web page often adds them).
    fn value(&self) -> Option<&str> {
        self.text.as_ref().map(|held| held.text.trim())
    }

    fn event(&self, changed: bool) -> CaptureEvent {
        CaptureEvent {
            capture_id: hex(&self.id),
            state: self.state,
            changed,
            env_keys: self.env_keys.filter(|_| self.state == CaptureState::Value),
        }
    }
}

fn gone(id: &[u8; 16]) -> CaptureEvent {
    CaptureEvent {
        capture_id: hex(id),
        state: CaptureState::Gone,
        changed: false,
        env_keys: None,
    }
}

/// The one slot.
#[derive(Default)]
pub struct Capture {
    slot: Mutex<Option<Slot>>,
    /// Tests only: how many slot texts are alive.
    #[cfg(test)]
    alive: Arc<std::sync::atomic::AtomicUsize>,
}

impl Capture {
    /// Tests only: how many slot texts (every one this slot has held and not dropped) are alive.
    #[cfg(test)]
    pub(crate) fn alive_texts(&self) -> usize {
        self.alive.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Puts a press's read in the slot, in place of what was there, and tells the page: whether it did. Not when every vault
    /// locked since the read began (`began` is [`Sessions::epoch`] from before it): a lock cannot be undone by a read
    /// that began before it, and nothing is sent. `changed` is whether an earlier capture was waiting with another value.
    pub(crate) fn fill(
        &self,
        notifier: &dyn Notifier,
        sessions: &Sessions,
        began: u64,
        read: Read,
    ) -> bool {
        let Some(id) = new_id() else {
            return false;
        };
        let mut slot = lock(&self.slot);
        // Checked here, under the slot's mutex: a lock that comes after this check finds the slot and empties it.
        if sessions.epoch() != began {
            return false;
        }
        let earlier = slot.take();
        let new = Slot {
            id,
            text: read.text.map(|text| Held::new(text, self)),
            state: read.state,
            epoch: began,
            chosen: earlier.as_ref().and_then(|old| old.chosen),
            env_keys: read.env_keys,
        };
        let changed = earlier
            .as_ref()
            .is_some_and(|old| old.value() != new.value());
        let event = new.event(changed);
        *slot = Some(new);
        // The text before it goes now, wiped, not when this call ends.
        drop(earlier);
        notifier.capture(&event);
        true
    }

    /// The slot as an event would say it (`changed` false), for a page that has just loaded.
    pub fn state(&self) -> Option<CaptureEvent> {
        lock(&self.slot).as_ref().map(|slot| slot.event(false))
    }

    /// The slot, if `id` is its id: a capture id that is old, made up or of nothing is `NotFound`.
    fn current<'a>(slot: &'a mut Option<Slot>, id: &str) -> ShellResult<&'a mut Slot> {
        slot.as_mut()
            .filter(|held| hex(&held.id) == id)
            .ok_or(ShellError::NotFound)
    }

    /// Records the vault the capture goes to. Run inside that session's publish guard, so a lock of it cannot slip in
    /// between: it either refuses first, or waits and then runs its hook, which empties the slot.
    pub(crate) fn choose(&self, id: &str, session: SessionId) -> ShellResult<()> {
        Self::current(&mut lock(&self.slot), id)?.chosen = Some(session);
        Ok(())
    }

    /// The vault the capture was handed to and the value (trimmed), for Reveal: `NotFound` for an old id and for a slot
    /// that holds no value, `Locked` when no vault was chosen.
    pub(crate) fn reveal(&self, id: &str) -> ShellResult<(SessionId, Zeroizing<String>)> {
        let mut slot = lock(&self.slot);
        let held = Self::current(&mut slot, id)?;
        let Some(value) = held.value() else {
            return Err(ShellError::NotFound);
        };
        let chosen = held.chosen.ok_or(ShellError::Locked)?;
        Ok((chosen, Zeroizing::new(value.to_owned())))
    }

    /// A copy of the slot's state and raw text, for a command that works on the text after the mutex is let go.
    pub(crate) fn snapshot(
        &self,
        id: &str,
    ) -> ShellResult<(CaptureState, Option<Zeroizing<String>>)> {
        let mut slot = lock(&self.slot);
        let held = Self::current(&mut slot, id)?;
        let raw = held
            .text
            .as_ref()
            .map(|held| Zeroizing::new(held.text.to_string()));
        Ok((held.state, raw))
    }

    /// Empties the slot if `id` is its id, and tells the page: whether it did. An old id changes nothing.
    pub(crate) fn empty(&self, notifier: &dyn Notifier, id: &str) -> bool {
        let mut slot = lock(&self.slot);
        if Self::current(&mut slot, id).is_err() {
            return false;
        }
        let emptied = slot.take();
        if let Some(emptied) = &emptied {
            notifier.capture(&gone(&emptied.id));
        }
        emptied.is_some()
    }

    /// The lock hook: every lock of all vaults (`None`) empties the slot, unless the capture was read after that lock
    /// (its epoch is the sessions' now, so a lock's late hook does not take a newer capture); the lock of the vault the
    /// capture was handed to empties it.
    pub(crate) fn lock_hook(
        self: &Arc<Self>,
        sessions: Weak<Sessions>,
        notifier: Arc<dyn Notifier>,
    ) -> LockHook {
        let capture = Arc::clone(self);
        Box::new(move |only, _| {
            let Some(sessions) = sessions.upgrade() else {
                return;
            };
            let mut slot = lock(&capture.slot);
            let goes = slot.as_ref().is_some_and(|held| match only {
                None => held.epoch < sessions.epoch(),
                Some(locked) => held.chosen == Some(locked),
            });
            if !goes {
                return;
            }
            if let Some(emptied) = slot.take() {
                notifier.capture(&gone(&emptied.id));
            }
        })
    }
}

impl ClipboardAfter {
    /// What the clear's answer comes to for the page: the clipboard held the text and was emptied, held something else (or
    /// nothing), or could not be emptied (busy, or Windows refused).
    pub(crate) fn of_clear(cleared: ShellResult<bool>) -> ClipboardAfter {
        match cleared {
            Ok(true) => ClipboardAfter::Cleared,
            Ok(false) => ClipboardAfter::NotOurs,
            Err(_) => ClipboardAfter::Failed,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    use lockbox_core::item::MAX_ITEM_JSON;
    use serde_json::{Value, json};

    use super::*;
    use crate::commands::capture::{OnClash, SaveWhat};

    use crate::os::{Clock, OsSignal};
    use crate::session::LockReason;
    use crate::testing::TestShell;

    /// A made-up text, never a real secret.
    const COPIED: &str = "Pw-0123456789-xyz";
    /// A made-up value that must never show up in an event, an answer, an error or a `Debug`.
    const SECRET: &str = "S3NT1NEL-value";
    const GIVE_UP: Duration = Duration::from_secs(30);

    fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
        let began = Instant::now();
        while !done() {
            assert!(began.elapsed() < GIVE_UP, "{what}");
            thread::sleep(Duration::from_millis(2));
        }
    }

    /// The user copies `text` and presses the shortcut: the press is read on this thread, so it is done on return.
    fn copy_and_press(ts: &TestShell, text: &str) {
        assert!(ts.clipboard.user_copy(text));
        ts.shell.save_shortcut_pressed();
    }

    fn captures(ts: &TestShell) -> Vec<Value> {
        ts.events.captures()
    }

    /// The id of the last event sent.
    fn last_id(ts: &TestShell) -> String {
        let last = captures(ts).pop().expect("an event was sent");
        last["capture_id"].as_str().unwrap().to_owned()
    }

    fn value_event(id: &str, changed: bool, env_keys: Option<u32>) -> Value {
        json!({ "capture_id": id, "state": "value", "changed": changed, "env_keys": env_keys })
    }

    fn gone_event(id: &str) -> Value {
        json!({ "capture_id": id, "state": "gone", "changed": false, "env_keys": null })
    }

    /// The slot is empty and the last thing the page was told is that this capture is gone.
    fn assert_emptied(ts: &TestShell, id: &str, events_before: usize) {
        assert_eq!(
            ts.shell.capture_state(),
            None,
            "the slot still holds a capture"
        );
        assert_eq!(
            ts.shell.capture.alive_texts(),
            0,
            "a copied text is still alive"
        );
        let sent = captures(ts);
        assert_eq!(
            sent[events_before..],
            [gone_event(id)],
            "exactly one `gone` for the capture"
        );
    }

    fn save_what(name: &str) -> SaveWhat {
        SaveWhat {
            name: name.to_owned(),
            collection: None,
            on_clash: OnClash::Ask,
            clear_clipboard: false,
            typed: None,
        }
    }

    // ---- the press

    /// A press reads the clipboard once (one opening: its size, then its text), leaves it as it was, tells the page the
    /// state and an id and nothing of the value, and only then brings the window forward.
    #[test]
    fn press_reads_once_and_sends_no_value() {
        let ts = TestShell::new();
        assert!(ts.clipboard.user_copy(COPIED));
        let seen = std::sync::Arc::new(std::sync::Mutex::new(None));
        let (events, window_saw) = (
            std::sync::Arc::clone(&ts.events),
            std::sync::Arc::clone(&seen),
        );
        ts.window.during_next_forward(move || {
            *window_saw.lock().unwrap() = Some(events.captures().len());
        });

        ts.shell.save_shortcut_pressed();

        assert_eq!(ts.clipboard.opens(), 1, "one opening");
        assert_eq!(
            ts.clipboard.take_events(),
            ["open", "text size", "read text", "close"]
        );
        assert_eq!(
            ts.clipboard.text().as_deref(),
            Some(COPIED),
            "the press changed the clipboard"
        );
        let sent = captures(&ts);
        assert_eq!(sent.len(), 1);
        let id = sent[0]["capture_id"].as_str().unwrap();
        assert_eq!(id.len(), 32);
        assert!(
            id.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        );
        assert_eq!(sent[0], value_event(id, false, None));
        assert!(!sent[0].to_string().contains(COPIED), "the value crossed");
        assert_eq!(ts.window.forwards(), 1);
        assert_eq!(
            *seen.lock().unwrap(),
            Some(1),
            "the window came forward before the page was told"
        );
        assert_eq!(
            ts.shell.capture_state(),
            Some(CaptureEvent {
                capture_id: id.to_owned(),
                state: CaptureState::Value,
                changed: false,
                env_keys: None,
            })
        );
    }

    /// A text over the item limit is never copied out of the clipboard: the capture opens empty-handed, `too_large`.
    #[test]
    fn over_limit_capture_opens_empty() {
        let ts = TestShell::new();
        copy_and_press(&ts, &"a".repeat(MAX_ITEM_JSON + 1));
        assert_eq!(ts.clipboard.take_events(), ["open", "text size", "close"]);
        let id = last_id(&ts);
        assert_eq!(
            captures(&ts),
            [json!({ "capture_id": id, "state": "too_large", "changed": false, "env_keys": null })]
        );
        assert_eq!(
            ts.shell.capture_reveal(&id).err(),
            Some(ShellError::NotFound),
            "there is no value to show"
        );
        assert_eq!(
            ts.window.forwards(),
            1,
            "the box still opens, to take a typed value"
        );
        assert_eq!(ts.shell.capture.alive_texts(), 0, "a text was kept");
    }

    /// A text over a key's limit could never be saved as a key, so it opens as `too_large` (8c: a typed value instead), not as
    /// a value every Save would refuse; nothing of it is kept. A `.env` of that size is still a value, for the paste.
    #[test]
    fn a_text_over_a_keys_limit_opens_too_large_unless_it_is_a_env() {
        let ts = TestShell::new();
        let trimmed_over = format!("  {}  ", "a".repeat(MAX_KEY_VALUE + 1));
        copy_and_press(&ts, &trimmed_over);
        let id = last_id(&ts);
        assert_eq!(
            captures(&ts),
            [json!({ "capture_id": id, "state": "too_large", "changed": false, "env_keys": null })]
        );
        assert_eq!(ts.shell.capture.alive_texts(), 0, "a text was kept");

        // At the limit once trimmed: a value.
        copy_and_press(&ts, &format!(" {} ", "a".repeat(MAX_KEY_VALUE)));
        assert_eq!(captures(&ts).last().unwrap()["state"], "value");

        let env: String = (0..800)
            .map(|n| format!("KEY_{n}=made-up-value-{n:020}\n"))
            .collect();
        assert!(env.len() > MAX_KEY_VALUE);
        copy_and_press(&ts, &env);
        let last = captures(&ts).last().unwrap().clone();
        assert_eq!(last["state"], "value");
        assert_eq!(last["env_keys"], 800);
    }

    /// Something that is not text (a picture), a blank text, an empty clipboard and a clipboard another program holds all
    /// open the box empty-handed: `empty`.
    #[test]
    fn non_text_capture_opens_empty() {
        let ts = TestShell::new();
        assert!(ts.clipboard.user_copy_non_text());
        ts.shell.save_shortcut_pressed();
        let id = last_id(&ts);
        assert_eq!(
            captures(&ts),
            [json!({ "capture_id": id, "state": "empty", "changed": false, "env_keys": null })]
        );
        assert!(ts.clipboard.has_non_text(), "the press touched the picture");

        for (what, setup) in [("blank text", "  \r\n\t "), ("empty text", "")] {
            let before = captures(&ts).len();
            copy_and_press(&ts, setup);
            let sent = captures(&ts);
            assert_eq!(sent.len(), before + 1, "{what}");
            assert_eq!(sent[before]["state"], "empty", "{what}");
        }
        let before = captures(&ts).len();
        ts.clipboard.hold_open_elsewhere(true);
        ts.shell.save_shortcut_pressed();
        ts.clipboard.hold_open_elsewhere(false);
        assert_eq!(
            captures(&ts)[before]["state"],
            "empty",
            "a clipboard that stayed busy"
        );
        assert_eq!(ts.shell.capture.alive_texts(), 0);
    }

    /// A second press replaces the slot with a new id, wipes the first text at once, and says `changed` only when the
    /// trimmed value differs: the same text again (even with other spaces round it) is not a change.
    #[test]
    fn second_press_replaces_and_marks_changed() {
        let ts = TestShell::new();
        copy_and_press(&ts, COPIED);
        let first = last_id(&ts);
        copy_and_press(&ts, "Other-value-1");
        let second = last_id(&ts);
        assert_ne!(first, second);
        assert_eq!(captures(&ts)[1], value_event(&second, true, None));
        assert_eq!(
            ts.shell.capture.alive_texts(),
            1,
            "the first text was not wiped at once"
        );
        assert_eq!(
            ts.shell.capture_state().map(|e| e.capture_id),
            Some(second.clone())
        );

        copy_and_press(&ts, " Other-value-1\r\n");
        let third = last_id(&ts);
        assert_ne!(second, third, "a new press always gets a new id");
        assert_eq!(captures(&ts)[2], value_event(&third, false, None));
        assert_eq!(ts.shell.capture.alive_texts(), 1);
        assert_eq!(ts.window.forwards(), 3);

        // Nothing waiting before: not a change. A value to nothing, and nothing to a value, is one.
        let ts = TestShell::new();
        copy_and_press(&ts, COPIED);
        assert_eq!(captures(&ts)[0]["changed"], false);
        assert!(ts.clipboard.user_copy_non_text());
        ts.shell.save_shortcut_pressed();
        assert_eq!(captures(&ts)[1]["state"], "empty");
        assert_eq!(captures(&ts)[1]["changed"], true, "the copied value went");
        copy_and_press(&ts, COPIED);
        assert_eq!(captures(&ts)[2]["changed"], true, "a value after nothing");
    }

    /// Only the newest value is held: the one before it is dropped (and wiped) the moment the new one is read.
    #[test]
    fn different_value_dropped_at_once() {
        let ts = TestShell::new();
        copy_and_press(&ts, "First-value-1");
        assert_eq!(ts.shell.capture.alive_texts(), 1);
        copy_and_press(&ts, "Second-value-2");
        assert_eq!(
            ts.shell.capture.alive_texts(),
            1,
            "two copied texts at once"
        );
        assert!(ts.clipboard.user_copy_non_text());
        ts.shell.save_shortcut_pressed();
        assert_eq!(
            ts.shell.capture.alive_texts(),
            0,
            "a text outlived the press that replaced it"
        );
    }

    /// A press carries the vault the earlier capture was handed to into the new one (the page already chose it).
    #[test]
    fn a_second_press_keeps_the_chosen_vault() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        copy_and_press(&ts, COPIED);
        ts.shell.capture_choose(s, g, &last_id(&ts)).unwrap();
        copy_and_press(&ts, "Other-value-1");
        let again = last_id(&ts);
        assert_eq!(
            ts.shell.capture_reveal(&again).unwrap().as_str(),
            "Other-value-1",
            "the new capture lost the chosen vault"
        );
    }

    /// Whatever the clipboard holds, a press never panics and nothing the page is told shows a value.
    #[test]
    fn any_clipboard_text_never_panics_and_never_leaks_a_value() {
        let ts = TestShell::new();
        let pieces = [
            "A=",
            "export ",
            "'",
            "\"",
            "\\",
            "\n",
            "\r\n",
            "\r",
            "#",
            " ",
            "\t",
            "=",
            "$",
            "é",
            "NAME",
            "9",
            "\u{feff}",
            SECRET,
            "A",
            "\0",
            "\u{1f511}",
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
            assert!(ts.clipboard.user_copy(&text));
            ts.shell.save_shortcut_pressed();
        }
        let shown = format!("{:?} {:?}", captures(&ts), ts.shell.capture_state());
        assert!(!shown.contains(SECRET), "a value is in {shown}");
        assert!(ts.shell.capture.alive_texts() <= 1);
    }

    // ---- what empties the slot

    /// Lock all empties the slot and tells the page; so does a lock with no vault open at all (the page gets no `locked`
    /// event then, so `gone` is the only word it has).
    #[test]
    fn lock_all_empties_the_slot() {
        let ts = TestShell::new();
        copy_and_press(&ts, COPIED);
        let id = last_id(&ts);
        let before = captures(&ts).len();
        ts.shell.lock_all();
        assert_emptied(&ts, &id, before);
        assert!(
            ts.events.locked().is_empty(),
            "no vault was open: no `locked` event"
        );
    }

    /// A press whose read is under way when every vault locks keeps nothing and tells nothing: the lock cannot be
    /// undone by a read that began before it.
    #[test]
    fn a_read_in_flight_when_everything_locks_keeps_nothing() {
        let ts = TestShell::new();
        assert!(ts.clipboard.user_copy(COPIED));
        let shell = std::sync::Arc::clone(&ts.shell);
        ts.clipboard.during_next_read(Box::new(move || {
            // The lock is under way (its epoch counted) while the read is still open; its hooks are not waited for here.
            let _ = shell.sessions.revoke_all(LockReason::Manual);
        }));

        ts.shell.save_shortcut_pressed();
        ts.shell.lock_all();

        assert_eq!(
            ts.shell.capture_state(),
            None,
            "a read that began before the lock filled the slot"
        );
        assert_eq!(
            captures(&ts),
            Vec::<Value>::new(),
            "the page was told of a capture the lock took"
        );
        assert_eq!(
            ts.window.forwards(),
            0,
            "the window came forward for nothing"
        );
        assert_eq!(ts.shell.capture.alive_texts(), 0);
    }

    /// A lock's late hook does not empty a capture made after that lock: the slot remembers when it was read.
    #[test]
    fn a_press_after_a_lock_is_not_emptied_by_that_locks_late_hook() {
        let ts = TestShell::new();
        let (reached, wait_for_it) = mpsc::channel::<()>();
        let (release, released) = mpsc::channel::<()>();
        let (reached, released) = (
            std::sync::Mutex::new(reached),
            std::sync::Mutex::new(released),
        );
        // The first lock's hooks run, and this one, added after the slot's own, holds the hook thread there.
        ts.shell.sessions.on_lock(Box::new(move |_, _| {
            let _ = crate::lock(&reached).send(());
            let _ = crate::lock(&released).recv_timeout(GIVE_UP);
        }));
        let _ = ts.shell.sessions.revoke_all(LockReason::Manual);
        wait_for_it.recv_timeout(GIVE_UP).unwrap();
        // A second lock waits behind the first one's hooks; its epoch is counted at once.
        let second = ts.shell.sessions.revoke_all(LockReason::Idle).unwrap();

        copy_and_press(&ts, COPIED);
        let id = last_id(&ts);
        release.send(()).unwrap();
        release.send(()).unwrap();
        second.wait();

        assert_eq!(
            ts.shell.capture_state().map(|e| e.capture_id),
            Some(id),
            "a lock that came before the press emptied it"
        );
        assert_eq!(
            captures(&ts).len(),
            1,
            "a `gone` was sent for a capture still held"
        );
    }

    /// The window's close button locks every vault, and so empties the slot.
    #[test]
    fn closing_window_empties_the_slot() {
        let ts = TestShell::new();
        ts.shell.settings.mark_close_explained().unwrap();
        copy_and_press(&ts, COPIED);
        let id = last_id(&ts);
        let before = captures(&ts).len();
        ts.shell.close_window();
        assert_eq!(ts.window.hides(), 1);
        assert_emptied(&ts, &id, before);
    }

    /// Quit (the app closing) empties the slot, even with no vault open.
    #[test]
    fn quit_empties_the_slot() {
        let ts = TestShell::new();
        copy_and_press(&ts, COPIED);
        let id = last_id(&ts);
        let before = captures(&ts).len();
        ts.shell.shutdown();
        assert_emptied(&ts, &id, before);
    }

    /// Windows locking the PC and going to sleep each empty the slot.
    #[test]
    fn windows_lock_and_sleep_empty_the_slot() {
        for signal in [OsSignal::SessionLocked, OsSignal::Suspending] {
            let ts = TestShell::new();
            copy_and_press(&ts, COPIED);
            let id = last_id(&ts);
            let before = captures(&ts).len();
            ts.shell.autolock.signal(signal);
            wait_until("the signal never emptied the slot", || {
                ts.shell.capture_state().is_none()
            });
            wait_until("no `gone` was sent", || captures(&ts).len() > before);
            assert_emptied(&ts, &id, before);
        }
    }

    /// The idle lock empties the slot with no vault open.
    #[test]
    fn idle_empties_the_slot_with_no_vault_open() {
        let ts = TestShell::new();
        copy_and_press(&ts, COPIED);
        let id = last_id(&ts);
        let before = captures(&ts).len();
        let t0 = ts.clock.now();
        ts.idle.set(Duration::from_secs(300));
        ts.shell.autolock.tick(t0 + Duration::from_secs(300));
        wait_until("idle never emptied the slot", || {
            ts.shell.capture_state().is_none()
        });
        wait_until("no `gone` was sent", || captures(&ts).len() > before);
        assert_emptied(&ts, &id, before);
    }

    /// A lock of the vault the capture was handed to empties it; a lock of another vault, or of a vault before the
    /// capture was handed on, does not.
    #[test]
    fn lock_of_chosen_vault_empties_the_slot() {
        let ts = TestShell::new();
        let (family, gf) = ts.open_vault("Family");
        let (work, gw) = ts.open_vault("Work");
        copy_and_press(&ts, COPIED);
        let id = last_id(&ts);

        ts.shell.sessions.lock(family, LockReason::Manual);
        assert!(
            ts.shell.capture_state().is_some(),
            "a lock before any choice emptied it"
        );

        // Family is locked: it cannot be chosen. Work is.
        assert_eq!(
            ts.shell.capture_choose(family, gf, &id).err(),
            Some(ShellError::Locked)
        );
        ts.shell.capture_choose(work, gw, &id).unwrap();
        let (other, _) = ts.open_vault("Third");
        ts.shell.sessions.lock(other, LockReason::Manual);
        assert!(
            ts.shell.capture_state().is_some(),
            "a lock of another vault emptied it"
        );

        let before = captures(&ts).len();
        ts.shell.sessions.lock(work, LockReason::Manual);
        assert_emptied(&ts, &id, before);
    }

    /// Unlocking a vault empties nothing and tells nothing.
    #[test]
    fn unlock_keeps_the_slot() {
        let ts = TestShell::new();
        copy_and_press(&ts, COPIED);
        let id = last_id(&ts);
        ts.open_vault("Family");
        ts.open_vault("Work");
        assert_eq!(ts.shell.capture_state().map(|e| e.capture_id), Some(id));
        assert_eq!(captures(&ts).len(), 1, "an unlock said something");
    }

    /// Cancel empties the slot and says `gone`; an old id is a quiet no-op that leaves the newer capture alone.
    #[test]
    fn cancel_empties_the_slot() {
        let ts = TestShell::new();
        copy_and_press(&ts, COPIED);
        let old = last_id(&ts);
        copy_and_press(&ts, "Other-value-1");
        let id = last_id(&ts);
        let before = captures(&ts).len();

        ts.shell.capture_cancel(&old);
        assert_eq!(
            ts.shell.capture_state().map(|e| e.capture_id),
            Some(id.clone()),
            "an old id emptied the slot"
        );
        assert_eq!(captures(&ts).len(), before, "an old id said something");

        ts.shell.capture_cancel(&id);
        assert_emptied(&ts, &id, before);
        ts.shell.capture_cancel(&id);
        assert_eq!(
            captures(&ts).len(),
            before + 1,
            "a second cancel said `gone` again"
        );
    }

    /// A save empties the slot and says `gone` (the clipboard clear is `commands::capture`'s own tests).
    #[test]
    fn save_empties_the_slot() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        copy_and_press(&ts, COPIED);
        let id = last_id(&ts);
        let before = captures(&ts).len();
        ts.shell
            .capture_save(s, g, &id, save_what("API_KEY"))
            .unwrap();
        assert_emptied(&ts, &id, before);
    }

    /// Every way the slot empties, one `gone` each, for the capture that was in it and no other.
    #[test]
    fn every_emptying_sends_gone() {
        type Way = (&'static str, fn(&TestShell, &str));
        let ways: [Way; 5] = [
            ("cancel", |ts, id| ts.shell.capture_cancel(id)),
            ("lock all", |ts, _| ts.shell.lock_all()),
            ("close", |ts, _| {
                ts.shell.settings.mark_close_explained().unwrap();
                ts.shell.close_window();
            }),
            ("quit", |ts, _| ts.shell.shutdown()),
            ("a lock of every vault from Windows", |ts, _| {
                ts.shell.autolock.signal(OsSignal::SessionLocked);
                wait_until("the lock never ran", || ts.shell.capture_state().is_none());
            }),
        ];
        for (way, empty_it) in ways {
            let ts = TestShell::new();
            copy_and_press(&ts, COPIED);
            let id = last_id(&ts);
            empty_it(&ts, &id);
            wait_until(way, || captures(&ts).len() == 2);
            assert_eq!(
                captures(&ts),
                [value_event(&id, false, None), gone_event(&id)],
                "{way}"
            );
        }
    }
}
