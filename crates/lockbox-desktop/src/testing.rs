//! Tests only: fakes for the OS calls (`os::{Env, Volumes, Dialogs, Launcher, IdleSource, Power, Clock, ClipboardCalls,
//! Timer}`), a shell built on them inside a temp folder, and the lock that keeps key derivations off a timing test's CPU.

use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::num::NonZeroU32;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError, RwLock, RwLockWriteGuard};
use std::time::{Duration, Instant};
use std::{fs, io};

use lockbox_core::blob::CancelToken;
use lockbox_core::internals::fsio::testutil::TempDir;
use zeroize::Zeroizing;

use crate::capture::CaptureEvent;
use crate::error::ShellResult;
use crate::lock;
use crate::os::{
    CLIPBOARD_FAILED, ClipboardCalls, ClipboardSteps, Clock, Dialogs, DriveType, EXCLUSION_FORMATS,
    Env, Hotkey, HotkeyTaken, IdleSource, InstalledPrinter, InstalledPrinters, Job, KnownFolder,
    Launcher, MainWindow, Os, PRINTERS_UNREADABLE, Power, PrintCalls, PrintDone, PrintFailed,
    PrintSteps, Shortcut, StartupEntry, TAG_FORMAT, Timer, Volumes,
};
use crate::session::{LockReason, Notice, Notifier, SessionId};
use crate::shell::Shell;
use crate::startup::{StartupState, state_of};

/// Each Argon2 run (creating, unlocking or opening a vault) keeps several cores busy for about a second. Every test
/// of the crate shares this lock for reading while it derives a key; a timing test holds it for writing while it
/// measures, so no test's key derivation slows the thread it times.
static CPU: RwLock<()> = RwLock::new(());

/// Runs `work`, which derives a key, while no timing test measures. Never nest it, or call it while holding
/// [`quiet`]: the same thread would wait for itself.
pub fn heavy<T>(work: impl FnOnce() -> T) -> T {
    let _shared = CPU.read().unwrap_or_else(PoisonError::into_inner);
    work()
}

/// Held by a timing test while it measures.
pub fn quiet() -> RwLockWriteGuard<'static, ()> {
    CPU.write().unwrap_or_else(PoisonError::into_inner)
}

