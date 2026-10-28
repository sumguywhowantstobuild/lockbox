//! Safe file operations: crash-safe writes, retries, space checks, hidden temp files.
//!
//! The platform-specific calls live in `windows` (Win32) or `portable` (everything
//! else, so the code builds and is tested on Linux CI); both expose the same small
//! `sys` surface and this module adds the shared retry and error handling on top.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::secret::random_bytes;
use crate::{CoreError, Result};

#[cfg(not(windows))]
mod portable;
#[cfg(windows)]
mod windows;

#[cfg(not(windows))]
use portable as sys;
#[cfg(windows)]
use windows as sys;

/// Slack kept free on top of what an import or export needs.
const SPACE_MARGIN: u64 = 64 * 1024 * 1024;
const MAX_ATTEMPTS: u32 = 10;
const FIRST_WAIT: Duration = Duration::from_millis(20);
const MAX_WAIT: Duration = Duration::from_secs(1);

/// What we know about the volume a folder lives on. `None` means "unknown": never a reason to block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VolumeInfo {
    pub free_bytes: Option<u64>,
    pub max_file_bytes: Option<u64>,
}

/// Free space and per-file size limit of the volume holding `dir`.
pub fn volume_info(dir: &Path) -> Result<VolumeInfo> {
    #[cfg(test)]
    if let Some(fake) = VOLUME_OVERRIDE.with(|v| v.get()) {
        return Ok(fake);
    }
    Ok(sys::volume_info(dir)?)
}

#[cfg(test)]
thread_local! {
    static VOLUME_OVERRIDE: std::cell::Cell<Option<VolumeInfo>> = const { std::cell::Cell::new(None) };
}

/// Lets a test pretend the disk is full or FAT32 (this thread only).
#[cfg(test)]
pub(crate) fn set_volume_override(v: Option<VolumeInfo>) {
    VOLUME_OVERRIDE.with(|cell| cell.set(v));
}

/// Pure check: can `needed` more bytes be written, and can a single file of `file_bytes` exist here?
pub fn check_space(needed: u64, file_bytes: u64, v: &VolumeInfo) -> Result<()> {
    if let Some(max_file) = v.max_file_bytes
        && file_bytes > max_file
    {
        return Err(CoreError::FileSystemLimit { max_file });
    }
    if let Some(available) = v.free_bytes
        && needed.saturating_add(SPACE_MARGIN) > available
    {
        return Err(CoreError::NotEnoughSpace { needed, available });
    }
    Ok(())
}

/// Runs `op`, retrying while another program briefly holds the file (Windows errors
/// 32 sharing violation and 5 access denied: antivirus, indexer, backup tools).
/// Waits 20 ms, doubling, at most 1 s each, for up to 10 attempts. `sleep` is injected for tests.
fn retry_with<T>(op: impl FnMut() -> io::Result<T>, sleep: impl FnMut(Duration)) -> io::Result<T> {
    backoff(op, is_transient, sleep)
}

/// [`retry_with`] where each attempt runs inside `gate`, which gets `op` as one single attempt
/// and may refuse it. The waits come between gate calls, never inside one. Whatever the gate
/// returns is retried only if it is a transient I/O error (its own or the attempt's), so any
/// other refusal stops the retries.
fn retry_gated(
    mut op: impl FnMut() -> io::Result<()>,
    mut gate: impl FnMut(&mut dyn FnMut() -> Result<()>) -> Result<()>,
    sleep: impl FnMut(Duration),
) -> Result<()> {
    backoff(
        || gate(&mut || -> Result<()> { Ok(op()?) }),
        |e| matches!(e, CoreError::Io(e) if is_transient(e)),
        sleep,
    )
}

/// The one retry loop: runs `op` until it succeeds, fails with an error `transient` does not
/// accept, or has had [`MAX_ATTEMPTS`]; waits [`FIRST_WAIT`], doubling, at most [`MAX_WAIT`],
/// before each new attempt.
fn backoff<T, E>(
    mut op: impl FnMut() -> std::result::Result<T, E>,
    transient: impl Fn(&E) -> bool,
    mut sleep: impl FnMut(Duration),
) -> std::result::Result<T, E> {
    let mut wait = FIRST_WAIT;
    for attempt in 1.. {
        match op() {
            Err(e) if attempt < MAX_ATTEMPTS && transient(&e) => {
                sleep(wait);
                wait = (wait * 2).min(MAX_WAIT);
            }
            result => return result,
        }
    }
    unreachable!("the loop returns on the last attempt")
}

