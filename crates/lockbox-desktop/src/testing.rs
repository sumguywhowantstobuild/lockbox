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

use lockbox_core::internals::fsio::testutil::TempDir;

use crate::lock;
use crate::os::{
    ClipboardCalls, ClipboardSteps, Clock, Dialogs, DriveType, EXCLUSION_FORMATS, Env, IdleSource,
    Job, KnownFolder, Launcher, Os, Power, Timer, Volumes,
};
use crate::session::{LockReason, Notice, Notifier, SessionId};
use crate::shell::Shell;

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

    fn notice(&self, _notice: &Notice) {}
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
}

/// The clipboard as the test sees it: its text, the formats added beside it, its sequence number (moved on by every
/// change, as Windows does), and whether it is open.
#[derive(Default)]
struct Clip {
    open: bool,
    /// Changed in the current opening: closing it adds the text formats Windows derives from the text.
    changed: bool,
    /// The sequence number cannot be read.
    no_sequence: bool,
    /// Another program has it open: every try at opening fails.
    held_elsewhere: bool,
    seq: u32,
    text: Option<String>,
    /// The names of the formats added beside the text, in order.
    formats: Vec<&'static str>,
    /// The format added when this many are already there fails.
    fail_format_at: Option<usize>,
    refuse_registration: bool,
}

/// A clipboard in memory, driven through [`ClipboardSteps`](crate::os::ClipboardSteps) like the real one. Counts the
/// tries at opening it.
#[derive(Default)]
pub struct FakeClipboard {
    clip: Arc<Mutex<Clip>>,
    opens: AtomicUsize,
}

/// The fake clipboard, open: closed when dropped.
pub struct FakeOpened(Arc<Mutex<Clip>>);

/// How many formats Windows adds when a clipboard holding text is closed after a change: `CF_TEXT`, `CF_OEMTEXT` and
/// `CF_LOCALE`, each moving the sequence number on (seen on Windows 11 in the hands-on probe).
const DERIVED_FORMATS: u32 = 3;

impl Drop for FakeOpened {
    fn drop(&mut self) {
        let mut clip = lock(&self.0);
        if std::mem::take(&mut clip.changed) && clip.text.is_some() {
            clip.seq += DERIVED_FORMATS;
        }
        clip.open = false;
    }
}

impl FakeClipboard {
    /// The user (another program) copies `text`.
    pub fn user_copy(&self, text: &str) {
        let mut clip = lock(&self.clip);
        clip.seq += 1;
        clip.text = Some(text.to_owned());
        clip.formats.clear();
    }

    /// From now on, while `held`, another program keeps the clipboard open.
    pub fn hold_open_elsewhere(&self, held: bool) {
        lock(&self.clip).held_elsewhere = held;
    }

    /// From now on, adding a format fails once `n` are already on the clipboard.
    pub fn fail_format_at(&self, n: usize) {
        lock(&self.clip).fail_format_at = Some(n);
    }

    /// From now on, the sequence number cannot be read.
    pub fn hide_sequence(&self) {
        lock(&self.clip).no_sequence = true;
    }

    /// From now on, Windows refuses to register clipboard formats.
    pub fn refuse_registration(&self) {
        lock(&self.clip).refuse_registration = true;
    }

    pub fn text(&self) -> Option<String> {
        lock(&self.clip).text.clone()
    }

    pub fn formats(&self) -> Vec<&'static str> {
        lock(&self.clip).formats.clone()
    }

    pub fn seq(&self) -> NonZeroU32 {
        NonZeroU32::new(lock(&self.clip).seq).expect("the clipboard has changed at least once")
    }

    pub fn is_open(&self) -> bool {
        lock(&self.clip).open
    }

    /// How many times opening it was tried.
    pub fn opens(&self) -> usize {
        self.opens.load(Ordering::SeqCst)
    }
}

impl ClipboardCalls for FakeClipboard {
    type Opened = FakeOpened;

