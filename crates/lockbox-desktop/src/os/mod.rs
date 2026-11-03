//! Calls into the operating system. `win` is the only module of the crate allowed `unsafe`. Each kind of call sits
//! behind a small trait, so the rules built on it are tested with fakes; [`Os`] holds the real ones.

#[cfg(windows)]
pub mod signals;
#[cfg(windows)]
pub mod win;

use std::ffi::{OsStr, OsString};
use std::io;
use std::num::NonZeroU32;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::error::{CoreErrorView, ShellError, ShellResult};
use crate::lock;

/// The OS calls the shell makes, behind their traits.
pub struct Os {
    pub volumes: Arc<dyn Volumes>,
    pub env: Arc<dyn Env>,
    pub dialogs: Arc<dyn Dialogs>,
    pub launcher: Arc<dyn Launcher>,
    pub idle: Arc<dyn IdleSource>,
    pub power: Arc<dyn Power>,
    pub clock: Arc<dyn Clock>,
    pub clipboard: Arc<dyn ClipboardBackend>,
    pub timer: Arc<dyn Timer>,
}

/// A copy's own tag (spec §7.3): 16 random bytes from the OS, written beside the copy in [`TAG_FORMAT`]. Not secret
/// and not derived from the copied value; it only tells Lockbox's copy apart from anything copied since.
pub type CopyTag = [u8; 16];

/// The clipboard as Lockbox uses it (spec §7.3). Each method is one clipboard opening: tried every
/// [`CLIPBOARD_RETRY`], at most [`CLIPBOARD_TRIES`] times, then [`CLIPBOARD_BUSY`]. The clipboard is opened with no
/// owner window, so a program that holds it open with no window of its own does not make it busy (Windows' rule).
pub trait ClipboardBackend: Send + Sync {
    /// Puts `text` on the clipboard with `tag` in [`TAG_FORMAT`] and the three [`EXCLUSION_FORMATS`] that keep it out
    /// of clipboard history, cloud sync and clipboard monitors, all in one opening. The text goes last, so it is never
    /// on the clipboard without its marks. A failure after the clipboard was emptied empties it again in the same
    /// opening; [`WriteFailed::left_behind`] says when that failed too.
    fn write_secret(&self, text: &str, tag: &CopyTag) -> Result<(), WriteFailed>;
    /// Empties the clipboard only while it still holds the copy tagged `tag`, checked and emptied in the same opening:
    /// whether it did. Anything copied since (which empties the clipboard, tag included) is left alone. With
    /// `until` (the app close's deadline), no try at opening starts at or after it and no wait runs past it.
    fn clear_if(&self, tag: &CopyTag, until: Option<Instant>) -> ShellResult<bool>;
}

/// A write that failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WriteFailed {
    pub error: ShellError,
    /// The write had started and the empty after its failure failed as well: the clipboard may still hold the copy's
    /// tag and marks (never its text, which goes last), to be cleared later by the tag.
    pub left_behind: bool,
}

impl WriteFailed {
    /// Nothing of the copy is on the clipboard.
    fn clean(error: ShellError) -> WriteFailed {
        WriteFailed {
            error,
            left_behind: false,
        }
    }
}

/// Another program kept the clipboard open through every try.
pub const CLIPBOARD_BUSY: ShellError = ShellError::Busy { what: "clipboard" };
/// Windows refused a clipboard step. Fixed text only: never the clipboard's text or Windows' message.
pub const CLIPBOARD_FAILED: ShellError = ShellError::Core(CoreErrorView {
    kind: "io",
    what: Some("clipboard"),
    needed: None,
    available: None,
    max_file: None,
    min: None,
});
/// How many times one opening is tried.
pub const CLIPBOARD_TRIES: u32 = 10;
/// The wait between two tries (Chromium's).
pub const CLIPBOARD_RETRY: Duration = Duration::from_millis(5);
/// The formats that keep a copy out of Windows' clipboard history (`CanIncludeInClipboardHistory`), out of cloud
/// clipboard sync (`CanUploadToCloudClipboard`), and out of clipboard monitors that honour it
/// (`ExcludeClipboardContentFromMonitorProcessing`), each set with a DWORD 0.
pub const EXCLUSION_FORMATS: [&str; 3] = [
    "ExcludeClipboardContentFromMonitorProcessing",
    "CanIncludeInClipboardHistory",
    "CanUploadToCloudClipboard",
];
/// Lockbox's own format, holding the copy's [`CopyTag`].
pub const TAG_FORMAT: &str = "Lockbox.CopyTag";