fn retry<T>(op: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    retry_with(op, std::thread::sleep)
}

fn is_transient(e: &io::Error) -> bool {
    // Windows ERROR_SHARING_VIOLATION and ERROR_ACCESS_DENIED. Other systems use
    // these numbers for unrelated errors, so they are only retried on Windows.
    cfg!(windows) && matches!(e.raw_os_error(), Some(32 | 5))
}

pub(crate) fn parent_dir(path: &Path) -> &Path {
    path.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
}

/// Moves `from` over `to` (replacing it) and makes the move durable.
pub fn replace_file(from: &Path, to: &Path) -> Result<()> {
    Ok(retry(|| sys::replace_file(from, to))?)
}

/// The move half of [`replace_file`], for publishing an output: each attempt of the move runs
/// through `gate` (the output journal's `publish`), and the waits between attempts come outside
/// it. A gate refusal or a non-transient error stops the retries and is returned; `to` is then
/// untouched. On success the move is done but not yet durable: call [`sync_after_replace`].
pub(crate) fn rename_replace_gated(
    from: &Path,
    to: &Path,
    gate: impl FnMut(&mut dyn FnMut() -> Result<()>) -> Result<()>,
) -> Result<()> {
    retry_gated(|| sys::rename_replace(from, to), gate, std::thread::sleep)
}

/// The durability half of [`replace_file`], after a successful [`rename_replace_gated`] to
/// `to`: flushes the folder where that is needed (not on Windows, where the move was
/// write-through). An error here means `to` is already replaced, but durability is not confirmed.
pub(crate) fn sync_after_replace(to: &Path) -> Result<()> {
    #[cfg(any(test, feature = "test-internals"))]
    failpoint::check("publish.after_rename")?;
    Ok(sys::sync_after_replace(to)?)
}

/// A destination that is already taken.
pub(crate) const DESTINATION_EXISTS: CoreError = CoreError::InvalidInput {
    what: "destination exists",
};

/// Moves the file or folder `from` to `to`, which must not exist (`InvalidInput` if it does).
pub fn rename_dir_no_replace(from: &Path, to: &Path) -> Result<()> {
    if to.try_exists()? {
        return Err(DESTINATION_EXISTS);
    }
    retry(|| sys::rename_no_replace(from, to)).map_err(taken_or_io)
}

/// Moves the file `from` to `to`, which must not exist at all: not a file, a folder or a
/// (dangling) link; `InvalidInput` if anything is there. Unlike [`rename_dir_no_replace`] the
/// check and the move are one step, so a competing writer cannot slip in between.
pub fn rename_file_no_replace(from: &Path, to: &Path) -> Result<()> {
    retry(|| sys::rename_file_no_replace(from, to)).map_err(taken_or_io)?;
    // An error here is one reported after the file landed, as the portable version can (it
    // links first, then removes the source and syncs the folder).
    #[cfg(any(test, feature = "test-internals"))]
    failpoint::check("publish.after_link")?;
    Ok(())
}

fn taken_or_io(e: io::Error) -> CoreError {
    // AlreadyExists on Windows; Linux reports a non-empty target as DirectoryNotEmpty.
    if matches!(
        e.kind(),
        io::ErrorKind::AlreadyExists | io::ErrorKind::DirectoryNotEmpty
    ) {
        DESTINATION_EXISTS
    } else {
        e.into()
    }
}

/// Clears the hidden attribute (other attributes stay). Windows keeps a file's
/// attributes when it is moved over another, so a hidden temp would make the saved
/// file hidden; call this before the move. No-op where hiding is just a leading dot.
pub fn clear_hidden(path: &Path) -> Result<()> {
    Ok(sys::clear_hidden(path)?)
}

/// Sets the hidden attribute (other attributes stay), e.g. on a staging folder.
/// No-op where hiding is just a leading dot.
pub fn set_hidden(path: &Path) -> Result<()> {
    Ok(sys::set_hidden(path)?)
}

