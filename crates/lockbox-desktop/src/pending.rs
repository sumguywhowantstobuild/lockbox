//! Choices waiting for the user's yes ([`Pending`]), each behind a one-time [`Token`] the confirming command sends
//! back. What waits can be a typed password or an unlocked vault, so a lock of all vaults drops everything here
//! (`Sessions::lock_all`). A pasted `.env`'s values wait here too, tied to their vault, so a lock of that one vault
//! drops them as well (`Pending::drop_env_pastes`, from a lock hook).

use std::fmt;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use lockbox_core::env_file::EnvEntry;
use lockbox_core::ids::VaultId;
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
/// JavaScript keeps every bit). Parsed back only in that exact form.
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
    /// `env_read`'s keys, waiting for `env_save`: the session and generation that read the paste (a save from any other
    /// is refused), and each key read, in the paste's order, its value wiped when dropped. Dropped by the lock of that
    /// one vault too ([`Pending::drop_env_pastes`]), not only by Lock all.
    EnvPaste {
        session: SessionId,
        generation: u64,
        entries: Vec<EnvEntry>,
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
