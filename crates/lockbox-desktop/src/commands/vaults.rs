//! The vault list, and opening vaults: create, unlock, recover (spec §5.3, §6.10). Vaults are named by registry ID
//! or session ID; their folders come only from the registry and from Rust's own dialogs (spec §4.1).
//!
//! Each command is a thin wrapper that parses its request and runs a [`Shell`] method below on the blocking pool:
//! a key derivation takes about a second, and a dialog waits for the user.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use lockbox_core::blob::CancelToken;
use lockbox_core::fsio::remove_dir_all_retry;
use lockbox_core::ids::VaultId;
use lockbox_core::kdf::check_new_password;
use lockbox_core::recovery::RecoverySecret;
use lockbox_core::{CleanupReport, UnlockReport, Vault, folder_name};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Request;
use zeroize::Zeroizing;

use super::{NoArgs, args, blocking};
use crate::error::{Confirm, Outcome, ShellError, ShellResult, VAULT_NOT_LISTED};
use crate::locations::{CloudProvider, LocationCheck};
use crate::os::same_path;
use crate::paths::default_vault_parent;
use crate::pending::{PendingChoice, Token};
use crate::registry::VaultEntry;
use crate::session::{Location, OpenAnswer, OpenStep, Opened, SessionId, SessionInfo, Tagged};
use crate::shell::Shell;

/// A new vault, open, with its recovery key: the one time the key crosses to the page (spec §4.1). No `Debug`.
#[derive(Serialize)]
pub struct CreatedView {
    pub info: SessionInfo,
    pub recovery_key: Zeroizing<String>,
}

/// An unlocked vault, with every warning the unlock raised (spec §6.3, §6.4). All false, and nothing cleaned, when
/// the vault was already unlocked: the warnings went with the first unlock.
#[derive(Debug, Serialize)]
pub struct UnlockView {
    pub info: SessionInfo,
    /// Opened from `vault.json.bak`, which may still need the previous password.
    pub used_backup_header: bool,
    /// The header was changed outside Lockbox: `accept_header` once the user agrees.
    pub header_mac_mismatch: bool,
    /// The other header copy could not be repaired; the next unlock tries again.
    pub header_repair_failed: bool,
    pub cleanup: CleanupView,
    /// The cloud provider syncing the vault's folder, as this unlock's location check found it: not supported (spec
    /// §6.10), so the page warns. A fixed name (`"OneDrive"`, `"GoogleDrive"`, `"Dropbox"`, `"Other"`), never a path;
    /// `null` too when the vault was already unlocked.
    pub cloud: Option<CloudProvider>,
    /// A recovery key was made for this vault and never confirmed (the app closed, or the vault locked, before the
    /// person typed part of it back): the page makes a new key before anything else. True only for a writable, live
    /// vault whose folder has the mark in the shell's vault state; a read-only copy never has it. Worked out afresh on
    /// every answer, the "already unlocked" one included.
    pub recovery_unconfirmed: bool,
}

/// What an unlock's opening closure gives back: the engine's report, the cloud provider its location check found,
/// and whether the folder has the "recovery key not confirmed" mark.
type Unlocked = (UnlockReport, Option<CloudProvider>, bool);

/// The view of an unlock (`unlock_vault`, `recover_vault`, `recover_vault_confirm`).
fn unlock_view(info: SessionInfo, unlocked: Unlocked) -> UnlockView {
    let (report, cloud, recovery_unconfirmed) = unlocked;
    let UnlockReport {
        used_backup_header,
        header_mac_mismatch,
        header_repair_failed,
        cleanup,
    } = report;
    UnlockView {
        info,
        used_backup_header,
        header_mac_mismatch,
        header_repair_failed,
        cleanup: cleanup.into(),
        cloud,
        recovery_unconfirmed,
    }
}

/// The view of an unlock of a vault that was already unlocked: the warnings went with the first unlock, so every one
/// is false, but the mark is read again, so the page cannot miss it.
fn already_unlocked_view(info: SessionInfo, recovery_unconfirmed: bool) -> UnlockView {
    UnlockView {
        info,
        used_backup_header: false,
        header_mac_mismatch: false,
        header_repair_failed: false,
        cleanup: CleanupView::default(),
        cloud: None,
        recovery_unconfirmed,
    }
}

/// What the cleanup at unlock did (spec §6.4): the engine's `CleanupReport`, field by field.
#[derive(Debug, Default, PartialEq, Eq, Serialize)]
pub struct CleanupView {
    pub partials_removed: usize,
    pub temps_removed: usize,
    pub retired_deleted: usize,
    pub purges_finished: usize,
    /// Unreferenced files moved to `files/orphaned/`.
    pub orphans_quarantined: usize,
    pub orphans_restored: usize,
    /// Damaged items: when not zero, "Cleanup skipped: N damaged items", and nothing was quarantined.
    pub skipped_damaged: usize,
    pub failed: usize,
}

impl From<CleanupReport> for CleanupView {
    fn from(report: CleanupReport) -> Self {
        let CleanupReport {
            partials_removed,
            temps_removed,
            retired_deleted,
            purges_finished,
            orphans_quarantined,
            orphans_restored,
            skipped_damaged,
            failed,
        } = report;
        CleanupView {
            partials_removed,
            temps_removed,
            retired_deleted,
            purges_finished,
            orphans_quarantined,
            orphans_restored,
            skipped_damaged,
            failed,
        }
    }
}

/// The header files a vault folder holds (the engine's names): a folder with neither holds no vault.
const HEADER_FILES: [&str; 2] = ["vault.json", "vault.json.bak"];

/// What a create that a lock overtook made: the vault exists and is on the vault list, but is not open.
const VAULT_CREATED: &str = "vault created";

/// Refuses (`"folder"`) a checked folder that is not `location`, the place the session was registered under before
/// the open (a junction on the listed path moved in between): the session must never hold one vault under another's
/// place, where a later unlock of that place would be answered with it.
fn same_place(check: &LocationCheck, location: &Location) -> ShellResult<()> {
    match same_path(&check.path, location.path()) {
        true => Ok(()),
        false => Err(ShellError::InvalidInput { what: "folder" }),
    }
}

/// `Locked` once a lock of all vaults has cancelled the open: checked right before a step that cannot be undone
/// (making the vault, accepting a header, setting a password), so a lock that lands before it changes nothing.
fn not_cancelled(cancel: &CancelToken) -> ShellResult<()> {
    match cancel.is_cancelled() {
        true => Err(ShellError::Locked),
        false => Ok(()),
    }
}

/// Tests only: the step a recovery reaches once the new password is set, just before it gives back the session.
#[cfg(test)]
const PASSWORD_SET: &str = "shell.recover.password_set";

/// Tests only: the step an unlock or a recovery reaches inside its open, before its location check.
#[cfg(test)]
const CHECKING: &str = "shell.open.checking";

/// Tests only: a named step a test can watch or make fail (the engine's failpoints, which are per thread: an opening
/// closure runs on the thread that called the command).
#[cfg(test)]
fn test_step(name: &'static str) -> ShellResult<()> {
    Ok(lockbox_core::internals::fsio::failpoint::check(name)?)
}

/// `recover_vault` sets a new password on a closed vault only; an unlocked one changes it from its session.
const UNLOCKED: ShellError = ShellError::InvalidInput {
    what: "vault is unlocked",
};

/// The new session an open gave back. An opening closure that cannot ask gives back nothing else.
fn opened<X>(answer: OpenAnswer<X>) -> ShellResult<Tagged<(SessionInfo, Option<X>)>> {
    match answer {
        Outcome::Done(tagged) => Ok(tagged),
        Outcome::Confirm(_) | Outcome::Dismissed => Err(ShellError::Cancelled),
    }
}

/// `recover_vault`'s answer: the session and what its recovery unlock found, once the closure that sets the new
/// password ran, or its question. A session already unlocked there (the closure skipped, the password not set) is
/// refused.
fn recovered(answer: OpenAnswer<Unlocked>) -> ShellResult<Outcome<Tagged<UnlockView>>> {
    Ok(match answer {
        Outcome::Done(Tagged {
            session,
            generation,
            data: (info, Some(unlocked)),
        }) => Outcome::Done(Tagged {
            session,
            generation,
            data: unlock_view(info, unlocked),
        }),
        Outcome::Done(_) => return Err(UNLOCKED),
        Outcome::Confirm(question) => Outcome::Confirm(question),
        Outcome::Dismissed => Outcome::Dismissed,
    })
}

impl Shell {
    /// Adds a vault folder the user picks. `Dismissed` when the dialog is closed; refused when the folder may not
    /// hold a vault or holds none. A folder a cloud provider syncs asks first (`Confirm::CloudFolder`);
    /// [`add_existing_vault_confirm`](Self::add_existing_vault_confirm) goes on from there.
    pub fn add_existing_vault(&self) -> ShellResult<Outcome<VaultEntry>> {
        let Some(dir) = self.os.dialogs.pick_folder("Add an existing vault", None) else {
            return Ok(Outcome::Dismissed);
        };
        self.add_folder(&dir, false)
    }

    /// The user's yes to adding a vault in a cloud folder: goes on with the folder chosen before, checked again.
    pub fn add_existing_vault_confirm(&self, token: &Token) -> ShellResult<Outcome<VaultEntry>> {
        match self.sessions.pending().take(token)? {
            PendingChoice::AddVault { dir } => self.add_folder(&dir, true),
            // A token for another question: used up, and its choice dropped (no lock is held here).
            _ => Err(ShellError::NotFound),
        }
    }

    /// Checks the vault folder `dir` and adds it to the vault list, asking first about a cloud folder unless
    /// `cloud_confirmed`.
    fn add_folder(&self, dir: &Path, cloud_confirmed: bool) -> ShellResult<Outcome<VaultEntry>> {
        // From the folder's check to its place on the list, no create may take that place (see `creating`).
        let creating = self.creating();
        let check = self.check_location(dir)?;
        let dir = check.path;
        if !HEADER_FILES.iter().any(|file| dir.join(file).is_file()) {
            return Err(ShellError::InvalidInput {
                what: "not a vault folder",
            });
        }
        if check.cloud.is_some() && !cloud_confirmed {
            // Parked once the creation lock is released: parking drops expired choices, which may hold a vault.
            drop(creating);
            let token = self.sessions.pending().put(PendingChoice::AddVault { dir });
            return Ok(Outcome::Confirm(Confirm::CloudFolder { token }));
        }
        let id = self.registry.add(&dir)?;
        drop(creating);
        Ok(Outcome::Done(self.registry.entry(id, &dir)))
    }

    /// Creates a vault named `name` in the default vaults folder, or in a folder the user picks
    /// (`choose_folder`), adds it to the vault list and opens it. A folder a cloud provider syncs asks first
    /// (`Confirm::CloudFolder`), before anything is written; [`create_vault_confirm`](Self::create_vault_confirm)
    /// goes on from there.
    pub fn create_vault(
        &self,
        name: String,
        password: Zeroizing<String>,
        choose_folder: bool,
    ) -> ShellResult<Outcome<Tagged<CreatedView>>> {
        // Before the dialog and the cloud question: the user hears it first.
        check_new_password(&password)?;
        // A lock of all vaults while the picker is open ends this create, as it does for the other pickers.
        let epoch = self.sessions.epoch();
        let parent = match choose_folder {
            true => match self
                .os
                .dialogs
                .pick_folder("Choose where to create the vault", None)
            {
                Some(parent) => parent,
                None => return Ok(Outcome::Dismissed),
            },
            false => default_vault_parent(self.os.env.as_ref())?,
        };
        let answer = self
            .sessions
            .open_since(epoch, None, Some(VAULT_CREATED), |cancel| {
                self.create_in(parent, name, password, false, cancel)
            })?;
        created(answer)
    }

    /// The user's yes to creating the vault in a cloud folder: goes on with the folder chosen before.
    pub fn create_vault_confirm(&self, token: &Token) -> ShellResult<Outcome<Tagged<CreatedView>>> {
        // Another question's choice is handed back as it is: moved once, under the sessions mutex, not boxed there.
        #[allow(clippy::result_large_err)]
        let pick = |choice| match choice {
            PendingChoice::CreateVault {
                parent,
                name,
                password,
            } => Ok((None, (parent, name, password))),
            // A token for another question: used up, and its choice dropped.
            other => Err(other),
        };
        let answer = self.sessions.open_choice(
            token,
            Some(VAULT_CREATED),
            pick,
            |(parent, name, password), cancel| self.create_in(parent, name, password, true, cancel),
        )?;
        created(answer)
    }

