//! Choices waiting for the user's yes ([`Pending`]), each behind a one-time [`Token`] the confirming command sends
//! back. What waits can be a typed password or an unlocked vault, so a lock of all vaults drops everything here
//! (`Sessions::lock_all`). A pasted `.env`'s values wait here too, tied to their vault, so a lock of that one vault
//! drops them as well (`Pending::drop_env_pastes`, from a lock hook).

use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use lockbox_core::env_file::EnvEntry;
use lockbox_core::ids::{FileId, ItemId, VaultId};
use lockbox_core::{UnlockReport, Vault};
use serde::de::{self, Deserializer};
use serde::ser::Serializer;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::commands::readable::ReadableJob;
use crate::error::{ShellError, ShellResult};
use crate::lock;
use crate::session::{Location, SessionId};

/// How long a choice waits for its answer.
const LIFETIME: Duration = Duration::from_secs(5 * 60);

/// A one-time confirmation token: 128 random bits from the OS, as 32 lowercase hex characters (a JSON string, so
/// JavaScript keeps every bit). Parsed back only in that exact form. Cloned only to answer with the token a command was
/// given (Pick more keeps its token).
#[derive(Clone)]
pub struct Token(String);

impl Token {
    /// The engine's random ID is exactly this: 16 bytes from the OS random source, written and parsed as 32
    /// lowercase hex characters and nothing else.
    fn random() -> Token {
        Token(VaultId::random().to_hex())
    }

    fn parse(text: String) -> Option<Token> {
        VaultId::from_hex(&text).is_ok().then_some(Token(text))
    }

    /// Compares every byte, whatever the first difference, so the time taken does not tell how much of a guess was
    /// right.
    fn matches(&self, other: &Token) -> bool {
        let (a, b) = (self.0.as_bytes(), other.0.as_bytes());
        a.len() == b.len() && a.iter().zip(b).fold(0, |diff, (x, y)| diff | (x ^ y)) == 0
    }
}

impl Serialize for Token {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Token {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Token::parse(String::deserialize(deserializer)?).ok_or_else(|| de::Error::custom("token"))
    }
}

/// Never shows the token: it is what confirms the choice.
impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Token(..)")
    }
}

/// The names a paste's answer showed Keep both: by place (a live folder, or none), each clashing row's number and the
/// name it would be saved under there. The user's own names: never in an error or a log (R5).
pub type ShownNames = HashMap<Option<ItemId>, HashMap<u32, String>>;