/// The clipboard's single steps, as Windows offers them. [`ClipboardSteps`] puts them in order, so the order and its
/// failure paths are the same for the real clipboard and the tests' fake.
pub trait ClipboardCalls: Send + Sync {
    /// The open clipboard: closed when dropped, on the thread that opened it.
    type Opened;
    /// The ID of the clipboard format `name` (`RegisterClipboardFormatW`); `None` if Windows refuses.
    fn register_format(&self, name: &str) -> Option<NonZeroU32>;
    /// One try at opening the clipboard; `None` while another program has it open.
    fn open(&self) -> Option<Self::Opened>;
    fn empty(&self) -> bool;
    /// Adds the text (`CF_UNICODETEXT`), keeping what is already on the clipboard. On a failure no copy of the text
    /// is left in memory the clipboard does not own.
    fn set_text(&self, text: &str) -> bool;
    /// Adds `format` holding `bytes`, keeping what is already on the clipboard.
    fn set_bytes(&self, format: NonZeroU32, bytes: &[u8]) -> bool;
    /// What `format` holds on the clipboard: `Ok(None)` only when it is confirmed not there, an error when it is there
    /// (or may be) but could not be read.
    fn read_bytes(&self, format: NonZeroU32) -> ShellResult<Option<Vec<u8>>>;
}

/// [`ClipboardBackend`] from single [`ClipboardCalls`] steps, waiting between tries on `clock`.
pub struct ClipboardSteps<C> {
    calls: Arc<C>,
    clock: Arc<dyn Clock>,
}

impl<C: ClipboardCalls> ClipboardSteps<C> {
    pub fn new(calls: Arc<C>, clock: Arc<dyn Clock>) -> ClipboardSteps<C> {
        ClipboardSteps { calls, clock }
    }

    /// One opening: tried every [`CLIPBOARD_RETRY`], at most [`CLIPBOARD_TRIES`] times. With `until`, no try starts
    /// at or after it and no wait runs past it: [`CLIPBOARD_BUSY`] once it has come.
    fn open(&self, until: Option<Instant>) -> ShellResult<C::Opened> {
        for tried in 1..=CLIPBOARD_TRIES {
            if until.is_some_and(|until| self.clock.now() >= until) {
                return Err(CLIPBOARD_BUSY);
            }
            if let Some(opened) = self.calls.open() {
                return Ok(opened);
            }
            if tried < CLIPBOARD_TRIES {
                let left = until.map_or(CLIPBOARD_RETRY, |until| {
                    until.saturating_duration_since(self.clock.now())
                });
                self.clock.sleep(CLIPBOARD_RETRY.min(left));
            }
        }
        Err(CLIPBOARD_BUSY)
    }

    /// The tag's format and the exclusion formats, registered before anything is written.
    fn formats(&self) -> ShellResult<(NonZeroU32, [NonZeroU32; 3])> {
        let tag = self.calls.register_format(TAG_FORMAT);
        match (
            tag,
            EXCLUSION_FORMATS.map(|name| self.calls.register_format(name)),
        ) {
            (Some(tag), [Some(a), Some(b), Some(c)]) => Ok((tag, [a, b, c])),
            _ => Err(CLIPBOARD_FAILED),
        }
    }

    /// The tag, each exclusion format, then the text: false at the first step that fails.
    fn fill(&self, text: &str, tag: &CopyTag, formats: (NonZeroU32, [NonZeroU32; 3])) -> bool {
        let (tag_format, exclusions) = formats;
        self.calls.set_bytes(tag_format, tag)
            && exclusions
                .into_iter()
                .all(|format| self.calls.set_bytes(format, &0u32.to_ne_bytes()))
            && self.calls.set_text(text)
    }
}

impl<C: ClipboardCalls> ClipboardBackend for ClipboardSteps<C> {
    fn write_secret(&self, text: &str, tag: &CopyTag) -> Result<(), WriteFailed> {
        let formats = self.formats().map_err(WriteFailed::clean)?;
        let _open = self.open(None).map_err(WriteFailed::clean)?;
        if !self.calls.empty() {
            return Err(WriteFailed::clean(CLIPBOARD_FAILED));
        }
        if self.fill(text, tag, formats) {
            return Ok(());
        }
        // Still in the same opening: nothing half-written is left for another program to see.
        Err(WriteFailed {
            error: CLIPBOARD_FAILED,
            left_behind: !self.calls.empty(),
        })
    }

