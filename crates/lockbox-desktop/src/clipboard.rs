//! Copying a field to the clipboard (spec §7.3), entirely in Rust (§4.1): the value never crosses to the page. Each
//! copy is kept out of clipboard history and cloud sync ([`ClipboardBackend::write_secret`]), and cleared after the
//! clear delay, or when its vault locks, or when the app closes, but only while the clipboard still holds it (its
//! own random tag is still there): whatever the user copied since is left alone. A clear that finds the clipboard
//! busy is tried again until it is done or the copy is gone.

use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use serde::Serialize;
use zeroize::Zeroizing;

use crate::autolock::SHUTDOWN_WAIT;
use crate::error::ShellResult;
use crate::lock;
use crate::os::{CLIPBOARD_FAILED, CLIPBOARD_RETRY, ClipboardBackend, Clock, CopyTag, Os, Timer};
use crate::session::{LockHook, LockReason, SessionId, Sessions};
use crate::settings::SettingsStore;

/// How long after a failed clear (the clipboard busy) the next try comes. Each try is itself bounded (ten openings
/// 5 ms apart), so a program holding the clipboard costs a try every quarter second, never a blocked thread.
pub const CLEAR_RETRY: Duration = Duration::from_millis(250);

/// The clipboard copy Lockbox made last, while it may still be on the clipboard.
#[derive(Debug, Clone, Copy)]
struct Owned {
    /// The copy's tag: while the clipboard holds it, the copy is still there.
    tag: CopyTag,
    /// The session the value came from: its lock clears the copy.
    session: SessionId,
    /// This copy's own number: only this copy's timer clears it.
    copy_id: u64,
}

/// What the lock hook and the timers share with [`Clipboard`].
struct Shared {
    backend: Arc<dyn ClipboardBackend>,
    timer: Arc<dyn Timer>,
    clock: Arc<dyn Clock>,
    /// Held across each write (so the copy on the clipboard and the one recorded here are always the same) and each
    /// clear. Lock order: a session's publish guard, then this. The hook and the timers take only this.
    owned: Mutex<Option<Owned>>,
    copies: AtomicU64,
}

impl Shared {
    /// One try at clearing the recorded copy, when `ours` picks it: emptied while its tag is still on the clipboard,
    /// left alone otherwise, and forgotten either way. `Some(copy_id)` when the clipboard could not be opened or
    /// emptied (or `until` came first): the copy stays recorded and needs another try.
    fn try_clear(&self, ours: impl Fn(&Owned) -> bool, until: Option<Instant>) -> Option<u64> {
        let mut owned = lock(&self.owned);
        let copy = owned.filter(|copy| ours(copy))?;
        match self.backend.clear_if(&copy.tag, until) {
            Ok(_) => {
                *owned = None;
                None
            }
            Err(_) => Some(copy.copy_id),
        }
    }

    /// Clears the copy `ours` picks, and keeps trying every [`CLEAR_RETRY`] on the timer until it is done.
    fn clear(self: &Arc<Self>, ours: impl Fn(&Owned) -> bool) {
        if let Some(copy_id) = self.try_clear(ours, None) {
            self.retry(copy_id);
        }
    }

    /// Another try at clearing the copy `copy_id`, [`CLEAR_RETRY`] from now on the timer. The timer's thread starts
    /// with the clipboard ([`Clipboard::new`]), so this cannot fail while the app runs; if it ever did, the copy stays
    /// recorded and the next lock or the app's close clears it.
    fn retry(self: &Arc<Self>, copy_id: u64) {
        let shared = Arc::downgrade(self);
        let again = move || {
            if let Some(shared) = Weak::upgrade(&shared) {
                shared.clear(|owned| owned.copy_id == copy_id);
            }
        };
        let _ = self
            .timer
            .at(self.clock.now() + CLEAR_RETRY, Box::new(again));
    }

    /// Tries to clear the copy `ours` picks, here and now, until `deadline`, the app close's own: no timer runs once
    /// the app is gone. Nothing starts at or after the deadline and no wait runs past it, the openings' own tries
    /// included (`clear_if` gets the deadline). Between tries: [`CLEAR_RETRY`] while more than that is left, then, in
    /// the last stretch, the openings' short spacing, so a clipboard freed just before the deadline is still cleared.
    /// If the copy is still there at the deadline, it stays recorded and a retry is left on the timer, for when the app
    /// does not exit after all.
    fn clear_until(self: &Arc<Self>, ours: impl Fn(&Owned) -> bool, deadline: Instant) {
        while self.clock.now() < deadline {
            if self.try_clear(&ours, Some(deadline)).is_none() {
                return;
            }
            let left = deadline.saturating_duration_since(self.clock.now());
            self.clock.sleep(match left > CLEAR_RETRY {
                true => CLEAR_RETRY,
                false => CLIPBOARD_RETRY.min(left),
            });
        }
        let still_recorded = lock(&self.owned)
            .filter(|copy| ours(copy))
            .map(|copy| copy.copy_id);
        if let Some(copy_id) = still_recorded {
            self.retry(copy_id);
        }
    }
}