/// A notifier that records each `locked` and `busy` event.
#[derive(Default)]
pub struct Events {
    locked: Mutex<Vec<(SessionId, u64, LockReason)>>,
    busy: Mutex<Vec<(Option<SessionId>, Vec<&'static str>)>>,
    /// Each notice, as the page would receive it.
    notices: Mutex<Vec<serde_json::Value>>,
    /// Each capture event, as the page would receive it.
    captures: Mutex<Vec<serde_json::Value>>,
    /// Run once, inside the next `busy` event, before it is recorded.
    on_busy: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl Events {
    /// Runs `hook` once, inside the next `busy` event: it may block or panic there.
    pub fn during_next_busy(&self, hook: Box<dyn FnOnce() + Send>) {
        *lock(&self.on_busy) = Some(hook);
    }

    pub fn locked(&self) -> Vec<(SessionId, u64, LockReason)> {
        lock(&self.locked).clone()
    }

    pub fn busy(&self) -> Vec<(Option<SessionId>, Vec<&'static str>)> {
        lock(&self.busy).clone()
    }

    pub fn notices(&self) -> Vec<serde_json::Value> {
        lock(&self.notices).clone()
    }

    /// Every capture event the shell sent, in order, as the page would receive it.
    pub fn captures(&self) -> Vec<serde_json::Value> {
        lock(&self.captures).clone()
    }
}

impl Notifier for Events {
    fn locked(&self, session: SessionId, generation: u64, reason: LockReason) {
        lock(&self.locked).push((session, generation, reason));
    }

    fn busy(&self, session: Option<SessionId>, operations: &[&'static str]) {
        let hook = lock(&self.on_busy).take();
        if let Some(hook) = hook {
            hook();
        }
        lock(&self.busy).push((session, operations.to_vec()));
    }

    fn notice(&self, notice: &Notice) {
        let notice = serde_json::to_value(notice).expect("a notice serialises");
        lock(&self.notices).push(notice);
    }

    fn capture(&self, event: &CaptureEvent) {
        let event = serde_json::to_value(event).expect("a capture event serialises");
        lock(&self.captures).push(event);
    }
}

/// Idle time the test sets: none until it does.
#[derive(Default)]
pub struct FakeIdle(Mutex<Duration>);

impl FakeIdle {
    pub fn set(&self, since_last_input: Duration) {
        *lock(&self.0) = since_last_input;
    }
}

impl IdleSource for FakeIdle {
    fn since_last_input(&self) -> Duration {
        *lock(&self.0)
    }
}

/// The main window: counts the hides and the times it was brought forward, and can run a step inside the next of each.
#[derive(Default)]
pub struct FakeWindow {
    hides: AtomicUsize,
    on_hide: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    forwards: AtomicUsize,
    on_forward: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    /// Each time the shell asked for capture protection to change while the window was up, in order.
    protections: Mutex<Vec<bool>>,
}

impl FakeWindow {
    /// Each capture protection the shell asked the window for (`true`: kept out of captures), in order.
    pub fn protections(&self) -> Vec<bool> {
        lock(&self.protections).clone()
    }

    /// How many times the shell hid the window.
    pub fn hides(&self) -> usize {
        self.hides.load(Ordering::SeqCst)
    }

    /// How many times the shell brought the window forward.
    pub fn forwards(&self) -> usize {
        self.forwards.load(Ordering::SeqCst)
    }

    /// Runs `hook` once, inside the next bring-forward, before it is counted.
    pub fn during_next_forward(&self, hook: impl FnOnce() + Send + 'static) {
        *lock(&self.on_forward) = Some(Box::new(hook));
    }

    /// Runs `hook` once, inside the next hide, before it is counted: what it sees is what the shell had done by then.
    pub fn during_next_hide(&self, hook: impl FnOnce() + Send + 'static) {
        *lock(&self.on_hide) = Some(Box::new(hook));
    }
}

impl MainWindow for FakeWindow {
    fn hide(&self) {
        let hook = lock(&self.on_hide).take();
        if let Some(hook) = hook {
            hook();
        }
        self.hides.fetch_add(1, Ordering::SeqCst);
    }

    fn bring_forward(&self) {
        let hook = lock(&self.on_forward).take();
        if let Some(hook) = hook {
            hook();
        }
        self.forwards.fetch_add(1, Ordering::SeqCst);
    }

    fn protect_from_capture(&self, on: bool) {
        lock(&self.protections).push(on);
    }
}

/// The save shortcut as Windows holds it, in memory: the one registered, each ask in order, and an answer a test sets
/// for the next ask (`HotkeyTaken::Taken` or `NotSet`, which leaves the one registered as it was, as Windows does).
#[derive(Default)]
pub struct FakeHotkey {
    registered: Mutex<Option<Shortcut>>,
    asked: Mutex<Vec<Option<Shortcut>>>,
    refuse: Mutex<Vec<HotkeyTaken>>,
    /// Run once, inside the next ask, before it is answered.
    on_set: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl FakeHotkey {
    /// Runs `hook` once, inside the next ask: it may block there.
    pub fn during_next_set(&self, hook: impl FnOnce() + Send + 'static) {
        *lock(&self.on_set) = Some(Box::new(hook));
    }

    /// The shortcut registered now.
    pub fn registered(&self) -> Option<Shortcut> {
        *lock(&self.registered)
    }

    /// Every shortcut the shell asked for, in order (`None`: released).
    pub fn asked(&self) -> Vec<Option<Shortcut>> {
        lock(&self.asked).clone()
    }

    /// The next ask is refused with `why`; the ones after it go through unless refused too.
    pub fn refuse_next(&self, why: HotkeyTaken) {
        lock(&self.refuse).push(why);
    }
}

impl Hotkey for FakeHotkey {
    fn set(&self, shortcut: Option<Shortcut>) -> Result<(), HotkeyTaken> {
        lock(&self.asked).push(shortcut);
        let hook = lock(&self.on_set).take();
        if let Some(hook) = hook {
            hook();
        }
        let mut refuse = lock(&self.refuse);
        if !refuse.is_empty() {
            return Err(refuse.remove(0));
        }
        *lock(&self.registered) = shortcut;
        Ok(())
    }
}

/// What the registry holds about starting with Windows, in memory: Lockbox's `Run` entry, and Windows' own on/off value
/// for it. `read` counts and answers what is there now; an error a test sets is the OS's, with its own text, which the
/// shell must never pass on.
#[derive(Default)]
pub struct FakeStartup {
    inner: Mutex<StartupRegistry>,
}

#[derive(Default)]
struct StartupRegistry {
    entry: bool,
    approved_off: bool,
    reads: usize,
    writes: Vec<bool>,
    fail_read: Option<String>,
    fail_write: Option<String>,
}

impl FakeStartup {
    /// How many times the registry was read.
    pub fn reads(&self) -> usize {
        lock(&self.inner).reads
    }

    /// Each write asked for (`true`: the entry on), in order.
    pub fn writes(&self) -> Vec<bool> {
        lock(&self.inner).writes.clone()
    }

    /// Whether Lockbox's `Run` entry is there.
    pub fn entry_present(&self) -> bool {
        lock(&self.inner).entry
    }

    /// Something other than the shell adds or removes the entry.
    pub fn set_entry_elsewhere(&self, present: bool) {
        lock(&self.inner).entry = present;
    }

    /// The person turns Lockbox off in Windows' Startup settings.
    pub fn turn_off_in_windows(&self) {
        lock(&self.inner).approved_off = true;
    }

    /// The person turns it back on there.
    pub fn turn_on_in_windows(&self) {
        lock(&self.inner).approved_off = false;
    }

    /// The next read fails, with `message` as the OS's own words.
    pub fn fail_next_read(&self, message: &str) {
        lock(&self.inner).fail_read = Some(message.to_owned());
    }

    /// The next write fails, with `message` as the OS's own words; the entry is left as it was.
    pub fn fail_next_write(&self, message: &str) {
        lock(&self.inner).fail_write = Some(message.to_owned());
    }
}

impl StartupEntry for FakeStartup {
    fn read(&self) -> io::Result<StartupState> {
        let mut registry = lock(&self.inner);
        registry.reads += 1;
        if let Some(message) = registry.fail_read.take() {
            return Err(io::Error::other(message));
        }
        // Windows' own value as it is written: `03` for off, `02` for on, then a time. The same rule as the real read.
        let approved: [u8; 12] = [
            if registry.approved_off { 3 } else { 2 },
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        ];
        Ok(state_of(registry.entry, Some(&approved)))
    }

    fn write(&self, on: bool) -> io::Result<()> {
        let mut registry = lock(&self.inner);
        registry.writes.push(on);
        if let Some(message) = registry.fail_write.take() {
            return Err(io::Error::other(message));
        }
        registry.entry = on;
        Ok(())
    }
}

/// Records each keep-awake request.
#[derive(Default)]
pub struct FakePower(Mutex<Vec<bool>>);

impl FakePower {
    pub fn calls(&self) -> Vec<bool> {
        lock(&self.0).clone()
    }
}

impl Power for FakePower {
    fn keep_awake(&self, on: bool) {
        lock(&self.0).push(on);
    }
}

/// A clock that stands still until the test moves it.
pub struct FakeClock(Mutex<Instant>);

impl FakeClock {
    pub fn set(&self, now: Instant) {
        *lock(&self.0) = now;
    }
}

impl Default for FakeClock {
    fn default() -> Self {
        FakeClock(Mutex::new(Instant::now()))
    }
}

impl Clock for FakeClock {
    fn now(&self) -> Instant {
        *lock(&self.0)
    }

    /// No real wait: the clock moves on by `time`.
    fn sleep(&self, time: Duration) {
        *lock(&self.0) += time;
    }
}

/// The clipboard as the test sees it: its text, the tag and the marks beside it, and whether it is open.
#[derive(Default)]
struct Clip {
    open: bool,
    /// Another program has it open: every try at opening fails while this is above zero, each try counting it down
    /// (`usize::MAX`: until released).
    held_for: usize,
    text: Option<String>,
    /// What [`TAG_FORMAT`] holds.
    tag: Option<Vec<u8>>,
    /// The names of the exclusion formats added, in order.
    formats: Vec<&'static str>,
    /// The exclusion format added when this many are already there fails.
    fail_format_at: Option<usize>,
    fail_text: bool,
    /// Counts the coming empties down: the one reaching zero fails.
    fail_empty_in: Option<usize>,
    refuse_registration: bool,
    /// Each step, in order: `open`, `close`, `empty`, `set tag`, `set mark`, `set text`, `read tag`, `text size`,
    /// `read text`.
    events: Vec<&'static str>,
    /// Run once, right after the next close, with the clipboard free again.
    after_close: Option<Hook>,
    /// Run once, inside the next read of the tag, with the clipboard still open.
    during_read: Option<Hook>,
    /// The next read of the tag, or look at the text's size, fails, though what it reads is there.
    fail_read: bool,
    /// Something that is not text is on the clipboard (a picture, a list of files).
    non_text: bool,
}

/// The format IDs the fake hands out: the exclusion formats from `0xC000`, the tag's format at [`FAKE_TAG_FORMAT`].
const FAKE_FORMATS: u32 = 0xC000;
const FAKE_TAG_FORMAT: u32 = 0xC010;

/// A clipboard in memory, driven through [`ClipboardSteps`](crate::os::ClipboardSteps) like the real one. Counts the
/// tries at opening it and records each step.
#[derive(Default)]
pub struct FakeClipboard {
    clip: Arc<Mutex<Clip>>,
    opens: AtomicUsize,
    /// The clock each try at opening is timed by, once the test gives one.
    clock: Mutex<Option<Arc<FakeClock>>>,
    /// When each try at opening was made, by that clock.
    open_times: Mutex<Vec<Instant>>,
}

/// The fake clipboard, open: closed when dropped.
pub struct FakeOpened(Arc<Mutex<Clip>>);

impl Drop for FakeOpened {
    fn drop(&mut self) {
        let hook = {
            let mut clip = lock(&self.0);
            clip.open = false;
            clip.events.push("close");
            clip.after_close.take()
        };
        if let Some(hook) = hook {
            hook();
        }
    }
}

impl FakeClipboard {
    /// The user (another program) copies `text`, which empties the clipboard first, as every copy does. Refused while
    /// the clipboard is open (false), as Windows refuses it.
    pub fn user_copy(&self, text: &str) -> bool {
        let mut clip = lock(&self.clip);
        if clip.open {
            return false;
        }
        clip.text = Some(text.to_owned());
        clip.tag = None;
        clip.formats.clear();
        clip.non_text = false;
        true
    }

    /// The user (another program) copies something that is not text. Refused while the clipboard is open (false).
    pub fn user_copy_non_text(&self) -> bool {
        let mut clip = lock(&self.clip);
        if clip.open {
            return false;
        }
        clip.text = None;
        clip.tag = None;
        clip.formats.clear();
        clip.non_text = true;
        true
    }

    /// Whether something that is not text is on the clipboard.
    pub fn has_non_text(&self) -> bool {
        lock(&self.clip).non_text
    }

    /// From now on, while `held`, another program keeps the clipboard open.
    pub fn hold_open_elsewhere(&self, held: bool) {
        lock(&self.clip).held_for = if held { usize::MAX } else { 0 };
    }

    /// Another program keeps the clipboard open through the next `tries` tries at opening it.
    pub fn hold_open_for(&self, tries: usize) {
        lock(&self.clip).held_for = tries;
    }

    /// From now on, adding an exclusion format fails once `n` are already on the clipboard.
    pub fn fail_format_at(&self, n: usize) {
        lock(&self.clip).fail_format_at = Some(n);
    }

    /// From now on, adding the text fails.
    pub fn fail_text(&self) {
        lock(&self.clip).fail_text = true;
    }

    /// The `n`th empty from now (0: the next one) fails, leaving the clipboard as it was.
    pub fn fail_empty_at(&self, n: usize) {
        lock(&self.clip).fail_empty_in = Some(n);
    }

    /// From now on, Windows refuses to register clipboard formats.
    pub fn refuse_registration(&self) {
        lock(&self.clip).refuse_registration = true;
    }

    /// Runs `hook` once, right after the next close.
    pub fn after_next_close(&self, hook: Hook) {
        lock(&self.clip).after_close = Some(hook);
    }

    /// Runs `hook` once, inside the next read of the tag, while the clipboard is open.
    pub fn during_next_read(&self, hook: Hook) {
        lock(&self.clip).during_read = Some(hook);
    }

    /// The next read of the tag fails, as `GetClipboardData` or `GlobalLock` can.
    pub fn fail_next_read(&self) {
        lock(&self.clip).fail_read = true;
    }

    /// The tag's format now holds `payload`, as if written that way (another program's, or a block rounded up).
    pub fn replace_tag(&self, payload: &[u8]) {
        lock(&self.clip).tag = Some(payload.to_vec());
    }

    pub fn text(&self) -> Option<String> {
        lock(&self.clip).text.clone()
    }

    pub fn tag(&self) -> Option<Vec<u8>> {
        lock(&self.clip).tag.clone()
    }

    pub fn formats(&self) -> Vec<&'static str> {
        lock(&self.clip).formats.clone()
    }

    pub fn is_open(&self) -> bool {
        lock(&self.clip).open
    }

    /// How many times opening it was tried.
    pub fn opens(&self) -> usize {
        self.opens.load(Ordering::SeqCst)
    }

    /// From now on, each try at opening is timed by `clock`.
    pub fn watch_clock(&self, clock: Arc<FakeClock>) {
        *lock(&self.clock) = Some(clock);
    }

    /// When each try at opening was made since the last call, by the watched clock.
    pub fn take_open_times(&self) -> Vec<Instant> {
        std::mem::take(&mut lock(&self.open_times))
    }

    /// The steps so far, and forgets them.
    pub fn take_events(&self) -> Vec<&'static str> {
        std::mem::take(&mut lock(&self.clip).events)
    }
}

impl ClipboardCalls for FakeClipboard {
    type Opened = FakeOpened;

    fn register_format(&self, name: &str) -> Option<NonZeroU32> {
        if lock(&self.clip).refuse_registration {
            return None;
        }
        if name == TAG_FORMAT {
            return NonZeroU32::new(FAKE_TAG_FORMAT);
        }
        let at = EXCLUSION_FORMATS.iter().position(|known| *known == name)?;
        NonZeroU32::new(FAKE_FORMATS + u32::try_from(at).ok()?)
    }

    fn open(&self) -> Option<FakeOpened> {
        self.opens.fetch_add(1, Ordering::SeqCst);
        if let Some(clock) = lock(&self.clock).as_ref() {
            lock(&self.open_times).push(clock.now());
        }
        let mut clip = lock(&self.clip);
        if clip.held_for > 0 {
            if clip.held_for != usize::MAX {
                clip.held_for -= 1;
            }
            return None;
        }
        assert!(!clip.open, "opened twice");
        clip.open = true;
        clip.events.push("open");
        Some(FakeOpened(Arc::clone(&self.clip)))
    }

    fn empty(&self) -> bool {
        let mut clip = lock(&self.clip);
        assert!(clip.open, "emptied while closed");
        clip.events.push("empty");
        match clip.fail_empty_in {
            Some(0) => {
                clip.fail_empty_in = None;
                return false;
            }
            Some(n) => clip.fail_empty_in = Some(n - 1),
            None => {}
        }
        clip.text = None;
        clip.tag = None;
        clip.formats.clear();
        clip.non_text = false;
        true
    }

    fn set_text(&self, text: &str) -> bool {
        let mut clip = lock(&self.clip);
        assert!(clip.open, "written while closed");
        clip.events.push("set text");
        if clip.fail_text {
            return false;
        }
        clip.text = Some(text.to_owned());
        true
    }

    fn set_bytes(&self, format: NonZeroU32, bytes: &[u8]) -> bool {
        let mut clip = lock(&self.clip);
        assert!(clip.open, "written while closed");
        if format.get() == FAKE_TAG_FORMAT {
            clip.events.push("set tag");
            clip.tag = Some(bytes.to_vec());
            return true;
        }
        clip.events.push("set mark");
        assert_eq!(bytes, 0u32.to_ne_bytes(), "a mark is a DWORD 0");
        if clip.fail_format_at == Some(clip.formats.len()) {
            return false;
        }
        let name = EXCLUSION_FORMATS[(format.get() - FAKE_FORMATS) as usize];
        clip.formats.push(name);
        true
    }

    fn read_bytes(&self, format: NonZeroU32) -> ShellResult<Option<Vec<u8>>> {
        let (held, failed, hook) = {
            let mut clip = lock(&self.clip);
            assert!(clip.open, "read while closed");
            assert_eq!(format.get(), FAKE_TAG_FORMAT, "only the tag is read");
            clip.events.push("read tag");
            let failed = std::mem::take(&mut clip.fail_read);
            (clip.tag.clone(), failed, clip.during_read.take())
        };
        if let Some(hook) = hook {
            hook();
        }
        match failed {
            true => Err(CLIPBOARD_FAILED),
            false => Ok(held),
        }
    }

    fn text_size(&self) -> ShellResult<Option<usize>> {
        let mut clip = lock(&self.clip);
        assert!(clip.open, "looked at while closed");
        clip.events.push("text size");
        if std::mem::take(&mut clip.fail_read) {
            return Err(CLIPBOARD_FAILED);
        }
        // UTF-16 units and the terminator, two bytes each, as Windows holds it.
        Ok(clip
            .text
            .as_ref()
            .map(|text| (text.encode_utf16().count() + 1) * 2))
    }

    fn copy_text(&self) -> ShellResult<Option<Zeroizing<String>>> {
        let (text, hook) = {
            let mut clip = lock(&self.clip);
            assert!(clip.open, "read while closed");
            clip.events.push("read text");
            (clip.text.clone(), clip.during_read.take())
        };
        if let Some(hook) = hook {
            hook();
        }
        Ok(text.map(Zeroizing::new))
    }
}

/// A timer that runs nothing by itself: the test runs the jobs whose time has come, with [`run_due`](Self::run_due).
#[derive(Default)]
pub struct FakeTimer {
    jobs: Mutex<Vec<(Instant, Job)>>,
    /// The next job cannot be scheduled.
    fail_next: AtomicBool,
}

impl FakeTimer {
    /// The next job cannot be scheduled, as if the timer thread could not start.
    pub fn fail_next(&self) {
        self.fail_next.store(true, Ordering::SeqCst);
    }

    /// Runs, earliest first, every job due at `now`.
    pub fn run_due(&self, now: Instant) {
        let mut due: Vec<(Instant, Job)> = {
            let mut jobs = lock(&self.jobs);
            let (due, later) = jobs.drain(..).partition(|(when, _)| *when <= now);
            *jobs = later;
            due
        };
        due.sort_by_key(|(when, _)| *when);
        for (_, job) in due {
            job();
        }
    }

    /// How many jobs wait.
    pub fn waiting(&self) -> usize {
        lock(&self.jobs).len()
    }
}

thread_local! {
    /// The next fake timer started on this thread fails to start.
    static FAIL_TIMER_START: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// The next fake timer this thread starts fails to start, as if its thread could not be made.
pub fn fail_next_timer_start() {
    FAIL_TIMER_START.set(true);
}

impl Timer for FakeTimer {
    fn start(&self) -> io::Result<()> {
        match FAIL_TIMER_START.take() {
            true => Err(io::Error::other("no thread")),
            false => Ok(()),
        }
    }

    fn at(&self, when: Instant, job: Job) -> io::Result<()> {
        if self.fail_next.swap(false, Ordering::SeqCst) {
            return Err(io::Error::other("no timer"));
        }
        lock(&self.jobs).push((when, job));
        Ok(())
    }
}

/// Environment variables set by the test, and known folders inside a temp folder.
pub struct FakeEnv {
    vars: Mutex<HashMap<String, OsString>>,
    folders: HashMap<KnownFolder, PathBuf>,
}

impl FakeEnv {
    /// Known folders `profile`, `local` and `roaming` inside `base`, made on the spot.
    pub fn new(base: &Path) -> FakeEnv {
        let folders = [
            (KnownFolder::Profile, "profile"),
            (KnownFolder::LocalAppData, "local"),
            (KnownFolder::RoamingAppData, "roaming"),
        ]
        .into_iter()
        .map(|(id, name)| {
            let folder = base.join(name);
            fs::create_dir_all(&folder).unwrap();
            (id, folder)
        })
        .collect();
        FakeEnv {
            vars: Mutex::default(),
            folders,
        }
    }

    pub fn set_var(&self, name: &str, value: impl Into<OsString>) {
        lock(&self.vars).insert(name.to_owned(), value.into());
    }

    pub fn folder(&self, id: KnownFolder) -> PathBuf {
        self.folders[&id].clone()
    }
}

impl Env for FakeEnv {
    fn var(&self, name: &str) -> Option<OsString> {
        lock(&self.vars).get(name).cloned()
    }

    fn known_folder(&self, id: KnownFolder) -> io::Result<PathBuf> {
        self.folders
            .get(&id)
            .cloned()
            .ok_or_else(|| io::ErrorKind::NotFound.into())
    }
}

/// A step a test runs once, inside a fake's call.
type Hook = Box<dyn FnOnce() + Send>;

/// A volume as [`FakeVolumes`] reports it.
#[derive(Clone, Copy)]
pub struct FakeVolume {
    pub drive: DriveType,
    pub file_system: &'static str,
    pub label: &'static str,
}

/// A fixed NTFS drive: what every path is on unless the test says otherwise.
pub const LOCAL_NTFS: FakeVolume = FakeVolume {
    drive: DriveType::Fixed,
    file_system: "NTFS",
    label: "Windows",
};

/// Volumes the test describes: folders it mounts a [`FakeVolume`] on, and cloud sync roots. Everything else is on a
/// fixed NTFS drive whose root is the path's own drive.
#[derive(Default)]
pub struct FakeVolumes {
    /// Canonical roots, each with its volume.
    mounted: Mutex<Vec<(PathBuf, FakeVolume)>>,
    /// Canonical sync roots, each with the provider name it registered (`None`: unreadable).
    sync_roots: Mutex<Vec<(PathBuf, Option<String>)>>,
    /// Run once, on the next `volume_root` call: in the middle of a location check.
    on_volume_root: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    /// Folders gone (their drive unplugged): they and everything in them do not exist.
    vanished: Mutex<Vec<PathBuf>>,
    /// Run once, inside the next `exists` call: it may block there, as a stalled drive does.
    on_exists: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    /// Run once, inside the next `exists` call for a path inside the folder given with it.
    on_exists_at: Mutex<Option<(PathBuf, Hook)>>,
    /// How many `exists` calls have started.
    exists_calls: AtomicUsize,
}

fn canonical(dir: &Path) -> PathBuf {
    fs::canonicalize(dir).unwrap()
}

fn inside(path: &Path, root: &Path) -> bool {
    crate::locations::is_within(path, root)
}

impl FakeVolumes {
    /// From now on, the existing folder `root` is a volume of its own, described by `volume`.
    pub fn mount(&self, root: &Path, volume: FakeVolume) {
        lock(&self.mounted).push((canonical(root), volume));
    }

    /// From now on, the existing folder `root` is a cloud sync root whose provider name cannot be read.
    pub fn add_sync_root(&self, root: &Path) {
        lock(&self.sync_roots).push((canonical(root), None));
    }

    /// From now on, the existing folder `root` is a cloud sync root registered by the provider `name`.
    pub fn add_sync_root_named(&self, root: &Path, name: &str) {
        lock(&self.sync_roots).push((canonical(root), Some(name.to_owned())));
    }

    /// The innermost sync root `path` is inside.
    fn sync_root(&self, path: &Path) -> Option<(PathBuf, Option<String>)> {
        lock(&self.sync_roots)
            .iter()
            .filter(|(root, _)| inside(path, root))
            .max_by_key(|(root, _)| root.components().count())
            .cloned()
    }

    /// Runs `hook` once, on the next `volume_root` call: in the middle of the next location check.
    pub fn during_next_check(&self, hook: Box<dyn FnOnce() + Send>) {
        *lock(&self.on_volume_root) = Some(hook);
    }

    /// Runs `hook` once, inside the next `exists` call.
    pub fn during_next_exists(&self, hook: Box<dyn FnOnce() + Send>) {
        *lock(&self.on_exists) = Some(hook);
    }

    /// Runs `hook` once, inside the next `exists` call for a path inside `dir`.
    pub fn during_exists_at(&self, dir: &Path, hook: Box<dyn FnOnce() + Send>) {
        *lock(&self.on_exists_at) = Some((canonical(dir), hook));
    }

    /// How many `exists` calls have started.
    pub fn exists_calls(&self) -> usize {
        self.exists_calls.load(Ordering::SeqCst)
    }

    /// From now on, the folder `dir` and everything in it are gone, as if its drive were unplugged.
    pub fn vanish(&self, dir: &Path) {
        lock(&self.vanished).push(canonical(dir));
    }

    /// The innermost mounted volume `path` is inside.
    fn mounted_at(&self, path: &Path) -> Option<(PathBuf, FakeVolume)> {
        lock(&self.mounted)
            .iter()
            .filter(|(root, _)| inside(path, root))
            .max_by_key(|(root, _)| root.components().count())
            .cloned()
    }

    fn volume(&self, root: &Path) -> FakeVolume {
        lock(&self.mounted)
            .iter()
            .find(|(mounted, _)| crate::os::same_path(mounted, root))
            .map_or(LOCAL_NTFS, |(_, volume)| *volume)
    }
}

impl Volumes for FakeVolumes {
    fn drive_type(&self, root: &Path) -> DriveType {
        self.volume(root).drive
    }

    fn file_system(&self, root: &Path) -> io::Result<String> {
        Ok(self.volume(root).file_system.to_owned())
    }

    fn volume_label(&self, root: &Path) -> io::Result<String> {
        Ok(self.volume(root).label.to_owned())
    }

    fn volume_root(&self, path: &Path) -> io::Result<PathBuf> {
        let hook = lock(&self.on_volume_root).take();
        if let Some(hook) = hook {
            hook();
        }
        if let Some((root, _)) = self.mounted_at(path) {
            return Ok(root);
        }
        // The drive: the path's prefix and root separator.
        Ok(path
            .components()
            .take_while(|c| matches!(c, Component::Prefix(_) | Component::RootDir))
            .collect())
    }

    fn under_sync_root(&self, path: &Path) -> bool {
        self.sync_root(path).is_some()
    }

    fn sync_root_provider(&self, path: &Path) -> Option<String> {
        self.sync_root(path)?.1
    }

    fn exists(&self, path: &Path) -> io::Result<bool> {
        self.exists_calls.fetch_add(1, Ordering::SeqCst);
        let hook = {
            let mut at = lock(&self.on_exists_at);
            match at.as_ref() {
                Some((dir, _)) if inside(path, dir) => at.take().map(|(_, hook)| hook),
                _ => None,
            }
        };
        if let Some(hook) = hook {
            hook();
        }
        let hook = lock(&self.on_exists).take();
        if let Some(hook) = hook {
            hook();
        }
        if lock(&self.vanished).iter().any(|gone| inside(path, gone)) {
            return Ok(false);
        }
        path.try_exists()
    }
}

/// Dialogs that answer what the test queued, in order (`None`, as if closed, once the queue is empty), and count how
/// often they were opened.
#[derive(Default)]
pub struct FakeDialogs {
    answers: Mutex<VecDeque<Option<PathBuf>>>,
    opened: AtomicUsize,
    /// Run once, inside the next dialog, before it answers: while the user would be choosing.
    on_open: Mutex<Option<Hook>>,
    /// The start folder each folder dialog was given, in order.
    starts: Mutex<Vec<Option<PathBuf>>>,
    /// The name each save dialog suggested, in order.
    suggested: Mutex<Vec<String>>,
    /// The title each save dialog was given, in order.
    titles: Mutex<Vec<String>>,
    /// The filter each save dialog was given, in order: its name and extensions, or `None` for no filter.
    filters: Mutex<Vec<Filter>>,
}

/// A dialog's filter as the fake records it: a name and the extensions it shows, or none.
pub type Filter = Option<(String, Vec<String>)>;

impl FakeDialogs {
    /// The filter each save dialog was opened with, in order (`None`: no filter, so a real dialog adds no extension).
    pub fn filters(&self) -> Vec<Filter> {
        lock(&self.filters).clone()
    }

    /// The title each save dialog was opened with, in order.
    pub fn titles(&self) -> Vec<String> {
        lock(&self.titles).clone()
    }

    /// The start folder each folder dialog was opened with (`None`: none given), in order.
    pub fn folder_starts(&self) -> Vec<Option<PathBuf>> {
        lock(&self.starts).clone()
    }

    pub fn answer(&self, answer: Option<PathBuf>) {
        lock(&self.answers).push_back(answer);
    }

    pub fn opened(&self) -> usize {
        self.opened.load(Ordering::SeqCst)
    }

    pub fn suggested(&self) -> Vec<String> {
        lock(&self.suggested).clone()
    }

    /// Runs `hook` once, inside the next dialog, before it answers.
    pub fn during_next_dialog(&self, hook: Hook) {
        *lock(&self.on_open) = Some(hook);
    }

    fn next(&self) -> Option<PathBuf> {
        self.opened.fetch_add(1, Ordering::SeqCst);
        let hook = lock(&self.on_open).take();
        if let Some(hook) = hook {
            hook();
        }
        lock(&self.answers).pop_front().flatten()
    }
}

impl Dialogs for FakeDialogs {
    fn pick_folder(&self, _title: &str, start: Option<&Path>) -> Option<PathBuf> {
        lock(&self.starts).push(start.map(Path::to_path_buf));
        self.next()
    }

    fn pick_file(&self, _title: &str, _filter: Option<(&str, &[&str])>) -> Option<PathBuf> {
        self.next()
    }

    fn save_file(
        &self,
        title: &str,
        suggested: &str,
        filter: Option<(&str, &[&str])>,
    ) -> Option<PathBuf> {
        lock(&self.filters).push(filter.map(|(name, extensions)| {
            (
                name.to_owned(),
                extensions.iter().map(|e| (*e).to_owned()).collect(),
            )
        }));
        lock(&self.titles).push(title.to_owned());
        lock(&self.suggested).push(suggested.to_owned());
        self.next()
    }
}

/// A launcher that records each link (its parsed form) and each file it is given instead of opening them.
#[derive(Default)]
pub struct FakeLauncher {
    opened: Mutex<Vec<String>>,
    opened_files: Mutex<Vec<PathBuf>>,
    /// Run once, inside the next launch, before it returns.
    on_open: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    /// The next file launch fails.
    fail_next_file: AtomicBool,
}

impl FakeLauncher {
    pub fn opened(&self) -> Vec<String> {
        lock(&self.opened).clone()
    }

    pub fn opened_files(&self) -> Vec<PathBuf> {
        lock(&self.opened_files).clone()
    }

    /// Runs `hook` once, inside the next launch: while the link or file is being opened.
    pub fn during_next_open(&self, hook: Box<dyn FnOnce() + Send>) {
        *lock(&self.on_open) = Some(hook);
    }

    /// The next file launch fails, as when no app takes the file's type.
    pub fn fail_next_file(&self) {
        self.fail_next_file.store(true, Ordering::SeqCst);
    }

    fn run_hook(&self) {
        let hook = lock(&self.on_open).take();
        if let Some(hook) = hook {
            hook();
        }
    }
}

impl Launcher for FakeLauncher {
    fn open_url(&self, url: &tauri::Url) -> io::Result<()> {
        lock(&self.opened).push(url.as_str().to_owned());
        self.run_hook();
        Ok(())
    }

    fn open_file(&self, file: &Path) -> io::Result<()> {
        lock(&self.opened_files).push(file.to_path_buf());
        self.run_hook();
        match self.fail_next_file.swap(false, Ordering::SeqCst) {
            true => Err(io::Error::other("no app")),
            false => Ok(()),
        }
    }
}

/// What a fake print job found at its path when it began.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartedPrint {
    pub path: PathBuf,
    /// The file was already there (WebView2 writes over the path it is given).
    pub existed: bool,
    /// ...and was hidden.
    pub hidden: bool,
    /// Its folder was hidden.
    pub folder_hidden: bool,
}

/// Whether `path` is there and hidden (`FILE_ATTRIBUTE_HIDDEN`).
fn is_hidden(path: Option<&Path>) -> bool {
    path.and_then(|path| fs::symlink_metadata(path).ok())
        .is_some_and(|meta| std::os::windows::fs::MetadataExt::file_attributes(&meta) & 0x2 != 0)
}

/// The printing calls as the test sees them: records each job, holds its `done` until the test ends the job, and can
/// refuse to begin one. Like WebView2, a PDF job refuses to write over an existing hidden file: it ends unsuccessful,
/// writing nothing.
#[derive(Default)]
pub struct FakePrintCalls {
    started: Mutex<Vec<StartedPrint>>,
    /// Jobs begun and not ended, oldest first, each with its path (empty for a job for a printer).
    waiting: Mutex<VecDeque<(PathBuf, PrintDone)>>,
    /// The next `start` or `start_on_printer` refuses with this.
    refuse_next: Mutex<Option<PrintFailed>>,
    /// What a job that ends well leaves in its file (it opens the file that is there and writes over it, as WebView2
    /// does); `None` writes nothing.
    pdf: Mutex<Option<Vec<u8>>>,
    /// The printers the fake Windows has, and its default.
    installed: Mutex<InstalledPrinters>,
    /// Listing the printers fails (once) with this.
    list_fails: Mutex<bool>,
    /// Run once, inside the next listing, before it answers: a test locks the session there.
    on_list: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    /// The name each printer job was begun for, in order (and not refused as busy: the calls are what is counted).
    printed_to: Mutex<Vec<String>>,
    /// Run once, when the next PDF job begins, on the thread that begins it.
    on_start: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    /// Jobs queued for the webview's thread and not yet submitted to WebView2, oldest first.
    queued: Mutex<VecDeque<QueuedPrint>>,
    /// Jobs wait in `queued` until the test calls `submit_queued`.
    held: AtomicBool,
    /// The printers' names, and every job's path, of the jobs that reached WebView2.
    submitted: Mutex<Vec<String>>,
    submitted_jobs: Mutex<Vec<PathBuf>>,
}

impl FakePrintCalls {
    pub fn started(&self) -> Vec<StartedPrint> {
        lock(&self.started).clone()
    }

    /// The next job is refused when it starts.
    pub fn refuse_next(&self, failed: PrintFailed) {
        *lock(&self.refuse_next) = Some(failed);
    }

    /// A job that ends well writes `bytes` over its file first (a new file, or a visible one that is there).
    pub fn write_on_success(&self, bytes: &[u8]) {
        *lock(&self.pdf) = Some(bytes.to_vec());
    }

    /// `hook` runs once, on the thread that begins the next job, when it is begun: a test arms a failpoint there that
    /// the same thread reaches later (failpoints are per thread).
    pub fn on_start(&self, hook: impl FnOnce() + Send + 'static) {
        *lock(&self.on_start) = Some(Box::new(hook));
    }

    /// How many jobs have begun and not ended.
    pub fn running(&self) -> usize {
        lock(&self.waiting).len()
    }

    /// The printers the fake Windows has, and the default one's name.
    pub fn set_printers(&self, printers: Vec<InstalledPrinter>, default: Option<&str>) {
        *lock(&self.installed) = InstalledPrinters {
            printers,
            default: default.map(str::to_owned),
        };
    }

    /// The next listing of printers fails.
    pub fn fail_listing(&self) {
        *lock(&self.list_fails) = true;
    }

    /// `hook` runs inside the next listing of printers, before it answers.
    pub fn on_listing(&self, hook: impl FnOnce() + Send + 'static) {
        *lock(&self.on_list) = Some(Box::new(hook));
    }

    /// The names the printer jobs were begun for, in order.
    pub fn printed_to(&self) -> Vec<String> {
        lock(&self.printed_to).clone()
    }

    /// Ends the oldest running job with `result`; false when none runs.
    pub fn finish(&self, result: Result<(), PrintFailed>) -> bool {
        let Some((path, done)) = lock(&self.waiting).pop_front() else {
            return false;
        };
        let mut result = result;
        // A PDF job (a job for a printer has no path). WebView2 ends one that meets an existing hidden file without an error
        // and without a file.
        if result.is_ok() && !path.as_os_str().is_empty() {
            if is_hidden(Some(&path)) {
                result = Err(PrintFailed::NotWritten { code: 0 });
            } else if let Some(pdf) = lock(&self.pdf).clone() {
                // Writes over the file that is there (truncating it), or makes the file when there is none.
                let mut file = match fs::OpenOptions::new()
                    .write(true)
                    .truncate(true)
                    .open(&path)
                {
                    Ok(file) => file,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&path)
                        .unwrap(),
                    Err(error) => panic!("the fake print could not open its file: {error}"),
                };
                io::Write::write_all(&mut file, &pdf).unwrap();
            }
        }
        done(result);
        true
    }

    /// The webview goes away: every running job is dropped without an answer.
    pub fn drop_running_jobs(&self) {
        lock(&self.waiting).clear();
    }

    /// From now on a job waits in the queue, as it does for the webview's own thread, until [`submit_queued`](Self::submit_queued):
    /// a test locks the session in between.
    pub fn hold_submission(&self) {
        self.held.store(true, Ordering::SeqCst);
    }

    /// How many jobs are queued and not yet submitted to WebView2.
    pub fn queued(&self) -> usize {
        lock(&self.queued).len()
    }

    /// The webview's thread gets to the queued jobs: each one whose token is cancelled ends with
    /// [`PrintFailed::Revoked`] and WebView2 is not asked; each other is submitted (it runs until
    /// [`finish`](Self::finish)). How many were submitted.
    pub fn submit_queued(&self) -> usize {
        let mut submitted = 0;
        loop {
            let Some(job) = lock(&self.queued).pop_front() else {
                return submitted;
            };
            if job.cancel.is_cancelled() {
                (job.done)(Err(PrintFailed::Revoked));
                continue;
            }
            if !job.label.is_empty() {
                lock(&self.submitted).push(job.label);
            }
            lock(&self.submitted_jobs).push(job.path.clone());
            lock(&self.waiting).push_back((job.path, job.done));
            submitted += 1;
        }
    }

    /// The names of the printers whose jobs reached WebView2 (past the token's check), in order.
    pub fn submitted(&self) -> Vec<String> {
        lock(&self.submitted).clone()
    }

    /// The paths of the PDF jobs (and an empty path for each job for a printer) that reached WebView2, in order.
    pub fn submitted_jobs(&self) -> Vec<PathBuf> {
        lock(&self.submitted_jobs).clone()
    }

    /// Queues a job for the webview's thread and, unless held, runs that thread's step at once.
    fn queue(&self, path: PathBuf, label: String, cancel: CancelToken, done: PrintDone) {
        lock(&self.queued).push_back(QueuedPrint {
            path,
            label,
            cancel,
            done,
        });
        if !self.held.load(Ordering::SeqCst) {
            self.submit_queued();
        }
    }
}

/// A job queued for the webview's thread, not yet submitted to WebView2.
struct QueuedPrint {
    path: PathBuf,
    /// The printer's name for a job for a printer; empty for a PDF.
    label: String,
    cancel: CancelToken,
    done: PrintDone,
}

impl PrintCalls for FakePrintCalls {
    fn start(&self, path: &Path, cancel: CancelToken, done: PrintDone) -> Result<(), PrintFailed> {
        let hook = lock(&self.on_start).take();
        if let Some(hook) = hook {
            hook();
        }
        lock(&self.started).push(StartedPrint {
            path: path.to_path_buf(),
            existed: fs::symlink_metadata(path).is_ok(),
            hidden: is_hidden(Some(path)),
            folder_hidden: is_hidden(path.parent()),
        });
        if let Some(failed) = lock(&self.refuse_next).take() {
            return Err(failed);
        }
        self.queue(path.to_path_buf(), String::new(), cancel, done);
        Ok(())
    }

