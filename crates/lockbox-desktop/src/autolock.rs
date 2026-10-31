//! Locking without the user asking (spec §7.4 and §6.10): after the idle time, on Windows lock, sleep and hibernate,
//! when a vault's folder or drive goes away, and when the app closes. Long operations pause the idle time and keep
//! the PC awake while they run ([`AutoLock::begin`]).
//!
//! Nothing here runs on the signal window's thread: the app's signal receiver calls [`AutoLock::signal`], and a
//! timer thread calls [`AutoLock::tick`] every [`TICK`].

use std::path::{Component, Path, Prefix};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
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

/// The longest [`AutoLock::shutdown`] waits for the lock and its hooks before the process may exit.
pub const SHUTDOWN_WAIT: Duration = Duration::from_secs(2);

/// Locks the vaults on idle, Windows' signals, vanished folders and app exit.
pub struct AutoLock {
    sessions: Arc<Sessions>,
    settings: Arc<SettingsStore>,
    volumes: Arc<dyn Volumes>,
    idle: Arc<dyn IdleSource>,
    operations: Arc<Operations>,
    /// Set by the first [`shutdown`](Self::shutdown).
    closing: AtomicBool,
}

/// The long operations under way, shared with each [`LongOp`].
struct Operations {
    running: Mutex<Running>,
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
}

struct Operation {
    id: u64,
    session: Option<SessionId>,
    what: &'static str,
    cancel: CancelToken,
}

/// A long operation under way ([`AutoLock::begin`]): while any exists, idle time does not count and the PC is kept
/// awake. Dropping it ends the operation.
pub struct LongOp {
    id: u64,
    session: Option<SessionId>,
    operations: Arc<Operations>,
}

impl Drop for LongOp {
    fn drop(&mut self) {
        self.operations.end(self.id, self.session);
    }
}

impl Operations {
    /// Keep-awake requests and busy events are made under the lock, so they reach Windows and the page in the order
    /// the operations started and ended.
    fn begin(&self, session: Option<SessionId>, what: &'static str, cancel: CancelToken) -> u64 {
        let mut running = lock(&self.running);
        running.last_id += 1;
        let id = running.last_id;
        if running.operations.is_empty() {
            self.power.keep_awake(true);
        }
        running.operations.push(Operation {
            id,
            session,
            what,
            cancel,
        });
        self.announce(&running, session);
        id
    }

    fn end(&self, id: u64, session: Option<SessionId>) {
        let mut running = lock(&self.running);
        running.operations.retain(|operation| operation.id != id);
        running.last_end = Some(self.clock.now());
        if running.operations.is_empty() {
            self.power.keep_awake(false);
        }
        self.announce(&running, session);
    }

    /// `lockbox://busy`: the operations now running for `session` (or without one).
    fn announce(&self, running: &Running, session: Option<SessionId>) {
        let names: Vec<&'static str> = running
            .operations
            .iter()
            .filter(|operation| operation.session == session)
            .map(|operation| operation.what)
            .collect();
        self.notifier.busy(session, &names);
    }

    fn cancel_all(&self) {
        for operation in &lock(&self.running).operations {
            operation.cancel.cancel();
        }
    }

