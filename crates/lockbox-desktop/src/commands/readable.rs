//! One way to write a readable file (spec §7.2, §7.4): a file that holds a secret in plain form (the recovery key's
//! PDF, a folder's keys as a `.env`) goes where the user picks, by Save a copy's rules. Rust opens the dialog, so no path crosses the page;
//! the output journal's checks run first (a damaged journal refuses), then the vault-folder and state-folder refusals,
//! then the cloud question; the file is made in a journaled temp beside the destination, and renamed into place only
//! while the session is still unlocked in the generation that asked. An existing file is untouched until then.
//!
//! The PDF is WebView2's print-to-PDF of the page as it shows, so the key reaches it only through the printed page, and
//! no command carries it. WebView2 refuses an existing hidden file and writes straight over the path it is given, so
//! the printer gets a new file inside a new hidden folder beside the destination, both with Lockbox's own temp names and
//! both written in the journal before they exist. The `.env` file's bytes are made in Rust (`commands::env`), written to
//! one journaled temp beside the destination and published the same way.

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use lockbox_core::blob::{CancelToken, OutputJournal};
use lockbox_core::fsio::{hidden_temp_path, publish_readable, refuse_vault_folder};
use lockbox_core::ids::ItemId;
use serde::Deserialize;
use tauri::State;
use tauri::ipc::Request;

use super::{NoArgs, args, blocking};
use crate::error::{
    Confirm, Outcome, PDF_NOT_MADE, PRINT_NOT_SENT, PRINTER_BUSY, PRINTER_GONE, ShellError,
    ShellResult,
};
use crate::locations::cloud_provider_of;
use crate::os::{PrintFailed, win};
use crate::outputs::{FOLDER_SUFFIX, LAUNCH_OPEN_TRIES};
use crate::pending::{PendingChoice, Token};
use crate::restore::shown;
use crate::session::{SessionId, Tagged, VaultRef};
use crate::shell::Shell;
use crate::views::{PrinterList, SavedView};

/// How long a print job waits for the printer's answer. WebView2 cannot cancel a print, so a lock does not stop one: the
/// job waits for the answer, to delete the file and folder the printer made, and only then goes on. A one-page PDF is
/// made in a second or two, so 30 seconds is long enough for a slow machine and short enough that a printer that never
/// answers does not hold a thread for ever. With no answer in that time, the file and the folder are left where they
/// are and stay in the output journal, and the next launch's sweep removes them.
pub const PRINT_ANSWER_WAIT: Duration = Duration::from_secs(30);

/// What the dialog's PDF filter is called, and the extension it shows.
const PDF_FILTER: (&str, &[&str]) = ("PDF", &["pdf"]);

/// A readable file to write: the dialog's title and suggested name, and what goes in it.
pub struct ReadableJob {
    /// The save dialog's title.
    pub title: &'static str,
    /// The name the dialog suggests.
    pub file_name: String,
    pub kind: ReadableKind,
}

/// What a [`ReadableJob`] writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadableKind {
    /// The recovery key's PDF: WebView2's print-to-PDF of the page as it shows.
    RecoveryPdf,
    /// A folder's keys as a `.env` file. It holds the folder's id and never any text: the keys are read again when the
    /// file is written, after the dialog and after a cloud folder's yes, so the file is what the folder holds then.
    EnvFile { collection: ItemId },
}

impl ReadableJob {
    /// The recovery key's PDF.
    pub fn recovery_pdf() -> ReadableJob {
        ReadableJob {
            title: "Save the recovery key as a PDF",
            file_name: "Lockbox recovery key.pdf".to_owned(),
            kind: ReadableKind::RecoveryPdf,
        }
    }

    /// The keys of the folder `collection` as a `.env` file.
    pub fn env_file(collection: ItemId) -> ReadableJob {
        ReadableJob {
            title: "Save the keys as a .env file",
            file_name: ".env".to_owned(),
            kind: ReadableKind::EnvFile { collection },
        }
    }

    /// The dialog's filter. A `.env` file has none: a filter makes Windows add its extension to a name typed without
    /// one, so the name the person keeps would not be the name written. With no filter the dialog adds nothing.
    fn filter(&self) -> Option<(&'static str, &'static [&'static str])> {
        match self.kind {
            ReadableKind::RecoveryPdf => Some(PDF_FILTER),
            ReadableKind::EnvFile { .. } => None,
        }
    }
}

impl Shell {
    /// Saves a readable file where the user picks. Refused first, before any dialog: for a session that is locked,
    /// stale or not ours (`Locked`, `NotFound`), for a read-only one (`ReadOnly`: a read-only copy never shows a
    /// recovery key), and while the output journal is damaged. The save dialog opens outside every lock (`Dismissed`
    /// when it is closed); the destination is then refused inside a vault folder or Lockbox's own state folder, and a
    /// folder a cloud provider syncs asks first (`Confirm::CloudFolder`), the job and destination parked for
    /// [`save_readable_confirm`](Self::save_readable_confirm). Nothing is written until the question is answered.
    pub fn save_readable(
        &self,
        session: SessionId,
        generation: u64,
        job: ReadableJob,
    ) -> ShellResult<Tagged<Outcome<SavedView>>> {
        self.live_writable(session, generation)?;
        self.outputs.usable()?;
        let Some(dest) = self
            .os
            .dialogs
            .save_file(job.title, &job.file_name, job.filter())
        else {
            return self.still_current(session, generation, Outcome::Dismissed);
        };
        self.write_readable(session, generation, job, &dest, false)
    }

    /// The user's yes to writing in a cloud folder: goes on with the job and destination parked before, for the session
    /// that asked (and only while it is still unlocked in the generation that asked). Everything is checked again, since
    /// the folder may have changed since.
    pub fn save_readable_confirm(&self, token: &Token) -> ShellResult<Tagged<Outcome<SavedView>>> {
        match self.sessions.pending().take(token)? {
            PendingChoice::Readable {
                session,
                generation,
                job,
                dest,
            } => self.write_readable(session, generation, job, &dest, true),
            // A token for another question: used up, and its choice dropped (no lock is held here).
            _ => Err(ShellError::NotFound),
        }
    }

    /// The printers Lockbox offers for the recovery key, read from Windows now: the ones that send a page to a device,
    /// not the ones that make a file through a box of their own (see
    /// [`InstalledPrinter::writes_a_file_of_its_own`](crate::os::InstalledPrinter::writes_a_file_of_its_own)), and the
    /// default only when it is among them. Needs no session: it holds nothing of a vault. Names are not put in an error
    /// (R5): a list Windows cannot give is one fixed error.
    pub fn list_printers(&self) -> ShellResult<PrinterList> {
        Ok(self.os.printer.installed_printers()?.offered())
    }

