//! Locking without the user asking (spec §7.4 and §6.10): after the idle time, on Windows lock, sleep and hibernate,
//! when a vault's folder or drive goes away, and when the app closes. Long operations pause the idle time and keep
//! the PC awake while they run ([`AutoLock::begin`]).
//!
//! Nothing here runs on the signal window's thread: the app's signal receiver calls [`AutoLock::signal`], and a
//! timer thread calls [`AutoLock::tick`] every [`TICK`]. Folder checks run on a thread of their own, so a drive that
//! stops answering never holds up the idle lock.
//!
//! Lock order: the operations' list ([`Operations::running`]), then the sessions' own locks. The list is held across a
//! revocation (which never waits for a hook), never across a hook, the notifier or a keep-awake request. No trigger
//! (the timer, the signal receiver, the folder check) waits for a lock hook: hooks run on the sessions' hook thread.
//! Only the shutdown waits for them, until its deadline.

use std::path::{Component, Path, Prefix};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use lockbox_core::blob::CancelToken;

use crate::lock;
use crate::os::{Clock, IdleSource, Os, OsSignal, Power, Volumes};
use crate::session::{LockReason, Notifier, SessionId, Sessions};
use crate::settings::SettingsStore;

/// How often the timer thread calls [`AutoLock::tick`]: also how late a vault on a drive that went away without a
/// signal can lock.
pub const TICK: Duration = Duration::from_secs(5);

/// The longest a [`shutdown`](AutoLock::shutdown) call waits, from the moment it is made, before the process may
/// exit.
pub const SHUTDOWN_WAIT: Duration = Duration::from_secs(2);

/// Locks the vaults on idle, Windows' signals, vanished folders and app exit.
pub struct AutoLock {
    sessions: Arc<Sessions>,
    settings: Arc<SettingsStore>,
    volumes: Arc<dyn Volumes>,
    idle: Arc<dyn IdleSource>,
    operations: Arc<Operations>,
    closing: Arc<Closing>,
    /// Set while a folder check runs: at most one at a time.
    probing: Arc<AtomicBool>,
    /// Tests only: the last folder check's thread.
    #[cfg(test)]
    probe_thread: Mutex<Option<thread::JoinHandle<()>>>,
    #[cfg(test)]
    on_tick: Mutex<TestHook>,
    #[cfg(test)]
    fail_spawn: AtomicBool,
    #[cfg(test)]
    on_helper: Arc<Mutex<TestHook>>,
}

/// Tests only: a step a test runs once, inside the shell's own work.
#[cfg(test)]
type TestHook = Option<Box<dyn FnOnce() + Send>>;

/// The long operations under way, shared with each [`LongOp`].
struct Operations {
    /// Never held across a call out of this module but a session revocation.
    running: Mutex<Running>,
    /// The keep-awake state last asked for. Held while asking Windows and telling the page, so both see the changes
    /// in order.
    announcing: Mutex<bool>,
    /// The closing gate: set for good at the shutdown's entry, read under `running` where an operation registers.
    closed: AtomicBool,
    power: Arc<dyn Power>,
    clock: Arc<dyn Clock>,
    notifier: Arc<dyn Notifier>,
}

#[derive(Default)]
struct Running {
    last_id: u64,
    operations: Vec<Operation>,
    /// When the last operation to end did; `None` before any has.
    last_end: Option<Instant>,
    /// This idle period has locked already: set by the idle lock, cleared by input or an operation ending.
    idle_locked: bool,
}

struct Operation {
    id: u64,
    session: Option<SessionId>,
    what: &'static str,
    cancel: CancelToken,
}

impl Running {
    /// How long the user has been idle at `now`, given `since_input`: none while an operation runs, else counted at
    /// most from the end of the last one.
    fn idle_for(&self, since_input: Duration, now: Instant) -> Duration {
        if !self.operations.is_empty() {
            return Duration::ZERO;
        }
        match self.last_end {
            Some(end) => since_input.min(now.saturating_duration_since(end)),
            None => since_input,
        }
    }

    fn cancel_all(&self) {
        for operation in &self.operations {
            operation.cancel.cancel();
        }
    }
}

/// A long operation under way ([`AutoLock::begin`]): while any exists, idle time does not count and the PC is kept
/// awake. Dropping it ends the operation.
pub struct LongOp {
    /// `None`: refused, the app is closing.
    id: Option<u64>,
    session: Option<SessionId>,
    operations: Arc<Operations>,
}

impl Drop for LongOp {
    fn drop(&mut self) {
        if let Some(id) = self.id {
            self.operations.end(id, self.session);
        }
    }
}

impl Operations {
    fn begin(
        self: &Arc<Self>,
        session: Option<SessionId>,
        what: &'static str,
        cancel: CancelToken,
    ) -> LongOp {
        let id = {
            let mut running = lock(&self.running);
            if self.closed.load(Ordering::SeqCst) {
                cancel.cancel();
                None
            } else {
                running.last_id += 1;
                let id = running.last_id;
                running.operations.push(Operation {
                    id,
                    session,
                    what,
                    cancel,
                });
                Some(id)
            }
        };
        // The guard exists before anything else runs: if the notifier or Windows fails, unwinding drops it and the
        // operation ends.
        let operation = LongOp {
            id,
            session,
            operations: Arc::clone(self),
        };
        if id.is_some() {
            self.announce(Some(session));
        }
        operation
    }

    fn end(&self, id: u64, session: Option<SessionId>) {
        {
            let mut running = lock(&self.running);
            running.operations.retain(|operation| operation.id != id);
            running.last_end = Some(self.clock.now());
            running.idle_locked = false;
        }
        // While unwinding, only the keep-awake request is put right: a second panic would abort the process.
        self.announce((!thread::panicking()).then_some(session));
    }

    /// Asks Windows to keep the PC awake while any operation runs, and with `Some(session)`, sends `lockbox://busy`:
    /// the operations now running for that session (or without one).
    fn announce(&self, busy: Option<Option<SessionId>>) {
        let mut awake = lock(&self.announcing);
        let (any, names) = {
            let running = lock(&self.running);
            let names: Vec<&'static str> = match busy {
                Some(session) => running
                    .operations
                    .iter()
                    .filter(|operation| operation.session == session)
                    .map(|operation| operation.what)
                    .collect(),
                None => Vec::new(),
            };
            (!running.operations.is_empty(), names)
        };
        if any != *awake {
            self.power.keep_awake(any);
            *awake = any;
        }
        if let Some(session) = busy {
            self.notifier.busy(session, &names);
        }
    }

    /// Shuts the closing gate: from now on no operation registers. Takes no lock, so the shutdown sets it at once.
    fn shut(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }

    /// The app is closing: shuts the gate and cancels every operation registered before it.
    fn close(&self) {
        self.shut();
        lock(&self.running).cancel_all();
    }
}

/// How far closing the app has got, for every [`shutdown`](AutoLock::shutdown) call to wait on.
#[derive(Default)]
struct Closing {
    phase: Mutex<Phase>,
    changed: Condvar,
}

