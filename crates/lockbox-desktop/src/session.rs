//! Open vaults and the locking contract (spec §7.4): each session has a generation, bumped when it locks and when it
//! unlocks again, that every command checks when it starts and again before it answers.
//!
//! The sessions mutex is held only for lookups and state changes: never across vault work, while waiting for a
//! vault's `RwLock`, or while waiting for a publish guard.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{
    Arc, Condvar, Mutex, MutexGuard, PoisonError, RwLock, TryLockError, TryLockResult,
};
use std::time::{Duration, Instant};
use std::{fmt, fs, io, thread};

use lockbox_core::blob::CancelToken;
use lockbox_core::{ReadOnlyVault, Vault};
use serde::{Deserialize, Serialize};

use crate::error::{Confirm, Outcome, ShellError, ShellResult};
use crate::pending::{Pending, PendingChoice, Token};
use crate::{lock, os};

/// How long a short command waits for a vault another command is using, and how often it tries again.
const SHORT_WAIT: Duration = Duration::from_millis(500);
const RETRY: Duration = Duration::from_millis(10);

const BUSY: ShellError = ShellError::Busy {
    what: "operation in progress",
};
const BUSY_OPENING: ShellError = ShellError::Busy { what: "opening" };

/// A session's number: a counter from 1, never reused while the app runs. Like generations (counters from 1 too), it
/// never reaches 2^53, so a JSON number carries it exactly.
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SessionId(pub u64);

/// An answer carrying one session's data, tagged with the generation it was read in: the UI drops it unless that
/// generation is still current (spec §7.4). No `Debug`: the data can be a revealed password (R5).
#[derive(Serialize)]
pub struct Tagged<T> {
    pub session: SessionId,
    pub generation: u64,
    pub data: T,
}

/// Where a session's vault is: a vault folder, or a backup file opened read-only. Canonical (see [`Location::folder`]
/// and [`Location::backup`]) and compared as Windows compares names: ordinal, ignoring case.
#[derive(Clone)]
pub enum Location {
    Folder(PathBuf),
    Backup(PathBuf),
}

impl Location {
    /// The vault folder `dir`, canonicalised.
    pub fn folder(dir: &Path) -> io::Result<Location> {
        fs::canonicalize(dir).map(Location::Folder)
    }

    /// The backup file `file`, canonicalised.
    pub fn backup(file: &Path) -> io::Result<Location> {
        fs::canonicalize(file).map(Location::Backup)
    }

    fn path(&self) -> &Path {
        match self {
            Location::Folder(path) | Location::Backup(path) => path,
        }
    }
}

impl PartialEq for Location {
    fn eq(&self, other: &Location) -> bool {
        let same_kind = matches!(
            (self, other),
            (Location::Folder(_), Location::Folder(_)) | (Location::Backup(_), Location::Backup(_))
        );
        same_kind && os::same_path(self.path(), other.path())
    }
}

/// No `Hash`: it would have to fold case exactly as Windows does, and nothing needs it.
impl Eq for Location {}

/// Never shows the path (R5).
impl fmt::Debug for Location {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Location::Folder(_) => "Location::Folder(..)",
            Location::Backup(_) => "Location::Backup(..)",
        })
    }
}

/// A vault an opening closure hands to [`Sessions::open`].
pub enum Opened {
    Writable(Vault),
    ReadOnly(ReadOnlyVault),
}

/// What [`Sessions::read`] and its kin lend to their closure.
pub enum VaultRef<'a> {
    Writable(&'a Vault),
    ReadOnly(&'a ReadOnlyVault),
}

/// Why a session locked, sent with `lockbox://locked`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LockReason {
    Manual,
    Idle,
    WindowsLocked,
    Sleep,
    DriveGone,
    AppClosing,
    Restore,
}

/// A notice for the UI, sent as `lockbox://notice` `{ kind, .. }`. The launch sweeps and restore recovery add their
/// variants (Tasks 13 to 15).
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Notice {}

/// Tells the UI what changed: the shell's events (`lockbox://locked`, `lockbox://busy`, `lockbox://notice`).
pub trait Notifier: Send + Sync {
    fn locked(&self, session: SessionId, generation: u64, reason: LockReason);
    /// The long operations running for `session`, or for none (`None`: testing or restoring a backup).
    fn busy(&self, session: Option<SessionId>, operations: &[&'static str]);
    fn notice(&self, notice: &Notice);
}

/// What an opening closure gives back: a new session, or a question to ask first, whose state waits in [`Pending`]
/// (`recover_vault`'s changed header). The `fn` builds the question from the new token.
// Returned once per open and unpacked straight away: boxing the vault would only add an allocation.
#[allow(clippy::large_enum_variant)]
pub enum OpenStep<X> {
    Session(Location, Opened, X),
    Ask(PendingChoice, fn(Token) -> Confirm),
}

/// What [`Sessions::open`] answers: `Outcome<Tagged<(SessionInfo, Option<X>)>>`, the session and `X` when the
/// opening closure ran, or its question.
pub type OpenAnswer<X> = Outcome<Tagged<(SessionInfo, Option<X>)>>;

/// One session as the UI lists it.
#[derive(Clone, Serialize)]
pub struct SessionInfo {
    pub session: SessionId,
    pub generation: u64,
    pub name: String,
    pub read_only: bool,
    pub state: SessionState,
}

/// Never shows the vault's name (R5).
impl fmt::Debug for SessionInfo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionInfo")
            .field("session", &self.session)
            .field("generation", &self.generation)
            .field("read_only", &self.read_only)
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Unlocked,
    Locked,
    /// Locked because its drive went away (spec §6.10).
    Unavailable,
}

/// A hook run after every lock, with the session that locked (`None`: all of them).
pub type LockHook = Box<dyn Fn(Option<SessionId>, LockReason) + Send + Sync>;

/// An unlocked session's vault. The session holds one reference and each running command another; the last to let
/// go drops the vault (key wiped, `.lock` released).
#[derive(Clone)]
enum Handle {
    Writable(Arc<Held<RwLock<Vault>>>),
    ReadOnly(Arc<Held<ReadOnlyVault>>),
}

impl Handle {
    /// The vault a change writes to: `ReadOnly` for a read-only session.
    fn writable(&self) -> ShellResult<&RwLock<Vault>> {
        match self {
            Handle::Writable(held) => Ok(&held.vault),
            Handle::ReadOnly(_) => Err(ShellError::ReadOnly),
        }
    }