/// What 2c's Clear now found ([`Clipboard::clear_now`]), as the page reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClearNow {
    /// Lockbox's copy was on the clipboard and is gone now.
    Cleared,
    /// There was nothing of Lockbox's to clear: already cleared, or something else copied since.
    Gone,
    /// Another program holds the clipboard; Lockbox keeps trying on its own.
    Busy,
}

/// When the app's close stops waiting for its lock hooks ([`AutoLock::close_deadline`](crate::autolock::AutoLock)),
/// once closing has started.
pub type CloseDeadline = Arc<dyn Fn() -> Option<Instant> + Send + Sync>;

/// Lockbox's clipboard copies (spec §7.3).
pub struct Clipboard {
    shared: Arc<Shared>,
    settings: Arc<SettingsStore>,
    close_deadline: CloseDeadline,
    /// Tests only: run once, right after the next write's publish ends, before its timer is set.
    #[cfg(test)]
    after_write: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl Clipboard {
    /// Uses `os`'s clipboard, timer and clock; reads the clear delay from `settings` at each copy, and the app close's
    /// deadline from `close_deadline`. Starts the timer's thread first: without it no copy could be cleared later,
    /// so there is no clipboard (`the clipboard timer could not start`), and the app does not start.
    pub fn new(
        os: &Os,
        settings: Arc<SettingsStore>,
        close_deadline: CloseDeadline,
    ) -> io::Result<Clipboard> {
        os.timer
            .start()
            .map_err(|_| io::Error::other("the clipboard timer could not start"))?;
        Ok(Clipboard {
            shared: Arc::new(Shared {
                backend: Arc::clone(&os.clipboard),
                timer: Arc::clone(&os.timer),
                clock: Arc::clone(&os.clock),
                owned: Mutex::default(),
                copies: AtomicU64::new(0),
            }),
            settings,
            close_deadline,
            #[cfg(test)]
            after_write: Mutex::default(),
        })
    }

    /// The lock hook, to be added before any other (spec §7.4 step 5): a lock of the session the copy came from, or
    /// of all (`None`), clears the copy while it is still on the clipboard. Runs on the lock-hook thread. A lock tries
    /// once (ten short openings) and, if the clipboard is busy, leaves the retries to the timer, so it never holds up
    /// the hooks after it for long. App close tries again here until the close's own deadline (or [`SHUTDOWN_WAIT`]
    /// from now for an app-close lock with no close under way), since no timer runs once the app is gone.
    pub fn lock_hook(&self) -> LockHook {
        let (shared, close_deadline) = (Arc::clone(&self.shared), Arc::clone(&self.close_deadline));
        Box::new(move |only, reason| {
            let ours = |owned: &Owned| only.is_none_or(|locked| locked == owned.session);
            match reason {
                LockReason::AppClosing => {
                    let deadline =
                        close_deadline().unwrap_or_else(|| Instant::now() + SHUTDOWN_WAIT);
                    shared.clear_until(ours, deadline);
                }
                _ => shared.clear(ours),
            }
        })
    }

    /// Copies `secret`, a value read from `session` in `generation`, to the clipboard with a new random tag, and
    /// clears it after the clear delay as set now. The write runs inside [`Sessions::publish`]: never once the session
    /// has locked (`Locked`, nothing written), and recorded before the publish ends, so a lock that comes after it
    /// always finds the copy and its hook clears it. A write that fails before touching the clipboard leaves the
    /// earlier copy recorded; one whose clean-up failed too records this copy, to be cleared by its tag.
    pub fn copy(
        &self,
        sessions: &Sessions,
        session: SessionId,
        generation: u64,
        secret: Zeroizing<String>,
    ) -> ShellResult<()> {
        let delay = self.settings.get().clipboard_delay();
        let mut tag = CopyTag::default();
        getrandom::fill(&mut tag).map_err(|_| CLIPBOARD_FAILED)?;
        let (copy_id, failed) = sessions.publish(session, generation, || {
            let mut owned = lock(&self.shared.owned);
            let written = self.shared.backend.write_secret(&secret, &tag);
            match written {
                Err(failed) if !failed.left_behind => Err(failed.error),
                written => {
                    let copy_id = self.shared.copies.fetch_add(1, Ordering::SeqCst) + 1;
                    *owned = Some(Owned {
                        tag,
                        session,
                        copy_id,
                    });
                    Ok((copy_id, written.err()))
                }
            }
        })?;
        drop(secret);
        if let Some(failed) = failed {
            self.shared.retry(copy_id);
            return Err(failed.error);
        }
        #[cfg(test)]
        {
            let hook = lock(&self.after_write).take();
            if let Some(hook) = hook {
                hook();
            }
        }
        let shared = Arc::downgrade(&self.shared);
        let clear = move || {
            if let Some(shared) = Weak::upgrade(&shared) {
                shared.clear(|owned| owned.copy_id == copy_id);
            }
        };
        let armed = self
            .shared
            .timer
            .at(self.shared.clock.now() + delay, Box::new(clear));
        if armed.is_err() {
            // Without a timer the copy would stay until a lock: take it off now instead.
            self.shared.clear(|owned| owned.copy_id == copy_id);
            return Err(CLIPBOARD_FAILED);
        }
        Ok(())
    }

    /// 2c's Clear now: clears Lockbox's last copy here and now, while the clipboard still holds it, under the same rule
    /// as its timer (whatever the user copied since is left alone). `Gone` when there is no copy to clear (the timer
    /// or a lock got there first, or something else was copied since); `Busy` when another program holds the
    /// clipboard: the copy stays recorded and the timer keeps trying, as for a busy timer clear.
    pub fn clear_now(&self) -> ClearNow {
        let busy = {
            let mut owned = lock(&self.shared.owned);
            let Some(copy) = *owned else {
                return ClearNow::Gone;
            };
            match self.shared.backend.clear_if(&copy.tag, None) {
                Ok(cleared) => {
                    *owned = None;
                    return match cleared {
                        true => ClearNow::Cleared,
                        false => ClearNow::Gone,
                    };
                }
                Err(_) => copy.copy_id,
            }
        };
        self.shared.retry(busy);
        ClearNow::Busy
    }

    /// Tests only: runs `hook` once, right after the next write's publish ends, before its timer is set.
    #[cfg(test)]
    pub(crate) fn after_next_write(&self, hook: Box<dyn FnOnce() + Send>) {
        *lock(&self.after_write) = Some(hook);
    }

    /// Tests only: the session whose copy Lockbox still counts as on the clipboard.
    #[cfg(test)]
    pub(crate) fn owner(&self) -> Option<SessionId> {
        lock(&self.shared.owned).map(|owned| owned.session)
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::{Barrier, mpsc};
    use std::thread;
    use std::time::{Duration, Instant};

    use lockbox_core::Vault;
    use lockbox_core::recovery::RecoverySecret;

    use super::*;
    use crate::error::{Outcome, ShellError};
    use crate::os::CLIPBOARD_BUSY;
    use crate::os::EXCLUSION_FORMATS;
    use crate::session::{Location, LockReason, OpenStep, Opened, SessionState};
    use crate::settings::Settings;
    use crate::testing::{TestShell, heavy};

    const PW: &str = "correct horse battery";
    const SECRET: &str = "Pw-0123456789-xyz";
    /// How long a test thread waits for another before it fails instead of hanging.
    const GIVE_UP: Duration = Duration::from_secs(60);

    fn secret(text: &str) -> Zeroizing<String> {
        Zeroizing::new(text.to_owned())
    }

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    /// A vault made once (one key derivation), reopened as often as a test needs through its recovery key, which
    /// derives no key (HKDF only): 200 rounds stay fast.
    struct TestVault {
        dir: PathBuf,
        recovery: RecoverySecret,
    }

    fn new_vault(parent: &Path, name: &str) -> TestVault {
        let created = heavy(|| Vault::create(parent, name, PW)).unwrap();
        TestVault {
            dir: created.vault.dir().to_path_buf(),
            recovery: created.recovery,
        }
    }

    /// Unlocks `vault` as a session of the test shell: its id and generation.
    fn unlock(ts: &TestShell, vault: &TestVault) -> (SessionId, u64) {
        let (opened, _) = Vault::unlock_with_recovery(&vault.dir, &vault.recovery).unwrap();
        let location = Location::folder(&vault.dir).unwrap();
        let answer = ts.shell.sessions.open(Some(location.clone()), None, |_| {
            Ok(OpenStep::Session(location, Opened::Writable(opened), ()))
        });
        let Ok(Outcome::Done(tagged)) = answer else {
            panic!("the session did not open");
        };
        (tagged.session, tagged.generation)
    }

    fn copy(ts: &TestShell, session: SessionId, generation: u64, text: &str) -> ShellResult<()> {
        ts.shell
            .clipboard
            .copy(&ts.shell.sessions, session, generation, secret(text))
    }

    /// Moves the fake clock to `start + after` and runs the timers due by then.
    fn at(ts: &TestShell, start: Instant, after: Duration) {
        ts.clock.set(start + after);
        ts.timer.run_due(start + after);
    }

    #[test]
    fn clears_after_delay_when_still_ours() {
        let ts = TestShell::new();
        let family = new_vault(&ts.vaults(), "Family");
        let (s, g) = unlock(&ts, &family);
        let start = ts.clock.now();
        copy(&ts, s, g, SECRET).unwrap();
        assert_eq!(ts.clipboard.text().as_deref(), Some(SECRET));
        assert_eq!(ts.clipboard.formats(), EXCLUSION_FORMATS);
        assert_eq!(ts.shell.clipboard.owner(), Some(s));
        at(&ts, start, secs(29));
        assert_eq!(
            ts.clipboard.text().as_deref(),
            Some(SECRET),
            "cleared early"
        );
        at(&ts, start, secs(30));
        assert_eq!(ts.clipboard.text(), None, "not cleared at 30 s");
        assert_eq!(ts.shell.clipboard.owner(), None);

        // The delay is read at each copy: 10 s after a change of setting.
        ts.shell
            .settings
            .set(Settings {
                clipboard_seconds: 10,
                ..Settings::default()
            })
            .unwrap();
        let start = ts.clock.now();
        copy(&ts, s, g, SECRET).unwrap();
        at(&ts, start, secs(9));
        assert_eq!(
            ts.clipboard.text().as_deref(),
            Some(SECRET),
            "cleared early"
        );
        at(&ts, start, secs(10));
        assert_eq!(ts.clipboard.text(), None, "not cleared at 10 s");
    }

    /// Review Focus 3: the user copies something else after Lockbox's copy. Neither the timer nor a lock touches it.
    #[test]
    fn user_copy_after_ours_is_kept() {
        let ts = TestShell::new();
        let family = new_vault(&ts.vaults(), "Family");
        let (s, g) = unlock(&ts, &family);
        let start = ts.clock.now();
        copy(&ts, s, g, SECRET).unwrap();
        assert!(ts.clipboard.user_copy("mine"));
        at(&ts, start, secs(30));
        assert_eq!(
            ts.clipboard.text().as_deref(),
            Some("mine"),
            "the timer cleared it"
        );

        let start = ts.clock.now();
        copy(&ts, s, g, SECRET).unwrap();
        assert!(ts.clipboard.user_copy("mine again"));
        ts.shell.sessions.lock(s, LockReason::Manual);
        assert_eq!(
            ts.clipboard.text().as_deref(),
            Some("mine again"),
            "the lock cleared it"
        );
        let (s, g) = unlock(&ts, &family);
        copy(&ts, s, g, SECRET).unwrap();
        assert!(ts.clipboard.user_copy("mine a third time"));
        ts.shell.sessions.lock_all(LockReason::Manual);
        at(&ts, start, secs(300));
        assert_eq!(
            ts.clipboard.text().as_deref(),
            Some("mine a third time"),
            "lock_all or a timer cleared it"
        );
        assert_eq!(ts.shell.clipboard.owner(), None);
    }

    /// Stage 7 (2026-11-13, the group 2 walk): 2c's Clear now takes Lockbox's copy off at once, and the copy's timer
    /// then has nothing left to do.
    #[test]
    fn clear_now_takes_our_copy_off_at_once() {
        let ts = TestShell::new();
        let family = new_vault(&ts.vaults(), "Family");
        let (s, g) = unlock(&ts, &family);
        let start = ts.clock.now();
        copy(&ts, s, g, SECRET).unwrap();
        at(&ts, start, secs(5));
        assert_eq!(ts.shell.clipboard.clear_now(), ClearNow::Cleared);
        assert_eq!(ts.clipboard.text(), None, "Clear now left the copy");
        assert_eq!(ts.shell.clipboard.owner(), None);
        // A second press finds nothing, and the old timer touches nothing copied later.
        assert_eq!(ts.shell.clipboard.clear_now(), ClearNow::Gone);
        assert!(ts.clipboard.user_copy("mine"));
        at(&ts, start, secs(30));
        assert_eq!(ts.clipboard.text().as_deref(), Some("mine"));
    }

    /// Clear now follows the timer's rule: whatever the user copied after Lockbox's copy is left alone.
    #[test]
    fn clear_now_leaves_a_later_copy_alone() {
        let ts = TestShell::new();
        let family = new_vault(&ts.vaults(), "Family");
        let (s, g) = unlock(&ts, &family);
        copy(&ts, s, g, SECRET).unwrap();
        assert!(ts.clipboard.user_copy("mine"));
        assert_eq!(ts.shell.clipboard.clear_now(), ClearNow::Gone);
        assert_eq!(
            ts.clipboard.text().as_deref(),
            Some("mine"),
            "Clear now cleared the user's own copy"
        );
        assert_eq!(ts.shell.clipboard.owner(), None);
    }

    /// With the clipboard held by another program, Clear now says so and keeps trying, as a busy timer clear does.
    #[test]
    fn clear_now_on_a_busy_clipboard_keeps_trying() {
        let ts = TestShell::new();
        let family = new_vault(&ts.vaults(), "Family");
        let (s, g) = unlock(&ts, &family);
        copy(&ts, s, g, SECRET).unwrap();
        ts.clipboard.hold_open_elsewhere(true);
        assert_eq!(ts.shell.clipboard.clear_now(), ClearNow::Busy);
        assert_eq!(ts.clipboard.text().as_deref(), Some(SECRET));
        assert_eq!(ts.shell.clipboard.owner(), Some(s), "given up while busy");
        ts.clipboard.hold_open_elsewhere(false);
        let now = ts.clock.now();
        at(&ts, now, CLEAR_RETRY);
        assert_eq!(ts.clipboard.text(), None, "never tried again");
        assert_eq!(ts.shell.clipboard.owner(), None);
    }

    #[test]
    fn later_copy_not_cleared_by_earlier_timer() {
        let ts = TestShell::new();
        let family = new_vault(&ts.vaults(), "Family");
        let (s, g) = unlock(&ts, &family);
        let start = ts.clock.now();
        copy(&ts, s, g, "first").unwrap();
        at(&ts, start, secs(20));
        copy(&ts, s, g, "second").unwrap();
        at(&ts, start, secs(30));
        assert_eq!(
            ts.clipboard.text().as_deref(),
            Some("second"),
            "the first copy's timer cleared the second"
        );
        at(&ts, start, secs(49));
        assert_eq!(
            ts.clipboard.text().as_deref(),
            Some("second"),
            "cleared early"
        );
        at(&ts, start, secs(50));
        assert_eq!(ts.clipboard.text(), None, "not cleared at 50 s");
    }

    #[test]
    fn lock_clears_only_that_vaults_copy() {
        let ts = TestShell::new();
        let a = new_vault(&ts.vaults(), "Family");
        let b = new_vault(&ts.vaults(), "Work");
        let (sa, ga) = unlock(&ts, &a);
        let (sb, _) = unlock(&ts, &b);
        copy(&ts, sa, ga, SECRET).unwrap();
        ts.shell.sessions.lock(sb, LockReason::Manual);
        assert_eq!(
            ts.clipboard.text().as_deref(),
            Some(SECRET),
            "B's lock cleared A's copy"
        );
        assert_eq!(ts.shell.clipboard.owner(), Some(sa));
        ts.shell.sessions.lock(sa, LockReason::Manual);
        assert_eq!(ts.clipboard.text(), None, "A's lock left A's copy");
        assert_eq!(ts.shell.clipboard.owner(), None);

        let (sa, ga) = unlock(&ts, &a);
        copy(&ts, sa, ga, SECRET).unwrap();
        ts.shell.sessions.lock_all(LockReason::Idle);
        assert_eq!(ts.clipboard.text(), None, "lock_all left the copy");
        assert_eq!(ts.shell.clipboard.owner(), None);
    }

    #[test]
    fn shutdown_clears_our_copy() {
        let ts = TestShell::new();
        let family = new_vault(&ts.vaults(), "Family");
        let (s, g) = unlock(&ts, &family);
        copy(&ts, s, g, SECRET).unwrap();
        ts.shell.shutdown();
        assert_eq!(ts.clipboard.text(), None, "app close left the copy");
        assert_eq!(ts.shell.clipboard.owner(), None);
    }

    /// A copy and a lock of all vaults at once, 200 times: either the copy lands first and the lock's hook clears
    /// it, or the lock comes first and the copy never writes. Never the secret left behind. The lock starts a little
    /// later each round (a spin, no sleep), so the rounds spread over both orders instead of the lock always winning.
    #[test]
    fn copy_racing_lock_never_leaves_secret() {
        let ts = TestShell::new();
        let family = new_vault(&ts.vaults(), "Family");
        let (mut copied, mut refused) = (0, 0);
        for round in 0..200 {
            let (s, g) = unlock(&ts, &family);
            let start = Arc::new(Barrier::new(2));
            let (shell, go) = (Arc::clone(&ts.shell), Arc::clone(&start));
            let locker = thread::spawn(move || {
                go.wait();
                for _ in 0..(round % 50) * 40 {
                    std::hint::spin_loop();
                }
                shell.sessions.lock_all(LockReason::Manual);
            });
            start.wait();
            match copy(&ts, s, g, SECRET) {
                Ok(()) => copied += 1,
                Err(ShellError::Locked) => refused += 1,
                Err(other) => panic!("round {round}: {other:?}"),
            }
            locker.join().unwrap();
            assert_ne!(
                ts.clipboard.text().as_deref(),
                Some(SECRET),
                "round {round}: the secret was left on the clipboard"
            );
            assert_eq!(ts.shell.clipboard.owner(), None, "round {round}");
        }
        assert_eq!(copied + refused, 200);
    }

    /// The copy is recorded before its publish ends: a lock that comes right after it, before the copy has even set
    /// its timer, finds it and clears it. The deterministic case of the race above.
    #[test]
    fn lock_right_after_the_write_clears_it() {
        let ts = TestShell::new();
        let family = new_vault(&ts.vaults(), "Family");
        let (s, g) = unlock(&ts, &family);
        let shell = Arc::clone(&ts.shell);
        ts.shell.clipboard.after_next_write(Box::new(move || {
            shell.sessions.lock_all(LockReason::Manual);
        }));
        copy(&ts, s, g, SECRET).unwrap();
        assert_eq!(ts.clipboard.text(), None, "the lock missed the copy");
        assert_eq!(ts.shell.clipboard.owner(), None);
    }

    /// A timer that cannot be set: the copy is taken off at once rather than left until a lock.
    #[test]
    fn copy_without_a_timer_is_taken_off() {
        let ts = TestShell::new();
        let family = new_vault(&ts.vaults(), "Family");
        let (s, g) = unlock(&ts, &family);
        ts.timer.fail_next();
        assert_eq!(copy(&ts, s, g, SECRET), Err(CLIPBOARD_FAILED));
        assert_eq!(ts.clipboard.text(), None);
        assert_eq!(ts.shell.clipboard.owner(), None);
    }

    /// Fix round 1 (2): a timer clear that finds the clipboard busy keeps trying, [`CLEAR_RETRY`] apart, and clears
    /// the copy once the clipboard is free, with nothing more from the user.
    #[test]
    fn busy_timer_clear_is_retried_until_done() {
        let ts = TestShell::new();
        let family = new_vault(&ts.vaults(), "Family");
        let (s, g) = unlock(&ts, &family);
        let start = ts.clock.now();
        copy(&ts, s, g, SECRET).unwrap();
        ts.clipboard.hold_open_elsewhere(true);
        at(&ts, start, secs(30));
        at(&ts, start, secs(30) + CLEAR_RETRY);
        assert_eq!(ts.clipboard.text().as_deref(), Some(SECRET));
        assert_eq!(ts.shell.clipboard.owner(), Some(s), "given up while busy");
        ts.clipboard.hold_open_elsewhere(false);
        at(&ts, start, secs(30) + CLEAR_RETRY * 2);
        assert_eq!(ts.clipboard.text(), None, "never tried again");
        assert_eq!(ts.shell.clipboard.owner(), None);
        assert_eq!(ts.timer.waiting(), 0, "still retrying after the clear");
    }

    /// Fix round 1 (2): a lock whose clear finds the clipboard busy returns, and leaves a retry that clears the copy
    /// once the clipboard is free.
    #[test]
    fn busy_lock_clear_is_retried_until_done() {
        let ts = TestShell::new();
        let family = new_vault(&ts.vaults(), "Family");
        let (s, g) = unlock(&ts, &family);
        copy(&ts, s, g, SECRET).unwrap();
        ts.clipboard.hold_open_elsewhere(true);
        ts.shell.sessions.lock(s, LockReason::Manual);
        assert_eq!(ts.clipboard.text().as_deref(), Some(SECRET));
        ts.clipboard.hold_open_elsewhere(false);
        let now = ts.clock.now();
        at(&ts, now, CLEAR_RETRY);
        assert_eq!(
            ts.clipboard.text(),
            None,
            "never tried again after the lock"
        );
        assert_eq!(ts.shell.clipboard.owner(), None);
    }

    /// Fix round 1 (2): closing the app while the clipboard is busy keeps trying within the close's time, so the copy
    /// is gone before the app is.
    #[test]
    fn busy_close_clear_is_retried_within_the_deadline() {
        let ts = TestShell::new();
        let family = new_vault(&ts.vaults(), "Family");
        let (s, g) = unlock(&ts, &family);
        copy(&ts, s, g, SECRET).unwrap();
        // Busy through the first try (ten openings), free for the next.
        ts.clipboard.hold_open_for(10);
        ts.shell.shutdown();
        assert_eq!(ts.clipboard.text(), None, "app close left the copy");
        assert_eq!(ts.shell.clipboard.owner(), None);
    }

    /// Fix round 1 (3): when the close's helper thread cannot start, the clipboard is still cleared.
    #[test]
    fn shutdown_without_helper_still_clears() {
        let ts = TestShell::new();
        let family = new_vault(&ts.vaults(), "Family");
        let (s, g) = unlock(&ts, &family);
        copy(&ts, s, g, SECRET).unwrap();
        ts.shell.autolock.fail_next_spawn();
        ts.shell.shutdown();
        assert_eq!(ts.clipboard.text(), None, "app close left the copy");
        assert_eq!(ts.shell.clipboard.owner(), None);
    }

    /// Fix round 2 (2): the timer's thread starts with the clipboard; if it cannot, there is no clipboard and the app
    /// does not start, so no copy is ever made without a way to clear it later.
    #[test]
    fn clipboard_refuses_to_start_without_its_timer() {
        crate::testing::fail_next_timer_start();
        assert!(TestShell::try_new().is_err(), "started without a timer");
        // The next start is a normal one.
        TestShell::new();
    }

    /// Fix round 2 (1): a clear whose tag read fails keeps the copy and tries again, instead of taking the copy for
    /// gone.
    #[test]
    fn unreadable_tag_keeps_the_copy_and_retries() {
        let ts = TestShell::new();
        let family = new_vault(&ts.vaults(), "Family");
        let (s, g) = unlock(&ts, &family);
        let start = ts.clock.now();
        copy(&ts, s, g, SECRET).unwrap();
        ts.clipboard.fail_next_read();
        at(&ts, start, secs(30));
        assert_eq!(ts.clipboard.text().as_deref(), Some(SECRET));
        assert_eq!(ts.shell.clipboard.owner(), Some(s), "taken for gone");
        at(&ts, start, secs(30) + CLEAR_RETRY);
        assert_eq!(ts.clipboard.text(), None, "never tried again");
        assert_eq!(ts.shell.clipboard.owner(), None);
    }

    /// Fix round 2 (3), fix round 3 (1): the close-time clear keeps to the close's own deadline. No try at opening
    /// starts at or after it, no wait runs past it, and the copy stays recorded with a retry left behind (for an app
    /// that does not exit after all). Once the deadline has passed, there is no try at all. Fake clock: no real waits.
    #[test]
    fn close_clear_stops_at_the_close_deadline() {
        let ts = TestShell::new();
        let family = new_vault(&ts.vaults(), "Family");
        let (s, g) = unlock(&ts, &family);
        copy(&ts, s, g, SECRET).unwrap();
        ts.clipboard.hold_open_elsewhere(true);
        let deadline = ts.clock.now() + Duration::from_millis(300);
        ts.shell.autolock.set_close_deadline(deadline);
        let waiting = ts.timer.waiting();
        ts.clipboard.take_open_times();
        ts.shell.sessions.lock_all(LockReason::AppClosing);
        let tries = ts.clipboard.take_open_times();
        assert!(!tries.is_empty(), "never tried");
        assert!(
            tries.iter().all(|at| *at < deadline),
            "a try at or after the deadline"
        );
        assert_eq!(ts.clock.now(), deadline, "waited past the deadline");
        assert_eq!(ts.clipboard.text().as_deref(), Some(SECRET));
        assert_eq!(ts.shell.clipboard.owner(), Some(s));
        assert_eq!(ts.timer.waiting(), waiting + 1, "no retry left behind");

        // The deadline already passed: not one try, and the retry is still left.
        ts.shell.sessions.lock_all(LockReason::AppClosing);
        assert!(
            ts.clipboard.take_open_times().is_empty(),
            "tried after the deadline"
        );
        assert_eq!(ts.shell.clipboard.owner(), Some(s));

        ts.clipboard.hold_open_elsewhere(false);
        let now = ts.clock.now();
        at(&ts, now, CLEAR_RETRY);
        assert_eq!(ts.clipboard.text(), None);
    }

    /// Fix round 3 (1): the clipboard is freed shortly before the close's deadline, after the first try found it
    /// busy: short tries in the last stretch still clear the copy before the deadline. Fake clock: no real waits.
    #[test]
    fn clipboard_freed_just_before_the_close_deadline_is_cleared() {
        let ts = TestShell::new();
        let family = new_vault(&ts.vaults(), "Family");
        let (s, g) = unlock(&ts, &family);
        copy(&ts, s, g, SECRET).unwrap();
        let start = ts.clock.now();
        let deadline = start + Duration::from_millis(200);
        ts.shell.autolock.set_close_deadline(deadline);
        // Busy through the first 20 tries (about the first 100 ms), free after.
        ts.clipboard.hold_open_for(20);
        ts.clipboard.take_open_times();
        ts.shell.sessions.lock_all(LockReason::AppClosing);
        assert_eq!(ts.clipboard.text(), None, "not cleared before the deadline");
        assert_eq!(ts.shell.clipboard.owner(), None);
        let last = *ts.clipboard.take_open_times().last().unwrap();
        assert!(last < deadline, "cleared only at {:?}", last - start);
    }

    /// Fix round 1 (4): the write fails and so does its empty: the copy's tag may still be there, so the copy stays
    /// recorded and a retry clears it.
    #[test]
    fn failed_rollback_keeps_the_copy_owned_and_retries() {
        let ts = TestShell::new();
        let family = new_vault(&ts.vaults(), "Family");
        let (s, g) = unlock(&ts, &family);
        ts.clipboard.fail_text();
        ts.clipboard.fail_empty_at(1);
        assert_eq!(copy(&ts, s, g, SECRET), Err(CLIPBOARD_FAILED));
        assert_eq!(ts.clipboard.text(), None, "the text was left");
        assert!(ts.clipboard.tag().is_some());
        assert_eq!(ts.shell.clipboard.owner(), Some(s));
        let now = ts.clock.now();
        at(&ts, now, CLEAR_RETRY);
        assert_eq!(ts.clipboard.tag(), None, "never cleared");
        assert_eq!(ts.shell.clipboard.owner(), None);
    }

    /// A write that fails before touching the clipboard keeps the earlier copy recorded, so its clear still comes.
    #[test]
    fn clean_failure_keeps_the_earlier_copy() {
        let ts = TestShell::new();
        let family = new_vault(&ts.vaults(), "Family");
        let (s, g) = unlock(&ts, &family);
        let start = ts.clock.now();
        copy(&ts, s, g, SECRET).unwrap();
        ts.clipboard.hold_open_for(10);
        assert_eq!(copy(&ts, s, g, "second"), Err(CLIPBOARD_BUSY));
        assert_eq!(ts.clipboard.text().as_deref(), Some(SECRET));
        at(&ts, start, secs(30));
        assert_eq!(ts.clipboard.text(), None, "the earlier copy was forgotten");
    }

    /// Fix round 1 (1, 7): another program copies the instant Lockbox's write closes the clipboard. Neither the timer,
    /// nor a lock, nor app close ever clears it.
    #[test]
    fn copy_right_after_the_write_is_never_cleared() {
        let ts = TestShell::new();
        let family = new_vault(&ts.vaults(), "Family");
        let (s, g) = unlock(&ts, &family);
        let start = ts.clock.now();
        let clipboard = Arc::clone(&ts.clipboard);
        ts.clipboard
            .after_next_close(Box::new(move || assert!(clipboard.user_copy("theirs"))));
        copy(&ts, s, g, SECRET).unwrap();
        assert_eq!(ts.clipboard.text().as_deref(), Some("theirs"));
        at(&ts, start, secs(30));
        ts.shell.sessions.lock(s, LockReason::Manual);
        ts.shell.shutdown();
        assert_eq!(
            ts.clipboard.text().as_deref(),
            Some("theirs"),
            "their copy was cleared"
        );
    }

    /// Fix round 1 (7): a lock that revokes the session while the write is still under way (after the clipboard
    /// closed, before the copy is recorded) waits for the write, then finds the copy and clears it.
    #[test]
    fn lock_during_the_write_clears_it() {
        let ts = TestShell::new();
        let family = new_vault(&ts.vaults(), "Family");
        let (s, g) = unlock(&ts, &family);
        let shell = Arc::clone(&ts.shell);
        let (locker_out, locker) = mpsc::channel();
        ts.clipboard.after_next_close(Box::new(move || {
            let locking = Arc::clone(&shell);
            let handle = thread::spawn(move || locking.sessions.lock_all(LockReason::Manual));
            // Revoked (step 1 done): the lock now waits for this write's publish attempt to end.
            let began = Instant::now();
            while shell
                .sessions
                .list()
                .iter()
                .any(|info| info.session == s && info.state == SessionState::Unlocked)
            {
                assert!(began.elapsed() < GIVE_UP, "the lock never revoked");
                thread::yield_now();
            }
            locker_out.send(handle).unwrap();
        }));
        assert_eq!(
            copy(&ts, s, g, SECRET),
            Ok(()),
            "the write had started before the lock"
        );
        locker.recv().unwrap().join().unwrap();
        assert_eq!(ts.clipboard.text(), None, "the lock missed the copy");
        assert_eq!(ts.shell.clipboard.owner(), None);
    }

    #[test]
    fn copy_after_lock_never_writes() {
        let ts = TestShell::new();
        let family = new_vault(&ts.vaults(), "Family");
        let (s, g) = unlock(&ts, &family);
        ts.shell.sessions.lock(s, LockReason::Manual);
        assert_eq!(copy(&ts, s, g, SECRET), Err(ShellError::Locked));
        // Unlocked again: the old generation still never writes.
        let (s2, g2) = unlock(&ts, &family);
        assert_eq!(s2, s);
        assert_eq!(copy(&ts, s, g, SECRET), Err(ShellError::Locked));
        assert_eq!(ts.clipboard.opens(), 0, "the clipboard was opened");
        assert_eq!(ts.timer.waiting(), 0, "a timer was set");
        assert_eq!(ts.shell.clipboard.owner(), None);
        copy(&ts, s2, g2, SECRET).unwrap();
        assert_eq!(ts.clipboard.text().as_deref(), Some(SECRET));
    }

    #[test]
    fn failed_exclusion_empties_clipboard() {
        let ts = TestShell::new();
        let family = new_vault(&ts.vaults(), "Family");
        let (s, g) = unlock(&ts, &family);
        assert!(ts.clipboard.user_copy("theirs"));
        ts.clipboard.fail_format_at(2);
        assert_eq!(copy(&ts, s, g, SECRET), Err(CLIPBOARD_FAILED));
        assert_eq!(
            ts.clipboard.text(),
            None,
            "the secret stayed without its marks"
        );
        assert!(ts.clipboard.formats().is_empty());
        assert!(!ts.clipboard.is_open(), "the clipboard was left open");
        assert_eq!(ts.shell.clipboard.owner(), None);
        assert_eq!(ts.timer.waiting(), 0, "a timer was set");
    }
}