    /// Prints the recovery key's page straight to `printer`, with no Windows window, for the session that asked.
    /// Refused first as [`save_readable`](Self::save_readable) is (stale, foreign, read-only). Then `printer` must be
    /// one of the printers [`list_printers`](Self::list_printers) gives *now*, or `PRINTER_GONE` (a printer that writes
    /// a file through a box of its own is never among them, so it cannot be named here either). `PRINTER_BUSY` while a
    /// PDF or another print runs (the one printer is shared). The answer waits for WebView2's own: `Ok` when the printer
    /// took the job, `PRINT_NOT_SENT` for a refusal, any other status or no answer in time. A lock at any point
    /// answers `Locked` and the page shows no error; WebView2 cannot cancel a print, so a job already sent is the
    /// printer's. Lockbox writes no file on this path.
    pub fn print_recovery_key(
        &self,
        session: SessionId,
        generation: u64,
        printer: String,
    ) -> ShellResult<Tagged<()>> {
        let cancel = self.live_writable(session, generation)?;
        let listed = self.list_printers()?;
        // The list can take seconds (a network printer's server): a lock meanwhile must stop the print.
        if cancel.is_cancelled() {
            return Err(ShellError::Locked);
        }
        if !listed.printers.contains(&printer) {
            return Err(PRINTER_GONE);
        }
        // The session's token goes with the job: it is checked again right before WebView2 is asked.
        let answers = self.os.printer.print_to_printer(&printer, &cancel);
        let refused = match answers.recv_timeout(self.print_wait()) {
            Ok(Ok(())) => None,
            Ok(Err(PrintFailed::Busy)) => Some(PRINTER_BUSY),
            // Refused, ended without the printer taking it, or no answer in time.
            _ => Some(PRINT_NOT_SENT),
        };
        if cancel.is_cancelled() {
            return Err(ShellError::Locked);
        }
        match refused {
            Some(error) => Err(error),
            None => self.still_current(session, generation, ()),
        }
    }

    /// The session's cancel token (cancelled by its lock), once it is checked to be unlocked in `generation` and
    /// writable. The vault is let go at once: a print can take seconds, and a lock must not be held up by it.
    pub(super) fn live_writable(
        &self,
        session: SessionId,
        generation: u64,
    ) -> ShellResult<CancelToken> {
        let held = self
            .sessions
            .read(session, generation, |vault, cancel| match vault {
                VaultRef::Writable(_) => Ok(cancel.clone()),
                VaultRef::ReadOnly(_) => Err(ShellError::ReadOnly),
            })?;
        Ok(held.data)
    }

    /// The rest of a save, after the dialog or after a yes: the checks on the destination, the cloud question unless
    /// `cloud_confirmed`, then the write.
    fn write_readable(
        &self,
        session: SessionId,
        generation: u64,
        job: ReadableJob,
        dest: &Path,
        cloud_confirmed: bool,
    ) -> ShellResult<Tagged<Outcome<SavedView>>> {
        // Again: after the dialog, or after a yes, the session may have locked, and the journal may have been damaged.
        let cancel = self.live_writable(session, generation)?;
        self.outputs.usable()?;
        let dest = self.output_destination(dest)?;
        refuse_vault_folder(&dest)?;
        let folder = dest
            .parent()
            .ok_or(ShellError::InvalidInput { what: "file name" })?;
        if !cloud_confirmed
            && cloud_provider_of(self.os.volumes.as_ref(), self.os.env.as_ref(), folder)?.is_some()
        {
            let token = self.sessions.pending().put(PendingChoice::Readable {
                session,
                generation,
                job,
                dest,
            });
            return self.still_current(
                session,
                generation,
                Outcome::Confirm(Confirm::CloudFolder { token }),
            );
        }
        match job.kind {
            ReadableKind::RecoveryPdf => {
                self.write_recovery_pdf(session, generation, &cancel, &dest)
            }
            ReadableKind::EnvFile { collection } => {
                self.write_env_file(session, generation, &cancel, &dest, collection)
            }
        }
    }

    /// Prints the page to a new file in a new hidden folder beside `dest` and publishes it there. Both are written in
    /// the journal before they exist (the folder first, then the file in it, which WebView2 makes). The printer's answer
    /// is awaited for [`PRINT_ANSWER_WAIT`] (shorter in tests): a lock does not stop WebView2, so the file and the folder
    /// are deleted once it answers, and nothing reaches `dest`. With no answer the entries stay for the launch sweep.
    fn write_recovery_pdf(
        &self,
        session: SessionId,
        generation: u64,
        cancel: &CancelToken,
        dest: &Path,
    ) -> ShellResult<Tagged<Outcome<SavedView>>> {
        let docs = dest
            .parent()
            .ok_or(ShellError::InvalidInput { what: "file name" })?;
        let journal = self.outputs.for_call(&self.sessions, session, generation);
        let folder = hidden_temp_path(docs, FOLDER_SUFFIX);
        journal.finish(journal.record(&folder))?;
        if let Err(error) = fs::create_dir(&folder).and_then(|()| win::set_hidden(&folder)) {
            self.discard_pdf(&folder, None);
            return Err(error.into());
        }
        let file = hidden_temp_path(&folder, ".lockbox-partial");
        if let Err(error) = journal.finish(journal.record(&file)) {
            self.discard_pdf(&folder, None);
            return Err(error);
        }

        // A lock before WebView2 is asked stops the job there (the token goes with it: `PrintFailed::Revoked`, answered
        // `Locked`, only the journaled temp to clean). A lock after that cannot stop WebView2: wait for it, then clean up.
        let answers = self.os.printer.print_to_pdf(&file, cancel);
        let refused = match answers.recv_timeout(self.print_wait()) {
            Ok(Ok(())) => None,
            Ok(Err(PrintFailed::Busy)) => Some(PRINTER_BUSY),
            Ok(Err(_)) => Some(PDF_NOT_MADE),
            Err(_) => {
                // No answer (or the webview went first): the printer may still write. Both stay in the journal.
                return Err(locked_or(cancel, PDF_NOT_MADE));
            }
        };
        if let Some(error) = refused {
            self.discard_pdf(&folder, Some(&file));
            return Err(locked_or(cancel, error));
        }
        if cancel.is_cancelled() {
            self.discard_pdf(&folder, Some(&file));
            return Err(ShellError::Locked);
        }

        let published = journal.finish(publish_readable(&file, dest, |attempt| {
            journal.publish(attempt)
        }));
        if let Err(error) = published {
            // The move is the last thing that can fail before it happens; if the file is gone, it happened.
            let moved = fs::symlink_metadata(&file).is_err();
            self.discard_pdf(&folder, (!moved).then_some(file.as_path()));
            return Err(error);
        }
        journal.clear(&file);
        self.discard_pdf(&folder, None);
        let saved = SavedView {
            folder: shown(docs),
        };
        self.still_current(session, generation, Outcome::Done(saved))
    }