    /// The vault a two-session operation copies from, which is always a read-only one.
    fn read_only(&self) -> ShellResult<&ReadOnlyVault> {
        match self {
            Handle::ReadOnly(held) => Ok(&held.vault),
            Handle::Writable(_) => Err(ShellError::InvalidInput {
                what: "source vault",
            }),
        }
    }
}

/// A vault, counted among its session's [`Vaults`] until it is dropped. Fields drop in order, so the vault goes
/// before the count does.
struct Held<T> {
    vault: T,
    _counted: Counted,
}

/// One vault of a session, counted from when it becomes the session's until it is dropped.
struct Counted(Arc<Vaults>);

impl Counted {
    fn new(vaults: &Arc<Vaults>) -> Counted {
        *lock(&vaults.alive) += 1;
        Counted(Arc::clone(vaults))
    }
}

impl Drop for Counted {
    fn drop(&mut self) {
        *lock(&self.0.alive) -= 1;
        self.0.dropped.notify_all();
    }
}

/// How many of a session's vaults are still alive, from every time it was unlocked: a command started in an earlier
/// generation may still hold that generation's vault ([`Sessions::release_wait`]).
#[derive(Default)]
struct Vaults {
    alive: Mutex<usize>,
    dropped: Condvar,
}

impl Vaults {
    /// Waits up to `max` for none to be alive.
    fn wait_none(&self, max: Duration) -> bool {
        let alive = lock(&self.alive);
        let (alive, _) = self
            .dropped
            .wait_timeout_while(alive, max, |alive| *alive > 0)
            .unwrap_or_else(PoisonError::into_inner);
        *alive == 0
    }
}

/// What a session's checks share outside the sessions mutex.
#[derive(Default)]
struct Gate {
    /// Bumped, under the sessions mutex, by every lock and every unlock.
    generation: AtomicU64,
    /// Held for one publish attempt (a rename or a clipboard write). A lock passes it once, after the bump.
    publish: Mutex<()>,
}

impl Gate {
    fn is(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }
}

/// One session, unlocked or locked. Sessions stay listed once locked, so unlocking the same location again keeps
/// its number and moves its generation on.
struct Entry {
    id: SessionId,
    location: Location,
    name: String,
    read_only: bool,
    state: SessionState,
    gate: Arc<Gate>,
    /// `Some` while unlocked.
    live: Option<Live>,
    /// Every vault this session has held that is not dropped yet.
    vaults: Arc<Vaults>,
}

impl Entry {
    fn info(&self) -> SessionInfo {
        SessionInfo {
            session: self.id,
            generation: self.gate.generation.load(Ordering::SeqCst),
            name: self.name.clone(),
            read_only: self.read_only,
            state: self.state,
        }
    }
}

/// What a lock takes from an unlocked session.
struct Live {
    handle: Handle,
    cancel: CancelToken,
    /// The tokens of the two-session operations ([`Sessions::read_write`]) using this session, by link number.
    linked: Vec<(u64, CancelToken)>,
}

/// An open under way: a lock of all vaults cancels it, and a second open of its location is busy.
struct Opening {
    id: u64,
    location: Option<Location>,
    cancel: CancelToken,
}

/// What a command holds while it runs.
struct Lease {
    handle: Handle,
    cancel: CancelToken,
    gate: Arc<Gate>,
}

impl Lease {
    /// Lets go of the vault, then checks the generation once more: whatever `result` is, nothing read before a lock
    /// is returned after it.
    fn answer<T>(
        self,
        id: SessionId,
        generation: u64,
        result: ShellResult<T>,
        change: Option<&'static str>,
    ) -> ShellResult<Tagged<T>> {
        let Lease { handle, gate, .. } = self;
        drop(handle);
        if !gate.is(generation) {
            return Err(overtaken(&result, change));
        }
        result.map(|data| Tagged {
            session: id,
            generation,
            data,
        })
    }
}

/// The answer for work a lock overtook: `LockedAfterChange` when it was a change (`what`) that went through, else
/// `Locked`.
fn overtaken<T>(result: &ShellResult<T>, change: Option<&'static str>) -> ShellError {
    match (result, change) {
        (Ok(_), Some(what)) => ShellError::LockedAfterChange { what },
        _ => ShellError::Locked,
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Wait {
    /// Short commands: try again every 10 ms for up to 500 ms.
    Short,
    /// Long operations: busy at once.
    Long,
}

/// Takes a vault's `RwLock` (`try_lock`) as `wait` says. A lock while waiting means the command never starts.
fn wait_for<G>(
    wait: Wait,
    gate: &Gate,
    generation: u64,
    mut try_lock: impl FnMut() -> TryLockResult<G>,
) -> ShellResult<G> {
    let deadline = Instant::now() + SHORT_WAIT;
    let guard = loop {
        match try_lock() {
            Ok(guard) => break guard,
            // A command that panicked: the engine writes each change to disk before it changes its memory.
            Err(TryLockError::Poisoned(poisoned)) => break poisoned.into_inner(),
            Err(TryLockError::WouldBlock) => {}
        }
        if !gate.is(generation) {
            return Err(ShellError::Locked);
        }
        if wait == Wait::Long || Instant::now() >= deadline {
            return Err(BUSY);
        }
        thread::sleep(RETRY);
    };
    if !gate.is(generation) {
        return Err(ShellError::Locked);
    }
    Ok(guard)
}

#[derive(Default)]
struct Inner {
    sessions: Vec<Entry>,
    opening: Vec<Opening>,
    /// Bumped by every lock of all vaults: an open that started before one discards what it made.
    epoch: u64,
    last_session: u64,
    /// Numbers opens and two-session links.
    last_serial: u64,
}

impl Inner {
    fn serial(&mut self) -> u64 {
        self.last_serial += 1;
        self.last_serial
    }

    /// The session `id`, unlocked in `generation`: its gate and what a lock takes.
    fn live(&mut self, id: SessionId, generation: u64) -> ShellResult<(&Arc<Gate>, &mut Live)> {
        let entry = self
            .sessions
            .iter_mut()
            .find(|entry| entry.id == id)
            .ok_or(ShellError::NotFound)?;
        match &mut entry.live {
            Some(live) if entry.gate.is(generation) => Ok((&entry.gate, live)),
            _ => Err(ShellError::Locked),
        }
    }

    fn lease(&mut self, id: SessionId, generation: u64) -> ShellResult<Lease> {
        let (gate, live) = self.live(id, generation)?;
        Ok(Lease {
            handle: live.handle.clone(),
            cancel: live.cancel.clone(),
            gate: Arc::clone(gate),
        })
    }

    fn unlocked_at(&self, location: &Location) -> Option<&Entry> {
        self.sessions
            .iter()
            .find(|entry| entry.live.is_some() && entry.location == *location)
    }

    /// Makes `opened` the unlocked session at `location`: the session that was there before, unlocked again with
    /// the next generation, or a new one at generation 1.
    fn insert(&mut self, location: Location, opened: Opened) -> SessionInfo {
        let at = match self.sessions.iter().position(|e| e.location == location) {
            Some(at) => at,
            None => {
                self.last_session += 1;
                self.sessions.push(Entry {
                    id: SessionId(self.last_session),
                    location,
                    name: String::new(),
                    read_only: false,
                    state: SessionState::Locked,
                    gate: Arc::default(),
                    live: None,
                    vaults: Arc::default(),
                });
                self.sessions.len() - 1
            }
        };
        let entry = &mut self.sessions[at];
        let counted = Counted::new(&entry.vaults);
        let (name, read_only, handle) = match opened {
            Opened::Writable(vault) => (
                vault.name().to_owned(),
                false,
                Handle::Writable(Arc::new(Held {
                    vault: RwLock::new(vault),
                    _counted: counted,
                })),
            ),
            Opened::ReadOnly(vault) => (
                vault.name().to_owned(),
                true,
                Handle::ReadOnly(Arc::new(Held {
                    vault,
                    _counted: counted,
                })),
            ),
        };
        entry.gate.generation.fetch_add(1, Ordering::SeqCst);
        entry.name = name;
        entry.read_only = read_only;
        entry.state = SessionState::Unlocked;
        entry.live = Some(Live {
            handle,
            cancel: CancelToken::new(),
            linked: Vec::new(),
        });
        entry.info()
    }
}

/// Takes an open off the list when it ends, also when its closure panicked.
struct OpeningGuard<'a> {
    sessions: &'a Sessions,
    id: u64,
    done: bool,
}

impl OpeningGuard<'_> {
    /// Takes it off under the caller's lock, in the same step that publishes what it made.
    fn finish(&mut self, inner: &mut Inner) {
        inner.opening.retain(|opening| opening.id != self.id);
        self.done = true;
    }
}

impl Drop for OpeningGuard<'_> {
    fn drop(&mut self) {
        if !self.done {
            let mut inner = self.sessions.inner();
            self.finish(&mut inner);
        }
    }
}

/// Takes a two-session operation's token off both sessions when it ends.
struct Unlink<'a> {
    sessions: &'a Sessions,
    link: u64,
    ids: [SessionId; 2],
}

impl Drop for Unlink<'_> {
    fn drop(&mut self) {
        let mut inner = self.sessions.inner();
        for entry in inner.sessions.iter_mut() {
            if let (true, Some(live)) = (self.ids.contains(&entry.id), &mut entry.live) {
                live.linked.retain(|(link, _)| *link != self.link);
            }
        }
    }
}

/// What lock step (1) took from one session, for the steps after it.
struct Locking {
    id: SessionId,
    generation: u64,
    gate: Arc<Gate>,
    live: Live,
}

fn tag_info<X>(info: SessionInfo, x: Option<X>) -> Tagged<(SessionInfo, Option<X>)> {
    Tagged {
        session: info.session,
        generation: info.generation,
        data: (info, x),
    }
}

