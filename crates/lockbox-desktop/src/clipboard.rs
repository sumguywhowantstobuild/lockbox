//! Copying a field to the clipboard (spec §7.3), entirely in Rust (§4.1): the value never crosses to the page. Each
//! copy is kept out of clipboard history and cloud sync ([`ClipboardBackend::write_secret`]), and cleared after the
//! clear delay, or when its vault locks, or when the app closes, but only while the clipboard still holds it: whatever
//! the user copied since is left alone.

use std::num::NonZeroU32;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use zeroize::Zeroizing;

use crate::error::ShellResult;
use crate::lock;
use crate::os::{CLIPBOARD_FAILED, ClipboardBackend, Clock, Os, Timer};
use crate::session::{LockHook, SessionId, Sessions};
use crate::settings::SettingsStore;

/// The clipboard copy Lockbox made last, while it may still be on the clipboard.
#[derive(Debug, Clone, Copy)]
struct Owned {
    /// The clipboard's sequence number right after the copy: any later change moves it on.
    seq: NonZeroU32,
    /// The session the value came from: its lock clears the copy.
    session: SessionId,
    /// This copy's own number: only this copy's timer clears it.
    copy_id: u64,
}

/// What the lock hook and the timers share with [`Clipboard`].
struct Shared {
    backend: Arc<dyn ClipboardBackend>,
    /// Held across each write (so the copy on the clipboard and the one recorded here are always the same) and each
    /// clear. Lock order: a session's publish guard, then this. The hook and the timers take only this.
    owned: Mutex<Option<Owned>>,
    copies: AtomicU64,
}

impl Shared {
    /// Clears the recorded copy when `ours` picks it and the clipboard still holds it. Afterwards nothing is recorded,
    /// unless the clipboard could not be opened or emptied: the copy then stays recorded, so its timer (if still to
    /// come), a lock or the app's close tries again.
    fn clear_where(&self, ours: impl Fn(&Owned) -> bool) {
        let mut owned = lock(&self.owned);
        let Some(copy) = owned.filter(|copy| ours(copy)) else {
            return;
        };
        if self.backend.clear_if(copy.seq).is_ok() {
            *owned = None;
        }
    }
}

/// Lockbox's clipboard copies (spec §7.3).
pub struct Clipboard {
    shared: Arc<Shared>,
    timer: Arc<dyn Timer>,
    clock: Arc<dyn Clock>,
    settings: Arc<SettingsStore>,
    /// Tests only: run once, right after the next write's publish ends, before its timer is set.
    #[cfg(test)]
    after_write: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl Clipboard {
    /// Uses `os`'s clipboard, timer and clock; reads the clear delay from `settings` at each copy.
    pub fn new(os: &Os, settings: Arc<SettingsStore>) -> Clipboard {
        Clipboard {
            shared: Arc::new(Shared {
                backend: Arc::clone(&os.clipboard),
                owned: Mutex::default(),
                copies: AtomicU64::new(0),
            }),
            timer: Arc::clone(&os.timer),
            clock: Arc::clone(&os.clock),
            settings,
            #[cfg(test)]
            after_write: Mutex::default(),
        }
    }

    /// The lock hook, to be added before any other (spec §7.4 step 5): a lock of the session the copy came from, or
    /// of all (`None`, app close included), clears the copy while it is still on the clipboard. Runs on the lock-hook
    /// thread; its clipboard opening gives up after [`CLIPBOARD_TRIES`](crate::os::CLIPBOARD_TRIES) short tries, so it
    /// never holds up the hooks after it for long.
    pub fn lock_hook(&self) -> LockHook {
        let shared = Arc::clone(&self.shared);
        Box::new(move |only, _reason| {
            shared.clear_where(|owned| only.is_none_or(|locked| locked == owned.session));
        })
    }

    /// Copies `secret`, a value read from `session` in `generation`, to the clipboard, and clears it after the clear
    /// delay as set now. The write runs inside [`Sessions::publish`]: never once the session has locked (`Locked`,
    /// nothing written), and recorded before the publish ends, so a lock that comes after it always finds the copy and
    /// its hook clears it.
    pub fn copy(
        &self,
        sessions: &Sessions,
        session: SessionId,
        generation: u64,
        secret: Zeroizing<String>,
    ) -> ShellResult<()> {
        let delay = self.settings.get().clipboard_delay();
        let copy_id = sessions.publish(session, generation, || {
            let mut owned = lock(&self.shared.owned);
            let seq = self.shared.backend.write_secret(&secret)?;
            let copy_id = self.shared.copies.fetch_add(1, Ordering::SeqCst) + 1;
            *owned = Some(Owned {
                seq,
                session,
                copy_id,
            });
            Ok(copy_id)
        })?;
        drop(secret);
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
                shared.clear_where(|owned| owned.copy_id == copy_id);
            }
        };
        if self
            .timer
            .at(self.clock.now() + delay, Box::new(clear))
            .is_err()
        {
            // Without a timer the copy would stay until a lock: take it off now instead.
            self.shared.clear_where(|owned| owned.copy_id == copy_id);
            return Err(CLIPBOARD_FAILED);
        }
        Ok(())
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
    use std::sync::Barrier;
    use std::thread;
    use std::time::{Duration, Instant};

    use lockbox_core::Vault;
    use lockbox_core::recovery::RecoverySecret;

    use super::*;
    use crate::error::{Outcome, ShellError};
    use crate::os::EXCLUSION_FORMATS;
    use crate::session::{Location, LockReason, OpenStep, Opened};
    use crate::settings::Settings;
    use crate::testing::{TestShell, heavy};

    const PW: &str = "correct horse battery";
    const SECRET: &str = "Pw-0123456789-xyz";

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
        ts.clipboard.user_copy("mine");
        at(&ts, start, secs(30));
        assert_eq!(
            ts.clipboard.text().as_deref(),
            Some("mine"),
            "the timer cleared it"
        );

        let start = ts.clock.now();
        copy(&ts, s, g, SECRET).unwrap();
        ts.clipboard.user_copy("mine again");
        ts.shell.sessions.lock(s, LockReason::Manual);
        assert_eq!(
            ts.clipboard.text().as_deref(),
            Some("mine again"),
            "the lock cleared it"
        );
        let (s, g) = unlock(&ts, &family);
        copy(&ts, s, g, SECRET).unwrap();
        ts.clipboard.user_copy("mine a third time");
        ts.shell.sessions.lock_all(LockReason::Manual);
        at(&ts, start, secs(300));
        assert_eq!(
            ts.clipboard.text().as_deref(),
            Some("mine a third time"),
            "lock_all or a timer cleared it"
        );
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

    /// A clear that finds the clipboard busy keeps the copy recorded: the lock that follows clears it.
    #[test]
    fn busy_clear_is_tried_again_at_the_lock() {
        let ts = TestShell::new();
        let family = new_vault(&ts.vaults(), "Family");
        let (s, g) = unlock(&ts, &family);
        let start = ts.clock.now();
        copy(&ts, s, g, SECRET).unwrap();
        ts.clipboard.hold_open_elsewhere(true);
        at(&ts, start, secs(30));
        assert_eq!(ts.clipboard.text().as_deref(), Some(SECRET));
        assert_eq!(ts.shell.clipboard.owner(), Some(s));
        ts.clipboard.hold_open_elsewhere(false);
        ts.shell.sessions.lock(s, LockReason::Manual);
        assert_eq!(ts.clipboard.text(), None);
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
        ts.clipboard.user_copy("theirs");
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