    fn start_on_printer(
        &self,
        printer: &str,
        cancel: CancelToken,
        done: PrintDone,
    ) -> Result<(), PrintFailed> {
        lock(&self.printed_to).push(printer.to_owned());
        if let Some(failed) = lock(&self.refuse_next).take() {
            return Err(failed);
        }
        self.queue(PathBuf::new(), printer.to_owned(), cancel, done);
        Ok(())
    }

    fn installed_printers(&self) -> ShellResult<InstalledPrinters> {
        let hook = lock(&self.on_list).take();
        if let Some(hook) = hook {
            hook();
        }
        if std::mem::take(&mut *lock(&self.list_fails)) {
            return Err(PRINTERS_UNREADABLE);
        }
        Ok(lock(&self.installed).clone())
    }
}

/// A shell on fake OS calls, inside its own temp folder: the known folders in `profile`, `local` and `roaming`, and
/// a `vaults` folder for the test's own vaults.
pub struct TestShell {
    pub shell: Arc<Shell>,
    pub env: Arc<FakeEnv>,
    pub volumes: Arc<FakeVolumes>,
    pub dialogs: Arc<FakeDialogs>,
    pub launcher: Arc<FakeLauncher>,
    pub idle: Arc<FakeIdle>,
    pub power: Arc<FakePower>,
    pub clock: Arc<FakeClock>,
    pub clipboard: Arc<FakeClipboard>,
    pub timer: Arc<FakeTimer>,
    pub print: Arc<FakePrintCalls>,
    pub window: Arc<FakeWindow>,
    pub hotkey: Arc<FakeHotkey>,
    pub startup: Arc<FakeStartup>,
    /// The events the shell sent.
    pub events: Arc<Events>,
    /// Tauri's app-data folders, as the app passes them in.
    pub app_dirs: Vec<PathBuf>,
    /// Kept last, so the shell (and every vault it holds) is gone before the folder is removed.
    pub temp: TempDir,
}

impl TestShell {
    pub fn new() -> TestShell {
        TestShell::try_new().unwrap()
    }