/// What waits in [`Pending`] for the user's answer. Each task adds the variants it needs; a typed password is kept
/// as a `Zeroizing<String>`. No `Debug`: it holds passwords, names and paths (R5).
pub enum PendingChoice {
    /// `create_vault` in a cloud folder, waiting for the user's yes (`Confirm::CloudFolder`): the folder chosen
    /// (canonical, as checked), so the dialog is not shown again, and what the vault is created with.
    CreateVault {
        parent: PathBuf,
        name: String,
        password: Zeroizing<String>,
    },
    /// `recover_vault` after a header changed outside Lockbox (`Confirm::HeaderChanged`): the vault, unlocked with
    /// the recovery key (it holds its `.lock` while it waits), the new password to set once the user accepts, and what
    /// that unlock found, for the answer.
    RecoverVault {
        location: Location,
        vault: Box<Vault>,
        new_password: Zeroizing<String>,
        report: UnlockReport,
    },
    /// `add_existing_vault` of a folder a cloud provider syncs, waiting for the user's yes (`Confirm::CloudFolder`):
    /// the folder chosen (canonical), so the dialog is not shown again.
    AddVault { dir: PathBuf },
    /// `restore_prepare` waiting for a yes (`Confirm::CloudFolder` or `Confirm::NewFolder`): the backup and parent
    /// picked, and the credential typed, so the confirming command neither asks for files again nor lets another
    /// backup in. Boxed: the variant is much larger than the others.
    Restore(Box<crate::restore::RestoreChoice>),
    /// `save_readable` to a cloud folder, waiting for the user's yes (`Confirm::CloudFolder`): the session and
    /// generation that asked (the yes goes on only while that session is still unlocked in that generation, never for
    /// another one), the job, and the destination (its folder canonical, as checked), so the dialog is not shown again.
    Readable {
        session: SessionId,
        generation: u64,
        job: ReadableJob,
        dest: PathBuf,
    },
    /// `save_file_copy` to a cloud folder, waiting for the user's yes (`Confirm::CloudFolder`): the session and generation
    /// that asked (the yes goes on only while that session is still unlocked in that generation), the stored file by its
    /// item and file IDs, and the destination (its folder canonical, as checked), so the dialog is not shown again. It
    /// holds no secret, but it is the vault's: dropped by the lock of that one vault too
    /// ([`Pending::drop_stored_copies`]), not only by Lock all.
    StoredCopy {
        session: SessionId,
        generation: u64,
        id: ItemId,
        file_id: FileId,
        dest: PathBuf,
    },
    /// `env_read`'s keys (or `capture_env`'s), waiting for `env_save`: the session and generation that read the paste (a
    /// save from any other is refused), and each key read, in the paste's order, its value wiped when dropped. Dropped
    /// by the lock of that one vault too ([`Pending::drop_env_pastes`]), not only by Lock all.
    EnvPaste {
        session: SessionId,
        generation: u64,
        entries: Vec<EnvEntry>,
        /// The text the keys were read from, wiped when dropped: what the clipboard is compared with when the save is
        /// asked to clear it afterwards.
        source: Zeroizing<String>,
        /// The name Keep both was shown for each clashing row in each place, so the save can tell that the place has
        /// changed since.
        shown: ShownNames,
    },
    /// The files picked to be added to a vault (`pick_files_to_add`), waiting for `add_files`: the session and generation
    /// that picked them (a command from any other is refused), and their paths in the order picked. The paths never go to
    /// the page. One entry for the whole pick session: Pick more and Remove change the list in place under the same token
    /// and start its five minutes again ([`Pending::update_picked`]); the add takes it once. Dropped by the lock of that
    /// one vault too ([`Pending::drop_picked_files`]), not only by Lock all. Holds no secret.
    PickedFiles {
        session: SessionId,
        generation: u64,
        paths: Vec<PathBuf>,
    },
    /// Tests only: a choice that may hold an unlocked vault, to see it dropped.
    #[cfg(test)]
    Test(Option<Box<lockbox_core::Vault>>),
    /// Tests only: records when it is dropped.
    #[cfg(test)]
    Marker(DropMarker),
}

/// Tests only: sets its flag when dropped.
#[cfg(test)]
pub struct DropMarker(std::sync::Arc<std::sync::atomic::AtomicBool>);

#[cfg(test)]
impl Drop for DropMarker {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// The choices waiting for an answer, each until it is taken, it expires, or every vault locks.
#[derive(Default)]
pub struct Pending {
    parked: Mutex<Vec<Parked>>,
    /// Tests only: run once, right after the next take has removed its choice (with `parked` released), so a test can
    /// lock every vault at exactly that point.
    #[cfg(test)]
    after_take: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

struct Parked {
    token: Token,
    until: Instant,
    choice: PendingChoice,
}

impl Pending {
    /// Parks `choice` and returns the token that takes it back. Expired choices are dropped on the way.
    pub fn put(&self, choice: PendingChoice) -> Token {
        self.put_at(choice, Instant::now())
    }

    /// Takes the choice parked under `token`, once. `NotFound` for a token taken before, expired, or dropped by a
    /// lock. Expired choices are dropped on the way.
    pub fn take(&self, token: &Token) -> ShellResult<PendingChoice> {
        self.take_at(token, Instant::now())
    }

    /// Drops every expired choice: an unlocked vault waiting for a yes holds its key and its `.lock`, so it should
    /// not outlive its five minutes. For a periodic caller (Task 11's idle tick); `put` and `take` sweep too.
    pub fn sweep_expired(&self) {
        self.sweep_at(Instant::now());
    }

    /// Like [`put`](Self::put), for a caller holding the sessions mutex (`Sessions::open`): the expired choices are
    /// handed back, to be dropped once that mutex is released, since one may be a vault.
    pub(crate) fn park(&self, choice: PendingChoice) -> (Token, Vec<PendingChoice>) {
        self.park_at(choice, Instant::now())
    }

    /// Removes every choice, for the caller to drop.
    pub(crate) fn drain(&self) -> Vec<PendingChoice> {
        lock(&self.parked)
            .drain(..)
            .map(|parked| parked.choice)
            .collect()
    }

