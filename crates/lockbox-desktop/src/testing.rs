//! Tests only: fakes for the OS calls (`os::{Env, Volumes, Dialogs}`), a shell built on them inside a temp folder,
//! and the lock that keeps key derivations off a timing test's CPU.

use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError, RwLock, RwLockWriteGuard};
use std::{fs, io};

use lockbox_core::internals::fsio::testutil::TempDir;

use crate::lock;
use crate::os::{Dialogs, DriveType, Env, KnownFolder, Os, Volumes};
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

/// A notifier that drops every event.
pub struct NoEvents;

impl Notifier for NoEvents {
    fn locked(&self, _session: SessionId, _generation: u64, _reason: LockReason) {}
    fn busy(&self, _session: Option<SessionId>, _operations: &[&'static str]) {}
    fn notice(&self, _notice: &Notice) {}
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

/// A shell on fake OS calls, inside its own temp folder: the known folders in `profile`, `local` and `roaming`, and
/// a `vaults` folder for the test's own vaults.
pub struct TestShell {
    pub shell: Arc<Shell>,
    pub env: Arc<FakeEnv>,
    pub volumes: Arc<FakeVolumes>,
    pub dialogs: Arc<FakeDialogs>,
    /// Tauri's app-data folders, as the app passes them in.
    pub app_dirs: Vec<PathBuf>,
    /// Kept last, so the shell (and every vault it holds) is gone before the folder is removed.
    pub temp: TempDir,
}

impl TestShell {
    pub fn new() -> TestShell {
        let temp = TempDir::new();
        let env = Arc::new(FakeEnv::new(temp.path()));
        let volumes = Arc::new(FakeVolumes::default());
        let dialogs = Arc::new(FakeDialogs::default());
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
        };
        let shell = Arc::new(Shell::new(Arc::new(NoEvents), os, app_dirs.clone()).unwrap());
        TestShell {
            shell,
            env,
            volumes,
            dialogs,
            app_dirs,
            temp,
        }
    }

    /// The folder for the test's own vaults.
    pub fn vaults(&self) -> PathBuf {
        self.temp.path().join("vaults")
    }
}