    /// Like [`new`](Self::new), with the shell's own refusal to start handed back.
    pub fn try_new() -> io::Result<TestShell> {
        let temp = TempDir::new();
        let env = Arc::new(FakeEnv::new(temp.path()));
        let volumes = Arc::new(FakeVolumes::default());
        let dialogs = Arc::new(FakeDialogs::default());
        let launcher = Arc::new(FakeLauncher::default());
        let idle = Arc::new(FakeIdle::default());
        let power = Arc::new(FakePower::default());
        let clock = Arc::new(FakeClock::default());
        let clipboard = Arc::new(FakeClipboard::default());
        clipboard.watch_clock(clock.clone());
        let timer = Arc::new(FakeTimer::default());
        let print = Arc::new(FakePrintCalls::default());
        let window = Arc::new(FakeWindow::default());
        let hotkey = Arc::new(FakeHotkey::default());
        let startup = Arc::new(FakeStartup::default());
        let events = Arc::new(Events::default());
        let app_dirs = vec![
            env.folder(KnownFolder::RoamingAppData)
                .join("io.github.sumguywhowantstobuild.lockbox"),
            env.folder(KnownFolder::LocalAppData)
                .join("io.github.sumguywhowantstobuild.lockbox"),
        ];
        fs::create_dir_all(temp.path().join("vaults")).unwrap();
        let os = Os {
            volumes: volumes.clone(),
            env: env.clone(),
            dialogs: dialogs.clone(),
            launcher: launcher.clone(),
            idle: idle.clone(),
            power: power.clone(),
            clock: clock.clone(),
            clipboard: Arc::new(ClipboardSteps::new(clipboard.clone(), clock.clone())),
            timer: timer.clone(),
            printer: Arc::new(PrintSteps::new(print.clone())),
            window: window.clone(),
            hotkey: hotkey.clone(),
            startup: startup.clone(),
        };
        let shell = Arc::new(Shell::new(events.clone(), os, app_dirs.clone())?);
        Ok(TestShell {
            shell,
            env,
            volumes,
            dialogs,
            launcher,
            idle,
            power,
            clock,
            clipboard,
            timer,
            print,
            window,
            hotkey,
            startup,
            events,
            app_dirs,
            temp,
        })
    }