    /// Drops the pasted keys waiting for `only` (those of every session when `None`), and nothing else here: the lock
    /// hook's work, since a lock of one vault drains nothing of its own. The values are wiped as they drop, after the
    /// mutex is released.
    pub(crate) fn drop_env_pastes(&self, only: Option<SessionId>) {
        let dropped = {
            let mut parked = lock(&self.parked);
            let ours = |p: &Parked| match &p.choice {
                PendingChoice::EnvPaste { session, .. } => {
                    only.is_none_or(|locked| locked == *session)
                }
                _ => false,
            };
            let (gone, kept): (Vec<Parked>, Vec<Parked>) =
                std::mem::take(&mut *parked).into_iter().partition(ours);
            *parked = kept;
            gone
        };
        // Dropped here, with the mutex released: each value is wiped as it goes.
        drop(dropped);
    }

    /// Drops the copies waiting in a cloud folder's question for `only` (those of every session when `None`), and nothing
    /// else here: the lock hook's work, as for the pasted keys.
    pub(crate) fn drop_stored_copies(&self, only: Option<SessionId>) {
        let dropped = {
            let mut parked = lock(&self.parked);
            let ours = |p: &Parked| match &p.choice {
                PendingChoice::StoredCopy { session, .. } => {
                    only.is_none_or(|locked| locked == *session)
                }
                _ => false,
            };
            let (gone, kept): (Vec<Parked>, Vec<Parked>) =
                std::mem::take(&mut *parked).into_iter().partition(ours);
            *parked = kept;
            gone
        };
        drop(dropped);
    }

    /// Drops the files picked for `only` (those of every session when `None`), and nothing else here: the lock hook's work,
    /// as for the pasted keys.
    pub(crate) fn drop_picked_files(&self, only: Option<SessionId>) {
        let dropped = {
            let mut parked = lock(&self.parked);
            let ours = |p: &Parked| match &p.choice {
                PendingChoice::PickedFiles { session, .. } => {
                    only.is_none_or(|locked| locked == *session)
                }
                _ => false,
            };
            let (gone, kept): (Vec<Parked>, Vec<Parked>) =
                std::mem::take(&mut *parked).into_iter().partition(ours);
            *parked = kept;
            gone
        };
        drop(dropped);
    }

    /// Changes the list of picked files parked under `token` in place, for the session and generation that picked it: `f`
    /// is given the paths, and its answer is returned. The token stays, and its five minutes start again. `ChoiceExpired`
    /// for a token that is not there, is another kind of choice, or belongs to another session or generation, with
    /// nothing changed. `f` runs under the table's lock: no slow work in it.
    pub fn update_picked<R>(
        &self,
        token: &Token,
        session: SessionId,
        generation: u64,
        f: impl FnOnce(&mut Vec<PathBuf>) -> ShellResult<R>,
    ) -> ShellResult<R> {
        self.update_picked_at(token, session, generation, Instant::now(), f)
    }

    pub(crate) fn update_picked_at<R>(
        &self,
        token: &Token,
        session: SessionId,
        generation: u64,
        now: Instant,
        f: impl FnOnce(&mut Vec<PathBuf>) -> ShellResult<R>,
    ) -> ShellResult<R> {
        let (answer, expired) = {
            let mut parked = lock(&self.parked);
            let expired = take_expired(&mut parked, now);
            let answer = match find_picked(&mut parked, token, session, generation) {
                Some((until, paths)) => {
                    *until = now + LIFETIME;
                    f(paths)
                }
                None => Err(ShellError::ChoiceExpired),
            };
            (answer, expired)
        };
        drop(expired);
        answer
    }

    /// The paths of the picked files parked under `token`, as [`update_picked`](Self::update_picked) finds them, and
    /// nothing changed (the lifetime included).
    pub fn peek_picked(
        &self,
        token: &Token,
        session: SessionId,
        generation: u64,
    ) -> ShellResult<Vec<PathBuf>> {
        self.peek_picked_at(token, session, generation, Instant::now())
    }

    pub(crate) fn peek_picked_at(
        &self,
        token: &Token,
        session: SessionId,
        generation: u64,
        now: Instant,
    ) -> ShellResult<Vec<PathBuf>> {
        let (answer, expired) = {
            let mut parked = lock(&self.parked);
            let expired = take_expired(&mut parked, now);
            let answer = find_picked(&mut parked, token, session, generation)
                .map(|(_, paths)| paths.clone())
                .ok_or(ShellError::ChoiceExpired);
            (answer, expired)
        };
        drop(expired);
        answer
    }

    /// Takes the picked files parked under `token` for good, once, but only if they are still exactly `checked` (what the
    /// caller measured and checked before the job): a list changed since, a used or expired choice, or another session's
    /// or generation's is `ChoiceExpired`, and what is parked stays.
    pub fn take_picked(
        &self,
        token: &Token,
        session: SessionId,
        generation: u64,
        checked: &[PathBuf],
    ) -> ShellResult<()> {
        self.take_picked_at(token, session, generation, checked, Instant::now())
    }

