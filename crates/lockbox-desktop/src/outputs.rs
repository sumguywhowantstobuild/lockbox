//! The output journal (spec §7.2): every temporary plaintext file Lockbox creates is written down in
//! `pending-outputs.json`, in the state folder, before it exists, and forgotten once it is gone. At launch the
//! leftovers of a crash or power cut are swept by strict rules, so a tampered journal never makes Lockbox delete
//! anything it did not make.
//!
//! `{ "version": 1, "entries": ["<absolute path>", ..] }`: temp paths and "Open" folders only, never an original file
//! name (R5). Read and written like the other state files ([`read_state`], [`write_state`]), one change at a time.

use std::cell::RefCell;
use std::ffi::OsStr;
use std::fs::{self, Metadata};
use std::io;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use lockbox_core::blob::OutputJournal;
use lockbox_core::fsio::{is_destination_taken, rename_file_no_replace};
use lockbox_core::{CoreError, Result as CoreResult};
use serde::{Deserialize, Serialize};

use crate::error::{ShellError, ShellResult};
use crate::lock;
use crate::os::{Volumes, same_path, win};
use crate::paths::{StatePaths, StateVersion, read_state, write_state};
use crate::session::{SessionId, Sessions};

/// What `pending-outputs.json` is called in errors. While it is damaged every decrypted output is refused
/// (`Core(Damaged { what: "output journal" })`) until [`Outputs::reset`] sets it aside.
pub const WHAT: &str = "output journal";

/// What the engine is told when the shell itself stopped an output step (the journal could not be written, the
/// session locked); the command answers the shell's refusal instead ([`CallJournal::finish`]).
const REFUSED: CoreError = CoreError::Cancelled;

/// The engine's temp names: `.<16 lowercase hex>` and one of these.
const TEMP_SUFFIXES: [&str; 2] = [".lockbox-partial", ".lockbox-backup-partial"];

/// How many damaged journals [`Outputs::reset`] keeps beside the new one: `pending-outputs.json.damaged-1` to `-99`.
const MAX_SET_ASIDE: u32 = 99;

/// `FILE_ATTRIBUTE_REPARSE_POINT`: a link, a junction, a mount point or a cloud placeholder.
const REPARSE_POINT: u32 = 0x400;
/// `FILE_ATTRIBUTE_DIRECTORY`, which a junction to a folder has too.
const DIRECTORY: u32 = 0x10;

/// The sweep's delete attempts, as the engine retries its own: at most 10, while another program briefly holds the
/// leftover (a sharing violation or access denied), waiting 20 ms and doubling, at most 1 s, between them.
pub(crate) const DELETE_TRIES: u32 = 10;
const FIRST_WAIT: Duration = Duration::from_millis(20);
const MAX_WAIT: Duration = Duration::from_secs(1);

/// What the launch sweep did: leftovers removed, entries kept for a later launch (a drive not connected, a leftover
/// that could not be removed yet), and whether the journal could not be read (nothing was removed then).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct SweepReport {
    pub removed: usize,
    pub kept: usize,
    pub unreadable: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct JournalFile {
    version: StateVersion,
    entries: Vec<PathBuf>,
}

/// The output journal. Each change reads the file, changes it and writes it back while holding the journal's own
/// lock, which is taken under a vault's lock (an export records while it reads its vault), never the other way round.
pub struct Outputs {
    file: PathBuf,
    /// The state folder's `open\` folder, where "Open" copies live ([`OpenFolders`](crate::open::OpenFolders)), as
    /// Lockbox computes it from the known folder: never a resolved copy of a folder that may lead elsewhere.
    open: PathBuf,
    volumes: Arc<dyn Volumes>,
    edits: Mutex<()>,
    #[cfg(test)]
    hooks: TestHooks,
}

/// Tests only: told how each publish attempt went.
#[cfg(test)]
type AttemptHook = Box<dyn Fn(Attempt) + Send + Sync>;

/// Tests only: run once at a step, with the path it is about to use.
#[cfg(test)]
type PathHook = Box<dyn FnOnce(&Path) + Send>;

/// Tests only: steps a test watches or acts in.
#[cfg(test)]
#[derive(Default)]
struct TestHooks {
    /// Told the outcome of each publish attempt, as soon as the attempt has returned.
    on_attempt: Mutex<Option<AttemptHook>>,
    /// Run once, after a delete attempt of the sweep has failed and before the next one.
    on_retry: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    /// Run once, right before reset moves the journal to the name it is given.
    on_set_aside: Mutex<Option<PathHook>>,
}

/// Tests only: how one publish attempt went.
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Attempt {
    /// The rename ran and failed, with this OS error.
    Failed(Option<i32>),
    Renamed,
    /// The session's publish gate refused it: the rename never ran.
    Refused,
}

/// What the sweep does with one entry.
enum Swept {
    /// Lockbox's leftover, deleted: dropped from the journal.
    Removed,
    /// Kept for a later launch: its drive is not connected, or it could not be removed yet.
    Kept,
    /// Not Lockbox's, or already gone: dropped from the journal, nothing deleted.
    Dropped,
}

impl Outputs {
    pub fn new(paths: &StatePaths, volumes: Arc<dyn Volumes>) -> Outputs {
        Outputs {
            file: paths.outputs.clone(),
            open: paths.open.clone(),
            volumes,
            edits: Mutex::default(),
            #[cfg(test)]
            hooks: TestHooks::default(),
        }
    }

    /// Tests only: `hook` is told how each publish attempt went, as soon as it has returned.
    #[cfg(test)]
    pub(crate) fn on_attempt(&self, hook: AttemptHook) {
        *lock(&self.hooks.on_attempt) = Some(hook);
    }

    /// Tests only: tells the `on_attempt` hook how a publish attempt went.
    #[cfg(test)]
    fn attempted(&self, attempt: Attempt) {
        if let Some(hook) = lock(&self.hooks.on_attempt).as_ref() {
            hook(attempt);
        }
    }

    /// Tests only: runs `hook` once, after a failed delete attempt of the sweep and before the next.
    #[cfg(test)]
    pub(crate) fn on_retry(&self, hook: Box<dyn FnOnce() + Send>) {
        *lock(&self.hooks.on_retry) = Some(hook);
    }

    /// Tests only: runs `hook` once, right before reset moves the journal to the name it is given.
    #[cfg(test)]
    pub(crate) fn on_set_aside(&self, hook: PathHook) {
        *lock(&self.hooks.on_set_aside) = Some(hook);
    }