    fn clear_if(&self, tag: &CopyTag, until: Option<Instant>) -> ShellResult<bool> {
        let format = self
            .calls
            .register_format(TAG_FORMAT)
            .ok_or(CLIPBOARD_FAILED)?;
        let _open = self.open(until)?;
        // A read that fails is an error (tried again later), never taken for the tag being gone.
        let still_ours = self
            .calls
            .read_bytes(format)?
            .is_some_and(|held| is_tag(&held, tag));
        if !still_ours {
            return Ok(false);
        }
        match self.calls.empty() {
            true => Ok(true),
            false => Err(CLIPBOARD_FAILED),
        }
    }
}

/// Whether `held`, what [`TAG_FORMAT`] holds, is exactly `tag`: the 16 bytes, then nothing, or only zeros (a block
/// may be rounded up to a larger size, `GlobalSize`, and Lockbox's blocks are zero-filled). Anything shorter, or
/// anything else after the tag, is not this copy's.
fn is_tag(held: &[u8], tag: &CopyTag) -> bool {
    held.split_at_checked(tag.len())
        .is_some_and(|(head, rest)| head == tag && rest.iter().all(|&byte| byte == 0))
}

/// Work a [`Timer`] runs later.
pub type Job = Box<dyn FnOnce() + Send>;

/// Runs work at a set time: the clipboard's clear after the delay (spec §7.3).
pub trait Timer: Send + Sync {
    /// Starts the timer's thread, once (later calls do nothing). Called when the clipboard is built, so the app never
    /// runs without it.
    fn start(&self) -> io::Result<()>;
    /// Runs `job` once [`Instant::now`] reaches `when`, on the timer's own thread. An error only when the timer was
    /// never started (or its thread is gone, which a started timer's never is).
    fn at(&self, when: Instant, job: Job) -> io::Result<()>;
}

/// What the timer thread tells a test each time it starts a timed wait: the time it waits for, and when it began.
#[cfg(test)]
type WaitAck = mpsc::Sender<(Instant, Instant)>;

/// The real [`Timer`]: one thread, started by [`start`](Timer::start), that runs each job when its time comes, the
/// earliest first. A job that panics is passed over; the thread carries on.
#[derive(Default)]
pub struct ThreadTimer {
    queue: Mutex<Option<mpsc::Sender<(Instant, Job)>>>,
    /// Tests only: told each time the thread starts a timed wait.
    #[cfg(test)]
    waits: Mutex<Option<WaitAck>>,
}

impl Timer for ThreadTimer {
    fn start(&self) -> io::Result<()> {
        let mut queue = lock(&self.queue);
        if queue.is_some() {
            return Ok(());
        }
        let (sender, jobs) = mpsc::channel();
        #[cfg(test)]
        let waits = lock(&self.waits).clone();
        thread::Builder::new()
            .name("lockbox-timer".into())
            .spawn(move || {
                run_timer(
                    jobs,
                    #[cfg(test)]
                    waits,
                )
            })?;
        *queue = Some(sender);
        Ok(())
    }

    fn at(&self, when: Instant, job: Job) -> io::Result<()> {
        match lock(&self.queue)
            .as_ref()
            .map(|sender| sender.send((when, job)))
        {
            Some(Ok(())) => Ok(()),
            _ => Err(io::Error::other("the timer is not running")),
        }
    }
}

impl ThreadTimer {
    /// Tests only: a timer, not yet started, whose thread reports each timed wait it starts.
    #[cfg(test)]
    fn reporting_waits(acks: WaitAck) -> ThreadTimer {
        let timer = ThreadTimer::default();
        *lock(&timer.waits) = Some(acks);
        timer
    }
}