    /// Removes the PDF's temp `file` (when it may be there) and then its folder, by the launch sweep's own rules: no
    /// link on the way, Lockbox's own names, and the folder only while it is empty. What cannot be removed now stays in
    /// the journal for the next launch.
    fn discard_pdf(&self, folder: &Path, file: Option<&Path>) {
        let file_gone =
            file.is_none_or(|file| self.outputs.remove_leftover(file, LAUNCH_OPEN_TRIES));
        if file_gone {
            self.outputs.remove_leftover(folder, LAUNCH_OPEN_TRIES);
        }
    }

    /// How long a PDF or printer job waits for the printer's answer.
    fn print_wait(&self) -> Duration {
        #[cfg(test)]
        if let Some(wait) = *crate::lock(&self.print_wait) {
            return wait;
        }
        PRINT_ANSWER_WAIT
    }

    /// Tests only: a PDF job waits `wait` for the printer's answer, in place of [`PRINT_ANSWER_WAIT`].
    #[cfg(test)]
    pub(crate) fn set_print_wait(&self, wait: Duration) {
        *crate::lock(&self.print_wait) = Some(wait);
    }
}

/// `error`, unless the session locked meanwhile: a lock at any point is answered `Locked`, and the page shows no error.
fn locked_or(cancel: &CancelToken, error: ShellError) -> ShellError {
    match cancel.is_cancelled() {
        true => ShellError::Locked,
        false => error,
    }
}

/// `save_recovery_pdf`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionArgs {
    session: SessionId,
    generation: u64,
}

/// `print_recovery_key`: the printer is one of the names `list_printers` gave (checked again against a new list).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PrintArgs {
    session: SessionId,
    generation: u64,
    printer: String,
}

/// `save_readable_confirm`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfirmArgs {
    token: Token,
}