    /// The opening closure of a create: checks `parent` (again, after a yes: it may have changed since), asks first
    /// about a cloud folder unless `cloud_confirmed`, then creates the vault there and adds it to the vault list. A
    /// lock of all vaults seen before the vault is made (its `cancel`, checked right before) answers `Locked`, with
    /// nothing made; one that lands after it leaves the vault on disk and on the vault list:
    /// `LockedAfterChange { what: "vault created" }`. If the list refuses the vault and it is removed again, a lock
    /// answers `Locked` (nothing is left); if the removal fails too, `"vault not listed"`, with or without a lock.
    fn create_in(
        &self,
        parent: PathBuf,
        name: String,
        password: Zeroizing<String>,
        cloud_confirmed: bool,
        cancel: &CancelToken,
    ) -> ShellResult<OpenStep<Zeroizing<String>>> {
        let check = self.check_location(&parent)?;
        // The folder as checked, from here on.
        let parent = check.path;
        if check.cloud.is_some() && !cloud_confirmed {
            let choice = PendingChoice::CreateVault {
                parent,
                name,
                password,
            };
            return Ok(OpenStep::Ask(choice, |token| Confirm::CloudFolder {
                token,
            }));
        }
        // One creation at a time, from the room check to the new vault's place on the list (see `creating`).
        let creating = self.creating();
        // Before anything is written, so a full or damaged list never leaves the new vault off it.
        self.registry.check_room()?;
        not_cancelled(cancel)?;
        // The default vaults folder is made on first use; a folder the user picked exists already.
        fs::create_dir_all(&parent)?;
        // The mark first: from here until the person has typed part of the key back, the vault's folder is noted as
        // having a key nobody confirmed. If the mark cannot be written, no vault and no key are made. The ID is chosen
        // here so the folder, and so the mark's key, is known before the vault exists.
        let id = VaultId::random();
        let place = parent.join(folder_name(&name, &id));
        self.vault_state.mark_unconfirmed(&place)?;
        let created = match Vault::create_with_id(&parent, &name, &password, id) {
            Ok(created) => created,
            Err(e) => {
                self.take_back_mark_if_not_made(&place);
                return Err(e.into());
            }
        };
        let listed = fs::canonicalize(created.vault.dir())
            .map_err(ShellError::from)
            .and_then(|dir| self.registry.add(&dir).map(|_| dir));
        drop(creating);
        let dir = match listed {
            Ok(dir) => dir,
            Err(e) => {
                // Not on the list (its write failed, or it would grow too large): removed again, so no vault is left
                // that Lockbox cannot show and whose recovery key was never shown. The vault closes first, freeing its
                // `.lock`; only the folder this create made is removed. If that fails too, the vault (or part of
                // it) stays on disk: `VAULT_NOT_LISTED` tells the user, who knows its password, to add it. Its mark
                // stays: the key was never shown.
                let made = created.vault.dir().to_path_buf();
                drop(created);
                return Err(match remove_dir_all_retry(&made) {
                    Ok(()) => {
                        self.take_back_mark_if_not_made(&place);
                        e
                    }
                    Err(_) => VAULT_NOT_LISTED,
                });
            }
        };
        Ok(OpenStep::Session(
            Location::Folder(dir),
            Opened::Writable(created.vault),
            created.recovery.to_display(),
        ))
    }
}

impl Shell {
    /// Takes back the mark written for a vault `create_in` then failed to make: only when the folder is not there.
    /// A vault that was made (and so a key nobody saw) keeps its mark. Best effort: a mark for a folder that never
    /// existed is harmless, so a failure to take it back is not reported.
    fn take_back_mark_if_not_made(&self, place: &Path) {
        if !place.exists() {
            let _ = self.vault_state.clear_unconfirmed(place);
        }
    }
}

/// What a create's open answers: the new session with its recovery key, or the question.
fn created(answer: OpenAnswer<Zeroizing<String>>) -> ShellResult<Outcome<Tagged<CreatedView>>> {
    Ok(match answer {
        Outcome::Done(tagged) => {
            let (info, recovery_key) = tagged.data;
            // Never `None`: an open without a location always runs its closure.
            let recovery_key = recovery_key.ok_or(ShellError::Cancelled)?;
            Outcome::Done(Tagged {
                session: tagged.session,
                generation: tagged.generation,
                data: CreatedView { info, recovery_key },
            })
        }
        Outcome::Confirm(question) => Outcome::Confirm(question),
        Outcome::Dismissed => Outcome::Dismissed,
    })
}

impl Shell {
    /// The registered folder of the vault `id` and its session location. `NotFound` for an ID not on the list. The
    /// folder is checked again (it may have moved drives since it was added) inside the open, where a lock of all
    /// vaults during the check is seen.
    fn registered(&self, id: u32) -> ShellResult<(PathBuf, Location)> {
        let dir = self.registry.path(id).ok_or(ShellError::NotFound)?;
        let location = Location::folder(&dir)?;
        Ok((dir, location))
    }

    /// Unlocks the vault `id` of the vault list with its password.
    pub fn unlock_vault(
        &self,
        id: u32,
        password: Zeroizing<String>,
    ) -> ShellResult<Tagged<UnlockView>> {
        let (dir, location) = self.registered(id)?;
        let again = location.clone();
        let answer = self.sessions.open(Some(location.clone()), None, |_| {
            #[cfg(test)]
            test_step(CHECKING)?;
            let check = self.check_location(&dir)?;
            same_place(&check, &location)?;
            let (vault, report) = Vault::unlock_with_password(&check.path, &password)?;
            let unconfirmed = self.recovery_unconfirmed(&location, false);
            let unlocked = (report, check.cloud, unconfirmed);
            Ok(OpenStep::Session(
                location,
                Opened::Writable(vault),
                unlocked,
            ))
        })?;
        let Tagged {
            session,
            generation,
            data: (info, unlocked),
        } = opened(answer)?;
        let data = match unlocked {
            Some(unlocked) => unlock_view(info, unlocked),
            None => {
                let unconfirmed = self.recovery_unconfirmed(&again, info.read_only);
                already_unlocked_view(info, unconfirmed)
            }
        };
        Ok(Tagged {
            session,
            generation,
            data,
        })
    }

    /// Whether the vault folder at `location` has the "recovery key not confirmed" mark and is open to write: a
    /// read-only copy (a backup, a pre-restore folder) never shows it, and its location is not the folder's anyway.
    /// A mark that cannot be read for a reason other than damage counts as there (see `is_unconfirmed`).
    fn recovery_unconfirmed(&self, location: &Location, read_only: bool) -> bool {
        !read_only
            && matches!(location, Location::Folder(_))
            && self.vault_state.is_unconfirmed(location.path())
    }

    /// Unlocks the vault `id` with its recovery key and sets `new_password` before the session can be used (spec
    /// §5.3), and answers with what that unlock found, as [`unlock_vault`](Self::unlock_vault) does. A header changed
    /// outside Lockbox asks first (`Confirm::HeaderChanged`): the engine refuses a password change until it is
    /// accepted. A vault already unlocked is refused: its password is changed from the open vault.
    pub fn recover_vault(
        &self,
        id: u32,
        recovery_key: Zeroizing<String>,
        new_password: Zeroizing<String>,
    ) -> ShellResult<Outcome<Tagged<UnlockView>>> {
        // Before the recovery unlock and the changed-header question, whose yes rewrites the header.
        check_new_password(&new_password)?;
        let (dir, location) = self.registered(id)?;
        if self.sessions.find(&location).is_some() {
            return Err(UNLOCKED);
        }
        let secret = RecoverySecret::parse(&recovery_key)?;
        let answer = self
            .sessions
            .open(Some(location.clone()), Some("password"), |cancel| {
                #[cfg(test)]
                test_step(CHECKING)?;
                let check = self.check_location(&dir)?;
                same_place(&check, &location)?;
                let (mut vault, report) = Vault::unlock_with_recovery(&check.path, &secret)?;
                if report.header_mac_mismatch {
                    let choice = PendingChoice::RecoverVault {
                        location,
                        vault: Box::new(vault),
                        new_password,
                        report,
                    };
                    return Ok(OpenStep::Ask(choice, |token| Confirm::HeaderChanged {
                        token,
                    }));
                }
                not_cancelled(cancel)?;
                vault.change_password(&new_password)?;
                #[cfg(test)]
                test_step(PASSWORD_SET)?;
                let unconfirmed = self.recovery_unconfirmed(&location, false);
                let unlocked = (report, check.cloud, unconfirmed);
                Ok(OpenStep::Session(
                    location,
                    Opened::Writable(vault),
                    unlocked,
                ))
            })?;
        recovered(answer)
    }

    /// The user's answer about the changed header: yes accepts it, sets the new password and opens the session; no
    /// closes the vault with nothing changed (`Dismissed`).
    pub fn recover_vault_confirm(
        &self,
        token: &Token,
        accept: bool,
    ) -> ShellResult<Outcome<Tagged<UnlockView>>> {
        if !accept {
            // Taken and dropped, outside every lock: the vault closes with nothing changed.
            return match self.sessions.pending().take(token)? {
                PendingChoice::RecoverVault { .. } => Ok(Outcome::Dismissed),
                // A token for another question: used up, and its choice dropped.
                _ => Err(ShellError::NotFound),
            };
        }
        // As in `create_vault_confirm`: another question's choice is handed back unboxed.
        #[allow(clippy::result_large_err)]
        let pick = |choice| match choice {
            PendingChoice::RecoverVault {
                location,
                vault,
                new_password,
                report,
            } => {
                let opening = Some(location.clone());
                Ok((opening, (location, vault, new_password, report)))
            }
            other => Err(other),
        };
        let answer = self.sessions.open_choice(
            token,
            Some("password"),
            pick,
            |(location, vault, new_password, mut report), cancel| {
                // Before `accept_header` writes anything.
                check_new_password(&new_password)?;
                // Checked again: the folder may have moved drives while the question waited.
                let check = self.check_location(location.path())?;
                not_cancelled(cancel)?;
                let mut vault = *vault;
                vault.accept_header()?;
                vault.change_password(&new_password)?;
                #[cfg(test)]
                test_step(PASSWORD_SET)?;
                // The changed header the report found is accepted now.
                report.header_mac_mismatch = false;
                let unconfirmed = self.recovery_unconfirmed(&location, false);
                let unlocked = (report, check.cloud, unconfirmed);
                Ok(OpenStep::Session(
                    location,
                    Opened::Writable(vault),
                    unlocked,
                ))
            },
        )?;
        recovered(answer)
    }

    pub fn change_password(
        &self,
        session: SessionId,
        generation: u64,
        new_password: Zeroizing<String>,
    ) -> ShellResult<Tagged<()>> {
        self.sessions
            .write_change(session, generation, "password", |vault, _| {
                Ok(vault.change_password(&new_password)?)
            })
    }

    /// A new recovery key, shown once; the old one stops working. The vault's "recovery key not confirmed" mark is
    /// written first, so a crash or lock before the person has typed part of the key back leaves the mark, and the
    /// next unlock makes another. If the mark cannot be written, no key is made (`TooLarge { what: "vault state" }`
    /// or an I/O refusal). No password is asked: the person is already inside, and this is the way out of a key they
    /// never saw. A mark stays if the engine then fails: the old key may still work, and one more new key costs less
    /// than a key nobody saw.
    pub fn regenerate_recovery(
        &self,
        session: SessionId,
        generation: u64,
    ) -> ShellResult<Tagged<Zeroizing<String>>> {
        self.sessions
            .write_change(session, generation, "recovery key", |vault, _| {
                self.vault_state.mark_unconfirmed(vault.dir())?;
                Ok(vault.regenerate_recovery()?.to_display())
            })
    }

    /// The person typed part of the new recovery key back: clears the "recovery key not confirmed" mark of the
    /// session's vault. Clearing a mark that is not there is a success. Refused, as any change is, on a stale
    /// generation, a session that is not there, and a read-only copy.
    pub fn recovery_confirmed(
        &self,
        session: SessionId,
        generation: u64,
    ) -> ShellResult<Tagged<()>> {
        self.sessions.write(session, generation, |vault, _| {
            self.vault_state.clear_unconfirmed(vault.dir())
        })
    }

