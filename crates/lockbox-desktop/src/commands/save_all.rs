//! Saving all of a folder's files (spec §7.2, design "Saving all of a folder's files"; plan 4B, task 11): every stored
//! file of every live item of a folder, written decrypted into a folder the person picks, never replacing anything.
//!
//! Two steps, so the page can show where the files go and how many there are before anything is written. The picker
//! opens inside [`save_all_files`](Shell::save_all_files), titled with the number of copies so the warning comes first,
//! and the shell's destination checks run ([`Shell::checked_output`]); the answer is a plan (names, sizes, the total), kept
//! under a token in [`PendingChoice::SaveAll`], or the cloud question. [`save_all_start`](Shell::save_all_start) runs
//! every check again and then the job: one operation for the whole batch, with one progress bar over every file's bytes
//! and one Stop. Each file is its own use of the vault (the engine's [`export_file_new`](lockbox_core::Vault::export_file_new):
//! decrypted and verified once into a hidden, journaled temp, then moved to the first free name by a move that refuses a
//! taken one), and the vault is let go between two files. The path never reaches the page: it sees names and sizes, and
//! tokens.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;

use lockbox_core::NewExportError;
use lockbox_core::ids::{FileId, ItemId};
use lockbox_core::item::{Item, ItemKind};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Request;

use super::batch::{BatchProgress, RELEASE_GAP};
use super::{args, blocking};
use crate::error::{Confirm, Outcome, ShellError, ShellResult};
use crate::jobs::{JobKind, JobScope, RunningJob};
use crate::open::{MAX_NAME_CHARS, save_name};
use crate::pending::{PendingChoice, Token};
use crate::restore::shown;
use crate::session::{SessionId, Tagged, VaultRef};
use crate::shell::{Checked, Shell};

/// A folder with no stored files: the entry is hidden at none, so this is a race.
const NO_FILES: ShellError = ShellError::InvalidInput { what: "no files" };
/// The folder's files are no longer exactly the ones planned.
const FOLDER_CHANGED: ShellError = ShellError::InvalidInput {
    what: "folder changed",
};
/// What a taken name at number 999 is answered by the engine.
const DESTINATION_EXISTS: &str = "destination exists";
/// A name in the chosen folder, given to the shared destination checks, which take a file's path. Nothing is ever made
/// under it.
const PLACEHOLDER: &str = "unused";

/// One file of a plan, as the page lists it: its name as it will be written (after the name rule), its size, and the
/// item it is attached to when it is an attachment of a login, key or note (`None` for a file item's own file).
#[derive(Serialize)]
pub struct PlannedFile {
    pub name: String,
    pub size: u64,
    pub attached_to: Option<String>,
}

/// The answer of the first step: the plan's token, the folder the files will go in (display text, `\\?\` removed, never
/// accepted back), each file and the total of their sizes.
#[derive(Serialize)]
pub struct SavePlan {
    pub choice: Token,
    pub folder_shown: String,
    pub files: Vec<PlannedFile>,
    pub total: u64,
}

/// A file that was saved, under the name it has on disk.
#[derive(Serialize)]
pub struct SavedFile {
    pub name: String,
    pub size: u64,
    pub attached_to: Option<String>,
}

/// A file saved under another name than its stored one: because of the name rule, or because the name was taken.
#[derive(Serialize)]
pub struct Renamed {
    pub from: String,
    pub to: String,
}

/// What the batch did, as the summary shows it. Names only. `stopped` is the refusal that ended the batch early (a Stop,
/// a full drive, ...), `None` when it ran to the end; then `unfinished` is the file being written when it stopped (the
/// engine leaves nothing of it) and `not_started` the ones after it. A file refused because no name up to 999 was free is
/// in `not_started` too, with `stopped` unset. `output` is the handle for Show in Explorer and for closing the summary.
#[derive(Serialize)]
pub struct SaveAllView {
    pub saved: Vec<SavedFile>,
    pub renamed: Vec<Renamed>,
    pub damaged: Vec<String>,
    pub gone: Vec<String>,
    pub unfinished: Option<String>,
    pub not_started: Vec<String>,
    pub stopped: Option<ShellError>,
    pub folder_shown: String,
    pub output: Token,
}

/// One stored file of the folder as a plan holds it.
struct Entry {
    item: ItemId,
    file: FileId,
    /// The stored name, as the person knows it.
    stored: String,
    size: u64,
    attached_to: Option<String>,
}

/// What became of one file.
enum Step {
    Saved(PathBuf),
    /// Its item was deleted or trashed, or the file taken off it, since the plan.
    Gone,
    /// It does not decrypt or verify (or its blob is missing).
    Damaged,
    /// No name up to 999 was free.
    Refused,
    /// The batch ends here, with this refusal. `started`: the file was being written (so it is the unfinished one); not:
    /// its turn had not begun.
    Stopped {
        error: ShellError,
        started: bool,
    },
    /// The file is in place (it counts as saved, under this name) and the batch ends with this refusal, which came after
    /// the move: no file is unfinished.
    SavedThenStopped(PathBuf, ShellError),
}

/// What one use of the vault for one file came to.
enum Tried {
    Saved(PathBuf),
    /// Saved, and the output journal's gate then failed with this error (its contract allows that after the move).
    SavedThenFailed(PathBuf, ShellError),
    Gone,
    Damaged,
    Refused,
}

/// Every item of the vault, trashed ones included.
fn all_items<'a>(vault: &'a VaultRef<'_>) -> Box<dyn Iterator<Item = &'a Item> + 'a> {
    match vault {
        VaultRef::Writable(vault) => Box::new(vault.items()),
        VaultRef::ReadOnly(vault) => Box::new(vault.items()),
    }
}

/// Every stored file of every live item filed in the live folder `folder` (a file item's own file and every attachment),
/// by the item's title in either case and then its ID, each item's files in its own order. `NotFound` for an ID that is
/// not a live folder of this vault (another vault's, a trashed folder, an item that is no folder).
fn folder_files(vault: &VaultRef<'_>, folder: ItemId) -> ShellResult<Vec<Entry>> {
    let is_live_folder = |item: &&Item| {
        item.id == folder && matches!(item.kind, ItemKind::Collection) && item.trashed_at.is_none()
    };
    if all_items(vault).find(is_live_folder).is_none() {
        return Err(ShellError::NotFound);
    }
    let mut items: Vec<&Item> = all_items(vault)
        .filter(|item| {
            item.trashed_at.is_none() && !item.purging && item.collection == Some(folder)
        })
        .collect();
    items.sort_by_cached_key(|item| (item.title.to_lowercase(), item.id));
    Ok(items
        .into_iter()
        .flat_map(|item| {
            let attached_to = (!matches!(item.kind, ItemKind::File)).then(|| item.title.clone());
            item.attachments.iter().map(move |file| Entry {
                item: item.id,
                file: file.file_id,
                stored: file.name.clone(),
                size: file.length,
                attached_to: attached_to.clone(),
            })
        })
        .collect())
}

/// The IDs of `entries`, sorted: what "the same files" is judged on, whatever order or titles they have now.
fn ids_of(entries: &[Entry]) -> Vec<(ItemId, FileId)> {
    let mut ids: Vec<(ItemId, FileId)> = entries.iter().map(|e| (e.item, e.file)).collect();
    ids.sort_unstable();
    ids
}

/// The name for copy number `number` of `name`: the name itself for 1, then `name (2).ext`, `name (3).ext`, with the
/// number before the last extension (none for a name that is all extension, like `.env`). The base is cut so that the
/// whole stays within [`MAX_NAME_CHARS`] characters, keeping the extension; an extension too long to keep is cut with
/// the rest.
pub(crate) fn numbered(name: &str, number: u32) -> String {
    if number <= 1 {
        return name.to_owned();
    }
    let suffix = format!(" ({number})");
    let (stem, extension) = match name.rfind('.') {
        Some(dot) if dot > 0 => name.split_at(dot),
        _ => (name, ""),
    };
    let room = MAX_NAME_CHARS.saturating_sub(suffix.chars().count());
    let (stem, extension) = match extension.chars().count() < room {
        true => (stem, extension),
        false => (name, ""),
    };
    let stem: String = stem
        .chars()
        .take(room - extension.chars().count())
        .collect();
    format!("{stem}{suffix}{extension}")
}

/// The picker's title: the number of copies, before any is written.
fn picker_title(count: usize) -> String {
    match count {
        1 => "Choose where to save 1 unencrypted copy".to_owned(),
        count => format!("Choose where to save {count} unencrypted copies"),
    }
}

/// The folder a checked placeholder path is in.
fn folder_of(checked: PathBuf) -> ShellResult<PathBuf> {
    checked
        .parent()
        .map(Path::to_path_buf)
        .ok_or(ShellError::InvalidInput { what: "file name" })
}

/// Whether the file is still on a live item of the vault.
fn still_there(vault: &VaultRef<'_>, entry: &Entry) -> bool {
    let item = match vault {
        VaultRef::Writable(vault) => vault.get_item(&entry.item),
        VaultRef::ReadOnly(vault) => vault.get_item(&entry.item),
    };
    item.is_ok_and(|item| {
        item.trashed_at.is_none()
            && !item.purging
            && item.attachments.iter().any(|f| f.file_id == entry.file)
    })
}

impl Shell {
    /// Opens the folder picker for the files of the folder `folder`, titled "Choose where to save N unencrypted copies"
    /// (N counts every stored file of the folder, attached ones included), and answers the plan. Refused before the
    /// picker opens: a damaged output journal, a stale generation (`Locked`), a session that is not ours or a folder that
    /// is not a live folder of that vault (`NotFound`), and a folder with no files (`invalid_input`, "no files"). A read-only
    /// session may save all, as it may save a copy. After the picker: the state folder and any vault's folder are refused,
    /// a folder a cloud provider syncs answers [`Confirm::CloudFolder`] (the yes is
    /// [`save_all_files_confirm`](Self::save_all_files_confirm)), and free space for the whole batch is checked, with the
    /// numbers. Nothing is written, and no job begins. `Dismissed` when the picker is closed.
    pub fn save_all_files(
        &self,
        session: SessionId,
        generation: u64,
        folder: &str,
    ) -> ShellResult<Tagged<Outcome<SavePlan>>> {
        let folder = ItemId::from_hex(folder)?;
        self.outputs.usable()?;
        let count = self
            .sessions
            .read(session, generation, |vault, _| {
                Ok(folder_files(&vault, folder)?.len())
            })?
            .data;
        if count == 0 {
            return Err(NO_FILES);
        }
        let Some(chosen) = self.os.dialogs.pick_folder(&picker_title(count), None) else {
            return self.still_current(session, generation, Outcome::Dismissed);
        };
        self.plan_save_all(session, generation, folder, &chosen, false)
    }

    /// The user's yes to saving in a cloud folder: goes on with the folder parked before, for the session that asked (and
    /// only while it is still unlocked in the generation that asked), with no second picker, and answers the plan as
    /// [`save_all_files`](Self::save_all_files) does. Every check runs again, since the folder may have changed. A token
    /// that is not a cloud question (never given, used, expired, a plan's, another kind's) is `ChoiceExpired`.
    pub fn save_all_files_confirm(&self, token: &Token) -> ShellResult<Tagged<Outcome<SavePlan>>> {
        let asked = self.sessions.pending().take_cloud_question(token)?;
        self.plan_save_all(
            asked.session,
            asked.generation,
            asked.folder,
            &asked.dest,
            true,
        )
    }

    /// The rest of the first step, after the picker or after a yes: the shared checks on the chosen folder, the cloud
    /// question unless `cloud_confirmed`, then the files as they are now, the space for all of them, and the plan parked.
    fn plan_save_all(
        &self,
        session: SessionId,
        generation: u64,
        folder: ItemId,
        chosen: &Path,
        cloud_confirmed: bool,
    ) -> ShellResult<Tagged<Outcome<SavePlan>>> {
        let pending = self.sessions.pending();
        let dir = match self.checked_output(&chosen.join(PLACEHOLDER), cloud_confirmed)? {
            Checked::Ready(checked) => folder_of(checked)?,
            Checked::Cloud(checked) => {
                // The question holds the folder and no files: a plan can't be started from it.
                let token = pending.put(PendingChoice::SaveAll {
                    session,
                    generation,
                    folder,
                    dest: folder_of(checked)?,
                    files: Vec::new(),
                });
                let ask = Outcome::Confirm(Confirm::CloudFolder { token });
                return self.still_current(session, generation, ask);
            }
        };
        let entries = self
            .sessions
            .read(session, generation, |vault, _| {
                let entries = folder_files(&vault, folder)?;
                if entries.is_empty() {
                    return Err(NO_FILES);
                }
                let sizes: Vec<u64> = entries.iter().map(|entry| entry.size).collect();
                match &vault {
                    VaultRef::Writable(vault) => vault.check_output_space(&dir, &sizes)?,
                    VaultRef::ReadOnly(vault) => vault.check_output_space(&dir, &sizes)?,
                }
                Ok(entries)
            })?
            .data;
        let total = entries
            .iter()
            .fold(0u64, |sum, entry| sum.saturating_add(entry.size));
        let files = entries
            .iter()
            .map(|entry| PlannedFile {
                name: save_name(&entry.stored),
                size: entry.size,
                attached_to: entry.attached_to.clone(),
            })
            .collect();
        let choice = pending.put(PendingChoice::SaveAll {
            session,
            generation,
            folder,
            dest: dir.clone(),
            files: entries
                .iter()
                .map(|entry| (entry.item, entry.file))
                .collect(),
        });
        let plan = SavePlan {
            choice: choice.clone(),
            folder_shown: shown(&dir),
            files,
            total,
        };
        self.still_current(session, generation, Outcome::Done(plan))
            .inspect_err(|_| {
                // A lock came meanwhile: what was just parked is no one's.
                let _ = pending.use_up_save_all(&choice);
            })
    }

