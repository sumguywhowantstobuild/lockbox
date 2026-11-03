//! "Open" (spec §7.2): a stored file decrypted into a new folder only the current user can reach, verified whole,
//! marked read-only and with Windows' internet mark, then launched with its default app. The copies go when their
//! vault locks or the app closes; one another program still holds stays listed, and goes on a retry or at a launch.
//!
//! Each folder is written down in the output journal before it exists, so a crash leaves nothing the launch sweep does
//! not find; the launch also looks in `open\` itself, for copies a damaged journal no longer lists. The list of folders
//! is held only for changes to it, never across a file or journal call. Lock order: the list, then the sessions' own
//! mutex (a cleanup reads which sessions are unlocked while it picks from the list).

#[cfg(test)]
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, PoisonError, Weak};
use std::thread;
use std::time::Instant;

use lockbox_core::ids::VaultId;
use lockbox_core::is_reserved_device_name;
use serde::Serialize;

use crate::error::{ShellError, ShellResult};
use crate::lock;
use crate::os::{same_name, win};
use crate::outputs::{DELETE_TRIES, Outputs, set_read_only};
use crate::session::{LockHook, Notice, Notifier, SessionId, Sessions};

/// Longest name of an opened copy, in characters (spec §7.2: length capped).
const MAX_NAME_CHARS: usize = 100;

/// What Lockbox calls a stored file that has no usable name.
const NO_NAME: &str = "file";

/// The file types that ask first, whatever Windows says about them (spec §7.2), judged on the last extension. Windows'
/// own opinion comes on top ([`win::is_dangerous_type`]).
const EXECUTABLE_TYPES: &[&str] = &[
    "exe",
    "com",
    "bat",
    "cmd",
    "ps1",
    "psm1",
    "psd1",
    "ps1xml",
    "psc1",
    "vbs",
    "vbe",
    "js",
    "jse",
    "wsf",
    "wsh",
    "wsc",
    "sct",
    "hta",
    "lnk",
    "url",
    "website",
    "msi",
    "msp",
    "mst",
    "scr",
    "pif",
    "cpl",
    "jar",
    "jnlp",
    "reg",
    "appref-ms",
    "application",
    "xbap",
    "msc",
    "scf",
    "inf",
    "chm",
    "gadget",
    "settingcontent-ms",
    "library-ms",
    "search-ms",
    "appx",
    "msix",
    "appinstaller",
    "diagcab",
    "iso",
    "img",
    "vhd",
    "vhdx",
    "xll",
    "theme",
    "themepack",
];

/// The stream that carries Windows' internet mark, and what it says: zone 3, the internet.
const MARK_STREAM: &str = ":Zone.Identifier";
const INTERNET_MARK: &[u8] = b"[ZoneTransfer]\r\nZoneId=3\r\n";

/// The name an opened copy gets, built from the stored name (spec §7.2): letters, digits, space, `-`, `_`, `.`, `(` and
/// `)` kept, anything else (a path separator, a right-to-left mark) `_`; no dots or spaces at the end, which Windows
/// would drop; a `_` before a reserved device name; at most [`MAX_NAME_CHARS`] characters, keeping the extension;
/// `file` when nothing is left.
pub fn safe_name(original: &str) -> String {
    let kept = |c: char| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.' | '(' | ')');
    let name: String = original
        .chars()
        .map(|c| if kept(c) { c } else { '_' })
        .collect();
    let name = fit(&name);
    if name.is_empty() {
        return NO_NAME.to_owned();
    }
    // After the cut, which can leave a device name (`CONSOLE.<long>` to `CON.<long>`); a name starting `_` is none.
    match is_reserved_device_name(&name) {
        true => fit(&format!("_{name}")),
        false => name,
    }
}

/// `name` at [`MAX_NAME_CHARS`] characters at most, cut before its extension (an extension too long to keep is cut with
/// the rest), with no dots or spaces at the end.
fn fit(name: &str) -> String {
    let trimmed = |name: &str| name.trim_end_matches(['.', ' ']).to_owned();
    let name = trimmed(name);
    if name.chars().count() <= MAX_NAME_CHARS {
        return name;
    }
    let extension = name.rfind('.').map_or("", |dot| &name[dot..]);
    let (extension, kept) = match extension.chars().count() {
        kept if kept < MAX_NAME_CHARS => (extension, kept),
        _ => ("", 0),
    };
    let stem: String = name.chars().take(MAX_NAME_CHARS - kept).collect();
    trimmed(&(stem + extension))
}

/// Whether the opened copy named `safe` (always [`safe_name`]'s result) asks first: its last extension, in any case as
/// Windows compares names, is one of [`EXECUTABLE_TYPES`], or Windows rates the type as dangerous.
pub fn is_executable(safe: &str) -> bool {
    let Some((_, extension)) = safe.rsplit_once('.') else {
        return false;
    };
    EXECUTABLE_TYPES
        .iter()
        .any(|listed| same_name(OsStr::new(extension), OsStr::new(listed)))
        || win::is_dangerous_type(&format!(".{extension}"))
}

/// What a cleanup did: folders removed, and folders still listed because another program holds a copy (all of them,
/// not only those this cleanup tried).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct RemoveReport {
    pub removed: usize,
    pub still_open: usize,
}

/// One "Open" folder.
struct Folder {
    path: PathBuf,
    /// The session the copy came from and its generation then, which is how long the copy may live; `None`: left by an
    /// earlier run of the app.
    owner: Option<(SessionId, u64)>,
    /// A cleanup could not remove it yet: [`retry`](OpenFolders::retry) tries it again.
    stuck: bool,
}

/// Picks the folders whose lifetime is over, by the sessions as they are now: every folder made in a generation that is
/// no longer unlocked. A session keeps its ID when it unlocks again, so the generation is what tells a new copy from an
/// old one. A folder from an earlier run has no owner left, so each lock and the app's close try it too (spec §7.2). With
/// the sessions gone nothing is alive, so every folder is picked.
fn ended(sessions: &Weak<Sessions>) -> impl Fn(&Folder) -> bool + use<> {
    let unlocked: Option<Vec<(SessionId, u64)>> = sessions.upgrade().map(|sessions| {
        let unlocked = sessions.unlocked().into_iter();
        unlocked
            .map(|(id, generation, _)| (id, generation))
            .collect()
    });
    move |folder| match (&unlocked, &folder.owner) {
        (Some(unlocked), Some(owner)) => !unlocked.contains(owner),
        _ => true,
    }
}

/// Tests only: a step a test acts at, with the path it is about to use.
#[cfg(test)]
type StepHook = Box<dyn FnOnce(&Path) + Send>;

/// The "Open" folders, in the state folder's `open\`.
pub struct OpenFolders {
    root: PathBuf,
    outputs: Arc<Outputs>,
    notifier: Arc<dyn Notifier>,
    /// Every folder made and not yet known to be gone. A cleanup takes out what it removes, so no two work on one, and
    /// puts back what it could not.
    folders: Mutex<Vec<Folder>>,
    /// How many cleanups are under way, whatever started them, and their end ([`wait_idle`](Self::wait_idle)).
    cleanups: Mutex<usize>,
    idle: Condvar,
    #[cfg(test)]
    steps: Mutex<HashMap<&'static str, StepHook>>,
}

/// One cleanup under way, from before its folders leave the list until dropped, also after a panic.
struct Cleaning<'a>(&'a OpenFolders);