    /// The journal for one output (a decrypted copy, a backup) made from the session `session` in `generation`: it
    /// records the engine's temp before it exists, and runs each publish attempt only while the session is still
    /// unlocked in `generation` ([`Sessions::publish`]).
    pub fn for_call<'a>(
        &'a self,
        sessions: &'a Sessions,
        session: SessionId,
        generation: u64,
    ) -> CallJournal<'a> {
        CallJournal {
            outputs: self,
            sessions,
            session,
            generation,
            recorded: RefCell::default(),
            refusal: RefCell::default(),
        }
    }

    /// Refuses decrypted output while the journal cannot be read (damaged: `Core(Damaged { what: "output journal"
    /// })`), so a command can say so before it opens a dialog.
    pub fn usable(&self) -> ShellResult<()> {
        let _edit = lock(&self.edits);
        self.load().map(drop)
    }

    /// The entries on disk; none when there is no journal yet.
    fn load(&self) -> ShellResult<Vec<PathBuf>> {
        let journal = read_state::<JournalFile>(&self.file, WHAT)?;
        Ok(journal.map_or_else(Vec::new, |journal| journal.entries))
    }

    fn save(&self, entries: Vec<PathBuf>) -> ShellResult<()> {
        let journal = JournalFile {
            version: StateVersion,
            entries,
        };
        write_state(&self.file, &journal, WHAT)
    }

    /// Writes the engine's `temp` down before it exists, its folder canonical (links, junctions and short names
    /// resolved), and returns the path written. Any failure (a damaged journal, a write that fails) is returned, and
    /// the engine then never creates the temp.
    fn record(&self, temp: &Path) -> ShellResult<PathBuf> {
        let (Some(name), Some(folder)) = (temp.file_name(), temp.parent()) else {
            return Err(ShellError::InvalidInput { what: "file name" });
        };
        let written = fs::canonicalize(folder)?.join(name);
        let _edit = lock(&self.edits);
        let mut entries = self.load()?;
        if !entries.iter().any(|entry| same_path(entry, &written)) {
            entries.push(written.clone());
        }
        self.save(entries)?;
        Ok(written)
    }

    /// Writes the new "Open" folder `folder` down before it exists, spelled exactly as given: `open\<32 hex>` as
    /// Lockbox computes it, never resolved, or the sweep would drop the entry. Any failure is returned, and then the
    /// folder is never made.
    pub(crate) fn record_open(&self, folder: &Path) -> ShellResult<()> {
        let _edit = lock(&self.edits);
        let mut entries = self.load()?;
        entries.push(folder.to_path_buf());
        self.save(entries)
    }

    /// Whether the sweep's rules could remove a folder in `open\`: its path is plain and no link leads to it.
    pub(crate) fn open_folder_is_plain(&self) -> bool {
        plain_root(&self.open)
            .is_some_and(|root| matches!(no_link_below(&root, &self.open), Checked::Delete { .. }))
    }

    /// Whether a folder in `open\` keeps the permissions it is made with: only on NTFS, the file system vaults also
    /// need. Elsewhere Windows may accept them and ignore them.
    pub(crate) fn open_folder_keeps_permissions(&self) -> bool {
        fs::canonicalize(&self.open)
            .and_then(|open| self.volumes.volume_root(&open))
            .and_then(|root| self.volumes.file_system(&root))
            .is_ok_and(|file_system| file_system.eq_ignore_ascii_case("NTFS"))
    }

    /// The folders directly inside `open\` that are certainly of Lockbox's making, by what is on disk and not by the
    /// journal: each named exactly 32 lowercase hex and, by its own metadata, a plain folder. Files, other names and
    /// links are not listed. None when `open\` is missing or a link leads to it. Each still passes the sweep's full
    /// check before each delete ([`remove_open`](Self::remove_open)).
    pub(crate) fn open_folders_on_disk(&self) -> Vec<PathBuf> {
        if !self.open_folder_is_plain() {
            return Vec::new();
        }
        let Ok(inside) = fs::read_dir(&self.open) else {
            return Vec::new();
        };
        inside
            .flatten()
            .filter(|item| {
                // A `DirEntry`'s metadata is the item's own on Windows, never what a link leads to.
                item.file_name().to_str().is_some_and(is_open_name)
                    && item.metadata().is_ok_and(|meta| plain(&meta, true))
            })
            .map(|item| self.open.join(item.file_name()))
            .collect()
    }

    /// The "Open" folders the journal lists: after the launch sweep, those it could not remove yet.
    pub(crate) fn open_entries(&self) -> Vec<PathBuf> {
        let _edit = lock(&self.edits);
        let mut entries = self.load().unwrap_or_default();
        entries.retain(|entry| {
            let name = entry.file_name().and_then(OsStr::to_str);
            name.is_some_and(is_open_name) && entry.parent().is_some_and(|dir| self.is_open(dir))
        });
        entries
    }

    /// Removes the "Open" folder `folder` by the sweep's rules in at most `tries` attempts ([`DELETE_TRIES`] can take
    /// seconds), and forgets it unless it is kept (it could not be removed yet, or its drive is not there): whether it
    /// is done with. The journal's lock is not held meanwhile.
    pub(crate) fn remove_open(&self, folder: &Path, tries: u32) -> bool {
        match self.sweep_one(folder, tries) {
            Swept::Kept => false,
            Swept::Removed | Swept::Dropped => {
                self.clear(folder);
                true
            }
        }
    }

    /// Forgets `written`, once its temp or "Open" folder is gone. Never panics (the engine may call it while
    /// unwinding): when the journal cannot be read or written, the entry stays, and the next launch's sweep finds
    /// nothing there and drops it. Nothing is logged.
    pub(crate) fn clear(&self, written: &Path) {
        let _edit = lock(&self.edits);
        let Ok(mut entries) = self.load() else {
            return;
        };
        let before = entries.len();
        entries.retain(|entry| !same_path(entry, written));
        if entries.len() != before {
            let _ = self.save(entries);
        }
    }

    /// The launch sweep (spec §7.2): deletes the leftovers the journal lists that are certainly Lockbox's, and only
    /// those. An entry is deleted only when all of these hold, checked again right before every delete attempt:
    /// - its text is an absolute path on a local drive (`C:\`, `\\?\C:\`) or a share (`\\?\UNC\server\share\`),
    ///   then plain names only: no `.`, `..` or empty part, refused as written, before anything normalises it;
    /// - it is an "Open" folder (its name 32 lowercase hex, directly inside `open\` as Lockbox spells it from the
    ///   known folder), or an engine temp (`.<16 lowercase hex>.lockbox-partial` or `.lockbox-backup-partial`) whose
    ///   folder, resolved, is the folder written down;
    /// - no folder on its way, from the drive or share down (the state folder and the folders above it included), is
    ///   a link, a junction or a mount point (a cloud-file folder, whose reparse point keeps it in place, passes);
    /// - it is, by its own metadata, a plain folder or a plain file: no reparse point of any kind.
    ///
    /// Anything else is dropped from the journal and left on disk; an entry on a drive that is not connected, or that
    /// could not be removed, is kept for the next launch. A journal that cannot be read removes nothing and stays as
    /// it is (`unreadable`).
    pub fn sweep(&self) -> SweepReport {
        let _edit = lock(&self.edits);
        let Ok(entries) = self.load() else {
            return SweepReport {
                unreadable: true,
                ..SweepReport::default()
            };
        };
        if entries.is_empty() {
            return SweepReport::default();
        }
        let mut report = SweepReport::default();
        let mut kept = Vec::new();
        for entry in entries {
            match self.sweep_one(&entry, DELETE_TRIES) {
                Swept::Removed => report.removed += 1,
                Swept::Kept => kept.push(entry),
                Swept::Dropped => {}
            }
        }
        report.kept = kept.len();
        // If this write fails, the next launch sweeps the same list: what was removed is then gone, and dropped.
        let _ = self.save(kept);
        report
    }

    /// One entry of the sweep: every delete attempt, retries included, comes right after a full check of its own, so
    /// a folder swapped for a link between two attempts stops the next one.
    fn sweep_one(&self, entry: &Path, tries: u32) -> Swept {
        let mut wait = FIRST_WAIT;
        for attempt in 1..=tries {
            let folder = match self.check(entry) {
                Checked::Delete { folder } => folder,
                Checked::Keep => return Swept::Kept,
                Checked::Drop => return Swept::Dropped,
            };
            match delete_once(entry, folder) {
                Ok(()) => return Swept::Removed,
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Swept::Dropped,
                Err(e) if attempt < tries && is_transient(&e) => {
                    #[cfg(test)]
                    if let Some(hook) = lock(&self.hooks.on_retry).take() {
                        hook();
                    }
                    thread::sleep(wait);
                    wait = (wait * 2).min(MAX_WAIT);
                }
                Err(_) => return Swept::Kept,
            }
        }
        Swept::Kept
    }

    /// Whether `entry` may be deleted now (see [`sweep`](Self::sweep)), and whether it is a folder.
    fn check(&self, entry: &Path) -> Checked {
        let Some(root) = plain_root(entry) else {
            return Checked::Drop;
        };
        let (Some(name), Some(folder)) =
            (entry.file_name().and_then(OsStr::to_str), entry.parent())
        else {
            return Checked::Drop;
        };
        let is_folder = match (
            is_open_name(name) && self.is_open(folder),
            is_temp_name(name),
        ) {
            (true, _) => true,
            (false, true) => false,
            (false, false) => return Checked::Drop,
        };
        if !matches!(self.volumes.exists(&root), Ok(true)) {
            return Checked::Keep;
        }
        match no_link_below(&root, folder) {
            Checked::Delete { .. } => {}
            not_safe => return not_safe,
        }
        // A temp is written down with its folder resolved; one spelled any other way is not Lockbox's.
        if !is_folder && !fs::canonicalize(folder).is_ok_and(|real| same_path(&real, folder)) {
            return Checked::Drop;
        }
        match fs::symlink_metadata(entry) {
            Ok(meta) if plain(&meta, is_folder) => Checked::Delete { folder: is_folder },
            Err(e) if e.kind() != io::ErrorKind::NotFound => Checked::Keep,
            // Not a plain file or folder, or already gone.
            _ => Checked::Drop,
        }
    }

    /// Whether `folder` is the `open\` folder as Lockbox spells it (or that same text in its verbatim form).
    fn is_open(&self, folder: &Path) -> bool {
        same_path(folder, &self.open)
            || verbatim(&self.open).is_some_and(|open| same_path(folder, &open))
    }

    /// Sets a damaged journal aside, as `pending-outputs.json.damaged-<n>` (the first free `n` from 1 to 99), so
    /// decrypted output works again; its temps are no longer swept (its "Open" folders are: each launch lists `open\`,
    /// [`open_folders_on_disk`](Self::open_folders_on_disk)). Each move never replaces anything (the
    /// engine's no-replace move: one step, so a file that appears at that name is never overwritten); a name that is
    /// taken moves on to the next. A journal that reads fine (or none) is left as it is. `TooLarge` once all 99 names
    /// are taken.
    pub fn reset(&self) -> ShellResult<()> {
        let _edit = lock(&self.edits);
        if self.load().is_ok() {
            return Ok(());
        }
        for n in 1..=MAX_SET_ASIDE {
            let mut aside = self.file.clone().into_os_string();
            aside.push(format!(".damaged-{n}"));
            #[cfg(test)]
            if let Some(hook) = lock(&self.hooks.on_set_aside).take() {
                hook(Path::new(&aside));
            }
            match rename_file_no_replace(&self.file, Path::new(&aside)) {
                Ok(()) => return Ok(()),
                Err(e) if is_destination_taken(&e) => {}
                Err(e) => return Err(e.into()),
            }
        }
        Err(ShellError::TooLarge {
            what: "damaged output journals",
        })
    }
}