    /// Accepts a header changed outside Lockbox (after `header_mac_mismatch`), once the user agreed.
    pub fn accept_header(&self, session: SessionId, generation: u64) -> ShellResult<Tagged<()>> {
        self.sessions
            .write(session, generation, |vault, _| Ok(vault.accept_header()?))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VaultArg {
    id: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateVault {
    name: String,
    password: Zeroizing<String>,
    choose_folder: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenArg {
    token: Token,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UnlockVault {
    id: u32,
    password: Zeroizing<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecoverVault {
    id: u32,
    recovery_key: Zeroizing<String>,
    new_password: Zeroizing<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecoverConfirm {
    token: Token,
    accept: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionArg {
    session: SessionId,
    generation: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChangePassword {
    session: SessionId,
    generation: u64,
    new_password: Zeroizing<String>,
}

#[tauri::command]
pub(super) async fn list_vaults(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Vec<VaultEntry>> {
    let NoArgs {} = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.registry.list()).await
}

/// The first screen's "Start a new list" (Ask 12): sets a damaged vault list aside and makes an empty one. Refused for a
/// list that reads fine; takes no arguments, and the page never sees a path.
#[tauri::command]
pub(super) async fn start_new_vault_list(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<()> {
    let NoArgs {} = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.registry.start_new_list()).await
}

#[tauri::command]
pub(super) async fn add_existing_vault(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Outcome<VaultEntry>> {
    let NoArgs {} = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.add_existing_vault()).await
}

#[tauri::command]
pub(super) async fn add_existing_vault_confirm(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Outcome<VaultEntry>> {
    let TokenArg { token } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.add_existing_vault_confirm(&token)).await
}

#[tauri::command]
pub(super) async fn forget_vault(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<()> {
    let VaultArg { id } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.registry.forget(id)).await
}

#[tauri::command]
pub(super) async fn create_vault(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Outcome<Tagged<CreatedView>>> {
    let CreateVault {
        name,
        password,
        choose_folder,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.create_vault(name, password, choose_folder)).await
}

#[tauri::command]
pub(super) async fn create_vault_confirm(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Outcome<Tagged<CreatedView>>> {
    let TokenArg { token } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.create_vault_confirm(&token)).await
}

#[tauri::command]
pub(super) async fn unlock_vault(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<UnlockView>> {
    let UnlockVault { id, password } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.unlock_vault(id, password)).await
}

#[tauri::command]
pub(super) async fn recover_vault(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Outcome<Tagged<UnlockView>>> {
    let RecoverVault {
        id,
        recovery_key,
        new_password,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.recover_vault(id, recovery_key, new_password)).await
}

#[tauri::command]
pub(super) async fn recover_vault_confirm(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Outcome<Tagged<UnlockView>>> {
    let RecoverConfirm { token, accept } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.recover_vault_confirm(&token, accept)).await
}

#[tauri::command]
pub(super) async fn change_password(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<()>> {
    let ChangePassword {
        session,
        generation,
        new_password,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.change_password(session, generation, new_password)).await
}

#[tauri::command]
pub(super) async fn regenerate_recovery(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<Zeroizing<String>>> {
    let SessionArg {
        session,
        generation,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.regenerate_recovery(session, generation)).await
}

#[tauri::command]
pub(super) async fn recovery_confirmed(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<()>> {
    let SessionArg {
        session,
        generation,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.recovery_confirmed(session, generation)).await
}

#[tauri::command]
pub(super) async fn accept_header(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<()>> {
    let SessionArg {
        session,
        generation,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.accept_header(session, generation)).await
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::os::windows::fs::OpenOptionsExt;
    use std::path::Path;
    use std::rc::Rc;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;
    use std::time::{Duration, Instant};

    use lockbox_core::internals::fsio::failpoint;
    use lockbox_core::internals::fsio::testutil::make_dir_link;
    use lockbox_core::internals::header::{
        HEADER_BACKUP, HEADER_FILE, parse_header, serialize_header,
    };
    use lockbox_core::internals::lockfile::VaultLock;
    use lockbox_core::{CoreError, read_vault_name};
    use serde_json::{Value, json};
    use tauri::ipc::InvokeBody;
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

    use super::super::{MALFORMED, parse};
    use super::*;
    use crate::os::{DriveType, KnownFolder};
    use crate::paths::MAX_STATE_FILE;
    use crate::registry::MAX_VAULTS;
    use crate::session::{LockReason, SessionState};
    use crate::testing::{FakeVolume, LOCAL_NTFS, TestShell, heavy};

    const PW: &str = "correct horse battery";
    const NEW_PW: &str = "a different long password";
    /// A well-formed token no choice waits under: a repeated pattern, which the secret scan does not take for a key.
    const FAKE_TOKEN: &str = "abababababababababababababababab";

    fn secret(text: &str) -> Zeroizing<String> {
        Zeroizing::new(text.to_owned())
    }

    /// A new vault named "Family" in the test's vaults folder, closed, and on the vault list: its ID, canonical
    /// folder and recovery key.
    fn registered(ts: &TestShell) -> (u32, PathBuf, Zeroizing<String>) {
        let created = heavy(|| Vault::create(&ts.vaults(), "Family", PW)).unwrap();
        let dir = fs::canonicalize(created.vault.dir()).unwrap();
        let recovery = created.recovery.to_display();
        drop(created);
        (ts.shell.registry.add(&dir).unwrap(), dir, recovery)
    }

    /// Whether nothing holds the vault in `dir`: its `.lock` is free.
    fn is_free(dir: &Path) -> bool {
        VaultLock::acquire(dir).is_ok()
    }

    /// Changes the vault's header outside Lockbox (its name, which the header MAC covers), in both copies.
    fn change_header(dir: &Path) {
        let mut header = parse_header(&fs::read(dir.join(HEADER_FILE)).unwrap()).unwrap();
        header.name = "Renamed".to_owned();
        fs::write(dir.join(HEADER_FILE), serialize_header(&header)).unwrap();
        fs::write(dir.join(HEADER_BACKUP), serialize_header(&header)).unwrap();
    }

    fn headers(dir: &Path) -> (Vec<u8>, Vec<u8>) {
        (
            fs::read(dir.join(HEADER_FILE)).unwrap(),
            fs::read(dir.join(HEADER_BACKUP)).unwrap(),
        )
    }

    fn password_works(dir: &Path, password: &str) -> bool {
        match heavy(|| Vault::unlock_with_password(dir, password)) {
            Ok(_) => true,
            Err(CoreError::WrongPassword) => false,
            Err(other) => panic!("unlock failed otherwise: {other:?}"),
        }
    }

    fn wrong_password() -> ShellError {
        CoreError::WrongPassword.into()
    }

    fn done<T>(outcome: Outcome<T>) -> T {
        match outcome {
            Outcome::Done(value) => value,
            Outcome::Confirm(_) => panic!("asked first"),
            Outcome::Dismissed => panic!("dismissed"),
        }
    }

    fn state(ts: &TestShell, session: SessionId) -> Option<SessionState> {
        ts.shell
            .sessions
            .list()
            .into_iter()
            .find(|info| info.session == session)
            .map(|info| info.state)
    }

    #[test]
    fn create_in_default_folder_registers_and_opens() {
        let ts = TestShell::new();
        let created = heavy(|| ts.shell.create_vault("Family".into(), secret(PW), false));
        let tagged = done(created.unwrap());
        assert_eq!(ts.dialogs.opened(), 0, "no dialog for the default folder");
        assert_eq!(tagged.data.info.name, "Family");
        assert_eq!(state(&ts, tagged.session), Some(SessionState::Unlocked));
        assert_eq!(tagged.generation, tagged.data.info.generation);

        let entries = ts.shell.registry.entries();
        assert_eq!(entries.len(), 1);
        let (id, dir) = entries[0].clone();
        let parent = ts.env.folder(KnownFolder::Profile).join("Lockbox Vaults");
        assert_eq!(
            dir.parent(),
            Some(fs::canonicalize(&parent).unwrap().as_path())
        );
        assert_eq!(read_vault_name(&dir).unwrap(), "Family");

        // The recovery key shown is the vault's.
        let json = serde_json::to_value(&tagged).unwrap();
        assert_eq!(
            json["data"]["recovery_key"],
            tagged.data.recovery_key.as_str()
        );
        ts.shell.sessions.lock_all(LockReason::Manual);
        let key = RecoverySecret::parse(&tagged.data.recovery_key).unwrap();
        assert!(heavy(|| Vault::unlock_with_recovery(&dir, &key)).is_ok());
        assert_eq!(ts.shell.registry.path(id), Some(dir));
    }

    /// A lock while the folder picker is open: the password typed before it makes no new unlocked vault after it.
    #[test]
    fn lock_during_the_folder_picker_creates_nothing() {
        let ts = TestShell::new();
        let parent = ts.vaults();
        let shell = Arc::clone(&ts.shell);
        ts.dialogs.during_next_dialog(Box::new(move || {
            shell.sessions.lock_all(LockReason::Manual)
        }));
        ts.dialogs.answer(Some(parent.clone()));
        let answer = ts.shell.create_vault("Family".into(), secret(PW), true);
        assert_eq!(answer.err(), Some(ShellError::Locked));
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 0, "nothing created");
        assert!(ts.shell.registry.entries().is_empty());
        assert!(ts.shell.sessions.list().is_empty());
    }

    #[test]
    fn closed_folder_dialog_creates_nothing() {
        let ts = TestShell::new();
        let answer = ts.shell.create_vault("Family".into(), secret(PW), true);
        assert!(matches!(answer, Ok(Outcome::Dismissed)));
        assert_eq!(ts.dialogs.opened(), 1);
        assert!(ts.shell.registry.entries().is_empty());
        assert!(ts.shell.sessions.list().is_empty());
    }

    #[test]
    fn cloud_folder_needs_confirmation() {
        let ts = TestShell::new();
        let synced = ts.vaults();
        ts.volumes.add_sync_root(&synced);
        ts.dialogs.answer(Some(synced.clone()));
        let answer = ts.shell.create_vault("Family".into(), secret(PW), true);
        let Ok(Outcome::Confirm(Confirm::CloudFolder { token })) = answer else {
            panic!("a cloud folder asks first");
        };
        assert_eq!(fs::read_dir(&synced).unwrap().count(), 0, "nothing created");
        assert!(ts.shell.registry.entries().is_empty());
        assert!(ts.shell.sessions.list().is_empty());

        let tagged = done(heavy(|| ts.shell.create_vault_confirm(&token)).unwrap());
        assert_eq!(ts.dialogs.opened(), 1, "no second dialog");
        assert_eq!(tagged.data.info.name, "Family");
        let entries = ts.shell.registry.entries();
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].1.parent(),
            Some(fs::canonicalize(&synced).unwrap().as_path())
        );
        // The token was used up.
        assert!(matches!(
            ts.shell.create_vault_confirm(&token),
            Err(ShellError::NotFound)
        ));
    }

    #[test]
    fn create_refuses_unsupported_folder_before_writing() {
        let ts = TestShell::new();
        let usb = ts.vaults();
        ts.volumes.mount(
            &usb,
            FakeVolume {
                drive: DriveType::Removable,
                ..LOCAL_NTFS
            },
        );
        ts.dialogs.answer(Some(usb.clone()));
        let answer = ts.shell.create_vault("Family".into(), secret(PW), true);
        assert_eq!(
            answer.err(),
            Some(ShellError::InvalidInput {
                what: "removable drive"
            })
        );
        assert_eq!(fs::read_dir(&usb).unwrap().count(), 0);
        assert!(ts.shell.registry.entries().is_empty());
    }

    #[test]
    fn create_vault_confirm_with_unknown_or_other_token_refused() {
        let ts = TestShell::new();
        let unknown: Token = serde_json::from_value(json!(FAKE_TOKEN)).unwrap();
        assert!(matches!(
            ts.shell.create_vault_confirm(&unknown),
            Err(ShellError::NotFound)
        ));
        // A token for another question is used up and refused, and its choice dropped.
        let (id, dir, recovery) = registered(&ts);
        change_header(&dir);
        let asked = heavy(|| ts.shell.recover_vault(id, recovery, secret(NEW_PW))).unwrap();
        let Outcome::Confirm(Confirm::HeaderChanged { token }) = asked else {
            panic!("the changed header asks first");
        };
        assert!(matches!(
            ts.shell.create_vault_confirm(&token),
            Err(ShellError::NotFound)
        ));
        assert!(is_free(&dir), "the vault that waited is dropped");
        assert!(matches!(
            ts.shell.recover_vault_confirm(&token, true),
            Err(ShellError::NotFound)
        ));
    }

    #[test]
    fn create_racing_lock_says_created() {
        let ts = TestShell::new();
        let shell = Arc::clone(&ts.shell);
        failpoint::observe(
            "create.before_rename",
            Box::new(move || shell.sessions.lock_all(LockReason::WindowsLocked)),
        );
        let answer = heavy(|| ts.shell.create_vault("Family".into(), secret(PW), false));
        failpoint::disarm_all();
        assert_eq!(
            answer.err(),
            Some(ShellError::LockedAfterChange {
                what: "vault created"
            })
        );
        let entries = ts.shell.registry.entries();
        assert_eq!(entries.len(), 1, "the new vault is on the list");
        assert!(ts.shell.sessions.list().is_empty(), "but not open");
        assert!(is_free(&entries[0].1));
    }

    /// Locks every vault from another thread right after the next take of a pending choice, and lets the taker go on
    /// once that lock has finished or is waiting for the sessions mutex the taker holds. Join the returned handle.
    fn lock_once_taken(ts: &TestShell) -> Arc<Mutex<Option<thread::JoinHandle<()>>>> {
        let shell = Arc::clone(&ts.shell);
        let locker = Arc::new(Mutex::new(None));
        let slot = Arc::clone(&locker);
        ts.shell.sessions.pending().after_take(Box::new(move || {
            let waits = shell.sessions.inner_waits();
            let done = Arc::new(AtomicBool::new(false));
            let handle = {
                let (shell, done) = (Arc::clone(&shell), Arc::clone(&done));
                thread::spawn(move || {
                    shell.sessions.lock_all(LockReason::WindowsLocked);
                    done.store(true, Ordering::SeqCst);
                })
            };
            let give_up = Instant::now() + Duration::from_secs(60);
            while !done.load(Ordering::SeqCst) && shell.sessions.inner_waits() == waits {
                assert!(Instant::now() < give_up, "the lock never ran");
                thread::sleep(Duration::from_millis(1));
            }
            *crate::lock(&slot) = Some(handle);
        }));
        locker
    }

    fn join(locker: &Mutex<Option<thread::JoinHandle<()>>>) {
        let handle = crate::lock(locker).take().expect("the choice was taken");
        handle.join().unwrap();
    }

    /// Fix round 1 (F1): a lock that lands just as a confirm takes its choice is never missed. Either the lock comes
    /// first (the choice is gone: `NotFound`), or it sees the open under way and discards what it makes.
    #[test]
    fn lock_as_a_confirm_takes_its_choice_is_seen() {
        let ts = TestShell::new();

        // Recovery: the session never opens. The lock lands while the confirm's closure runs; whether its cancel is
        // seen before the header is accepted (`Locked`, nothing changed; fix round 2) or after the password is set
        // (`LockedAfterChange`) depends on timing, and both are right.
        let (id, dir, recovery) = registered(&ts);
        change_header(&dir);
        let before = headers(&dir);
        let asked = heavy(|| ts.shell.recover_vault(id, recovery, secret(NEW_PW))).unwrap();
        let Outcome::Confirm(Confirm::HeaderChanged { token }) = asked else {
            panic!("the changed header asks first");
        };
        let locker = lock_once_taken(&ts);
        let answer = heavy(|| ts.shell.recover_vault_confirm(&token, true));
        join(&locker);
        match answer.err() {
            Some(ShellError::Locked) => assert_eq!(headers(&dir), before, "nothing changed"),
            Some(ShellError::LockedAfterChange { what: "password" }) => {
                assert!(password_works(&dir, NEW_PW))
            }
            other => panic!("not overtaken by the lock: {other:?}"),
        }
        assert!(ts.shell.sessions.list().is_empty(), "no session");
        assert!(is_free(&dir));

        // Creation in a cloud folder: never opened; made and listed only if the cancel came after the vault was made.
        let synced = ts.temp.path().join("synced");
        fs::create_dir(&synced).unwrap();
        ts.volumes.add_sync_root(&synced);
        let ask = || {
            ts.dialogs.answer(Some(synced.clone()));
            let answer = ts.shell.create_vault("Work".into(), secret(PW), true);
            let Ok(Outcome::Confirm(Confirm::CloudFolder { token })) = answer else {
                panic!("a cloud folder asks first");
            };
            token
        };
        let token = ask();
        let locker = lock_once_taken(&ts);
        let answer = heavy(|| ts.shell.create_vault_confirm(&token));
        join(&locker);
        assert!(ts.shell.sessions.list().is_empty(), "no session");
        let entries = ts.shell.registry.entries();
        match answer.err() {
            Some(ShellError::Locked) => {
                assert_eq!(entries.len(), 1, "nothing made");
                assert!(vault_folders(&synced).is_empty());
            }
            Some(ShellError::LockedAfterChange {
                what: "vault created",
            }) => {
                assert_eq!(entries.len(), 2, "the new vault is on the list");
                assert!(is_free(&entries[1].1));
            }
            other => panic!("not overtaken by the lock: {other:?}"),
        }
        let listed = entries.len();

        // A lock before the yes: the choice is gone, nothing is created.
        let token = ask();
        ts.shell.sessions.lock_all(LockReason::WindowsLocked);
        assert_eq!(
            ts.shell.create_vault_confirm(&token).err(),
            Some(ShellError::NotFound)
        );
        assert_eq!(ts.shell.registry.entries().len(), listed);

        // A lock while the confirm's closure runs (after it registered): made, listed, not opened.
        let token = ask();
        let shell = Arc::clone(&ts.shell);
        failpoint::observe(
            "create.before_rename",
            Box::new(move || shell.sessions.lock_all(LockReason::WindowsLocked)),
        );
        let answer = heavy(|| ts.shell.create_vault_confirm(&token));
        failpoint::disarm_all();
        assert_eq!(
            answer.err(),
            Some(ShellError::LockedAfterChange {
                what: "vault created"
            })
        );
        assert!(ts.shell.sessions.list().is_empty());
        assert_eq!(ts.shell.registry.entries().len(), listed + 1);
    }

    /// When this thread's next create reaches its staging folder, runs `second` on another thread and lets this create
    /// go on once `second` has finished or is waiting for the creation lock this create holds. Join the returned
    /// handle for `second`'s answer.
    fn second_at_staging<T: Send + 'static>(
        ts: &TestShell,
        second: impl FnOnce(&Shell) -> T + Send + 'static,
    ) -> Arc<Mutex<Option<thread::JoinHandle<T>>>> {
        let shell = Arc::clone(&ts.shell);
        let slot = Arc::new(Mutex::new(None));
        let out = Arc::clone(&slot);
        let mut second = Some(second);
        failpoint::observe(
            "create.before_rename",
            Box::new(move || {
                let Some(second) = second.take() else {
                    return;
                };
                let waits = shell.creation_waits();
                let done = Arc::new(AtomicBool::new(false));
                let handle = {
                    let (shell, done) = (Arc::clone(&shell), Arc::clone(&done));
                    thread::spawn(move || {
                        let answer = second(&shell);
                        done.store(true, Ordering::SeqCst);
                        answer
                    })
                };
                let give_up = Instant::now() + Duration::from_secs(60);
                while !done.load(Ordering::SeqCst) && shell.creation_waits() == waits {
                    assert!(Instant::now() < give_up, "the second create never ran");
                    thread::sleep(Duration::from_millis(1));
                }
                *crate::lock(&out) = Some(handle);
            }),
        );
        slot
    }

    fn joined<T>(slot: &Mutex<Option<thread::JoinHandle<T>>>) -> T {
        let handle = crate::lock(slot).take().expect("the second create ran");
        handle.join().unwrap()
    }

    /// The vault folders directly inside `parent`.
    fn vault_folders(parent: &Path) -> Vec<PathBuf> {
        fs::read_dir(parent)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|dir| HEADER_FILES.iter().any(|file| dir.join(file).exists()))
            .collect()
    }

    /// Fix round 1 (F5): two creates in the same folder at once both succeed (the engine's create removes every
    /// unfinished staging folder in its parent, the other create's included).
    #[test]
    fn creates_in_the_same_folder_at_once_both_succeed() {
        let ts = TestShell::new();
        let second = second_at_staging(&ts, |shell| {
            shell.create_vault("Work".into(), secret(PW), false)
        });
        let (first, second) = heavy(|| {
            let first = ts.shell.create_vault("Family".into(), secret(PW), false);
            (first, joined(&second))
        });
        failpoint::disarm_all();
        let (first, second) = (done(first.unwrap()), done(second.unwrap()));
        assert_ne!(first.session, second.session);
        assert_eq!(ts.shell.registry.entries().len(), 2);
        assert_eq!(ts.shell.sessions.list().len(), 2);
    }

    /// Fix round 1 (F5): with one place left on the vault list, two creates at once let exactly one through, and
    /// leave no vault on disk that is not on the list.
    #[test]
    fn last_place_on_the_list_goes_to_one_create() {
        let ts = TestShell::new();
        let base = fs::canonicalize(ts.temp.path()).unwrap();
        let listed: Vec<_> = (1..MAX_VAULTS as u32)
            .map(|id| json!({ "id": id, "path": base.join(format!("v{id}")) }))
            .collect();
        fs::create_dir_all(&ts.shell.paths.root).unwrap();
        fs::write(
            &ts.shell.paths.registry,
            json!({ "version": 1, "vaults": listed }).to_string(),
        )
        .unwrap();
        let elsewhere = ts.vaults();
        ts.dialogs.answer(Some(elsewhere.clone()));
        // Fix round 2 (G5): each create records whether it reached the engine's create (its staging folder), so the
        // test shows the creation lock at work, not only the cleanup of a vault the list could not take.
        let second = second_at_staging(&ts, |shell| {
            let reached = Rc::new(Cell::new(false));
            let seen = Rc::clone(&reached);
            failpoint::observe("create.before_rename", Box::new(move || seen.set(true)));
            let answer = shell.create_vault("Work".into(), secret(PW), true);
            failpoint::disarm_all();
            (answer.map(|_| ()), reached.get())
        });
        let first_reached = Rc::new(Cell::new(false));
        let seen = Rc::clone(&first_reached);
        failpoint::observe("create.before_rename", Box::new(move || seen.set(true)));
        let (first, (second, second_reached)) = heavy(|| {
            let first = ts.shell.create_vault("Family".into(), secret(PW), false);
            (first, joined(&second))
        });
        failpoint::disarm_all();
        let full = ShellError::TooLarge { what: "vault list" };
        let answers = [
            (first.map(|_| ()), first_reached.get()),
            (second, second_reached),
        ];
        assert_eq!(
            answers.iter().filter(|(answer, _)| answer.is_ok()).count(),
            1,
            "exactly one through"
        );
        for (answer, reached) in &answers {
            if answer.is_err() {
                assert_eq!(*answer, Err(full));
                assert!(
                    !reached,
                    "refused at the room check, before anything was made"
                );
            }
        }
        let entries = ts.shell.registry.entries();
        assert_eq!(entries.len(), MAX_VAULTS);
        let default = ts.env.folder(KnownFolder::Profile).join("Lockbox Vaults");
        let on_disk: Vec<_> = [vault_folders(&default), vault_folders(&elsewhere)].concat();
        assert_eq!(on_disk.len(), 1, "no vault left off the list");
        let on_disk = fs::canonicalize(&on_disk[0]).unwrap();
        assert!(entries.iter().any(|(_, dir)| *dir == on_disk));
    }

    /// Fix round 1 (F5, F6): a vault the list cannot take after it was made is removed again, so no vault is left
    /// on disk off the list: the list's write fails, or the list would grow too large to read back.
    #[test]
    fn create_whose_listing_fails_leaves_nothing() {
        let ts = TestShell::new();
        let default = ts.env.folder(KnownFolder::Profile).join("Lockbox Vaults");
        failpoint::observe(
            "create.before_rename",
            Box::new(|| failpoint::arm("atomic_write.before_replace")),
        );
        let answer = heavy(|| ts.shell.create_vault("Family".into(), secret(PW), false));
        failpoint::disarm_all();
        assert!(
            matches!(answer, Err(ShellError::Core(_))),
            "the list's write failed"
        );
        assert!(vault_folders(&default).is_empty(), "the vault is removed");
        assert_eq!(fs::read_dir(&default).unwrap().count(), 0, "nothing left");
        assert!(ts.shell.sessions.list().is_empty());
        assert!(ts.shell.registry.entries().is_empty());

        // A list 100 bytes short of its cap: the new vault's entry does not fit.
        let base = fs::canonicalize(ts.temp.path()).unwrap();
        let seed = |chars: usize| {
            let path = base.join("x".repeat(chars));
            json!({ "version": 1, "vaults": [ { "id": 1, "path": path } ] }).to_string()
        };
        let overhead = seed(1).len() - 1;
        let seed = seed(MAX_STATE_FILE as usize - 100 - overhead);
        assert_eq!(seed.len() as u64, MAX_STATE_FILE - 100);
        fs::create_dir_all(&ts.shell.paths.root).unwrap();
        fs::write(&ts.shell.paths.registry, seed).unwrap();
        assert_eq!(ts.shell.registry.entries().len(), 1);
        let answer = heavy(|| ts.shell.create_vault("Family".into(), secret(PW), false));
        assert_eq!(
            answer.map(|_| ()),
            Err(ShellError::TooLarge { what: "vault list" })
        );
        assert!(vault_folders(&default).is_empty(), "the vault is removed");
        assert!(ts.shell.sessions.list().is_empty());
        assert_eq!(ts.shell.registry.entries().len(), 1);
    }

    /// Fix round 2 (G1): a vault the list cannot take, and that cannot be removed again either, is reported as such
    /// (`"vault not listed"`): it is on disk, and the user can add it and make a new recovery key.
    #[test]
    fn vault_left_off_the_list_is_reported() {
        let ts = TestShell::new();
        let default = ts.env.folder(KnownFolder::Profile).join("Lockbox Vaults");
        let held: Rc<RefCell<Option<fs::File>>> = Rc::default();
        let hold = Rc::clone(&held);
        let parent = default.clone();
        let shell = Arc::clone(&ts.shell);
        // Once the vault is published: the list's write fails, and its header is held open without delete sharing,
        // as a scanner might, so the removal fails too (after its retries). Fix round 3 (H1): and every vault locks
        // right then, before the create answers; the warning must survive that lock.
        failpoint::observe(
            "create.before_rename",
            Box::new(move || {
                failpoint::arm("atomic_write.before_replace");
                let (hold, parent, shell) = (Rc::clone(&hold), parent.clone(), Arc::clone(&shell));
                failpoint::observe(
                    "atomic_write.before_replace",
                    Box::new(move || {
                        if hold.borrow().is_some() {
                            return;
                        }
                        let vault = vault_folders(&parent).pop().expect("the vault is made");
                        let file = fs::OpenOptions::new()
                            .read(true)
                            .share_mode(FILE_SHARE_READ)
                            .open(vault.join(HEADER_FILE))
                            .unwrap();
                        *hold.borrow_mut() = Some(file);
                        shell.sessions.lock_all(LockReason::WindowsLocked);
                    }),
                );
            }),
        );
        let answer = heavy(|| ts.shell.create_vault("Family".into(), secret(PW), false));
        failpoint::disarm_all();
        assert!(held.borrow().is_some(), "the header was held");
        assert_eq!(
            answer.map(|_| ()),
            Err(ShellError::InvalidInput {
                what: "vault not listed"
            })
        );
        let left = vault_folders(&default);
        assert_eq!(left.len(), 1, "still on disk");
        assert!(ts.shell.sessions.list().is_empty());
        assert!(ts.shell.registry.entries().is_empty());
        drop(held.borrow_mut().take());
    }

    /// Fix round 2 (G2): adding a folder the list already holds finds its entry, however the folder is spelled
    /// (a trailing separator, another letter case), and the check never adds a separator of its own.
    #[test]
    fn adding_a_listed_folder_finds_its_entry() {
        let ts = TestShell::new();
        heavy(|| ts.shell.create_vault("Family".into(), secret(PW), false)).unwrap();
        let (id, dir) = ts.shell.registry.entries()[0].clone();
        let text = dir.to_string_lossy().into_owned();
        assert!(!text.ends_with('\\'));
        assert_eq!(ts.shell.check_location(&dir).unwrap().path, dir);
        for spelled in [
            dir.clone(),
            PathBuf::from(format!("{text}\\")),
            PathBuf::from(text.to_uppercase()),
        ] {
            ts.dialogs.answer(Some(spelled.clone()));
            let entry = done(ts.shell.add_existing_vault().unwrap());
            assert_eq!(entry.id, id, "{}", spelled.display());
        }
        assert_eq!(ts.shell.registry.entries(), vec![(id, dir)]);
    }

    /// Makes the junction `link` lead to `target` instead.
    fn retarget(link: &Path, target: &Path) {
        fs::remove_dir(link).unwrap();
        make_dir_link(link, target);
    }

    /// Fix round 2 (G4): create, add, unlock and recover use the folder their check looked at, not the path they
    /// were given: a junction on the way that is moved during the check (to another folder holding another vault)
    /// does not change where they act.
    #[test]
    fn the_checked_folder_is_the_one_used() {
        let ts = TestShell::new();
        let folder = |name: &str| {
            let dir = ts.temp.path().join(name);
            fs::create_dir(&dir).unwrap();
            dir
        };
        let (here, there) = (folder("here"), folder("there"));
        let other = heavy(|| Vault::create(&there, "Work", NEW_PW)).unwrap();
        let other_vault = other.vault.dir().to_path_buf();
        drop(other);
        let move_during_check = |link: &Path, to: &Path| {
            let (link, to) = (link.to_path_buf(), to.to_path_buf());
            ts.volumes
                .during_next_check(Box::new(move || retarget(&link, &to)));
        };

        // Create: chosen through a junction to `here`, moved to `there` mid-check.
        let parent_link = ts.vaults().join("parent-link");
        make_dir_link(&parent_link, &here);
        move_during_check(&parent_link, &there);
        ts.dialogs.answer(Some(parent_link.clone()));
        let created =
            done(heavy(|| ts.shell.create_vault("Family".into(), secret(PW), true)).unwrap());
        let made = vault_folders(&here);
        assert_eq!(made.len(), 1, "made where the check looked");
        assert_eq!(vault_folders(&there).len(), 1, "only the other vault there");
        let (id, listed) = ts.shell.registry.entries()[0].clone();
        assert_eq!(listed, fs::canonicalize(&made[0]).unwrap());
        ts.shell.sessions.lock_all(LockReason::Manual);

        // Add: the same vault through a junction, moved to the other vault mid-check.
        let vault_link = ts.vaults().join("vault-link");
        make_dir_link(&vault_link, &made[0]);
        move_during_check(&vault_link, &other_vault);
        ts.dialogs.answer(Some(vault_link.clone()));
        let entry = done(ts.shell.add_existing_vault().unwrap());
        assert_eq!((entry.id, entry.name.as_deref()), (id, Some("Family")));
        assert_eq!(ts.shell.registry.entries().len(), 1);

        // Unlock and recover: a listed folder reached through a junction, moved mid-check.
        let listed_link = ts.vaults().join("listed-link");
        make_dir_link(&listed_link, &made[0]);
        let via_link = fs::canonicalize(ts.vaults()).unwrap().join("listed-link");
        let link_id = ts.shell.registry.add(&via_link).unwrap();
        move_during_check(&listed_link, &other_vault);
        let view = heavy(|| ts.shell.unlock_vault(link_id, secret(PW))).unwrap();
        assert_eq!(view.data.info.name, "Family");
        ts.shell.sessions.lock_all(LockReason::Manual);

        retarget(&listed_link, &made[0]);
        move_during_check(&listed_link, &other_vault);
        let key = created.data.recovery_key.clone();
        let recovered = heavy(|| ts.shell.recover_vault(link_id, key, secret(NEW_PW)));
        assert_eq!(done(recovered.unwrap()).data.info.name, "Family");
    }

    /// Fix round 3 (H2): a listed folder that leads elsewhere by the time it is checked (a junction moved after the
    /// session's place was read) is refused, so a session never holds one vault under another's place. The other
    /// vault's own password and recovery key are used: without the refusal they would open it.
    #[test]
    fn session_is_named_by_the_checked_folder() {
        let ts = TestShell::new();
        let (_, family, _) = registered(&ts);
        let elsewhere = ts.temp.path().join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        let other = heavy(|| Vault::create(&elsewhere, "Work", NEW_PW)).unwrap();
        let (work, work_key) = (other.vault.dir().to_path_buf(), other.recovery.to_display());
        drop(other);
        let link = ts.vaults().join("listed-link");
        make_dir_link(&link, &family);
        let id = ts
            .shell
            .registry
            .add(&fs::canonicalize(ts.vaults()).unwrap().join("listed-link"))
            .unwrap();
        let move_once_open = || {
            retarget(&link, &family);
            let (link, work) = (link.clone(), work.clone());
            let mut moved = false;
            failpoint::observe(
                CHECKING,
                Box::new(move || {
                    if !moved {
                        moved = true;
                        retarget(&link, &work);
                    }
                }),
            );
        };
        let refused = Some(ShellError::InvalidInput { what: "folder" });

        move_once_open();
        let answer = heavy(|| ts.shell.unlock_vault(id, secret(NEW_PW)));
        failpoint::disarm_all();
        assert_eq!(answer.err(), refused);

        move_once_open();
        let answer = heavy(|| ts.shell.recover_vault(id, work_key, secret(PW)));
        failpoint::disarm_all();
        assert_eq!(answer.err(), refused);

        assert!(ts.shell.sessions.list().is_empty());
        assert!(is_free(&family) && is_free(&work));
        assert!(
            password_works(&work, NEW_PW),
            "the other vault is unchanged"
        );
    }

    #[test]
    fn unlock_by_registry_id() {
        let ts = TestShell::new();
        let (id, dir, _) = registered(&ts);
        assert_eq!(
            ts.shell.unlock_vault(id + 1, secret(PW)).err(),
            Some(ShellError::NotFound)
        );
        assert_eq!(
            heavy(|| ts.shell.unlock_vault(id, secret("not the password"))).err(),
            Some(wrong_password())
        );
        assert!(ts.shell.sessions.list().is_empty());
        let tagged = heavy(|| ts.shell.unlock_vault(id, secret(PW))).unwrap();
        assert_eq!(tagged.data.info.name, "Family");
        assert_eq!(state(&ts, tagged.session), Some(SessionState::Unlocked));
        assert!(!is_free(&dir));
    }

    #[test]
    fn unlock_rechecks_location() {
        let ts = TestShell::new();
        let (id, _, recovery) = registered(&ts);
        // The registered folder is now on a removable drive.
        ts.volumes.mount(
            &ts.vaults(),
            FakeVolume {
                drive: DriveType::Removable,
                ..LOCAL_NTFS
            },
        );
        let refused = Some(ShellError::InvalidInput {
            what: "removable drive",
        });
        assert_eq!(ts.shell.unlock_vault(id, secret(PW)).err(), refused);
        assert_eq!(
            ts.shell.recover_vault(id, recovery, secret(NEW_PW)).err(),
            refused
        );
        assert!(ts.shell.sessions.list().is_empty());
    }

    /// Fix round 1 (F2): the location check runs inside the open, so a lock of all vaults during it is seen.
    #[test]
    fn lock_during_the_location_check_is_seen() {
        let ts = TestShell::new();
        let (id, dir, recovery) = registered(&ts);
        let lock_now = || {
            let shell = Arc::clone(&ts.shell);
            ts.volumes.during_next_check(Box::new(move || {
                shell.sessions.lock_all(LockReason::WindowsLocked)
            }));
        };
        lock_now();
        assert_eq!(
            heavy(|| ts.shell.unlock_vault(id, secret(PW))).err(),
            Some(ShellError::Locked)
        );
        assert!(ts.shell.sessions.list().is_empty());
        assert!(is_free(&dir));

        // Fix round 2 (G6): the open checks its cancel before the step it cannot undo, so a lock seen during the
        // check changes nothing: no new password, no accepted header, no new vault.
        lock_now();
        assert_eq!(
            heavy(|| ts.shell.recover_vault(id, recovery.clone(), secret(NEW_PW))).err(),
            Some(ShellError::Locked)
        );
        assert!(ts.shell.sessions.list().is_empty());
        assert!(is_free(&dir));
        assert!(password_works(&dir, PW), "the password is unchanged");

        change_header(&dir);
        let before = headers(&dir);
        let asked = heavy(|| ts.shell.recover_vault(id, recovery, secret(NEW_PW))).unwrap();
        let Outcome::Confirm(Confirm::HeaderChanged { token }) = asked else {
            panic!("the changed header asks first");
        };
        lock_now();
        assert_eq!(
            heavy(|| ts.shell.recover_vault_confirm(&token, true)).err(),
            Some(ShellError::Locked)
        );
        assert_eq!(headers(&dir), before, "nothing accepted");
        assert!(is_free(&dir));

        lock_now();
        assert_eq!(
            heavy(|| ts.shell.create_vault("Work".into(), secret(PW), false)).err(),
            Some(ShellError::Locked)
        );
        let default = ts.env.folder(KnownFolder::Profile).join("Lockbox Vaults");
        assert!(
            !default.exists() || vault_folders(&default).is_empty(),
            "nothing made"
        );
        assert_eq!(ts.shell.registry.entries().len(), 1);
        assert!(ts.shell.sessions.list().is_empty());
    }

    /// Fix round 1 (F3): a folder name Windows would change on creation (here, into the state folder) is refused.
    #[test]
    fn create_refuses_a_name_windows_would_change() {
        let ts = TestShell::new();
        let local = ts.env.folder(KnownFolder::LocalAppData);
        ts.dialogs.answer(Some(local.join("Lockbox.")));
        assert_eq!(
            ts.shell
                .create_vault("Family".into(), secret(PW), true)
                .err(),
            Some(ShellError::InvalidInput { what: "folder" })
        );
        assert!(!ts.shell.paths.root.exists(), "nothing made");
        assert!(ts.shell.registry.entries().is_empty());
    }

    /// Fix round 1 (F3): the yes to a changed header checks the folder again: it may have moved drives while the
    /// question waited.
    #[test]
    fn recover_confirm_rechecks_location() {
        let ts = TestShell::new();
        let (id, dir, recovery) = registered(&ts);
        change_header(&dir);
        let before = headers(&dir);
        let asked = heavy(|| ts.shell.recover_vault(id, recovery, secret(NEW_PW))).unwrap();
        let Outcome::Confirm(Confirm::HeaderChanged { token }) = asked else {
            panic!("the changed header asks first");
        };
        ts.volumes.mount(
            &ts.vaults(),
            FakeVolume {
                drive: DriveType::Removable,
                ..LOCAL_NTFS
            },
        );
        assert_eq!(
            heavy(|| ts.shell.recover_vault_confirm(&token, true)).err(),
            Some(ShellError::InvalidInput {
                what: "removable drive"
            })
        );
        assert!(ts.shell.sessions.list().is_empty());
        assert!(is_free(&dir));
        assert_eq!(headers(&dir), before, "nothing accepted");
    }

    #[test]
    fn unlock_report_flags_reach_the_view() {
        let ts = TestShell::new();
        let (id, dir, _) = registered(&ts);

        // Fix round 1 (F13): `vault.json` damaged and its repair fails (the engine's failpoint on the repair write):
        // opened from `.bak`, and the failed repair reported.
        fs::write(dir.join(HEADER_FILE), b"damaged").unwrap();
        failpoint::arm("unlock.repair_write");
        let view = heavy(|| ts.shell.unlock_vault(id, secret(PW)));
        failpoint::disarm_all();
        let view = view.unwrap().data;
        assert!(view.used_backup_header && view.header_repair_failed && !view.header_mac_mismatch);
        let json = serde_json::to_value(&view).unwrap();
        assert_eq!(json["header_repair_failed"], true);
        ts.shell.sessions.lock_all(LockReason::Manual);

        // `vault.json` still damaged: opened from `.bak`, which the unlock now repairs. A leftover partial file is
        // cleaned up, and an unreferenced blob set aside.
        fs::write(
            dir.join("files").join("0123456789abcdef.blob.partial"),
            b"x",
        )
        .unwrap();
        let orphan = format!("{}.blob", "cd".repeat(16));
        fs::write(dir.join("files").join(&orphan), b"x").unwrap();
        let view = heavy(|| ts.shell.unlock_vault(id, secret(PW)))
            .unwrap()
            .data;
        assert!(view.used_backup_header && !view.header_mac_mismatch && !view.header_repair_failed);
        assert_eq!(view.cleanup.partials_removed, 1);
        assert_eq!(view.cleanup.orphans_quarantined, 1);
        assert!(dir.join("files").join("orphaned").join(&orphan).exists());

        // Unlocking it again while it is unlocked: the same session, no warnings, nothing cleaned.
        let again = ts.shell.unlock_vault(id, secret(PW)).unwrap();
        assert_eq!(again.session, view.info.session);
        assert!(!again.data.used_backup_header && !again.data.header_mac_mismatch);
        assert_eq!(again.data.cleanup, CleanupView::default());

        // The header changed outside Lockbox: reported, and accepted through the session.
        ts.shell.sessions.lock_all(LockReason::Manual);
        change_header(&dir);
        let tagged = heavy(|| ts.shell.unlock_vault(id, secret(PW))).unwrap();
        assert!(tagged.data.header_mac_mismatch && !tagged.data.used_backup_header);
        let json = serde_json::to_value(&tagged.data).unwrap();
        for flag in [
            "used_backup_header",
            "header_mac_mismatch",
            "header_repair_failed",
        ] {
            assert!(json[flag].is_boolean(), "{flag}");
        }
        assert_eq!(json["cleanup"]["skipped_damaged"], 0);
        ts.shell
            .accept_header(tagged.session, tagged.generation)
            .unwrap();
        ts.shell.sessions.lock_all(LockReason::Manual);
        let view = heavy(|| ts.shell.unlock_vault(id, secret(PW)))
            .unwrap()
            .data;
        assert!(!view.header_mac_mismatch);
    }

    #[test]
    fn recover_sets_new_password_before_use() {
        let ts = TestShell::new();
        let (id, dir, recovery) = registered(&ts);

        // Fix round 1 (F13): the new password cannot be written: no session ever opens, the vault is closed again,
        // and the old password still works.
        failpoint::arm("write_headers.before_first");
        let answer = heavy(|| ts.shell.recover_vault(id, recovery.clone(), secret(NEW_PW)));
        failpoint::disarm_all();
        assert!(matches!(answer, Err(ShellError::Core(_))));
        assert!(ts.shell.sessions.list().is_empty(), "no session");
        assert!(is_free(&dir));
        assert!(password_works(&dir, PW));

        let tagged = done(heavy(|| ts.shell.recover_vault(id, recovery, secret(NEW_PW))).unwrap());
        assert_eq!(tagged.data.info.name, "Family");
        assert!(
            ts.shell
                .sessions
                .read(tagged.session, tagged.generation, |_, _| Ok(()))
                .is_ok(),
            "the session is usable"
        );
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert!(!password_works(&dir, PW));
        assert!(password_works(&dir, NEW_PW));
    }

    #[test]
    fn recover_with_a_typo_or_short_password_refused() {
        let ts = TestShell::new();
        let (id, dir, recovery) = registered(&ts);
        assert!(matches!(
            ts.shell
                .recover_vault(id, secret("not a recovery key"), secret(NEW_PW)),
            Err(ShellError::Core(_))
        ));
        assert_eq!(
            heavy(|| ts
                .shell
                .recover_vault(id, recovery.clone(), secret("short")))
            .err(),
            Some(CoreError::PasswordTooShort { min: 12 }.into())
        );
        assert!(ts.shell.sessions.list().is_empty());
        assert!(is_free(&dir));
        assert!(password_works(&dir, PW));

        // Fix round 1 (F11): refused before anything else, so a changed header is not asked about (and accepted)
        // first: both header files stay as they were.
        change_header(&dir);
        let before = headers(&dir);
        assert_eq!(
            heavy(|| ts.shell.recover_vault(id, recovery, secret("short"))).err(),
            Some(CoreError::PasswordTooShort { min: 12 }.into())
        );
        assert_eq!(headers(&dir), before);
        assert!(ts.shell.sessions.list().is_empty());
        assert!(is_free(&dir));
    }

    /// Fix round 1 (F11): a password too short is refused before the folder dialog opens.
    #[test]
    fn create_with_a_short_password_refused_before_the_dialog() {
        let ts = TestShell::new();
        ts.dialogs.answer(Some(ts.vaults()));
        assert_eq!(
            ts.shell
                .create_vault("Family".into(), secret("short"), true)
                .err(),
            Some(CoreError::PasswordTooShort { min: 12 }.into())
        );
        assert_eq!(ts.dialogs.opened(), 0, "no dialog");
        assert_eq!(fs::read_dir(ts.vaults()).unwrap().count(), 0);
    }

    #[test]
    fn recover_after_changed_header_asks_first() {
        let ts = TestShell::new();
        let (id, dir, recovery) = registered(&ts);
        change_header(&dir);
        let before = headers(&dir);
        let ask = || {
            let answer = heavy(|| ts.shell.recover_vault(id, recovery.clone(), secret(NEW_PW)));
            let Ok(Outcome::Confirm(Confirm::HeaderChanged { token })) = answer else {
                panic!("the changed header asks first");
            };
            assert!(ts.shell.sessions.list().is_empty(), "no session yet");
            assert!(!is_free(&dir), "the unlocked vault waits for the answer");
            token
        };

        // No: dismissed, the vault closed, nothing changed on disk.
        let token = ask();
        assert!(matches!(
            ts.shell.recover_vault_confirm(&token, false),
            Ok(Outcome::Dismissed)
        ));
        assert!(is_free(&dir));
        assert_eq!(headers(&dir), before);

        // Every vault locks before the answer: the choice is gone, and so is the vault's `.lock`.
        let token = ask();
        ts.shell.sessions.lock_all(LockReason::WindowsLocked);
        assert!(is_free(&dir));
        assert!(matches!(
            ts.shell.recover_vault_confirm(&token, true),
            Err(ShellError::NotFound)
        ));
        assert_eq!(headers(&dir), before);

        // Yes: the header is accepted and the new password set, then the session opens.
        let token = ask();
        let tagged = done(heavy(|| ts.shell.recover_vault_confirm(&token, true)).unwrap());
        assert_eq!(tagged.data.info.name, "Renamed");
        assert_eq!(state(&ts, tagged.session), Some(SessionState::Unlocked));
        ts.shell.sessions.lock_all(LockReason::Manual);
        let (_, report) = heavy(|| Vault::unlock_with_password(&dir, NEW_PW)).unwrap();
        assert!(!report.header_mac_mismatch);
    }

    /// Fix round 1 (F13): a lock that lands after the yes accepted the header and set the new password, before the
    /// session opens: the change is reported (`LockedAfterChange`), and nothing stays open.
    #[test]
    fn lock_after_the_recovery_yes_set_the_password() {
        let ts = TestShell::new();
        let (id, dir, recovery) = registered(&ts);
        change_header(&dir);
        let asked = heavy(|| ts.shell.recover_vault(id, recovery, secret(NEW_PW))).unwrap();
        let Outcome::Confirm(Confirm::HeaderChanged { token }) = asked else {
            panic!("the changed header asks first");
        };
        let shell = Arc::clone(&ts.shell);
        failpoint::observe(
            PASSWORD_SET,
            Box::new(move || shell.sessions.lock_all(LockReason::WindowsLocked)),
        );
        let answer = heavy(|| ts.shell.recover_vault_confirm(&token, true));
        failpoint::disarm_all();
        assert_eq!(
            answer.err(),
            Some(ShellError::LockedAfterChange { what: "password" })
        );
        assert!(ts.shell.sessions.list().is_empty());
        assert!(is_free(&dir));
        assert!(password_works(&dir, NEW_PW), "the change went through");
        let (_, report) = heavy(|| Vault::unlock_with_password(&dir, NEW_PW)).unwrap();
        assert!(!report.header_mac_mismatch, "and the header was accepted");
    }

    #[test]
    fn recover_unlocked_vault_refused() {
        let ts = TestShell::new();
        let (id, dir, _) = registered(&ts);
        heavy(|| ts.shell.unlock_vault(id, secret(PW))).unwrap();
        // Refused before the key is even read: not a typo error for this one.
        assert_eq!(
            ts.shell
                .recover_vault(id, secret("not a recovery key"), secret(NEW_PW))
                .err(),
            Some(ShellError::InvalidInput {
                what: "vault is unlocked"
            })
        );
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert!(password_works(&dir, PW));
    }

    #[test]
    fn password_and_recovery_key_changed_from_the_session() {
        let ts = TestShell::new();
        let (id, dir, old_recovery) = registered(&ts);
        let tagged = heavy(|| ts.shell.unlock_vault(id, secret(PW))).unwrap();
        let (session, generation) = (tagged.session, tagged.generation);
        let changed = heavy(|| {
            ts.shell
                .change_password(session, generation, secret(NEW_PW))
        });
        assert_eq!(changed.unwrap().generation, generation);
        let recovery = heavy(|| ts.shell.regenerate_recovery(session, generation)).unwrap();
        assert_ne!(recovery.data.as_str(), old_recovery.as_str());
        // A stale generation is refused.
        assert_eq!(
            ts.shell.accept_header(session, generation + 1).err(),
            Some(ShellError::Locked)
        );
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert!(password_works(&dir, NEW_PW));
        let new_key = RecoverySecret::parse(&recovery.data).unwrap();
        assert!(heavy(|| Vault::unlock_with_recovery(&dir, &new_key)).is_ok());
        let old_key = RecoverySecret::parse(&old_recovery).unwrap();
        assert!(heavy(|| Vault::unlock_with_recovery(&dir, &old_key)).is_err());
    }

    #[test]
    fn add_existing_vault_checks_the_folder() {
        let ts = TestShell::new();
        // Closed dialog.
        assert!(matches!(
            ts.shell.add_existing_vault(),
            Ok(Outcome::Dismissed)
        ));

        // A folder with no vault in it.
        let plain = ts.temp.path().join("plain");
        fs::create_dir(&plain).unwrap();
        ts.dialogs.answer(Some(plain));
        assert_eq!(
            ts.shell.add_existing_vault().err(),
            Some(ShellError::InvalidInput {
                what: "not a vault folder"
            })
        );

        // A vault: added once, with its name.
        let created = heavy(|| Vault::create(&ts.vaults(), "Family", PW)).unwrap();
        let dir = created.vault.dir().to_path_buf();
        drop(created);
        for _ in 0..2 {
            ts.dialogs.answer(Some(dir.clone()));
            let entry = done(ts.shell.add_existing_vault().unwrap());
            assert_eq!(entry.id, 1);
            assert_eq!(entry.name.as_deref(), Some("Family"));
            assert!(entry.available);
        }
        assert_eq!(ts.shell.registry.entries().len(), 1);

        // A vault on a removable drive is refused.
        ts.volumes.mount(
            &ts.vaults(),
            FakeVolume {
                drive: DriveType::Removable,
                ..LOCAL_NTFS
            },
        );
        ts.dialogs.answer(Some(dir));
        assert_eq!(
            ts.shell.add_existing_vault().err(),
            Some(ShellError::InvalidInput {
                what: "removable drive"
            })
        );
    }

    /// Fix round 1 (F7): adding a vault in a cloud folder asks first, and adds it on the user's yes.
    #[test]
    fn add_existing_cloud_folder_asks_then_adds() {
        let ts = TestShell::new();
        let created = heavy(|| Vault::create(&ts.vaults(), "Family", PW)).unwrap();
        let dir = created.vault.dir().to_path_buf();
        drop(created);
        ts.volumes.add_sync_root(&ts.vaults());
        let ask = || {
            ts.dialogs.answer(Some(dir.clone()));
            let Ok(Outcome::Confirm(Confirm::CloudFolder { token })) =
                ts.shell.add_existing_vault()
            else {
                panic!("a cloud folder asks first");
            };
            assert!(ts.shell.registry.entries().is_empty(), "not added yet");
            token
        };

        // A lock of all vaults before the yes drops the question.
        let token = ask();
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert_eq!(
            ts.shell.add_existing_vault_confirm(&token).err(),
            Some(ShellError::NotFound)
        );

        let token = ask();
        let entry = done(ts.shell.add_existing_vault_confirm(&token).unwrap());
        assert_eq!(entry.id, 1);
        assert_eq!(entry.name.as_deref(), Some("Family"));
        assert_eq!(ts.shell.registry.entries().len(), 1);
        assert_eq!(ts.dialogs.opened(), 2, "no dialog on the yes");
        // Used up.
        assert_eq!(
            ts.shell.add_existing_vault_confirm(&token).err(),
            Some(ShellError::NotFound)
        );

        // A token for another question is used up and refused, and its choice dropped.
        ts.dialogs.answer(Some(ts.vaults()));
        let asked = ts.shell.create_vault("Work".into(), secret(PW), true);
        let Ok(Outcome::Confirm(Confirm::CloudFolder { token })) = asked else {
            panic!("a cloud folder asks first");
        };
        assert_eq!(
            ts.shell.add_existing_vault_confirm(&token).err(),
            Some(ShellError::NotFound)
        );
        assert_eq!(
            ts.shell.create_vault_confirm(&token).err(),
            Some(ShellError::NotFound)
        );
    }

    /// Fix round 1 (F7): an unlock or a recovery of a vault whose folder a cloud provider syncs says which one, as a
    /// fixed name: the page warns (spec §6.10).
    #[test]
    fn unlock_and_recover_in_a_cloud_folder_say_so() {
        let ts = TestShell::new();
        let (id, dir, recovery) = registered(&ts);
        let view = heavy(|| ts.shell.unlock_vault(id, secret(PW)))
            .unwrap()
            .data;
        assert_eq!(view.cloud, None);
        assert_eq!(serde_json::to_value(&view).unwrap()["cloud"], Value::Null);
        ts.shell.sessions.lock_all(LockReason::Manual);

        ts.env.set_var("OneDrive", ts.vaults().into_os_string());
        let view = heavy(|| ts.shell.unlock_vault(id, secret(PW)))
            .unwrap()
            .data;
        assert_eq!(view.cloud, Some(CloudProvider::OneDrive));
        assert_eq!(serde_json::to_value(&view).unwrap()["cloud"], "OneDrive");
        ts.shell.sessions.lock_all(LockReason::Manual);

        let recovered = heavy(|| ts.shell.recover_vault(id, recovery.clone(), secret(NEW_PW)));
        let view = done(recovered.unwrap()).data;
        assert_eq!(view.cloud, Some(CloudProvider::OneDrive));

        // After a changed header, the yes says so too.
        ts.shell.sessions.lock_all(LockReason::Manual);
        change_header(&dir);
        let asked = heavy(|| ts.shell.recover_vault(id, recovery, secret(PW))).unwrap();
        let Outcome::Confirm(Confirm::HeaderChanged { token }) = asked else {
            panic!("the changed header asks first");
        };
        let view = done(heavy(|| ts.shell.recover_vault_confirm(&token, true)).unwrap()).data;
        assert_eq!(view.cloud, Some(CloudProvider::OneDrive));
    }

    /// Fix round 1 (F8): a recovery answers with the recovery unlock's report, as an unlock does: files the cleanup
    /// moved or removed, a header opened from its backup.
    #[test]
    fn recover_reports_what_the_unlock_found() {
        let ts = TestShell::new();
        let (id, dir, recovery) = registered(&ts);
        fs::write(dir.join(HEADER_FILE), b"damaged").unwrap();
        let orphan = dir.join("files").join(format!("{}.blob", "ab".repeat(16)));
        fs::write(&orphan, b"x").unwrap();
        let recovered = heavy(|| ts.shell.recover_vault(id, recovery.clone(), secret(NEW_PW)));
        let tagged = done(recovered.unwrap());
        let view = tagged.data;
        assert_eq!(view.info.name, "Family");
        assert_eq!(view.info.session, tagged.session);
        assert!(view.used_backup_header && !view.header_mac_mismatch);
        assert_eq!(view.cleanup.orphans_quarantined, 1);

        // Through the changed-header question: the first unlock's report, with the header now accepted.
        ts.shell.sessions.lock_all(LockReason::Manual);
        change_header(&dir);
        fs::write(
            dir.join("files").join("0123456789abcdef.blob.partial"),
            b"x",
        )
        .unwrap();
        let asked = heavy(|| ts.shell.recover_vault(id, recovery, secret(PW))).unwrap();
        let Outcome::Confirm(Confirm::HeaderChanged { token }) = asked else {
            panic!("the changed header asks first");
        };
        let view = done(heavy(|| ts.shell.recover_vault_confirm(&token, true)).unwrap()).data;
        assert_eq!(view.info.name, "Renamed");
        assert!(!view.header_mac_mismatch, "accepted by the yes");
        assert_eq!(view.cleanup.partials_removed, 1);
    }

    // ---- The "recovery key not confirmed" mark (Plan 4A, Task 6) ----

    /// The shell's vault-state file, read as JSON.
    fn state_file(ts: &TestShell) -> Value {
        serde_json::from_slice(&fs::read(&ts.shell.paths.vault_state).unwrap()).unwrap()
    }

    /// The vault the test shell lists first.
    fn listed_dir(ts: &TestShell) -> PathBuf {
        ts.shell.registry.entries()[0].1.clone()
    }

    /// A state file 100 bytes short of its cap, so one more note cannot be saved: its text.
    fn nearly_full_state(ts: &TestShell) -> String {
        let base = fs::canonicalize(ts.temp.path()).unwrap();
        let seed = |chars: usize| {
            let path = base.join("x".repeat(chars));
            json!({
                "version": 1,
                "vaults": [ { "path": path, "unconfirmed": false, "last_backup": "d" } ]
            })
            .to_string()
        };
        let overhead = seed(1).len() - 1;
        let seed = seed(MAX_STATE_FILE as usize - 100 - overhead);
        assert_eq!(seed.len() as u64, MAX_STATE_FILE - 100);
        fs::create_dir_all(&ts.shell.paths.root).unwrap();
        fs::write(&ts.shell.paths.vault_state, &seed).unwrap();
        seed
    }

    /// The mark is on disk before the engine makes the vault, in the place the vault is then made in.
    #[test]
    fn mark_written_before_create() {
        let ts = TestShell::new();
        let seen: Rc<RefCell<Option<(Value, bool)>>> = Rc::default();
        let (file, record) = (ts.shell.paths.vault_state.clone(), Rc::clone(&seen));
        failpoint::observe(
            "create.before_rename",
            Box::new(move || {
                let state: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
                let place = PathBuf::from(state["vaults"][0]["path"].as_str().unwrap());
                *record.borrow_mut() = Some((state, place.exists()));
            }),
        );
        let created = heavy(|| ts.shell.create_vault("Family".into(), secret(PW), false));
        failpoint::disarm_all();
        let tagged = done(created.unwrap());
        let (state, existed) = seen.borrow_mut().take().expect("the engine's create ran");
        assert!(!existed, "the vault was not there yet");
        assert_eq!(state["vaults"].as_array().unwrap().len(), 1);
        assert_eq!(state["vaults"][0]["unconfirmed"], true);

        // The mark names the folder the vault was made in, the one on the list and the session's.
        let dir = listed_dir(&ts);
        let marked = PathBuf::from(state["vaults"][0]["path"].as_str().unwrap());
        assert!(crate::os::same_path(&marked, &dir));
        assert!(ts.shell.vault_state.is_unconfirmed(&dir));
        assert_eq!(read_vault_name(&dir).unwrap(), "Family");
        // It stays until the key is confirmed: another unlock says so.
        ts.shell.sessions.lock_all(LockReason::Manual);
        let id = ts.shell.registry.entries()[0].0;
        let view = heavy(|| ts.shell.unlock_vault(id, secret(PW))).unwrap();
        assert!(view.data.recovery_unconfirmed);
        assert_eq!(view.session, tagged.session);
    }

    /// A refusal to write the mark stops the create before anything is made: no vault, no staging folder, no list
    /// entry, no session, so no key was ever made.
    #[test]
    fn no_key_made_if_mark_cannot_be_written() {
        let ts = TestShell::new();
        let default = ts.env.folder(KnownFolder::Profile).join("Lockbox Vaults");
        let reached = Rc::new(Cell::new(false));
        let seen = Rc::clone(&reached);
        failpoint::observe("create.before_rename", Box::new(move || seen.set(true)));
        let nothing_made = |ts: &TestShell| {
            assert!(!reached.get(), "the engine never started a vault");
            assert_eq!(fs::read_dir(&default).unwrap().count(), 0, "nothing made");
            assert!(ts.shell.registry.entries().is_empty());
            assert!(ts.shell.sessions.list().is_empty());
        };

        // The write fails.
        failpoint::arm("atomic_write.before_replace");
        let answer = heavy(|| ts.shell.create_vault("Family".into(), secret(PW), false));
        failpoint::disarm_all();
        assert!(matches!(answer, Err(ShellError::Core(view)) if view.kind == "io"));
        nothing_made(&ts);
        assert!(!ts.shell.paths.vault_state.exists());

        // The note would not fit.
        let seed = nearly_full_state(&ts);
        let answer = heavy(|| ts.shell.create_vault("Family".into(), secret(PW), false));
        assert_eq!(
            answer.err(),
            Some(ShellError::TooLarge {
                what: "vault state"
            })
        );
        nothing_made(&ts);
        assert_eq!(
            fs::read_to_string(&ts.shell.paths.vault_state).unwrap(),
            seed
        );
        failpoint::disarm_all();
    }

    /// A cloud folder still asks first: the mark is written only on the yes, with the vault.
    #[test]
    fn cloud_folder_asks_before_the_mark_is_written() {
        let ts = TestShell::new();
        let synced = ts.vaults();
        ts.volumes.add_sync_root(&synced);
        ts.dialogs.answer(Some(synced.clone()));
        let answer = ts.shell.create_vault("Family".into(), secret(PW), true);
        let Ok(Outcome::Confirm(Confirm::CloudFolder { token })) = answer else {
            panic!("a cloud folder asks first");
        };
        assert!(
            !ts.shell.paths.vault_state.exists(),
            "no mark before the yes"
        );
        done(heavy(|| ts.shell.create_vault_confirm(&token)).unwrap());
        assert!(ts.shell.vault_state.is_unconfirmed(&listed_dir(&ts)));
    }

    /// A create that makes nothing leaves no mark behind; one that leaves a vault (not listed, or a lock that came
    /// after it was made) keeps its mark, since its key was never shown.
    #[test]
    fn a_create_that_made_nothing_leaves_no_mark() {
        let ts = TestShell::new();
        // The engine refuses (a name that is only spaces): refused after the mark, so the mark is taken back.
        let default = ts.env.folder(KnownFolder::Profile).join("Lockbox Vaults");
        let answer = heavy(|| ts.shell.create_vault("   ".into(), secret(PW), false));
        assert!(answer.is_err());
        assert_eq!(state_file(&ts)["vaults"], json!([]));

        // The vault list cannot take the vault (100 bytes short of its cap), and it is removed again: nothing made,
        // no mark.
        let base = fs::canonicalize(ts.temp.path()).unwrap();
        let seed = |chars: usize| {
            let path = base.join("x".repeat(chars));
            json!({ "version": 1, "vaults": [ { "id": 1, "path": path } ] }).to_string()
        };
        let overhead = seed(1).len() - 1;
        fs::write(
            &ts.shell.paths.registry,
            seed(MAX_STATE_FILE as usize - 100 - overhead),
        )
        .unwrap();
        let answer = heavy(|| ts.shell.create_vault("Family".into(), secret(PW), false));
        assert_eq!(
            answer.map(|_| ()),
            Err(ShellError::TooLarge { what: "vault list" })
        );
        assert!(vault_folders(&default).is_empty(), "the vault is removed");
        assert_eq!(state_file(&ts)["vaults"], json!([]));
        fs::remove_file(&ts.shell.paths.registry).unwrap();

        // A lock right after the vault was made: it exists, is listed, was never shown its key. The mark stays.
        let shell = Arc::clone(&ts.shell);
        failpoint::observe(
            "create.before_rename",
            Box::new(move || shell.sessions.lock_all(LockReason::WindowsLocked)),
        );
        let answer = heavy(|| ts.shell.create_vault("Work".into(), secret(PW), false));
        failpoint::disarm_all();
        assert_eq!(
            answer.err(),
            Some(ShellError::LockedAfterChange {
                what: "vault created"
            })
        );
        assert!(ts.shell.vault_state.is_unconfirmed(&listed_dir(&ts)));
        assert_eq!(state_file(&ts)["vaults"].as_array().unwrap().len(), 1);
    }

    /// A new key's mark is on disk before the header changes.
    #[test]
    fn mark_written_before_new_key() {
        let ts = TestShell::new();
        let (session, generation) = ts.open_vault("Family");
        let dir = listed_dir(&ts);
        ts.shell.recovery_confirmed(session, generation).unwrap();
        assert!(!ts.shell.vault_state.is_unconfirmed(&dir));

        let seen = Rc::new(Cell::new(None));
        let (shell, record, dir_seen) = (Arc::clone(&ts.shell), Rc::clone(&seen), dir.clone());
        failpoint::observe(
            "write_headers.before_first",
            Box::new(move || record.set(Some(shell.vault_state.is_unconfirmed(&dir_seen)))),
        );
        let key = heavy(|| ts.shell.regenerate_recovery(session, generation));
        failpoint::disarm_all();
        key.unwrap();
        assert_eq!(seen.get(), Some(true), "marked when the header was written");
        assert!(
            ts.shell.vault_state.is_unconfirmed(&dir),
            "and stays marked"
        );
    }

    /// A refusal to write the mark stops the new key before the header is touched: the old key still works.
    #[test]
    fn no_new_key_if_mark_cannot_be_written() {
        let ts = TestShell::new();
        let (session, generation) = ts.open_vault("Family");
        let dir = listed_dir(&ts);
        ts.shell.recovery_confirmed(session, generation).unwrap();
        let before = headers(&dir);
        let reached = Rc::new(Cell::new(false));
        let seen = Rc::clone(&reached);
        failpoint::observe(
            "write_headers.before_first",
            Box::new(move || seen.set(true)),
        );

        // The write fails.
        failpoint::arm("atomic_write.before_replace");
        let answer = heavy(|| ts.shell.regenerate_recovery(session, generation));
        failpoint::disarm_all();
        assert!(matches!(answer.err(), Some(ShellError::Core(view)) if view.kind == "io"));
        assert!(!reached.get());
        assert_eq!(headers(&dir), before, "no new key");
        assert!(!ts.shell.vault_state.is_unconfirmed(&dir));

        // The note would not fit.
        let seed = nearly_full_state(&ts);
        let answer = heavy(|| ts.shell.regenerate_recovery(session, generation));
        assert_eq!(
            answer.err(),
            Some(ShellError::TooLarge {
                what: "vault state"
            })
        );
        assert!(!reached.get());
        assert_eq!(headers(&dir), before, "no new key");
        assert_eq!(
            fs::read_to_string(&ts.shell.paths.vault_state).unwrap(),
            seed
        );
        failpoint::disarm_all();
    }

    /// A stale generation, a foreign session and a read-only copy make no key and write no mark.
    #[test]
    fn new_key_refused_stale_foreign_and_read_only_writes_no_mark() {
        let ts = TestShell::new();
        let (session, generation) = ts.open_vault("Family");
        let dir = listed_dir(&ts);
        ts.shell.recovery_confirmed(session, generation).unwrap();
        let before = headers(&dir);
        assert_eq!(
            ts.shell.regenerate_recovery(session, generation + 1).err(),
            Some(ShellError::Locked)
        );
        assert_eq!(
            ts.shell
                .regenerate_recovery(SessionId(session.0 + 100), generation)
                .err(),
            Some(ShellError::NotFound)
        );
        assert_eq!(headers(&dir), before);
        assert!(!ts.shell.vault_state.is_unconfirmed(&dir));

        // A read-only copy: refused, and no mark is written for it (nor for anything else).
        let backup = ts.folder("Backups").join("Family.lockbox-backup");
        ts.dialogs.answer(Some(backup.clone()));
        done(
            heavy(|| ts.shell.backup_vault(session, generation))
                .unwrap()
                .data,
        );
        ts.shell.sessions.lock_all(LockReason::Manual);
        ts.dialogs.answer(Some(backup));
        let credential = super::super::backup::CredentialArg::Password(secret(PW));
        let copy = done(heavy(|| ts.shell.open_backup_read_only(credential)).unwrap());
        assert!(copy.data.read_only);
        let state_before = fs::read(&ts.shell.paths.vault_state).unwrap();
        assert_eq!(
            heavy(|| ts.shell.regenerate_recovery(copy.session, copy.generation)).err(),
            Some(ShellError::ReadOnly)
        );
        assert_eq!(
            fs::read(&ts.shell.paths.vault_state).unwrap(),
            state_before,
            "the state file is unchanged"
        );
        assert_eq!(headers(&dir), before);
    }

    /// A mark that cannot be read for a reason other than damage (another program holds the file) is taken for a mark,
    /// not for none: the unlock then makes a new key rather than letting the person fill a vault whose key they never
    /// saw. A damaged file is another matter (it reads as empty; see `damaged_state_file_starts_empty`).
    #[test]
    fn an_unreadable_state_file_counts_as_a_mark() {
        let ts = TestShell::new();
        let (session, generation) = ts.open_vault("Family");
        ts.shell.recovery_confirmed(session, generation).unwrap();
        let id = ts.shell.registry.entries()[0].0;
        ts.shell.sessions.lock_all(LockReason::Manual);
        let view = heavy(|| ts.shell.unlock_vault(id, secret(PW))).unwrap();
        assert!(
            !view.data.recovery_unconfirmed,
            "a confirmed key shows nothing"
        );
        ts.shell.sessions.lock_all(LockReason::Manual);

        // A folder where the file should be: opening it for reading fails, and it is not a damaged file.
        fs::remove_file(&ts.shell.paths.vault_state).unwrap();
        fs::create_dir(&ts.shell.paths.vault_state).unwrap();
        let view = heavy(|| ts.shell.unlock_vault(id, secret(PW))).unwrap();
        assert!(view.data.recovery_unconfirmed);
        // Unlocking again while unlocked reads it again.
        assert!(
            ts.shell
                .unlock_vault(id, secret(PW))
                .unwrap()
                .data
                .recovery_unconfirmed
        );
        // A read-only copy still shows nothing, whatever the file.
        let folder = Location::folder(&listed_dir(&ts)).unwrap();
        assert!(!ts.shell.recovery_unconfirmed(&folder, true));
    }

    /// Closing the app (or any lock) at the key screen leaves the mark: the next unlock, with the password, with the
    /// recovery key, or by a yes to a changed header, says so, and so does an unlock of a vault already unlocked.
    #[test]
    fn unconfirmed_mark_makes_a_new_key_at_next_unlock() {
        let ts = TestShell::new();
        let created = heavy(|| ts.shell.create_vault("Family".into(), secret(PW), false));
        let created = done(created.unwrap());
        let key = created.data.recovery_key.clone();
        let dir = listed_dir(&ts);
        let id = ts.shell.registry.entries()[0].0;
        // The app closes at the key screen.
        ts.shell.sessions.lock_all(LockReason::AppClosing);

        let view = heavy(|| ts.shell.unlock_vault(id, secret(PW))).unwrap();
        assert!(view.data.recovery_unconfirmed);
        assert_eq!(
            serde_json::to_value(&view.data).unwrap()["recovery_unconfirmed"],
            true
        );
        // Unlocking again while unlocked: no other warning, and the mark is read again.
        let again = ts.shell.unlock_vault(id, secret(PW)).unwrap();
        assert_eq!(again.session, view.session);
        assert!(!again.data.used_backup_header && again.data.cleanup == CleanupView::default());
        assert!(again.data.recovery_unconfirmed);

        // The new key needs no password; once confirmed, the next unlock says nothing.
        let (session, generation) = (view.session, view.generation);
        let fresh = heavy(|| ts.shell.regenerate_recovery(session, generation)).unwrap();
        assert_ne!(fresh.data.as_str(), key.as_str());
        let after = ts.shell.unlock_vault(id, secret(PW)).unwrap();
        assert!(after.data.recovery_unconfirmed, "still unconfirmed");
        ts.shell.recovery_confirmed(session, generation).unwrap();
        assert!(
            !ts.shell
                .unlock_vault(id, secret(PW))
                .unwrap()
                .data
                .recovery_unconfirmed
        );
        ts.shell.sessions.lock_all(LockReason::Manual);
        let view = heavy(|| ts.shell.unlock_vault(id, secret(PW))).unwrap();
        assert!(!view.data.recovery_unconfirmed);
        ts.shell.sessions.lock_all(LockReason::Manual);

        // A mark again (a vault the person made a new key for and never confirmed): by the recovery key.
        ts.shell.vault_state.mark_unconfirmed(&dir).unwrap();
        let recovered = heavy(|| {
            ts.shell
                .recover_vault(id, fresh.data.clone(), secret(NEW_PW))
        });
        assert!(done(recovered.unwrap()).data.recovery_unconfirmed);
        ts.shell.sessions.lock_all(LockReason::Manual);

        // And through the changed header's yes.
        change_header(&dir);
        let asked = heavy(|| ts.shell.recover_vault(id, fresh.data.clone(), secret(PW))).unwrap();
        let Outcome::Confirm(Confirm::HeaderChanged { token }) = asked else {
            panic!("the changed header asks first");
        };
        let view = done(heavy(|| ts.shell.recover_vault_confirm(&token, true)).unwrap());
        assert!(view.data.recovery_unconfirmed);
    }

    /// A read-only copy never shows the mark, however it is spelled to the rule, and cannot clear the folder's.
    #[test]
    fn read_only_copy_with_same_id_never_shows_the_mark() {
        let ts = TestShell::new();
        let (session, generation) = ts.open_vault("Family");
        let dir = listed_dir(&ts);
        assert!(ts.shell.vault_state.is_unconfirmed(&dir));
        let backups = ts.folder("Backups");
        let backup = backups.join("Family.lockbox-backup");
        ts.dialogs.answer(Some(backup.clone()));
        done(
            heavy(|| ts.shell.backup_vault(session, generation))
                .unwrap()
                .data,
        );
        ts.shell.sessions.lock_all(LockReason::Manual);

        // The copy holds the vault's ID and is opened read-only.
        ts.dialogs.answer(Some(backup.clone()));
        let credential = super::super::backup::CredentialArg::Password(secret(PW));
        let opened = done(heavy(|| ts.shell.open_backup_read_only(credential)).unwrap());
        assert!(opened.data.read_only);
        let copy = Location::backup(&backup).unwrap();
        assert!(!ts.shell.recovery_unconfirmed(&copy, true));
        assert!(!ts.shell.vault_state.is_unconfirmed(copy.path()));
        // Even asked about the marked folder, a read-only session shows nothing.
        let folder = Location::folder(&dir).unwrap();
        assert!(ts.shell.recovery_unconfirmed(&folder, false));
        assert!(!ts.shell.recovery_unconfirmed(&folder, true));
        // And it cannot clear the folder's mark.
        assert_eq!(
            ts.shell
                .recovery_confirmed(opened.session, opened.generation)
                .err(),
            Some(ShellError::ReadOnly)
        );
        assert!(ts.shell.vault_state.is_unconfirmed(&dir));
    }

    #[test]
    fn recovery_confirmed_clears_the_mark() {
        let ts = TestShell::new();
        let (session, generation) = ts.open_vault("Family");
        let other = ts.open_vault("Work");
        let (dir, other_dir) = (
            ts.shell.registry.entries()[0].1.clone(),
            ts.shell.registry.entries()[1].1.clone(),
        );
        assert!(ts.shell.vault_state.is_unconfirmed(&dir));
        let answer = ts.shell.recovery_confirmed(session, generation).unwrap();
        assert_eq!(
            serde_json::to_value(&answer).unwrap(),
            json!({ "session": session.0, "generation": generation, "data": null })
        );
        assert!(!ts.shell.vault_state.is_unconfirmed(&dir));
        assert!(
            ts.shell.vault_state.is_unconfirmed(&other_dir),
            "only this session's vault"
        );
        // Clearing a mark that is not there is a success.
        ts.shell.recovery_confirmed(session, generation).unwrap();
        ts.shell.recovery_confirmed(other.0, other.1).unwrap();
        ts.shell.sessions.lock_all(LockReason::Manual);
        let id = ts.shell.registry.entries()[0].0;
        let view = heavy(|| ts.shell.unlock_vault(id, secret(PW))).unwrap();
        assert!(!view.data.recovery_unconfirmed);
    }

    #[test]
    fn recovery_confirmed_refused_stale_and_read_only() {
        let ts = TestShell::new();
        let (session, generation) = ts.open_vault("Family");
        let dir = listed_dir(&ts);
        // A stale generation, a session that is not there, and a session that has locked since.
        assert_eq!(
            ts.shell.recovery_confirmed(session, generation + 1).err(),
            Some(ShellError::Locked)
        );
        assert_eq!(
            ts.shell
                .recovery_confirmed(SessionId(session.0 + 100), generation)
                .err(),
            Some(ShellError::NotFound)
        );
        assert!(ts.shell.vault_state.is_unconfirmed(&dir), "nothing cleared");
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert_eq!(
            ts.shell.recovery_confirmed(session, generation).err(),
            Some(ShellError::Locked)
        );
        assert!(ts.shell.vault_state.is_unconfirmed(&dir));
        // A read-only copy is refused (also in `read_only_copy_with_same_id_never_shows_the_mark`).
        let (session, generation) = ts.open_vault("Work");
        let backup = ts.folder("Backups").join("Work.lockbox-backup");
        ts.dialogs.answer(Some(backup.clone()));
        done(
            heavy(|| ts.shell.backup_vault(session, generation))
                .unwrap()
                .data,
        );
        ts.shell.sessions.lock_all(LockReason::Manual);
        ts.dialogs.answer(Some(backup));
        let credential = super::super::backup::CredentialArg::Password(secret(PW));
        let copy = done(heavy(|| ts.shell.open_backup_read_only(credential)).unwrap());
        let refused = ts.shell.recovery_confirmed(copy.session, copy.generation);
        assert_eq!(refused.err(), Some(ShellError::ReadOnly));
        let json = serde_json::to_value(ShellError::ReadOnly).unwrap();
        assert_eq!(json, json!({ "code": "read_only" }));
    }

    /// The answer of an unlock, with the new field last.
    #[test]
    fn unlock_view_json_is_pinned() {
        let info = SessionInfo {
            session: SessionId(7),
            generation: 3,
            name: "Family".to_owned(),
            read_only: false,
            state: SessionState::Unlocked,
        };
        let cleanup = r#"{"partials_removed":0,"temps_removed":0,"retired_deleted":0,"purges_finished":0,"orphans_quarantined":0,"orphans_restored":0,"skipped_damaged":0,"failed":0}"#;
        let expected = |mark: bool| {
            format!(
                r#"{{"info":{{"session":7,"generation":3,"name":"Family","read_only":false,"state":"unlocked"}},"used_backup_header":false,"header_mac_mismatch":false,"header_repair_failed":false,"cleanup":{cleanup},"cloud":null,"recovery_unconfirmed":{mark}}}"#
            )
        };
        for mark in [true, false] {
            let view = already_unlocked_view(info.clone(), mark);
            assert_eq!(serde_json::to_string(&view).unwrap(), expected(mark));
        }
        let report = UnlockReport {
            used_backup_header: false,
            header_mac_mismatch: false,
            header_repair_failed: false,
            cleanup: CleanupReport::default(),
        };
        let view = unlock_view(info, (report, None, true));
        assert_eq!(serde_json::to_string(&view).unwrap(), expected(true));
    }

    /// `recovery_confirmed`'s answer, and its request.
    #[test]
    fn recovery_confirmed_answer_and_request_are_pinned() {
        let answer = Tagged {
            session: SessionId(7),
            generation: 3,
            data: (),
        };
        assert_eq!(
            serde_json::to_string(&answer).unwrap(),
            r#"{"session":7,"generation":3,"data":null}"#
        );
        // The same request as `regenerate_recovery` and `accept_header`, with nothing else allowed.
        refuses_a_path::<SessionArg>(json!({ "session": 7, "generation": 3 }));
    }

    /// `body` parses as the request `T`, and the same body with a `path` added is refused with the fixed answer.
    /// `commands::args` runs this same parser on every command's request; a Tauri test app cannot run inside this
    /// test program (it lacks the Common Controls 6 manifest that `build.rs` gives only `tests/`), and
    /// `tests/ipc.rs` shows a real request reaching the parser.
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

    #[test]
    fn request_with_a_path_field_refused() {
        let token = FAKE_TOKEN;
        refuses_a_path::<CreateVault>(
            json!({ "name": "Family", "password": PW, "choose_folder": true }),
        );
        // `add_existing_vault`, `list_vaults` and `start_new_vault_list`.
        refuses_a_path::<NoArgs>(json!({}));
        refuses_a_path::<VaultArg>(json!({ "id": 1 }));
        // `create_vault_confirm` and `add_existing_vault_confirm`.
        refuses_a_path::<TokenArg>(json!({ "token": token }));
        refuses_a_path::<UnlockVault>(json!({ "id": 1, "password": PW }));
        refuses_a_path::<RecoverVault>(
            json!({ "id": 1, "recovery_key": "x", "new_password": NEW_PW }),
        );
        refuses_a_path::<RecoverConfirm>(json!({ "token": token, "accept": true }));
        refuses_a_path::<SessionArg>(json!({ "session": 1, "generation": 1 }));
        refuses_a_path::<ChangePassword>(
            json!({ "session": 1, "generation": 1, "new_password": NEW_PW }),
        );
    }
}