impl Drop for Cleaning<'_> {
    fn drop(&mut self) {
        self.0.cleanup_ended();
    }
}

/// A lock's cleanup worker, counted from before its thread runs until dropped: after its work, also after a panic, or
/// unrun when its thread could not start.
struct WorkerDone(Arc<OpenFolders>);

impl Drop for WorkerDone {
    fn drop(&mut self) {
        self.0.cleanup_ended();
    }
}

impl OpenFolders {
    /// `root`: the state folder's `open\`, as Lockbox computes it.
    pub fn new(root: PathBuf, outputs: Arc<Outputs>, notifier: Arc<dyn Notifier>) -> OpenFolders {
        OpenFolders {
            root,
            outputs,
            notifier,
            folders: Mutex::default(),
            cleanups: Mutex::default(),
            idle: Condvar::new(),
            #[cfg(test)]
            steps: Mutex::default(),
        }
    }

    /// Tests only: runs `hook` once at `step`: `recorded` (the journal lists the folder; it does not exist yet),
    /// `before_mark` (the copy has verified), `sealed` (the copy is marked and read-only), `cleanup_starts` (a lock's
    /// cleanup worker has started and selected nothing yet; no path).
    #[cfg(test)]
    pub(crate) fn at_step(&self, step: &'static str, hook: StepHook) {
        lock(&self.steps).insert(step, hook);
    }

    /// Tests only: runs the hook of `step`, if there is one.
    #[cfg(test)]
    fn step(&self, step: &'static str, path: &Path) {
        let hook = lock(&self.steps).remove(step);
        if let Some(hook) = hook {
            hook(path);
        }
    }

    /// Makes a new folder `open\<32 lowercase hex>` for a copy from `session` in `generation`, for the current user
    /// alone ([`win::create_private_folder`]), and lists it. The journal comes first: if it cannot be written, nothing
    /// is made (spec §7.2). The lock that ends that generation removes the folder; so does [`discard`](Self::discard).
    ///
    /// Refused (`InvalidInput { what: "open folder" }`) when a link leads to `open\` (a Local AppData moved to another
    /// drive by a junction, a share): every cleanup would then leave the copy on disk for good (the sweep's rule, which
    /// removes nothing behind a link), so no plaintext goes there. The same where the folder's permissions would not last
    /// (not NTFS). Save a copy still works.
    pub fn create(&self, session: SessionId, generation: u64) -> ShellResult<PathBuf> {
        fs::create_dir_all(&self.root)?;
        if !self.outputs.open_folder_is_plain() || !self.outputs.open_folder_keeps_permissions() {
            return Err(ShellError::InvalidInput {
                what: "open folder",
            });
        }
        let folder = self.root.join(VaultId::random().to_hex());
        self.outputs.record_open(&folder)?;
        #[cfg(test)]
        self.step("recorded", &folder);
        if let Err(error) = win::create_private_folder(&folder) {
            self.outputs.clear(&folder);
            return Err(error.into());
        }
        lock(&self.folders).push(Folder {
            path: folder.clone(),
            owner: Some((session, generation)),
            stuck: false,
        });
        Ok(folder)
    }

    /// Finishes the copy `file`, which has verified whole: Windows' internet mark (spec §7.2), then read-only. A mark
    /// that cannot be written is refused, and the file must not be opened.
    pub fn seal(&self, file: &Path) -> ShellResult<()> {
        #[cfg(test)]
        self.step("before_mark", file);
        let mut mark = file.as_os_str().to_owned();
        mark.push(MARK_STREAM);
        fs::write(mark, INTERNET_MARK)?;
        set_read_only(file, true)?;
        #[cfg(test)]
        self.step("sealed", file);
        Ok(())
    }

    /// Tests only: removes every folder, as any cleanup does.
    #[cfg(test)]
    pub(crate) fn remove_all(&self) -> RemoveReport {
        self.remove(|_| true)
    }

    /// Tries again the folders a cleanup could not remove (spec §7.2's Retry). A copy still in use with its vault
    /// unlocked is left alone: nothing has asked to remove it.
    pub fn retry(&self) -> RemoveReport {
        self.remove(|folder| folder.stuck)
    }

    /// Removes the folder of an open that stopped, unless a lock's cleanup has it already. A copy something holds stays
    /// listed, and the page is told.
    pub fn discard(&self, folder: &Path) {
        self.tell(self.remove(|listed| listed.path == folder));
    }

    /// Tells the page when opened copies are left for its Retry.
    fn tell(&self, report: RemoveReport) {
        if report.still_open > 0 {
            self.notifier.notice(&Notice::OpenCleanup(report));
        }
    }

    /// Launch work, after the journal's own sweep (spec §7.2): the folders the sweep kept go on the retry list as they
    /// are, already tried. Every other folder [`Outputs::open_folders_on_disk`] finds in `open\` is a leftover no entry
    /// lists (a damaged journal, unreadable or set aside): removed like a journal entry, by the same check before each
    /// delete, and put on the list if another app holds it. The journal itself is not needed, so a damaged one does
    /// not stop this; no entry is written, since the next launch finds a kept folder the same way.
    pub fn sweep_leftovers(&self) -> RemoveReport {
        let _cleaning = self.cleaning();
        let kept = self.outputs.open_entries();
        let on_disk = self.outputs.open_folders_on_disk();
        let leftovers: Vec<Folder> = {
            let mut folders = lock(&self.folders);
            let known = |folders: &[Folder], path: &Path| {
                folders
                    .iter()
                    .any(|folder| folder.path.file_name() == path.file_name())
            };
            for path in kept {
                if !known(&folders, &path) {
                    folders.push(Folder {
                        path,
                        owner: None,
                        stuck: true,
                    });
                }
            }
            on_disk
                .into_iter()
                .filter(|path| !known(&folders, path))
                .map(|path| Folder {
                    path,
                    owner: None,
                    stuck: false,
                })
                .collect()
        };
        self.remove_each(leftovers)
    }