/// Whether a check lets the sweep delete an entry, keep it for later, or drop it.
#[derive(Debug, PartialEq, Eq)]
enum Checked {
    Delete { folder: bool },
    Keep,
    Drop,
}

/// One delete attempt, without retrying: an "Open" folder and everything in it (std's removal does not follow links
/// inside it), or a temp, its read-only flag cleared first. A copy in the folder gets its flag back when the attempt
/// fails: while a viewer holds it, it stays read-only.
fn delete_once(entry: &Path, folder: bool) -> io::Result<()> {
    if folder {
        let cleared = clear_read_only_inside(entry);
        let removed = fs::remove_dir_all(entry);
        if removed.is_err() {
            for file in cleared {
                let _ = set_read_only(&file, true);
            }
        }
        return removed;
    }
    set_read_only(entry, false)?;
    fs::remove_file(entry)
}

/// Clears the read-only flag of each plain file directly in `folder` (an opened copy): the files whose flag it cleared.
fn clear_read_only_inside(folder: &Path) -> Vec<PathBuf> {
    let Ok(inside) = fs::read_dir(folder) else {
        return Vec::new();
    };
    inside
        .flatten()
        .filter(|item| {
            // A `DirEntry`'s metadata is the item's own on Windows: a link is never a plain file here.
            item.metadata()
                .is_ok_and(|meta| meta.is_file() && meta.permissions().readonly())
        })
        .map(|item| item.path())
        .filter(|file| set_read_only(file, false).is_ok())
        .collect()
}

/// Sets `file`'s read-only flag as asked, when it is not so already.
pub(crate) fn set_read_only(file: &Path, read_only: bool) -> io::Result<()> {
    let mut permissions = fs::symlink_metadata(file)?.permissions();
    if permissions.readonly() != read_only {
        // On Windows this changes only the read-only attribute (the lint's worry is Unix modes).
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(read_only);
        fs::set_permissions(file, permissions)?;
    }
    Ok(())
}

/// Windows' sharing violation and access denied, when another program holds the leftover for a moment, and folder not
/// empty, when a file appeared in an "Open" folder during its removal (the temp of an open a lock has just cancelled,
/// which is gone a moment later).
fn is_transient(e: &io::Error) -> bool {
    matches!(e.raw_os_error(), Some(32 | 5 | 145))
}