    fn register_format(&self, name: &str) -> Option<NonZeroU32> {
        if lock(&self.clip).refuse_registration {
            return None;
        }
        let at = EXCLUSION_FORMATS.iter().position(|known| *known == name)?;
        NonZeroU32::new(0xC000 + u32::try_from(at).ok()?)
    }

    fn open(&self) -> Option<FakeOpened> {
        self.opens.fetch_add(1, Ordering::SeqCst);
        let mut clip = lock(&self.clip);
        if clip.open || clip.held_elsewhere {
            return None;
        }
        clip.open = true;
        Some(FakeOpened(Arc::clone(&self.clip)))
    }

    fn empty(&self) -> bool {
        let mut clip = lock(&self.clip);
        assert!(clip.open, "emptied while closed");
        clip.changed = true;
        clip.seq += 1;
        clip.text = None;
        clip.formats.clear();
        true
    }

    fn set_text(&self, text: &str) -> bool {
        let mut clip = lock(&self.clip);
        assert!(clip.open, "written while closed");
        clip.changed = true;
        clip.seq += 2;
        clip.text = Some(text.to_owned());
        clip.formats.clear();
        true
    }

    fn set_dword_zero(&self, format: NonZeroU32) -> bool {
        let mut clip = lock(&self.clip);
        assert!(clip.open, "written while closed");
        if clip.fail_format_at == Some(clip.formats.len()) {
            return false;
        }
        let name = EXCLUSION_FORMATS[(format.get() - 0xC000) as usize];
        clip.changed = true;
        clip.seq += 1;
        clip.formats.push(name);
        true
    }

    fn seq_num(&self) -> Option<NonZeroU32> {
        let clip = lock(&self.clip);
        NonZeroU32::new(clip.seq).filter(|_| !clip.no_sequence)
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

impl Timer for FakeTimer {
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
}

impl FakeDialogs {
    pub fn answer(&self, answer: Option<PathBuf>) {
        lock(&self.answers).push_back(answer);
    }

    pub fn opened(&self) -> usize {
        self.opened.load(Ordering::SeqCst)
    }

    fn next(&self) -> Option<PathBuf> {
        self.opened.fetch_add(1, Ordering::SeqCst);
        lock(&self.answers).pop_front().flatten()
    }
}

impl Dialogs for FakeDialogs {
    fn pick_folder(&self, _title: &str) -> Option<PathBuf> {
        self.next()
    }

    fn pick_file(&self, _title: &str, _filter: Option<(&str, &[&str])>) -> Option<PathBuf> {
        self.next()
    }

    fn save_file(
        &self,
        _title: &str,
        _suggested: &str,
        _filter: Option<(&str, &[&str])>,
    ) -> Option<PathBuf> {
        self.next()
    }
}

/// A launcher that records each link it is given (its parsed form) instead of opening it.
#[derive(Default)]
pub struct FakeLauncher {
    opened: Mutex<Vec<String>>,
    /// Run once, inside the next launch, before it returns.
    on_open: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl FakeLauncher {
    pub fn opened(&self) -> Vec<String> {
        lock(&self.opened).clone()
    }

    /// Runs `hook` once, inside the next launch: while the link is being opened.
    pub fn during_next_open(&self, hook: Box<dyn FnOnce() + Send>) {
        *lock(&self.on_open) = Some(hook);
    }
}

impl Launcher for FakeLauncher {
    fn open_url(&self, url: &tauri::Url) -> io::Result<()> {
        lock(&self.opened).push(url.as_str().to_owned());
        let hook = lock(&self.on_open).take();
        if let Some(hook) = hook {
            hook();
        }
        Ok(())
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
        let timer = Arc::new(FakeTimer::default());
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
            clipboard: Arc::new(ClipboardSteps(clipboard.clone())),
            timer: timer.clone(),
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
            events,
            app_dirs,
            temp,
        })
    }

    /// The folder for the test's own vaults.
    pub fn vaults(&self) -> PathBuf {
        self.temp.path().join("vaults")
    }
}