    /// Starts counting a cleanup, for [`wait_idle`](Self::wait_idle).
    fn cleaning(&self) -> Cleaning<'_> {
        *lock(&self.cleanups) += 1;
        Cleaning(self)
    }

    fn cleanup_ended(&self) {
        *lock(&self.cleanups) -= 1;
        self.idle.notify_all();
    }

    /// Takes the folders `which` picks out of the list and removes each.
    fn remove(&self, which: impl Fn(&Folder) -> bool) -> RemoveReport {
        self.remove_picked(|| which)
    }

    /// [`remove`](Self::remove), with what picks the folders made while the list is held: nothing joins the list
    /// between what it reads and the choice. Counted as a cleanup from before the folders leave the list, so a close
    /// that finds them gone from it still waits for them.
    fn remove_picked<P: Fn(&Folder) -> bool>(&self, pick: impl FnOnce() -> P) -> RemoveReport {
        let _cleaning = self.cleaning();
        let taken: Vec<Folder> = {
            let mut folders = lock(&self.folders);
            let which = pick();
            let (taken, kept) = std::mem::take(&mut *folders).into_iter().partition(&which);
            *folders = kept;
            taken
        };
        self.remove_each(taken)
    }

    /// Removes each of `taken`, which are off the list: what is left goes back, stuck. One try for each comes first, so
    /// that a folder another program holds does not use up the app close's time before the others get theirs.
    fn remove_each(&self, taken: Vec<Folder>) -> RemoveReport {
        let (gone, held): (Vec<Folder>, Vec<Folder>) = taken
            .into_iter()
            .partition(|folder| self.outputs.remove_open(&folder.path, 1));
        let mut removed = gone.len();
        for mut folder in held {
            if self.outputs.remove_open(&folder.path, DELETE_TRIES) {
                removed += 1;
            } else {
                folder.stuck = true;
                lock(&self.folders).push(folder);
            }
        }
        let folders = lock(&self.folders);
        RemoveReport {
            removed,
            still_open: folders.iter().filter(|folder| folder.stuck).count(),
        }
    }

    /// Waits for the cleanups under way, whatever started them, until `until`: whether none is left. A join could not
    /// stop at a time, so each counts itself out instead.
    pub fn wait_idle(&self, until: Instant) -> bool {
        let cleanups = lock(&self.cleanups);
        let left = until.saturating_duration_since(Instant::now());
        let (cleanups, _) = self
            .idle
            .wait_timeout_while(cleanups, left, |cleanups| *cleanups > 0)
            .unwrap_or_else(PoisonError::into_inner);
        *cleanups == 0
    }

    /// The lock hook, after the clipboard's: a lock removes the folders whose lifetime is over ([`ended`]), which a lock
    /// of all, app close included, makes of every folder of this run. It only starts a worker and returns, since deletes
    /// retry for seconds and hooks run one after the other on one thread. A worker that cannot start leaves its folders
    /// listed, for the next cleanup. `sessions` is weak because the sessions hold this hook: a strong one would keep them
    /// and their vaults alive for good.
    pub fn lock_hook(self: &Arc<Self>, sessions: Weak<Sessions>) -> LockHook {
        let folders = Arc::clone(self);
        Box::new(move |_, _| folders.start_cleanup(&sessions))
    }

    fn start_cleanup(self: &Arc<Self>, sessions: &Weak<Sessions>) {
        {
            let folders = lock(&self.folders);
            if folders.is_empty() || !folders.iter().any(ended(sessions)) {
                return;
            }
        }
        *lock(&self.cleanups) += 1;
        let done = WorkerDone(Arc::clone(self));
        let (folders, sessions) = (Arc::clone(self), Weak::clone(sessions));
        let _ = thread::Builder::new()
            .name("lockbox-open-cleanup".into())
            .spawn(move || {
                let _done = done;
                #[cfg(test)]
                folders.step("cleanup_starts", Path::new(""));
                folders.tell(folders.remove_picked(|| ended(&sessions)));
            });
    }
}

#[cfg(test)]
mod tests {
    use std::fs::OpenOptions;
    use std::io;
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::sync::mpsc;
    use std::time::Duration;

    use lockbox_core::internals::fsio::failpoint;
    use lockbox_core::internals::fsio::testutil::{make_dir_link, names};
    use serde_json::json;

    use super::*;
    use crate::autolock::SHUTDOWN_WAIT;
    use crate::error::Outcome;
    use crate::session::{LockReason, Tagged};
    use crate::testing::{FakeVolume, LOCAL_NTFS, TEST_PASSWORD, TestShell, heavy};

    /// How long a test thread waits for another before it fails instead of hanging.
    const GIVE_UP: Duration = Duration::from_secs(60);
    const LOCKED: Option<ShellError> = Some(ShellError::Locked);
    const PDF: &[u8] = b"%PDF test contents";
    /// `FILE_ATTRIBUTE_HIDDEN`.
    const HIDDEN: u32 = 2;
    /// `OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE`, and `INHERITED_ACE`.
    const INHERIT: u32 = 3;
    const INHERITED: u32 = 0x10;
    /// `FILE_ALL_ACCESS`.
    const FULL_ACCESS: u32 = 0x1F_01FF;

    /// Always disarms, so a failing test cannot leak a failpoint into the next one on this thread.
    struct Cleanup;
    impl Drop for Cleanup {
        fn drop(&mut self) {
            failpoint::disarm_all();
        }
    }

    /// A vault holding one stored file: its session, generation and the IDs.
    fn stored(ts: &TestShell, vault: &str, name: &str) -> (SessionId, u64, String, String) {
        let (s, g) = ts.open_vault(vault);
        let (id, file_id) = ts.stored_file(s, g, name, PDF);
        (s, g, id, file_id)
    }

    /// Opens the file, confirmed.
    fn open(
        ts: &TestShell,
        (s, g, id, file_id): &(SessionId, u64, String, String),
    ) -> ShellResult<Tagged<Outcome<()>>> {
        ts.shell.open_file(*s, *g, id, file_id, true)
    }

    /// The copy just opened.
    fn opened_copy(ts: &TestShell) -> PathBuf {
        ts.launcher
            .opened_files()
            .last()
            .cloned()
            .expect("something was launched")
    }

    /// The "Open" folders on disk.
    fn folders_on_disk(ts: &TestShell) -> Vec<String> {
        let open = &ts.shell.paths.open;
        if open.exists() {
            names(open)
        } else {
            Vec::new()
        }
    }

    /// Waits for the cleanups, which a test expects to end.
    fn cleaned(ts: &TestShell) {
        assert!(
            ts.shell.open_folders.wait_idle(Instant::now() + GIVE_UP),
            "the cleanup did not end"
        );
    }

    /// Holds `file` open with no sharing, as a viewer that keeps its document locked does.
    fn hold(file: &Path) -> fs::File {
        OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(file)
            .unwrap()
    }

    fn mark_of(file: &Path) -> io::Result<Vec<u8>> {
        let mut stream = file.as_os_str().to_owned();
        stream.push(MARK_STREAM);
        fs::read(stream)
    }

    #[test]
    fn safe_name_table() {
        let long = "a".repeat(300);
        let table: Vec<(String, String)> = vec![
            ("report.pdf".into(), "report.pdf".into()),
            (r"a/b\c:d*e?.txt".into(), "a_b_c_d_e_.txt".into()),
            ("CON.txt".into(), "_CON.txt".into()),
            ("con".into(), "_con".into()),
            ("nul.tar.gz".into(), "_nul.tar.gz".into()),
            ("NUL .txt".into(), "_NUL .txt".into()),
            ("COM¹.txt".into(), "_COM¹.txt".into()),
            ("CONSOLE.txt".into(), "CONSOLE.txt".into()),
            ("x. . ".into(), "x".into()),
            ("".into(), "file".into()),
            ("...".into(), "file".into()),
            ("   ".into(), "file".into()),
            (
                "Résumé 文件 (1)-final_v2.pdf".into(),
                "Résumé 文件 (1)-final_v2.pdf".into(),
            ),
            ("a<b>c\"d|e".into(), "a_b_c_d_e".into()),
            ("tab\tnew\nnul\0.txt".into(), "tab_new_nul_.txt".into()),
            ("a.pdf:evil.exe".into(), "a.pdf_evil.exe".into()),
            ("x.exe::$DATA".into(), "x.exe___DATA".into()),
            (".exe".into(), ".exe".into()),
        ];
        for (original, safe) in &table {
            assert_eq!(&safe_name(original), safe, "{original:?}");
        }
        // At most 100 characters, the extension kept.
        let cut = safe_name(&format!("{long}.pdf"));
        assert_eq!(cut.chars().count(), 100);
        assert!(cut.ends_with(".pdf"), "{cut}");
        assert_eq!(cut, format!("{}.pdf", "a".repeat(96)));
        // Counted in characters, not bytes.
        let cut = safe_name(&format!("{}.pdf", "é".repeat(300)));
        assert_eq!(cut, format!("{}.pdf", "é".repeat(96)));
        // An extension too long to keep is cut with the rest.
        let cut = safe_name(&format!("x.{long}"));
        assert_eq!(cut.chars().count(), 100);
        assert!(cut.starts_with("x.aaa"));
        // A cut that leaves spaces or dots at the end: they go too.
        let cut = safe_name(&format!("{}   {long}", "b".repeat(98)));
        assert_eq!(cut, "b".repeat(98));
        // A device name at the limit, the prefix counted, and one only the cut makes.
        let device = safe_name(&format!("CON.{long}"));
        assert_eq!(device.chars().count(), 100);
        assert!(device.starts_with("_CO"), "{device}");
        let extension = "e".repeat(96);
        let made_by_the_cut = safe_name(&format!("CONSOLE.{extension}"));
        assert_eq!(made_by_the_cut.chars().count(), 100);
        assert!(made_by_the_cut.starts_with("_CO"), "{made_by_the_cut}");
        assert!(!is_reserved_device_name(&made_by_the_cut));
    }