/// The timer thread: waits for the earliest job's time or a new job, whichever comes first, then runs every job
/// whose time has come. Ends when its [`ThreadTimer`] is dropped.
fn run_timer(jobs: mpsc::Receiver<(Instant, Job)>, #[cfg(test)] waits: Option<WaitAck>) {
    let mut waiting: Vec<(Instant, Job)> = Vec::new();
    loop {
        let received = match waiting.iter().map(|(when, _)| *when).min() {
            None => jobs.recv().map_err(|_| RecvTimeoutError::Disconnected),
            Some(next) => {
                #[cfg(test)]
                if let Some(waits) = &waits {
                    let _ = waits.send((next, Instant::now()));
                }
                jobs.recv_timeout(next.saturating_duration_since(Instant::now()))
            }
        };
        match received {
            Ok(job) => waiting.push(job),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        let now = Instant::now();
        let (mut due, later): (Vec<_>, Vec<_>) =
            waiting.into_iter().partition(|(when, _)| *when <= now);
        waiting = later;
        due.sort_by_key(|(when, _)| *when);
        for (_, job) in due {
            let _ = catch_unwind(AssertUnwindSafe(job));
        }
    }
}

/// How long the user has left Windows alone (spec §7.4: idle means no keyboard or mouse input anywhere in Windows).
pub trait IdleSource: Send + Sync {
    fn since_last_input(&self) -> Duration;
}

/// Keeps the PC awake while a long operation runs (spec §7.4).
pub trait Power: Send + Sync {
    /// `true` asks Windows to stay awake until called with `false`.
    fn keep_awake(&self, on: bool);
}

/// The time now, on the monotonic clock (when a long operation ended), and the waits between clipboard tries.
pub trait Clock: Send + Sync {
    fn now(&self) -> Instant;
    /// Waits `time`: a test's fake clock just moves on by it.
    fn sleep(&self, time: Duration);
}

/// [`Instant::now`] and [`thread::sleep`].
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }

    fn sleep(&self, time: Duration) {
        thread::sleep(time);
    }
}

/// A folder Windows keeps for each user (`SHGetKnownFolderPath`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum KnownFolder {
    /// `%USERPROFILE%`: the default vaults folder goes inside it.
    Profile,
    /// `%LOCALAPPDATA%`: the state folder goes inside it.
    LocalAppData,
    /// `%APPDATA%`, the Roaming profile: never a vault's place (spec §6.10).
    RoamingAppData,
}

/// Environment variables and known folders. Read only through this, never `std::env` directly, so tests give their
/// own (`std::env::set_var` is unsafe in edition 2024).
pub trait Env: Send + Sync {
    fn var(&self, name: &str) -> Option<OsString>;
    fn known_folder(&self, id: KnownFolder) -> io::Result<PathBuf>;
}

/// What Windows says a drive is (`GetDriveTypeW`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DriveType {
    Fixed,
    Removable,
    Remote,
    CdRom,
    RamDisk,
    Unknown,
}

/// Volumes and the folders on them. A `root` is what [`volume_root`](Volumes::volume_root) gives: a drive's root or
/// the folder a volume is mounted on, with its trailing backslash.
pub trait Volumes: Send + Sync {
    fn drive_type(&self, root: &Path) -> DriveType;
    /// The file system's name, such as `NTFS` or `FAT32`.
    fn file_system(&self, root: &Path) -> io::Result<String>;
    fn volume_label(&self, root: &Path) -> io::Result<String>;
    /// The root of the volume `path` is on.
    fn volume_root(&self, path: &Path) -> io::Result<PathBuf>;
    /// Whether `path` (an existing one) is inside a folder a cloud provider syncs and has registered with Windows.
    fn under_sync_root(&self, path: &Path) -> bool;
    /// The provider name the sync root above `path` (an existing one) registered with Windows, such as `OneDrive`;
    /// `None` when there is no sync root there or its name cannot be read.
    fn sync_root_provider(&self, path: &Path) -> Option<String>;
    fn exists(&self, path: &Path) -> io::Result<bool>;
}

/// File dialogs, opened by Rust inside a command (spec §4.2): the path chosen never passes through the page. `None`
/// when the user closed the dialog. Never called under a session or vault lock: a dialog waits for the user.
pub trait Dialogs: Send + Sync {
    /// `start`: the folder the dialog opens in; `None` leaves it to Windows.
    fn pick_folder(&self, title: &str, start: Option<&Path>) -> Option<PathBuf>;
    /// `filter`: a name and the extensions it shows, without dots.
    fn pick_file(&self, title: &str, filter: Option<(&str, &[&str])>) -> Option<PathBuf>;
    fn save_file(
        &self,
        title: &str,
        suggested: &str,
        filter: Option<(&str, &[&str])>,
    ) -> Option<PathBuf>;
}