    /// Runs the plan `choice` as one long job the page's `request` names: progress over every file's bytes together and one
    /// Stop. Every check runs again first, and a refusal leaves the plan for another try: the output journal, the state
    /// folder and vault folders, the files of the folder (`invalid_input`, "folder changed" unless they are exactly the
    /// planned ones) and the space for all of them. Then the plan is used up and the job begins.
    ///
    /// Each file is its own use of the vault (tried again for 30 seconds while another command has it, by the shell's
    /// clock), and the vault is let go for a moment after each. A file whose item went in the meantime is in `gone`; one
    /// that does not decrypt is in `damaged`; a taken name gets the next number and is listed in `renamed`; the batch
    /// goes on. A Stop, a full drive, a vault that stays busy or any other refusal ends it: the files before it are
    /// saved, the one being written leaves nothing (`unfinished`), the ones after were never started (`not_started`),
    /// and `stopped` says why. A lock is the one exception: like every command, the answer is `Locked`, and the files
    /// already saved stay.
    pub fn save_all_start(
        &self,
        choice: &Token,
        request: u32,
    ) -> ShellResult<Tagged<Outcome<SaveAllView>>> {
        let pending = self.sessions.pending();
        let planned = pending.peek_save_all(choice)?;
        let (session, generation) = (planned.session, planned.generation);
        // The cloud question was answered before the plan was made, so the cloud check is not asked again.
        let (Checked::Ready(checked) | Checked::Cloud(checked)) =
            self.checked_output(&planned.dest.join(PLACEHOLDER), true)?;
        let dir = folder_of(checked)?;
        let (entries, parent) = self
            .sessions
            .read(session, generation, |vault, cancel| {
                let entries =
                    folder_files(&vault, planned.folder).map_err(|error| match error {
                        ShellError::NotFound => FOLDER_CHANGED,
                        other => other,
                    })?;
                if ids_of(&entries) != ids_of_planned(&planned.files) {
                    return Err(FOLDER_CHANGED);
                }
                let sizes: Vec<u64> = entries.iter().map(|entry| entry.size).collect();
                match &vault {
                    VaultRef::Writable(vault) => vault.check_output_space(&dir, &sizes)?,
                    VaultRef::ReadOnly(vault) => vault.check_output_space(&dir, &sizes)?,
                }
                Ok((in_planned_order(entries, &planned.files), cancel.clone()))
            })?
            .data;
        pending.use_up_save_all(choice)?;

        let total = entries
            .iter()
            .fold(0u64, |sum, entry| sum.saturating_add(entry.size));
        let scope = JobScope::Session {
            session,
            generation,
        };
        let job = self
            .autolock
            .begin_job(scope, JobKind::SaveAll, &parent, Some(request));
        let progress = BatchProgress::new(job.progress(), total);
        let mut summary = Summary::default();
        for (index, entry) in entries.iter().enumerate() {
            let step = match job.token().is_cancelled() {
                true => Step::Stopped {
                    error: self.cancelled_or_locked(session, generation)?,
                    started: false,
                },
                false => self.save_one(session, generation, &job, &dir, entry, &progress)?,
            };
            match step {
                Step::Saved(path) => summary.record(entry, &path),
                Step::Gone => summary.gone.push(entry.stored.clone()),
                Step::Damaged => summary.damaged.push(entry.stored.clone()),
                Step::Refused => summary.not_started.push(entry.stored.clone()),
                Step::SavedThenStopped(path, error) => {
                    // The file is on disk: it is saved, and nothing is unfinished; the rest never began.
                    summary.record(entry, &path);
                    summary.stopped = Some(error);
                    let rest = entries[index + 1..].iter().map(|e| e.stored.clone());
                    summary.not_started.extend(rest);
                    break;
                }
                Step::Stopped { error, started } => {
                    summary.stopped = Some(error);
                    let rest = match started {
                        true => {
                            summary.unfinished = Some(entry.stored.clone());
                            index + 1
                        }
                        false => index,
                    };
                    let names = entries[rest..].iter().map(|entry| entry.stored.clone());
                    summary.not_started.extend(names);
                    break;
                }
            }
            #[cfg(test)]
            reached("file_done", index);
            // The vault is free now: a read, or a change, that has been waiting gets in before the next file takes it.
            if index + 1 < entries.len() {
                thread::sleep(RELEASE_GAP);
            }
        }
        // The job ends here, so its last progress event goes out before the answer.
        drop(job);
        let output = pending.put(PendingChoice::SavedFolder {
            session,
            generation,
            folder: dir.clone(),
        });
        let view = SaveAllView {
            saved: summary.saved,
            renamed: summary.renamed,
            damaged: summary.damaged,
            gone: summary.gone,
            unfinished: summary.unfinished,
            not_started: summary.not_started,
            stopped: summary.stopped,
            folder_shown: shown(&dir),
            output: output.clone(),
        };
        self.still_current(session, generation, Outcome::Done(view))
            .inspect_err(|_| pending.close_saved_folder(&output))
    }

    /// One file of the batch, at its turn: its own use of the vault (`Busy` is waited out by the batches' shared wait).
    /// Inside it the file is looked for once more (a file whose item went is `Gone`), then written by the engine to the
    /// first free name, through the output journal. What ends the whole command (a lock, a session that is gone) is the
    /// error; anything else the vault refuses with ends the batch as [`Step::Stopped`].
    fn save_one(
        &self,
        session: SessionId,
        generation: u64,
        job: &RunningJob,
        dir: &Path,
        entry: &Entry,
        progress: &BatchProgress<'_>,
    ) -> ShellResult<Step> {
        let name = save_name(&entry.stored);
        let result = self.when_free(
            job,
            |retries| {
                #[cfg(test)]
                reached("busy_retry", retries);
                #[cfg(not(test))]
                let _ = retries;
            },
            || {
                let tried = self.sessions.read_long(session, generation, |vault, _| {
                    if !still_there(&vault, entry) {
                        return Ok(Tried::Gone);
                    }
                    progress.begin_file(entry.size);
                    let journal = self.outputs.for_call(&self.sessions, session, generation);
                    let mut candidates = |number: u32| dir.join(numbered(&name, number));
                    let saved = match &vault {
                        VaultRef::Writable(vault) => vault.export_file_new(
                            &entry.item,
                            &entry.file,
                            &mut candidates,
                            &journal,
                            job.token(),
                            progress,
                        ),
                        VaultRef::ReadOnly(vault) => vault.export_file_new(
                            &entry.item,
                            &entry.file,
                            &mut candidates,
                            &journal,
                            job.token(),
                            progress,
                        ),
                    };
                    // A failure after the move comes with the path: the file is there, so it is saved whatever the gate
                    // said, and the batch then ends with that error.
                    let (published, saved) = match saved {
                        Ok(path) => (None, Ok(path)),
                        Err(NewExportError { error, published }) => (published, Err(error)),
                    };
                    match (published, journal.finish(saved)) {
                        (_, Ok(path)) => Ok(Tried::Saved(path)),
                        (Some(path), Err(error)) => Ok(Tried::SavedThenFailed(path, error)),
                        (None, Err(error)) => Self::refused(error),
                    }
                });
                tried.map(|tagged| tagged.data)
            },
        );
        match result {
            Ok(Tried::SavedThenFailed(path, error)) => {
                progress.finished_file(entry.size);
                match error {
                    ShellError::Locked | ShellError::NotFound => Err(error),
                    ShellError::Cancelled => Ok(Step::SavedThenStopped(
                        path,
                        self.cancelled_or_locked(session, generation)?,
                    )),
                    error => Ok(Step::SavedThenStopped(path, error)),
                }
            }
            Ok(Tried::Saved(path)) => {
                progress.finished_file(entry.size);
                Ok(Step::Saved(path))
            }
            Ok(Tried::Gone) => {
                progress.passed_over(entry.size);
                Ok(Step::Gone)
            }
            Ok(Tried::Damaged) => {
                progress.passed_over(entry.size);
                Ok(Step::Damaged)
            }
            Ok(Tried::Refused) => {
                progress.passed_over(entry.size);
                Ok(Step::Refused)
            }
            Err(error @ (ShellError::Locked | ShellError::NotFound)) => Err(error),
            Err(ShellError::Cancelled) => Ok(Step::Stopped {
                error: self.cancelled_or_locked(session, generation)?,
                started: true,
            }),
            Err(error) => Ok(Step::Stopped {
                error,
                started: true,
            }),
        }
    }

    /// What an error of the engine's before any file was in place is, for one file: a file that does not decrypt, a
    /// name taken up to 999, or an error that ends the batch.
    fn refused(error: ShellError) -> ShellResult<Tried> {
        match error {
            ShellError::Core(view) if view.kind == "damaged" => Ok(Tried::Damaged),
            ShellError::Core(view)
                if view.kind == "invalid_input" && view.what == Some(DESTINATION_EXISTS) =>
            {
                Ok(Tried::Refused)
            }
            error => Err(error),
        }
    }

    /// Opens the folder the summary's files were saved in, in Explorer, through the handle the summary gave: no command
    /// takes a path. The handle is read, not used up, so the button can be pressed again. `ChoiceExpired` for a handle
    /// that is gone (closed, five minutes old, dropped by a lock) and for a token that is not one, and the page then says
    /// to open the folder from Windows; a launch that fails is the `io` refusal, with no path.
    pub fn show_output_in_explorer(&self, output: &Token) -> ShellResult<()> {
        let (session, generation, folder) = self.sessions.pending().peek_saved_folder(output)?;
        // A lock's hook may still be on its way to drop the handle: a session that has locked has no summary.
        self.still_current(session, generation, ())
            .map_err(|_| ShellError::ChoiceExpired)?;
        self.os.launcher.open_folder(&folder)?;
        Ok(())
    }

    /// Drops the summary's handle, as the summary closes. Idempotent: closing one that is gone, or a token that was never
    /// a handle, is no error.
    pub fn close_output(&self, output: &Token) -> ShellResult<()> {
        self.sessions.pending().close_saved_folder(output);
        Ok(())
    }
}

/// The sorted IDs of the files a plan holds.
fn ids_of_planned(files: &[(ItemId, FileId)]) -> Vec<(ItemId, FileId)> {
    let mut ids = files.to_vec();
    ids.sort_unstable();
    ids
}

/// `entries` in the order of the plan's `files` (the same files, as the caller has checked).
fn in_planned_order(entries: Vec<Entry>, files: &[(ItemId, FileId)]) -> Vec<Entry> {
    let mut entries: Vec<Option<Entry>> = entries.into_iter().map(Some).collect();
    files
        .iter()
        .filter_map(|(item, file)| {
            entries
                .iter_mut()
                .find(|entry| matches!(entry, Some(e) if e.item == *item && e.file == *file))
                .and_then(Option::take)
        })
        .collect()
}

/// What a batch has done so far.
#[derive(Default)]
struct Summary {
    saved: Vec<SavedFile>,
    renamed: Vec<Renamed>,
    damaged: Vec<String>,
    gone: Vec<String>,
    unfinished: Option<String>,
    not_started: Vec<String>,
    stopped: Option<ShellError>,
}

impl Summary {
    /// `entry` is saved at `path`: its name on disk, and listed as renamed when that is not its stored name (the name
    /// rule changed it, or the name was taken).
    fn record(&mut self, entry: &Entry, path: &Path) {
        let on_disk = path
            .file_name()
            .map_or_else(String::new, |name| name.to_string_lossy().into_owned());
        if on_disk != entry.stored {
            self.renamed.push(Renamed {
                from: entry.stored.clone(),
                to: on_disk.clone(),
            });
        }
        self.saved.push(SavedFile {
            name: on_disk,
            size: entry.size,
            attached_to: entry.attached_to.clone(),
        });
    }
}

/// `save_all_files`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveAllFilesArgs {
    session: SessionId,
    generation: u64,
    folder: String,
}

/// `save_all_files_confirm`: the token the cloud question gave, and nothing else.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfirmArgs {
    token: Token,
}

/// `save_all_start`: the plan's token and the page's number for this job (what `lockbox://job-started` answers).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StartArgs {
    choice: Token,
    request: u32,
}

/// `show_output_in_explorer` and `close_output`: the summary's handle, and nothing else.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OutputArgs {
    output: Token,
}