    /// Review Focus 5: a right-to-left mark cannot disguise an executable.
    #[test]
    fn rtl_override_name_sanitised_and_flagged() {
        let safe = safe_name("invoice\u{202E}fdp.exe");
        assert_eq!(safe, "invoice_fdp.exe");
        assert!(is_executable(&safe));
    }

    /// Review Focus 5: dots and spaces Windows would drop cannot hide the extension.
    #[test]
    fn trailing_dot_executable_flagged() {
        for name in ["setup.exe.", "setup.exe ", "setup.exe. . ", "a.pdf.lnk"] {
            assert!(is_executable(&safe_name(name)), "{name:?}");
        }
    }

    #[test]
    fn executable_types_table() {
        // Spec §7.2's list, written out: the loop below reads the constant, so it would not miss one taken off it.
        for extension in [
            "exe", "bat", "cmd", "ps1", "vbs", "js", "hta", "lnk", "url", "msi", "scr",
        ] {
            assert!(EXECUTABLE_TYPES.contains(&extension), "{extension}");
        }
        for extension in EXECUTABLE_TYPES {
            let upper = extension.to_uppercase();
            for name in [
                format!("a.{extension}"),
                format!("A.B.{upper}"),
                format!(".{extension}"),
            ] {
                assert!(is_executable(&safe_name(&name)), "{name}");
            }
        }
        for name in [
            "report.pdf",
            "notes.txt",
            "a.exe.pdf",
            "noextension",
            "exe",
            "a.exe_",
        ] {
            assert!(!is_executable(&safe_name(name)), "{name}");
        }
        // Cut to the limit, the name is judged as it ends up.
        let cut = safe_name(&format!("{}.exe{}", "a".repeat(96), "z".repeat(200)));
        assert!(cut.ends_with(".exe") && is_executable(&cut), "{cut}");
    }

    /// Windows' own opinion counts, for a type that is not on Lockbox's list.
    #[test]
    fn windows_opinion_counts() {
        assert!(win::is_dangerous_type(".exe"));
        assert!(!win::is_dangerous_type(".txt"));
        assert!(!EXECUTABLE_TYPES.contains(&"vb"));
        assert!(win::is_dangerous_type(".vb"));
        assert!(is_executable("macro.vb"));
    }

    /// An executable and not confirmed: asked before anything is decrypted, written or journalled. Confirmed, it goes.
    #[test]
    fn executable_needs_confirmation_first() {
        let ts = TestShell::new();
        let (s, g, id, file_id) = stored(&ts, "Family", "setup.cmd");
        let asked = ts.shell.open_file(s, g, &id, &file_id, false).unwrap();
        assert_eq!(
            serde_json::to_value(&asked).unwrap(),
            json!({ "session": s, "generation": g, "data": { "Confirm": "Executable" } })
        );
        assert!(ts.launcher.opened_files().is_empty());
        assert_eq!(folders_on_disk(&ts), Vec::<String>::new());
        assert!(!ts.shell.paths.outputs.exists(), "no journal change");
        let busy = ts.events.busy();
        assert!(
            !busy.iter().any(|(_, ops)| ops.contains(&"open")),
            "{busy:?}"
        );

        let opened = ts.shell.open_file(s, g, &id, &file_id, true).unwrap();
        assert!(matches!(opened.data, Outcome::Done(())));
        assert_eq!(opened_copy(&ts).file_name(), Some(OsStr::new("setup.cmd")));
    }

    /// The copy is in a new folder, whole, read-only and not hidden when it launches, the journal lists its folder as
    /// Lockbox spells it, and no lock is held during the launch: the vault can be written, and a publish can pass.
    #[test]
    fn opened_copy_is_read_only_and_launched_after_unlock() {
        let ts = TestShell::new();
        let file = stored(&ts, "Family", "report.pdf");
        let (s, g, ..) = file;
        let shell = Arc::clone(&ts.shell);
        let (seen, was_seen) = mpsc::channel();
        ts.launcher.during_next_open(Box::new(move || {
            let write = shell.sessions.write(s, g, |_, _| Ok(()));
            let publish = shell.sessions.publish(s, g, || Ok(()));
            seen.send(write.is_ok() && publish.is_ok()).unwrap();
        }));
        let opened = open(&ts, &file).unwrap();
        assert!(matches!(opened.data, Outcome::Done(())));
        assert_eq!((opened.session, opened.generation), (s, g));
        assert!(
            was_seen.recv().unwrap(),
            "a lock was held during the launch"
        );

        let copy = opened_copy(&ts);
        assert_eq!(copy.file_name(), Some(OsStr::new("report.pdf")));
        assert_eq!(fs::read(&copy).unwrap(), PDF);
        let meta = fs::metadata(&copy).unwrap();
        assert!(meta.permissions().readonly());
        assert_eq!(meta.file_attributes() & HIDDEN, 0, "not hidden");
        let folder = copy.parent().unwrap();
        assert_eq!(folder.parent(), Some(ts.shell.paths.open.as_path()));
        assert_eq!(names(folder), ["report.pdf"], "no temp left");
        assert_eq!(
            ts.journal(),
            [folder.to_path_buf()],
            "the folder, as Lockbox spells it"
        );
        let busy = ts.events.busy();
        assert!(busy.contains(&(Some(s), vec!["open"])), "{busy:?}");
    }

    /// Spec §7.2: the copy says it came from the internet, in the stream Windows reads.
    #[cfg(windows)]
    #[test]
    fn opened_copy_carries_the_internet_mark() {
        let ts = TestShell::new();
        let file = stored(&ts, "Family", "report.pdf");
        open(&ts, &file).unwrap();
        assert_eq!(
            mark_of(&opened_copy(&ts)).unwrap(),
            b"[ZoneTransfer]\r\nZoneId=3\r\n"
        );
    }