    /// A second shell over the same state folder, vaults and fakes: the app after a restart. The first one is locked, as
    /// a closed app's vaults are.
    pub fn restarted(&self) -> Arc<Shell> {
        self.shell.sessions.lock_all(LockReason::AppClosing);
        let os = Os {
            volumes: self.volumes.clone(),
            env: self.env.clone(),
            dialogs: self.dialogs.clone(),
            launcher: self.launcher.clone(),
            idle: self.idle.clone(),
            power: self.power.clone(),
            clock: self.clock.clone(),
            clipboard: Arc::new(ClipboardSteps::new(
                self.clipboard.clone(),
                self.clock.clone(),
            )),
            timer: self.timer.clone(),
            printer: Arc::new(PrintSteps::new(self.print.clone())),
            window: self.window.clone(),
            hotkey: self.hotkey.clone(),
            startup: self.startup.clone(),
        };
        Arc::new(Shell::new(self.events.clone(), os, self.app_dirs.clone()).unwrap())
    }

    /// The folder for the test's own vaults.
    pub fn vaults(&self) -> PathBuf {
        self.temp.path().join("vaults")
    }

    /// A new vault named `name`, created and unlocked through the shell: its session and generation.
    pub fn open_vault(&self, name: &str) -> (SessionId, u64) {
        let password = zeroize::Zeroizing::new(TEST_PASSWORD.to_owned());
        let created = heavy(|| self.shell.create_vault(name.into(), password, false));
        let Ok(crate::error::Outcome::Done(tagged)) = created else {
            panic!("the vault did not open");
        };
        (tagged.session, tagged.generation)
    }

