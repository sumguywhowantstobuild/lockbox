//! Choices waiting for the user's yes ([`Pending`]), each behind a one-time [`Token`] the confirming command sends
//! back. What waits can be a typed password or an unlocked vault, so a lock of all vaults drops everything here
//! (`Sessions::lock_all`). A pasted `.env`'s values wait here too, tied to their vault, so a lock of that one vault
//! drops them as well (`Pending::drop_env_pastes`, from a lock hook).

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
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
    /// The backup picked to be tested (`test_backup_pick`, or a finished backup's own offer), waiting for `test_backup`: its
    /// path, which never goes to the page, and the lock epoch it was held in. Launch-scoped: no session owns it, so a lock
    /// of one vault leaves it, and a lock of all vaults, an idle lock, Windows locking or sleeping, and closing drop it
    /// with the rest ([`Pending::drain`]). Kept through every answer of `test_backup`, each one starting its five minutes
    /// again ([`Pending::use_test_backup`]); dropped by [`Pending::forget_test_backup`]. Holds no secret.
    TestBackup { path: PathBuf, epoch: u64 },
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
    /// The attempts running on a held backup ([`Pending::use_test_backup`]): while any does, it is not swept for being
    /// old. Always 0 for every other choice.
    in_use: u32,
    choice: PendingChoice,
}

/// A held backup an attempt is using: it is not swept for being old while this lives, and its five minutes start again
/// when it is dropped ([`Pending::use_test_backup`]).
pub struct TestBackupUse<'a> {
    pending: &'a Pending,
    token: Token,
    path: PathBuf,
    clock: &'a dyn Fn() -> Instant,
}