/// Saves the recovery key's PDF where the user picks (the page asks for nothing but the session: the key reaches the PDF
/// only through the printed page).
#[tauri::command]
pub(super) async fn save_recovery_pdf(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<Outcome<SavedView>>> {
    let SessionArgs {
        session,
        generation,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.save_readable(session, generation, ReadableJob::recovery_pdf())).await
}

#[tauri::command]
pub(super) async fn save_readable_confirm(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<Outcome<SavedView>>> {
    let ConfirmArgs { token } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.save_readable_confirm(&token)).await
}

/// The printers Lockbox offers for the recovery key, and the default one when it is among them. Reads Windows' list on
/// the blocking pool (a network printer's server can be slow to answer).
#[tauri::command]
pub(super) async fn list_printers(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<PrinterList> {
    let NoArgs {} = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.list_printers()).await
}

/// Prints the recovery key's page straight to the printer the person picked.
#[tauri::command]
pub(super) async fn print_recovery_key(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<()>> {
    let PrintArgs {
        session,
        generation,
        printer,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.print_recovery_key(session, generation, printer)).await
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, Instant};

    use lockbox_core::blob::CancelToken;
    use lockbox_core::internals::fsio::testutil::names;
    use lockbox_core::{CoreError, Credential, ReadOnlyVault};
    use serde_json::{Value, json};
    use tauri::ipc::InvokeBody;

    use super::super::{MALFORMED, parse};
    use super::*;
    use crate::error::{Confirm, PDF_NOT_MADE, PRINT_NOT_SENT, PRINTER_BUSY, PRINTER_GONE};
    use crate::os::{InstalledPrinter, PRINTER_ATTRIBUTE_FAX, PrintFailed};
    use crate::session::{Location, LockReason, OpenStep, Opened};
    use crate::testing::{TEST_PASSWORD, TestShell, heavy};

    /// How long a test thread waits for the other before it fails instead of hanging.
    const GIVE_UP: Duration = Duration::from_secs(60);
    const LOCKED: Option<ShellError> = Some(ShellError::Locked);
    /// What a finished print leaves in its file: a made-up stand-in for a PDF.
    const PDF: &[u8] = b"%PDF-1.7 a made-up stand-in";
    /// What is at the destination before the save.
    const OLD: &[u8] = b"the earlier pdf";
    const NAME: &str = "Lockbox recovery key.pdf";
    const FOLDER_SUFFIX: &str = ".lockbox-partial-folder";

    type Saved = ShellResult<Tagged<Outcome<SavedView>>>;

    /// An unlocked vault, and a `Documents` folder holding the earlier PDF: the session, its generation, and the
    /// destination the dialog will answer with.
    fn with_destination(ts: &TestShell) -> (SessionId, u64, PathBuf) {
        let (s, g) = ts.open_vault("Family");
        let dest = ts.folder("Documents").join(NAME);
        fs::write(&dest, OLD).unwrap();
        ts.print.write_on_success(PDF);
        (s, g, dest)
    }

    /// The save on a thread of its own, as the command's blocking pool runs it, once the printer has its job.
    fn saving(ts: &TestShell, s: SessionId, g: u64) -> JoinHandle<Saved> {
        let shell = Arc::clone(&ts.shell);
        let save = thread::spawn(move || shell.save_readable(s, g, ReadableJob::recovery_pdf()));
        wait_for_job(ts);
        save
    }

    /// Waits until the fake printer holds a job that has begun and not ended.
    fn wait_for_job(ts: &TestShell) {
        let until = Instant::now() + GIVE_UP;
        while ts.print.running() == 0 {
            assert!(Instant::now() < until, "the printer never got a job");
            thread::sleep(Duration::from_millis(2));
        }
    }

    fn joined(save: JoinHandle<Saved>) -> Saved {
        save.join().expect("the save did not panic")
    }

    /// The folder a finished save says it saved in.
    fn saved_in(answer: Saved) -> String {
        match answer {
            Ok(Tagged {
                data: Outcome::Done(view),
                ..
            }) => view.folder,
            Ok(_) => panic!("a question or a closed dialog, not a save"),
            Err(error) => panic!("refused: {error:?}"),
        }
    }

    /// Only the destination is in its folder: no temp, no folder; and nothing is left in the journal.
    fn nothing_left(ts: &TestShell, dest: &Path) {
        assert_eq!(names(dest.parent().unwrap()), [NAME]);
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    fn is_hex16(text: &str) -> bool {
        text.len() == 16 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    }

    /// A read-only session over the vault listed first: a backup or a pre-restore copy opens like this.
    fn read_only_session(ts: &TestShell) -> (SessionId, u64) {
        let dir = ts.shell.registry.entries()[0].1.clone();
        ts.shell.sessions.lock_all(LockReason::Manual);
        let vault = heavy(|| {
            ReadOnlyVault::open_folder(
                &dir,
                Credential::Password(TEST_PASSWORD),
                &CancelToken::new(),
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

    /// The printer gets a path that does not exist yet, inside a folder that is new and hidden, beside the
    /// destination; both are written in the journal before they exist, the folder first, and the page's save dialog
    /// is the job's: its title, the suggested name, and a PDF filter.
    #[test]
    fn printer_gets_a_new_file_in_a_new_hidden_folder() {
        let ts = TestShell::new();
        let (s, g, dest) = with_destination(&ts);
        let docs = dest.parent().unwrap().to_path_buf();
        ts.dialogs.answer(Some(dest.clone()));
        let save = saving(&ts, s, g);

        let started = ts.print.started();
        assert_eq!(started.len(), 1);
        let job = &started[0];
        assert!(!job.existed, "WebView2 makes the file itself");
        assert!(job.folder_hidden, "in a hidden folder");
        let folder = job.path.parent().unwrap();
        assert_eq!(
            folder.parent(),
            Some(docs.as_path()),
            "beside the destination"
        );
        let (folder_name, file_name) = (
            folder.file_name().unwrap().to_str().unwrap(),
            job.path.file_name().unwrap().to_str().unwrap(),
        );
        let folder_hex = folder_name
            .strip_prefix('.')
            .and_then(|n| n.strip_suffix(FOLDER_SUFFIX));
        assert!(folder_hex.is_some_and(is_hex16), "{folder_name}");
        let file_hex = file_name
            .strip_prefix('.')
            .and_then(|n| n.strip_suffix(".lockbox-partial"));
        assert!(file_hex.is_some_and(is_hex16), "{file_name}");
        assert_eq!(
            ts.journal(),
            [folder.to_path_buf(), job.path.clone()],
            "both written down, the folder first"
        );
        assert_eq!(
            fs::read(&dest).unwrap(),
            OLD,
            "the destination is untouched meanwhile"
        );

        assert!(ts.print.finish(Ok(())));
        joined(save).unwrap();
        assert_eq!(ts.dialogs.titles(), [ReadableJob::recovery_pdf().title]);
        assert_eq!(ts.dialogs.suggested(), [NAME]);
    }

    /// A finished print is renamed over the destination, the empty hidden folder is removed, the journal is empty,
    /// and the answer names the destination's folder as the user knows it (no `\\?\`).
    #[test]
    fn published_file_leaves_no_folder_behind() {
        let ts = TestShell::new();
        let (s, g, dest) = with_destination(&ts);
        ts.dialogs.answer(Some(dest.clone()));
        let save = saving(&ts, s, g);
        assert!(ts.print.finish(Ok(())));

        let answer = joined(save);
        let Ok(tagged) = &answer else {
            panic!("not saved");
        };
        assert_eq!((tagged.session, tagged.generation), (s, g));
        let docs = dest.parent().unwrap();
        assert_eq!(
            saved_in(answer),
            docs.to_str().unwrap().trim_start_matches(r"\\?\")
        );
        assert_eq!(
            fs::read(&dest).unwrap(),
            PDF,
            "the new PDF replaced the old"
        );
        nothing_left(&ts, &dest);
    }

    /// A lock while the page prints: the printer still ends (WebView2 cannot be cancelled) and writes its file in the
    /// hidden folder, which is deleted with the folder. The answer is `Locked`, the earlier file at the destination is
    /// as it was, and nothing else is beside it.
    #[test]
    fn lock_during_save_leaves_no_file_and_keeps_the_old_one() {
        let ts = TestShell::new();
        let (s, g, dest) = with_destination(&ts);
        ts.dialogs.answer(Some(dest.clone()));
        let save = saving(&ts, s, g);
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert!(ts.print.finish(Ok(())));

        assert_eq!(joined(save).err(), LOCKED);
        assert_eq!(fs::read(&dest).unwrap(), OLD);
        nothing_left(&ts, &dest);
    }

    /// The same for a new destination, with the printer answering well after the lock: no file ever appears there.
    #[test]
    fn late_print_after_lock_leaves_no_file() {
        let ts = TestShell::new();
        let (s, g, _) = with_destination(&ts);
        let dest = ts.folder("Elsewhere").join(NAME);
        ts.dialogs.answer(Some(dest.clone()));
        let save = saving(&ts, s, g);
        ts.shell.sessions.lock_all(LockReason::Manual);
        thread::sleep(Duration::from_millis(150));
        assert!(ts.print.finish(Ok(())));

        assert_eq!(joined(save).err(), LOCKED);
        assert!(!dest.exists(), "no file at the destination");
        assert!(
            names(dest.parent().unwrap()).is_empty(),
            "no temp, no folder"
        );
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
    }

    /// A printer that never answers: the job waits for it (a short time here) and gives up. The file and the folder
    /// are not deleted (the printer may still write), and both stay in the journal, so the next launch's sweep removes
    /// them, even a file written late. Nothing reaches the destination, and the earlier file is as it was.
    #[test]
    fn no_printer_answer_keeps_the_journal_entry() {
        let ts = TestShell::new();
        let (s, g, dest) = with_destination(&ts);
        ts.shell.set_print_wait(Duration::from_millis(100));
        ts.dialogs.answer(Some(dest.clone()));
        let started = Instant::now();
        let answer = ts.shell.save_readable(s, g, ReadableJob::recovery_pdf());
        assert!(started.elapsed() >= Duration::from_millis(100), "it waited");
        assert_eq!(answer.err(), Some(PDF_NOT_MADE));

        let listed = ts.journal();
        assert_eq!(listed.len(), 2, "folder and file stay listed");
        assert!(listed[0].is_dir());
        // The printer writes after all, as a slow one would.
        assert!(ts.print.finish(Ok(())));
        assert!(listed[1].is_file());
        assert_eq!(
            fs::read(&dest).unwrap(),
            OLD,
            "nothing reached the destination"
        );

        let report = ts.shell.sweep_outputs();
        assert_eq!(report.removed, 2);
        nothing_left(&ts, &dest);
        assert_eq!(fs::read(&dest).unwrap(), OLD);

        // With a lock meanwhile the answer is `Locked`, and the entries are kept in the same way.
        ts.dialogs.answer(Some(dest.clone()));
        let shell = Arc::clone(&ts.shell);
        let save = thread::spawn(move || shell.save_readable(s, g, ReadableJob::recovery_pdf()));
        wait_for_job(&ts);
        ts.shell.sessions.lock(s, LockReason::Manual);
        assert_eq!(joined(save).err(), LOCKED);
        assert_eq!(ts.journal().len(), 2, "kept for the sweep");
        assert_eq!(fs::read(&dest).unwrap(), OLD);
    }

    /// A vault folder is refused with the engine's own check, before anything is written or printed.
    #[test]
    fn vault_folder_refused() {
        let ts = TestShell::new();
        let (s, g, _) = with_destination(&ts);
        let vault = ts.shell.registry.entries()[0].1.clone();
        let before = names(&vault);
        for dest in [vault.join(NAME), vault.join("files").join(NAME)] {
            ts.dialogs.answer(Some(dest));
            let refused = ts.shell.save_readable(s, g, ReadableJob::recovery_pdf());
            assert_eq!(
                refused.err(),
                Some(ShellError::from(CoreError::InvalidInput {
                    what: "destination in a vault folder"
                }))
            );
        }
        assert!(ts.print.started().is_empty(), "nothing was printed");
        assert_eq!(names(&vault), before);
        assert!(!ts.shell.paths.outputs.exists(), "no journal change");
    }

    /// Lockbox's own state folder is refused, before anything is written or printed.
    #[test]
    fn state_folder_refused() {
        let ts = TestShell::new();
        let (s, g, _) = with_destination(&ts);
        fs::create_dir_all(&ts.shell.paths.root).unwrap();
        let before = names(&ts.shell.paths.root);
        ts.dialogs.answer(Some(ts.shell.paths.root.join(NAME)));
        let refused = ts.shell.save_readable(s, g, ReadableJob::recovery_pdf());
        assert_eq!(
            refused.err(),
            Some(ShellError::InvalidInput {
                what: "state folder"
            })
        );
        assert!(ts.print.started().is_empty());
        assert_eq!(names(&ts.shell.paths.root), before);
    }

    /// A cloud-synced folder asks first (`Confirm::CloudFolder`) before anything is written or printed.
    #[test]
    fn cloud_folder_asks_first() {
        let ts = TestShell::new();
        let (s, g, dest) = with_destination(&ts);
        ts.volumes.add_sync_root(dest.parent().unwrap());
        ts.dialogs.answer(Some(dest.clone()));
        let answer = ts.shell.save_readable(s, g, ReadableJob::recovery_pdf());
        let Ok(Tagged {
            data: Outcome::Confirm(Confirm::CloudFolder { .. }),
            ..
        }) = answer
        else {
            panic!("a cloud folder asks first");
        };
        assert!(ts.print.started().is_empty(), "nothing was printed");
        nothing_left(&ts, &dest);
        assert_eq!(fs::read(&dest).unwrap(), OLD);
        assert_eq!(ts.dialogs.opened(), 1);
    }

    /// The yes goes on with the parked job: no second dialog, the same destination, and the token is used up.
    #[test]
    fn confirm_goes_on_with_the_parked_job() {
        let ts = TestShell::new();
        let (s, g, dest) = with_destination(&ts);
        ts.volumes.add_sync_root(dest.parent().unwrap());
        ts.dialogs.answer(Some(dest.clone()));
        let Ok(Tagged {
            data: Outcome::Confirm(Confirm::CloudFolder { token }),
            ..
        }) = ts.shell.save_readable(s, g, ReadableJob::recovery_pdf())
        else {
            panic!("a cloud folder asks first");
        };

        let shell = Arc::clone(&ts.shell);
        let token = Arc::new(token);
        let again = Arc::clone(&token);
        let go = thread::spawn(move || shell.save_readable_confirm(&again));
        wait_for_job(&ts);
        assert!(ts.print.finish(Ok(())));
        let answer = go.join().unwrap();
        let Ok(tagged) = &answer else {
            panic!("not saved");
        };
        assert_eq!((tagged.session, tagged.generation), (s, g));
        assert_eq!(fs::read(&dest).unwrap(), PDF);
        nothing_left(&ts, &dest);
        assert_eq!(ts.dialogs.opened(), 1, "no second dialog");
        assert_eq!(
            ts.shell.save_readable_confirm(&token).err(),
            Some(ShellError::NotFound),
            "used up"
        );
    }

    /// The parked job belongs to the session that asked (the exact record, not the newest): once that session has
    /// locked, the yes writes nothing, even while another vault is unlocked.
    #[test]
    fn confirm_acts_on_the_session_that_asked() {
        let ts = TestShell::new();
        let (s, g, dest) = with_destination(&ts);
        ts.volumes.add_sync_root(dest.parent().unwrap());
        ts.dialogs.answer(Some(dest.clone()));
        let Ok(Tagged {
            data: Outcome::Confirm(Confirm::CloudFolder { token }),
            ..
        }) = ts.shell.save_readable(s, g, ReadableJob::recovery_pdf())
        else {
            panic!("a cloud folder asks first");
        };
        let (other, _) = ts.open_vault("Work");
        assert_ne!(other, s);
        ts.shell.sessions.lock(s, LockReason::Manual);

        assert_eq!(ts.shell.save_readable_confirm(&token).err(), LOCKED);
        assert!(ts.print.started().is_empty());
        nothing_left(&ts, &dest);
        assert_eq!(fs::read(&dest).unwrap(), OLD);
    }

    /// A damaged output journal refuses before the dialog opens; the journal is not touched. The yes of a parked job
    /// is refused too.
    #[test]
    fn damaged_journal_refuses() {
        let ts = TestShell::new();
        let (s, g, dest) = with_destination(&ts);
        fs::create_dir_all(&ts.shell.paths.root).unwrap();
        fs::write(&ts.shell.paths.outputs, "not json").unwrap();
        ts.dialogs.answer(Some(dest.clone()));
        let refused = ts.shell.save_readable(s, g, ReadableJob::recovery_pdf());
        assert_eq!(
            refused.err(),
            Some(ShellError::from(CoreError::Damaged {
                what: crate::outputs::WHAT
            }))
        );
        assert_eq!(ts.dialogs.opened(), 0, "before the dialog");
        assert!(ts.print.started().is_empty());
        assert_eq!(
            fs::read_to_string(&ts.shell.paths.outputs).unwrap(),
            "not json"
        );
        assert_eq!(names(dest.parent().unwrap()), [NAME]);
    }

    /// A closed dialog: `Dismissed` (tagged), and nothing is written, printed or journaled.
    #[test]
    fn dialog_cancel_writes_nothing() {
        let ts = TestShell::new();
        let (s, g, dest) = with_destination(&ts);
        ts.dialogs.answer(None);
        let answer = ts.shell.save_readable(s, g, ReadableJob::recovery_pdf());
        let Ok(tagged) = answer else {
            panic!("refused");
        };
        assert_eq!((tagged.session, tagged.generation), (s, g));
        assert!(matches!(tagged.data, Outcome::Dismissed));
        assert!(ts.print.started().is_empty());
        assert!(!ts.shell.paths.outputs.exists());
        assert_eq!(fs::read(&dest).unwrap(), OLD);
        assert_eq!(names(dest.parent().unwrap()), [NAME]);
    }

    /// WebView2 takes one print at a time: a second save while the first prints is refused with `PRINTER_BUSY`, and it
    /// leaves nothing of its own (its hidden folder is removed, its journal entries cleared); the first goes on and
    /// finishes. The printer is free again after.
    #[test]
    fn second_print_waits_for_the_first() {
        let ts = TestShell::new();
        let (s, g, dest) = with_destination(&ts);
        ts.dialogs.answer(Some(dest.clone()));
        let first = saving(&ts, s, g);
        let other = ts.folder("Other").join(NAME);
        ts.dialogs.answer(Some(other.clone()));
        assert_eq!(
            ts.shell
                .save_readable(s, g, ReadableJob::recovery_pdf())
                .err(),
            Some(PRINTER_BUSY)
        );
        assert!(
            names(other.parent().unwrap()).is_empty(),
            "the second left nothing"
        );
        assert_eq!(ts.journal().len(), 2, "only the first one's entries");

        assert!(ts.print.finish(Ok(())));
        joined(first).unwrap();
        nothing_left(&ts, &dest);

        ts.dialogs.answer(Some(other.clone()));
        let third = saving(&ts, s, g);
        assert!(ts.print.finish(Ok(())));
        joined(third).unwrap();
        assert_eq!(fs::read(&other).unwrap(), PDF);
    }

    /// A print that ends without a file, or that WebView2 refuses to start: `PDF_NOT_MADE`, the earlier file as it
    /// was, nothing left beside it and nothing in the journal.
    #[test]
    fn print_failure_leaves_no_file() {
        let ts = TestShell::new();
        let (s, g, dest) = with_destination(&ts);

        ts.dialogs.answer(Some(dest.clone()));
        let save = saving(&ts, s, g);
        assert!(ts.print.finish(Err(PrintFailed::NotWritten { code: 0 })));
        assert_eq!(joined(save).err(), Some(PDF_NOT_MADE));
        assert_eq!(fs::read(&dest).unwrap(), OLD);
        nothing_left(&ts, &dest);

        ts.print.refuse_next(PrintFailed::NotStarted { code: 5 });
        ts.dialogs.answer(Some(dest.clone()));
        let refused = ts.shell.save_readable(s, g, ReadableJob::recovery_pdf());
        assert_eq!(refused.err(), Some(PDF_NOT_MADE));
        assert_eq!(fs::read(&dest).unwrap(), OLD);
        nothing_left(&ts, &dest);
    }

    /// The finished PDF is flushed before it is moved (`publish_readable`): when the flush fails (made to fail on the
    /// save's own thread, where `publish_readable` runs), the earlier file is byte for byte as it was, and the temp and
    /// its folder are removed.
    #[test]
    fn a_pdf_that_cannot_be_flushed_keeps_the_old_file_and_leaves_no_temp() {
        let ts = TestShell::new();
        let (s, g, dest) = with_destination(&ts);
        ts.print.on_start(|| {
            lockbox_core::internals::fsio::failpoint::arm("publish.before_flush");
        });
        ts.dialogs.answer(Some(dest.clone()));
        let save = saving(&ts, s, g);
        assert!(ts.print.finish(Ok(())));
        assert!(matches!(
            joined(save).err(),
            Some(ShellError::Core(view)) if view.kind == "io"
        ));
        assert_eq!(fs::read(&dest).unwrap(), OLD);
        nothing_left(&ts, &dest);
    }

    /// A stale generation: refused before the dialog, with nothing written.
    #[test]
    fn save_recovery_pdf_refused_stale() {
        let ts = TestShell::new();
        let (s, g, dest) = with_destination(&ts);
        ts.dialogs.answer(Some(dest.clone()));
        let job = || ReadableJob::recovery_pdf();
        assert_eq!(ts.shell.save_readable(s, g + 1, job()).err(), LOCKED);
        ts.shell.sessions.lock(s, LockReason::Manual);
        assert_eq!(ts.shell.save_readable(s, g, job()).err(), LOCKED);
        assert_eq!(ts.dialogs.opened(), 0);
        assert!(ts.print.started().is_empty());
        nothing_left(&ts, &dest);
    }

    /// A session ID that is not one of ours, and a read-only copy (which never shows a recovery key): refused before
    /// the dialog.
    #[test]
    fn save_recovery_pdf_refused_foreign_and_read_only() {
        let ts = TestShell::new();
        let (s, g, dest) = with_destination(&ts);
        let job = || ReadableJob::recovery_pdf();
        ts.dialogs.answer(Some(dest.clone()));
        assert_eq!(
            ts.shell.save_readable(SessionId(s.0 + 100), g, job()).err(),
            Some(ShellError::NotFound)
        );
        let (r, gr) = read_only_session(&ts);
        assert_eq!(
            ts.shell.save_readable(r, gr, job()).err(),
            Some(ShellError::ReadOnly)
        );
        assert_eq!(ts.dialogs.opened(), 0);
        assert!(ts.print.started().is_empty());
        nothing_left(&ts, &dest);
    }

    fn installed(name: &str, port: &str, driver: &str, attributes: u32) -> InstalledPrinter {
        InstalledPrinter {
            name: name.to_owned(),
            port: port.to_owned(),
            driver: driver.to_owned(),
            attributes,
        }
    }

    /// The printers the fake Windows has: two real ones, two that write a file through a box of their own, and a fax.
    fn windows_has_printers(ts: &TestShell, default: Option<&str>) {
        ts.print.set_printers(
            vec![
                installed(
                    "Microsoft Print to PDF",
                    "PORTPROMPT:",
                    "Microsoft Print To PDF",
                    0,
                ),
                installed("Office", "IP_10.0.0.8", "HP Universal Printing PCL 6", 0),
                installed("Laser", "USB001", "Brother Laser Type1 Class Driver", 0),
                installed(
                    "Fax",
                    "SHRFAX:",
                    "Microsoft Shared Fax Driver",
                    PRINTER_ATTRIBUTE_FAX,
                ),
                installed(
                    "Send to OneNote",
                    "nul:",
                    "Send to Microsoft OneNote 16 Driver",
                    0,
                ),
            ],
            default,
        );
    }

    type Printed = ShellResult<Tagged<()>>;

    /// A print to `printer` on a thread of its own, as the command's blocking pool runs it, once the printer has its job.
    fn printing(ts: &TestShell, s: SessionId, g: u64, printer: &str) -> JoinHandle<Printed> {
        let shell = Arc::clone(&ts.shell);
        let printer = printer.to_owned();
        let print = thread::spawn(move || shell.print_recovery_key(s, g, printer));
        wait_for_job(ts);
        print
    }

    /// The printers Lockbox offers leave out the ones that write a file through a box of their own, and fax and OneNote
    /// printers; the default is the one Windows names.
    #[test]
    fn list_printers_leaves_out_file_and_fax_printers() {
        let ts = TestShell::new();
        windows_has_printers(&ts, Some("Laser"));
        let list = ts.shell.list_printers().unwrap();
        assert_eq!(list.printers, ["Office", "Laser"]);
        assert_eq!(list.default.as_deref(), Some("Laser"));
    }

    /// The default is `None` when Windows' default is one that is left out (Microsoft Print to PDF is a common default),
    /// when it names no printer Windows has, and when there is none. A listing Windows cannot give is a fixed error.
    #[test]
    fn default_printer_left_out_when_not_listed() {
        let ts = TestShell::new();
        for default in [Some("Microsoft Print to PDF"), Some("Gone"), None] {
            windows_has_printers(&ts, default);
            let list = ts.shell.list_printers().unwrap();
            assert_eq!(list.printers, ["Office", "Laser"]);
            assert_eq!(list.default, None, "{default:?}");
        }
        ts.print.set_printers(Vec::new(), None);
        let list = ts.shell.list_printers().unwrap();
        assert_eq!((list.printers, list.default), (Vec::new(), None));

        ts.print.fail_listing();
        assert_eq!(
            ts.shell.list_printers().err(),
            Some(crate::os::PRINTERS_UNREADABLE)
        );
        assert!(ts.shell.list_printers().is_ok(), "a failure is not kept");
    }

    /// A printer that is not in the list read now is refused with `PRINTER_GONE` and WebView2 is not asked: one that is
    /// left out (a file printer, a fax), one that is gone, one spelled differently, and an empty name.
    #[test]
    fn print_refused_for_a_printer_not_listed() {
        let ts = TestShell::new();
        let (s, g, dest) = with_destination(&ts);
        windows_has_printers(&ts, Some("Office"));
        for name in [
            "Microsoft Print to PDF",
            "Fax",
            "Send to OneNote",
            "Gone",
            "office",
            "Office ",
            "",
        ] {
            assert_eq!(
                ts.shell.print_recovery_key(s, g, name.to_owned()).err(),
                Some(PRINTER_GONE),
                "{name:?}"
            );
        }
        assert!(ts.print.printed_to().is_empty());
        assert_eq!(ts.print.running(), 0);

        // A printer that was listed and then removed from Windows is refused the same way.
        ts.print.set_printers(Vec::new(), None);
        assert_eq!(
            ts.shell.print_recovery_key(s, g, "Office".to_owned()).err(),
            Some(PRINTER_GONE)
        );
        assert!(ts.print.printed_to().is_empty());
        nothing_left(&ts, &dest);
    }

    /// Print goes to the printer that was named, and only to it; the page that asked is told once the printer has the
    /// job; Lockbox writes no file and keeps no journal entry for it; the printer is free after.
    #[test]
    fn print_sends_to_the_named_printer() {
        let ts = TestShell::new();
        let (s, g, dest) = with_destination(&ts);
        windows_has_printers(&ts, Some("Office"));
        let print = printing(&ts, s, g, "Laser");
        assert_eq!(ts.print.printed_to(), ["Laser"]);
        assert!(ts.print.started().is_empty(), "no PDF was made");
        assert!(ts.print.finish(Ok(())));
        let printed = print.join().unwrap().unwrap();
        assert_eq!((printed.session, printed.generation), (s, g));
        assert_eq!(
            fs::read(&dest).unwrap(),
            OLD,
            "Print touched no file of its own"
        );
        assert_eq!(names(dest.parent().unwrap()), [NAME]);
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());

        let again = printing(&ts, s, g, "Office");
        assert!(ts.print.finish(Ok(())));
        again.join().unwrap().unwrap();
        assert_eq!(ts.print.printed_to(), ["Laser", "Office"]);
    }

    /// Print: a stale generation, a foreign ID and a read-only copy are refused before the printers are read or
    /// anything is printed.
    #[test]
    fn print_refused_stale_foreign_and_read_only() {
        let ts = TestShell::new();
        let (s, g, _) = with_destination(&ts);
        windows_has_printers(&ts, Some("Office"));
        let office = || "Office".to_owned();
        assert_eq!(
            ts.shell.print_recovery_key(s, g + 1, office()).err(),
            LOCKED
        );
        assert_eq!(
            ts.shell
                .print_recovery_key(SessionId(s.0 + 100), g, office())
                .err(),
            Some(ShellError::NotFound)
        );
        let (r, gr) = read_only_session(&ts);
        assert_eq!(
            ts.shell.print_recovery_key(r, gr, office()).err(),
            Some(ShellError::ReadOnly)
        );
        assert_eq!(
            ts.shell.print_recovery_key(s, g, office()).err(),
            LOCKED,
            "locked by the read-only open"
        );
        assert!(ts.print.printed_to().is_empty());
    }

    /// Save as PDF and Print share the one printer: while a PDF prints, Print is refused with `PRINTER_BUSY`, and
    /// WebView2 is not asked.
    #[test]
    fn print_refused_while_a_pdf_prints() {
        let ts = TestShell::new();
        let (s, g, dest) = with_destination(&ts);
        windows_has_printers(&ts, Some("Office"));
        ts.dialogs.answer(Some(dest.clone()));
        let save = saving(&ts, s, g);
        assert_eq!(
            ts.shell.print_recovery_key(s, g, "Office".to_owned()).err(),
            Some(PRINTER_BUSY)
        );
        assert_eq!(ts.print.printed_to(), Vec::<String>::new());
        assert!(ts.print.finish(Ok(())));
        joined(save).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), PDF, "the save went on");

        let print = printing(&ts, s, g, "Office");
        assert!(ts.print.finish(Ok(())));
        print.join().unwrap().unwrap();
    }

    /// ...and the other way: while a print to a printer runs, Save as PDF is refused with `PRINTER_BUSY` before it
    /// makes anything (no folder, no journal entry), and works once the print has ended.
    #[test]
    fn pdf_refused_while_printing() {
        let ts = TestShell::new();
        let (s, g, dest) = with_destination(&ts);
        windows_has_printers(&ts, Some("Office"));
        let print = printing(&ts, s, g, "Office");
        ts.dialogs.answer(Some(dest.clone()));
        assert_eq!(
            ts.shell
                .save_readable(s, g, ReadableJob::recovery_pdf())
                .err(),
            Some(PRINTER_BUSY)
        );
        assert_eq!(
            names(dest.parent().unwrap()),
            [NAME],
            "the refused save made nothing"
        );
        assert_eq!(ts.journal(), Vec::<PathBuf>::new());
        assert!(ts.print.finish(Ok(())));
        print.join().unwrap().unwrap();

        ts.dialogs.answer(Some(dest.clone()));
        let save = saving(&ts, s, g);
        assert!(ts.print.finish(Ok(())));
        joined(save).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), PDF);
    }

    /// A job WebView2 refuses to start, one that ends without the printer taking it (printer unavailable or any other
    /// status) and one that never answers are each `PRINT_NOT_SENT`; the printer is free after each answer.
    #[test]
    fn print_failure_is_print_not_sent() {
        let ts = TestShell::new();
        let (s, g, _) = with_destination(&ts);
        windows_has_printers(&ts, Some("Office"));
        ts.print.refuse_next(PrintFailed::NotStarted {
            code: 0x8000_4005_u32 as i32,
        });
        assert_eq!(
            ts.shell.print_recovery_key(s, g, "Office".to_owned()).err(),
            Some(PRINT_NOT_SENT)
        );

        for ended in [
            PrintFailed::NotWritten { code: 0 },
            PrintFailed::NotWritten { code: 7 },
        ] {
            let print = printing(&ts, s, g, "Office");
            assert!(ts.print.finish(Err(ended)));
            assert_eq!(print.join().unwrap().err(), Some(PRINT_NOT_SENT));
        }

        let print = printing(&ts, s, g, "Office");
        assert!(ts.print.finish(Ok(())));
        print.join().unwrap().unwrap();

        // No answer in time: the same fixed answer.
        ts.shell.set_print_wait(Duration::from_millis(50));
        assert_eq!(
            ts.shell.print_recovery_key(s, g, "Office".to_owned()).err(),
            Some(PRINT_NOT_SENT)
        );
    }

    /// A lock while the printer takes the job: `Locked`, and no error shows on the page.
    #[test]
    fn print_answers_locked_after_a_lock() {
        let ts = TestShell::new();
        let (s, g, _) = with_destination(&ts);
        windows_has_printers(&ts, Some("Office"));
        let print = printing(&ts, s, g, "Office");
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert!(ts.print.finish(Ok(())));
        assert_eq!(print.join().unwrap().err(), LOCKED);
    }

    /// Waits until the fake printer holds a job queued for the webview's thread and not yet submitted to WebView2.
    fn wait_for_queued_job(ts: &TestShell) {
        let until = Instant::now() + GIVE_UP;
        while ts.print.queued() == 0 {
            assert!(Instant::now() < until, "no job was queued");
            thread::sleep(Duration::from_millis(2));
        }
    }

    /// The session locks after the print was queued for the webview's thread and before WebView2 is asked: WebView2 is
    /// never asked, so nothing prints (a submitted print cannot be recalled). The answer is `Locked`, and the printer is
    /// free after.
    #[test]
    fn a_print_queued_before_a_lock_is_never_submitted() {
        let ts = TestShell::new();
        let (s, g, _) = with_destination(&ts);
        windows_has_printers(&ts, Some("Office"));
        ts.print.hold_submission();
        let shell = Arc::clone(&ts.shell);
        let print = thread::spawn(move || shell.print_recovery_key(s, g, "Office".to_owned()));
        wait_for_queued_job(&ts);
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert_eq!(ts.print.submit_queued(), 0, "nothing reached WebView2");
        assert_eq!(print.join().unwrap().err(), LOCKED);
        assert!(ts.print.submitted().is_empty());
        assert_eq!(ts.print.running(), 0);
    }

    /// The same for Save as PDF: a lock between queueing and submission means WebView2 is never asked, no PDF is
    /// made, the earlier file is as it was, and what Lockbox had journaled is cleaned up.
    #[test]
    fn a_pdf_queued_before_a_lock_is_never_submitted() {
        let ts = TestShell::new();
        let (s, g, dest) = with_destination(&ts);
        ts.dialogs.answer(Some(dest.clone()));
        ts.print.hold_submission();
        let shell = Arc::clone(&ts.shell);
        let save = thread::spawn(move || shell.save_readable(s, g, ReadableJob::recovery_pdf()));
        wait_for_queued_job(&ts);
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert_eq!(ts.print.submit_queued(), 0, "nothing reached WebView2");
        assert_eq!(joined(save).err(), LOCKED);
        assert!(ts.print.submitted_jobs().is_empty());
        assert_eq!(fs::read(&dest).unwrap(), OLD);
        nothing_left(&ts, &dest);
    }

    /// A lock while Windows lists its printers (a network printer's server can take seconds): nothing is printed, and
    /// the answer is `Locked`.
    #[test]
    fn print_not_started_after_a_lock_while_listing() {
        let ts = TestShell::new();
        let (s, g, _) = with_destination(&ts);
        windows_has_printers(&ts, Some("Office"));
        let shell = Arc::clone(&ts.shell);
        ts.print
            .on_listing(move || shell.sessions.lock_all(LockReason::Manual));
        assert_eq!(
            ts.shell.print_recovery_key(s, g, "Office".to_owned()).err(),
            LOCKED
        );
        assert!(ts.print.printed_to().is_empty());
    }

    /// The commands' requests refuse unknown or missing fields with the one fixed answer.
    #[test]
    fn readable_commands_refuse_malformed_requests() {
        let body = |value: Value| InvokeBody::Json(value);
        let session = json!({ "session": 1, "generation": 2 });
        assert!(parse::<SessionArgs>(&body(session.clone())).is_ok());
        for bad in [
            json!({ "session": 1 }),
            json!({ "session": 1, "generation": 2, "path": "C:\\x" }),
            json!("SENTINEL-7f3a"),
        ] {
            assert_eq!(parse::<SessionArgs>(&body(bad)).err(), Some(MALFORMED));
        }
        let token = "0123456789abcdef0123456789abcdef";
        assert!(parse::<ConfirmArgs>(&body(json!({ "token": token }))).is_ok());
        for bad in [
            json!({}),
            json!({ "token": "not a token" }),
            json!({ "token": token, "dest": "C:\\x" }),
        ] {
            assert_eq!(parse::<ConfirmArgs>(&body(bad)).err(), Some(MALFORMED));
        }
        let print = json!({ "session": 1, "generation": 2, "printer": "Office" });
        assert!(parse::<PrintArgs>(&body(print)).is_ok());
        for bad in [
            json!({ "session": 1, "generation": 2 }),
            json!({ "session": 1, "generation": 2, "printer": 5 }),
            json!({ "session": 1, "generation": 2, "printer": "Office", "path": "C:\\x" }),
            json!({ "printer": "Office" }),
        ] {
            assert_eq!(parse::<PrintArgs>(&body(bad)).err(), Some(MALFORMED));
        }
        assert!(parse::<NoArgs>(&body(json!({}))).is_ok());
        assert_eq!(
            parse::<NoArgs>(&body(json!({ "printer": "Office" }))).err(),
            Some(MALFORMED)
        );
    }
}