/// Every session, unlocked or locked, and the rules of §7.4.
///
/// Lock order: `transitions`, then the sessions mutex, then (briefly, inside) [`Pending`]'s. A lock hook or a
/// publish closure must never call [`lock`](Self::lock), [`lock_all`](Self::lock_all) or [`open`](Self::open): it
/// runs while a lock (or the lock waiting for it) holds `transitions`, so it would wait for itself.
pub struct Sessions {
    /// Held by each lock for all five steps, and by an open while it publishes what it made: lock transitions
    /// happen one at a time, never interleaved. Never held while an opening closure runs.
    transitions: Mutex<()>,
    inner: Mutex<Inner>,
    notifier: Arc<dyn Notifier>,
    hooks: RwLock<Vec<LockHook>>,
    pending: Pending,
    /// Tests only: how many lock calls found `transitions` held and had to wait their turn, so a test can tell that a
    /// second lock is really waiting for the first, not merely late.
    #[cfg(test)]
    locks_waited: std::sync::atomic::AtomicUsize,
}

impl Sessions {
    pub fn new(notifier: Arc<dyn Notifier>) -> Self {
        Sessions {
            transitions: Mutex::default(),
            inner: Mutex::default(),
            notifier,
            hooks: RwLock::default(),
            pending: Pending::default(),
            #[cfg(test)]
            locks_waited: Default::default(),
        }
    }

    /// The choices waiting for the user's yes. [`lock_all`](Self::lock_all) drops them all.
    pub fn pending(&self) -> &Pending {
        &self.pending
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        lock(&self.inner)
    }

    /// Opens a session with `open`, which unlocks or opens the vault (or asks first). With `Some(location)`, an
    /// unlocked session there is answered as it is, without running `open` (`Done` with `None`), and an open of that
    /// location already under way answers `Busy`. A lock of all vaults while `open` runs cancels its token and
    /// discards what it made, a vault or a choice to park: `Locked`, or `LockedAfterChange` when `what` names the
    /// change `open` made on disk and it gave back a session (a question means the change was not made).
    pub fn open<X>(
        &self,
        location: Option<Location>,
        what: Option<&'static str>,
        open: impl FnOnce(&CancelToken) -> ShellResult<OpenStep<X>>,
    ) -> ShellResult<OpenAnswer<X>> {
        let (id, epoch, cancel) = {
            let mut inner = self.inner();
            if let Some(location) = &location {
                if let Some(entry) = inner.unlocked_at(location) {
                    return Ok(Outcome::Done(tag_info(entry.info(), None)));
                }
                if inner
                    .opening
                    .iter()
                    .any(|opening| opening.location.as_ref() == Some(location))
                {
                    return Err(BUSY_OPENING);
                }
            }
            let id = inner.serial();
            let cancel = CancelToken::new();
            inner.opening.push(Opening {
                id,
                location,
                cancel: cancel.clone(),
            });
            (id, inner.epoch, cancel)
        };
        let mut opening = OpeningGuard {
            sessions: self,
            id,
            done: false,
        };
        let step = open(&cancel);

        // Publishing what the open made waits for a lock under way to finish, so it never lands between that lock's
        // steps.
        let turn = lock(&self.transitions);
        let mut inner = self.inner();
        opening.finish(&mut inner);
        if inner.epoch != epoch {
            // A discarded vault closes after both locks are released.
            drop(inner);
            drop(turn);
            // Only a new session means `what` was done: a question changes nothing.
            let made = match &step {
                Ok(OpenStep::Session(..)) => Ok(()),
                _ => Err(ShellError::Locked),
            };
            return Err(overtaken(&made, what));
        }
        match step? {
            OpenStep::Ask(choice, confirm) => {
                let (token, expired) = self.pending.park(choice);
                drop(inner);
                drop(turn);
                drop(expired);
                Ok(Outcome::Confirm(confirm(token)))
            }
            OpenStep::Session(location, opened, x) => {
                // Only an open without a location can race another open of the same place.
                if inner.unlocked_at(&location).is_some() {
                    drop(inner);
                    drop(turn);
                    return Err(BUSY_OPENING);
                }
                let info = inner.insert(location, opened);
                Ok(Outcome::Done(tag_info(info, Some(x))))
            }
        }
    }