#[derive(Default)]
struct Phase {
    /// The first call's deadline, which also bounds the hooks for every later call. `None` until closing starts.
    hooks_deadline: Option<Instant>,
    /// Every vault is revoked and nothing can open.
    revoked: bool,
    /// The hooks are done too (or skipped).
    done: bool,
}

impl Closing {
    fn update(&self, change: impl FnOnce(&mut Phase)) {
        change(&mut lock(&self.phase));
        self.changed.notify_all();
    }

    /// Waits until `reached` or `deadline`.
    fn wait(&self, deadline: Instant, reached: impl Fn(&Phase) -> bool) {
        let mut phase = lock(&self.phase);
        while !reached(&phase) {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return;
            }
            phase = self
                .changed
                .wait_timeout(phase, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }
}

/// Marks closing done when dropped, also when the helper thread panicked: no caller waits past its deadline for it.
struct MarkDone(Arc<Closing>);

impl Drop for MarkDone {
    fn drop(&mut self) {
        self.0.update(|phase| phase.done = true);
    }
}

/// Clears the folder check's flag when dropped, also after a panic, so the next tick can check again.
struct DoneProbing(Arc<AtomicBool>);

impl Drop for DoneProbing {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl AutoLock {
    /// Uses `os`'s volumes, idle source, power and clock.
    pub fn new(
        sessions: Arc<Sessions>,
        settings: Arc<SettingsStore>,
        notifier: Arc<dyn Notifier>,
        os: &Os,
    ) -> AutoLock {
        AutoLock {
            sessions,
            settings,
            volumes: Arc::clone(&os.volumes),
            idle: Arc::clone(&os.idle),
            operations: Arc::new(Operations {
                running: Mutex::default(),
                announcing: Mutex::new(false),
                closed: AtomicBool::new(false),
                power: Arc::clone(&os.power),
                clock: Arc::clone(&os.clock),
                notifier,
            }),
            closing: Arc::default(),
            probing: Arc::default(),
            #[cfg(test)]
            probe_thread: Mutex::default(),
            #[cfg(test)]
            on_tick: Mutex::default(),
            #[cfg(test)]
            fail_spawn: AtomicBool::new(false),
            #[cfg(test)]
            on_helper: Arc::default(),
        }
    }

    /// Tests only: runs `hook` once, first thing on the next shutdown's helper thread.
    #[cfg(test)]
    pub(crate) fn during_next_helper(&self, hook: Box<dyn FnOnce() + Send>) {
        *lock(&self.on_helper) = Some(hook);
    }

    /// Tests only: runs `hook` once, inside the next tick, after it has read the idle time and before it locks.
    #[cfg(test)]
    pub(crate) fn during_next_tick(&self, hook: Box<dyn FnOnce() + Send>) {
        *lock(&self.on_tick) = Some(hook);
    }

    /// Tests only: the next shutdown cannot start its helper thread.
    #[cfg(test)]
    pub(crate) fn fail_next_spawn(&self) {
        self.fail_spawn.store(true, Ordering::SeqCst);
    }

    /// Tests only: waits for the last folder check to finish.
    #[cfg(test)]
    pub(crate) fn wait_probe(&self) {
        let probe = lock(&self.probe_thread).take();
        if let Some(probe) = probe {
            probe.join().expect("the folder check ran");
        }
    }

    /// Starts a long operation the user asked for (an import, Save a copy, Open, a backup or a restore), shown to the
    /// page as `what` under `session` (`None`: an operation without one, such as testing or restoring a backup).
    /// Windows lock, sleep and app exit cancel `cancel`. Once the app is closing, `cancel` is cancelled at once and
    /// nothing is registered.
    pub fn begin(
        &self,
        session: Option<SessionId>,
        what: &'static str,
        cancel: CancelToken,
    ) -> LongOp {
        self.operations.begin(session, what, cancel)
    }

    /// The timer's call, every [`TICK`]: drops the expired pending choices, starts a check for vanished folders, and
    /// locks everything (opens under way and pending choices included) once the user has been idle for the idle
    /// time, once per idle period.
    pub fn tick(&self, now: Instant) {
        self.sessions.pending().sweep_at(now);
        self.start_probe();
        let since_input = self.idle.since_last_input();
        let limit = self.settings.get().idle_limit();
        #[cfg(test)]
        {
            let hook = lock(&self.on_tick).take();
            if let Some(hook) = hook {
                hook();
            }
        }
        // Decided and revoked under the operations' list, so no operation begins or ends in between.
        let mut running = lock(&self.operations.running);
        if running.idle_for(since_input, now) < limit {
            running.idle_locked = false;
            return;
        }
        if running.idle_locked || self.operations.closed.load(Ordering::SeqCst) {
            return;
        }
        running.idle_locked = true;
        // The hooks are queued, not waited for: a blocked one must not stop the next tick.
        let _ = self.sessions.revoke_all(LockReason::Idle);
    }

    /// Checks, on a thread of its own, that each unlocked session's folder is still there, and locks as unavailable
    /// each one that is not (a folder whose existence cannot be read counts as gone). One check at a time: while one
    /// stalls, only finding vanished folders waits.
    /// The sessions checked are those unlocked at the tick, each in the generation it had then: a session locked and
    /// unlocked again since is left alone. Every vanished one is revoked in one step, and nothing waits for hooks.
    fn start_probe(&self) {
        let unlocked = self.sessions.unlocked();
        if unlocked.is_empty() || self.probing.swap(true, Ordering::SeqCst) {
            return;
        }
        let (sessions, volumes) = (Arc::clone(&self.sessions), Arc::clone(&self.volumes));
        let done = DoneProbing(Arc::clone(&self.probing));
        let probe = thread::Builder::new()
            .name("lockbox-folder-check".into())
            .spawn(move || {
                let _done = done;
                let gone: Vec<(SessionId, Option<u64>)> = unlocked
                    .into_iter()
                    .filter(|(_, _, location)| !matches!(volumes.exists(location.path()), Ok(true)))
                    .map(|(id, generation, _)| (id, Some(generation)))
                    .collect();
                if !gone.is_empty() {
                    let _ = sessions.revoke_some(&gone, LockReason::DriveGone);
                }
            });
        // A thread that cannot start drops `done`, so the next tick tries again.
        #[cfg(test)]
        if let Ok(probe) = probe {
            *lock(&self.probe_thread) = Some(probe);
        }
        #[cfg(not(test))]
        drop(probe);
    }

    /// A Windows signal (spec §7.4 and §6.10).
    pub fn signal(&self, signal: OsSignal) {
        match signal {
            OsSignal::SessionLocked => self.lock_now(LockReason::WindowsLocked),
            OsSignal::Suspending => self.lock_now(LockReason::Sleep),
            OsSignal::DriveRemoved { mask } => {
                // Every vault on the drive in one step; the hooks are queued, not waited for.
                let gone: Vec<(SessionId, Option<u64>)> = self
                    .sessions
                    .unlocked()
                    .into_iter()
                    .filter(|(_, _, location)| drive_bit(location.path()) & mask != 0)
                    .map(|(id, generation, _)| (id, Some(generation)))
                    .collect();
                if !gone.is_empty() {
                    let _ = self.sessions.revoke_some(&gone, LockReason::DriveGone);
                }
            }
            OsSignal::Ending => self.shutdown(),
        }
    }