/// Checks the drive or share `root` itself, then each folder below it down to `folder`: `Delete` when none leads
/// elsewhere, `Drop` when one is a link, a junction or a mount point (a name-surrogate reparse point, its tag read from
/// the folder itself: [`win::is_redirect`]) or is not a folder or not there (nothing below it is either). A folder
/// below the root that cannot be read keeps the entry (`Keep`); a root that cannot be read drops it. A folder whose
/// reparse point keeps it in place (a cloud-file folder such as OneDrive's) passes.
fn no_link_below(root: &Path, folder: &Path) -> Checked {
    no_link_on_the_way(&Disk, root, folder)
}

/// How the folders on an entry's way are read: from the disk ([`Disk`]), or by a test's fake (a drive or share root
/// that is a link cannot be made without admin rights).
trait FolderProbe {
    /// The item's own attributes (`symlink_metadata`: never what it leads to).
    fn attributes(&self, at: &Path) -> io::Result<u32>;
    /// Whether the item leads elsewhere ([`win::is_redirect`]); asked only of a reparse point.
    fn redirects(&self, at: &Path) -> io::Result<bool>;
}

struct Disk;

impl FolderProbe for Disk {
    fn attributes(&self, at: &Path) -> io::Result<u32> {
        Ok(fs::symlink_metadata(at)?.file_attributes())
    }

    fn redirects(&self, at: &Path) -> io::Result<bool> {
        win::is_redirect(at)
    }
}

/// [`no_link_below`] through `probe`.
fn no_link_on_the_way(probe: &dyn FolderProbe, root: &Path, folder: &Path) -> Checked {
    let Ok(rest) = folder.strip_prefix(root) else {
        return Checked::Drop;
    };
    // The drive or share root first, as strictly: one that is a link, or cannot be read, drops the entry.
    if let Some(stop) = folder_stops(probe, root, Checked::Drop) {
        return stop;
    }
    let mut at = root.to_path_buf();
    for part in rest.iter() {
        at.push(part);
        if let Some(stop) = folder_stops(probe, &at, Checked::Keep) {
            return stop;
        }
    }
    Checked::Delete { folder: true }
}

/// What the folder `at` says about the way through it: nothing (`None`) when it is a folder that leads nowhere else;
/// `Drop` when it leads elsewhere, is not a folder or is not there; `unreadable` when it cannot be read.
fn folder_stops(probe: &dyn FolderProbe, at: &Path, unreadable: Checked) -> Option<Checked> {
    let attributes = match probe.attributes(at) {
        Ok(attributes) => attributes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Some(Checked::Drop),
        Err(_) => return Some(unreadable),
    };
    if attributes & DIRECTORY == 0 {
        return Some(Checked::Drop);
    }
    if attributes & REPARSE_POINT == 0 {
        return None;
    }
    match probe.redirects(at) {
        Ok(false) => None,
        Ok(true) => Some(Checked::Drop),
        Err(_) => Some(unreadable),
    }
}

/// `path` in its verbatim form (`\\?\C:\..`) when it is a plain drive path (`C:\..`), as text only: nothing resolved.
fn verbatim(path: &Path) -> Option<PathBuf> {
    let text = path.to_str()?;
    let bytes = text.as_bytes();
    let drive = bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && &bytes[1..3] == br":\";
    drive.then(|| PathBuf::from(format!(r"\\?\{text}")))
}

/// The root of the drive or share `path` is on (`C:\`, `\\?\C:\`, `\\?\UNC\server\share\`), when the text of
/// `path` is that root followed by plain names only: no `.`, `..` or empty part (a doubled or trailing separator), no
/// `/`. Read from the text as written, never through `Path::components`, which drops a `.` in the middle. `None` for
/// anything else: a relative or drive-relative path, a plain `\\server\share` or device path, a bare root.
fn plain_root(path: &Path) -> Option<PathBuf> {
    let text = path.to_str()?;
    if text.contains('/') {
        return None;
    }
    let plain = |part: &str| !part.is_empty() && part != "." && part != "..";
    let (root, rest) = if let Some(share) = text.strip_prefix(r"\\?\UNC\") {
        let mut parts = share.splitn(3, '\\');
        let (server, name, rest) = (parts.next()?, parts.next()?, parts.next()?);
        if !plain(server) || !plain(name) {
            return None;
        }
        (format!(r"\\?\UNC\{server}\{name}\"), rest)
    } else {
        let (verbatim, drive) = match text.strip_prefix(r"\\?\") {
            Some(drive) => (r"\\?\", drive),
            None => ("", text),
        };
        let bytes = drive.as_bytes();
        if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || &bytes[1..3] != br":\" {
            return None;
        }
        (format!("{verbatim}{}", &drive[..3]), &drive[3..])
    };
    (!rest.is_empty() && rest.split('\\').all(plain)).then(|| PathBuf::from(root))
}

fn is_lower_hex(text: &str, len: usize) -> bool {
    text.len() == len && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// An "Open" folder's name: 32 lowercase hex.
fn is_open_name(name: &str) -> bool {
    is_lower_hex(name, 32)
}

/// An engine temp's name: `^\.[0-9a-f]{16}\.lockbox(-backup)?-partial$`.
fn is_temp_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix('.') else {
        return false;
    };
    TEMP_SUFFIXES.iter().any(|suffix| {
        rest.strip_suffix(suffix)
            .is_some_and(|hex| is_lower_hex(hex, 16))
    })
}

/// Whether `meta` (from `symlink_metadata`) is a plain folder (`folder`) or a plain file: no reparse point of any
/// kind.
fn plain(meta: &Metadata, folder: bool) -> bool {
    let kind = match folder {
        true => meta.is_dir(),
        false => meta.is_file(),
    };
    kind && meta.file_attributes() & REPARSE_POINT == 0
}

/// The journal of one output ([`Outputs::for_call`]). Used on the thread that makes the output.
pub struct CallJournal<'a> {
    outputs: &'a Outputs,
    sessions: &'a Sessions,
    session: SessionId,
    generation: u64,
    /// Each temp as the engine named it, with the path written down for it.
    recorded: RefCell<Vec<(PathBuf, PathBuf)>>,
    /// The shell's own refusal of a step, when one stopped the output.
    refusal: RefCell<Option<ShellError>>,
}

impl CallJournal<'_> {
    /// The engine's result as the command answers it: when the shell itself stopped the output (the journal could not
    /// be written, the session locked before a rename attempt), that refusal; otherwise the engine's own error.
    pub fn finish<T>(&self, result: CoreResult<T>) -> ShellResult<T> {
        let refusal = self.refusal.take();
        result.map_err(|error| refusal.unwrap_or_else(|| error.into()))
    }

    /// Keeps the first refusal for [`finish`](Self::finish), and tells the engine to stop.
    fn refuse(&self, error: ShellError) -> CoreError {
        self.refusal.borrow_mut().get_or_insert(error);
        REFUSED
    }
}