/// Opens things outside the app with the user's default programs (`ShellExecuteW`). Never called under a session or
/// vault lock: a launch may wait for Windows or the user (spec §7.4).
pub trait Launcher: Send + Sync {
    /// Opens a web link in the default browser. `url` is already parsed and checked to be `http` or `https`; the
    /// launcher passes on its parsed form (`as_str()`), never the text it was parsed from.
    fn open_url(&self, url: &tauri::Url) -> io::Result<()>;
    /// Opens the decrypted copy `file` with its default app, the file's own folder as the working directory.
    fn open_file(&self, file: &Path) -> io::Result<()>;
}

/// Whether `a` and `b` name the same path as the file system compares names: component by component (so a trailing
/// separator changes nothing), each on Windows ordinal and ignoring case, with Windows' own case table (not Unicode
/// lowercasing, which merges names Windows keeps apart); elsewhere exactly.
pub fn same_path(a: &Path, b: &Path) -> bool {
    let (mut a, mut b) = (a.components(), b.components());
    loop {
        match (a.next(), b.next()) {
            (None, None) => return true,
            (Some(x), Some(y)) if same_name(x.as_os_str(), y.as_os_str()) => {}
            _ => return false,
        }
    }
}

/// Whether two names (one path component each) are equal as the file system compares them; see [`same_path`].
pub fn same_name(a: &OsStr, b: &OsStr) -> bool {
    #[cfg(windows)]
    return win::equal_ignoring_case(a, b);
    #[cfg(not(windows))]
    return a == b;
}

