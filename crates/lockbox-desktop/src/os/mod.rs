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

/// The clipboard as Lockbox uses it (spec §7.3). Each method is one clipboard opening: tried every
/// [`CLIPBOARD_RETRY`], at most [`CLIPBOARD_TRIES`] times, then [`CLIPBOARD_BUSY`]. The clipboard is opened with no
/// owner window, so a program that holds it open with no window of its own does not make it busy (Windows' rule).
pub trait ClipboardBackend: Send + Sync {
    /// Puts `text` on the clipboard, marked to stay out of clipboard history, cloud sync and clipboard monitors: the
    /// clipboard's sequence number with Lockbox's copy on it. Nothing is written unless all three marks can be; a
    /// failure after the clipboard was emptied empties it again, so a copy is never left without its marks.
    fn write_secret(&self, text: &str) -> ShellResult<NonZeroU32>;
    /// Empties the clipboard only while it still holds Lockbox's copy (its sequence number is still `ours`), checked
    /// and emptied in the same opening: whether it did. Anything copied since is left alone.
    fn clear_if(&self, ours: NonZeroU32) -> ShellResult<bool>;
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

/// The clipboard's single steps, as Windows offers them (`clipboard_win::raw`). [`ClipboardSteps`] puts them in
/// order, so the order and its failure paths are the same for the real clipboard and the tests' fake.
pub trait ClipboardCalls: Send + Sync {
    /// The open clipboard: closed when dropped, on the thread that opened it.
    type Opened;
    /// The ID of the clipboard format `name` (`RegisterClipboardFormatW`); `None` if Windows refuses.
    fn register_format(&self, name: &str) -> Option<NonZeroU32>;
    /// One try at opening the clipboard; `None` while another program has it open.
    fn open(&self) -> Option<Self::Opened>;
    fn empty(&self) -> bool;
    /// Sets the clipboard's text (it empties the clipboard first, as `raw::set_string` does).
    fn set_text(&self, text: &str) -> bool;
    /// Adds `format` with a DWORD 0, keeping what is already on the clipboard.
    fn set_dword_zero(&self, format: NonZeroU32) -> bool;
    /// The clipboard's sequence number (`GetClipboardSequenceNumber`); `None` without access.
    fn seq_num(&self) -> Option<NonZeroU32>;
}

/// [`ClipboardBackend`] from single [`ClipboardCalls`] steps.
pub struct ClipboardSteps<C>(pub Arc<C>);

impl<C: ClipboardCalls> ClipboardSteps<C> {
    /// One opening: tried every [`CLIPBOARD_RETRY`], at most [`CLIPBOARD_TRIES`] times.
    fn open(&self) -> ShellResult<C::Opened> {
        for tried in 1..=CLIPBOARD_TRIES {
            if let Some(opened) = self.0.open() {
                return Ok(opened);
            }
            if tried < CLIPBOARD_TRIES {
                thread::sleep(CLIPBOARD_RETRY);
            }
        }
        Err(CLIPBOARD_BUSY)
    }

    /// The text, then each exclusion format: false at the first step that fails.
    fn fill(&self, text: &str, formats: [NonZeroU32; 3]) -> bool {
        self.0.set_text(text)
            && formats
                .into_iter()
                .all(|format| self.0.set_dword_zero(format))
    }
}

impl<C: ClipboardCalls> ClipboardBackend for ClipboardSteps<C> {
    /// The sequence number is read right after the clipboard is closed, not while it is open: closing it after a
    /// change adds the formats Windows derives from the text (`CF_TEXT`, `CF_OEMTEXT`, `CF_LOCALE`), each moving the
    /// number on (+3 on Windows 11, seen in the hands-on probe), so a number read while open never matches again.
    /// Another program copying in the instant between the close and the read would have its own copy cleared at the
    /// delay; Lockbox's copy is gone either way.
    fn write_secret(&self, text: &str) -> ShellResult<NonZeroU32> {
        // Registered before anything is written: a copy is never on the clipboard without its marks.
        let [Some(a), Some(b), Some(c)] =
            EXCLUSION_FORMATS.map(|name| self.0.register_format(name))
        else {
            return Err(CLIPBOARD_FAILED);
        };
        {
            let _open = self.open()?;
            if !self.0.empty() {
                return Err(CLIPBOARD_FAILED);
            }
            if !self.fill(text, [a, b, c]) {
                // Never a copy left without all its marks. Best effort: the failure is answered either way.
                self.0.empty();
                return Err(CLIPBOARD_FAILED);
            }
        }
        match self.0.seq_num() {
            Some(seq) => Ok(seq),
            None => {
                // A copy whose number is unknown could never be cleared: take it off now, best effort.
                if let Ok(_open) = self.open() {
                    self.0.empty();
                }
                Err(CLIPBOARD_FAILED)
            }
        }
    }