    /// A file item holding a file named `name` with `bytes`, stored in the session's vault: the item's ID and the
    /// file's ID, in hex.
    pub fn stored_file(
        &self,
        session: SessionId,
        generation: u64,
        name: &str,
        bytes: &[u8],
    ) -> (String, String) {
        let source = self.temp.path().join("sources");
        fs::create_dir_all(&source).unwrap();
        let source = source.join(name);
        fs::write(&source, bytes).unwrap();
        let stored = self
            .shell
            .sessions
            .write(session, generation, |vault, cancel| {
                let id = vault.new_file_item(None, &source, cancel)?;
                let file = vault.get_item(&id)?.attachments[0].file_id;
                Ok((id.to_hex(), file.to_hex()))
            });
        fs::remove_file(&source).unwrap();
        stored.unwrap().data
    }

    /// The entries of the output journal; empty when there is no journal file.
    pub fn journal(&self) -> Vec<PathBuf> {
        let Ok(text) = fs::read(&self.shell.paths.outputs) else {
            return Vec::new();
        };
        let journal: serde_json::Value = serde_json::from_slice(&text).unwrap();
        assert_eq!(journal["version"], 1);
        serde_json::from_value(journal["entries"].clone()).unwrap()
    }

    /// A new folder `name` in the test's temp folder, canonical (as a dialog's answer is made before use).
    pub fn folder(&self, name: &str) -> PathBuf {
        let dir = self.temp.path().join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(dir).unwrap()
    }
}

/// The password of every vault [`TestShell::open_vault`] makes.
pub const TEST_PASSWORD: &str = "correct horse battery";