impl OutputJournal for CallJournal<'_> {
    fn record(&self, temp: &Path) -> CoreResult<()> {
        match self.outputs.record(temp) {
            Ok(written) => {
                self.recorded
                    .borrow_mut()
                    .push((temp.to_path_buf(), written));
                Ok(())
            }
            Err(error) => Err(self.refuse(error)),
        }
    }

    fn clear(&self, temp: &Path) {
        let written = self
            .recorded
            .try_borrow_mut()
            .ok()
            .and_then(|mut recorded| {
                let at = recorded.iter().position(|(engine, _)| engine == temp)?;
                Some(recorded.remove(at).1)
            });
        // A temp this journal never wrote down has nothing to clear.
        if let Some(written) = written {
            self.outputs.clear(&written);
        }
    }

    /// One rename attempt, under the session's publish guard and only while it is still unlocked in the output's
    /// generation: a lock waits for this one attempt at most, never for the engine's retries, and refuses the next.
    fn publish(&self, attempt: &mut dyn FnMut() -> CoreResult<()>) -> CoreResult<()> {
        let mut tried = None;
        let gate = self.sessions.publish(self.session, self.generation, || {
            let result = attempt();
            #[cfg(test)]
            self.outputs.attempted(match &result {
                Ok(()) => Attempt::Renamed,
                Err(CoreError::Io(e)) => Attempt::Failed(e.raw_os_error()),
                Err(_) => Attempt::Failed(None),
            });
            tried = Some(result);
            Ok(())
        });
        match gate {
            Ok(()) => tried.unwrap_or(Err(REFUSED)),
            Err(error) => {
                #[cfg(test)]
                self.outputs.attempted(Attempt::Refused);
                Err(self.refuse(error))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::fs::{self, OpenOptions};
    use std::os::windows::fs::OpenOptionsExt;
    use std::path::{Path, PathBuf};
    use std::rc::Rc;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use lockbox_core::CoreError;
    use lockbox_core::blob::OutputJournal;
    use lockbox_core::internals::fsio::testutil::{make_dir_link, names};
    use lockbox_core::internals::fsio::{failpoint, set_hidden};
    use serde_json::json;

    use super::*;
    use crate::error::{Outcome, ShellError};
    use crate::os::KnownFolder;
    use crate::session::VaultRef;
    use crate::testing::TestShell;

    /// Lockbox's own temp names, as the engine makes them.
    const TEMP: &str = ".0123456789abcdef.lockbox-partial";
    const BACKUP_TEMP: &str = ".fedcba9876543210.lockbox-backup-partial";
    /// An "Open" folder's name.
    const OPEN: &str = "0123456789abcdef0123456789abcdef";

    /// Always disarms, so a failing test cannot leak a failpoint into the next one on this thread.
    struct Cleanup;
    impl Drop for Cleanup {
        fn drop(&mut self) {
            failpoint::disarm_all();
        }
    }

    fn damaged() -> ShellError {
        CoreError::Damaged { what: WHAT }.into()
    }

    /// Writes the journal by hand, as a crash (or a tampering program) leaves it.
    fn write_journal(ts: &TestShell, entries: &[PathBuf]) {
        let paths = &ts.shell.paths;
        fs::create_dir_all(&paths.root).unwrap();
        let text = json!({ "version": 1, "entries": entries }).to_string();
        fs::write(&paths.outputs, text).unwrap();
    }

    /// The journal's entries, read straight from `file` (inside an engine step).
    fn entries_in(file: &Path) -> Vec<PathBuf> {
        let journal: serde_json::Value = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
        serde_json::from_value(journal["entries"].clone()).unwrap()
    }

    /// `.<16 lowercase hex><suffix>`.
    fn is_temp_named(path: &Path, suffix: &str) -> bool {
        let name = path.file_name().unwrap().to_str().unwrap();
        let Some(hex) = name
            .strip_prefix('.')
            .and_then(|rest| rest.strip_suffix(suffix))
        else {
            return false;
        };
        hex.len() == 16 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    }

    /// At the engine's step between the record and the temp's creation, for Save a copy and for a backup: the
    /// journal file already lists the temp (canonical, beside the destination), and the temp does not exist yet.
    #[test]
    fn record_before_temp_exists() {
        let _cleanup = Cleanup;
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let (id, file_id) = ts.stored_file(s, g, "report.pdf", b"report");
        let out = ts.folder("out");
        let seen = Rc::new(RefCell::new(Vec::new()));
        for step in ["export.after_record", "backup.after_record"] {
            let (seen, file) = (Rc::clone(&seen), ts.shell.paths.outputs.clone());
            failpoint::observe(
                step,
                Box::new(move || {
                    let entries = entries_in(&file);
                    let there: Vec<bool> = entries.iter().map(|e| e.exists()).collect();
                    seen.borrow_mut().push((step, entries, there));
                }),
            );
        }

        ts.dialogs.answer(Some(out.join("report copy.pdf")));
        let saved = ts.shell.save_file_copy(s, g, &id, &file_id).unwrap();
        assert!(matches!(saved.data, Outcome::Done(())));
        // A backup through the same journal (its command comes with restore, in a later task).
        let shell = &ts.shell;
        shell
            .sessions
            .read_long(s, g, |vault, cancel| {
                let VaultRef::Writable(vault) = vault else {
                    panic!("a writable vault");
                };
                let journal = shell.outputs.for_call(&shell.sessions, s, g);
                let backup = vault.backup(&out.join("family.lockbox-backup"), &journal, cancel);
                journal.finish(backup.map(drop))
            })
            .unwrap();

        let seen = seen.borrow();
        assert_eq!(seen.len(), 2, "both steps reached");
        let suffixes = [".lockbox-partial", ".lockbox-backup-partial"];
        for ((step, entries, there), suffix) in seen.iter().zip(suffixes) {
            assert_eq!(entries.len(), 1, "{step}: the temp is written down");
            assert!(is_temp_named(&entries[0], suffix), "{step}");
            assert_eq!(entries[0].parent(), Some(out.as_path()), "{step}");
            assert_eq!(there, &[false], "{step}: the temp does not exist yet");
        }
        assert_eq!(
            ts.journal(),
            Vec::<PathBuf>::new(),
            "cleared once published"
        );
        assert_eq!(fs::read(out.join("report copy.pdf")).unwrap(), b"report");
        assert!(out.join("family.lockbox-backup").is_file());
    }

    /// A stale temp of each kind and an "Open" folder holding read-only files: all removed, the journal emptied, and
    /// the page told once.
    #[test]
    fn sweep_removes_leftovers() {
        let ts = TestShell::new();
        let paths = &ts.shell.paths;
        let docs = ts.folder("Documents");
        let (temp, backup_temp) = (docs.join(TEMP), docs.join(BACKUP_TEMP));
        for leftover in [&temp, &backup_temp] {
            fs::write(leftover, b"plaintext").unwrap();
            set_hidden(leftover).unwrap();
        }
        let open = paths.open.join(OPEN);
        fs::create_dir_all(open.join("inner")).unwrap();
        for file in [
            open.join("statement.pdf"),
            open.join("inner").join("notes.txt"),
        ] {
            fs::write(&file, b"plaintext").unwrap();
            let mut read_only = fs::metadata(&file).unwrap().permissions();
            read_only.set_readonly(true);
            fs::set_permissions(&file, read_only).unwrap();
        }
        write_journal(&ts, &[temp.clone(), open.clone(), backup_temp.clone()]);

        let report = ts.shell.sweep_outputs();
        assert_eq!(
            report,
            SweepReport {
                removed: 3,
                kept: 0,
                unreadable: false
            }
        );
        for leftover in [&temp, &backup_temp, &open] {
            assert!(!leftover.exists(), "removed");
        }
        assert!(paths.open.is_dir(), "the \"Open\" folders' parent stays");
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
        let notice =
            json!({ "kind": "output_sweep", "removed": 3, "kept": 0, "unreadable": false });
        assert_eq!(ts.events.notices(), [notice]);
        // Nothing left: nothing to tell.
        assert_eq!(ts.shell.sweep_outputs(), SweepReport::default());
        assert_eq!(ts.events.notices().len(), 1);
    }

    /// Review Focus 4: a tampered journal. A user's file, a folder outside `open\` named like an "Open" folder, a
    /// junction named like one, a temp name reached through a junction in an ancestor, a path that climbs with `..`
    /// and a relative path: all still on disk afterwards, and dropped from the journal. Then an `open` folder that is
    /// itself a junction: what it leads to stays too.
    #[cfg(windows)]
    #[test]
    fn sweep_ignores_paths_it_did_not_make() {
        let ts = TestShell::new();
        let paths = &ts.shell.paths;
        let docs = ts.folder("Documents");
        let thesis = docs.join("thesis.docx");
        fs::write(&thesis, b"years of work").unwrap();
        let outside = docs.join(OPEN);
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("inside.txt"), b"mine").unwrap();
        let target = docs.join("target");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("kept.txt"), b"mine").unwrap();
        fs::create_dir_all(&paths.open).unwrap();
        let junction = paths.open.join("fedcba9876543210fedcba9876543210");
        make_dir_link(&junction, &target);
        let real = docs.join("real");
        fs::create_dir(&real).unwrap();
        fs::write(real.join(TEMP), b"mine").unwrap();
        let via = docs.join("via");
        make_dir_link(&via, &real);
        // A real temp-named file, named in the journal through `sub\..`.
        fs::write(docs.join(TEMP), b"mine").unwrap();
        fs::create_dir(docs.join("sub")).unwrap();
        let spelled = docs.to_string_lossy().replace(r"\\?\", "");
        let climbing = PathBuf::from(format!(r"{spelled}\sub\..\{TEMP}"));
        write_journal(
            &ts,
            &[
                thesis.clone(),
                outside.clone(),
                junction.clone(),
                via.join(TEMP),
                climbing,
                PathBuf::from(TEMP),
            ],
        );

        assert_eq!(ts.shell.sweep_outputs(), SweepReport::default());
        assert_eq!(fs::read(&thesis).unwrap(), b"years of work");
        assert!(outside.join("inside.txt").is_file());
        assert!(
            fs::symlink_metadata(&junction).is_ok(),
            "the junction stays"
        );
        assert!(target.join("kept.txt").is_file());
        assert!(real.join(TEMP).is_file());
        assert!(docs.join(TEMP).is_file());
        assert_eq!(ts.journal(), Vec::<PathBuf>::new(), "all dropped");

        // `open` itself a junction: whatever is behind it is not Lockbox's.
        fs::remove_dir(&junction).unwrap();
        fs::remove_dir(&paths.open).unwrap();
        let elsewhere = docs.join("elsewhere");
        fs::create_dir_all(elsewhere.join(OPEN)).unwrap();
        fs::write(elsewhere.join(OPEN).join("inside.txt"), b"mine").unwrap();
        make_dir_link(&paths.open, &elsewhere);
        write_journal(&ts, &[paths.open.join(OPEN)]);
        assert_eq!(ts.shell.sweep_outputs(), SweepReport::default());
        assert!(elsewhere.join(OPEN).join("inside.txt").is_file());
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    /// Fix round 1: the state folder itself a junction to the user's own folder, which holds `open\<32 hex>`: the
    /// entry, spelled as Lockbox spells the state folder, is dropped and what the junction leads to stays.
    #[cfg(windows)]
    #[test]
    fn sweep_refuses_a_junctioned_state_root() {
        let ts = TestShell::new();
        let paths = ts.shell.paths.clone();
        let victim = ts.folder("victim");
        let theirs = victim.join("open").join(OPEN);
        fs::create_dir_all(&theirs).unwrap();
        fs::write(theirs.join("inside.txt"), b"mine").unwrap();
        assert!(!paths.root.exists(), "nothing saved yet");
        make_dir_link(&paths.root, &victim);
        write_journal(&ts, &[paths.open.join(OPEN)]);

        assert_eq!(ts.shell.sweep_outputs(), SweepReport::default());
        assert!(theirs.join("inside.txt").is_file());
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    /// Fix round 1: a junction higher up (the Local AppData folder itself): the "Open" folder behind it stays.
    #[cfg(windows)]
    #[test]
    fn sweep_refuses_a_junctioned_higher_ancestor() {
        let ts = TestShell::new();
        let paths = ts.shell.paths.clone();
        let local = ts.env.folder(KnownFolder::LocalAppData);
        let victim = ts.folder("victim");
        let theirs = victim.join("Lockbox").join("open").join(OPEN);
        fs::create_dir_all(&theirs).unwrap();
        fs::write(theirs.join("inside.txt"), b"mine").unwrap();
        fs::remove_dir(&local).unwrap();
        make_dir_link(&local, &victim);
        write_journal(&ts, &[paths.open.join(OPEN)]);

        assert_eq!(ts.shell.sweep_outputs(), SweepReport::default());
        assert!(theirs.join("inside.txt").is_file());
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    /// Fix round 2: the drive or share root is checked like every folder below it, before the walk goes down. A root
    /// that is a link cannot be made without admin rights, so a fake stands in for the disk (unit level).
    #[test]
    fn root_is_checked_too() {
        /// The root reads as given; every folder below it is a plain folder.
        struct Fake {
            root: PathBuf,
            /// `None`: the root's attributes cannot be read.
            attributes: Option<u32>,
            /// `None`: its reparse tag cannot be read.
            redirect: Option<bool>,
        }
        impl FolderProbe for Fake {
            fn attributes(&self, at: &Path) -> io::Result<u32> {
                if at != self.root {
                    return Ok(DIRECTORY);
                }
                self.attributes
                    .ok_or_else(|| io::ErrorKind::PermissionDenied.into())
            }
            fn redirects(&self, at: &Path) -> io::Result<bool> {
                if at != self.root {
                    return Ok(false);
                }
                self.redirect
                    .ok_or_else(|| io::ErrorKind::PermissionDenied.into())
            }
        }
        const LINK: u32 = DIRECTORY | REPARSE_POINT;
        let drop = Checked::Drop;
        let pass = Checked::Delete { folder: true };
        for root in [r"\\?\C:\", r"C:\", r"\\?\UNC\server\share\"] {
            let folder = Path::new(root).join("Users").join("me");
            let check = |attributes, redirect| {
                let fake = Fake {
                    root: PathBuf::from(root),
                    attributes,
                    redirect,
                };
                no_link_on_the_way(&fake, Path::new(root), &folder)
            };
            assert_eq!(check(Some(DIRECTORY), None), pass, "{root}: a plain root");
            assert_eq!(check(Some(LINK), Some(true)), drop, "{root}: a linked root");
            assert_eq!(check(Some(LINK), None), drop, "{root}: its tag unreadable");
            assert_eq!(check(None, None), drop, "{root}: unreadable");
            assert_eq!(check(Some(0), None), drop, "{root}: not a folder");
            assert_eq!(
                check(Some(LINK), Some(false)),
                pass,
                "{root}: a cloud-file root"
            );
        }
    }

    /// Fix round 1: "plain names only" holds for the text as written: a `.`, `..` or empty part is refused before
    /// anything normalises it away, for a drive path, a verbatim drive path and a share.
    #[test]
    fn entry_shapes() {
        let root = |text: &str| plain_root(Path::new(text));
        assert_eq!(root(r"C:\Users\me\x"), Some(PathBuf::from(r"C:\")));
        assert_eq!(root(r"\\?\C:\Users\me\x"), Some(PathBuf::from(r"\\?\C:\")));
        assert_eq!(
            root(r"\\?\UNC\server\share\me\x"),
            Some(PathBuf::from(r"\\?\UNC\server\share\"))
        );
        for refused in [
            r"C:\Users\.\x",
            r"C:\Users\..\x",
            r"C:\Users\\x",
            r"C:\Users\x\",
            r"C:\Users\x\.",
            r"\\?\C:\Users\.\x",
            r"\\?\C:\Users\..\x",
            r"\\?\UNC\server\share\.\x",
            r"\\?\UNC\server\.\x",
            r"\\?\UNC\server\share",
            r"C:\",
            r"C:x",
            r"C:/Users/x",
            r"Users\x",
            r"\Users\x",
            r"\\server\share\x",
            r"\\.\C:\x",
            r"\\?\Volume{0}\x",
        ] {
            assert_eq!(root(refused), None, "{refused}");
        }
    }

    /// Fix round 1: an "Open" folder named through `open\.\<32 hex>` (which `Path::components` would quietly turn
    /// into `open\<32 hex>`) is dropped by the journal's own sweep, and the folder stays. Then it is a real folder of
    /// Lockbox's name that nothing lists: the launch's look at `open\` removes it, by its own spelling.
    #[test]
    fn sweep_drops_dotted_entries() {
        let ts = TestShell::new();
        let paths = &ts.shell.paths;
        let open = paths.open.join(OPEN);
        fs::create_dir_all(&open).unwrap();
        let spelled = paths.open.to_string_lossy().into_owned();
        write_journal(&ts, &[PathBuf::from(format!(r"{spelled}\.\{OPEN}"))]);

        assert_eq!(ts.shell.outputs.sweep(), SweepReport::default());
        assert!(open.is_dir());
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());

        assert_eq!(ts.shell.sweep_outputs(), SweepReport::default());
        assert!(!open.exists());
    }

    /// Fix round 1: every delete attempt checks the entry again. The leftover is held open, so the first attempt
    /// fails; before the next, its folder (then `open\`) is swapped for a junction to a folder holding a file (a
    /// folder) of the same name. The next check sees the link: the entry is dropped and the user's file stays.
    #[cfg(windows)]
    #[test]
    fn sweep_rechecks_before_each_delete() {
        let ts = TestShell::new();
        let paths = ts.shell.paths.clone();
        let docs = ts.folder("Documents");
        let out = docs.join("out");
        fs::create_dir(&out).unwrap();
        fs::write(out.join(TEMP), b"plaintext").unwrap();
        let victim = docs.join("victim");
        fs::create_dir(&victim).unwrap();
        fs::write(victim.join(TEMP), b"mine").unwrap();
        let held = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(out.join(TEMP))
            .unwrap();
        let swapped = Arc::new(AtomicBool::new(false));
        let (moved, done) = (docs.join("out moved"), Arc::clone(&swapped));
        let (from, to) = (out.clone(), victim.clone());
        ts.shell.outputs.on_retry(Box::new(move || {
            drop(held);
            fs::rename(&from, &moved).unwrap();
            make_dir_link(&from, &to);
            done.store(true, Ordering::SeqCst);
        }));
        write_journal(&ts, &[out.join(TEMP)]);
        assert_eq!(ts.shell.sweep_outputs(), SweepReport::default());
        assert!(
            swapped.load(Ordering::SeqCst),
            "the swap ran between attempts"
        );
        assert_eq!(fs::read(victim.join(TEMP)).unwrap(), b"mine");
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());

        // The same for an "Open" folder, with `open\` itself swapped.
        let open = paths.open.join(OPEN);
        fs::create_dir_all(&open).unwrap();
        let held = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .share_mode(0)
            .open(open.join("statement.pdf"))
            .unwrap();
        let theirs = docs.join("their open");
        fs::create_dir_all(theirs.join(OPEN)).unwrap();
        fs::write(theirs.join(OPEN).join("inside.txt"), b"mine").unwrap();
        swapped.store(false, Ordering::SeqCst);
        let (from, moved, to, done) = (
            paths.open.clone(),
            docs.join("open moved"),
            theirs.clone(),
            Arc::clone(&swapped),
        );
        ts.shell.outputs.on_retry(Box::new(move || {
            drop(held);
            fs::rename(&from, &moved).unwrap();
            make_dir_link(&from, &to);
            done.store(true, Ordering::SeqCst);
        }));
        write_journal(&ts, &[open]);
        assert_eq!(ts.shell.sweep_outputs(), SweepReport::default());
        assert!(
            swapped.load(Ordering::SeqCst),
            "the swap ran between attempts"
        );
        assert!(theirs.join(OPEN).join("inside.txt").is_file());
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    /// Fix round 1: reset never replaces a file. Another program takes the first free name right before the move:
    /// that file stays and the journal goes to the next name. With all 99 names taken: `TooLarge`, journal kept.
    #[test]
    fn reset_never_overwrites() {
        let ts = TestShell::new();
        let paths = ts.shell.paths.clone();
        fs::create_dir_all(&paths.root).unwrap();
        fs::write(&paths.outputs, "not json").unwrap();
        let aside = |n: u32| paths.root.join(format!("pending-outputs.json.damaged-{n}"));
        ts.shell.outputs.on_set_aside(Box::new(|name| {
            fs::write(name, b"another program's").unwrap();
        }));
        ts.shell.outputs.reset().unwrap();
        assert_eq!(fs::read(aside(1)).unwrap(), b"another program's");
        assert_eq!(fs::read_to_string(aside(2)).unwrap(), "not json");
        assert!(!paths.outputs.exists());

        fs::write(&paths.outputs, "not json").unwrap();
        for n in 3..=99 {
            fs::write(aside(n), b"taken").unwrap();
        }
        assert_eq!(
            ts.shell.outputs.reset(),
            Err(ShellError::TooLarge {
                what: "damaged output journals"
            })
        );
        assert_eq!(fs::read_to_string(&paths.outputs).unwrap(), "not json");
        assert!(!paths.root.join("pending-outputs.json.damaged-100").exists());
    }

    /// Fix round 1: the launch sweep's report is kept for the page, which asks for it once loaded (the event goes
    /// out before the page listens). Nothing to tell: no notice.
    #[test]
    fn launch_notices_kept_for_the_page() {
        let ts = TestShell::new();
        let notices = || serde_json::to_value(ts.shell.launch_notices()).unwrap();
        assert_eq!(notices(), json!([]));
        ts.shell.sweep_outputs();
        assert_eq!(notices(), json!([]), "a clean launch has nothing to tell");
        fs::create_dir_all(&ts.shell.paths.root).unwrap();
        fs::write(&ts.shell.paths.outputs, "not json").unwrap();
        ts.shell.sweep_outputs();
        let notice = json!({ "kind": "output_sweep", "removed": 0, "kept": 0, "unreadable": true });
        assert_eq!(notices(), json!([notice]));
        assert_eq!(notices(), json!([notice]), "kept, not used up");
    }

    /// An entry on a drive that is not connected stays for a later launch; one on a connected drive whose temp is
    /// already gone is dropped.
    #[test]
    fn sweep_keeps_entries_on_missing_drives() {
        let ts = TestShell::new();
        let letter = ('D'..='Z')
            .rev()
            .find(|letter| !Path::new(&format!(r"{letter}:\")).exists())
            .expect("a drive letter not in use");
        let unplugged = PathBuf::from(format!(r"\\?\{letter}:\Copies\{TEMP}"));
        let gone = ts.folder("Documents").join(TEMP);
        write_journal(&ts, &[unplugged.clone(), gone]);

        let kept = SweepReport {
            removed: 0,
            kept: 1,
            unreadable: false,
        };
        assert_eq!(ts.shell.sweep_outputs(), kept);
        assert_eq!(ts.journal(), std::slice::from_ref(&unplugged));
        assert_eq!(
            ts.shell.sweep_outputs(),
            kept,
            "and again at the next launch"
        );
        assert_eq!(ts.journal(), [unplugged]);
    }

    /// A journal that does not parse: the sweep removes nothing and keeps the file as it is, and says so; no
    /// decrypted output (Save a copy, the engine's record) until the journal is set aside; imports still work.
    #[test]
    fn damaged_journal_kept_and_reported() {
        let ts = TestShell::new();
        let paths = &ts.shell.paths;
        let (s, g) = ts.open_vault("Family");
        let (id, file_id) = ts.stored_file(s, g, "report.pdf", b"report");
        let docs = ts.folder("Documents");
        let leftover = docs.join(TEMP);
        fs::write(&leftover, b"plaintext").unwrap();
        // Lists the leftover, with a field the journal does not have.
        let text = json!({ "version": 1, "entries": [leftover], "extra": true }).to_string();
        fs::create_dir_all(&paths.root).unwrap();
        fs::write(&paths.outputs, &text).unwrap();

        let unreadable = SweepReport {
            removed: 0,
            kept: 0,
            unreadable: true,
        };
        assert_eq!(ts.shell.sweep_outputs(), unreadable);
        assert_eq!(
            fs::read_to_string(&paths.outputs).unwrap(),
            text,
            "kept as it is"
        );
        assert!(leftover.is_file(), "nothing removed");
        let notice = json!({ "kind": "output_sweep", "removed": 0, "kept": 0, "unreadable": true });
        assert_eq!(ts.events.notices(), [notice]);

        // Refused before the dialog, and the engine's record refuses too: no temp is made.
        assert_eq!(
            ts.shell.save_file_copy(s, g, &id, &file_id).err(),
            Some(damaged())
        );
        assert_eq!(ts.dialogs.opened(), 0);
        let journal = ts.shell.outputs.for_call(&ts.shell.sessions, s, g);
        assert!(journal.record(&docs.join(BACKUP_TEMP)).is_err());
        assert_eq!(
            journal.finish(Err::<(), _>(CoreError::Cancelled)),
            Err(damaged())
        );
        assert_eq!(fs::read_to_string(&paths.outputs).unwrap(), text);
        assert_eq!(ts.shell.sweep_outputs(), unreadable, "reported until reset");

        // Imports write no decrypted output: not blocked.
        let source = ts.temp.path().join("statement.pdf");
        fs::write(&source, b"statement").unwrap();
        ts.dialogs.answer(Some(source));
        let added = ts.shell.add_file(s, g, None).unwrap();
        assert!(matches!(added.data, Outcome::Done(_)));

        // Set aside: decrypted output works again.
        ts.shell.outputs.reset().unwrap();
        assert!(!paths.outputs.exists());
        let aside = paths.root.join("pending-outputs.json.damaged-1");
        assert_eq!(fs::read_to_string(&aside).unwrap(), text);
        let copy = docs.join("report copy.pdf");
        ts.dialogs.answer(Some(copy.clone()));
        let saved = ts.shell.save_file_copy(s, g, &id, &file_id).unwrap();
        assert!(matches!(saved.data, Outcome::Done(())));
        assert_eq!(fs::read(&copy).unwrap(), b"report");
        assert_eq!(ts.shell.sweep_outputs(), SweepReport::default());

        // The next damaged journal goes beside it; a journal that is fine is left alone.
        fs::write(&paths.outputs, "not json").unwrap();
        ts.shell.outputs.reset().unwrap();
        let second = paths.root.join("pending-outputs.json.damaged-2");
        assert_eq!(fs::read_to_string(second).unwrap(), "not json");
        write_journal(&ts, &[]);
        ts.shell.outputs.reset().unwrap();
        assert!(paths.outputs.is_file());
        let aside = names(&paths.root);
        assert_eq!(aside.iter().filter(|n| n.contains("damaged")).count(), 2);
    }
}