    pub(crate) fn take_picked_at(
        &self,
        token: &Token,
        session: SessionId,
        generation: u64,
        checked: &[PathBuf],
        now: Instant,
    ) -> ShellResult<()> {
        let (taken, expired) = {
            let mut parked = lock(&self.parked);
            let expired = take_expired(&mut parked, now);
            let found = parked.iter().position(|p| {
                p.token.matches(token)
                    && matches!(&p.choice, PendingChoice::PickedFiles { session: s, generation: g, paths }
                        if *s == session && *g == generation && paths == checked)
            });
            (found.map(|at| parked.swap_remove(at)), expired)
        };
        drop(expired);
        taken.map(drop).ok_or(ShellError::ChoiceExpired)
    }

    fn park_at(&self, choice: PendingChoice, now: Instant) -> (Token, Vec<PendingChoice>) {
        let token = Token::random();
        let mut parked = lock(&self.parked);
        let expired = take_expired(&mut parked, now);
        parked.push(Parked {
            token: Token(token.0.clone()),
            until: now + LIFETIME,
            choice,
        });
        (token, expired)
    }

    fn put_at(&self, choice: PendingChoice, now: Instant) -> Token {
        // The expired choices are dropped here, after the lock is released.
        let (token, _expired) = self.park_at(choice, now);
        token
    }

    /// Like [`take`](Self::take), for a caller holding the sessions mutex (`Sessions::open_choice`): the choice
    /// parked under `token` (`None` for a token taken before, expired, or dropped by a lock) and the expired choices
    /// are handed back, to be dropped (whatever the caller does not keep) once that mutex is released.
    pub(crate) fn claim(&self, token: &Token) -> (Option<PendingChoice>, Vec<PendingChoice>) {
        self.claim_at(token, Instant::now())
    }

    fn claim_at(&self, token: &Token, now: Instant) -> (Option<PendingChoice>, Vec<PendingChoice>) {
        let mut parked = lock(&self.parked);
        let expired = take_expired(&mut parked, now);
        let found = parked
            .iter()
            .position(|p| p.token.matches(token))
            .map(|at| parked.swap_remove(at).choice);
        drop(parked);
        #[cfg(test)]
        self.run_after_take();
        (found, expired)
    }

    fn take_at(&self, token: &Token, now: Instant) -> ShellResult<PendingChoice> {
        let (found, expired) = self.claim_at(token, now);
        // The expired choices close here, with no lock held.
        drop(expired);
        found.ok_or(ShellError::NotFound)
    }

    /// Tests only: runs `hook` once, right after the next take removes its choice.
    #[cfg(test)]
    pub(crate) fn after_take(&self, hook: Box<dyn FnOnce() + Send>) {
        *lock(&self.after_take) = Some(hook);
    }

    #[cfg(test)]
    fn run_after_take(&self) {
        let hook = lock(&self.after_take).take();
        if let Some(hook) = hook {
            hook();
        }
    }