    /// A short read: waits up to 500 ms for a command using the vault, then `Busy`.
    pub fn read<T>(
        &self,
        id: SessionId,
        generation: u64,
        f: impl FnOnce(VaultRef<'_>, &CancelToken) -> ShellResult<T>,
    ) -> ShellResult<Tagged<T>> {
        self.read_with(id, generation, Wait::Short, f)
    }

    /// A short change: waits up to 500 ms for a command using the vault, then `Busy`.
    pub fn write<T>(
        &self,
        id: SessionId,
        generation: u64,
        f: impl FnOnce(&mut Vault, &CancelToken) -> ShellResult<T>,
    ) -> ShellResult<Tagged<T>> {
        self.write_with(id, generation, Wait::Short, None, f)
    }

    /// A long read (a backup, Save a copy, Open): `Busy` at once while a change runs.
    pub fn read_long<T>(
        &self,
        id: SessionId,
        generation: u64,
        f: impl FnOnce(VaultRef<'_>, &CancelToken) -> ShellResult<T>,
    ) -> ShellResult<Tagged<T>> {
        self.read_with(id, generation, Wait::Long, f)
    }

    /// A long change (an import): `Busy` at once while another command uses the vault.
    pub fn write_long<T>(
        &self,
        id: SessionId,
        generation: u64,
        f: impl FnOnce(&mut Vault, &CancelToken) -> ShellResult<T>,
    ) -> ShellResult<Tagged<T>> {
        self.write_with(id, generation, Wait::Long, None, f)
    }

    /// Like [`write`](Self::write), for a change the user must hear about even when a lock overtakes its answer (a
    /// new password or recovery key): `LockedAfterChange { what }` when `f` succeeded.
    pub fn write_change<T>(
        &self,
        id: SessionId,
        generation: u64,
        what: &'static str,
        f: impl FnOnce(&mut Vault, &CancelToken) -> ShellResult<T>,
    ) -> ShellResult<Tagged<T>> {
        self.write_with(id, generation, Wait::Short, Some(what), f)
    }

    fn read_with<T>(
        &self,
        id: SessionId,
        generation: u64,
        wait: Wait,
        f: impl FnOnce(VaultRef<'_>, &CancelToken) -> ShellResult<T>,
    ) -> ShellResult<Tagged<T>> {
        let lease = self.inner().lease(id, generation)?;
        let result = match &lease.handle {
            Handle::ReadOnly(held) => f(VaultRef::ReadOnly(&held.vault), &lease.cancel),
            Handle::Writable(held) => {
                let vault = wait_for(wait, &lease.gate, generation, || held.vault.try_read())?;
                f(VaultRef::Writable(&vault), &lease.cancel)
            }
        };
        lease.answer(id, generation, result, None)
    }

    fn write_with<T>(
        &self,
        id: SessionId,
        generation: u64,
        wait: Wait,
        change: Option<&'static str>,
        f: impl FnOnce(&mut Vault, &CancelToken) -> ShellResult<T>,
    ) -> ShellResult<Tagged<T>> {
        let lease = self.inner().lease(id, generation)?;
        let held = lease.handle.writable()?;
        let result = {
            let mut vault = wait_for(wait, &lease.gate, generation, || held.try_write())?;
            f(&mut vault, &lease.cancel)
        };
        lease.answer(id, generation, result, change)
    }

    /// A long operation from the read-only session `from` into the writable session `to` (copying an item out of a
    /// backup). `f` gets a token of its own, cancelled when either session locks; both generations are checked again
    /// before the answer, which is tagged with `to`'s.
    pub fn read_write<T>(
        &self,
        from: SessionId,
        from_generation: u64,
        to: SessionId,
        to_generation: u64,
        f: impl FnOnce(&ReadOnlyVault, &mut Vault, &CancelToken) -> ShellResult<T>,
    ) -> ShellResult<Tagged<T>> {
        let cancel = CancelToken::new();
        let (source, destination, link) = {
            let mut inner = self.inner();
            let source = inner.lease(from, from_generation)?;
            let destination = inner.lease(to, to_generation)?;
            destination.handle.writable()?;
            source.handle.read_only()?;
            // Both checked in this same step, so neither registration below can fail half-way.
            let link = inner.serial();
            for (id, generation) in [(from, from_generation), (to, to_generation)] {
                inner
                    .live(id, generation)?
                    .1
                    .linked
                    .push((link, cancel.clone()));
            }
            (source, destination, link)
        };
        let _unlink = Unlink {
            sessions: self,
            link,
            ids: [from, to],
        };
        let result = {
            let (from_vault, to_vault) =
                (source.handle.read_only()?, destination.handle.writable()?);
            let mut vault = wait_for(Wait::Long, &destination.gate, to_generation, || {
                to_vault.try_write()
            })?;
            f(from_vault, &mut vault, &cancel)
        };
        let Lease { handle, gate, .. } = source;
        drop(handle);
        let answer = destination.answer(to, to_generation, result, None);
        if !gate.is(from_generation) {
            return Err(ShellError::Locked);
        }
        answer
    }

    /// One publish attempt (a rename or a clipboard write): under that session's publish guard, never the sessions
    /// mutex, so a lock waits for this one attempt at most and never for its retries. `f` runs only while the
    /// session is still unlocked in `generation`; it must not lock or open a session.
    pub fn publish<T>(
        &self,
        id: SessionId,
        generation: u64,
        f: impl FnOnce() -> ShellResult<T>,
    ) -> ShellResult<T> {
        let gate = Arc::clone(self.inner().live(id, generation)?.0);
        let _attempt = lock(&gate.publish);
        if !gate.is(generation) {
            return Err(ShellError::Locked);
        }
        f()
    }

    /// Locks one session; nothing happens if it is not unlocked.
    pub fn lock(&self, id: SessionId, reason: LockReason) {
        self.lock_where(Some(id), reason);
    }

    /// Locks every session, cancels every open under way, and drops every pending choice.
    pub fn lock_all(&self, reason: LockReason) {
        self.lock_where(None, reason);
    }

    /// Takes `transitions` for a lock, waiting while another lock (or an open publishing) holds it.
    fn lock_turn(&self) -> MutexGuard<'_, ()> {
        match self.transitions.try_lock() {
            Ok(turn) => turn,
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(TryLockError::WouldBlock) => {
                #[cfg(test)]
                self.locks_waited.fetch_add(1, Ordering::SeqCst);
                lock(&self.transitions)
            }
        }
    }

    /// The steps of §7.4, in order.
    fn lock_where(&self, only: Option<SessionId>, reason: LockReason) {
        // One lock at a time, all five steps: a second lock waits for the first to finish, so it never finds a session
        // half-locked (already taken in step 1, its publish attempt not yet over) and returns, hooks run, too early.
        let _turn = self.lock_turn();
        // (1) Under the sessions mutex: the state, the generation, and everything a lock takes away...
        let (locked, opening, pending) = {
            let mut inner = self.inner();
            let (opening, pending) = match only {
                Some(_) => (Vec::new(), Vec::new()),
                None => {
                    inner.epoch += 1;
                    let opening: Vec<CancelToken> =
                        inner.opening.iter().map(|o| o.cancel.clone()).collect();
                    (opening, self.pending.drain())
                }
            };
            let state = match reason {
                LockReason::DriveGone => SessionState::Unavailable,
                _ => SessionState::Locked,
            };
            let locked: Vec<Locking> = inner
                .sessions
                .iter_mut()
                .filter(|entry| only.is_none_or(|id| entry.id == id))
                .filter_map(|entry| {
                    let live = entry.live.take()?;
                    entry.state = state;
                    let generation = entry.gate.generation.fetch_add(1, Ordering::SeqCst) + 1;
                    Some(Locking {
                        id: entry.id,
                        generation,
                        gate: Arc::clone(&entry.gate),
                        live,
                    })
                })
                .collect();
            (locked, opening, pending)
        };
        if only.is_some() && locked.is_empty() {
            return;
        }
        // ...then each publish guard once, so an attempt that saw the old generation has finished.
        for session in &locked {
            drop(lock(&session.gate.publish));
        }
        // (2) Cancel what runs.
        for cancel in &opening {
            cancel.cancel();
        }
        for session in &locked {
            session.live.cancel.cancel();
            for (_, cancel) in &session.live.linked {
                cancel.cancel();
            }
        }
        // (3) Let go of the vaults (the last holder of each drops it: key wiped, `.lock` released) and of every
        // pending choice.
        let notices: Vec<(SessionId, u64)> = locked
            .into_iter()
            .map(|session| (session.id, session.generation))
            .collect();
        drop(pending);
        // (4) Tell the UI.
        for (id, generation) in notices {
            self.notifier.locked(id, generation, reason);
        }
        // (5) The hooks, in the order they were added (the clipboard's first).
        for hook in self
            .hooks
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
        {
            hook(only, reason);
        }
    }

    /// Adds a hook that runs after every lock, after those added before it. It must not lock or open a session.
    pub fn on_lock(&self, hook: LockHook) {
        self.hooks
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .push(hook);
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        self.inner().sessions.iter().map(Entry::info).collect()
    }

    /// Waits up to `max` for every vault the locked session `id` has held to drop, those of earlier unlocks that a
    /// command still holds included. True once they have (or when there is no such session), false while the
    /// session is unlocked or something still holds one.
    pub fn release_wait(&self, id: SessionId, max: Duration) -> bool {
        let vaults = {
            let inner = self.inner();
            match inner.sessions.iter().find(|entry| entry.id == id) {
                None => return true,
                Some(entry) if entry.live.is_some() => return false,
                Some(entry) => Arc::clone(&entry.vaults),
            }
        };
        vaults.wait_none(max)
    }

    /// Each unlocked session and its location.
    pub fn locations(&self) -> Vec<(SessionId, Location)> {
        self.inner()
            .sessions
            .iter()
            .filter(|entry| entry.live.is_some())
            .map(|entry| (entry.id, entry.location.clone()))
            .collect()
    }

    /// The unlocked session at `location`.
    pub fn find(&self, location: &Location) -> Option<SessionId> {
        self.inner().unlocked_at(location).map(|entry| entry.id)
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Condvar, Mutex, OnceLock, PoisonError};
    use std::thread;
    use std::time::Instant;

    use lockbox_core::Credential;
    use lockbox_core::blob::NoJournal;
    use lockbox_core::internals::fsio::testutil::TempDir;
    use lockbox_core::internals::lockfile::VaultLock;
    use serde_json::json;

    use super::*;
    use crate::error::ShellError;
    use crate::lock;
    use crate::testing::{heavy, quiet};

    const PW: &str = "correct horse battery";
    /// How long a test thread waits for the other one before it fails instead of hanging. Generous: a vault created
    /// before a meeting point can take many seconds while every other test derives keys too.
    const GIVE_UP: Duration = Duration::from_secs(60);

    /// Where two threads meet, like a two-party `Barrier`, but one that gives up after [`GIVE_UP`]: a test whose
    /// other thread failed then fails too, instead of hanging.
    #[derive(Default)]
    struct Meet {
        /// How many meetings are over, and whether one thread is already waiting.
        state: Mutex<(u64, bool)>,
        met: Condvar,
    }

    impl Meet {
        fn wait(&self) {
            let mut state = lock(&self.state);
            let (round, waiting) = *state;
            if waiting {
                *state = (round + 1, false);
                self.met.notify_all();
                return;
            }
            state.1 = true;
            let (_state, waited) = self
                .met
                .wait_timeout_while(state, GIVE_UP, |state| state.0 == round)
                .unwrap_or_else(PoisonError::into_inner);
            assert!(!waited.timed_out(), "the other thread never came");
        }
    }

    /// Records each `locked` notice.
    #[derive(Default)]
    struct Recorder {
        locked: Mutex<Vec<(SessionId, u64, LockReason)>>,
    }

    impl Notifier for Recorder {
        fn locked(&self, session: SessionId, generation: u64, reason: LockReason) {
            lock(&self.locked).push((session, generation, reason));
        }
        fn busy(&self, _session: Option<SessionId>, _operations: &[&'static str]) {}
        fn notice(&self, _notice: &Notice) {}
    }

    fn sessions() -> (Arc<Recorder>, Sessions) {
        let recorder = Arc::new(Recorder::default());
        (recorder.clone(), Sessions::new(recorder))
    }

    /// A new vault named "Family" in `parent`, open.
    fn create(parent: &Path) -> Vault {
        heavy(|| Vault::create(parent, "Family", PW).unwrap().vault)
    }

    /// A new vault in `parent`, closed again: its folder.
    fn create_closed(parent: &Path) -> PathBuf {
        create(parent).dir().to_path_buf()
    }

    fn unlock(dir: &Path) -> lockbox_core::Result<Vault> {
        heavy(|| Vault::unlock_with_password(dir, PW)).map(|(vault, _)| vault)
    }

    fn open_read_only_vault(dir: &Path) -> ReadOnlyVault {
        heavy(|| ReadOnlyVault::open_folder(dir, Credential::Password(PW), &CancelToken::new()))
            .unwrap()
    }

    /// Opens `opened` as the session at `location`: its id and generation.
    fn open_as(sessions: &Sessions, location: Location, opened: Opened) -> (SessionId, u64) {
        let answer = sessions.open(Some(location.clone()), None, |_| {
            Ok(OpenStep::Session(location, opened, ()))
        });
        let Ok(Outcome::Done(tagged)) = answer else {
            panic!("the session did not open");
        };
        (tagged.session, tagged.generation)
    }

    /// A new vault in `parent`, open as a writable session: its id, generation and folder.
    fn open_writable(sessions: &Sessions, parent: &Path) -> (SessionId, u64, PathBuf) {
        let vault = create(parent);
        let dir = vault.dir().to_path_buf();
        let location = Location::folder(&dir).unwrap();
        let (id, generation) = open_as(sessions, location, Opened::Writable(vault));
        (id, generation, dir)
    }

    /// The vault folder `dir` as a read-only session.
    fn open_read_only(sessions: &Sessions, dir: &Path) -> (SessionId, u64) {
        let location = Location::folder(dir).unwrap();
        open_as(
            sessions,
            location,
            Opened::ReadOnly(open_read_only_vault(dir)),
        )
    }

    /// Copies a vault folder, leaving out the `.lock` a live vault holds.
    fn copy_folder(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for entry in fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_folder(&entry.path(), &target);
            } else if entry.file_name() != ".lock" {
                fs::copy(entry.path(), target).unwrap();
            }
        }
    }

    /// Whether nothing holds the vault in `dir` (its key is dropped with it): its `.lock` is free.
    fn is_free(dir: &Path) -> bool {
        VaultLock::acquire(dir).is_ok()
    }

    fn state(sessions: &Sessions, id: SessionId) -> SessionState {
        sessions
            .list()
            .into_iter()
            .find(|info| info.session == id)
            .expect("the session is listed")
            .state
    }

    /// Polls `done` every millisecond for up to `max`.
    fn wait_until(max: Duration, done: impl Fn() -> bool) -> bool {
        let start = Instant::now();
        while !done() {
            if start.elapsed() > max {
                return false;
            }
            thread::sleep(Duration::from_millis(1));
        }
        true
    }

    /// Spins until `cancel` is set and returns when it saw it; fails the test if it never is (after [`GIVE_UP`]), so
    /// a broken cancel cannot pass on the generation check alone.
    fn until_cancelled(cancel: &CancelToken) -> Instant {
        assert!(
            wait_until(GIVE_UP, || cancel.is_cancelled()),
            "the operation's token was never cancelled"
        );
        Instant::now()
    }

    /// How soon after a lock a running operation must see its cancel. It polls every millisecond; the margin is for a
    /// loaded test machine.
    const PROMPT: Duration = Duration::from_secs(1);

    /// Whether `seen` (set by the operation) came within [`PROMPT`] of `locked_at`.
    fn prompt(locked_at: Instant, seen: &OnceLock<Instant>) -> bool {
        seen.get()
            .is_some_and(|seen| seen.saturating_duration_since(locked_at) < PROMPT)
    }

    #[test]
    fn stale_generation_refused() {
        let parent = TempDir::new();
        let (_, sessions) = sessions();
        let (id, generation, _) = open_writable(&sessions, parent.path());
        for stale in [generation - 1, generation + 1] {
            assert_eq!(
                sessions.read(id, stale, |_, _| Ok(())).err(),
                Some(ShellError::Locked)
            );
        }
        assert_eq!(
            sessions
                .read(SessionId(999), generation, |_, _| Ok(()))
                .err(),
            Some(ShellError::NotFound)
        );
        let answer = sessions.read(id, generation, |_, _| Ok(7)).unwrap();
        assert_eq!(
            (answer.session, answer.generation, answer.data),
            (id, generation, 7)
        );
    }

    /// Review Focus 1: Windows locks during the one-second password check.
    #[test]
    fn lock_during_unlock_discards_vault() {
        let parent = TempDir::new();
        let (_, sessions) = sessions();
        let dir = create_closed(parent.path());
        let location = Location::folder(&dir).unwrap();
        let (unlocked, locked) = (Meet::default(), Meet::default());
        let saw_cancel = AtomicBool::new(false);
        let answer = thread::scope(|s| {
            let opening = s.spawn(|| {
                sessions.open(Some(location.clone()), None, |cancel| {
                    let vault = unlock(&dir)?;
                    unlocked.wait();
                    locked.wait();
                    saw_cancel.store(cancel.is_cancelled(), Ordering::SeqCst);
                    Ok(OpenStep::Session(
                        location.clone(),
                        Opened::Writable(vault),
                        (),
                    ))
                })
            });
            unlocked.wait();
            sessions.lock_all(LockReason::WindowsLocked);
            locked.wait();
            opening.join().unwrap()
        });
        assert_eq!(answer.err(), Some(ShellError::Locked));
        assert!(
            saw_cancel.load(Ordering::SeqCst),
            "the open's token is cancelled"
        );
        assert!(
            sessions
                .list()
                .iter()
                .all(|info| info.state != SessionState::Unlocked)
        );
        assert!(is_free(&dir), "the discarded vault released its .lock");
        assert!(unlock(&dir).is_ok());
    }

    #[test]
    fn lock_during_long_read_returns_locked_and_releases_key() {
        let parent = TempDir::new();
        let (_, sessions) = sessions();
        let (id, generation, dir) = open_writable(&sessions, parent.path());
        let (started, finish) = (Meet::default(), Meet::default());
        let seen = OnceLock::new();
        let (locked_at, held, released, free, answer) = thread::scope(|s| {
            let reading = s.spawn(|| {
                sessions.read_long(id, generation, |_, cancel| {
                    started.wait();
                    seen.set(until_cancelled(cancel)).unwrap();
                    // Hold the vault a little past the cancel, as an operation finishing its chunk does.
                    finish.wait();
                    Ok(())
                })
            });
            started.wait();
            let locked_at = Instant::now();
            sessions.lock(id, LockReason::Manual);
            let held = !sessions.release_wait(id, Duration::from_millis(50));
            finish.wait();
            let released = sessions.release_wait(id, Duration::from_secs(1));
            let free = is_free(&dir);
            (locked_at, held, released, free, reading.join().unwrap())
        });
        assert!(prompt(locked_at, &seen), "the read saw the cancel promptly");
        assert!(held, "the read still held the vault");
        assert!(released, "the last reference dropped");
        assert!(free, "the vault's .lock is free");
        assert_eq!(answer.err(), Some(ShellError::Locked));
    }

    #[test]
    fn result_after_lock_is_never_returned() {
        let parent = TempDir::new();
        let (_, sessions) = sessions();
        let (id, generation, _) = open_writable(&sessions, parent.path());
        let (started, go) = (Meet::default(), Meet::default());
        let answer = thread::scope(|s| {
            let reading = s.spawn(|| {
                sessions.read(id, generation, |_, _| {
                    started.wait();
                    go.wait();
                    Ok("item data")
                })
            });
            started.wait();
            sessions.lock(id, LockReason::Manual);
            go.wait();
            reading.join().unwrap()
        });
        assert_eq!(answer.err(), Some(ShellError::Locked));
    }

    #[test]
    fn change_racing_lock_says_changed() {
        let parent = TempDir::new();
        let (_, sessions) = sessions();
        let (id, generation, _) = open_writable(&sessions, parent.path());
        let (started, go) = (Meet::default(), Meet::default());
        let answer = thread::scope(|s| {
            let changing = s.spawn(|| {
                sessions.write_change(id, generation, "password", |_, _| {
                    started.wait();
                    go.wait();
                    Ok(())
                })
            });
            started.wait();
            sessions.lock_all(LockReason::Manual);
            go.wait();
            changing.join().unwrap()
        });
        assert_eq!(
            answer.err(),
            Some(ShellError::LockedAfterChange { what: "password" })
        );
    }

    #[test]
    fn read_only_session_refuses_writes() {
        let parent = TempDir::new();
        let (_, sessions) = sessions();
        let dir = create_closed(parent.path());
        let (id, generation) = open_read_only(&sessions, &dir);
        assert_eq!(
            sessions.write(id, generation, |_, _| Ok(())).err(),
            Some(ShellError::ReadOnly)
        );
        assert_eq!(
            sessions.write_long(id, generation, |_, _| Ok(())).err(),
            Some(ShellError::ReadOnly)
        );
        assert_eq!(
            sessions
                .write_change(id, generation, "password", |_, _| Ok(()))
                .err(),
            Some(ShellError::ReadOnly)
        );
        assert_eq!(
            sessions
                .read_write(id, generation, id, generation, |_, _, _| Ok(()))
                .err(),
            Some(ShellError::ReadOnly)
        );
        let read = sessions.read(id, generation, |vault, _| {
            Ok(matches!(vault, VaultRef::ReadOnly(_)))
        });
        assert!(read.unwrap().data);
    }

    #[test]
    fn sessions_keyed_by_location() {
        let parent = TempDir::new();
        let (_, sessions) = sessions();
        let vault = create(parent.path());
        let dir = vault.dir().to_path_buf();
        let backup = parent.path().join("Family.lockbox-backup");
        vault
            .backup(&backup, &NoJournal, &CancelToken::new())
            .unwrap();
        let mut before_restore = dir.clone().into_os_string();
        before_restore.push(".before-restore");
        let before_restore = PathBuf::from(before_restore);
        copy_folder(&dir, &before_restore);

        let live = open_as(
            &sessions,
            Location::folder(&dir).unwrap(),
            Opened::Writable(vault),
        );
        let from_backup = heavy(|| {
            ReadOnlyVault::open_backup(&backup, Credential::Password(PW), &CancelToken::new())
        })
        .unwrap();
        let backup_session = open_as(
            &sessions,
            Location::backup(&backup).unwrap(),
            Opened::ReadOnly(from_backup),
        );
        let before_session = open_read_only(&sessions, &before_restore);

        let ids = [live.0, backup_session.0, before_session.0];
        assert!(ids[0] != ids[1] && ids[1] != ids[2] && ids[0] != ids[2]);
        let listed = sessions.list();
        assert_eq!(listed.len(), 3);
        assert!(
            listed
                .iter()
                .all(|info| info.state == SessionState::Unlocked)
        );
        for (id, generation) in [live, backup_session, before_session] {
            assert!(sessions.read(id, generation, |_, _| Ok(())).is_ok());
        }

        // The same folder in another case is the same location; a folder and a backup never are.
        let Location::Folder(canonical) = Location::folder(&dir).unwrap() else {
            unreachable!()
        };
        let shouted = PathBuf::from(canonical.to_string_lossy().to_uppercase());
        assert_eq!(
            Location::Folder(shouted.clone()),
            Location::Folder(canonical.clone())
        );
        assert_ne!(Location::Backup(shouted), Location::Folder(canonical));
    }

    #[test]
    fn same_location_opens_once() {
        let parent = TempDir::new();
        let (_, sessions) = sessions();
        let vault = create(parent.path());
        let location = Location::folder(vault.dir()).unwrap();
        let first = sessions.open(Some(location.clone()), None, |_| {
            Ok(OpenStep::Session(
                location.clone(),
                Opened::Writable(vault),
                "unlock report",
            ))
        });
        let Ok(Outcome::Done(first)) = first else {
            panic!("the first open answers Done");
        };
        assert_eq!(first.data.1, Some("unlock report"));

        let ran = Cell::new(false);
        let again = sessions.open(Some(location), None, |_| {
            ran.set(true);
            Err::<OpenStep<&str>, _>(ShellError::NotFound)
        });
        let Ok(Outcome::Done(again)) = again else {
            panic!("the second open answers Done");
        };
        assert!(!ran.get(), "the closure did not run");
        assert_eq!(
            (again.session, again.generation, again.data.1),
            (first.session, first.generation, None)
        );
        assert_eq!(again.data.0.state, SessionState::Unlocked);
    }

    #[test]
    fn concurrent_open_of_one_location_is_busy() {
        let parent = TempDir::new();
        let (_, sessions) = sessions();
        let vault = create(parent.path());
        let location = Location::folder(vault.dir()).unwrap();
        let (inside, release) = (Meet::default(), Meet::default());
        let (second, first) = thread::scope(|s| {
            let first = s.spawn(|| {
                sessions.open(Some(location.clone()), None, |_| {
                    inside.wait();
                    release.wait();
                    Ok(OpenStep::Session(
                        location.clone(),
                        Opened::Writable(vault),
                        (),
                    ))
                })
            });
            inside.wait();
            let ran = Cell::new(false);
            let second = sessions.open(Some(location.clone()), None, |_| {
                ran.set(true);
                Err::<OpenStep<()>, _>(ShellError::NotFound)
            });
            release.wait();
            assert!(!ran.get(), "the second open did not run");
            (second.err(), first.join().unwrap())
        });
        assert_eq!(second, Some(ShellError::Busy { what: "opening" }));
        assert!(matches!(first, Ok(Outcome::Done(_))));
    }

    #[test]
    fn ask_racing_lock_parks_nothing() {
        let parent = TempDir::new();
        let (_, sessions) = sessions();
        let dir = create_closed(parent.path());
        let location = Location::folder(&dir).unwrap();
        let ask = |token| Confirm::HeaderChanged { token };

        // Raced by a lock: nothing is parked, and the vault the choice held is dropped.
        let (inside, locked) = (Meet::default(), Meet::default());
        let answer = thread::scope(|s| {
            let asking = s.spawn(|| {
                sessions.open(Some(location.clone()), None, |_| {
                    let vault = unlock(&dir)?;
                    inside.wait();
                    locked.wait();
                    Ok(OpenStep::<()>::Ask(
                        PendingChoice::Test(Some(Box::new(vault))),
                        ask,
                    ))
                })
            });
            inside.wait();
            sessions.lock_all(LockReason::Manual);
            locked.wait();
            asking.join().unwrap()
        });
        assert_eq!(answer.err(), Some(ShellError::Locked));
        assert_eq!(sessions.pending().len(), 0);
        assert!(is_free(&dir));

        // Not raced: a question whose token is taken once.
        let answer = sessions.open(Some(location), None, |_| {
            Ok(OpenStep::<()>::Ask(PendingChoice::Test(None), ask))
        });
        let Ok(Outcome::Confirm(Confirm::HeaderChanged { token })) = answer else {
            panic!("the open asks first");
        };
        assert!(sessions.list().is_empty(), "no session is made");
        assert!(matches!(
            sessions.pending().take(&token),
            Ok(PendingChoice::Test(None))
        ));
        assert!(matches!(
            sessions.pending().take(&token),
            Err(ShellError::NotFound)
        ));
    }

    /// Task 9: a question changes nothing, so a lock racing it answers `Locked` even for an open that names its
    /// change (`recover_vault` asks before it sets the new password).
    #[test]
    fn ask_racing_lock_with_what_says_locked() {
        let (_, sessions) = sessions();
        let answer = sessions.open(None, Some("password"), |_| {
            sessions.lock_all(LockReason::Manual);
            Ok(OpenStep::<()>::Ask(PendingChoice::Test(None), |token| {
                Confirm::HeaderChanged { token }
            }))
        });
        assert_eq!(answer.err(), Some(ShellError::Locked));
        assert_eq!(sessions.pending().len(), 0);
    }

    #[test]
    fn open_racing_lock_with_what_says_changed() {
        let parent = TempDir::new();
        let (_, sessions) = sessions();
        let (inside, locked) = (Meet::default(), Meet::default());
        let made = OnceLock::new();
        let answer = thread::scope(|s| {
            let creating = s.spawn(|| {
                sessions.open(None, Some("vault created"), |_| {
                    let vault = create(parent.path());
                    made.set(vault.dir().to_path_buf()).unwrap();
                    let location = Location::folder(vault.dir()).unwrap();
                    inside.wait();
                    locked.wait();
                    Ok(OpenStep::Session(location, Opened::Writable(vault), ()))
                })
            });
            inside.wait();
            sessions.lock_all(LockReason::Manual);
            locked.wait();
            creating.join().unwrap()
        });
        assert_eq!(
            answer.err(),
            Some(ShellError::LockedAfterChange {
                what: "vault created"
            })
        );
        assert!(sessions.list().is_empty());
        assert!(is_free(made.get().unwrap()), "the new vault was dropped");
    }

    #[test]
    fn sessions_found_by_location() {
        let parent = TempDir::new();
        let (_, sessions) = sessions();
        let (a, _, a_dir) = open_writable(&sessions, parent.path());
        let (b, _, b_dir) = open_writable(&sessions, parent.path());
        let (a_at, b_at) = (
            Location::folder(&a_dir).unwrap(),
            Location::folder(&b_dir).unwrap(),
        );
        let mut found = sessions.locations();
        found.sort_by_key(|(id, _)| id.0);
        assert_eq!(found, [(a, a_at.clone()), (b, b_at.clone())]);
        assert_eq!(sessions.find(&a_at), Some(a));
        assert_eq!(sessions.find(&b_at), Some(b));

        sessions.lock(a, LockReason::Manual);
        assert_eq!(sessions.find(&a_at), None);
        assert_eq!(sessions.locations(), [(b, b_at)]);
    }

    #[test]
    fn drive_gone_lock_marks_unavailable() {
        let parent = TempDir::new();
        let (recorder, sessions) = sessions();
        let (a, a_generation, _) = open_writable(&sessions, parent.path());
        let (b, b_generation, _) = open_writable(&sessions, parent.path());
        sessions.lock(a, LockReason::DriveGone);
        sessions.lock(b, LockReason::Manual);
        assert_eq!(state(&sessions, a), SessionState::Unavailable);
        assert_eq!(state(&sessions, b), SessionState::Locked);
        assert_eq!(
            *lock(&recorder.locked),
            [
                (a, a_generation + 1, LockReason::DriveGone),
                (b, b_generation + 1, LockReason::Manual),
            ]
        );
    }

    #[test]
    fn token_survives_json_round_trip() {
        let (_, sessions) = sessions();
        let token = sessions.pending().put(PendingChoice::Test(None));
        let answer = Tagged {
            session: SessionId(1),
            generation: 2,
            data: Outcome::<()>::Confirm(Confirm::HeaderChanged { token }),
        };
        let json = serde_json::to_value(&answer).unwrap();
        let sent = &json["data"]["Confirm"]["HeaderChanged"]["token"];
        let text = sent.as_str().expect("the token is a JSON string");
        assert_eq!(text.len(), 32);
        assert!(text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));

        let back: Token = serde_json::from_value(sent.clone()).unwrap();
        assert!(matches!(
            sessions.pending().take(&back),
            Ok(PendingChoice::Test(None))
        ));

        // Only that exact form parses.
        let rest = &text[1..];
        for bad in [
            json!(format!("A{rest}")),
            json!(format!("g{rest}")),
            json!(format!(" {rest}")),
            json!(rest),
            json!(format!("{text}0")),
            json!(1),
        ] {
            assert!(serde_json::from_value::<Token>(bad).is_err());
        }
    }

    #[test]
    fn short_write_waits_briefly_then_busy() {
        let parent = TempDir::new();
        let (_, sessions) = sessions();
        let (id, generation, _) = open_writable(&sessions, parent.path());
        let _quiet = quiet();
        let held = Meet::default();

        // Held for 100 ms: the short write waits for it.
        let (short, holder) = thread::scope(|s| {
            let holder = s.spawn(|| {
                sessions.write_long(id, generation, |_, _| {
                    held.wait();
                    thread::sleep(Duration::from_millis(100));
                    Ok(())
                })
            });
            held.wait();
            let short = sessions.write(id, generation, |_, _| Ok(()));
            (short.err(), holder.join().unwrap().err())
        });
        assert_eq!((short, holder), (None, None));

        // Held for longer than the wait (until released): busy after about 500 ms.
        let release = Meet::default();
        let (short, waited, holder) = thread::scope(|s| {
            let holder = s.spawn(|| {
                sessions.write_long(id, generation, |_, _| {
                    held.wait();
                    release.wait();
                    Ok(())
                })
            });
            held.wait();
            let start = Instant::now();
            let short = sessions.write(id, generation, |_, _| Ok(()));
            let waited = start.elapsed();
            release.wait();
            (short.err(), waited, holder.join().unwrap().err())
        });
        assert_eq!((short, holder), (Some(BUSY), None));
        assert!(
            waited >= Duration::from_millis(500) && waited < Duration::from_secs(1),
            "waited {waited:?}"
        );
    }

    #[test]
    fn long_write_busy_at_once_and_lock_not_delayed() {
        let parent = TempDir::new();
        let (_, sessions) = sessions();
        let (id, generation, _) = open_writable(&sessions, parent.path());
        let _quiet = quiet();
        let held = Meet::default();
        let (second, second_took, lock_took, stopped_after, holder) = thread::scope(|s| {
            let holder = s.spawn(|| {
                let answer = sessions.write_long(id, generation, |_, cancel| {
                    held.wait();
                    until_cancelled(cancel);
                    Ok(())
                });
                (answer, Instant::now())
            });
            held.wait();
            let start = Instant::now();
            let second = sessions.write_long(id, generation, |_, _| Ok(()));
            let second_took = start.elapsed();
            let locked_at = Instant::now();
            sessions.lock_all(LockReason::Manual);
            let lock_took = locked_at.elapsed();
            let (holder, ended) = holder.join().unwrap();
            let stopped_after = ended.saturating_duration_since(locked_at);
            (second.err(), second_took, lock_took, stopped_after, holder)
        });
        assert_eq!(second, Some(BUSY));
        assert!(second_took < Duration::from_millis(50), "{second_took:?}");
        assert!(lock_took < Duration::from_millis(50), "{lock_took:?}");
        assert!(
            stopped_after < PROMPT,
            "the write stopped {stopped_after:?} after the lock"
        );
        assert_eq!(holder.err(), Some(ShellError::Locked));
    }

    #[test]
    fn two_session_operation_stops_when_either_locks() {
        let parent = TempDir::new();
        let (_, sessions) = sessions();
        let vault = create(parent.path());
        let copy = parent.path().join("copy");
        copy_folder(vault.dir(), &copy);
        let to = open_as(
            &sessions,
            Location::folder(vault.dir()).unwrap(),
            Opened::Writable(vault),
        );
        for lock_source in [true, false] {
            let from = open_read_only(&sessions, &copy);
            let started = Meet::default();
            let seen = OnceLock::new();
            let (locked_at, answer) = thread::scope(|s| {
                let copying = s.spawn(|| {
                    sessions.read_write(from.0, from.1, to.0, to.1, |_, _, cancel| {
                        started.wait();
                        seen.set(until_cancelled(cancel)).unwrap();
                        Ok(())
                    })
                });
                started.wait();
                let locked_at = Instant::now();
                sessions.lock(if lock_source { from.0 } else { to.0 }, LockReason::Manual);
                (locked_at, copying.join().unwrap())
            });
            assert_eq!(answer.err(), Some(ShellError::Locked));
            assert!(prompt(locked_at, &seen), "the copy saw the cancel promptly");
            if lock_source {
                assert!(
                    sessions.read(to.0, to.1, |_, _| Ok(())).is_ok(),
                    "the destination stays open"
                );
            }
        }
    }

    #[test]
    fn lock_waits_only_for_one_publish_step() {
        let parent = TempDir::new();
        let (_, sessions) = sessions();
        let (id, generation, _) = open_writable(&sessions, parent.path());
        let _quiet = quiet();
        let entered = Meet::default();
        let finished = AtomicBool::new(false);
        let (took, finished_first, published) = thread::scope(|s| {
            let publishing = s.spawn(|| {
                sessions.publish(id, generation, || {
                    entered.wait();
                    thread::sleep(Duration::from_millis(50));
                    finished.store(true, Ordering::SeqCst);
                    Ok(())
                })
            });
            entered.wait();
            let start = Instant::now();
            sessions.lock_all(LockReason::Manual);
            let took = start.elapsed();
            let finished_first = finished.load(Ordering::SeqCst);
            (took, finished_first, publishing.join().unwrap())
        });
        assert!(finished_first, "the lock waited for the attempt under way");
        assert!(took < Duration::from_millis(100), "{took:?}");
        assert_eq!(published, Ok(()));

        let ran = AtomicBool::new(false);
        let after = sessions.publish(id, generation, || {
            ran.store(true, Ordering::SeqCst);
            Ok(())
        });
        assert_eq!(after, Err(ShellError::Locked));
        assert!(
            !ran.load(Ordering::SeqCst),
            "a publish after the lock never runs"
        );
    }

    /// Logs what each step of a lock can observe.
    #[derive(Default)]
    struct Steps {
        log: Mutex<Vec<String>>,
        token: OnceLock<CancelToken>,
        dir: OnceLock<PathBuf>,
    }

    impl Notifier for Steps {
        fn locked(&self, _session: SessionId, generation: u64, _reason: LockReason) {
            let cancelled = self.token.get().unwrap().is_cancelled();
            let released = is_free(self.dir.get().unwrap());
            lock(&self.log).push(format!(
                "notifier: generation {generation}, cancelled {cancelled}, released {released}"
            ));
        }
        fn busy(&self, _session: Option<SessionId>, _operations: &[&'static str]) {}
        fn notice(&self, _notice: &Notice) {}
    }

    #[test]
    fn lock_steps_run_in_spec_order() {
        let parent = TempDir::new();
        let steps = Arc::new(Steps::default());
        let sessions = Sessions::new(steps.clone());
        let (id, generation, dir) = open_writable(&sessions, parent.path());
        let token = sessions
            .read(id, generation, |_, cancel| Ok(cancel.clone()))
            .unwrap()
            .data;
        steps.token.set(token.clone()).unwrap();
        steps.dir.set(dir).unwrap();
        for n in 1..=2 {
            let steps = steps.clone();
            sessions.on_lock(Box::new(move |which, reason| {
                lock(&steps.log).push(format!("hook {n}: {which:?} {reason:?}"));
            }));
        }

        let entered = Meet::default();
        let published = thread::scope(|s| {
            let publishing = s.spawn(|| {
                sessions.publish(id, generation, || {
                    entered.wait();
                    // The lock now waits for this attempt: it has bumped the generation, and cancels nothing until
                    // the attempt ends.
                    let bumped = wait_until(Duration::from_secs(5), || {
                        sessions.list()[0].generation == generation + 1
                    });
                    thread::sleep(Duration::from_millis(20));
                    let cancelled = token.is_cancelled();
                    lock(&steps.log)
                        .push(format!("publish: bumped {bumped}, cancelled {cancelled}"));
                    Ok(())
                })
            });
            entered.wait();
            sessions.lock(id, LockReason::Manual);
            publishing.join().unwrap()
        });
        assert_eq!(published, Ok(()));
        assert_eq!(
            *lock(&steps.log),
            [
                "publish: bumped true, cancelled false".to_string(),
                format!(
                    "notifier: generation {}, cancelled true, released true",
                    generation + 1
                ),
                format!("hook 1: Some({id:?}) Manual"),
                format!("hook 2: Some({id:?}) Manual"),
            ]
        );
    }

    #[test]
    fn lock_all_drops_everything_pending() {
        let parent = TempDir::new();
        let (_, sessions) = sessions();
        let dir = create_closed(parent.path());
        let with_vault = sessions
            .pending()
            .put(PendingChoice::Test(Some(Box::new(unlock(&dir).unwrap()))));
        let plain = sessions.pending().put(PendingChoice::Test(None));
        assert!(!is_free(&dir));

        sessions.lock_all(LockReason::Idle);
        for token in [with_vault, plain] {
            assert!(matches!(
                sessions.pending().take(&token),
                Err(ShellError::NotFound)
            ));
        }
        assert!(is_free(&dir), "the parked vault was dropped");
    }

    /// Fix round 1: a second lock must not skip a session whose first lock is still waiting for a publish attempt,
    /// nor run its hooks (the clipboard clear) and return while that attempt can still write.
    #[test]
    fn overlapping_locks_finish_in_turn() {
        let parent = TempDir::new();
        let (_, sessions) = sessions();
        let (id, generation, _) = open_writable(&sessions, parent.path());
        let log = Arc::new(Mutex::new(Vec::<String>::new()));
        {
            let log = log.clone();
            sessions.on_lock(Box::new(move |which, reason| {
                lock(&log).push(format!("hook {which:?} {reason:?}"));
            }));
        }
        let (entered, go) = (Meet::default(), Meet::default());
        let all_returned = AtomicBool::new(false);
        let (waiting, second_waits, returned_early, logged_early, published) = thread::scope(|s| {
            let publishing = s.spawn(|| {
                sessions.publish(id, generation, || {
                    entered.wait();
                    go.wait();
                    lock(&log).push("publish done".to_string());
                    Ok(())
                })
            });
            entered.wait();
            let manual = s.spawn(|| sessions.lock(id, LockReason::Manual));
            // The manual lock has done step (1) and now waits for the publish guard, holding its turn.
            let waiting = wait_until(GIVE_UP, || state(&sessions, id) == SessionState::Locked);
            let all = s.spawn(|| {
                sessions.lock_all(LockReason::Idle);
                all_returned.store(true, Ordering::SeqCst);
            });
            // The second lock has provably found the first one's turn taken while the publish is still held:
            // without the turn it never waits, and this fails. Waiting, it cannot return or run hooks before `go`.
            let second_waits = wait_until(GIVE_UP, || {
                sessions.locks_waited.load(Ordering::SeqCst) == 1
            });
            let returned_early = all_returned.load(Ordering::SeqCst);
            let logged_early = lock(&log).clone();
            go.wait();
            let published = publishing.join().unwrap();
            manual.join().unwrap();
            all.join().unwrap();
            (
                waiting,
                second_waits,
                returned_early,
                logged_early,
                published,
            )
        });
        assert!(waiting, "the manual lock reached the publish guard");
        assert!(second_waits, "lock_all waited for the first lock's turn");
        assert!(
            !returned_early,
            "lock_all returned before the first lock finished"
        );
        assert_eq!(
            logged_early,
            Vec::<String>::new(),
            "no hook ran before the publish ended"
        );
        assert_eq!(published, Ok(()));
        assert_eq!(
            *lock(&log),
            [
                "publish done".to_string(),
                format!("hook Some({id:?}) Manual"),
                "hook None Idle".to_string(),
            ]
        );
    }

    /// Fix round 1: a vault from an earlier unlock that a running operation still holds is waited for too.
    #[test]
    fn release_wait_counts_every_copy() {
        let parent = TempDir::new();
        let (_, sessions) = sessions();
        let dir = create_closed(parent.path());
        let (id, first) = open_read_only(&sessions, &dir);
        let (started, finish) = (Meet::default(), Meet::default());
        let (reopened, held, released, answer) = thread::scope(|s| {
            let reading = s.spawn(|| {
                sessions.read_long(id, first, |_, _| {
                    started.wait();
                    finish.wait();
                    Ok(())
                })
            });
            started.wait();
            sessions.lock(id, LockReason::Manual);
            let reopened = open_read_only(&sessions, &dir);
            sessions.lock(id, LockReason::Manual);
            let held = !sessions.release_wait(id, Duration::from_millis(50));
            finish.wait();
            let released = sessions.release_wait(id, Duration::from_secs(1));
            (reopened, held, released, reading.join().unwrap())
        });
        assert_eq!(
            reopened,
            (id, first + 2),
            "the same session, unlocked again"
        );
        assert!(held, "the first unlock's vault was still held");
        assert!(released, "every copy dropped");
        assert_eq!(answer.err(), Some(ShellError::Locked));
    }

    /// Fix round 1: locations compare as Windows compares names (ordinal, ignoring case), not by Unicode lowercase.
    #[cfg(windows)]
    #[test]
    fn paths_compare_as_windows_does() {
        let at = |name: &str| Location::Folder(Path::new("C:\\Vaults").join(name));
        // Lowercasing U+0130 gives "i" + U+0307; Windows keeps them apart.
        assert_ne!(at("\u{0130}"), at("i\u{0307}"));
        assert_eq!(at("\u{00C9}t\u{00E9}"), at("\u{00E9}T\u{00C9}"));
        assert_eq!(at("FAMILY"), at("family"));
        assert_ne!(at("family"), at("familia"));
    }
}