    /// Windows lock and sleep: cancels every long operation and revokes every vault in one step (no operation begins
    /// in between). The hooks are queued, not waited for: a blocked one must not stop the next signal.
    fn lock_now(&self, reason: LockReason) {
        let running = lock(&self.operations.running);
        running.cancel_all();
        let _ = self.sessions.revoke_all(reason);
    }

    /// Closing the app ([`Shell::shutdown`](crate::shell::Shell::shutdown)). The first call shuts the closing gates at
    /// once (no open and no long operation is admitted after it), then finishes on a helper thread: every long
    /// operation cancelled, every vault revoked, then the hooks. Every call returns once every vault is revoked and the hooks are done, or at [`SHUTDOWN_WAIT`] after
    /// it was made, whichever comes first; the hooks get no longer than the first call's deadline. If the helper
    /// thread cannot start, the vaults are revoked here (which never waits for a hook) and the hooks are skipped.
    pub(crate) fn shutdown(&self) {
        let deadline = Instant::now() + SHUTDOWN_WAIT;
        let mut first = false;
        self.closing.update(|phase| {
            first = phase.hooks_deadline.is_none();
            phase.hooks_deadline.get_or_insert(deadline);
        });
        if first {
            // Before anything else, and without waiting for any lock: the gates are read where opens and operations
            // register and publish.
            self.sessions.shut();
            self.operations.shut();
            self.start_closing();
        }
        self.closing.wait(deadline, |phase| phase.revoked);
        let hooks_deadline = lock(&self.closing.phase).hooks_deadline.unwrap_or(deadline);
        self.closing
            .wait(hooks_deadline.min(deadline), |phase| phase.done);
    }

    fn start_closing(&self) {
        let (sessions, operations, closing) = (
            Arc::clone(&self.sessions),
            Arc::clone(&self.operations),
            Arc::clone(&self.closing),
        );
        #[cfg(test)]
        let on_helper = Arc::clone(&self.on_helper);
        let helper = move || {
            #[cfg(test)]
            {
                let hook = lock(&on_helper).take();
                if let Some(hook) = hook {
                    hook();
                }
            }
            let _done = MarkDone(Arc::clone(&closing));
            operations.close();
            let hooks = sessions.close(true);
            closing.update(|phase| phase.revoked = true);
            if let Some(hooks) = hooks {
                hooks.wait();
            }
        };
        #[cfg(test)]
        let spawned = match self.fail_spawn.load(Ordering::SeqCst) {
            true => Err(std::io::Error::other("no thread")),
            false => thread::Builder::new()
                .name("lockbox-closing".into())
                .spawn(helper),
        };
        #[cfg(not(test))]
        let spawned = thread::Builder::new()
            .name("lockbox-closing".into())
            .spawn(helper);
        if spawned.is_err() {
            self.operations.close();
            // No hook is queued, so none is waited for. Not bounded by the deadline: the revocation waits for a publish
            // attempt under way (one rename or clipboard write). That needs Windows to refuse a thread at exit while a
            // rename stalls; it costs a slow exit, never an open vault, and a deadline here would need a second lock
            // path (fix round 2, controller ruling).
            let _ = self.sessions.close(false);
            self.closing.update(|phase| {
                phase.revoked = true;
                phase.done = true;
            });
        }
    }
}

/// The bit of the drive `path` is on in a `DriveRemoved` mask (bit 0 for A:), or 0 for a path without a drive letter
/// (a volume mounted in a folder: the folder check finds it gone).
fn drive_bit(path: &Path) -> u32 {
    let Some(Component::Prefix(prefix)) = path.components().next() else {
        return 0;
    };
    match prefix.kind() {
        Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) if letter.is_ascii_alphabetic() => {
            1 << (letter.to_ascii_uppercase() - b'A')
        }
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::panic::{AssertUnwindSafe, catch_unwind};
    use std::path::PathBuf;
    use std::sync::atomic::AtomicUsize;
    use std::sync::mpsc;

    use lockbox_core::Vault;
    use lockbox_core::internals::fsio::failpoint;
    use lockbox_core::internals::lockfile::VaultLock;
    use zeroize::Zeroizing;

    use super::*;
    use crate::error::{Outcome, ShellError};
    use crate::lock;
    use crate::pending::PendingChoice;
    use crate::session::{Location, LockReason, OpenStep, Opened, SessionState};
    use crate::settings::Settings;
    use crate::testing::{TestShell, heavy};

    const PW: &str = "correct horse battery";
    const MIB: usize = 1024 * 1024;
    /// How long a blocked hook waits for the test before it gives up, so a failing test cannot hang.
    const GIVE_UP: Duration = Duration::from_secs(60);
    /// How long a test waits for something that should happen at once (another thread's step) before it fails.
    const PATIENCE: Duration = Duration::from_secs(10);
    /// What a shutdown may take past [`SHUTDOWN_WAIT`]: waking from its wait, and the test thread being scheduled
    /// again, on a loaded machine.
    const SCHEDULING_MARGIN: Duration = Duration::from_millis(250);

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

    /// Whether nothing holds the vault in `dir` (its key is dropped with it): its `.lock` is free.
    fn is_free(dir: &Path) -> bool {
        VaultLock::acquire(dir).is_ok()
    }

    /// A lock hook that counts its runs.
    fn count_hooks(ts: &TestShell) -> Arc<AtomicUsize> {
        let runs = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&runs);
        ts.shell.sessions.on_lock(Box::new(move |_, _| {
            counted.fetch_add(1, Ordering::SeqCst);
        }));
        runs
    }

    /// `minutes:seconds` as a duration.
    fn at(minutes: u64, seconds: u64) -> Duration {
        Duration::from_secs(minutes * 60 + seconds)
    }

    /// A new vault named `name`, created and unlocked through the shell (and so on the vault list): its session.
    fn open_vault(ts: &TestShell, name: &str) -> SessionId {
        let password = Zeroizing::new(PW.to_owned());
        let created = heavy(|| ts.shell.create_vault(name.into(), password, false));
        let Ok(Outcome::Done(tagged)) = created else {
            panic!("the vault did not open");
        };
        tagged.session
    }

    fn state(ts: &TestShell, id: SessionId) -> SessionState {
        ts.shell
            .sessions
            .list()
            .into_iter()
            .find(|info| info.session == id)
            .expect("the session is listed")
            .state
    }

    /// Each session that locked, with its reason, in order.
    fn locks(ts: &TestShell) -> Vec<(SessionId, LockReason)> {
        ts.events
            .locked()
            .into_iter()
            .map(|(id, _, reason)| (id, reason))
            .collect()
    }

    /// The folder of the `n`th vault on the vault list.
    fn vault_dir(ts: &TestShell, n: usize) -> PathBuf {
        ts.shell.registry.entries()[n].1.clone()
    }