    /// A mark that cannot be written (Windows refuses: the file is read-only by then) stops the open: refused, the
    /// folder removed, nothing launched.
    #[cfg(windows)]
    #[test]
    fn mark_that_cannot_be_written_stops_the_open() {
        let ts = TestShell::new();
        let file = stored(&ts, "Family", "report.pdf");
        let (made, was_made) = mpsc::channel();
        ts.shell.open_folders.at_step(
            "before_mark",
            Box::new(move |copy| {
                let mut read_only = fs::metadata(copy).unwrap().permissions();
                read_only.set_readonly(true);
                fs::set_permissions(copy, read_only).unwrap();
                made.send(()).unwrap();
            }),
        );
        let answer = open(&ts, &file);
        assert!(
            was_made.try_recv().is_ok(),
            "the export got as far as the mark"
        );
        assert!(
            matches!(answer, Err(ShellError::Core(view)) if view.kind == "io"),
            "refused as an I/O error"
        );
        assert!(ts.launcher.opened_files().is_empty());
        cleaned(&ts);
        assert_eq!(folders_on_disk(&ts), Vec::<String>::new());
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    /// A lock after the export, before the last check: not launched, the folder removed.
    #[test]
    fn lock_between_decrypt_and_launch_stops_launch() {
        let ts = TestShell::new();
        let file = stored(&ts, "Family", "report.pdf");
        let shell = Arc::clone(&ts.shell);
        ts.shell.open_folders.at_step(
            "sealed",
            Box::new(move |_| shell.sessions.lock_all(LockReason::Manual)),
        );
        assert_eq!(open(&ts, &file).err(), LOCKED);
        assert!(ts.launcher.opened_files().is_empty());
        cleaned(&ts);
        assert_eq!(folders_on_disk(&ts), Vec::<String>::new());
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    /// The launch waits (for a "How do you want to open this file?" dialog): the lock returns while it is still parked,
    /// its cleanup removes the copy, and the open answers `Locked`.
    #[test]
    fn locking_is_not_delayed_by_a_blocked_launch() {
        let ts = TestShell::new();
        let file = stored(&ts, "Family", "report.pdf");
        let (in_launch, launching) = mpsc::channel();
        let (let_go, released) = mpsc::channel::<()>();
        ts.launcher.during_next_open(Box::new(move || {
            in_launch.send(()).unwrap();
            let _ = released.recv_timeout(GIVE_UP);
        }));
        let shell = Arc::clone(&ts.shell);
        let (s, g, id, file_id) = file;
        let opener = thread::spawn(move || shell.open_file(s, g, &id, &file_id, true));
        launching.recv_timeout(GIVE_UP).expect("the launch began");

        ts.shell.sessions.lock_all(LockReason::Manual);
        assert!(!opener.is_finished(), "the lock waited for the launch");
        cleaned(&ts);
        assert_eq!(folders_on_disk(&ts), Vec::<String>::new());

        let_go.send(()).unwrap();
        assert_eq!(opener.join().unwrap().err(), LOCKED);
    }

    /// A viewer holds the copy, so the cleanup's delete attempts fail. While the cleanup is parked in its retries the
    /// lock has already returned, and the wait for it stops at its time limit. Once the viewer lets go it finishes.
    #[test]
    fn locking_is_not_delayed_by_cleanup() {
        let ts = TestShell::new();
        let file = stored(&ts, "Family", "report.pdf");
        open(&ts, &file).unwrap();
        let held = hold(&opened_copy(&ts));
        let (in_retry, retrying) = mpsc::channel();
        let (let_go, released) = mpsc::channel::<()>();
        ts.shell.outputs.on_retry(Box::new(move || {
            in_retry.send(()).unwrap();
            let _ = released.recv_timeout(GIVE_UP);
            drop(held);
        }));
        let shell = Arc::clone(&ts.shell);
        let (locked, lock_returned) = mpsc::channel();
        let locker = thread::spawn(move || {
            shell.sessions.lock_all(LockReason::Manual);
            locked.send(()).unwrap();
        });
        retrying.recv_timeout(GIVE_UP).expect("the cleanup retries");
        lock_returned
            .recv_timeout(GIVE_UP)
            .expect("the lock waited for the cleanup");
        assert!(
            !ts.shell
                .open_folders
                .wait_idle(Instant::now() + Duration::from_millis(20)),
            "the cleanup is still parked"
        );
        let_go.send(()).unwrap();
        locker.join().unwrap();
        cleaned(&ts);
        assert_eq!(folders_on_disk(&ts), Vec::<String>::new());
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
        assert_eq!(
            ts.events.notices(),
            Vec::<serde_json::Value>::new(),
            "nothing left to tell"
        );
    }

    /// Fix round 1: a cleanup that starts late, after its vault was unlocked again and another file opened, removes
    /// the copy of the lock it came from and leaves the new one, which belongs to a later generation of that session.
    #[test]
    fn late_cleanup_leaves_a_copy_opened_since() {
        let ts = TestShell::new();
        let file = stored(&ts, "Family", "report.pdf");
        let (s, _, id, file_id) = file.clone();
        open(&ts, &file).unwrap();
        let old_copy = opened_copy(&ts);
        let (parked, is_parked) = mpsc::channel();
        let (let_go, released) = mpsc::channel::<()>();
        ts.shell.open_folders.at_step(
            "cleanup_starts",
            Box::new(move |_| {
                parked.send(()).unwrap();
                let _ = released.recv_timeout(GIVE_UP);
            }),
        );
        ts.shell.sessions.lock(s, LockReason::Manual);
        is_parked.recv_timeout(GIVE_UP).expect("the cleanup began");

        let registry_id = ts.shell.registry.entries()[0].0;
        let password = zeroize::Zeroizing::new(TEST_PASSWORD.to_owned());
        let unlocked = heavy(|| ts.shell.unlock_vault(registry_id, password)).unwrap();
        assert_eq!(unlocked.session, s, "the same session ID");
        let again = (s, unlocked.generation, id, file_id);
        open(&ts, &again).unwrap();
        let new_copy = opened_copy(&ts);
        assert_ne!(new_copy, old_copy);

        let_go.send(()).unwrap();
        cleaned(&ts);
        assert!(!old_copy.parent().unwrap().exists(), "the old one goes");
        assert_eq!(fs::read(&new_copy).unwrap(), PDF, "the new one stays");
        assert_eq!(ts.journal(), [new_copy.parent().unwrap().to_path_buf()]);

        // Its own lock takes it.
        ts.shell.sessions.lock(s, LockReason::Manual);
        cleaned(&ts);
        assert_eq!(folders_on_disk(&ts), Vec::<String>::new());
    }

    /// Fix round 1: a Retry parked on a held folder counts as a cleanup: a close would wait for it. The folder is off
    /// the list by then, so nothing else shows it is still being worked on.
    #[test]
    fn wait_idle_covers_a_retry() {
        let ts = TestShell::new();
        let file = stored(&ts, "Family", "report.pdf");
        open(&ts, &file).unwrap();
        let copy = opened_copy(&ts);
        let held = hold(&copy);
        assert_eq!(ts.shell.open_folders.remove_all().still_open, 1);

        let (in_retry, retrying) = mpsc::channel();
        let (let_go, released) = mpsc::channel::<()>();
        ts.shell.outputs.on_retry(Box::new(move || {
            in_retry.send(()).unwrap();
            let _ = released.recv_timeout(GIVE_UP);
            drop(held);
        }));
        let shell = Arc::clone(&ts.shell);
        let retry = thread::spawn(move || shell.open_folders.retry());
        retrying.recv_timeout(GIVE_UP).expect("the retry is held");
        assert!(
            !ts.shell.open_folders.wait_idle(Instant::now()),
            "the parked retry counts"
        );
        let_go.send(()).unwrap();
        cleaned(&ts);
        assert_eq!(retry.join().unwrap().removed, 1);
        assert!(!copy.parent().unwrap().exists());
    }

    /// Fix round 1: the same for the removal of an open that stopped.
    #[test]
    fn wait_idle_covers_a_discard() {
        let ts = TestShell::new();
        let file = stored(&ts, "Family", "report.pdf");
        open(&ts, &file).unwrap();
        let copy = opened_copy(&ts);
        let held = hold(&copy);
        let (in_retry, retrying) = mpsc::channel();
        let (let_go, released) = mpsc::channel::<()>();
        ts.shell.outputs.on_retry(Box::new(move || {
            in_retry.send(()).unwrap();
            let _ = released.recv_timeout(GIVE_UP);
            drop(held);
        }));
        let shell = Arc::clone(&ts.shell);
        let folder = copy.parent().unwrap().to_path_buf();
        let discard = thread::spawn(move || shell.open_folders.discard(&folder));
        retrying.recv_timeout(GIVE_UP).expect("the discard is held");
        assert!(
            !ts.shell.open_folders.wait_idle(Instant::now()),
            "the parked discard counts"
        );
        let_go.send(()).unwrap();
        cleaned(&ts);
        discard.join().unwrap();
        assert!(!copy.parent().unwrap().exists());
    }

    /// Fix round 1: a launch fails while something holds the copy: the page hears of it, and it goes on Retry.
    #[test]
    fn failed_launch_of_a_held_copy_is_reported() {
        let ts = TestShell::new();
        let file = stored(&ts, "Family", "report.pdf");
        ts.launcher.fail_next_file();
        let launcher = Arc::clone(&ts.launcher);
        let (handle, holding) = mpsc::channel();
        ts.launcher.during_next_open(Box::new(move || {
            handle.send(hold(&launcher.opened_files()[0])).unwrap();
        }));
        let answer = open(&ts, &file);
        assert!(matches!(answer, Err(ShellError::Core(view)) if view.kind == "io"));
        assert_eq!(
            ts.events.notices(),
            [json!({ "kind": "open_cleanup", "removed": 0, "still_open": 1 })]
        );
        let copy = opened_copy(&ts);
        assert!(copy.exists());
        drop(holding.recv().unwrap());
        assert_eq!(ts.shell.open_folders.retry().removed, 1);
        assert_eq!(folders_on_disk(&ts), Vec::<String>::new());
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    /// A lock removes the copies of its own vault only; the other vault's stay until it locks too.
    #[test]
    fn lock_removes_that_vaults_opened_files() {
        let ts = TestShell::new();
        let family = stored(&ts, "Family", "family.pdf");
        let work = stored(&ts, "Work", "work.pdf");
        open(&ts, &family).unwrap();
        let family_copy = opened_copy(&ts);
        open(&ts, &work).unwrap();
        let work_copy = opened_copy(&ts);

        ts.shell.sessions.lock(family.0, LockReason::Manual);
        cleaned(&ts);
        assert!(!family_copy.parent().unwrap().exists());
        assert_eq!(fs::read(&work_copy).unwrap(), PDF);
        assert_eq!(ts.journal(), [work_copy.parent().unwrap().to_path_buf()]);

        ts.shell.sessions.lock(work.0, LockReason::Manual);
        cleaned(&ts);
        assert_eq!(folders_on_disk(&ts), Vec::<String>::new());
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    /// App close removes every copy. Fix round 1: a shutdown on a busy machine may return at its deadline with the work
    /// still going, which is its right, so the test waits for that work itself: its hooks first (a hook after the "Open"
    /// one says when), then the cleanup they started. Nothing but the shutdown starts a cleanup here.
    #[test]
    fn shutdown_removes_all_opened_files() {
        let ts = TestShell::new();
        let family = stored(&ts, "Family", "family.pdf");
        let work = stored(&ts, "Work", "work.pdf");
        open(&ts, &family).unwrap();
        open(&ts, &work).unwrap();
        assert_eq!(folders_on_disk(&ts).len(), 2);
        let (hooks_ran, hooks_done) = mpsc::channel();
        ts.shell.sessions.on_lock(Box::new(move |_, _| {
            let _ = hooks_ran.send(());
        }));
        ts.shell.shutdown();
        hooks_done.recv_timeout(GIVE_UP).unwrap();
        cleaned(&ts);
        assert_eq!(folders_on_disk(&ts), Vec::<String>::new());
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    /// Fix round 1: with the sessions gone nothing is alive, so a cleanup picks every folder, an earlier run's too.
    #[test]
    fn cleanup_with_the_sessions_gone_removes_everything() {
        let ts = TestShell::new();
        let file = stored(&ts, "Family", "report.pdf");
        open(&ts, &file).unwrap();
        let (leftover, copy) = leftover_listed_by_nothing(&ts);
        let held = hold(&copy);
        ts.shell.open_folders.sweep_leftovers();
        drop(held);
        let hook = ts.shell.open_folders.lock_hook(Weak::new());
        hook(None, LockReason::AppClosing);
        cleaned(&ts);
        assert!(!leftover.exists());
        assert_eq!(folders_on_disk(&ts), Vec::<String>::new());
    }

    /// A cleanup parked in its retries for good: the shutdown waits for it, up to its one deadline and not past it.
    #[test]
    fn shutdown_waits_for_cleanup_until_its_deadline() {
        let ts = TestShell::new();
        let file = stored(&ts, "Family", "report.pdf");
        open(&ts, &file).unwrap();
        let held = hold(&opened_copy(&ts));
        let (in_retry, retrying) = mpsc::channel();
        let (let_go, released) = mpsc::channel::<()>();
        ts.shell.outputs.on_retry(Box::new(move || {
            in_retry.send(()).unwrap();
            let _ = released.recv_timeout(GIVE_UP);
            drop(held);
        }));
        let began = Instant::now();
        ts.shell.shutdown();
        let took = began.elapsed();
        assert!(took >= SHUTDOWN_WAIT, "it did not wait: {took:?}");
        // Generous: the point is that it ended while the cleanup is still parked, which the next lines show.
        assert!(took < SHUTDOWN_WAIT + Duration::from_secs(30), "{took:?}");
        retrying.recv_timeout(GIVE_UP).expect("the cleanup retries");
        assert!(!ts.shell.open_folders.wait_idle(Instant::now()));
        let_go.send(()).unwrap();
        cleaned(&ts);
        assert_eq!(folders_on_disk(&ts), Vec::<String>::new());
    }

    /// A copy a viewer holds stays, read-only and listed, and is told once. Let go, the retry removes it. A retry
    /// leaves alone the copies nothing has tried to remove yet.
    #[test]
    fn file_in_use_is_kept_and_retried() {
        let ts = TestShell::new();
        let file = stored(&ts, "Family", "report.pdf");
        open(&ts, &file).unwrap();
        let copy = opened_copy(&ts);
        let held = hold(&copy);

        assert_eq!(
            ts.shell.open_folders.remove_all(),
            RemoveReport {
                removed: 0,
                still_open: 1
            }
        );
        assert!(
            fs::metadata(&copy).unwrap().permissions().readonly(),
            "still read-only"
        );
        assert_eq!(ts.journal(), [copy.parent().unwrap().to_path_buf()]);

        drop(held);
        assert_eq!(
            ts.shell.open_folders.retry(),
            RemoveReport {
                removed: 1,
                still_open: 0
            }
        );
        assert!(!copy.parent().unwrap().exists());
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());

        // Nothing tried to remove this one: it is in use by the user, not stuck.
        open(&ts, &file).unwrap();
        let live = opened_copy(&ts);
        assert_eq!(ts.shell.open_folders.retry(), RemoveReport::default());
        assert_eq!(fs::read(&live).unwrap(), PDF);
    }

    /// A lock's cleanup that cannot remove a held copy tells the page; the page's retry command finds it again.
    #[test]
    fn lock_reports_a_held_copy() {
        let ts = TestShell::new();
        let file = stored(&ts, "Family", "report.pdf");
        open(&ts, &file).unwrap();
        let copy = opened_copy(&ts);
        let held = hold(&copy);
        ts.shell.sessions.lock_all(LockReason::Manual);
        cleaned(&ts);
        assert_eq!(
            ts.events.notices(),
            [json!({ "kind": "open_cleanup", "removed": 0, "still_open": 1 })]
        );
        assert!(copy.exists());
        drop(held);
        assert_eq!(ts.shell.open_folders.retry().removed, 1);
        assert_eq!(folders_on_disk(&ts), Vec::<String>::new());
    }

    /// The folder's own permissions, and the copy's, which it passes on: the current user alone, nothing from above.
    #[cfg(windows)]
    #[test]
    fn open_folder_acl_is_user_only() {
        let ts = TestShell::new();
        let file = stored(&ts, "Family", "report.pdf");
        open(&ts, &file).unwrap();
        let copy = opened_copy(&ts);
        let user = win::test_user_sid();
        let (protected, entries) = win::read_dacl(copy.parent().unwrap()).unwrap();
        assert!(protected, "nothing inherited from above");
        assert_eq!(
            entries,
            [win::AclEntry {
                allow: true,
                flags: INHERIT,
                mask: FULL_ACCESS,
                sid: user.clone(),
            }]
        );
        let (_, entries) = win::read_dacl(&copy).unwrap();
        assert_eq!(
            entries,
            [win::AclEntry {
                allow: true,
                flags: INHERITED,
                mask: FULL_ACCESS,
                sid: user,
            }]
        );
    }

    /// A lock while the copy is being written, with the temp not made yet and with it finished but not published:
    /// `Locked`, the partial copy and its folder gone, the journal empty, nothing launched.
    #[test]
    fn lock_during_open_deletes_partial() {
        let _cleanup = Cleanup;
        for step in ["export.after_record", "export.before_publish"] {
            let ts = TestShell::new();
            let file = stored(&ts, "Family", "report.pdf");
            let shell = Arc::clone(&ts.shell);
            failpoint::observe(
                step,
                Box::new(move || shell.sessions.lock_all(LockReason::Manual)),
            );
            assert_eq!(open(&ts, &file).err(), LOCKED, "{step}");
            failpoint::disarm_all();
            assert!(ts.launcher.opened_files().is_empty(), "{step}");
            cleaned(&ts);
            assert_eq!(folders_on_disk(&ts), Vec::<String>::new(), "{step}");
            assert_eq!(ts.journal(), Vec::<PathBuf>::new(), "{step}");
        }
    }

    /// The journal lists the folder before it exists; a journal that cannot be written stops the open with nothing
    /// made; a damaged one refuses before anything else.
    #[test]
    fn journal_comes_before_the_folder() {
        let _cleanup = Cleanup;
        let ts = TestShell::new();
        let file = stored(&ts, "Family", "report.pdf");
        let journal = ts.shell.paths.outputs.clone();
        let (seen, was_seen) = mpsc::channel();
        ts.shell.open_folders.at_step(
            "recorded",
            Box::new(move |folder| {
                let listed = fs::read_to_string(&journal)
                    .unwrap()
                    .contains(&folder.file_name().unwrap().to_string_lossy().into_owned());
                seen.send(listed && !folder.exists()).unwrap();
            }),
        );
        open(&ts, &file).unwrap();
        assert!(was_seen.try_recv().unwrap(), "written down first");
        ts.shell.open_folders.remove_all();

        let before = fs::read_to_string(&ts.shell.paths.outputs).unwrap();
        failpoint::arm("atomic_write.before_replace");
        let launched = ts.launcher.opened_files().len();
        let answer = open(&ts, &file);
        assert!(matches!(answer, Err(ShellError::Core(view)) if view.kind == "io"));
        failpoint::disarm_all();
        assert_eq!(folders_on_disk(&ts), Vec::<String>::new(), "nothing made");
        assert_eq!(fs::read_to_string(&ts.shell.paths.outputs).unwrap(), before);
        assert_eq!(ts.launcher.opened_files().len(), launched);

        fs::write(&ts.shell.paths.outputs, "not json").unwrap();
        assert_eq!(
            open(&ts, &file).err(),
            Some(
                lockbox_core::CoreError::Damaged {
                    what: crate::outputs::WHAT
                }
                .into()
            )
        );
        assert_eq!(folders_on_disk(&ts), Vec::<String>::new(), "nothing made");
    }

    /// Fix round 2: where permissions do not last, a user-only folder cannot be promised, so no plaintext goes there.
    #[test]
    fn open_refused_where_permissions_do_not_last() {
        let ts = TestShell::new();
        let file = stored(&ts, "Family", "report.pdf");
        fs::create_dir_all(&ts.shell.paths.open).unwrap();
        ts.volumes.mount(
            &ts.shell.paths.open,
            FakeVolume {
                file_system: "FAT32",
                ..LOCAL_NTFS
            },
        );
        assert_eq!(
            open(&ts, &file).err(),
            Some(ShellError::InvalidInput {
                what: "open folder"
            })
        );
        assert!(ts.launcher.opened_files().is_empty());
        assert_eq!(folders_on_disk(&ts), Vec::<String>::new());
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    /// A link on the way to `open\`: the sweep's rule would leave any copy there on disk for good, so none is made.
    #[test]
    fn open_refused_when_a_link_leads_to_the_open_folder() {
        let ts = TestShell::new();
        let file = stored(&ts, "Family", "report.pdf");
        let elsewhere = ts.folder("elsewhere");
        fs::create_dir_all(&ts.shell.paths.root).unwrap();
        make_dir_link(&ts.shell.paths.open, &elsewhere);
        assert_eq!(
            open(&ts, &file).err(),
            Some(ShellError::InvalidInput {
                what: "open folder"
            })
        );
        assert!(ts.launcher.opened_files().is_empty());
        assert!(names(&elsewhere).is_empty(), "no plaintext behind the link");
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    /// A launch that fails (no app takes the type) leaves nothing behind.
    #[test]
    fn failed_launch_removes_the_copy() {
        let ts = TestShell::new();
        let file = stored(&ts, "Family", "report.pdf");
        ts.launcher.fail_next_file();
        let answer = open(&ts, &file);
        assert!(matches!(answer, Err(ShellError::Core(view)) if view.kind == "io"));
        assert_eq!(folders_on_disk(&ts), Vec::<String>::new());
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    /// As if the app crashed with a copy open: the next launch's sweep removes it, by the journal entry open wrote.
    #[test]
    fn sweep_removes_a_copy_left_by_a_crash() {
        let ts = TestShell::new();
        let file = stored(&ts, "Family", "report.pdf");
        open(&ts, &file).unwrap();
        let report = ts.shell.sweep_outputs();
        assert_eq!((report.removed, report.kept), (1, 0));
        assert_eq!(folders_on_disk(&ts), Vec::<String>::new());
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    /// A copy still held at launch: kept, reported through `launch_notices`, and on the retry list.
    #[test]
    fn launch_reports_copies_it_could_not_remove() {
        let ts = TestShell::new();
        // An earlier run of the app made it: only the journal knows the folder.
        let paths = &ts.shell.paths;
        let folder = paths.open.join("0123456789abcdef0123456789abcdef");
        fs::create_dir_all(&folder).unwrap();
        let copy = folder.join("report.pdf");
        fs::write(&copy, PDF).unwrap();
        let journal = json!({ "version": 1, "entries": [folder] });
        fs::write(&paths.outputs, journal.to_string()).unwrap();
        let held = hold(&copy);

        let report = ts.shell.sweep_outputs();
        assert_eq!((report.removed, report.kept), (0, 1));
        let told = json!({ "kind": "open_cleanup", "removed": 0, "still_open": 1 });
        let notices = serde_json::to_value(ts.shell.launch_notices()).unwrap();
        assert_eq!(notices[1], told, "{notices}");
        assert!(ts.events.notices().contains(&told));

        assert_eq!(
            ts.shell.open_folders.retry(),
            RemoveReport {
                removed: 0,
                still_open: 1
            }
        );
        drop(held);
        // It has no owner left, so a lock tries it too (spec §7.2).
        ts.shell.sessions.lock_all(LockReason::Manual);
        cleaned(&ts);
        assert!(!folder.exists());
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    const LEFTOVER: &str = "0123456789abcdef0123456789abcdef";

    /// A folder `open\<LEFTOVER>` holding a read-only copy, as an earlier run left it, listed nowhere.
    fn leftover_listed_by_nothing(ts: &TestShell) -> (PathBuf, PathBuf) {
        let folder = ts.shell.paths.open.join(LEFTOVER);
        fs::create_dir_all(&folder).unwrap();
        let copy = folder.join("report.pdf");
        fs::write(&copy, PDF).unwrap();
        let mut read_only = fs::metadata(&copy).unwrap().permissions();
        read_only.set_readonly(true);
        fs::set_permissions(&copy, read_only).unwrap();
        (folder, copy)
    }

    /// A real folder with Lockbox's name in `open\` that no entry lists (a damaged journal was set aside): gone at the
    /// next launch, told, and no journal is written for it.
    #[test]
    fn leftover_without_a_journal_entry_is_removed_at_launch() {
        let ts = TestShell::new();
        let (folder, _) = leftover_listed_by_nothing(&ts);
        assert_eq!(ts.shell.sweep_outputs(), Default::default());
        assert!(!folder.exists());
        assert!(ts.shell.paths.open.is_dir(), "`open\\` itself stays");
        assert!(!ts.shell.paths.outputs.exists(), "no journal change");
        let told = json!({ "kind": "open_cleanup", "removed": 1, "still_open": 0 });
        assert_eq!(ts.events.notices(), std::slice::from_ref(&told));
        let notices = serde_json::to_value(ts.shell.launch_notices()).unwrap();
        assert_eq!(notices, json!([told]));
    }

    /// The case this closes: while the journal is damaged, its entries unreadable, the listing still finds the copy.
    /// The journal stays as it is, reported, and still blocks new output.
    #[test]
    fn leftover_is_removed_while_the_journal_is_damaged() {
        let ts = TestShell::new();
        let (s, g, id, file_id) = stored(&ts, "Family", "report.pdf");
        let (folder, _) = leftover_listed_by_nothing(&ts);
        fs::write(&ts.shell.paths.outputs, "not json").unwrap();

        assert!(ts.shell.sweep_outputs().unreadable);
        assert!(!folder.exists());
        assert_eq!(
            fs::read_to_string(&ts.shell.paths.outputs).unwrap(),
            "not json"
        );
        let damaged = lockbox_core::CoreError::Damaged {
            what: crate::outputs::WHAT,
        };
        assert_eq!(
            ts.shell.open_file(s, g, &id, &file_id, true).err(),
            Some(damaged.into())
        );
    }

    /// Only a real folder with exactly Lockbox's name is a leftover. A file with that name, a wrongly named folder and
    /// a link with that name stay, with what the link leads to, and none is told as a copy.
    #[cfg(windows)]
    #[test]
    fn other_things_in_the_open_folder_are_left_alone() {
        let ts = TestShell::new();
        let open = ts.shell.paths.open.clone();
        fs::create_dir_all(&open).unwrap();
        let file = open.join("11111111111111111111111111111111");
        fs::write(&file, b"mine").unwrap();
        let wrong_names = [
            "not an open folder",
            "0123456789ABCDEF0123456789ABCDEF",
            "0123456789abcdef0123456789abcde",
            "0123456789abcdef0123456789abcdef0",
        ];
        for name in wrong_names {
            fs::create_dir(open.join(name)).unwrap();
            fs::write(open.join(name).join("inside.txt"), b"mine").unwrap();
        }
        let target = ts.folder("target");
        fs::write(target.join("kept.txt"), b"mine").unwrap();
        let link = open.join("22222222222222222222222222222222");
        make_dir_link(&link, &target);

        assert_eq!(ts.shell.sweep_outputs(), Default::default());
        assert_eq!(fs::read(&file).unwrap(), b"mine");
        for name in wrong_names {
            assert!(open.join(name).join("inside.txt").is_file(), "{name}");
        }
        assert!(fs::symlink_metadata(&link).is_ok(), "the link stays");
        assert!(target.join("kept.txt").is_file());
        assert_eq!(ts.events.notices(), Vec::<serde_json::Value>::new());
        assert_eq!(ts.shell.open_folders.retry(), RemoveReport::default());
    }

    /// `open\` itself a link: what is behind it is not Lockbox's, whatever it is called.
    #[cfg(windows)]
    #[test]
    fn nothing_is_listed_behind_a_linked_open_folder() {
        let ts = TestShell::new();
        let elsewhere = ts.folder("elsewhere");
        fs::create_dir(elsewhere.join(LEFTOVER)).unwrap();
        fs::write(elsewhere.join(LEFTOVER).join("inside.txt"), b"mine").unwrap();
        fs::create_dir_all(&ts.shell.paths.root).unwrap();
        make_dir_link(&ts.shell.paths.open, &elsewhere);

        assert_eq!(ts.shell.sweep_outputs(), Default::default());
        assert!(elsewhere.join(LEFTOVER).join("inside.txt").is_file());
        assert_eq!(ts.events.notices(), Vec::<serde_json::Value>::new());
    }

    /// A leftover another app holds: kept, in the same count and notice, and on the retry list. An entry the journal
    /// still lists is counted once, not again by the listing.
    #[test]
    fn leftover_held_open_is_counted_and_retried() {
        let ts = TestShell::new();
        let (folder, copy) = leftover_listed_by_nothing(&ts);
        let listed = ts.shell.paths.open.join("fedcba9876543210fedcba9876543210");
        fs::create_dir(&listed).unwrap();
        let listed_copy = listed.join("listed.pdf");
        fs::write(&listed_copy, PDF).unwrap();
        let journal = json!({ "version": 1, "entries": [listed] });
        fs::write(&ts.shell.paths.outputs, journal.to_string()).unwrap();
        let held = (hold(&copy), hold(&listed_copy));

        ts.shell.sweep_outputs();
        let told = json!({ "kind": "open_cleanup", "removed": 0, "still_open": 2 });
        assert!(
            ts.events.notices().contains(&told),
            "{:?}",
            ts.events.notices()
        );
        assert!(fs::metadata(&copy).unwrap().permissions().readonly());

        drop(held);
        assert_eq!(
            ts.shell.open_folders.retry(),
            RemoveReport {
                removed: 2,
                still_open: 0
            }
        );
        assert!(!folder.exists() && !listed.exists());
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }
}