    /// How long the user has been idle at `now`, given `since_input`: none while an operation runs, else counted at
    /// most from the end of the last one.
    fn idle_for(&self, since_input: Duration, now: Instant) -> Duration {
        let running = lock(&self.running);
        if !running.operations.is_empty() {
            return Duration::ZERO;
        }
        match running.last_end {
            Some(end) => since_input.min(now.saturating_duration_since(end)),
            None => since_input,
        }
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
                power: Arc::clone(&os.power),
                clock: Arc::clone(&os.clock),
                notifier,
            }),
            closing: AtomicBool::new(false),
        }
    }

    /// Starts a long operation the user asked for (an import, Save a copy, Open, a backup or a restore), shown to the
    /// page as `what` under `session` (`None`: an operation without one, such as testing or restoring a backup).
    /// Windows lock, sleep and app exit cancel `cancel`.
    pub fn begin(
        &self,
        session: Option<SessionId>,
        what: &'static str,
        cancel: CancelToken,
    ) -> LongOp {
        LongOp {
            id: self.operations.begin(session, what, cancel),
            session,
            operations: Arc::clone(&self.operations),
        }
    }

    /// The timer's call, every [`TICK`]: drops the expired pending choices, locks as unavailable each vault whose
    /// folder is gone, then locks every vault once the user has been idle for the idle time.
    pub fn tick(&self, now: Instant) {
        self.sessions.pending().sweep_at(now);
        // Before the idle check, so a vault that is gone is shown as unavailable rather than locked.
        for (id, location) in self.sessions.locations() {
            // A folder whose existence cannot be read is taken for gone: the vault cannot be reached either.
            if !matches!(self.volumes.exists(location.path()), Ok(true)) {
                self.sessions.lock(id, LockReason::DriveGone);
            }
        }
        let idle = self.operations.idle_for(self.idle.since_last_input(), now);
        // Only with a vault to lock: a lock of all vaults also cancels opens under way and runs the lock hooks.
        if idle >= self.settings.get().idle_limit() && !self.sessions.locations().is_empty() {
            self.sessions.lock_all(LockReason::Idle);
        }
    }

    /// A Windows signal (spec §7.4 and §6.10).
    pub fn signal(&self, signal: OsSignal) {
        match signal {
            OsSignal::SessionLocked => self.lock_now(LockReason::WindowsLocked),
            OsSignal::Suspending => self.lock_now(LockReason::Sleep),
            OsSignal::DriveRemoved { mask } => {
                for (id, location) in self.sessions.locations() {
                    if drive_bit(location.path()) & mask != 0 {
                        self.sessions.lock(id, LockReason::DriveGone);
                    }
                }
            }
            OsSignal::Ending => self.shutdown(),
        }
    }

    /// Windows lock and sleep: cancels every long operation, then locks every vault. The operations are cancelled
    /// first so they stop at once, even while the lock waits its turn, and again after, for one begun meanwhile (a
    /// restore has no session for the lock to cancel).
    fn lock_now(&self, reason: LockReason) {
        self.operations.cancel_all();
        self.sessions.lock_all(reason);
        self.operations.cancel_all();
    }

    /// Closing the app ([`Shell::shutdown`](crate::shell::Shell::shutdown)): locks every vault on a helper thread,
    /// cancels every long operation, then waits at most [`SHUTDOWN_WAIT`] for the lock and its hooks. A hook that
    /// blocks is left behind: the process exits anyway. Only the first call does anything.
    pub(crate) fn shutdown(&self) {
        if self.closing.swap(true, Ordering::SeqCst) {
            return;
        }
        let (done, finished) = mpsc::channel();
        let sessions = Arc::clone(&self.sessions);
        // If the thread cannot start, `done` is dropped with it and the wait below ends at once: the process exit
        // still drops every vault (its key with the process memory, its `.lock` released by Windows).
        let _ = thread::Builder::new()
            .name("lockbox-closing".into())
            .spawn(move || {
                sessions.lock_all(LockReason::AppClosing);
                let _ = done.send(());
            });
        self.operations.cancel_all();
        let _ = finished.recv_timeout(SHUTDOWN_WAIT);
    }
}

/// The bit of the drive `path` is on in a `DriveRemoved` mask (bit 0 for A:), or 0 for a path without a drive letter
/// (a volume mounted in a folder: the tick finds it gone).
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
    use std::path::PathBuf;

    use lockbox_core::internals::fsio::failpoint;
    use zeroize::Zeroizing;

    use super::*;
    use crate::error::{Outcome, ShellError};
    use crate::lock;
    use crate::pending::PendingChoice;
    use crate::session::{LockReason, SessionState};
    use crate::testing::{TestShell, heavy};

    const PW: &str = "correct horse battery";
    const MIB: usize = 1024 * 1024;
    /// How long a blocked hook waits for the test before it gives up, so a failing test cannot hang.
    const GIVE_UP: Duration = Duration::from_secs(60);

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
            took < SHUTDOWN_WAIT + Duration::from_secs(1),
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
}