    /// [`sweep_expired`](Self::sweep_expired) at `now`: the auto-lock's tick passes its own time.
    pub(crate) fn sweep_at(&self, now: Instant) {
        let expired = take_expired(&mut lock(&self.parked), now);
        drop(expired);
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        lock(&self.parked).len()
    }
}

/// The picked files parked under `token` for `session` in `generation`: when they expire and their paths. Nothing for a
/// token that is not there, another kind of choice, or another session or generation.
fn find_picked<'a>(
    parked: &'a mut [Parked],
    token: &Token,
    session: SessionId,
    generation: u64,
) -> Option<(&'a mut Instant, &'a mut Vec<PathBuf>)> {
    parked.iter_mut().find_map(|p| match &mut p.choice {
        PendingChoice::PickedFiles {
            session: s,
            generation: g,
            paths,
        } if *s == session && *g == generation && p.token.matches(token) => {
            Some((&mut p.until, paths))
        }
        _ => None,
    })
}

/// Takes the expired choices out of `parked`, for the caller to drop after releasing its lock.
fn take_expired(parked: &mut Vec<Parked>, now: Instant) -> Vec<PendingChoice> {
    let (expired, live): (Vec<Parked>, Vec<Parked>) = std::mem::take(parked)
        .into_iter()
        .partition(|p| p.until <= now);
    *parked = live;
    expired.into_iter().map(|p| p.choice).collect()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    fn marker() -> (Arc<AtomicBool>, PendingChoice) {
        let dropped = Arc::new(AtomicBool::new(false));
        (dropped.clone(), PendingChoice::Marker(DropMarker(dropped)))
    }

    /// Fix round 1: an expired choice (it may hold an unlocked vault and its `.lock`) is dropped by the next put, not
    /// only refused by a take.
    #[test]
    fn expired_choice_dropped_on_next_put() {
        let pending = Pending::default();
        let now = Instant::now();
        let (dropped, choice) = marker();
        pending.put_at(choice, now);
        pending.put_at(
            PendingChoice::Test(None),
            now + LIFETIME - Duration::from_secs(1),
        );
        assert!(!dropped.load(Ordering::SeqCst), "not expired yet");
        pending.put_at(PendingChoice::Test(None), now + LIFETIME);
        assert!(dropped.load(Ordering::SeqCst), "the next put dropped it");
        assert_eq!(pending.len(), 2);
    }

    #[test]
    fn sweep_drops_expired_choices() {
        let pending = Pending::default();
        let now = Instant::now();
        let (dropped, choice) = marker();
        pending.put_at(choice, now);
        pending.sweep_at(now + LIFETIME - Duration::from_secs(1));
        assert!(!dropped.load(Ordering::SeqCst), "not expired yet");
        pending.sweep_at(now + LIFETIME);
        assert!(dropped.load(Ordering::SeqCst), "the sweep dropped it");
        assert_eq!(pending.len(), 0);
    }

    fn paste_of(session: u64) -> PendingChoice {
        PendingChoice::EnvPaste {
            session: SessionId(session),
            generation: 1,
            entries: vec![EnvEntry {
                name: "API_KEY".to_owned(),
                value: Zeroizing::new("made-up-value".to_owned()),
            }],
            source: Zeroizing::new("API_KEY=made-up-value".to_owned()),
            shown: ShownNames::new(),
        }
    }

    /// A lock of one vault drops the pasted keys of that vault and nothing else: another vault's paste and every other
    /// kind of waiting choice stay; a lock of all drops every paste (the choices of other kinds are Lock all's own).
    #[test]
    fn drop_env_pastes_takes_one_sessions_and_only_pastes() {
        let pending = Pending::default();
        let first = pending.put(paste_of(1));
        let second = pending.put(paste_of(2));
        let (dropped, marker) = marker();
        pending.put(marker);

        pending.drop_env_pastes(Some(SessionId(1)));
        assert_eq!(pending.len(), 2);
        assert!(!dropped.load(Ordering::SeqCst), "another kind stays");
        assert!(matches!(pending.take(&first), Err(ShellError::NotFound)));
        assert!(pending.take(&second).is_ok(), "the other session's stays");

        let third = pending.put(paste_of(3));
        pending.drop_env_pastes(None);
        assert_eq!(pending.len(), 1);
        assert!(!dropped.load(Ordering::SeqCst));
        assert!(matches!(pending.take(&third), Err(ShellError::NotFound)));
    }

    fn picked(session: u64, generation: u64, names: &[&str]) -> PendingChoice {
        PendingChoice::PickedFiles {
            session: SessionId(session),
            generation,
            paths: names.iter().map(PathBuf::from).collect(),
        }
    }

    fn paths(names: &[&str]) -> Vec<PathBuf> {
        names.iter().map(PathBuf::from).collect()
    }

    /// Picked files are kept under one token: updating them in place keeps the token, answers `ChoiceExpired` for a token
    /// that is not there or belongs to another session or generation, and changes nothing then.
    #[test]
    fn picked_files_update_in_place_for_their_own_session_only() {
        let pending = Pending::default();
        let now = Instant::now();
        let token = pending.put_at(picked(1, 1, &["a"]), now);
        let added = pending.update_picked_at(&token, SessionId(1), 1, now, |list| {
            list.push(PathBuf::from("b"));
            Ok(list.len())
        });
        assert_eq!(added, Ok(2));
        for (session, generation) in [(2, 1), (1, 2)] {
            let refused =
                pending.update_picked_at(&token, SessionId(session), generation, now, |list| {
                    list.clear();
                    Ok(())
                });
            assert_eq!(refused, Err(ShellError::ChoiceExpired));
        }
        let other = Token::random();
        assert_eq!(
            pending.update_picked_at(&other, SessionId(1), 1, now, |_| Ok(())),
            Err(ShellError::ChoiceExpired)
        );
        assert_eq!(
            pending.peek_picked_at(&token, SessionId(1), 1, now),
            Ok(paths(&["a", "b"]))
        );
        assert_eq!(pending.len(), 1);
        // A choice of another kind is no picked list.
        let test = pending.put_at(PendingChoice::Test(None), now);
        assert_eq!(
            pending.peek_picked_at(&test, SessionId(1), 1, now),
            Err(ShellError::ChoiceExpired)
        );
    }

    /// Updating the list starts its five minutes again; one not touched for five minutes is gone.
    #[test]
    fn picked_files_lifetime_restarts_with_each_update() {
        let pending = Pending::default();
        let now = Instant::now();
        let token = pending.put_at(picked(1, 1, &["a"]), now);
        let at = now + LIFETIME - Duration::from_secs(1);
        pending
            .update_picked_at(&token, SessionId(1), 1, at, |_| Ok(()))
            .unwrap();
        // Past the first five minutes, inside the second's.
        let later = now + LIFETIME + Duration::from_secs(10);
        assert_eq!(
            pending.peek_picked_at(&token, SessionId(1), 1, later),
            Ok(paths(&["a"]))
        );
        let expired = at + LIFETIME;
        assert_eq!(
            pending.update_picked_at(&token, SessionId(1), 1, expired, |_| Ok(())),
            Err(ShellError::ChoiceExpired)
        );
        assert_eq!(pending.len(), 0, "an expired list is dropped");
    }

    /// The list is taken once, and only as it was checked: a changed list, another session's or generation's token, or a
    /// second take is refused, and a refusal leaves what is there.
    #[test]
    fn picked_files_are_taken_once_and_only_as_checked() {
        let pending = Pending::default();
        let now = Instant::now();
        let token = pending.put_at(picked(1, 1, &["a", "b"]), now);
        let checked = paths(&["a", "b"]);
        for (session, generation, list) in [
            (2, 1, checked.clone()),
            (1, 2, checked.clone()),
            (1, 1, paths(&["a"])),
        ] {
            assert_eq!(
                pending.take_picked_at(&token, SessionId(session), generation, &list, now),
                Err(ShellError::ChoiceExpired)
            );
            assert_eq!(pending.len(), 1);
        }
        assert_eq!(
            pending.take_picked_at(&token, SessionId(1), 1, &checked, now),
            Ok(())
        );
        assert_eq!(pending.len(), 0);
        assert_eq!(
            pending.take_picked_at(&token, SessionId(1), 1, &checked, now),
            Err(ShellError::ChoiceExpired)
        );
    }

    /// A lock of one vault drops that vault's picked files and nothing else; a lock of all drops every list.
    #[test]
    fn drop_picked_files_takes_one_sessions_and_only_picks() {
        let pending = Pending::default();
        let first = pending.put(picked(1, 1, &["a"]));
        let second = pending.put(picked(2, 1, &["b"]));
        let (dropped, marker) = marker();
        pending.put(marker);

        pending.drop_picked_files(Some(SessionId(1)));
        assert_eq!(pending.len(), 2);
        assert!(!dropped.load(Ordering::SeqCst), "another kind stays");
        assert!(pending.peek_picked(&first, SessionId(1), 1).is_err());
        assert!(pending.peek_picked(&second, SessionId(2), 1).is_ok());

        pending.drop_picked_files(None);
        assert_eq!(pending.len(), 1);
        assert!(pending.peek_picked(&second, SessionId(2), 1).is_err());
    }

    /// A paste waits five minutes like every other choice.
    #[test]
    fn env_paste_expires_with_the_rest() {
        let pending = Pending::default();
        let now = Instant::now();
        let token = pending.put_at(paste_of(1), now);
        assert_eq!(pending.len(), 1);
        assert!(matches!(
            pending.take_at(&token, now + LIFETIME),
            Err(ShellError::NotFound)
        ));
        assert_eq!(pending.len(), 0, "an expired paste is dropped");
    }

    #[test]
    fn token_expires_after_five_minutes() {
        let pending = Pending::default();
        let now = Instant::now();
        let token = pending.put_at(PendingChoice::Test(None), now);
        assert!(
            pending
                .take_at(&token, now + LIFETIME - Duration::from_secs(1))
                .is_ok()
        );

        let token = pending.put_at(PendingChoice::Test(None), now);
        assert!(matches!(
            pending.take_at(&token, now + LIFETIME),
            Err(ShellError::NotFound)
        ));
        assert_eq!(pending.len(), 0, "an expired choice is dropped");
    }
}