/// A Windows event that locks every vault (spec §7.4), or the vaults on a drive that went away (spec §6.10).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OsSignal {
    /// The session was locked, signed out, switched away from (another user's sign-in screen took the console) or
    /// disconnected from remote desktop.
    SessionLocked,
    /// The PC is going to sleep or hibernating.
    Suspending,
    /// Volumes went away: bit 0 of `mask` is drive A:, bit 1 drive B:, bit 2 drive C:, and so on.
    DriveRemoved { mask: u32 },
    /// Windows is signing out or shutting down, and may end the process as soon as the window has the message.
    Ending,
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;
    use crate::testing::{FakeClipboard, FakeClock};

    /// How long a test waits for the timer thread before it fails instead of hanging.
    const GIVE_UP: Duration = Duration::from_secs(60);
    const TAG: CopyTag = [7; 16];
    const OTHER_TAG: CopyTag = [9; 16];

    fn fake_steps() -> (Arc<FakeClipboard>, ClipboardSteps<FakeClipboard>) {
        let fake = Arc::new(FakeClipboard::default());
        (
            Arc::clone(&fake),
            ClipboardSteps::new(fake, Arc::new(FakeClock::default())),
        )
    }

    /// The real timer runs a job whose time has come while a later one, scheduled first, still waits. No timing
    /// window: the near job is due at once, the far one an hour away.
    #[test]
    fn thread_timer_runs_due_jobs_first() {
        let timer = ThreadTimer::default();
        timer.start().unwrap();
        let far_ran = Arc::new(AtomicBool::new(false));
        let far = Arc::clone(&far_ran);
        timer
            .at(
                Instant::now() + Duration::from_secs(3600),
                Box::new(move || far.store(true, Ordering::SeqCst)),
            )
            .unwrap();
        let (ran, near_ran) = mpsc::channel();
        timer
            .at(Instant::now(), Box::new(move || ran.send(()).unwrap()))
            .unwrap();
        assert!(
            near_ran.recv_timeout(GIVE_UP).is_ok(),
            "the due job never ran"
        );
        assert!(!far_ran.load(Ordering::SeqCst), "the later job ran early");

        // A job that panics is passed over: the next one still runs.
        timer
            .at(Instant::now(), Box::new(|| panic!("a job failed")))
            .unwrap();
        let (ran, after_panic) = mpsc::channel();
        timer
            .at(Instant::now(), Box::new(move || ran.send(()).unwrap()))
            .unwrap();
        assert!(
            after_panic.recv_timeout(GIVE_UP).is_ok(),
            "the timer stopped"
        );
    }

    /// Fix round 1 (7), fix round 2 (6): a job scheduled for later runs once its time comes, with nothing else sent to
    /// the timer to wake it, and never before its time. The thread reports that it started a timed wait for that very
    /// time before the time came, so the job was not simply due already when the thread took it.
    #[test]
    fn thread_timer_wakes_for_a_future_deadline() {
        let (acks, waits) = mpsc::channel();
        let timer = ThreadTimer::reporting_waits(acks);
        timer.start().unwrap();
        let when = Instant::now() + Duration::from_secs(1);
        let (ran, ran_at) = mpsc::channel();
        timer
            .at(when, Box::new(move || ran.send(Instant::now()).unwrap()))
            .unwrap();
        let (waits_for, began) = waits.recv_timeout(GIVE_UP).expect("no timed wait");
        assert_eq!(waits_for, when, "waited for another time");
        assert!(began < when, "the wait began only after the job was due");
        let ran_at = ran_at.recv_timeout(GIVE_UP).expect("the timer never woke");
        assert!(ran_at >= when, "ran before its time");
    }

    /// Fix round 2 (2): a timer that was never started takes no job; starting it twice starts one thread.
    #[test]
    fn thread_timer_runs_only_once_started() {
        let timer = ThreadTimer::default();
        assert!(timer.at(Instant::now(), Box::new(|| {})).is_err());
        timer.start().unwrap();
        timer.start().unwrap();
        let (ran, has_run) = mpsc::channel();
        timer
            .at(Instant::now(), Box::new(move || ran.send(()).unwrap()))
            .unwrap();
        assert!(has_run.recv_timeout(GIVE_UP).is_ok());
    }

    /// Fix round 2 (4): only exactly this copy's tag counts, followed by nothing or by the zero bytes a block may be
    /// rounded up with. A shorter payload, or one with anything else after the tag, is someone else's.
    #[test]
    fn only_the_exact_tag_counts() {
        let mut padded = TAG.to_vec();
        padded.extend([0; 8]);
        let mut longer = TAG.to_vec();
        longer.push(1);
        let mut zeros_then_more = TAG.to_vec();
        zeros_then_more.extend([0, 0, 0, 1]);
        let table: [(&[u8], bool); 6] = [
            (&TAG, true),
            (&padded, true),
            (&TAG[..15], false),
            (&longer, false),
            (&zeros_then_more, false),
            (&OTHER_TAG, false),
        ];
        for (payload, ours) in table {
            let (fake, steps) = fake_steps();
            steps.write_secret("ours", &TAG).unwrap();
            fake.replace_tag(payload);
            assert_eq!(steps.clear_if(&TAG, None), Ok(ours), "{payload:?}");
            assert_eq!(fake.text().is_none(), ours, "{payload:?}");
        }
    }

    /// Fix round 2 (1): a tag that is there but cannot be read is not taken for a missing one: the clear fails (to
    /// be tried again) and touches nothing.
    #[test]
    fn unreadable_tag_is_an_error_not_absence() {
        let (fake, steps) = fake_steps();
        steps.write_secret("ours", &TAG).unwrap();
        fake.fail_next_read();
        assert_eq!(steps.clear_if(&TAG, None), Err(CLIPBOARD_FAILED));
        assert_eq!(fake.text().as_deref(), Some("ours"));
        assert_eq!(steps.clear_if(&TAG, None), Ok(true));
    }

    /// Each opening is tried [`CLIPBOARD_TRIES`] times, [`CLIPBOARD_RETRY`] apart, then answers [`CLIPBOARD_BUSY`],
    /// with nothing written.
    #[test]
    fn busy_clipboard_answers_busy_after_ten_tries() {
        let (fake, clock) = (
            Arc::new(FakeClipboard::default()),
            Arc::new(FakeClock::default()),
        );
        let steps = ClipboardSteps::new(Arc::clone(&fake), clock.clone());
        assert!(fake.user_copy("theirs"));
        fake.hold_open_elsewhere(true);
        let began = clock.now();
        assert_eq!(
            steps.write_secret("ours", &TAG),
            Err(WriteFailed {
                error: CLIPBOARD_BUSY,
                left_behind: false
            })
        );
        assert_eq!(
            clock.now() - began,
            CLIPBOARD_RETRY * (CLIPBOARD_TRIES - 1),
            "the tries were not spaced"
        );
        assert_eq!(fake.opens(), 10);
        assert_eq!(steps.clear_if(&TAG, None), Err(CLIPBOARD_BUSY));
        assert_eq!(fake.opens(), 20);
        assert_eq!(fake.text().as_deref(), Some("theirs"));

        // Free again: the write holds the text, the tag and all three marks, and clears only while the tag is there.
        fake.hold_open_elsewhere(false);
        steps.write_secret("ours", &TAG).unwrap();
        assert_eq!(fake.text().as_deref(), Some("ours"));
        assert_eq!(fake.tag(), Some(TAG.to_vec()));
        assert_eq!(fake.formats(), EXCLUSION_FORMATS);
        assert!(!fake.is_open(), "the clipboard was left open");
        assert_eq!(steps.clear_if(&OTHER_TAG, None), Ok(false));
        assert_eq!(
            fake.text().as_deref(),
            Some("ours"),
            "another tag cleared it"
        );
        assert_eq!(steps.clear_if(&TAG, None), Ok(true));
        assert_eq!(fake.text(), None);
        assert_eq!(steps.clear_if(&TAG, None), Ok(false));
    }

    /// Fix round 1 (1, 7): the write is one opening, the text last; the check and the clear are one opening, and
    /// another program trying to copy between them is refused until the clear is done.
    #[test]
    fn write_and_clear_are_each_one_opening() {
        let (fake, steps) = fake_steps();
        steps.write_secret("ours", &TAG).unwrap();
        assert_eq!(
            fake.take_events(),
            [
                "open", "empty", "set tag", "set mark", "set mark", "set mark", "set text", "close"
            ]
        );
        let other = Arc::clone(&fake);
        let (refused, was_refused) = mpsc::channel();
        fake.during_next_read(Box::new(move || {
            refused.send(!other.user_copy("theirs")).unwrap();
        }));
        assert_eq!(steps.clear_if(&TAG, None), Ok(true));
        assert!(
            was_refused.recv().unwrap(),
            "a copy got in between the check and the clear"
        );
        assert_eq!(fake.take_events(), ["open", "read tag", "empty", "close"]);
        assert_eq!(fake.text(), None);
        // Not ours: looked at, never touched.
        assert!(fake.user_copy("theirs"));
        assert_eq!(steps.clear_if(&TAG, None), Ok(false));
        assert_eq!(fake.take_events(), ["open", "read tag", "close"]);
        assert_eq!(fake.text().as_deref(), Some("theirs"));
    }

    /// Fix round 1 (1): another program copies the instant Lockbox's write closes the clipboard. Its copy has no tag,
    /// so no clear ever takes it.
    #[test]
    fn copy_right_after_the_close_is_never_cleared() {
        let (fake, steps) = fake_steps();
        let other = Arc::clone(&fake);
        fake.after_next_close(Box::new(move || assert!(other.user_copy("theirs"))));
        steps.write_secret("ours", &TAG).unwrap();
        assert_eq!(fake.text().as_deref(), Some("theirs"));
        assert_eq!(steps.clear_if(&TAG, None), Ok(false));
        assert_eq!(fake.text().as_deref(), Some("theirs"));
    }

    /// A step that fails empties the clipboard again in the same opening; when that empty fails too, the write says
    /// so (Fix round 1, 4). The text goes last, so a failure before it never leaves the text.
    #[test]
    fn failed_step_empties_in_the_same_opening() {
        let (fake, steps) = fake_steps();
        assert!(fake.user_copy("theirs"));
        fake.fail_format_at(2);
        assert_eq!(
            steps.write_secret("ours", &TAG),
            Err(WriteFailed {
                error: CLIPBOARD_FAILED,
                left_behind: false
            })
        );
        assert_eq!(
            fake.take_events(),
            [
                "open", "empty", "set tag", "set mark", "set mark", "set mark", "empty", "close"
            ]
        );
        assert_eq!((fake.text(), fake.tag()), (None, None));

        // The text itself refused, and the empty after it fails: the tag and marks may be left, never the text.
        let (fake, steps) = fake_steps();
        fake.fail_text();
        fake.fail_empty_at(1);
        assert_eq!(
            steps.write_secret("ours", &TAG),
            Err(WriteFailed {
                error: CLIPBOARD_FAILED,
                left_behind: true
            })
        );
        assert_eq!(fake.text(), None);
        assert_eq!(fake.tag(), Some(TAG.to_vec()));
        assert!(!fake.is_open());
        // Cleared later by its tag.
        assert_eq!(steps.clear_if(&TAG, None), Ok(true));
        assert_eq!(fake.tag(), None);
    }

    /// Fix round 3 (1): with a deadline, no try at opening starts at or after it and no wait runs past it; once it
    /// has come, there is no try at all.
    #[test]
    fn opening_never_starts_at_or_after_the_deadline() {
        let (fake, clock) = (
            Arc::new(FakeClipboard::default()),
            Arc::new(FakeClock::default()),
        );
        fake.watch_clock(clock.clone());
        let steps = ClipboardSteps::new(Arc::clone(&fake), clock.clone());
        steps.write_secret("ours", &TAG).unwrap();
        fake.hold_open_elsewhere(true);
        let start = clock.now();
        let deadline = start + Duration::from_millis(12);
        fake.take_open_times();
        assert_eq!(steps.clear_if(&TAG, Some(deadline)), Err(CLIPBOARD_BUSY));
        let tried: Vec<Duration> = fake
            .take_open_times()
            .iter()
            .map(|at| *at - start)
            .collect();
        let ms = Duration::from_millis;
        assert_eq!(
            tried,
            [ms(0), ms(5), ms(10)],
            "tries at or after the deadline"
        );
        assert_eq!(clock.now(), deadline, "waited past the deadline");

        // Already past: not one try.
        assert_eq!(steps.clear_if(&TAG, Some(deadline)), Err(CLIPBOARD_BUSY));
        assert!(fake.take_open_times().is_empty());
        assert_eq!(fake.text().as_deref(), Some("ours"));
    }

    /// A format Windows will not register: nothing is written, the clipboard is not even opened.
    #[test]
    fn unregistered_format_writes_nothing() {
        let (fake, steps) = fake_steps();
        assert!(fake.user_copy("theirs"));
        fake.refuse_registration();
        assert_eq!(
            steps.write_secret("ours", &TAG),
            Err(WriteFailed {
                error: CLIPBOARD_FAILED,
                left_behind: false
            })
        );
        assert_eq!(steps.clear_if(&TAG, None), Err(CLIPBOARD_FAILED));
        assert_eq!(fake.opens(), 0);
        assert_eq!(fake.text().as_deref(), Some("theirs"));
    }

    /// Fix round 3 (H3): what `same_path` treats as one folder, and what it keeps apart. The registry, `Location`
    /// and `is_within` all rest on it, so a later "simplification" must not merge folders Windows keeps apart.
    #[test]
    fn same_path_table() {
        let same = |a: &str, b: &str| same_path(Path::new(a), Path::new(b));
        let one_folder = [
            (r"\\?\C:\Vaults\Family", r"\\?\C:\Vaults\Family"),
            // A trailing separator, a doubled one, another letter case.
            (r"\\?\C:\Vaults\Family", r"\\?\C:\Vaults\Family\"),
            (r"C:\Vaults\Family", r"C:\Vaults\\Family"),
            (r"\\?\C:\Vaults\Family", r"\\?\c:\VAULTS\family"),
            // `.` in a plain path is the folder itself, as Windows reads it.
            (r"C:\Vaults\.\Family", r"C:\Vaults\Family"),
        ];
        for (a, b) in one_folder {
            assert!(same(a, b), "{a} and {b} should be one folder");
            assert!(same(b, a), "{b} and {a} should be one folder");
        }
        let apart = [
            // `..` is never resolved here: it may lead through a link.
            (r"C:\Vaults\..\Family", r"C:\Family"),
            // A verbatim path and a plain one: different prefixes.
            (r"\\?\C:\Vaults\Family", r"C:\Vaults\Family"),
            // Windows does not normalise a verbatim path, so its `.` is a name of its own.
            (r"\\?\C:\Vaults\.", r"\\?\C:\Vaults"),
            (r"\\?\C:\Vaults\Family", r"\\?\D:\Vaults\Family"),
            (r"\\?\C:\Vaults\Family", r"\\?\C:\Vaults\Family2"),
            (r"\\?\C:\Vaults\Family", r"\\?\C:\Vaults"),
            (r"\\?\C:\Vaults\Family", r"\\?\C:\Vaults\Family "),
        ];
        for (a, b) in apart {
            assert!(!same(a, b), "{a} and {b} should be apart");
            assert!(!same(b, a), "{b} and {a} should be apart");
        }
        let name = |a: &str, b: &str| same_name(OsStr::new(a), OsStr::new(b));
        assert!(name("Family", "fAMILY"));
        assert!(!name("Family", "Family "));
        assert!(!name("Family", "Famil"));
    }
}