    #[test]
    fn locks_after_idle_setting() {
        let ts = TestShell::new();
        let family = open_vault(&ts, "Family");
        let autolock = &ts.shell.autolock;
        let t0 = ts.clock.now();

        ts.idle.set(at(4, 59));
        autolock.tick(t0 + at(4, 59));
        assert_eq!(state(&ts, family), SessionState::Unlocked);
        ts.idle.set(at(5, 0));
        autolock.tick(t0 + at(5, 0));
        assert_eq!(state(&ts, family), SessionState::Locked);
        assert_eq!(locks(&ts), [(family, LockReason::Idle)]);

        // A new setting counts from the next tick.
        ts.shell
            .settings
            .set(crate::settings::Settings {
                idle_minutes: 1,
                ..ts.shell.settings.get()
            })
            .unwrap();
        let work = open_vault(&ts, "Work");
        ts.idle.set(at(0, 59));
        autolock.tick(t0 + at(6, 0));
        assert_eq!(state(&ts, work), SessionState::Unlocked);
        ts.idle.set(at(1, 0));
        autolock.tick(t0 + at(6, 1));
        assert_eq!(state(&ts, work), SessionState::Locked);
    }

    #[test]
    fn long_operation_pauses_idle() {
        let ts = TestShell::new();
        let family = open_vault(&ts, "Family");
        let autolock = &ts.shell.autolock;
        let t0 = ts.clock.now();

        let import = autolock.begin(Some(family), "import", CancelToken::new());
        let restore = autolock.begin(None, "restore", CancelToken::new());
        for minute in [5, 10, 30] {
            ts.idle.set(at(minute, 0));
            autolock.tick(t0 + at(minute, 0));
            assert_eq!(state(&ts, family), SessionState::Unlocked, "{minute} min");
        }
        assert_eq!(ts.power.calls(), [true], "asked once to stay awake");
        // `lockbox://busy` lists each session's operations, `null` for one without a session.
        drop(import);
        drop(restore);
        assert_eq!(
            ts.events.busy(),
            [
                (Some(family), vec!["import"]),
                (None, vec!["restore"]),
                (Some(family), vec![]),
                (None, vec![]),
            ]
        );
    }

    #[test]
    fn idle_counts_from_end_of_long_operation() {
        let ts = TestShell::new();
        let family = open_vault(&ts, "Family");
        let autolock = &ts.shell.autolock;
        let t0 = ts.clock.now();

        let backup = autolock.begin(Some(family), "backup", CancelToken::new());
        ts.clock.set(t0 + at(30, 0));
        drop(backup);
        // No input since the start: only the time since the operation ended counts.
        ts.idle.set(at(34, 59));
        autolock.tick(t0 + at(34, 59));
        assert_eq!(state(&ts, family), SessionState::Unlocked);
        ts.idle.set(at(35, 0));
        autolock.tick(t0 + at(35, 0));
        assert_eq!(state(&ts, family), SessionState::Locked);
        assert_eq!(locks(&ts), [(family, LockReason::Idle)]);
    }

    #[test]
    fn windows_lock_cancels_long_operations() {
        let ts = TestShell::new();
        let family = open_vault(&ts, "Family");
        let autolock = &ts.shell.autolock;
        // Tokens of their own, not the session's: only the auto-lock can cancel them.
        let (import, restore) = (CancelToken::new(), CancelToken::new());
        let _import = autolock.begin(Some(family), "import", import.clone());
        let _restore = autolock.begin(None, "restore", restore.clone());

        autolock.signal(OsSignal::SessionLocked);
        assert!(import.is_cancelled(), "the import's token is cancelled");
        assert!(
            restore.is_cancelled(),
            "a restore before its swap is cancelled"
        );
        assert_eq!(state(&ts, family), SessionState::Locked);
        assert_eq!(locks(&ts), [(family, LockReason::WindowsLocked)]);
    }

    #[test]
    fn sleep_locks_all() {
        let ts = TestShell::new();
        let family = open_vault(&ts, "Family");
        let work = open_vault(&ts, "Work");
        let backup = CancelToken::new();
        let _backup = ts
            .shell
            .autolock
            .begin(Some(work), "backup", backup.clone());

        ts.shell.autolock.signal(OsSignal::Suspending);
        assert!(backup.is_cancelled());
        assert_eq!(state(&ts, family), SessionState::Locked);
        assert_eq!(state(&ts, work), SessionState::Locked);
        let mut locked = locks(&ts);
        locked.sort_by_key(|(id, _)| id.0);
        assert_eq!(
            locked,
            [(family, LockReason::Sleep), (work, LockReason::Sleep)]
        );
    }

    #[test]
    fn vanished_folder_locks_as_unavailable() {
        let ts = TestShell::new();
        let family = open_vault(&ts, "Family");
        let work = open_vault(&ts, "Work");
        let autolock = &ts.shell.autolock;
        let (family_dir, work_dir) = (vault_dir(&ts, 0), vault_dir(&ts, 1));

        // The folder is gone at the next tick: that vault alone locks, as unavailable.
        ts.volumes.vanish(&family_dir);
        autolock.tick(ts.clock.now());
        autolock.wait_probe();
        assert_eq!(state(&ts, family), SessionState::Unavailable);
        assert_eq!(state(&ts, work), SessionState::Unlocked);
        assert_eq!(locks(&ts), [(family, LockReason::DriveGone)]);

        // A drive removed: only the vaults on it lock.
        let bit = drive_bit(&work_dir);
        assert_eq!(bit.count_ones(), 1, "the folder is on a lettered drive");
        autolock.signal(OsSignal::DriveRemoved { mask: !bit });
        assert_eq!(state(&ts, work), SessionState::Unlocked);
        autolock.signal(OsSignal::DriveRemoved { mask: bit });
        assert_eq!(state(&ts, work), SessionState::Unavailable);
        assert_eq!(
            locks(&ts),
            [
                (family, LockReason::DriveGone),
                (work, LockReason::DriveGone)
            ]
        );

        // Both stay on the vault list, the vanished one shown as not available.
        let listed = ts.shell.registry.list().unwrap();
        assert_eq!(listed.len(), 2);
        assert!(!listed[0].available);
        assert!(listed[1].available);
    }