impl TestBackupUse<'_> {
    /// The backup's path: never sent to the page.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestBackupUse<'_> {
    fn drop(&mut self) {
        self.pending.end_test_backup(&self.token, (self.clock)());
    }
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

    /// Starts an attempt on the backup held under `token`, which must have been held in lock epoch `epoch` (the current
    /// one): its path is the answer's [`path`](TestBackupUse::path). While the answer lives the backup is in use and no
    /// sweep (the timer's, or any put or take) drops it for being old, however long the attempt runs; when the answer is
    /// dropped its five minutes start again, by `clock`. A forget, a new pick or a lock of all vaults still drops it, in
    /// use or not. `ChoiceExpired` for a token that is not there, was used or dropped, is five minutes old and not in
    /// use, holds another kind of choice or a backup of another epoch, with nothing changed. Never the generic
    /// `NotFound`.
    pub fn use_test_backup<'a>(
        &'a self,
        token: &Token,
        epoch: u64,
        clock: &'a dyn Fn() -> Instant,
    ) -> ShellResult<TestBackupUse<'a>> {
        let now = clock();
        let (answer, expired) = {
            let mut parked = lock(&self.parked);
            let expired = take_expired(&mut parked, now);
            let answer = parked
                .iter_mut()
                .find_map(|p| match &p.choice {
                    PendingChoice::TestBackup { path, epoch: held }
                        if *held == epoch && p.token.matches(token) =>
                    {
                        let path = path.clone();
                        p.until = now + LIFETIME;
                        p.in_use += 1;
                        Some(path)
                    }
                    _ => None,
                })
                .ok_or(ShellError::ChoiceExpired);
            (answer, expired)
        };
        drop(expired);
        answer.map(|path| TestBackupUse {
            pending: self,
            token: Token(token.0.clone()),
            path,
            clock,
        })
    }

    /// The end of an attempt ([`TestBackupUse`] dropped): one less in use, and five minutes from `now`. Nothing for a
    /// choice a forget or a lock has dropped since.
    fn end_test_backup(&self, token: &Token, now: Instant) {
        let mut parked = lock(&self.parked);
        if let Some(p) = parked.iter_mut().find(|p| {
            p.token.matches(token) && matches!(p.choice, PendingChoice::TestBackup { .. })
        }) {
            p.in_use = p.in_use.saturating_sub(1);
            p.until = now + LIFETIME;
        }
    }

    /// Drops the backup held under `token`, and nothing else: a token that is not there, was dropped already, or holds
    /// another kind of choice is left alone, with no error (forgetting is idempotent).
    pub fn forget_test_backup(&self, token: &Token) {
        let gone = {
            let mut parked = lock(&self.parked);
            let found = parked.iter().position(|p| {
                p.token.matches(token) && matches!(p.choice, PendingChoice::TestBackup { .. })
            });
            found.map(|at| parked.swap_remove(at))
        };
        drop(gone);
    }

    fn park_at(&self, choice: PendingChoice, now: Instant) -> (Token, Vec<PendingChoice>) {
        let token = Token::random();
        let mut parked = lock(&self.parked);
        let expired = take_expired(&mut parked, now);
        parked.push(Parked {
            token: Token(token.0.clone()),
            until: now + LIFETIME,
            in_use: 0,
            choice,
        });
        (token, expired)
    }

    /// Like [`put`](Self::put), with the time of the caller's own clock (the shell's, which a test moves).
    pub(crate) fn put_at(&self, choice: PendingChoice, now: Instant) -> Token {
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

/// Takes the expired choices out of `parked`, for the caller to drop after releasing its lock. A held backup an attempt
/// is using is not expired, whatever its age.
fn take_expired(parked: &mut Vec<Parked>, now: Instant) -> Vec<PendingChoice> {
    let (expired, live): (Vec<Parked>, Vec<Parked>) = std::mem::take(parked)
        .into_iter()
        .partition(|p| p.in_use == 0 && p.until <= now);
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

    fn held(epoch: u64) -> PendingChoice {
        PendingChoice::TestBackup {
            path: PathBuf::from("a.lockbox-backup"),
            epoch,
        }
    }

    /// A held backup is used by its own token in the epoch it was held in, and by nothing else: another kind of choice
    /// under the token, a token that is not there and another epoch's choice answer `ChoiceExpired` (never `NotFound`),
    /// and what is parked stays.
    #[test]
    fn a_held_backup_is_used_by_its_token_and_epoch_only() {
        let pending = Pending::default();
        let now = Instant::now();
        let token = pending.put_at(held(3), now);
        let other = pending.put_at(picked(1, 1, &["a"]), now);
        assert_eq!(
            used(&pending, &token, 3, now),
            Ok(PathBuf::from("a.lockbox-backup"))
        );
        assert_eq!(
            used(&pending, &token, 4, now),
            Err(ShellError::ChoiceExpired)
        );
        assert_eq!(
            used(&pending, &other, 3, now),
            Err(ShellError::ChoiceExpired)
        );
        assert_eq!(
            used(&pending, &Token::random(), 3, now),
            Err(ShellError::ChoiceExpired)
        );
        assert_eq!(pending.len(), 2, "nothing was taken");
        assert!(pending.take_at(&token, now).is_ok());
        assert_eq!(
            used(&pending, &token, 3, now),
            Err(ShellError::ChoiceExpired)
        );
    }

    /// One whole attempt on the held backup at `now`: begun and ended at the same moment.
    fn used(pending: &Pending, token: &Token, epoch: u64, now: Instant) -> ShellResult<PathBuf> {
        let clock = || now;
        pending
            .use_test_backup(token, epoch, &clock)
            .map(|attempt| attempt.path().to_path_buf())
    }

    /// Fix round 2: a held backup an attempt is using is not swept, however long the attempt runs (a sweep from the
    /// timer, or any put or take, finds it in use), and its five minutes start again when the attempt ends. Only after
    /// that does it expire. A use that was refused holds nothing.
    #[test]
    fn a_held_backup_in_use_is_not_swept_and_restarts_when_the_attempt_ends() {
        let pending = Pending::default();
        let now = Instant::now();
        let token = pending.put_at(held(1), now);
        let time = std::cell::Cell::new(now);
        let clock = || time.get();

        let attempt = pending.use_test_backup(&token, 1, &clock).unwrap();
        time.set(now + LIFETIME + Duration::from_secs(60));
        pending.sweep_at(time.get());
        assert_eq!(pending.len(), 1, "swept while in use");
        let other = pending.put_at(PendingChoice::Test(None), time.get());
        assert_eq!(pending.len(), 2, "a put swept it while in use");
        assert!(pending.take_at(&other, time.get()).is_ok());
        assert_eq!(pending.len(), 1, "a take swept it while in use");

        time.set(time.get() + Duration::from_secs(60));
        let ended = time.get();
        drop(attempt);
        pending.sweep_at(ended + LIFETIME - Duration::from_secs(1));
        assert_eq!(pending.len(), 1, "five minutes from the end");
        assert_eq!(
            used(
                &pending,
                &token,
                1,
                ended + LIFETIME - Duration::from_secs(1)
            ),
            Ok(PathBuf::from("a.lockbox-backup")),
            "still there to try again"
        );
        let again = ended + LIFETIME - Duration::from_secs(1) + LIFETIME;
        pending.sweep_at(again);
        assert_eq!(pending.len(), 0, "five minutes after the last use");
        assert_eq!(
            used(&pending, &token, 1, again),
            Err(ShellError::ChoiceExpired)
        );

        // A refused use (another epoch) holds nothing: it expires on time.
        let stray = pending.put_at(held(1), again);
        assert!(used(&pending, &stray, 2, again).is_err());
        pending.sweep_at(again + LIFETIME);
        assert_eq!(pending.len(), 0);
    }

    /// Two attempts at once keep the hold until the last one ends.
    #[test]
    fn a_held_backup_stays_while_any_attempt_uses_it() {
        let pending = Pending::default();
        let now = Instant::now();
        let token = pending.put_at(held(1), now);
        let time = std::cell::Cell::new(now);
        let clock = || time.get();
        let first = pending.use_test_backup(&token, 1, &clock).unwrap();
        let second = pending.use_test_backup(&token, 1, &clock).unwrap();
        time.set(now + LIFETIME * 2);
        drop(first);
        time.set(now + LIFETIME * 4);
        pending.sweep_at(time.get());
        assert_eq!(pending.len(), 1, "the second attempt still runs");
        drop(second);
        pending.sweep_at(time.get() + LIFETIME);
        assert_eq!(pending.len(), 0);
    }

    /// Being in use does not keep a choice against a forget or a lock of all vaults, and the attempt's end then
    /// brings nothing back.
    #[test]
    fn a_held_backup_in_use_is_still_forgotten_and_drained() {
        let pending = Pending::default();
        let now = Instant::now();
        let clock = || now;

        let token = pending.put_at(held(1), now);
        let attempt = pending.use_test_backup(&token, 1, &clock).unwrap();
        pending.forget_test_backup(&token);
        assert_eq!(pending.len(), 0);
        drop(attempt);
        assert_eq!(pending.len(), 0, "the end of the attempt brought it back");

        let token = pending.put_at(held(1), now);
        let attempt = pending.use_test_backup(&token, 1, &clock).unwrap();
        drop(pending.drain());
        assert_eq!(pending.len(), 0);
        drop(attempt);
        assert_eq!(
            used(&pending, &token, 1, now),
            Err(ShellError::ChoiceExpired)
        );
    }

    /// Each use starts the five minutes again, so someone retrying passwords is not timed out; one left alone for five
    /// minutes is gone.
    #[test]
    fn a_held_backups_lifetime_restarts_with_each_use() {
        let pending = Pending::default();
        let now = Instant::now();
        let token = pending.put_at(held(1), now);
        let at = now + LIFETIME - Duration::from_secs(1);
        assert!(used(&pending, &token, 1, at).is_ok());
        let later = now + LIFETIME + Duration::from_secs(10);
        assert!(used(&pending, &token, 1, later).is_ok());
        let expired = later + LIFETIME;
        assert_eq!(
            used(&pending, &token, 1, expired),
            Err(ShellError::ChoiceExpired)
        );
        assert_eq!(pending.len(), 0, "an expired one is dropped");
    }

    /// Forgetting drops a held backup and only that: another kind of choice under the token stays, and an unknown or
    /// already-dropped token is nothing to forget, with no error.
    #[test]
    fn forget_test_backup_drops_only_a_held_backup() {
        let pending = Pending::default();
        let now = Instant::now();
        let token = pending.put_at(held(1), now);
        let other = pending.put_at(picked(1, 1, &["a"]), now);
        pending.forget_test_backup(&other);
        assert_eq!(pending.len(), 2);
        pending.forget_test_backup(&token);
        assert_eq!(pending.len(), 1);
        pending.forget_test_backup(&token);
        pending.forget_test_backup(&Token::random());
        assert_eq!(pending.len(), 1);
        assert!(pending.peek_picked(&other, SessionId(1), 1).is_ok());
    }

    /// A lock of one vault leaves a held backup alone (it has no vault); a lock of all vaults drains it with the rest.
    #[test]
    fn locking_one_vault_leaves_a_held_backup_and_draining_drops_it() {
        let pending = Pending::default();
        let token = pending.put(held(1));
        pending.drop_env_pastes(Some(SessionId(1)));
        pending.drop_stored_copies(Some(SessionId(1)));
        pending.drop_picked_files(Some(SessionId(1)));
        let now = Instant::now();
        assert!(used(&pending, &token, 1, now).is_ok());
        drop(pending.drain());
        assert_eq!(
            used(&pending, &token, 1, now),
            Err(ShellError::ChoiceExpired)
        );
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
