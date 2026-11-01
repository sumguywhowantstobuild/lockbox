//! The output journal (spec §7.2): every temporary plaintext file Lockbox creates is written down in
//! `pending-outputs.json`, in the state folder, before it exists, and forgotten once it is gone. At launch the
//! leftovers of a crash or power cut are swept by strict rules, so a tampered journal never makes Lockbox delete
//! anything it did not make.
//!
//! `{ "version": 1, "entries": ["<absolute path>", ..] }`: temp paths only, never an original file name (R5). Read
//! and written like the other state files ([`read_state`], [`write_state`]), one change at a time.

use std::cell::RefCell;
use std::ffi::OsStr;
use std::fs::{self, Metadata};
use std::io;
use std::os::windows::fs::MetadataExt;
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::{Arc, Mutex};

use lockbox_core::blob::OutputJournal;
use lockbox_core::fsio::{remove_dir_all_retry, remove_file_retry};
use lockbox_core::{CoreError, Result as CoreResult};
use serde::{Deserialize, Serialize};

use crate::error::{ShellError, ShellResult};
use crate::lock;
use crate::os::{Volumes, same_path};
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
    /// The state folder and its `open\` folder, where "Open" copies live (a later task makes them).
    root: PathBuf,
    open: PathBuf,
    volumes: Arc<dyn Volumes>,
    edits: Mutex<()>,
    /// Tests only: how many publish attempts have started.
    #[cfg(test)]
    attempts: std::sync::atomic::AtomicUsize,
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
            root: paths.root.clone(),
            open: paths.open.clone(),
            volumes,
            edits: Mutex::default(),
            #[cfg(test)]
            attempts: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    /// Tests only: how many publish attempts have started.
    #[cfg(test)]
    pub(crate) fn publish_attempts(&self) -> usize {
        self.attempts.load(std::sync::atomic::Ordering::SeqCst)
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

    /// Forgets `written`, once its temp is gone. Never panics (the engine may call it while unwinding): when the
    /// journal cannot be read or written, the entry stays, and the next launch's sweep finds nothing there and drops
    /// it. Nothing is logged.
    fn clear(&self, written: &Path) {
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
    /// those. An entry is deleted only when all of these hold:
    /// - it is an absolute path on a local drive or a share, made of plain names only (no `.` or `..`);
    /// - it is an "Open" folder (its name 32 lowercase hex, directly inside `open\`, which is itself a real folder
    ///   right inside the state folder), or an engine temp (`.<16 lowercase hex>.lockbox-partial` or
    ///   `.lockbox-backup-partial`) whose folder, resolved, is the folder written down: no link anywhere along it;
    /// - it is, by its own metadata, a plain folder or a plain file (not a link, junction or other reparse point).
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
        let open = self.open_folder();
        let mut report = SweepReport::default();
        let mut kept = Vec::new();
        for entry in entries {
            match self.sweep_one(&entry, open.as_deref()) {
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

    /// One entry of the sweep. `open`: the `open\` folder, canonical, when it may hold "Open" folders.
    fn sweep_one(&self, entry: &Path, open: Option<&Path>) -> Swept {
        let Some(root) = drive_root(entry) else {
            return Swept::Dropped;
        };
        let (Some(name), Some(folder)) =
            (entry.file_name().and_then(OsStr::to_str), entry.parent())
        else {
            return Swept::Dropped;
        };
        let in_open = same_path(folder, &self.open) || open.is_some_and(|o| same_path(folder, o));
        let is_folder = match (in_open && is_open_name(name), is_temp_name(name)) {
            (true, _) => true,
            (false, true) => false,
            (false, false) => return Swept::Dropped,
        };
        if !matches!(self.volumes.exists(&root), Ok(true)) {
            return Swept::Kept;
        }
        let no_link = match is_folder {
            true => open.is_some(),
            false => fs::canonicalize(folder).is_ok_and(|real| same_path(&real, folder)),
        };
        if !no_link {
            return Swept::Dropped;
        }
        match fs::symlink_metadata(entry) {
            Ok(meta) if plain(&meta, is_folder) => {}
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Swept::Kept,
            // Not a plain file or folder, or already gone.
            _ => return Swept::Dropped,
        }
        let removed = match is_folder {
            true => remove_dir_all_retry(entry),
            false => remove_file_retry(entry),
        };
        match removed {
            Ok(()) => Swept::Removed,
            Err(_) => Swept::Kept,
        }
    }

    /// `open\`, canonical, when it is a real folder (not a link) whose canonical path is `<state folder>\open`;
    /// `None` otherwise, and then no "Open" folder is swept.
    fn open_folder(&self) -> Option<PathBuf> {
        let meta = fs::symlink_metadata(&self.open).ok()?;
        if !plain(&meta, true) {
            return None;
        }
        let open = fs::canonicalize(&self.open).ok()?;
        let root = fs::canonicalize(&self.root).ok()?;
        same_path(&open, &root.join(self.open.file_name()?)).then_some(open)
    }

    /// Sets a damaged journal aside, as `pending-outputs.json.damaged-<n>` (the first free `n` from 1 to 99), so
    /// decrypted output works again; its leftovers are no longer swept. A journal that reads fine (or none) is left
    /// as it is. `TooLarge` once all 99 names are taken.
    pub fn reset(&self) -> ShellResult<()> {
        let _edit = lock(&self.edits);
        if self.load().is_ok() {
            return Ok(());
        }
        for n in 1..=MAX_SET_ASIDE {
            let mut aside = self.file.clone().into_os_string();
            aside.push(format!(".damaged-{n}"));
            match fs::symlink_metadata(&aside) {
                Ok(_) => continue,
                Err(e) if e.kind() == io::ErrorKind::NotFound => {
                    return Ok(fs::rename(&self.file, &aside)?);
                }
                Err(e) => return Err(e.into()),
            }
        }
        Err(ShellError::TooLarge {
            what: "damaged output journals",
        })
    }
}

/// The root of the drive or share `path` is on (`C:\`, `\\?\C:\`, `\\?\UNC\server\share\`), when `path` is absolute
/// and made of plain names after it (no `.` or `..`); `None` for anything else (a relative path, a device path).
fn drive_root(path: &Path) -> Option<PathBuf> {
    let mut parts = path.components();
    let Some(Component::Prefix(prefix)) = parts.next() else {
        return None;
    };
    let local_or_share = matches!(
        prefix.kind(),
        Prefix::Disk(_) | Prefix::VerbatimDisk(_) | Prefix::VerbatimUNC(..)
    );
    if !local_or_share || parts.next() != Some(Component::RootDir) {
        return None;
    }
    let mut names = 0;
    for part in parts {
        if !matches!(part, Component::Normal(_)) {
            return None;
        }
        names += 1;
    }
    let mut root = PathBuf::from(prefix.as_os_str());
    root.push(Component::RootDir);
    (names > 0).then_some(root)
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
        #[cfg(test)]
        self.outputs
            .attempts
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let mut tried = None;
        let gate = self.sessions.publish(self.session, self.generation, || {
            tried = Some(attempt());
            Ok(())
        });
        match gate {
            Ok(()) => tried.unwrap_or(Err(REFUSED)),
            Err(error) => Err(self.refuse(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::rc::Rc;

    use lockbox_core::CoreError;
    use lockbox_core::blob::OutputJournal;
    use lockbox_core::internals::fsio::testutil::{make_dir_link, names};
    use lockbox_core::internals::fsio::{failpoint, set_hidden};
    use serde_json::json;

    use super::*;
    use crate::error::{Outcome, ShellError};
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