    /// A `DriveRemoved` mask has bit 0 for A:; a location without a drive letter has no bit (the tick finds it).
    #[test]
    fn drive_bit_table() {
        let table = [
            (r"\\?\C:\Lockbox Vaults\Family", 1 << 2),
            (r"\\?\d:\Family", 1 << 3),
            (r"C:\Family", 1 << 2),
            (r"\\?\A:\", 1),
            (r"\\?\Z:\Family", 1 << 25),
            (
                r"\\?\Volume{8c3f0e1a-0000-0000-0000-100000000000}\Family",
                0,
            ),
            (r"\\?\UNC\server\share\Family", 0),
            (r"\\server\share\Family", 0),
            (r"Family", 0),
        ];
        for (path, bit) in table {
            assert_eq!(drive_bit(Path::new(path)), bit, "{path}");
        }
    }

    #[test]
    fn keep_awake_off_when_last_op_ends() {
        let ts = TestShell::new();
        let autolock = &ts.shell.autolock;
        let first = autolock.begin(None, "backup", CancelToken::new());
        let second = autolock.begin(None, "restore", CancelToken::new());
        assert_eq!(ts.power.calls(), [true]);
        drop(first);
        assert_eq!(ts.power.calls(), [true], "one operation still runs");
        drop(second);
        assert_eq!(ts.power.calls(), [true, false]);
        drop(autolock.begin(None, "backup", CancelToken::new()));
        assert_eq!(ts.power.calls(), [true, false, true, false]);
    }

    /// Fix from Task 8's review: an abandoned choice (it may hold a typed password or an unlocked vault's `.lock`) is
    /// dropped within one tick of its five minutes, even while the user stays active and nothing else is confirmed.
    #[test]
    fn tick_drops_expired_choices() {
        let ts = TestShell::new();
        let pending = ts.shell.sessions.pending();
        let parked_at = Instant::now();
        let _token = pending.put(PendingChoice::Test(None));
        let expires = Instant::now() + at(5, 0);
        ts.shell.autolock.tick(parked_at + at(4, 59));
        assert_eq!(pending.len(), 1, "not expired yet");
        ts.shell.autolock.tick(expires);
        assert_eq!(pending.len(), 0, "dropped by the tick");
    }

    #[test]
    fn shutdown_locks_and_runs_hooks() {
        // Hooks that return: every vault locked, every hook run with `None` (all), operations cancelled.
        let ts = TestShell::new();
        let family = open_vault(&ts, "Family");
        let ran = Arc::new(Mutex::new(Vec::new()));
        for name in ["clipboard", "open"] {
            let ran = Arc::clone(&ran);
            ts.shell.sessions.on_lock(Box::new(move |only, reason| {
                lock(&ran).push((name, only, reason))
            }));
        }
        let restore = CancelToken::new();
        let _restore = ts.shell.autolock.begin(None, "restore", restore.clone());
        let started = Instant::now();
        ts.shell.shutdown();
        assert!(started.elapsed() < SHUTDOWN_WAIT);
        assert_eq!(state(&ts, family), SessionState::Locked);
        assert_eq!(locks(&ts), [(family, LockReason::AppClosing)]);
        assert_eq!(
            *lock(&ran),
            [
                ("clipboard", None, LockReason::AppClosing),
                ("open", None, LockReason::AppClosing)
            ]
        );
        assert!(restore.is_cancelled());

        // A hook that blocks: the shutdown still returns after at most its wait, with every vault locked.
        let ts = TestShell::new();
        let family = open_vault(&ts, "Family");
        let (release, released) = mpsc::channel::<()>();
        let released = Mutex::new(released);
        ts.shell.sessions.on_lock(Box::new(move |_, _| {
            let _ = lock(&released).recv_timeout(GIVE_UP);
        }));
        let started = Instant::now();
        ts.shell.shutdown();
        let took = started.elapsed();
        assert!(took >= SHUTDOWN_WAIT, "it waited for the hook ({took:?})");
        assert!(
            took < SHUTDOWN_WAIT + SCHEDULING_MARGIN,
            "it stopped waiting ({took:?})"
        );
        assert_eq!(state(&ts, family), SessionState::Locked);

        // Called again (the window's close request, then the app's exit): it returns at once.
        let again = Instant::now();
        ts.shell.shutdown();
        assert!(again.elapsed() < SHUTDOWN_WAIT / 2);
        release.send(()).unwrap();
    }

    #[test]
    fn lock_during_import_deletes_partial() {
        let ts = TestShell::new();
        let family = open_vault(&ts, "Family");
        let generation = ts.shell.sessions.list()[0].generation;
        let files = vault_dir(&ts, 0).join("files");
        let src = ts.temp.path().join("scan.bin");
        fs::write(&src, vec![7u8; 8 * MIB]).unwrap();

        // Windows locks once the file is encrypted to `.partial`, just before it would be published.
        let shell = Arc::clone(&ts.shell);
        let partial_seen = Arc::new(Mutex::new(false));
        let seen = Arc::clone(&partial_seen);
        let files_at_lock = files.clone();
        failpoint::observe(
            "import.before_publish",
            Box::new(move || {
                *lock(&seen) = partials(&files_at_lock) == 1;
                shell.autolock.signal(OsSignal::SessionLocked);
            }),
        );
        let answer = ts
            .shell
            .sessions
            .write_long(family, generation, |vault, cancel| {
                let _import = ts
                    .shell
                    .autolock
                    .begin(Some(family), "import", cancel.clone());
                Ok(vault.new_file_item(None, &src, cancel)?)
            });
        failpoint::disarm_all();

        assert!(
            *lock(&partial_seen),
            "the lock came with the .partial on disk"
        );
        assert_eq!(answer.err(), Some(ShellError::Locked));
        assert_eq!(partials(&files), 0, "the .partial is deleted");
        assert!(
            ts.shell.sessions.release_wait(family, GIVE_UP),
            "the vault and its key are released"
        );
    }

    /// How many `*.partial` files are in `files`.
    fn partials(files: &Path) -> usize {
        fs::read_dir(files)
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".partial")
            })
            .count()
    }

    /// Fix round 1 (2): a lock whose hook blocks (vault A's) never keeps another vault (B) unlocked: Windows lock,
    /// sleep and the app's exit each revoke B at once, whatever A's hook is doing.
    fn blocked_hook_case(what: &str, trigger: fn(&TestShell)) {
        let ts = TestShell::new();
        let family = open_vault(&ts, "Family");
        let work = open_vault(&ts, "Work");
        let (entered, hook_entered) = mpsc::channel();
        let entered = Mutex::new(entered);
        let (release, released) = mpsc::channel::<()>();
        let released = Mutex::new(released);
        ts.shell.sessions.on_lock(Box::new(move |only, _| {
            if only == Some(family) {
                let _ = lock(&entered).send(());
                let _ = lock(&released).recv_timeout(GIVE_UP);
            }
        }));
        let revoked = thread::scope(|s| {
            s.spawn(|| ts.shell.sessions.lock(family, LockReason::Manual));
            hook_entered
                .recv_timeout(GIVE_UP)
                .expect("the first lock's hook runs");
            let triggering = s.spawn(|| trigger(&ts));
            let revoked = wait_until(PATIENCE, || state(&ts, work) == SessionState::Locked)
                && ts.shell.sessions.release_wait(work, GIVE_UP);
            release.send(()).unwrap();
            triggering.join().unwrap();
            revoked
        });
        assert!(revoked, "{what}: the other vault was revoked at once");
    }

    #[test]
    fn blocked_hook_never_delays_other_vaults() {
        blocked_hook_case("Windows lock", |ts| {
            ts.shell.autolock.signal(OsSignal::SessionLocked)
        });
        blocked_hook_case("sleep", |ts| ts.shell.autolock.signal(OsSignal::Suspending));
        blocked_hook_case("app exit", |ts| ts.shell.shutdown());
    }

    /// Fix round 1 (3): once the app is closing, no vault opens and no long operation runs (`begin` hands back its
    /// token cancelled).
    #[test]
    fn closing_refuses_new_work() {
        let ts = TestShell::new();
        ts.shell.shutdown();
        let ran = AtomicBool::new(false);
        let answer = ts.shell.sessions.open::<()>(None, None, |_| {
            ran.store(true, Ordering::SeqCst);
            Err(ShellError::InvalidInput { what: "folder" })
        });
        assert_eq!(answer.err(), Some(ShellError::Locked));
        assert!(!ran.load(Ordering::SeqCst), "the open never ran");

        let restore = CancelToken::new();
        let _restore = ts.shell.autolock.begin(None, "restore", restore.clone());
        assert!(restore.is_cancelled(), "a late operation is cancelled");
        assert!(ts.power.calls().is_empty(), "nothing is kept awake");
        assert!(ts.events.busy().is_empty(), "nothing is shown as running");
    }

    /// Fix round 1 (3, 7): two shutdowns at once (the window's close request and Windows ending the session) each
    /// return only once every vault is revoked, or at their own deadline. Here a publish attempt holds the revocation
    /// back past both deadlines.
    #[test]
    fn concurrent_shutdowns_wait_for_revocation() {
        let ts = TestShell::new();
        let family = open_vault(&ts, "Family");
        let generation = ts.shell.sessions.list()[0].generation;
        let dir = vault_dir(&ts, 0);
        let (entered, publishing_entered) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        let released = Mutex::new(released);
        let results = thread::scope(|s| {
            let publishing = s.spawn(|| {
                ts.shell.sessions.publish(family, generation, || {
                    entered.send(()).unwrap();
                    let _ = lock(&released).recv_timeout(GIVE_UP);
                    Ok(())
                })
            });
            publishing_entered.recv_timeout(GIVE_UP).unwrap();
            let shutdown = || {
                let started = Instant::now();
                ts.shell.shutdown();
                (started.elapsed(), is_free(&dir))
            };
            let callers = [s.spawn(shutdown), s.spawn(shutdown)];
            let results = callers.map(|caller| caller.join().unwrap());
            release.send(()).unwrap();
            publishing.join().unwrap().unwrap();
            results
        });
        for (took, revoked) in results {
            assert!(
                revoked || took >= SHUTDOWN_WAIT,
                "returned after {took:?} with the vault still open"
            );
            assert!(took < SHUTDOWN_WAIT + SCHEDULING_MARGIN, "{took:?}");
        }
        assert_eq!(state(&ts, family), SessionState::Locked);
    }

    /// Fix round 1 (7): a hook that panics neither stretches the shutdown nor stops the hooks after it.
    #[test]
    fn shutdown_survives_a_panicking_hook() {
        let ts = TestShell::new();
        let family = open_vault(&ts, "Family");
        ts.shell
            .sessions
            .on_lock(Box::new(|_, _| panic!("a hook failed")));
        let after = count_hooks(&ts);
        let started = Instant::now();
        ts.shell.shutdown();
        assert!(started.elapsed() < SHUTDOWN_WAIT + SCHEDULING_MARGIN);
        assert_eq!(state(&ts, family), SessionState::Locked);
        assert_eq!(after.load(Ordering::SeqCst), 1, "the next hook still ran");
    }

    /// Fix round 1 (7): one deadline from entry bounds the whole shutdown, also while a notifier blocks an operation's
    /// start (which held the operations mutex before this round).
    #[test]
    fn shutdown_bound_holds_under_operation_contention() {
        let ts = TestShell::new();
        let family = open_vault(&ts, "Family");
        let (entered, notifier_entered) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        ts.events.during_next_busy(Box::new(move || {
            entered.send(()).unwrap();
            let _ = released.recv_timeout(PATIENCE);
        }));
        let import = CancelToken::new();
        let took = thread::scope(|s| {
            let beginning = s.spawn(|| {
                drop(
                    ts.shell
                        .autolock
                        .begin(Some(family), "import", import.clone()),
                );
            });
            notifier_entered.recv_timeout(GIVE_UP).unwrap();
            let started = Instant::now();
            ts.shell.shutdown();
            let took = started.elapsed();
            let _ = release.send(());
            beginning.join().unwrap();
            took
        });
        assert!(took < SHUTDOWN_WAIT + SCHEDULING_MARGIN, "{took:?}");
        assert_eq!(state(&ts, family), SessionState::Locked);
        assert!(import.is_cancelled());
    }

    /// Fix round 1 (3, 7): with no helper thread, every vault is still revoked (inline, bounded) and the hooks are
    /// skipped.
    #[test]
    fn shutdown_without_helper_revokes_inline() {
        let ts = TestShell::new();
        let family = open_vault(&ts, "Family");
        let hooks = count_hooks(&ts);
        let restore = CancelToken::new();
        let _restore = ts.shell.autolock.begin(None, "restore", restore.clone());
        ts.shell.autolock.fail_next_spawn();
        let started = Instant::now();
        ts.shell.shutdown();
        assert!(started.elapsed() < SHUTDOWN_WAIT + SCHEDULING_MARGIN);
        assert_eq!(state(&ts, family), SessionState::Locked);
        assert!(ts.shell.sessions.release_wait(family, GIVE_UP));
        assert!(restore.is_cancelled());
        assert_eq!(hooks.load(Ordering::SeqCst), 0, "no hook ran");
    }

    /// Fix round 1 (4): idle locks an open under way and the pending choices too, with no vault unlocked; one lock per
    /// idle period, and a new one after input.
    #[test]
    fn idle_locks_opens_and_pending_once_per_period() {
        let ts = TestShell::new();
        let hooks = count_hooks(&ts);
        let pending = ts.shell.sessions.pending();
        let _token = pending.put(PendingChoice::Test(None));
        // Each tick at the real time now: only the fake idle time matters here, and no choice expires.
        let (inside, open_inside) = mpsc::channel();
        let (go, opened_may_go) = mpsc::channel::<()>();
        let opened_may_go = Mutex::new(opened_may_go);
        let answer = thread::scope(|s| {
            let opening = s.spawn(|| {
                ts.shell.sessions.open::<()>(None, None, |_| {
                    inside.send(()).unwrap();
                    let _ = lock(&opened_may_go).recv_timeout(GIVE_UP);
                    Err(ShellError::InvalidInput { what: "folder" })
                })
            });
            open_inside.recv_timeout(GIVE_UP).unwrap();
            ts.idle.set(at(5, 0));
            ts.shell.autolock.tick(Instant::now());
            go.send(()).unwrap();
            opening.join().unwrap()
        });
        assert_eq!(
            answer.err(),
            Some(ShellError::Locked),
            "the open is discarded"
        );
        assert_eq!(pending.len(), 0, "the pending choice is dropped");

        // Still idle: no second lock. A lock of all vaults drops every pending choice before it returns, so a choice
        // still parked shows that none ran (the hooks run later, on the hook thread).
        let _second = pending.put(PendingChoice::Test(None));
        ts.idle.set(at(5, 5));
        ts.shell.autolock.tick(Instant::now());
        assert_eq!(pending.len(), 1, "one lock per idle period");
        // Input, then idle again: a new lock.
        ts.idle.set(at(0, 1));
        ts.shell.autolock.tick(Instant::now());
        assert_eq!(pending.len(), 1, "input does not lock");
        ts.idle.set(at(5, 0));
        ts.shell.autolock.tick(Instant::now());
        assert_eq!(pending.len(), 0, "a new idle period locks again");
        assert!(
            wait_until(PATIENCE, || hooks.load(Ordering::SeqCst) == 2),
            "each of the two locks ran its hooks once"
        );
    }

    /// Fix round 1 (6): an operation that begins after the tick has read the idle time, but before it would lock,
    /// is respected.
    #[test]
    fn begin_during_tick_is_respected() {
        let ts = TestShell::new();
        let family = open_vault(&ts, "Family");
        let t0 = ts.clock.now();
        let import = CancelToken::new();
        let running = Arc::new(Mutex::new(None));
        let (shell, kept, token) = (Arc::clone(&ts.shell), Arc::clone(&running), import.clone());
        ts.shell.autolock.during_next_tick(Box::new(move || {
            *lock(&kept) = Some(shell.autolock.begin(Some(family), "import", token));
        }));
        ts.idle.set(at(5, 0));
        ts.shell.autolock.tick(t0 + at(5, 0));
        assert_eq!(state(&ts, family), SessionState::Unlocked);
        assert!(!import.is_cancelled());
        assert!(lock(&running).is_some());
    }

    /// Fix round 1 (6): an operation that begins and ends while the tick decides restarts the idle time.
    #[test]
    fn begin_and_end_during_tick_is_respected() {
        let ts = TestShell::new();
        let family = open_vault(&ts, "Family");
        let t0 = ts.clock.now();
        let (shell, clock) = (Arc::clone(&ts.shell), Arc::clone(&ts.clock));
        ts.shell.autolock.during_next_tick(Box::new(move || {
            clock.set(t0 + at(5, 0));
            drop(
                shell
                    .autolock
                    .begin(Some(family), "backup", CancelToken::new()),
            );
        }));
        ts.idle.set(at(5, 0));
        ts.shell.autolock.tick(t0 + at(5, 0));
        assert_eq!(state(&ts, family), SessionState::Unlocked);
    }

    /// Fix round 1 (5): a folder check that stalls (a drive not answering) never holds up the idle lock, and no
    /// second check starts while it stalls.
    #[test]
    fn blocked_probe_never_delays_idle() {
        let ts = TestShell::new();
        let family = open_vault(&ts, "Family");
        let t0 = ts.clock.now();
        let (release, released) = mpsc::channel::<()>();
        ts.volumes.during_next_exists(Box::new(move || {
            let _ = released.recv_timeout(GIVE_UP);
        }));
        let calls = ts.volumes.exists_calls();
        ts.idle.set(at(5, 0));
        let (done, tick_done) = mpsc::channel();
        let (returned, locked, probes) = thread::scope(|s| {
            let ticking = s.spawn(|| {
                ts.shell.autolock.tick(t0 + at(5, 0));
                done.send(()).unwrap();
            });
            let returned = tick_done.recv_timeout(PATIENCE).is_ok();
            let locked = state(&ts, family) == SessionState::Locked;
            let probing = wait_until(PATIENCE, || ts.volumes.exists_calls() == calls + 1);
            if returned {
                ts.shell.autolock.tick(t0 + at(5, 5));
            }
            let probes = ts.volumes.exists_calls() - calls;
            release.send(()).unwrap();
            ticking.join().unwrap();
            (returned, locked, probing.then_some(probes))
        });
        ts.shell.autolock.wait_probe();
        assert!(returned, "the tick did not wait for the folder check");
        assert!(locked, "the idle lock happened");
        assert_eq!(locks(&ts), [(family, LockReason::Idle)]);
        assert_eq!(probes, Some(1), "one folder check at a time");
    }

    /// Fix round 1 (5): a settings save that is slow to write never holds up the tick, which uses the settings in
    /// effect until the new ones are saved.
    #[test]
    fn settings_save_never_delays_tick() {
        let ts = TestShell::new();
        let family = open_vault(&ts, "Family");
        let t0 = ts.clock.now();
        ts.idle.set(at(5, 0));
        let returned = Arc::new(AtomicBool::new(false));
        let (shell, seen) = (Arc::clone(&ts.shell), Arc::clone(&returned));
        ts.shell.settings.during_next_save(Box::new(move || {
            let (done, tick_done) = mpsc::channel();
            thread::spawn(move || {
                shell.autolock.tick(t0 + at(5, 0));
                let _ = done.send(());
            });
            seen.store(tick_done.recv_timeout(PATIENCE).is_ok(), Ordering::SeqCst);
        }));
        ts.shell
            .settings
            .set(Settings {
                idle_minutes: 30,
                ..ts.shell.settings.get()
            })
            .unwrap();
        assert!(
            returned.load(Ordering::SeqCst),
            "the tick did not wait for the save"
        );
        assert_eq!(state(&ts, family), SessionState::Locked);
        assert_eq!(ts.shell.settings.get().idle_minutes, 30);
    }

    /// Fix round 1 (8): a notifier that panics while an operation begins leaves no operation behind to pause the idle
    /// time forever, and the keep-awake request is withdrawn.
    #[test]
    fn notifier_panic_in_begin_leaves_no_operation() {
        let ts = TestShell::new();
        let family = open_vault(&ts, "Family");
        let t0 = ts.clock.now();
        ts.events
            .during_next_busy(Box::new(|| panic!("the page could not be told")));
        let begun = catch_unwind(AssertUnwindSafe(|| {
            ts.shell
                .autolock
                .begin(Some(family), "import", CancelToken::new())
        }));
        assert!(begun.is_err(), "the panic reached the caller");
        assert_eq!(ts.power.calls(), [true, false]);
        ts.idle.set(at(5, 0));
        ts.shell.autolock.tick(t0 + at(5, 0));
        assert_eq!(state(&ts, family), SessionState::Locked);
    }

    /// Runs `work` on a thread of `scope` and tells whether it returned within [`PATIENCE`].
    fn returns_soon<'scope>(
        scope: &'scope thread::Scope<'scope, '_>,
        work: impl FnOnce() + Send + 'scope,
    ) -> bool {
        let (done, finished) = mpsc::channel();
        scope.spawn(move || {
            work();
            let _ = done.send(());
        });
        finished.recv_timeout(PATIENCE).is_ok()
    }

    /// A lock hook that blocks while it runs for `session`, until the returned sender sends (or [`GIVE_UP`]); the
    /// receiver hears when it starts blocking.
    fn block_hook(ts: &TestShell, session: SessionId) -> (mpsc::Sender<()>, mpsc::Receiver<()>) {
        let (entered, hook_entered) = mpsc::channel();
        let entered = Mutex::new(entered);
        let (release, released) = mpsc::channel::<()>();
        let released = Mutex::new(released);
        ts.shell.sessions.on_lock(Box::new(move |only, _| {
            if only == Some(session) {
                let _ = lock(&entered).send(());
                let _ = lock(&released).recv_timeout(GIVE_UP);
            }
        }));
        (release, hook_entered)
    }

    /// Fix round 2 (1): a drive with two vaults on it goes away while the first one's hook blocks: the second is
    /// revoked at once, and the trigger does not wait for the hook.
    fn drive_gone_case(what: &str, trigger: fn(&TestShell, u32)) {
        let ts = TestShell::new();
        let family = open_vault(&ts, "Family");
        let work = open_vault(&ts, "Work");
        let bit = drive_bit(&vault_dir(&ts, 0));
        let (release, _hook_entered) = block_hook(&ts, family);
        let (returned, revoked) = thread::scope(|s| {
            let returned = returns_soon(s, || trigger(&ts, bit));
            let revoked = state(&ts, work) == SessionState::Unavailable
                && ts.shell.sessions.release_wait(work, GIVE_UP);
            release.send(()).unwrap();
            (returned, revoked)
        });
        assert!(returned, "{what}: the trigger did not wait for the hook");
        assert!(revoked, "{what}: the second vault was revoked at once");
    }

    #[test]
    fn drive_gone_revokes_every_vault_on_it_despite_a_blocked_hook() {
        drive_gone_case("drive removed", |ts, bit| {
            ts.shell
                .autolock
                .signal(OsSignal::DriveRemoved { mask: bit })
        });
        drive_gone_case("folder check", |ts, _| {
            ts.volumes.vanish(&vault_dir(ts, 0));
            ts.volumes.vanish(&vault_dir(ts, 1));
            ts.shell.autolock.tick(ts.clock.now());
            ts.shell.autolock.wait_probe();
        });
    }

    /// Fix round 2 (1): while a hook blocks, later Windows locks and idle ticks still revoke vaults unlocked since,
    /// and the tick still drops expired choices: no trigger waits for a hook.
    #[test]
    fn blocked_hook_never_stalls_triggers() {
        let ts = TestShell::new();
        let family = open_vault(&ts, "Family");
        let t0 = ts.clock.now();
        let (release, hook_entered) = block_hook(&ts, family);
        let pending = ts.shell.sessions.pending();
        let results = thread::scope(|s| {
            s.spawn(|| ts.shell.sessions.lock(family, LockReason::Manual));
            hook_entered
                .recv_timeout(GIVE_UP)
                .expect("the first lock's hook runs");

            let work = open_vault(&ts, "Work");
            let signalled = returns_soon(s, || ts.shell.autolock.signal(OsSignal::SessionLocked));
            let work_locked = state(&ts, work) == SessionState::Locked;

            // Both ticks on one thread, as on the app's only timer thread: the second runs only if the first returns.
            let photos = open_vault(&ts, "Photos");
            ts.idle.set(at(5, 0));
            let (ticked_once, first_tick) = mpsc::channel();
            let (next, next_tick) = mpsc::channel::<Instant>();
            let (ticked_twice, second_tick) = mpsc::channel();
            let autolock = &ts.shell.autolock;
            s.spawn(move || {
                autolock.tick(t0 + at(5, 0));
                let _ = ticked_once.send(());
                if let Ok(later) = next_tick.recv_timeout(GIVE_UP) {
                    autolock.tick(later);
                    let _ = ticked_twice.send(());
                }
            });
            let ticked = first_tick.recv_timeout(PATIENCE).is_ok();
            let photos_locked = state(&ts, photos) == SessionState::Locked;

            let _token = pending.put(PendingChoice::Test(None));
            ts.idle.set(Duration::ZERO);
            let swept = ticked
                && next.send(Instant::now() + at(5, 0)).is_ok()
                && second_tick.recv_timeout(PATIENCE).is_ok()
                && pending.len() == 0;

            release.send(()).unwrap();
            [signalled, work_locked, ticked, photos_locked, swept]
        });
        assert_eq!(
            results, [true; 5],
            "[signal returned, vault locked, tick returned, vault locked, choice swept]"
        );
    }

    /// Fix round 2 (2): the closing gate shuts as the shutdown starts, before its helper has done anything: an open
    /// already running cannot publish, a new open is refused, and a new operation is cancelled.
    #[test]
    fn closing_gate_shuts_at_entry() {
        let ts = TestShell::new();
        let family = open_vault(&ts, "Family");
        let dir = vault_dir(&ts, 0);
        ts.shell.sessions.lock(family, LockReason::Manual);
        let vault = heavy(|| Vault::unlock_with_password(&dir, PW)).unwrap().0;
        let location = Location::folder(&dir).unwrap();
        let (entered, helper_entered) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        ts.shell.autolock.during_next_helper(Box::new(move || {
            entered.send(()).unwrap();
            let _ = released.recv_timeout(GIVE_UP);
        }));
        let (answer, freed, late_answer, late_ran, late_cancelled) = thread::scope(|s| {
            let answer = ts.shell.sessions.open(Some(location.clone()), None, |_| {
                // The app starts closing while this open runs; its helper waits.
                s.spawn(|| ts.shell.shutdown());
                helper_entered.recv_timeout(GIVE_UP).unwrap();
                Ok(OpenStep::Session(
                    location.clone(),
                    Opened::Writable(vault),
                    (),
                ))
            });
            let freed = is_free(&dir);
            let late_ran = AtomicBool::new(false);
            let late_answer = ts.shell.sessions.open::<()>(None, None, |_| {
                late_ran.store(true, Ordering::SeqCst);
                Err(ShellError::InvalidInput { what: "folder" })
            });
            let restore = CancelToken::new();
            let _restore = ts.shell.autolock.begin(None, "restore", restore.clone());
            let late_cancelled = restore.is_cancelled();
            release.send(()).unwrap();
            (
                answer.err(),
                freed,
                late_answer.err(),
                late_ran.load(Ordering::SeqCst),
                late_cancelled,
            )
        });
        assert_eq!(
            answer,
            Some(ShellError::Locked),
            "the running open did not publish"
        );
        assert!(freed, "its vault was dropped");
        assert_eq!(
            late_answer,
            Some(ShellError::Locked),
            "a new open is refused"
        );
        assert!(!late_ran, "the new open never ran");
        assert!(late_cancelled, "a new operation is cancelled");
    }

    /// Fix round 2 (3): a folder check that stalls, then answers "gone" after the vault was locked and unlocked again,
    /// leaves the new unlock alone.
    #[test]
    fn stale_folder_result_spares_a_new_unlock() {
        let ts = TestShell::new();
        let family = open_vault(&ts, "Family");
        let dir = vault_dir(&ts, 0);
        let id = ts.shell.registry.entries()[0].0;
        let (entered, probe_entered) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        ts.volumes.during_next_exists(Box::new(move || {
            entered.send(()).unwrap();
            let _ = released.recv_timeout(GIVE_UP);
        }));
        ts.shell.autolock.tick(ts.clock.now());
        probe_entered.recv_timeout(GIVE_UP).unwrap();
        ts.shell.sessions.lock(family, LockReason::Manual);
        let reopened = heavy(|| ts.shell.unlock_vault(id, Zeroizing::new(PW.to_owned()))).unwrap();
        ts.volumes.vanish(&dir);
        release.send(()).unwrap();
        ts.shell.autolock.wait_probe();
        assert_eq!(reopened.session, family);
        assert_eq!(state(&ts, family), SessionState::Unlocked);
        assert_eq!(ts.shell.sessions.list()[0].generation, reopened.generation);
    }
}