    fn clear_if(&self, ours: NonZeroU32) -> ShellResult<bool> {
        let _open = self.open()?;
        if self.0.seq_num() != Some(ours) {
            return Ok(false);
        }
        match self.0.empty() {
            true => Ok(true),
            false => Err(CLIPBOARD_FAILED),
        }
    }
}

/// Work a [`Timer`] runs later.
pub type Job = Box<dyn FnOnce() + Send>;

/// Runs work at a set time: the clipboard's clear after the delay (spec §7.3).
pub trait Timer: Send + Sync {
    /// Runs `job` once [`Instant::now`] reaches `when`, on the timer's own thread. An error when it cannot be
    /// scheduled (the thread could not start).
    fn at(&self, when: Instant, job: Job) -> io::Result<()>;
}

/// The real [`Timer`]: one thread, started on first use, that runs each job when its time comes, the earliest
/// first. A job that panics is passed over; the thread carries on.
#[derive(Default)]
pub struct ThreadTimer {
    queue: Mutex<Option<mpsc::Sender<(Instant, Job)>>>,
}

impl Timer for ThreadTimer {
    fn at(&self, when: Instant, job: Job) -> io::Result<()> {
        let mut queue = lock(&self.queue);
        if queue.is_none() {
            let (sender, jobs) = mpsc::channel();
            thread::Builder::new()
                .name("lockbox-timer".into())
                .spawn(move || run_timer(jobs))?;
            *queue = Some(sender);
        }
        match queue.as_ref().map(|sender| sender.send((when, job))) {
            Some(Ok(())) => Ok(()),
            _ => Err(io::Error::other("the timer stopped")),
        }
    }
}

/// The timer thread: waits for the earliest job's time or a new job, whichever comes first, then runs every job
/// whose time has come. Ends when its [`ThreadTimer`] is dropped.
fn run_timer(jobs: mpsc::Receiver<(Instant, Job)>) {
    let mut waiting: Vec<(Instant, Job)> = Vec::new();
    loop {
        let received = match waiting.iter().map(|(when, _)| *when).min() {
            None => jobs.recv().map_err(|_| RecvTimeoutError::Disconnected),
            Some(next) => jobs.recv_timeout(next.saturating_duration_since(Instant::now())),
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

/// The time now, on the monotonic clock: when a long operation ended.
pub trait Clock: Send + Sync {
    fn now(&self) -> Instant;
}

/// [`Instant::now`].
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
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
    fn pick_folder(&self, title: &str) -> Option<PathBuf>;
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
    use crate::testing::FakeClipboard;

    /// How long a test waits for the timer thread before it fails instead of hanging.
    const GIVE_UP: Duration = Duration::from_secs(60);

    /// The real timer runs a job whose time has come while a later one, scheduled first, still waits. No timing
    /// window: the near job is due at once, the far one an hour away.
    #[test]
    fn thread_timer_runs_due_jobs_first() {
        let timer = ThreadTimer::default();
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

    /// Each opening is tried [`CLIPBOARD_TRIES`] times, then answers [`CLIPBOARD_BUSY`], with nothing written.
    #[test]
    fn busy_clipboard_answers_busy_after_ten_tries() {
        let fake = Arc::new(FakeClipboard::default());
        let steps = ClipboardSteps(Arc::clone(&fake));
        fake.user_copy("theirs");
        fake.hold_open_elsewhere(true);
        let theirs = fake.seq();
        assert_eq!(steps.write_secret("ours"), Err(CLIPBOARD_BUSY));
        assert_eq!(fake.opens(), 10);
        assert_eq!(steps.clear_if(theirs), Err(CLIPBOARD_BUSY));
        assert_eq!(fake.opens(), 20);
        assert_eq!(fake.text().as_deref(), Some("theirs"));

        // Free again: the write holds the text and all three marks, and clears only while it is still there.
        fake.hold_open_elsewhere(false);
        let ours = steps.write_secret("ours").unwrap();
        assert_eq!(fake.text().as_deref(), Some("ours"));
        assert_eq!(fake.formats(), EXCLUSION_FORMATS);
        assert!(!fake.is_open(), "the clipboard was left open");
        assert_eq!(steps.clear_if(ours), Ok(true));
        assert_eq!(fake.text(), None);
        assert_eq!(steps.clear_if(ours), Ok(false));
    }

    /// Closing the clipboard after a write adds the formats Windows derives from the text, which moves the sequence
    /// number on: the number recorded is the one after the close, so the clear still finds the copy.
    #[test]
    fn sequence_is_read_after_the_close() {
        let fake = Arc::new(FakeClipboard::default());
        let steps = ClipboardSteps(Arc::clone(&fake));
        let ours = steps.write_secret("ours").unwrap();
        assert_eq!(ours, fake.seq());
        assert_eq!(steps.clear_if(ours), Ok(true));
        assert_eq!(fake.text(), None);

        // No sequence number to be had: the copy could never be cleared by it, so it is taken off at once.
        fake.hide_sequence();
        assert_eq!(steps.write_secret("ours"), Err(CLIPBOARD_FAILED));
        assert_eq!(fake.text(), None);
        assert!(!fake.is_open(), "the clipboard was left open");
    }

    /// A format Windows will not register: nothing is written, the clipboard is not even opened.
    #[test]
    fn unregistered_format_writes_nothing() {
        let fake = Arc::new(FakeClipboard::default());
        fake.user_copy("theirs");
        fake.refuse_registration();
        let steps = ClipboardSteps(Arc::clone(&fake));
        assert_eq!(steps.write_secret("ours"), Err(CLIPBOARD_FAILED));
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