#[tauri::command]
pub(super) async fn save_all_files(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<Outcome<SavePlan>>> {
    let SaveAllFilesArgs {
        session,
        generation,
        folder,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.save_all_files(session, generation, &folder)).await
}

#[tauri::command]
pub(super) async fn save_all_files_confirm(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<Outcome<SavePlan>>> {
    let ConfirmArgs { token } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.save_all_files_confirm(&token)).await
}

#[tauri::command]
pub(super) async fn save_all_start(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<Outcome<SaveAllView>>> {
    let StartArgs { choice, request } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.save_all_start(&choice, request)).await
}

#[tauri::command]
pub(super) async fn show_output_in_explorer(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<()> {
    let OutputArgs { output } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.show_output_in_explorer(&output)).await
}

#[tauri::command]
pub(super) async fn close_output(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<()> {
    let OutputArgs { output } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.close_output(&output)).await
}

/// Tests only: hooks run when a batch reaches a step on this thread (`file_done`, with the file's place in the batch,
/// after it was saved or passed over and the vault is free; `busy_retry`, with the number of tries so far).
#[cfg(test)]
type StepHook = Box<dyn FnMut(usize)>;

#[cfg(test)]
thread_local! {
    static STEPS: std::cell::RefCell<Vec<(&'static str, StepHook)>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

/// Tests only: runs `hook` each time this thread reaches `step`.
#[cfg(test)]
fn at(step: &'static str, hook: impl FnMut(usize) + 'static) {
    STEPS.with(|steps| steps.borrow_mut().push((step, Box::new(hook))));
}

/// Tests only: runs `hook` after each file of a batch, with the vault free.
#[cfg(test)]
fn after_each_file(hook: impl FnMut(usize) + 'static) {
    at("file_done", hook);
}

/// Tests only: runs `hook` before each wait for a busy vault, with the number of tries so far.
#[cfg(test)]
fn at_retry(hook: impl FnMut(usize) + 'static) {
    at("busy_retry", hook);
}

/// Tests only: the point `step` is reached. The hooks run with the list free, so one may add another.
#[cfg(test)]
fn reached(step: &'static str, index: usize) {
    let mut hooks = STEPS.with(|steps| std::mem::take(&mut *steps.borrow_mut()));
    for (name, hook) in &mut hooks {
        if *name == step {
            hook(index);
        }
    }
    STEPS.with(|steps| {
        let mut steps = steps.borrow_mut();
        hooks.append(&mut steps);
        *steps = hooks;
    });
}

/// Tests only: forgets every hook of this thread.
#[cfg(test)]
fn forget_test_steps() {
    STEPS.with(|steps| steps.borrow_mut().clear());
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::fs::{self, OpenOptions};
    use std::os::windows::fs::OpenOptionsExt;
    use std::path::{Path, PathBuf};
    use std::rc::Rc;
    use std::sync::{Arc, Mutex, mpsc};
    use std::thread;
    use std::time::{Duration, Instant};

    use lockbox_core::blob::{CancelToken, NoProgress};
    use lockbox_core::ids::ItemId;
    use lockbox_core::internals::fsio::testutil::{flip_byte, make_dir_link, names};
    use lockbox_core::internals::fsio::{VolumeInfo, failpoint, set_volume_override};
    use lockbox_core::item::ItemKind;
    use lockbox_core::{CoreError, Credential, ReadOnlyVault};
    use serde_json::{Value, json};
    use tauri::ipc::InvokeBody;

    use super::super::{MALFORMED, parse};
    use super::*;
    use crate::error::Confirm;
    use crate::jobs::{JobScope, OperationId};
    use crate::os::Clock;
    use crate::session::{Location, LockReason, OpenStep, Opened};
    use crate::shell::PROGRESS_EVENT;
    use crate::testing::{TEST_PASSWORD, TestShell, heavy};

    const MIB: u64 = 1024 * 1024;
    /// How long a test thread waits for another before it fails instead of hanging.
    const GIVE_UP: Duration = Duration::from_secs(60);
    const LOCKED: Option<ShellError> = Some(ShellError::Locked);
    const EXPIRED: Option<ShellError> = Some(ShellError::ChoiceExpired);
    const NOT_FOUND: Option<ShellError> = Some(ShellError::NotFound);

    /// Puts back what a test changed on its thread, whatever way it ends.
    struct Cleanup;
    impl Drop for Cleanup {
        fn drop(&mut self) {
            failpoint::disarm_all();
            set_volume_override(None);
            forget_test_steps();
        }
    }

    /// The bytes of a made-up file: `size` bytes that differ with `seed`.
    fn bytes(size: u64, seed: u8) -> Vec<u8> {
        (0..size)
            .map(|i| ((i % 251) as u8).wrapping_add(seed))
            .collect()
    }

    /// A folder "Taxes" in the session's vault holding a file item for each of `files` (a name and its contents; the
    /// names may repeat). Each source is made under a canonical folder of its own, so a name Windows would change
    /// (`CON.txt`, a trailing dot) is made as written. The folder's ID.
    fn folder_with(ts: &TestShell, s: SessionId, g: u64, files: &[(&str, Vec<u8>)]) -> String {
        let sources = ts.temp.path().join("sources");
        fs::create_dir_all(&sources).unwrap();
        let sources = fs::canonicalize(sources).unwrap();
        ts.shell
            .sessions
            .write(s, g, |vault, cancel| {
                let folder = vault.new_item(ItemKind::Collection, "Taxes", None)?;
                for (n, (name, contents)) in files.iter().enumerate() {
                    let dir = sources.join(n.to_string());
                    fs::create_dir_all(&dir).unwrap();
                    let path = dir.join(name);
                    fs::write(&path, contents).unwrap();
                    vault.new_file_item(Some(folder), &path, cancel, &NoProgress)?;
                    fs::remove_file(&path).unwrap();
                }
                Ok(folder.to_hex())
            })
            .unwrap()
            .data
    }

    /// A note titled `title` in `folder`, with the file `name` attached.
    fn note_with(
        ts: &TestShell,
        (s, g): (SessionId, u64),
        folder: &str,
        title: &str,
        name: &str,
        contents: &[u8],
    ) -> String {
        let folder = ItemId::from_hex(folder).unwrap();
        let path = ts.temp.path().join("sources").join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, contents).unwrap();
        ts.shell
            .sessions
            .write(s, g, |vault, cancel| {
                let note = vault.new_item(ItemKind::Note, title, Some(folder))?;
                vault.attach_file(&note, &path, cancel, &NoProgress)?;
                Ok(note.to_hex())
            })
            .unwrap()
            .data
    }

    /// The stored files of `folder` as (name, item ID, file ID), by name.
    fn stored(ts: &TestShell, s: SessionId, g: u64, folder: &str) -> Vec<(String, String, String)> {
        let folder = ItemId::from_hex(folder).unwrap();
        let mut found = ts
            .shell
            .sessions
            .read(s, g, |vault, _| {
                let VaultRef::Writable(vault) = vault else {
                    panic!("a writable session");
                };
                Ok(vault
                    .items()
                    .filter(|item| item.collection == Some(folder))
                    .flat_map(|item| {
                        item.attachments.iter().map(|file| {
                            (file.name.clone(), item.id.to_hex(), file.file_id.to_hex())
                        })
                    })
                    .collect::<Vec<_>>())
            })
            .unwrap()
            .data;
        found.sort();
        found
    }

    /// A folder of the test's own that a person could pick, canonical as a dialog's answer is made before use.
    fn destination(ts: &TestShell, name: &str) -> PathBuf {
        ts.folder(name)
    }

    /// What a command that went through holds.
    fn done<T>(answer: ShellResult<Tagged<Outcome<T>>>) -> T {
        match answer.unwrap() {
            Tagged {
                data: Outcome::Done(data),
                ..
            } => data,
            _ => panic!("the command did not finish"),
        }
    }

    /// Picks `dest` and asks for the plan: the plan.
    fn plan_in(ts: &TestShell, s: SessionId, g: u64, folder: &str, dest: &Path) -> SavePlan {
        ts.dialogs.answer(Some(dest.to_path_buf()));
        done(ts.shell.save_all_files(s, g, folder))
    }

    /// Plans and starts, as the page does: the summary as the page receives it.
    fn save_all(ts: &TestShell, s: SessionId, g: u64, folder: &str, dest: &Path) -> Value {
        let plan = plan_in(ts, s, g, folder, dest);
        serde_json::to_value(done(ts.shell.save_all_start(&plan.choice, 1))).unwrap()
    }

    fn texts(list: &Value) -> Vec<String> {
        list.as_array()
            .unwrap()
            .iter()
            .map(|name| name.as_str().unwrap().to_owned())
            .collect()
    }

    /// The names of the files in the summary's `saved` list.
    fn saved_names(view: &Value) -> Vec<String> {
        view["saved"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| file["name"].as_str().unwrap().to_owned())
            .collect()
    }

    /// The entries of the output journal, read by a path (a failpoint's closure cannot borrow the test shell).
    fn journal_at(file: &Path) -> Vec<PathBuf> {
        let Ok(text) = fs::read(file) else {
            return Vec::new();
        };
        let journal: Value = serde_json::from_slice(&text).unwrap();
        serde_json::from_value(journal["entries"].clone()).unwrap()
    }

    /// A read-only session over the vault listed first, as a backup or a pre-restore copy opens.
    fn read_only_session(ts: &TestShell) -> (SessionId, u64) {
        let dir = ts.shell.registry.entries()[0].1.clone();
        ts.shell.sessions.lock_all(LockReason::Manual);
        let vault = heavy(|| {
            ReadOnlyVault::open_folder(
                &dir,
                Credential::Password(TEST_PASSWORD),
                &CancelToken::new(),
                &NoProgress,
            )
        })
        .unwrap();
        let location = Location::folder(&dir).unwrap();
        let opened = ts.shell.sessions.open(Some(location.clone()), None, |_| {
            Ok(OpenStep::Session(location, Opened::ReadOnly(vault), ()))
        });
        let Ok(Outcome::Done(tagged)) = opened else {
            panic!("the read-only session did not open");
        };
        (tagged.session, tagged.generation)
    }

    /// The one job's events of kind `save_all`: its `job-started` and every progress event in order.
    fn the_save_all_job(ts: &TestShell, request: u32) -> (Value, Vec<Value>) {
        let started: Vec<Value> = ts
            .events
            .started()
            .into_iter()
            .filter(|event| event["request"] == json!(request))
            .collect();
        assert_eq!(started.len(), 1, "{started:?}");
        assert_eq!(started[0]["kind"], json!("save_all"));
        let progress = ts
            .events
            .progress()
            .into_iter()
            .filter(|event| event["operation"] == started[0]["operation"])
            .collect();
        (started[0].clone(), progress)
    }

    /// Sends a Stop for the job as the page's button does.
    fn stop_job(shell: &Shell, started: &Value) {
        let operation = OperationId(started["operation"].as_u64().unwrap());
        let scope: JobScope = serde_json::from_value(started["scope"].clone()).unwrap();
        shell.autolock.cancel_operation(operation, scope).unwrap();
    }

    // ---- the picker, the plan and the checks before anything is written ----

    /// The picker says how many copies come before any is written; the plan lists every stored file of every live item
    /// of the folder, attached ones with the item they belong to, a trashed item's not at all, in a stable order, with
    /// names after the name rule and the sizes; nothing is written and no journal entry made.
    #[test]
    fn plan_counts_every_stored_file_attached_ones_included() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(&ts, s, g, &[("b.txt", bytes(3, 1)), ("a.txt", bytes(5, 2))]);
        note_with(&ts, (s, g), &folder, "Tax note", "w2.pdf", &bytes(7, 3));
        let trashed = note_with(&ts, (s, g), &folder, "Old", "old.pdf", &bytes(9, 4));
        ts.shell
            .sessions
            .write(s, g, |vault, _| {
                Ok(vault.trash_item(&ItemId::from_hex(&trashed).unwrap())?)
            })
            .unwrap();
        let dest = destination(&ts, "Out");
        let plan = plan_in(&ts, s, g, &folder, &dest);
        assert_eq!(
            ts.dialogs.folder_titles(),
            ["Choose where to save 3 unencrypted copies"]
        );
        let plan = serde_json::to_value(plan).unwrap();
        let files = plan["files"].as_array().unwrap();
        let listed: Vec<(&str, u64, Option<&str>)> = files
            .iter()
            .map(|f| {
                (
                    f["name"].as_str().unwrap(),
                    f["size"].as_u64().unwrap(),
                    f["attached_to"].as_str(),
                )
            })
            .collect();
        assert_eq!(
            listed,
            [
                ("a.txt", 5, None),
                ("b.txt", 3, None),
                ("w2.pdf", 7, Some("Tax note"))
            ]
        );
        assert_eq!(plan["total"], json!(15));
        assert_eq!(plan["folder_shown"], json!(shown(&dest)));
        assert!(plan["choice"].as_str().is_some_and(|t| t.len() == 32));
        assert!(names(&dest).is_empty(), "nothing is written by a plan");
        assert!(!ts.shell.paths.outputs.exists(), "no journal entry");
        assert!(ts.events.started().is_empty(), "no job yet");
        // One file reads as one copy.
        let (s2, g2) = ts.open_vault("Work");
        let single = folder_with(&ts, s2, g2, &[("only.txt", bytes(1, 0))]);
        plan_in(&ts, s2, g2, &single, &dest);
        assert_eq!(
            ts.dialogs.folder_titles().last().unwrap(),
            "Choose where to save 1 unencrypted copy"
        );
    }

    /// A folder with no files is refused before the picker, as `{"code":"invalid_input","what":"no files"}`; a closed
    /// picker is `Dismissed`, tagged, with nothing parked; a folder that is not a live folder of this vault (another
    /// vault's, a trashed one, an item that is no folder) is `NotFound`.
    #[test]
    fn no_files_dismissed_and_not_a_folder() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let empty = folder_with(&ts, s, g, &[]);
        let full = folder_with(&ts, s, g, &[("a.txt", bytes(3, 1))]);
        let (other, go) = ts.open_vault("Work");
        let theirs = folder_with(&ts, other, go, &[("t.txt", bytes(3, 1))]);
        let note = note_with(&ts, (s, g), &full, "N", "n.txt", b"n");
        let dialogs = ts.dialogs.opened();

        let refused = ts.shell.save_all_files(s, g, &empty).err();
        assert_eq!(refused, Some(ShellError::InvalidInput { what: "no files" }));
        assert_eq!(
            serde_json::to_value(refused.unwrap()).unwrap(),
            json!({ "code": "invalid_input", "what": "no files" })
        );
        for id in [&theirs, &note, &ItemId::random().to_hex()] {
            assert_eq!(ts.shell.save_all_files(s, g, id).err(), NOT_FOUND, "{id}");
        }
        assert_eq!(ts.dialogs.opened(), dialogs, "no picker for any of them");

        ts.dialogs.answer(None);
        let answer = ts.shell.save_all_files(s, g, &full).unwrap();
        assert_eq!((answer.session, answer.generation), (s, g));
        assert!(matches!(answer.data, Outcome::Dismissed));
        assert_eq!(ts.shell.sessions.pending().len(), 0);

        // A folder in the trash is no folder to save.
        ts.shell
            .sessions
            .write(s, g, |vault, _| {
                Ok(vault.delete_collection(&ItemId::from_hex(&full).unwrap())?)
            })
            .unwrap();
        assert_eq!(ts.shell.save_all_files(s, g, &full).err(), NOT_FOUND);
    }

    /// The command is refused for a stale generation (`Locked`) and a session that is not ours (`NotFound`) before the
    /// picker, a plan's start for the stale generation of a choice parked by another path and for a choice that was
    /// never given, and a read-only session may save all.
    #[test]
    fn save_all_refused_stale_foreign() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(&ts, s, g, &[("a.txt", bytes(3, 1))]);
        let dest = destination(&ts, "Out");
        let dialogs = ts.dialogs.opened();
        let foreign = SessionId(s.0 + 100);
        for (session, generation, wanted) in [(s, g + 1, LOCKED), (foreign, g, NOT_FOUND)] {
            assert_eq!(
                ts.shell.save_all_files(session, generation, &folder).err(),
                wanted
            );
        }
        assert_eq!(ts.dialogs.opened(), dialogs, "no picker before the check");

        // A plan of a generation the session has left, and of a session that is not there: the start is refused.
        let parked = |session: SessionId, generation: u64| {
            ts.shell.sessions.pending().put(PendingChoice::SaveAll {
                session,
                generation,
                folder: ItemId::from_hex(&folder).unwrap(),
                dest: dest.clone(),
                files: vec![(ItemId::random(), lockbox_core::ids::FileId::random())],
            })
        };
        let stale = parked(s, g + 1);
        assert_eq!(ts.shell.save_all_start(&stale, 1).err(), LOCKED);
        let strange = parked(foreign, g);
        assert_eq!(ts.shell.save_all_start(&strange, 1).err(), NOT_FOUND);
        let never: Token =
            serde_json::from_value(Value::String(["0123456789abcdef"; 2].concat())).unwrap();
        assert_eq!(ts.shell.save_all_start(&never, 1).err(), EXPIRED);
        assert_eq!(
            ts.shell.save_all_files_confirm(&never).err(),
            EXPIRED,
            "the cloud question's yes too"
        );
        assert!(ts.events.started().is_empty());
        assert!(names(&dest).is_empty());

        // A read-only session saves all, as it saves a copy.
        let (r, gr) = read_only_session(&ts);
        let view = save_all(&ts, r, gr, &folder, &dest);
        assert_eq!(saved_names(&view), ["a.txt"]);
        assert_eq!(fs::read(dest.join("a.txt")).unwrap(), bytes(3, 1));
    }

    /// The same, from a vault opened read-only, in full: two files and an attached one, a taken name and a stop-free run.
    #[test]
    fn works_on_a_read_only_vault() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(&ts, s, g, &[("a.txt", bytes(3, 1)), ("b.txt", bytes(4, 2))]);
        note_with(&ts, (s, g), &folder, "Note", "c.txt", &bytes(5, 3));
        let (r, gr) = read_only_session(&ts);
        let dest = destination(&ts, "Out");
        fs::write(dest.join("b.txt"), b"OLD").unwrap();
        let view = save_all(&ts, r, gr, &folder, &dest);
        assert_eq!(saved_names(&view), ["a.txt", "b (2).txt", "c.txt"]);
        assert_eq!(fs::read(dest.join("b.txt")).unwrap(), b"OLD");
        assert_eq!(fs::read(dest.join("b (2).txt")).unwrap(), bytes(4, 2));
        assert_eq!(fs::read(dest.join("c.txt")).unwrap(), bytes(5, 3));
        assert_eq!(view["stopped"], Value::Null);
        let busy = ts.events.busy();
        assert!(busy.contains(&(Some(r), vec!["save_all"])), "{busy:?}");
    }

    /// The plan's checks: the state folder (also reached through a link or in another case) and a vault's folder are
    /// refused with nothing parked, written or journaled, and a folder that cannot be found is no folder.
    #[test]
    fn state_folder_and_vault_folder_refused() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(&ts, s, g, &[("a.txt", bytes(3, 1))]);
        let paths = ts.shell.paths.clone();
        fs::create_dir_all(&paths.open).unwrap();
        let link = ts.temp.path().join("state link");
        make_dir_link(&link, &paths.root);
        let shouting = PathBuf::from(paths.root.to_string_lossy().to_uppercase());
        for dir in [&paths.root, &paths.open, &link, &shouting] {
            ts.dialogs.answer(Some(dir.clone()));
            assert_eq!(
                ts.shell.save_all_files(s, g, &folder).err(),
                Some(ShellError::InvalidInput {
                    what: "state folder"
                })
            );
        }
        let vault_dir = ts.shell.registry.entries()[0].1.clone();
        let inside = vault_dir.join("files");
        let another = ts.folder("Another vault");
        fs::write(another.join("vault.json"), b"not really").unwrap();
        for dir in [
            vault_dir.clone(),
            inside,
            another.clone(),
            another.join("below"),
        ] {
            fs::create_dir_all(&dir).unwrap();
            ts.dialogs.answer(Some(dir.clone()));
            let refused = ts.shell.save_all_files(s, g, &folder).err();
            assert!(
                matches!(refused, Some(ShellError::Core(view)) if view.kind == "invalid_input"
                    && matches!(view.what, Some("destination in a vault folder" | "destination inside vault"))),
                "{refused:?}"
            );
        }
        ts.dialogs.answer(Some(ts.temp.path().join("not there")));
        assert!(ts.shell.save_all_files(s, g, &folder).is_err());
        assert_eq!(ts.shell.sessions.pending().len(), 0);
        assert!(!paths.outputs.exists(), "no journal change");
        assert!(names(&paths.open).is_empty());

        // The start runs them again: a plan parked for the state folder, one for a vault's folder, and a plan whose folder
        // became a vault's after it was made.
        let parked = |dest: &Path| {
            ts.shell.sessions.pending().put(PendingChoice::SaveAll {
                session: s,
                generation: g,
                folder: ItemId::from_hex(&folder).unwrap(),
                dest: dest.to_path_buf(),
                files: stored(&ts, s, g, &folder)
                    .into_iter()
                    .map(|(_, item, file)| {
                        (
                            ItemId::from_hex(&item).unwrap(),
                            lockbox_core::ids::FileId::from_hex(&file).unwrap(),
                        )
                    })
                    .collect(),
            })
        };
        let state = parked(&paths.root);
        assert_eq!(
            ts.shell.save_all_start(&state, 1).err(),
            Some(ShellError::InvalidInput {
                what: "state folder"
            })
        );
        let vault = parked(&vault_dir);
        assert!(matches!(
            ts.shell.save_all_start(&vault, 1).err(),
            Some(ShellError::Core(view)) if view.what == Some("destination in a vault folder")
        ));
        let dest = destination(&ts, "Out");
        let plan = plan_in(&ts, s, g, &folder, &dest);
        fs::write(dest.join("vault.json"), b"not really").unwrap();
        assert!(matches!(
            ts.shell.save_all_start(&plan.choice, 1).err(),
            Some(ShellError::Core(view)) if view.what == Some("destination in a vault folder")
        ));
        assert_eq!(names(&dest), ["vault.json"], "nothing was written");
        assert!(ts.events.started().is_empty(), "refused before the job");
        assert!(!paths.outputs.exists());
    }

    /// A damaged output journal refuses before the picker opens, and again at the start of a plan made before it was
    /// damaged: nothing is written, no job begins.
    #[test]
    fn damaged_output_journal_refuses() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(&ts, s, g, &[("a.txt", bytes(3, 1))]);
        let dest = destination(&ts, "Out");
        let plan = plan_in(&ts, s, g, &folder, &dest);
        fs::create_dir_all(&ts.shell.paths.root).unwrap();
        fs::write(&ts.shell.paths.outputs, "garbage, not a journal").unwrap();
        let damaged = Some(ShellError::from(CoreError::Damaged {
            what: crate::outputs::WHAT,
        }));
        let dialogs = ts.dialogs.opened();
        assert_eq!(ts.shell.save_all_files(s, g, &folder).err(), damaged);
        assert_eq!(ts.dialogs.opened(), dialogs, "refused before the picker");
        assert_eq!(ts.shell.save_all_start(&plan.choice, 1).err(), damaged);
        assert!(names(&dest).is_empty());
        assert!(ts.events.started().is_empty());
        // Resetting the journal makes the same plan work again: the refusal did not use it up.
        ts.shell.outputs.reset().unwrap();
        let view = serde_json::to_value(done(ts.shell.save_all_start(&plan.choice, 1))).unwrap();
        assert_eq!(saved_names(&view), ["a.txt"]);
    }

    /// Free space for the whole batch is checked before anything starts, with the numbers: three files that each fit
    /// alone are refused together at the plan and again at the start, nothing is written or journaled and no job begins;
    /// one byte more room goes ahead.
    #[test]
    fn no_space_for_the_batch_refused_first_with_numbers() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let sizes = [30 * MIB, 30 * MIB + 5, 30 * MIB + 9];
        let files: Vec<(&str, Vec<u8>)> = ["a.bin", "b.bin", "c.bin"]
            .into_iter()
            .zip(sizes)
            .map(|(name, size)| (name, bytes(size, 1)))
            .collect();
        let folder = folder_with(&ts, s, g, &files);
        let dest = destination(&ts, "Out");
        let total: u64 = sizes.iter().sum();
        let margin = 64 * MIB;
        let volume = |free: Option<u64>| {
            set_volume_override(Some(VolumeInfo {
                free_bytes: free,
                max_file_bytes: None,
            }))
        };
        volume(Some(total + margin - 1));
        ts.dialogs.answer(Some(dest.clone()));
        assert_eq!(
            ts.shell.save_all_files(s, g, &folder).err(),
            Some(ShellError::from(CoreError::NotEnoughSpace {
                needed: total + margin,
                available: total + margin - 1
            }))
        );
        assert_eq!(ts.shell.sessions.pending().len(), 0);

        volume(Some(total + margin));
        let plan = plan_in(&ts, s, g, &folder, &dest);
        volume(Some(total + margin - 1));
        let refused = ts.shell.save_all_start(&plan.choice, 1).err();
        assert!(
            matches!(refused, Some(ShellError::Core(view)) if view.kind == "not_enough_space"
                && view.needed == Some(total + margin) && view.available == Some(total + margin - 1)),
            "{refused:?}"
        );
        assert!(names(&dest).is_empty() && !ts.shell.paths.outputs.exists());
        assert!(ts.events.started().is_empty(), "no job began");
        volume(Some(total + margin));
        let view = serde_json::to_value(done(ts.shell.save_all_start(&plan.choice, 1))).unwrap();
        assert_eq!(saved_names(&view).len(), 3, "the refusal left the plan");
    }

    /// A volume whose free space cannot be read never blocks: the batch goes ahead.
    #[test]
    fn save_all_unknown_free_space_goes_ahead() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(&ts, s, g, &[("a.txt", bytes(3, 1)), ("b.txt", bytes(4, 2))]);
        let dest = destination(&ts, "Out");
        set_volume_override(Some(VolumeInfo {
            free_bytes: None,
            max_file_bytes: None,
        }));
        let view = save_all(&ts, s, g, &folder, &dest);
        assert_eq!(saved_names(&view), ["a.txt", "b.txt"]);
    }

    // ---- never overwriting ----

    /// A name that is taken is never replaced: the copy is "report (2).pdf", the file that was there is byte for byte
    /// as it was, and the summary says which name changed and which did not.
    #[test]
    fn existing_file_is_never_replaced() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(
            &ts,
            s,
            g,
            &[("report.pdf", bytes(40, 1)), ("notes.txt", bytes(30, 2))],
        );
        let dest = destination(&ts, "Out");
        fs::write(dest.join("report.pdf"), b"OLD CONTENTS").unwrap();
        fs::write(dest.join("report (2).pdf"), b"OLD TOO").unwrap();
        let view = save_all(&ts, s, g, &folder, &dest);
        assert_eq!(saved_names(&view), ["notes.txt", "report (3).pdf"]);
        assert_eq!(fs::read(dest.join("report.pdf")).unwrap(), b"OLD CONTENTS");
        assert_eq!(fs::read(dest.join("report (2).pdf")).unwrap(), b"OLD TOO");
        assert_eq!(fs::read(dest.join("report (3).pdf")).unwrap(), bytes(40, 1));
        assert_eq!(fs::read(dest.join("notes.txt")).unwrap(), bytes(30, 2));
        assert_eq!(
            view["renamed"],
            json!([{ "from": "report.pdf", "to": "report (3).pdf" }])
        );
        assert_eq!(
            names(&dest),
            [
                "notes.txt",
                "report (2).pdf",
                "report (3).pdf",
                "report.pdf"
            ]
        );
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    /// A file that appears between the check and the move is safe, for the batch as for one file: the copy goes to the
    /// next name and the other program's file is untouched.
    #[test]
    fn a_file_appearing_at_the_last_moment_gets_a_new_name() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(&ts, s, g, &[("a.txt", bytes(3, 1)), ("b.txt", bytes(4, 2))]);
        let dest = destination(&ts, "Out");
        let plan = plan_in(&ts, s, g, &folder, &dest);
        let arrived = dest.join("b.txt");
        let (made, seen) = (Rc::new(RefCell::new(0)), Rc::new(RefCell::new(0)));
        let (count, squat, wrote) = (Rc::clone(&seen), arrived.clone(), Rc::clone(&made));
        failpoint::observe(
            "export.before_publish",
            Box::new(move || {
                *count.borrow_mut() += 1;
                // Right before the second file's move.
                if *count.borrow() == 2 {
                    assert!(!squat.exists(), "the name was free when it was checked");
                    fs::write(&squat, b"ARRIVED").unwrap();
                    *wrote.borrow_mut() += 1;
                }
            }),
        );
        let view = serde_json::to_value(done(ts.shell.save_all_start(&plan.choice, 1))).unwrap();
        assert_eq!(*made.borrow(), 1, "the file arrived during the batch");
        assert_eq!(saved_names(&view), ["a.txt", "b (2).txt"]);
        assert_eq!(fs::read(&arrived).unwrap(), b"ARRIVED");
        assert_eq!(fs::read(dest.join("b (2).txt")).unwrap(), bytes(4, 2));
        assert_eq!(
            view["renamed"],
            json!([{ "from": "b.txt", "to": "b (2).txt" }])
        );
        assert_eq!(names(&dest), ["a.txt", "b (2).txt", "b.txt"]);
    }

    /// Three stored files that share one name get one name each, with no question for any: `a.txt`, `a (2).txt`,
    /// `a (3).txt`, each with its own contents, and the summary lists the two that changed.
    #[test]
    fn same_names_in_one_folder_get_numbers() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let contents = [bytes(5, 1), bytes(6, 2), bytes(7, 3)];
        let files: Vec<(&str, Vec<u8>)> = contents.iter().map(|c| ("a.txt", c.clone())).collect();
        let folder = folder_with(&ts, s, g, &files);
        let dest = destination(&ts, "Out");
        let view = save_all(&ts, s, g, &folder, &dest);
        let mut saved = saved_names(&view);
        saved.sort();
        assert_eq!(saved, ["a (2).txt", "a (3).txt", "a.txt"]);
        let mut got: Vec<Vec<u8>> = ["a.txt", "a (2).txt", "a (3).txt"]
            .iter()
            .map(|name| fs::read(dest.join(name)).unwrap())
            .collect();
        got.sort();
        let mut wanted = contents.to_vec();
        wanted.sort();
        assert_eq!(got, wanted, "each stored file came out once");
        let renamed = view["renamed"].as_array().unwrap();
        assert_eq!(renamed.len(), 2);
        assert!(renamed.iter().all(|r| r["from"] == json!("a.txt")));
        // Names that differ only in case are the same name to Windows.
        let again = folder_with(
            &ts,
            s,
            g,
            &[("Report.PDF", bytes(3, 1)), ("report.pdf", bytes(4, 2))],
        );
        let dest = destination(&ts, "Out 2");
        let view = save_all(&ts, s, g, &again, &dest);
        assert_eq!(saved_names(&view).len(), 2);
        assert_eq!(names(&dest).len(), 2);
    }

    /// Numbering stops at 999: the file is refused as "destination exists" and the batch goes on, and nothing that was
    /// there is touched. The refused file is named with the ones not saved.
    #[test]
    fn numbering_stops_at_999_and_the_batch_goes_on() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(&ts, s, g, &[("r.txt", bytes(3, 1)), ("z.txt", bytes(4, 2))]);
        let dest = destination(&ts, "Out");
        fs::write(dest.join("r.txt"), b"1").unwrap();
        for number in 2..=999 {
            fs::write(dest.join(format!("r ({number}).txt")), b"x").unwrap();
        }
        let view = save_all(&ts, s, g, &folder, &dest);
        assert_eq!(saved_names(&view), ["z.txt"]);
        assert_eq!(texts(&view["not_started"]), ["r.txt"]);
        assert_eq!(view["stopped"], Value::Null, "the batch went on");
        assert_eq!(fs::read(dest.join("r.txt")).unwrap(), b"1");
        assert_eq!(names(&dest).len(), 1000, "999 old files and z.txt, no temp");
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    /// A stored name Windows would change is changed, and the summary lists each change: a device name, a trailing dot.
    /// Ordinary punctuation is left as the person wrote it, and the plan shows the names as they will be saved.
    #[test]
    fn changed_names_are_listed_in_renamed() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(
            &ts,
            s,
            g,
            &[
                ("CON.txt", bytes(3, 1)),
                ("notes.", bytes(4, 2)),
                ("Report, final & signed #2.pdf", bytes(5, 3)),
            ],
        );
        let dest = destination(&ts, "Out");
        let plan = plan_in(&ts, s, g, &folder, &dest);
        let planned: Vec<String> = plan.files.iter().map(|f| f.name.clone()).collect();
        assert_eq!(
            planned,
            ["_CON.txt", "notes", "Report, final & signed #2.pdf"]
        );
        let view = serde_json::to_value(done(ts.shell.save_all_start(&plan.choice, 1))).unwrap();
        assert_eq!(
            saved_names(&view),
            ["_CON.txt", "notes", "Report, final & signed #2.pdf"]
        );
        assert_eq!(
            view["renamed"],
            json!([
                { "from": "CON.txt", "to": "_CON.txt" },
                { "from": "notes.", "to": "notes" }
            ])
        );
        assert_eq!(
            names(&dest),
            ["Report, final & signed #2.pdf", "_CON.txt", "notes"]
        );
    }

    // ---- a stop, a lock, a damaged file, a full drive, a file that went ----

    /// The save at the second file's last step, then `then` runs on the engine's thread.
    fn at_second_file(then: impl FnOnce() + 'static) {
        let (count, then) = (Rc::new(RefCell::new(0)), Rc::new(RefCell::new(Some(then))));
        failpoint::observe(
            "export.before_publish",
            Box::new(move || {
                *count.borrow_mut() += 1;
                if *count.borrow() == 2
                    && let Some(then) = then.borrow_mut().take()
                {
                    then();
                }
            }),
        );
    }

    /// A Stop while the second of three files is being written: the first stays whole, the second leaves nothing (no
    /// partial, no journal entry), the third was never started, and the summary says all of it.
    #[test]
    fn stop_keeps_finished_files_and_leaves_no_partial() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(
            &ts,
            s,
            g,
            &[
                ("a.txt", bytes(3, 1)),
                ("b.txt", bytes(4, 2)),
                ("c.txt", bytes(5, 3)),
            ],
        );
        let dest = destination(&ts, "Out");
        let plan = plan_in(&ts, s, g, &folder, &dest);
        let (shell, events) = (Arc::clone(&ts.shell), Arc::clone(&ts.events));
        at_second_file(move || stop_job(&shell, &events.started()[0]));
        let view = serde_json::to_value(done(ts.shell.save_all_start(&plan.choice, 7))).unwrap();
        assert_eq!(saved_names(&view), ["a.txt"]);
        assert_eq!(view["unfinished"], json!("b.txt"));
        assert_eq!(texts(&view["not_started"]), ["c.txt"]);
        assert_eq!(view["stopped"], json!({ "code": "cancelled" }));
        assert_eq!(names(&dest), ["a.txt"], "no partial, no later file");
        assert_eq!(fs::read(dest.join("a.txt")).unwrap(), bytes(3, 1));
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
        let (_, progress) = the_save_all_job(&ts, 7);
        assert_eq!(progress.last().unwrap()["finished"], json!(true));
        // The session is still working: the same plan saves again, from a new pick.
        let again = destination(&ts, "Again");
        let view = save_all(&ts, s, g, &folder, &again);
        assert_eq!(saved_names(&view).len(), 3);
    }

    /// A Stop between two files (the job's token is already cancelled when the next one's turn comes) is no half-made
    /// file at all: the one before stays, and the rest were never started.
    #[test]
    fn a_stop_between_files_names_the_rest_as_not_started() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(&ts, s, g, &[("a.txt", bytes(3, 1)), ("b.txt", bytes(4, 2))]);
        let dest = destination(&ts, "Out");
        let plan = plan_in(&ts, s, g, &folder, &dest);
        let (shell, events) = (Arc::clone(&ts.shell), Arc::clone(&ts.events));
        after_each_file(move |index| {
            if index == 0 {
                stop_job(&shell, &events.started()[0]);
            }
        });
        let view = serde_json::to_value(done(ts.shell.save_all_start(&plan.choice, 1))).unwrap();
        assert_eq!(saved_names(&view), ["a.txt"]);
        assert_eq!(view["unfinished"], Value::Null);
        assert_eq!(texts(&view["not_started"]), ["b.txt"]);
        assert_eq!(view["stopped"], json!({ "code": "cancelled" }));
        assert_eq!(names(&dest), ["a.txt"]);
    }

    /// A lock while the second file is being written answers `Locked`, no summary: the first file stays whole, the second
    /// leaves nothing, and the journal is empty.
    #[test]
    fn a_lock_keeps_finished_files_and_leaves_no_partial() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(&ts, s, g, &[("a.txt", bytes(3, 1)), ("b.txt", bytes(4, 2))]);
        let dest = destination(&ts, "Out");
        let plan = plan_in(&ts, s, g, &folder, &dest);
        let shell = Arc::clone(&ts.shell);
        at_second_file(move || shell.sessions.lock_all(LockReason::Manual));
        assert_eq!(ts.shell.save_all_start(&plan.choice, 1).err(), LOCKED);
        assert_eq!(names(&dest), ["a.txt"]);
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
        assert_eq!(ts.shell.sessions.pending().len(), 0, "no summary handle");
        // A lock between two files too.
        let (s, g) = ts.open_vault("Again");
        let folder = folder_with(&ts, s, g, &[("a.txt", bytes(3, 1)), ("b.txt", bytes(4, 2))]);
        let dest = destination(&ts, "Out 2");
        let plan = plan_in(&ts, s, g, &folder, &dest);
        let shell = Arc::clone(&ts.shell);
        after_each_file(move |index| {
            if index == 0 {
                shell.sessions.lock_all(LockReason::Manual)
            }
        });
        assert_eq!(ts.shell.save_all_start(&plan.choice, 1).err(), LOCKED);
        assert_eq!(names(&dest), ["a.txt"]);
    }

    /// A file that does not decrypt is named and the rest go on: nothing half-made is left of it, the summary lists it
    /// with the ones saved, and the bar still ends at its total.
    #[test]
    fn damaged_file_is_named_and_the_rest_continue() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(
            &ts,
            s,
            g,
            &[
                ("a.txt", bytes(3, 1)),
                ("b.bin", bytes(2 * MIB, 2)),
                ("c.txt", bytes(5, 3)),
            ],
        );
        let vault_dir = ts.shell.registry.entries()[0].1.clone();
        let (_, _, damaged) = stored(&ts, s, g, &folder)
            .into_iter()
            .find(|(name, _, _)| name == "b.bin")
            .unwrap();
        let blob = vault_dir.join("files").join(format!("{damaged}.blob"));
        flip_byte(&blob, fs::metadata(&blob).unwrap().len() / 2).unwrap();
        let dest = destination(&ts, "Out");
        let view = save_all(&ts, s, g, &folder, &dest);
        assert_eq!(saved_names(&view), ["a.txt", "c.txt"]);
        assert_eq!(texts(&view["damaged"]), ["b.bin"]);
        assert_eq!(view["stopped"], Value::Null);
        assert_eq!(view["unfinished"], Value::Null);
        assert_eq!(names(&dest), ["a.txt", "c.txt"], "nothing half-made");
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
        let (_, progress) = the_save_all_job(&ts, 1);
        let last = progress.last().unwrap();
        assert_eq!(
            (last["finished"].clone(), last["done"].clone()),
            (json!(true), last["total"].clone())
        );

        // A blob that is gone is as damaged as one that is changed.
        fs::remove_file(&blob).unwrap();
        let again = destination(&ts, "Again");
        let view = save_all(&ts, s, g, &folder, &again);
        assert_eq!(texts(&view["damaged"]), ["b.bin"]);
        assert_eq!(saved_names(&view), ["a.txt", "c.txt"]);
    }

    /// A drive that fills partway ends the batch, saying how many were saved: the one that could not be written leaves
    /// nothing, and it and the rest are named. The refusal is the engine's, with its numbers.
    #[test]
    fn full_drive_ends_the_job_and_says_how_many() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(
            &ts,
            s,
            g,
            &[
                ("a.txt", bytes(3, 1)),
                ("b.txt", bytes(4, 2)),
                ("c.txt", bytes(5, 3)),
            ],
        );
        let dest = destination(&ts, "Out");
        let plan = plan_in(&ts, s, g, &folder, &dest);
        // The drive fills as the first file is written: the second one's own check refuses.
        let filled = Rc::new(RefCell::new(false));
        let once = Rc::clone(&filled);
        failpoint::observe(
            "export.before_publish",
            Box::new(move || {
                if !*once.borrow() {
                    *once.borrow_mut() = true;
                    set_volume_override(Some(VolumeInfo {
                        free_bytes: Some(1),
                        max_file_bytes: None,
                    }));
                }
            }),
        );
        let view = serde_json::to_value(done(ts.shell.save_all_start(&plan.choice, 1))).unwrap();
        assert_eq!(saved_names(&view), ["a.txt"]);
        assert_eq!(view["unfinished"], json!("b.txt"));
        assert_eq!(texts(&view["not_started"]), ["c.txt"]);
        assert_eq!(
            view["stopped"],
            json!({
                "code": "core", "kind": "not_enough_space",
                "needed": 4 + 64 * MIB, "available": 1
            })
        );
        assert_eq!(names(&dest), ["a.txt"]);
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    /// A file whose item is trashed or deleted while the batch runs is listed in `gone` and the batch goes on; the files
    /// already saved are untouched and the bar still ends at its total.
    #[test]
    fn a_file_removed_during_the_batch_is_listed_as_gone() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(
            &ts,
            s,
            g,
            &[
                ("a.txt", bytes(3, 1)),
                ("b.txt", bytes(4, 2)),
                ("c.txt", bytes(5, 3)),
                ("d.txt", bytes(6, 4)),
            ],
        );
        let dest = destination(&ts, "Out");
        let plan = plan_in(&ts, s, g, &folder, &dest);
        let found = stored(&ts, s, g, &folder);
        let item_of =
            |name: &str| ItemId::from_hex(&found.iter().find(|f| f.0 == name).unwrap().1).unwrap();
        let (b, c) = (item_of("b.txt"), item_of("c.txt"));
        let shell = Arc::clone(&ts.shell);
        after_each_file(move |index| {
            if index == 0 {
                // b is trashed, c is trashed and then deleted for good.
                shell
                    .sessions
                    .write(s, g, |vault, _| Ok(vault.trash_item(&b)?))
                    .unwrap();
                shell
                    .sessions
                    .write(s, g, |vault, _| Ok(vault.trash_item(&c)?))
                    .unwrap();
                shell
                    .sessions
                    .write(s, g, |vault, _| Ok(vault.purge_item(&c)?))
                    .unwrap();
            }
        });
        let view = serde_json::to_value(done(ts.shell.save_all_start(&plan.choice, 1))).unwrap();
        assert_eq!(saved_names(&view), ["a.txt", "d.txt"]);
        assert_eq!(texts(&view["gone"]), ["b.txt", "c.txt"]);
        assert_eq!(view["stopped"], Value::Null);
        assert_eq!(names(&dest), ["a.txt", "d.txt"]);
        let (_, progress) = the_save_all_job(&ts, 1);
        let last = progress.last().unwrap();
        assert_eq!(last["done"], last["total"]);
        assert_eq!(last["total"], json!(18));
    }

    /// The vault is let go between files, so a change from another command lands in the middle of a batch instead of
    /// waiting for the whole of it.
    #[test]
    fn the_vault_is_let_go_between_files() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(&ts, s, g, &[("a.txt", bytes(3, 1)), ("b.txt", bytes(4, 2))]);
        let dest = destination(&ts, "Out");
        let plan = plan_in(&ts, s, g, &folder, &dest);
        let shell = Arc::clone(&ts.shell);
        let wrote = Rc::new(RefCell::new(None));
        let result = Rc::clone(&wrote);
        after_each_file(move |index| {
            if index == 0 {
                let added = shell.sessions.write(s, g, |vault, _| {
                    Ok(vault.new_item(ItemKind::Note, "Between", None)?.to_hex())
                });
                *result.borrow_mut() = Some(added.is_ok());
            }
        });
        let view = serde_json::to_value(done(ts.shell.save_all_start(&plan.choice, 1))).unwrap();
        assert_eq!(
            *wrote.borrow(),
            Some(true),
            "a change got in between two files"
        );
        assert_eq!(saved_names(&view), ["a.txt", "b.txt"]);
    }

    /// A failure right after a file's move (the step `export.after_publish`, armed here) cannot take the copy back or
    /// hide it: the file stays and is in the summary, and the batch goes on.
    #[test]
    fn a_failure_right_after_publication_counts_the_file_as_saved() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(&ts, s, g, &[("a.txt", bytes(3, 1)), ("b.txt", bytes(4, 2))]);
        let dest = destination(&ts, "Out");
        failpoint::arm("export.after_publish");
        let view = save_all(&ts, s, g, &folder, &dest);
        assert_eq!(saved_names(&view), ["a.txt", "b.txt"]);
        assert_eq!(view["stopped"], Value::Null);
        assert_eq!(fs::read(dest.join("a.txt")).unwrap(), bytes(3, 1));
        assert_eq!(fs::read(dest.join("b.txt")).unwrap(), bytes(4, 2));
        assert_eq!(names(&dest), ["a.txt", "b.txt"]);
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    // ---- the output journal and the gate ----

    /// Each file's temp is written down in the output journal before it exists and cleared once the file is published; a
    /// temp a crash left behind (listed, in the chosen folder) is found and removed by the launch sweep.
    #[test]
    fn temp_files_recorded_in_the_output_journal_and_swept() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(&ts, s, g, &[("a.txt", bytes(3, 1)), ("b.txt", bytes(4, 2))]);
        let dest = destination(&ts, "Out");
        let (journal, folder_seen) = (ts.shell.paths.outputs.clone(), dest.clone());
        let seen = Rc::new(RefCell::new(Vec::new()));
        let record = Rc::clone(&seen);
        failpoint::observe(
            "export.before_publish",
            Box::new(move || {
                let entries = journal_at(&journal);
                // One entry: this file's temp, in the chosen folder, which is already there.
                assert_eq!(entries.len(), 1, "{entries:?}");
                assert_eq!(entries[0].parent().unwrap(), folder_seen);
                assert!(
                    entries[0]
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .ends_with(".lockbox-partial")
                );
                record.borrow_mut().push(entries[0].exists());
            }),
        );
        save_all(&ts, s, g, &folder, &dest);
        assert_eq!(*seen.borrow(), [true, true]);
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());

        // A crash after the entry was written and the temp made: the next launch's sweep removes it.
        let leftover = dest.join(".0123456789abcdef.lockbox-partial");
        fs::write(&leftover, b"half a file").unwrap();
        fs::write(
            &ts.shell.paths.outputs,
            serde_json::to_vec(&json!({ "version": 1, "entries": [leftover] })).unwrap(),
        )
        .unwrap();
        ts.shell.sweep_outputs();
        assert!(!leftover.exists());
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    /// The temp is held by another program (a virus scan) as the second file is published: the engine waits between
    /// attempts outside the gate, so a lock that lands during the wait returns at once and refuses the next attempt. The
    /// first file stays, the second leaves nothing, and the answer is `Locked`.
    #[test]
    fn a_held_destination_waits_outside_the_gate() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(&ts, s, g, &[("a.txt", bytes(3, 1)), ("b.txt", bytes(4, 2))]);
        let dest = destination(&ts, "Out");
        let plan = plan_in(&ts, s, g, &folder, &dest);
        // The second file's temp, once it is finished, is held with no sharing.
        let held = Arc::new(Mutex::new(None));
        let (journal, hold) = (ts.shell.paths.outputs.clone(), Arc::clone(&held));
        at_second_file(move || {
            let temp = journal_at(&journal).pop().unwrap();
            let file = OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(temp)
                .unwrap();
            *hold.lock().unwrap() = Some(file);
        });
        let (waiting, waiting_rx) = mpsc::channel();
        let (locked, locked_rx) = mpsc::channel::<()>();
        let mut first_wait = Some((waiting, locked_rx));
        failpoint::observe(
            "publish.retry_wait",
            Box::new(move || {
                if let Some((waiting, locked)) = first_wait.take() {
                    waiting.send(Instant::now()).unwrap();
                    locked.recv_timeout(GIVE_UP).expect("the locker locked");
                }
            }),
        );
        let shell = Arc::clone(&ts.shell);
        let locker = thread::spawn(move || {
            waiting_rx
                .recv_timeout(GIVE_UP)
                .expect("the engine waited between attempts");
            let started = Instant::now();
            shell.sessions.lock_all(LockReason::Manual);
            let took = started.elapsed();
            drop(held.lock().unwrap().take());
            locked.send(()).unwrap();
            took
        });
        let answer = ts.shell.save_all_start(&plan.choice, 1);
        let took = locker.join().unwrap();
        assert_eq!(answer.err(), LOCKED);
        assert!(took < Duration::from_millis(250), "the lock took {took:?}");
        assert_eq!(
            names(&dest),
            ["a.txt"],
            "the first file stays, the second left nothing"
        );
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    /// The temp is held by another program as the second file is published (the engine waits before the next attempt), a
    /// Stop comes during that wait and the hold is then let go, so the next move would work. The job's token is looked
    /// at inside every attempt, so the second file is not published: it is the unfinished one, the third was never
    /// started, nothing half-made is left, and the summary is a Stop, not a normal end.
    #[test]
    fn a_stop_during_a_retry_wait_publishes_nothing() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(
            &ts,
            s,
            g,
            &[
                ("a.txt", bytes(3, 1)),
                ("b.txt", bytes(4, 2)),
                ("c.txt", bytes(5, 3)),
            ],
        );
        let dest = destination(&ts, "Out");
        let plan = plan_in(&ts, s, g, &folder, &dest);
        let held = Arc::new(Mutex::new(None));
        let (journal, hold) = (ts.shell.paths.outputs.clone(), Arc::clone(&held));
        at_second_file(move || {
            let temp = journal_at(&journal).pop().unwrap();
            let file = OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(temp)
                .unwrap();
            *hold.lock().unwrap() = Some(file);
        });
        let (shell, events) = (Arc::clone(&ts.shell), Arc::clone(&ts.events));
        let mut waits = 0;
        failpoint::observe(
            "publish.retry_wait",
            Box::new(move || {
                waits += 1;
                if waits == 1 {
                    stop_job(&shell, &events.started()[0]);
                    drop(held.lock().unwrap().take());
                }
            }),
        );
        let view = serde_json::to_value(done(ts.shell.save_all_start(&plan.choice, 3))).unwrap();
        assert_eq!(saved_names(&view), ["a.txt"]);
        assert_eq!(view["unfinished"], json!("b.txt"));
        assert_eq!(texts(&view["not_started"]), ["c.txt"]);
        assert_eq!(view["stopped"], json!({ "code": "cancelled" }));
        assert_eq!(names(&dest), ["a.txt"], "the second file never appeared");
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    /// The journal's gate fails after a file's move succeeded (its contract allows it; armed here through a test step):
    /// the file is on disk, so it is in `saved` under its final name and is no unfinished file, and the gate's error ends
    /// the batch as `stopped` with the rest as not started; the move was not tried again and nothing was removed.
    #[test]
    fn a_gate_error_after_the_move_counts_the_file_as_saved() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(
            &ts,
            s,
            g,
            &[
                ("a.txt", bytes(3, 1)),
                ("b.txt", bytes(4, 2)),
                ("c.txt", bytes(5, 3)),
            ],
        );
        let dest = destination(&ts, "Out");
        fs::write(dest.join("b.txt"), b"OLD").unwrap();
        let plan = plan_in(&ts, s, g, &folder, &dest);
        // The first file is moved without a fault; the gate fails right after the second file's one successful move.
        let (count, nth) = (Rc::new(RefCell::new(0)), Rc::new(RefCell::new(0)));
        let (counting, armed_at) = (Rc::clone(&count), Rc::clone(&nth));
        failpoint::observe(
            "export.before_publish",
            Box::new(move || {
                *counting.borrow_mut() += 1;
                if *counting.borrow() == 2 {
                    failpoint::arm("outputs.after_attempt");
                    *armed_at.borrow_mut() += 1;
                }
            }),
        );
        let view = serde_json::to_value(done(ts.shell.save_all_start(&plan.choice, 1))).unwrap();
        assert_eq!(*nth.borrow(), 1);
        assert_eq!(
            saved_names(&view),
            ["a.txt", "b (2).txt"],
            "the second file counts, under its final name"
        );
        assert_eq!(view["unfinished"], Value::Null);
        assert_eq!(texts(&view["not_started"]), ["c.txt"]);
        assert_eq!(
            view["stopped"],
            json!({ "code": "invalid_input", "what": "gate" })
        );
        assert_eq!(
            view["renamed"],
            json!([{ "from": "b.txt", "to": "b (2).txt" }])
        );
        assert_eq!(names(&dest), ["a.txt", "b (2).txt", "b.txt"]);
        assert_eq!(fs::read(dest.join("b (2).txt")).unwrap(), bytes(4, 2));
        assert_eq!(fs::read(dest.join("b.txt")).unwrap(), b"OLD");
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
        let (_, progress) = the_save_all_job(&ts, 1);
        assert_eq!(progress.last().unwrap()["finished"], json!(true));
    }

    /// The drive fills while the second file is being written (the write that is its second chunk fails as a full drive
    /// does, the free space being unknown): the batch ends with the full-drive refusal, in the shape the page's words
    /// use, with what the engine knows (`needed` the file and the slack kept free, `available` 0 as it is not known);
    /// the first file stays, the second leaves nothing and is the unfinished one, the third was never started.
    #[test]
    fn a_drive_that_fills_mid_file_ends_the_batch_with_the_full_drive_refusal() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let big = 2 * MIB + 7;
        let folder = folder_with(
            &ts,
            s,
            g,
            &[
                ("a.txt", bytes(3, 1)),
                ("b.bin", bytes(big, 2)),
                ("c.txt", bytes(5, 3)),
            ],
        );
        let dest = destination(&ts, "Out");
        let plan = plan_in(&ts, s, g, &folder, &dest);
        set_volume_override(Some(VolumeInfo {
            free_bytes: None,
            max_file_bytes: None,
        }));
        let count = Rc::new(RefCell::new(0));
        failpoint::observe(
            "export.after_record",
            Box::new(move || {
                *count.borrow_mut() += 1;
                if *count.borrow() == 2 {
                    failpoint::arm_disk_full("export.write");
                }
            }),
        );
        let view = serde_json::to_value(done(ts.shell.save_all_start(&plan.choice, 1))).unwrap();
        assert_eq!(saved_names(&view), ["a.txt"]);
        assert_eq!(view["unfinished"], json!("b.bin"));
        assert_eq!(texts(&view["not_started"]), ["c.txt"]);
        assert_eq!(
            view["stopped"],
            json!({
                "code": "core", "kind": "not_enough_space",
                "needed": big + 64 * MIB, "available": 0
            })
        );
        assert_eq!(names(&dest), ["a.txt"], "no partial, no later file");
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    // ---- the cloud question ----

    /// A folder a cloud provider syncs asks first, after the picker and before anything is read, decrypted or written:
    /// the answer is the question with a token, nothing is written, no job begins, and a folder no provider syncs is not
    /// asked about.
    #[test]
    fn save_all_cloud_folder_warns_first() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(&ts, s, g, &[("a.txt", bytes(3, 1))]);
        let synced = destination(&ts, "Synced");
        ts.volumes.add_sync_root(&synced);
        ts.dialogs.answer(Some(synced.clone()));
        let asked = ts.shell.save_all_files(s, g, &folder).unwrap();
        assert!(matches!(
            asked.data,
            Outcome::Confirm(Confirm::CloudFolder { .. })
        ));
        assert_eq!((asked.session, asked.generation), (s, g));
        assert!(names(&synced).is_empty());
        assert!(ts.events.started().is_empty() && ts.events.busy().is_empty());
        assert!(!ts.shell.paths.outputs.exists());
        assert_eq!(ts.dialogs.opened(), 1);
        let plain = destination(&ts, "Plain");
        let plan = plan_in(&ts, s, g, &folder, &plain);
        assert_eq!(
            plan.files.len(),
            1,
            "a folder no provider syncs is not asked about"
        );
    }

    /// Asks for the cloud question about the folder the cloud tests use: its token.
    fn cloud_token(ts: &TestShell, s: SessionId, g: u64, folder: &str, dest: &Path) -> Token {
        ts.dialogs.answer(Some(dest.to_path_buf()));
        let Ok(Tagged {
            data: Outcome::Confirm(Confirm::CloudFolder { token }),
            ..
        }) = ts.shell.save_all_files(s, g, folder)
        else {
            panic!("a cloud folder asks first");
        };
        token
    }

    /// The yes answers the same plan as a folder that needs no question, with no second picker; the plan's own token
    /// then starts the job, writing in the folder that was asked about. The question's token is used up.
    #[test]
    fn save_all_confirm_yes_writes() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(&ts, s, g, &[("a.txt", bytes(3, 1)), ("b.txt", bytes(4, 2))]);
        let synced = destination(&ts, "Synced");
        ts.volumes.add_sync_root(&synced);
        let token = cloud_token(&ts, s, g, &folder, &synced);
        let plan = done(ts.shell.save_all_files_confirm(&token));
        assert_eq!(plan.files.len(), 2);
        assert_eq!(plan.total, 7);
        assert_eq!(ts.dialogs.opened(), 1, "no second picker");
        assert!(names(&synced).is_empty(), "the yes writes nothing yet");
        assert_eq!(
            ts.shell.save_all_files_confirm(&token).err(),
            EXPIRED,
            "the question is used up"
        );
        let view = serde_json::to_value(done(ts.shell.save_all_start(&plan.choice, 1))).unwrap();
        assert_eq!(saved_names(&view), ["a.txt", "b.txt"]);
        assert_eq!(names(&synced), ["a.txt", "b.txt"]);
        // The question's own token is no plan: it cannot start the job without the yes.
        let again = cloud_token(&ts, s, g, &folder, &synced);
        assert_eq!(ts.shell.save_all_start(&again, 2).err(), EXPIRED);
        let on_a_read_only = read_only_session(&ts);
        let ro_token = cloud_token(
            &ts,
            on_a_read_only.0,
            on_a_read_only.1,
            &folder,
            &destination(&ts, "Synced"),
        );
        assert!(matches!(
            ts.shell.save_all_files_confirm(&ro_token).unwrap().data,
            Outcome::Done(_)
        ));
    }

    /// The yes is checked afresh: a folder that became a vault's while the question waited, a journal damaged since, and a
    /// folder that has no files any more are each refused by the shell with nothing written and no job begun.
    #[test]
    fn save_all_confirm_checks_again_on_yes() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(&ts, s, g, &[("a.txt", bytes(3, 1))]);
        let synced = destination(&ts, "Synced");
        ts.volumes.add_sync_root(&synced);

        let token = cloud_token(&ts, s, g, &folder, &synced);
        fs::write(synced.join("vault.json"), b"not really").unwrap();
        assert!(matches!(
            ts.shell.save_all_files_confirm(&token).err(),
            Some(ShellError::Core(view)) if view.what == Some("destination in a vault folder")
        ));
        fs::remove_file(synced.join("vault.json")).unwrap();

        let token = cloud_token(&ts, s, g, &folder, &synced);
        fs::create_dir_all(&ts.shell.paths.root).unwrap();
        fs::write(&ts.shell.paths.outputs, "garbage").unwrap();
        assert_eq!(
            ts.shell.save_all_files_confirm(&token).err(),
            Some(ShellError::from(CoreError::Damaged {
                what: crate::outputs::WHAT
            }))
        );
        ts.shell.outputs.reset().unwrap();

        let token = cloud_token(&ts, s, g, &folder, &synced);
        let (id, _) = (stored(&ts, s, g, &folder)[0].1.clone(), ());
        ts.shell
            .sessions
            .write(s, g, |vault, _| {
                Ok(vault.trash_item(&ItemId::from_hex(&id).unwrap())?)
            })
            .unwrap();
        assert_eq!(
            ts.shell.save_all_files_confirm(&token).err(),
            Some(ShellError::InvalidInput { what: "no files" })
        );
        assert!(names(&synced).is_empty());
        assert!(ts.events.started().is_empty());
    }

    /// A lock of the vault that asked drops the question at once (a lock of another leaves it), as Lock all does; the yes
    /// then finds nothing, even after the vault is unlocked again.
    #[test]
    fn save_all_confirm_dropped_at_lock() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(&ts, s, g, &[("a.txt", bytes(3, 1))]);
        let synced = destination(&ts, "Synced");
        ts.volumes.add_sync_root(&synced);
        let token = cloud_token(&ts, s, g, &folder, &synced);
        let (other, _) = ts.open_vault("Work");
        assert_eq!(ts.shell.sessions.pending().len(), 1);
        ts.shell.sessions.lock(other, LockReason::Manual);
        assert_eq!(ts.shell.sessions.pending().len(), 1, "another vault's lock");
        ts.shell.sessions.lock(s, LockReason::Manual);
        assert_eq!(ts.shell.sessions.pending().len(), 0, "its own lock");
        assert_eq!(ts.shell.save_all_files_confirm(&token).err(), EXPIRED);

        let (s2, g2) = ts.open_vault("Again");
        let folder2 = folder_with(&ts, s2, g2, &[("a.txt", bytes(3, 1))]);
        let token = cloud_token(&ts, s2, g2, &folder2, &synced);
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert_eq!(ts.shell.save_all_files_confirm(&token).err(), EXPIRED);
        assert!(names(&synced).is_empty());
    }

    /// The confirming command takes a token and nothing else: one never given, one used, one of another question (it
    /// stays parked), and a plan's own token (a plan is not a question) are each `ChoiceExpired`, with nothing written.
    #[test]
    fn save_all_confirm_refuses_a_used_or_foreign_token() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(&ts, s, g, &[("a.txt", bytes(3, 1))]);
        let synced = destination(&ts, "Synced");
        ts.volumes.add_sync_root(&synced);
        let made_up: Token =
            serde_json::from_value(Value::String(["0123456789abcdef"; 2].concat())).unwrap();
        assert_eq!(ts.shell.save_all_files_confirm(&made_up).err(), EXPIRED);

        let other = ts.shell.sessions.pending().put(PendingChoice::AddVault {
            dir: ts.temp.path().to_path_buf(),
        });
        assert_eq!(ts.shell.save_all_files_confirm(&other).err(), EXPIRED);
        assert_eq!(
            ts.shell.sessions.pending().len(),
            1,
            "the other question stays"
        );

        let plain = destination(&ts, "Plain");
        let plan = plan_in(&ts, s, g, &folder, &plain);
        assert_eq!(ts.shell.save_all_files_confirm(&plan.choice).err(), EXPIRED);
        // The plan the confirm refused is still there.
        assert_eq!(ts.shell.sessions.pending().len(), 2);
        let view = serde_json::to_value(done(ts.shell.save_all_start(&plan.choice, 1))).unwrap();
        assert_eq!(saved_names(&view), ["a.txt"]);
        // Used: the plan cannot start twice.
        assert_eq!(ts.shell.save_all_start(&plan.choice, 2).err(), EXPIRED);
        assert_eq!(names(&plain), ["a.txt"]);

        let token = cloud_token(&ts, s, g, &folder, &synced);
        assert!(done(ts.shell.save_all_files_confirm(&token)).total > 0);
        assert_eq!(ts.shell.save_all_files_confirm(&token).err(), EXPIRED);
        // Another command's token is no question of this one either.
        assert_eq!(ts.shell.save_file_copy_confirm(&token, 1).err(), NOT_FOUND);
    }

    // ---- the plan's start ----

    /// The files of the folder are checked again at the start: one added, one removed or one replaced since the plan makes
    /// `{"code":"invalid_input","what":"folder changed"}`, with nothing written, no job begun and the plan kept; a new
    /// plan then works. A file renamed since changes nothing.
    #[test]
    fn a_changed_folder_refuses_the_start() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(&ts, s, g, &[("a.txt", bytes(3, 1)), ("b.txt", bytes(4, 2))]);
        let dest = destination(&ts, "Out");
        let plan = plan_in(&ts, s, g, &folder, &dest);
        let found = stored(&ts, s, g, &folder);
        let b = ItemId::from_hex(&found[1].1).unwrap();
        // A rename changes no file.
        ts.shell
            .sessions
            .write(s, g, |vault, _| {
                let mut item = vault.get_item(&b)?.clone();
                item.title = "renamed".to_owned();
                Ok(vault.update_item(item)?)
            })
            .unwrap();
        let changed = note_with(&ts, (s, g), &folder, "New", "new.txt", b"new");
        let refused = ts.shell.save_all_start(&plan.choice, 1).err();
        assert_eq!(
            refused,
            Some(ShellError::InvalidInput {
                what: "folder changed"
            })
        );
        assert_eq!(
            serde_json::to_value(refused.unwrap()).unwrap(),
            json!({ "code": "invalid_input", "what": "folder changed" })
        );
        assert!(names(&dest).is_empty() && ts.events.started().is_empty());
        // The plan is still parked (a refusal does not use it up), and refuses again.
        assert_eq!(ts.shell.sessions.pending().len(), 1);
        // Removing what was added makes the plan right again.
        ts.shell
            .sessions
            .write(s, g, |vault, _| {
                let id = ItemId::from_hex(&changed).unwrap();
                vault.trash_item(&id)?;
                Ok(vault.purge_item(&id)?)
            })
            .unwrap();
        let view = serde_json::to_value(done(ts.shell.save_all_start(&plan.choice, 1))).unwrap();
        assert_eq!(saved_names(&view), ["a.txt", "b.txt"]);
    }

    // ---- progress ----

    /// One job for the whole batch: `job-started` of kind `save_all` with the page's number, then progress that never goes
    /// back or past the total (every file's bytes together), ends finished at the total; the busy list says `save_all`.
    #[test]
    fn save_all_job_progress_ends_at_the_total() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let sizes = [3 * MIB + 5, 5, 2 * MIB + 9];
        let files: Vec<(&str, Vec<u8>)> = ["a.bin", "b.bin", "c.bin"]
            .into_iter()
            .zip(sizes)
            .map(|(name, size)| (name, bytes(size, 1)))
            .collect();
        let folder = folder_with(&ts, s, g, &files);
        let dest = destination(&ts, "Out");
        let plan = plan_in(&ts, s, g, &folder, &dest);
        assert_eq!(plan.total, sizes.iter().sum::<u64>());
        let view = done(ts.shell.save_all_start(&plan.choice, 41));
        assert_eq!(view.saved.len(), 3);
        let (started, progress) = the_save_all_job(&ts, 41);
        assert_eq!(
            started["scope"],
            json!({ "type": "session", "session": s.0, "generation": g })
        );
        assert!(progress.len() >= 2, "{progress:?}");
        assert!(
            progress
                .iter()
                .all(|event| event["kind"] == json!("save_all"))
        );
        assert!(
            progress
                .iter()
                .all(|event| event["total"] == json!(plan.total))
        );
        let done_bytes: Vec<u64> = progress
            .iter()
            .map(|e| e["done"].as_u64().unwrap())
            .collect();
        assert!(
            done_bytes.windows(2).all(|pair| pair[0] <= pair[1]),
            "{done_bytes:?}"
        );
        assert!(done_bytes.iter().all(|done| *done <= plan.total));
        let (last, earlier) = progress.split_last().unwrap();
        assert!(earlier.iter().all(|e| e["finished"] == json!(false)));
        assert_eq!(
            (last["finished"].clone(), last["done"].clone()),
            (json!(true), json!(plan.total))
        );
        assert!(
            ts.events.busy().contains(&(Some(s), vec!["save_all"])),
            "{:?}",
            ts.events.busy()
        );
        assert!(
            ts.events
                .job_events()
                .iter()
                .filter(|(name, _)| *name == PROGRESS_EVENT)
                .all(|(_, event)| event["kind"] == json!("save_all")),
            "every progress event of the batch is the batch's"
        );
    }

    // ---- the summary's handle ----

    /// The summary's handle opens only the folder the files were saved in, through the launcher: no command takes a path,
    /// the handle can be used again, and a failed launch is an `io` refusal that names nothing.
    #[test]
    fn show_in_explorer_takes_only_the_handle() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(&ts, s, g, &[("a.txt", bytes(3, 1))]);
        let dest = destination(&ts, "Out");
        let view = done({
            let plan = plan_in(&ts, s, g, &folder, &dest);
            ts.shell.save_all_start(&plan.choice, 1)
        });
        assert_eq!(view.folder_shown, shown(&dest));
        ts.shell.show_output_in_explorer(&view.output).unwrap();
        ts.shell.show_output_in_explorer(&view.output).unwrap();
        assert_eq!(ts.launcher.opened_folders(), [dest.clone(), dest.clone()]);
        ts.launcher.fail_next_folder();
        let failed = ts.shell.show_output_in_explorer(&view.output).err();
        assert_eq!(failed, Some(ShellError::from(std::io::Error::other("x"))));
        assert_eq!(
            serde_json::to_value(failed.unwrap()).unwrap(),
            json!({ "code": "core", "kind": "io" })
        );
        // No other kind of token opens a folder, and a handle that was never given does not either.
        let plan = plan_in(&ts, s, g, &folder, &dest);
        let made_up: Token =
            serde_json::from_value(Value::String(["0123456789abcdef"; 2].concat())).unwrap();
        for token in [&plan.choice, &made_up] {
            assert_eq!(ts.shell.show_output_in_explorer(token).err(), EXPIRED);
        }
        assert_eq!(ts.launcher.opened_folders().len(), 3);
        // The handle is not the plan: it cannot start a job.
        assert_eq!(ts.shell.save_all_start(&view.output, 3).err(), EXPIRED);
    }

    /// Closing the summary drops the handle (closing it again, or a handle never given, is no error), and Show in
    /// Explorer then says the handle is gone.
    #[test]
    fn show_in_explorer_after_close_output_is_choice_expired() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(&ts, s, g, &[("a.txt", bytes(3, 1))]);
        let dest = destination(&ts, "Out");
        let plan = plan_in(&ts, s, g, &folder, &dest);
        let view = done(ts.shell.save_all_start(&plan.choice, 1));
        let other = plan_in(&ts, s, g, &folder, &dest);
        ts.shell.close_output(&other.choice).unwrap();
        assert_eq!(
            ts.shell.sessions.pending().len(),
            2,
            "a plan is no handle: closing it closes nothing"
        );
        ts.shell.close_output(&view.output).unwrap();
        ts.shell.close_output(&view.output).unwrap();
        assert_eq!(
            ts.shell.show_output_in_explorer(&view.output).err(),
            EXPIRED
        );
        assert!(ts.launcher.opened_folders().is_empty());
        assert_eq!(ts.shell.sessions.pending().len(), 1);
    }

    /// The handle is dropped by a lock of its vault (a lock of another leaves it), by Lock all and by a lock from Windows;
    /// a plan not yet started goes the same way, so the start finds nothing.
    #[test]
    fn the_choice_is_dropped_by_a_lock_of_its_vault() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(&ts, s, g, &[("a.txt", bytes(3, 1))]);
        let dest = destination(&ts, "Out");
        let (other, go) = ts.open_vault("Work");
        let theirs = folder_with(&ts, other, go, &[("t.txt", bytes(3, 1))]);
        let their_plan = plan_in(&ts, other, go, &theirs, &destination(&ts, "Theirs"));

        let plan = plan_in(&ts, s, g, &folder, &dest);
        let view = done(ts.shell.save_all_start(&plan.choice, 1));
        let waiting = plan_in(&ts, s, g, &folder, &dest);
        assert_eq!(ts.shell.sessions.pending().len(), 3);
        ts.shell.sessions.lock(s, LockReason::Manual);
        assert_eq!(
            ts.shell.sessions.pending().len(),
            1,
            "only the other vault's plan is left"
        );
        assert_eq!(
            ts.shell.show_output_in_explorer(&view.output).err(),
            EXPIRED
        );
        assert_eq!(ts.shell.save_all_start(&waiting.choice, 1).err(), EXPIRED);
        assert!(ts.launcher.opened_folders().is_empty());
        assert!(
            ts.shell.save_all_start(&their_plan.choice, 2).is_ok(),
            "another vault's plan survived"
        );

        // Windows locking or sleeping, and Lock all, drop every handle.
        for (n, reason) in [
            LockReason::Manual,
            LockReason::WindowsLocked,
            LockReason::Sleep,
            LockReason::AppClosing,
        ]
        .into_iter()
        .enumerate()
        {
            let (session, generation) = ts.open_vault(&format!("Next {n}"));
            let folder = folder_with(&ts, session, generation, &[("c.txt", bytes(3, 1))]);
            let out = destination(&ts, &format!("Next out {n}"));
            let plan = plan_in(&ts, session, generation, &folder, &out);
            let view = done(ts.shell.save_all_start(&plan.choice, 3));
            let waiting = plan_in(&ts, session, generation, &folder, &out);
            ts.shell.sessions.lock_all(reason);
            assert_eq!(
                ts.shell.show_output_in_explorer(&view.output).err(),
                EXPIRED,
                "{reason:?}"
            );
            assert_eq!(
                ts.shell.save_all_start(&waiting.choice, 3).err(),
                EXPIRED,
                "{reason:?}"
            );
            assert_eq!(ts.shell.sessions.pending().len(), 0, "{reason:?}");
        }
    }

    // ---- the commands' bodies ----

    fn refuses_a_path<T: serde::de::DeserializeOwned>(body: Value) {
        assert!(
            parse::<T>(&InvokeBody::Json(body.clone())).is_ok(),
            "{body}"
        );
        let mut sneaked = body;
        sneaked["path"] = json!("SENTINEL-7f3a");
        assert_eq!(
            parse::<T>(&InvokeBody::Json(sneaked)).err(),
            Some(MALFORMED)
        );
    }

    /// None of the five takes a path, and each needs exactly what it is given: a start needs the page's `request` number.
    #[test]
    fn no_save_all_command_takes_a_path() {
        let id = "0123456789abcdef0123456789abcdef";
        refuses_a_path::<SaveAllFilesArgs>(json!({ "session": 1, "generation": 1, "folder": id }));
        refuses_a_path::<ConfirmArgs>(json!({ "token": id }));
        refuses_a_path::<StartArgs>(json!({ "choice": id, "request": 1 }));
        refuses_a_path::<OutputArgs>(json!({ "output": id }));
        let parses = |body: Value| parse::<StartArgs>(&InvokeBody::Json(body)).is_ok();
        assert!(
            !parses(json!({ "choice": id })),
            "a start needs its request"
        );
        for bad in [
            json!(-1),
            json!(4294967296u64),
            json!("5"),
            json!(1.5),
            json!(null),
        ] {
            assert!(!parses(json!({ "choice": id, "request": bad })));
        }
        assert!(parses(json!({ "choice": id, "request": u32::MAX })));
        // A token is exactly 32 lowercase hex characters.
        assert!(
            !parse::<OutputArgs>(&InvokeBody::Json(json!({ "output": "C:\\Users\\x" }))).is_ok()
        );
        assert!(!parse::<ConfirmArgs>(&InvokeBody::Json(json!({ "token": "short" }))).is_ok());
    }

    /// The summary's shape, as the page reads it.
    #[test]
    fn the_summary_has_the_frozen_shape() {
        let ts = TestShell::new();
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(&ts, s, g, &[("a.txt", bytes(3, 1))]);
        note_with(&ts, (s, g), &folder, "Tax note", "w2.pdf", &bytes(7, 3));
        let dest = destination(&ts, "Out");
        let view = save_all(&ts, s, g, &folder, &dest);
        let mut keys: Vec<&str> = view
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "damaged",
                "folder_shown",
                "gone",
                "not_started",
                "output",
                "renamed",
                "saved",
                "stopped",
                "unfinished"
            ]
        );
        assert_eq!(
            view["saved"],
            json!([
                { "name": "a.txt", "size": 3, "attached_to": null },
                { "name": "w2.pdf", "size": 7, "attached_to": "Tax note" }
            ])
        );
        assert_eq!(view["renamed"], json!([]));
        assert_eq!(
            (view["damaged"].clone(), view["gone"].clone()),
            (json!([]), json!([]))
        );
        assert_eq!(view["stopped"], Value::Null);
        assert_eq!(view["unfinished"], Value::Null);
        assert_eq!(view["not_started"], json!([]));
        assert_eq!(view["folder_shown"], json!(shown(&dest)));
        assert!(!view["folder_shown"].as_str().unwrap().starts_with(r"\\?\"));
        assert!(view["output"].as_str().is_some_and(|t| t.len() == 32));
        // Nothing of a path but the shown folder, which is display text.
        assert!(
            !view
                .to_string()
                .contains(&dest.join("a.txt").to_string_lossy().replace('\\', "\\\\"))
        );
    }

    /// Numbers go before the last extension, the base is cut so the whole stays within 100 characters, and a name that is
    /// all extension or has an extension too long to keep is numbered at its end.
    #[test]
    fn numbered_names() {
        assert_eq!(numbered("a.txt", 1), "a.txt");
        assert_eq!(numbered("a.txt", 2), "a (2).txt");
        assert_eq!(numbered("a.tar.gz", 3), "a.tar (3).gz");
        assert_eq!(numbered("noext", 4), "noext (4)");
        assert_eq!(numbered(".env", 2), ".env (2)");
        assert_eq!(numbered("Report, final.pdf", 12), "Report, final (12).pdf");
        let long = format!("{}.pdf", "a".repeat(96));
        let cut = numbered(&long, 999);
        assert_eq!(cut.chars().count(), 100);
        assert_eq!(cut, format!("{} (999).pdf", "a".repeat(90)));
        let unkeepable = format!("x.{}", "e".repeat(98));
        let cut = numbered(&unkeepable, 2);
        assert_eq!(cut.chars().count(), 100);
        assert!(cut.ends_with(" (2)"), "{cut}");
        let accented = format!("{}.pdf", "é".repeat(96));
        assert_eq!(numbered(&accented, 2).chars().count(), 100);
        for number in 2..=999 {
            let name = numbered(&long, number);
            assert!(
                name.chars().count() <= 100 && !name.ends_with(['.', ' ']),
                "{name}"
            );
        }
    }

    /// The busy wait is the one Task 10 uses (the shared module): a file whose turn comes while another command holds the
    /// vault waits for it, tried again every 50 ms by the shell's clock, and goes on once it is free; nothing is skipped.
    #[test]
    fn a_batch_waits_for_a_busy_vault_between_files() {
        let ts = TestShell::new();
        let _cleanup = Cleanup;
        let (s, g) = ts.open_vault("Family");
        let folder = folder_with(&ts, s, g, &[("a.txt", bytes(3, 1)), ("b.txt", bytes(4, 2))]);
        let dest = destination(&ts, "Out");
        let plan = plan_in(&ts, s, g, &folder, &dest);
        // Another command (an import) takes the vault when the first file is done: the second waits, and the hold is let go
        // at the third try.
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let release_rx = Arc::new(Mutex::new(Some(release_rx)));
        let release_tx = Rc::new(RefCell::new(Some(release_tx)));
        let holder: Rc<RefCell<Option<thread::JoinHandle<()>>>> = Rc::default();
        {
            let (shell, holder, release_rx) = (
                Arc::clone(&ts.shell),
                Rc::clone(&holder),
                Arc::clone(&release_rx),
            );
            after_each_file(move |index| {
                if index != 0 {
                    return;
                }
                let (running, running_rx) = mpsc::channel::<()>();
                let (shell, release_rx) = (Arc::clone(&shell), Arc::clone(&release_rx));
                *holder.borrow_mut() = Some(thread::spawn(move || {
                    let release = release_rx.lock().unwrap().take().unwrap();
                    let _ = shell.sessions.write_long(s, g, |_, _| {
                        running.send(()).unwrap();
                        release.recv_timeout(GIVE_UP).ok();
                        Ok(())
                    });
                }));
                running_rx.recv_timeout(GIVE_UP).unwrap();
            });
        }
        let retries = Rc::new(RefCell::new(Vec::new()));
        {
            let (retries, release_tx, holder) = (
                Rc::clone(&retries),
                Rc::clone(&release_tx),
                Rc::clone(&holder),
            );
            at_retry(move |tries| {
                retries.borrow_mut().push(tries);
                if tries == 3
                    && let Some(release) = release_tx.borrow_mut().take()
                {
                    release.send(()).unwrap();
                    // Wait until the hold has really ended before the next try: the shell's test clock jumps on every
                    // wait, so on a slow machine the whole 30-second limit could pass before the holder thread ran
                    // (CI, 2026-11-17: the second file was refused as busy).
                    if let Some(handle) = holder.borrow_mut().take() {
                        handle.join().unwrap();
                    }
                }
            });
        }
        let before = ts.clock.now();
        let view = serde_json::to_value(done(ts.shell.save_all_start(&plan.choice, 1))).unwrap();
        assert!(
            holder.borrow().is_none(),
            "the hold was let go at the third try"
        );
        assert_eq!(saved_names(&view), ["a.txt", "b.txt"]);
        assert_eq!(view["stopped"], Value::Null);
        assert!(
            retries.borrow().starts_with(&[1, 2, 3]),
            "{:?}",
            retries.borrow()
        );
        assert!(
            ts.clock.now() - before >= Duration::from_millis(150),
            "the waits ran on the shell's clock"
        );
    }
}