/// Flushes the folder itself to disk, so names created or renamed inside it survive a power cut.
pub fn sync_dir(path: &Path) -> Result<()> {
    Ok(sys::sync_dir(path)?)
}

/// Deletes `path`, clearing a read-only flag first. A missing file counts as success.
pub fn remove_file_retry(path: &Path) -> Result<()> {
    match retry(|| {
        sys::clear_readonly(path)?;
        fs::remove_file(path)
    }) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

/// Deletes the folder `path` and everything in it, retrying like the other operations while
/// another program briefly holds something inside. A missing folder counts as success. The
/// caller decides whether `path` is a folder it may delete.
pub fn remove_dir_all_retry(path: &Path) -> Result<()> {
    match retry(|| fs::remove_dir_all(path)) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

/// Reads `path`, retrying like the other operations while another program holds it. Reads
/// at most `max + 1` bytes, so a file over `max` is noticed without loading all of it.
pub(crate) fn read_retry(path: &Path, max: usize) -> Result<Vec<u8>> {
    Ok(retry(|| {
        let mut bytes = Vec::new();
        File::open(path)?
            .take(max as u64 + 1)
            .read_to_end(&mut bytes)?;
        Ok(bytes)
    })?)
}

/// Opens `path` for reading. On Windows the handle shares read access only, so nobody can
/// change, replace or delete the file while it is held. Elsewhere a plain open.
pub fn open_shared_read(path: &Path) -> Result<File> {
    Ok(retry(|| sys::open_shared_read(path))?)
}

/// Whether the file at `path` is the open `file`, whatever its name (a hard link, another
/// spelling of the path, a link to it). Nothing at `path`, or a folder, is not.
pub fn is_same_file(file: &File, path: &Path) -> Result<bool> {
    match fs::metadata(path) {
        Ok(meta) if meta.is_file() => Ok(sys::file_id(file)? == sys::file_id(&File::open(path)?)?),
        Ok(_) => Ok(false),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}

/// Reads up to `buf.len()` bytes at `offset`; 0 means end of file.
pub fn read_at(file: &File, buf: &mut [u8], offset: u64) -> Result<usize> {
    Ok(retry(|| sys::read_at(file, buf, offset))?)
}

/// A fresh name `.<16 random hex chars><suffix>` in `dir` for a hidden temp file; nothing is created.
/// Lets a caller record the path (e.g. in the output journal) before the file exists.
pub fn hidden_temp_path(dir: &Path, suffix: &str) -> PathBuf {
    #[cfg(test)]
    if let Some(name) = FORCED_TEMP_NAME.with(|n| n.borrow_mut().take()) {
        return dir.join(name);
    }
    let hex: String = random_bytes::<8>()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    dir.join(format!(".{hex}{suffix}"))
}

#[cfg(test)]
thread_local! {
    static FORCED_TEMP_NAME: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// Makes the next `hidden_temp_path` on this thread return `dir/name`, to force a collision.
#[cfg(test)]
pub(crate) fn force_next_temp_name(name: &str) {
    FORCED_TEMP_NAME.with(|n| *n.borrow_mut() = Some(name.to_owned()));
}

/// Creates the new, empty, hidden file `path`. Fails rather than reuse an existing file.
pub fn create_hidden_file(path: &Path) -> Result<File> {
    Ok(sys::create_hidden(path)?)
}

/// Creates a new, empty, hidden file `.<16 random hex chars><suffix>` in `dir`.
/// Fails rather than reuse an existing file.
pub fn create_hidden_temp(dir: &Path, suffix: &str) -> Result<(File, PathBuf)> {
    let path = hidden_temp_path(dir, suffix);
    let file = create_hidden_file(&path)?;
    Ok((file, path))
}

/// The most memory this process has held in RAM at once, in bytes. `None` where it is not
/// measured (everywhere but Windows), and on Windows if the system call fails. Only for the
/// large-file test; not a stable API.
#[doc(hidden)]
#[cfg_attr(not(any(test, feature = "test-internals")), allow(dead_code))]
pub fn peak_memory_bytes() -> Option<u64> {
    sys::peak_memory_bytes()
}

/// Writes `bytes` to `target` so a crash or power cut leaves either the old or the new
/// content, never a mix: temp file in the same folder, flushed to disk, then swapped in.
/// The temp file is removed if anything fails.
pub fn atomic_write(target: &Path, bytes: &[u8]) -> Result<()> {
    write_then_publish(target, bytes, replace_file)
}

/// [`atomic_write`] for a `target` that must not exist at all (`InvalidInput` "destination
/// exists" if anything is there, a dangling link included): the first writer wins and nobody
/// else's file is replaced.
pub fn atomic_create(target: &Path, bytes: &[u8]) -> Result<()> {
    write_then_publish(target, bytes, rename_file_no_replace)
}

fn write_then_publish(
    target: &Path,
    bytes: &[u8],
    publish: impl FnOnce(&Path, &Path) -> Result<()>,
) -> Result<()> {
    let (mut file, tmp) = create_hidden_temp(parent_dir(target), ".tmp")?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        clear_hidden(&tmp)?;
        drop(file); // Windows cannot replace a file that is still open without delete sharing.
        #[cfg(any(test, feature = "test-internals"))]
        failpoint::check("atomic_write.before_replace")?;
        publish(&tmp, target)
    })();
    if result.is_err() {
        let _ = remove_file_retry(&tmp);
    }
    result
}

/// Test hooks that make a named step fail, to prove the order of crash-safe writes.
/// Thread-local, so parallel tests do not disturb each other.
#[cfg(any(test, feature = "test-internals"))]
pub mod failpoint {
    use crate::Result;
    use crate::blob::CancelToken;
    use std::cell::RefCell;

    type Observer = (&'static str, Box<dyn FnMut()>);

    thread_local! {
        static ARMED: RefCell<Vec<&'static str>> = const { RefCell::new(Vec::new()) };
        static CANCELS: RefCell<Vec<(&'static str, CancelToken)>> = const { RefCell::new(Vec::new()) };
        static OBSERVERS: RefCell<Vec<Observer>> = const { RefCell::new(Vec::new()) };
    }

    /// Runs `f` each time the step `name` is reached, before its usual behaviour, so a test
    /// can look at the disk at exactly that point.
    pub fn observe(name: &'static str, f: Box<dyn FnMut()>) {
        OBSERVERS.with(|o| o.borrow_mut().push((name, f)));
    }

    /// Cancels `token` when the step `name` is reached (the step itself succeeds), to test
    /// a cancel that arrives at exactly that stage.
    pub fn arm_cancel(name: &'static str, token: CancelToken) {
        CANCELS.with(|c| c.borrow_mut().push((name, token)));
    }

    pub fn arm(name: &'static str) {
        ARMED.with(|a| a.borrow_mut().push(name));
    }

    pub fn disarm_all() {
        ARMED.with(|a| a.borrow_mut().clear());
        CANCELS.with(|c| c.borrow_mut().clear());
        OBSERVERS.with(|o| o.borrow_mut().clear());
    }

    /// Fails with an `Io` error while `name` is armed.
    pub fn check(name: &'static str) -> Result<()> {
        // Taken out while they run, so an observer may itself reach a failpoint.
        let mut observers = OBSERVERS.take();
        for (watched, f) in observers.iter_mut() {
            if *watched == name {
                f();
            }
        }
        OBSERVERS.with(|o| {
            let added = std::mem::replace(&mut *o.borrow_mut(), observers);
            o.borrow_mut().extend(added);
        });
        CANCELS.with(|c| {
            for (armed, token) in c.borrow().iter() {
                if *armed == name {
                    token.cancel();
                }
            }
        });
        if ARMED.with(|a| a.borrow().contains(&name)) {
            return Err(std::io::Error::other(name).into());
        }
        Ok(())
    }
}

#[cfg(any(test, feature = "test-internals"))]
pub mod testutil {
    use std::path::{Path, PathBuf};

    /// A fresh folder under the system temp dir, deleted on drop.
    pub struct TempDir(PathBuf);

    impl TempDir {
        pub fn new() -> TempDir {
            let name: String = crate::secret::random_bytes::<8>()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            let path = std::env::temp_dir().join(format!("lockbox-test-{name}"));
            std::fs::create_dir_all(&path).unwrap();
            TempDir(path)
        }

        pub fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Default for TempDir {
        fn default() -> Self {
            Self::new()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The names directly inside `dir`, sorted.
    pub fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    /// Flips the lowest bit of the byte at offset `at` of the file `path`: one data byte of damage.
    pub fn flip_byte(path: &Path, at: u64) -> std::io::Result<()> {
        use std::io::{Read, Seek, SeekFrom, Write};
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)?;
        let mut byte = [0u8];
        file.seek(SeekFrom::Start(at))?;
        file.read_exact(&mut byte)?;
        byte[0] ^= 1;
        file.seek(SeekFrom::Start(at))?;
        file.write_all(&byte)
    }

    /// Makes `link` a folder link to `target`: a junction on Windows (needs no special rights),
    /// a symlink elsewhere. Panics when it cannot, so a link test never passes by skipping.
    pub fn make_dir_link(link: &Path, target: &Path) {
        #[cfg(windows)]
        {
            let made = std::process::Command::new("cmd")
                .arg("/C")
                .arg("mklink")
                .arg("/J")
                .arg(link)
                .arg(target)
                .output()
                .is_ok_and(|o| o.status.success());
            assert!(made, "cannot create a junction on Windows");
        }
        #[cfg(not(windows))]
        std::os::unix::fs::symlink(target, link).expect("cannot create a symlink");
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::TempDir;
    use super::*;
    use std::time::Duration;

    fn tmp_files(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect()
    }

    #[test]
    fn peak_memory_is_measured_on_windows_only() {
        // A running test process holds at least a megabyte.
        assert_eq!(
            peak_memory_bytes().is_some_and(|b| b > 1 << 20),
            cfg!(windows)
        );
    }

    #[test]
    fn atomic_write_replaces_content() {
        let dir = TempDir::new();
        let target = dir.path().join("vault.json");
        atomic_write(&target, b"old").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"old");
        atomic_write(&target, b"new content").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new content");
    }

    /// `atomic_create` publishes only to a name that is free, whatever else is there.
    #[test]
    fn atomic_create_never_replaces_anything() {
        use super::testutil::make_dir_link;
        let dir = TempDir::new();
        let target = dir.path().join("journal.json");
        atomic_create(&target, b"first").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"first");
        let exists = |r: Result<()>| {
            assert!(matches!(
                r,
                Err(CoreError::InvalidInput {
                    what: "destination exists"
                })
            ));
        };
        exists(atomic_create(&target, b"second"));
        assert_eq!(std::fs::read(&target).unwrap(), b"first");

        let folder = dir.path().join("folder");
        std::fs::create_dir(&folder).unwrap();
        exists(atomic_create(&folder, b"x"));
        let gone = TempDir::new();
        let link = dir.path().join("link");
        make_dir_link(&link, gone.path());
        drop(gone);
        exists(atomic_create(&link, b"x"));
        assert!(std::fs::symlink_metadata(&link).is_ok());
        assert!(tmp_files(dir.path()).is_empty());
    }

    #[test]
    fn remove_dir_all_retry_removes_a_tree_and_forgives_a_missing_one() {
        let dir = TempDir::new();
        let tree = dir.path().join("tree");
        std::fs::create_dir_all(tree.join("a").join("b")).unwrap();
        std::fs::write(tree.join("a").join("b").join("f"), b"x").unwrap();
        remove_dir_all_retry(&tree).unwrap();
        assert!(!tree.exists());
        remove_dir_all_retry(&tree).unwrap();
    }

    /// A program holding a file in the tree for a moment (antivirus) does not stop the removal.
    #[cfg(windows)]
    #[test]
    fn remove_dir_all_retry_waits_out_a_brief_hold() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = TempDir::new();
        let tree = dir.path().join("tree");
        std::fs::create_dir(&tree).unwrap();
        let held = tree.join("held");
        std::fs::write(&held, b"x").unwrap();
        let (opened_tx, opened_rx) = std::sync::mpsc::channel();
        let holder = std::thread::spawn(move || {
            // Share read + write but not delete, so deleting the file fails while it is open.
            let _held = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(1 | 2)
                .open(held)
                .unwrap();
            opened_tx.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(150));
        });
        opened_rx.recv().unwrap();
        assert!(std::fs::remove_dir_all(&tree).is_err(), "the hold works");
        remove_dir_all_retry(&tree).unwrap();
        holder.join().unwrap();
        assert!(!tree.exists());
    }

    #[test]
    fn atomic_write_leaves_no_tmp_on_success() {
        let dir = TempDir::new();
        atomic_write(&dir.path().join("a"), b"x").unwrap();
        assert!(tmp_files(dir.path()).is_empty());
    }

    #[test]
    fn failed_write_keeps_old_content() {
        let dir = TempDir::new();
        let target = dir.path().join("vault.json");
        atomic_write(&target, b"old").unwrap();
        failpoint::arm("atomic_write.before_replace");
        let result = atomic_write(&target, b"new");
        failpoint::disarm_all();
        assert!(matches!(result, Err(CoreError::Io(_))));
        assert_eq!(std::fs::read(&target).unwrap(), b"old");
        assert!(tmp_files(dir.path()).is_empty());
    }

    #[test]
    fn failpoint_observer_runs_before_the_step() {
        let seen = std::rc::Rc::new(std::cell::Cell::new(0));
        let counter = seen.clone();
        failpoint::observe("x.step", Box::new(move || counter.set(counter.get() + 1)));
        failpoint::arm("x.step");
        assert!(failpoint::check("x.step").is_err());
        failpoint::check("x.other").unwrap();
        assert_eq!(seen.get(), 1);
        failpoint::disarm_all();
        failpoint::check("x.step").unwrap();
        assert_eq!(seen.get(), 1);
    }

    #[test]
    fn failpoint_is_disarmed_by_default() {
        failpoint::check("atomic_write.before_replace").unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn retry_succeeds_after_transient_sharing_violation() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = TempDir::new();
        let target = dir.path().join("t");
        let from = dir.path().join("f");
        std::fs::write(&target, b"old").unwrap();
        std::fs::write(&from, b"new").unwrap();
        let (opened_tx, opened_rx) = std::sync::mpsc::channel();
        let (probed_tx, probed_rx) = std::sync::mpsc::channel::<()>();
        let holder_path = target.clone();
        let holder = std::thread::spawn(move || {
            // Share read + write but not delete, so replacing the file fails.
            let _held = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(1 | 2)
                .open(holder_path)
                .unwrap();
            opened_tx.send(()).unwrap();
            // Start the hold only once the main thread has seen the refusal.
            probed_rx.recv().unwrap();
            std::thread::sleep(Duration::from_millis(100));
        });
        opened_rx.recv().unwrap();
        // A single attempt really is refused while the file is held ...
        assert!(sys::replace_file(&from, &target).is_err());
        probed_tx.send(()).unwrap();
        // ... and the retrying version gets through once it is released.
        replace_file(&from, &target).unwrap();
        holder.join().unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
    }

    #[test]
    fn retry_backoff_doubles_and_caps() {
        let mut waits = Vec::new();
        let mut calls = 0;
        let result: std::io::Result<()> = retry_with(
            || {
                calls += 1;
                Err(std::io::Error::from_raw_os_error(32))
            },
            |d| waits.push(d),
        );
        assert!(result.is_err());
        // On non-Windows, 32 is some other error and is not retried.
        if cfg!(windows) {
            assert_eq!(calls, 10);
            let ms: Vec<u128> = waits.iter().map(|d| d.as_millis()).collect();
            assert_eq!(ms, [20, 40, 80, 160, 320, 640, 1000, 1000, 1000]);
        } else {
            assert_eq!(calls, 1);
        }
    }

    #[test]
    fn retry_does_not_retry_other_errors() {
        let mut calls = 0;
        let result: std::io::Result<()> = retry_with(
            || {
                calls += 1;
                Err(std::io::Error::from(std::io::ErrorKind::NotFound))
            },
            |_: Duration| panic!("must not wait"),
        );
        assert!(result.is_err());
        assert_eq!(calls, 1);
    }

    /// Counts its gate calls and says whether one is running.
    #[derive(Default)]
    struct Gate {
        calls: std::cell::Cell<u32>,
        inside: std::cell::Cell<bool>,
        refuse: bool,
    }

    impl crate::blob::OutputJournal for Gate {
        fn record(&self, _temp: &Path) -> Result<()> {
            Ok(())
        }
        fn clear(&self, _temp: &Path) {}
        fn publish(&self, attempt: &mut dyn FnMut() -> Result<()>) -> Result<()> {
            self.calls.set(self.calls.get() + 1);
            if self.refuse {
                return Err(CoreError::Cancelled);
            }
            self.inside.set(true);
            let result = attempt();
            self.inside.set(false);
            result
        }
    }

    /// The rename fails with a sharing violation twice, then works: the journal's gate runs
    /// once per attempt, and every wait comes between gate calls, never inside one.
    #[test]
    fn publish_called_once_per_attempt() {
        use crate::blob::OutputJournal;
        let journal = Gate::default();
        let (mut renames, mut waits) = (0, 0);
        let result = retry_gated(
            || {
                renames += 1;
                match renames {
                    1 | 2 => Err(std::io::Error::from_raw_os_error(32)),
                    _ => Ok(()),
                }
            },
            |attempt| journal.publish(attempt),
            |_| {
                assert!(!journal.inside.get(), "a wait inside publish");
                waits += 1;
            },
        );
        // On non-Windows, 32 is some other error and is not retried.
        if cfg!(windows) {
            result.unwrap();
            assert_eq!((journal.calls.get(), renames, waits), (3, 3, 2));
        } else {
            assert!(matches!(result, Err(CoreError::Io(_))));
            assert_eq!((journal.calls.get(), renames, waits), (1, 1, 0));
        }
    }

    /// A gate's own refusal is not retried, and the rename never runs.
    #[test]
    fn publish_refusal_stops_the_retries() {
        use crate::blob::OutputJournal;
        let journal = Gate {
            refuse: true,
            ..Gate::default()
        };
        let mut renames = 0;
        let result = retry_gated(
            || {
                renames += 1;
                Ok(())
            },
            |attempt| journal.publish(attempt),
            |_: Duration| panic!("must not wait"),
        );
        assert!(matches!(result, Err(CoreError::Cancelled)));
        assert_eq!((journal.calls.get(), renames), (1, 0));
    }

    #[test]
    fn remove_clears_readonly() {
        let dir = TempDir::new();
        let file = dir.path().join("ro");
        std::fs::write(&file, b"x").unwrap();
        let mut perms = std::fs::metadata(&file).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&file, perms).unwrap();
        remove_file_retry(&file).unwrap();
        assert!(!file.exists());
    }

    #[test]
    fn remove_missing_file_is_ok() {
        let dir = TempDir::new();
        remove_file_retry(&dir.path().join("nope")).unwrap();
    }

    const MIB: u64 = 1024 * 1024;
    const GIB: u64 = 1024 * MIB;

    #[test]
    fn check_space_rules() {
        let fat32 = VolumeInfo {
            free_bytes: Some(100 * GIB),
            max_file_bytes: Some(4 * GIB - 1),
        };
        assert!(matches!(
            check_space(0, 4 * GIB, &fat32),
            Err(CoreError::FileSystemLimit { max_file }) if max_file == 4 * GIB - 1
        ));
        check_space(0, 4 * GIB - 1, &fat32).unwrap();

        let small = VolumeInfo {
            free_bytes: Some(100 * MIB),
            max_file_bytes: None,
        };
        assert!(matches!(
            check_space(50 * MIB, 0, &small),
            Err(CoreError::NotEnoughSpace { needed, available })
                if needed == 50 * MIB && available == 100 * MIB
        ));
        check_space(36 * MIB, 0, &small).unwrap(); // needed + margin == free exactly

        let unknown = VolumeInfo {
            free_bytes: None,
            max_file_bytes: None,
        };
        check_space(u64::MAX, u64::MAX, &unknown).unwrap();
    }

    #[test]
    fn volume_info_override_wins() {
        let fake = VolumeInfo {
            free_bytes: Some(7),
            max_file_bytes: Some(9),
        };
        set_volume_override(Some(fake));
        let got = volume_info(Path::new("."));
        set_volume_override(None);
        assert_eq!(got.unwrap(), fake);
    }

    #[cfg(windows)]
    #[test]
    fn volume_info_on_temp_dir() {
        let info = volume_info(&std::env::temp_dir()).unwrap();
        assert!(info.free_bytes.is_some_and(|b| b > 0));
    }

    #[test]
    fn rename_dir_no_replace_refuses_existing() {
        let dir = TempDir::new();
        let (from, to) = (dir.path().join("from"), dir.path().join("to"));
        std::fs::create_dir(&from).unwrap();
        std::fs::create_dir(&to).unwrap();
        std::fs::write(from.join("a"), b"a").unwrap();
        std::fs::write(to.join("b"), b"b").unwrap();
        assert!(matches!(
            rename_dir_no_replace(&from, &to),
            Err(CoreError::InvalidInput {
                what: "destination exists"
            })
        ));
        assert_eq!(std::fs::read(from.join("a")).unwrap(), b"a");
        assert_eq!(std::fs::read(to.join("b")).unwrap(), b"b");
    }

    #[test]
    fn rename_dir_no_replace_moves_folder() {
        let dir = TempDir::new();
        let (from, to) = (dir.path().join("from"), dir.path().join("to"));
        std::fs::create_dir(&from).unwrap();
        std::fs::write(from.join("a"), b"a").unwrap();
        rename_dir_no_replace(&from, &to).unwrap();
        assert!(!from.exists());
        assert_eq!(std::fs::read(to.join("a")).unwrap(), b"a");
    }

    #[test]
    fn hidden_temp_has_requested_name_and_is_new() {
        let dir = TempDir::new();
        let (_f, path) = create_hidden_temp(dir.path(), ".tmp").unwrap();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with('.') && name.ends_with(".tmp"));
        assert_eq!(name.len(), 1 + 16 + 4);
        assert_eq!(path.parent().unwrap(), dir.path());
        // `create_new`: an existing file is never reused.
        assert!(sys::create_hidden(&path).is_err());
    }

    #[test]
    fn sync_dir_works_on_a_folder_and_fails_on_a_missing_one() {
        let dir = TempDir::new();
        sync_dir(dir.path()).unwrap();
        assert!(sync_dir(&dir.path().join("missing")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn set_hidden_hides_a_folder_and_keeps_other_attributes() {
        use std::os::windows::fs::MetadataExt;
        let dir = TempDir::new();
        let folder = dir.path().join("staging");
        std::fs::create_dir(&folder).unwrap();
        set_hidden(&folder).unwrap();
        let attrs = std::fs::metadata(&folder).unwrap().file_attributes();
        assert_ne!(attrs & 0x2, 0, "not hidden");
        assert_ne!(attrs & 0x10, 0, "directory bit lost");
        clear_hidden(&folder).unwrap();
        assert_eq!(
            std::fs::metadata(&folder).unwrap().file_attributes() & 0x2,
            0
        );
    }

    #[cfg(windows)]
    #[test]
    fn atomic_write_result_is_not_hidden() {
        use std::os::windows::fs::MetadataExt;
        let hidden = |p: &Path| std::fs::metadata(p).unwrap().file_attributes() & 0x2 != 0;
        let dir = TempDir::new();
        let target = dir.path().join("vault.json");
        atomic_write(&target, b"new target").unwrap();
        assert!(!hidden(&target), "new target is hidden");
        atomic_write(&target, b"replaced").unwrap();
        assert!(!hidden(&target), "replaced target is hidden");
    }

    #[cfg(windows)]
    #[test]
    fn clear_hidden_keeps_other_attributes() {
        use std::os::windows::fs::MetadataExt;
        let dir = TempDir::new();
        let (f, path) = create_hidden_temp(dir.path(), ".tmp").unwrap();
        drop(f);
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&path, perms).unwrap();
        clear_hidden(&path).unwrap();
        let attrs = std::fs::metadata(&path).unwrap().file_attributes();
        assert_eq!(attrs & 0x2, 0, "still hidden");
        assert_ne!(attrs & 0x1, 0, "read-only bit lost");
        remove_file_retry(&path).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn temp_is_hidden() {
        use std::os::windows::fs::MetadataExt;
        let dir = TempDir::new();
        let (f, _path) = create_hidden_temp(dir.path(), ".tmp").unwrap();
        let attrs = f.metadata().unwrap().file_attributes();
        assert_ne!(attrs & 0x2, 0, "FILE_ATTRIBUTE_HIDDEN not set");
    }
}
