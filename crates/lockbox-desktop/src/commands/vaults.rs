//! The vault list, and opening vaults: create, unlock, recover (spec §5.3, §6.10). Vaults are named by their row of
//! the list (`VaultRef`: the list's identity and the row's ID) or by session ID; their folders come only from the
//! registry and from Rust's own dialogs (spec §4.1).
//!
//! Each command is a thin wrapper that parses its request and runs a [`Shell`] method below on the blocking pool:
//! a key derivation takes about a second, and a dialog waits for the user.

use std::cell::Cell;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use lockbox_core::blob::CancelToken;
use lockbox_core::fsio::remove_dir_all_retry;
use lockbox_core::ids::VaultId;
use lockbox_core::kdf::check_new_password;
use lockbox_core::recovery::RecoverySecret;
use lockbox_core::{CleanupReport, CoreError, RecoveryCheck, UnlockReport, Vault, folder_name};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Request;
use zeroize::Zeroizing;

use super::backup::backup_refusal;
use super::{NoArgs, args, blocking};
use crate::error::{Confirm, Outcome, ShellError, ShellResult, VAULT_NOT_LISTED};
use crate::locations::{CloudProvider, LocationCheck};
use crate::os::same_path;
use crate::paths::default_vault_parent;
use crate::pending::{PendingChoice, RecoveryChoice, Token};
use crate::registry::{VaultEntry, VaultRef};
use crate::session::{
    Change, KeyState, Location, OpenAnswer, OpenStep, Opened, SessionId, SessionInfo, Tagged,
};
use crate::shell::Shell;
use crate::views::{Confirmation, NewKeyView, RecoveryCheckKind, RecoveryCheckView};

/// A new vault, open, with its recovery key: the one time the key crosses to the page (spec §4.1). No `Debug`.
#[derive(Serialize)]
pub struct CreatedView {
    pub info: SessionInfo,
    pub recovery_key: Zeroizing<String>,
    /// The creation key's number, as a key made later is numbered: the page sends it back to confirm this key
    /// (`recovery_confirmed`), and a confirmation of any other number is for an older key.
    pub issue: u64,
    /// The registry ID the vault list gave the new vault (`registry.add`, from 1): the page's `vaultId` for this
    /// session from the start, whatever a later read of the list brings.
    pub vault_id: u32,
}

/// An unlocked vault, with every warning the unlock raised (spec §6.3, §6.4). All false, and nothing cleaned, when
/// the vault was already unlocked: the warnings went with the first unlock.
#[derive(Debug, Serialize)]
pub struct UnlockView {
    pub info: SessionInfo,
    /// Opened from `vault.json.bak`, which may still need the previous password.
    pub used_backup_header: bool,
    /// The header was changed outside Petalock: `accept_header` once the user agrees.
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

/// The view of an unlock (`unlock_vault`, `recover_finish`).
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

/// What a create that a lock overtook made: the vault exists and is on the vault list, but is not open. Its registry ID
/// is not known where the create begins (0 here): the create's closure notes the ID the list gave it, and `created`
/// puts it in the answer, so no create ever answers `vault: 0`.
const VAULT_CREATED: Change = Change {
    what: "vault created",
    vault: 0,
};

/// Tests only: the step a change of password or a new recovery key reaches once the current password is checked.
#[cfg(test)]
const PASSWORD_CHECKED: &str = "shell.password.checked";

/// Tests only: the step reached right before the stop check that comes ahead of the header writes.
#[cfg(test)]
const BEFORE_HEADER_WRITES: &str = "shell.header.before_writes";

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

/// The stop check that comes right before a header write, after everything slow is done (the new password's key
/// derived, the mark written): `Cancelled` once a lock has cancelled the session's commands, so a lock that lands
/// before it changes nothing, and one that lands after it leaves a change that is whole. Reached through the engine's
/// `change_password_with` for a password, which is why it answers the engine's error type.
fn before_header_writes(cancel: &CancelToken) -> lockbox_core::Result<()> {
    #[cfg(test)]
    lockbox_core::internals::fsio::failpoint::check(BEFORE_HEADER_WRITES)?;
    match cancel.is_cancelled() {
        true => Err(lockbox_core::CoreError::Cancelled),
        false => Ok(()),
    }
}

/// A lock that came before the header writes answers `Locked` (nothing was written), never `Cancelled`.
fn stopped_by_a_lock(error: lockbox_core::CoreError) -> ShellError {
    match error {
        lockbox_core::CoreError::Cancelled => ShellError::Locked,
        other => other.into(),
    }
}

/// Tests only: the step a recovery reaches once the new password is set, just before it gives back the session.
#[cfg(test)]
const PASSWORD_SET: &str = "shell.recover.password_set";

/// Tests only: the step an unlock or a recovery reaches inside its open, before its location check.
#[cfg(test)]
const CHECKING: &str = "shell.open.checking";

/// Tests only: the step an unlock reaches once it has looked its row up, before its open is registered: where a Remove
/// that finishes in between is tested.
#[cfg(test)]
const LOOKED_UP: &str = "shell.unlock.looked_up";

/// Tests only: the step a Remove reaches once its location is held and the vault is locked, right before the list is
/// written.
#[cfg(test)]
const REMOVING: &str = "shell.remove.held";

/// Tests only: a named step a test can watch or make fail (the engine's failpoints, which are per thread: an opening
/// closure runs on the thread that called the command).
#[cfg(test)]
fn test_step(name: &'static str) -> ShellResult<()> {
    Ok(lockbox_core::internals::fsio::failpoint::check(name)?)
}

/// A recovery sets a new password on a closed vault only; an unlocked one changes it from its session.
const UNLOCKED: ShellError = ShellError::InvalidInput {
    what: "vault is unlocked",
};

/// `recover_finish` for a changed header, without the person's yes: refused with the choice kept, so the page asks.
const CHANGED_HEADER_NOT_ACCEPTED: ShellError = ShellError::InvalidInput {
    what: "header changed on disk",
};

/// The change a recovery makes, for a lock that overtakes it to report: a new password, for the vault the choice holds.
fn password_change(vault: u32) -> Change {
    Change {
        what: "password",
        vault,
    }
}

/// The new session an open gave back. An opening closure that cannot ask gives back nothing else.
fn opened<X>(answer: OpenAnswer<X>) -> ShellResult<Tagged<(SessionInfo, Option<X>)>> {
    match answer {
        Outcome::Done(tagged) => Ok(tagged),
        Outcome::Confirm(_) | Outcome::Dismissed => Err(ShellError::Cancelled),
    }
}

impl Shell {
    /// `recover_finish`'s answer: the session and what its recovery unlock found, once the closure that sets the new
    /// password ran. A session already unlocked there (the closure skipped, the password not set) is refused. A
    /// recovery that enters 21f is given 21f's permission, as an unlock is (`enter_21f`).
    fn recovered(&self, answer: OpenAnswer<Unlocked>) -> ShellResult<Tagged<UnlockView>> {
        let Tagged {
            session,
            generation,
            data: (info, unlocked),
        } = opened(answer)?;
        let Some(unlocked) = unlocked else {
            return Err(UNLOCKED);
        };
        self.enter_21f(session, generation, info.read_only);
        Ok(Tagged {
            session,
            generation,
            data: unlock_view(info, unlocked),
        })
    }

    /// 21f's permission for a session a writable unlock has just opened (with the password or the recovery key, so a
    /// credential was proved): to make a recovery key without being given the password, only when the vault folder's
    /// mark was read without error and is there. A file that cannot be read, a folder with no mark and a read-only
    /// session get none. Showing 21f is a separate, lenient question (`recovery_unconfirmed`): it costs one extra key
    /// where this costs the password check. A lock that came since the unlock leaves nothing to grant.
    fn enter_21f(&self, session: SessionId, generation: u64, read_only: bool) {
        if read_only {
            return;
        }
        let Some(Location::Folder(folder)) = self.sessions.location_of(session) else {
            return;
        };
        if self.vault_state.is_unconfirmed_strict(&folder) == Ok(true) {
            let _ = self.sessions.grant_key_permission(session, generation);
        }
    }

    /// The registry ID of the vault a session holds, for an answer the page keeps for that vault; 0 when the
    /// session's folder is not on the list.
    fn registry_id_of(&self, session: SessionId) -> u32 {
        let Some(location) = self.sessions.location_of(session) else {
            return 0;
        };
        self.registry
            .entries()
            .into_iter()
            .find(|(_, folder)| same_path(folder, location.path()))
            .map_or(0, |(id, _)| id)
    }
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
        if let (Some(provider), false) = (check.cloud, cloud_confirmed) {
            // Parked once the creation lock is released: parking drops expired choices, which may hold a vault.
            drop(creating);
            let token = self.sessions.pending().put(PendingChoice::AddVault { dir });
            return Ok(Outcome::Confirm(Confirm::CloudFolder { token, provider }));
        }
        let vault = self.registry.add(&dir)?;
        drop(creating);
        Ok(Outcome::Done(self.registry.entry(vault, &dir)))
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
        let made = Cell::new(0);
        let answer = self
            .sessions
            .open_since(epoch, None, Some(VAULT_CREATED), |cancel| {
                self.create_in(parent, name, password, false, &made, cancel)
            });
        self.created(&made, answer)
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
        let made = Cell::new(0);
        let answer = self.sessions.open_choice(
            token,
            Some(VAULT_CREATED),
            pick,
            |(parent, name, password), cancel| {
                self.create_in(parent, name, password, true, &made, cancel)
            },
        );
        self.created(&made, answer)
    }

    /// The opening closure of a create: checks `parent` (again, after a yes: it may have changed since), asks first
    /// about a cloud folder unless `cloud_confirmed`, then creates the vault there and adds it to the vault list. A
    /// lock of all vaults seen before the vault is made (its `cancel`, checked right before) answers `Locked`, with
    /// nothing made; one that lands after it leaves the vault on disk and on the vault list:
    /// `LockedAfterChange { what: "vault created" }`. If the list refuses the vault and it is removed again, a lock
    /// answers `Locked` (nothing is left); if the removal fails too, `"vault not listed"`, with or without a lock.
    /// `made` is set to the registry ID the list gave the vault, the moment it is listed: the open's answer cannot
    /// carry it when a lock discards the new session, so [`created`](Self::created) reads it from there.
    fn create_in(
        &self,
        parent: PathBuf,
        name: String,
        password: Zeroizing<String>,
        cloud_confirmed: bool,
        made: &Cell<u32>,
        cancel: &CancelToken,
    ) -> ShellResult<OpenStep<Zeroizing<String>>> {
        let check = self.check_location(&parent)?;
        // The folder as checked, from here on.
        let parent = check.path;
        if let (Some(provider), false) = (check.cloud, cloud_confirmed) {
            let choice = PendingChoice::CreateVault {
                parent,
                name,
                password,
            };
            return Ok(OpenStep::Ask(
                choice,
                Box::new(move |token| Confirm::CloudFolder { token, provider }),
            ));
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
            .and_then(|dir| {
                self.registry.add(&dir).map(|vault| {
                    made.set(vault.id);
                    dir
                })
            });
        drop(creating);
        let dir = match listed {
            Ok(dir) => dir,
            Err(e) => {
                // Not on the list (its write failed, or it would grow too large): removed again, so no vault is left
                // that Petalock cannot show and whose recovery key was never shown. The vault closes first, freeing its
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

impl Shell {
    /// What a create's open answers: the new session with its recovery key, the key's `issue` number and the vault's
    /// registry ID (`made`, set by `create_in`), or the question. The new session may make a recovery key without the
    /// password while 21c's step lasts (for its retries), until the creation key is confirmed. A lock that came
    /// between the vault's opening and this grant leaves the vault made and its key never shown:
    /// `LockedAfterChange`, as for a lock during the create. Either way it names the vault by the ID `made` holds,
    /// never the newest on the list: another window may have listed one since.
    fn created(
        &self,
        made: &Cell<u32>,
        answer: ShellResult<OpenAnswer<Zeroizing<String>>>,
    ) -> ShellResult<Outcome<Tagged<CreatedView>>> {
        let vault_id = made.get();
        let named = |e| match e {
            // `made` is 0 only while no vault was listed, and then no lock can have reported one made.
            ShellError::LockedAfterChange { what, vault: 0 } if vault_id != 0 => {
                ShellError::LockedAfterChange {
                    what,
                    vault: vault_id,
                }
            }
            other => other,
        };
        Ok(match answer.map_err(named)? {
            Outcome::Done(tagged) => {
                let (info, recovery_key) = tagged.data;
                // Never `None`: an open without a location always runs its closure.
                let recovery_key = recovery_key.ok_or(ShellError::Cancelled)?;
                let issue = self
                    .sessions
                    .start_creation_key(tagged.session, tagged.generation)
                    .map_err(|_| ShellError::LockedAfterChange {
                        what: VAULT_CREATED.what,
                        vault: vault_id,
                    })?;
                Outcome::Done(Tagged {
                    session: tagged.session,
                    generation: tagged.generation,
                    data: CreatedView {
                        info,
                        recovery_key,
                        issue,
                        vault_id,
                    },
                })
            }
            Outcome::Confirm(question) => Outcome::Confirm(question),
            Outcome::Dismissed => Outcome::Dismissed,
        })
    }
}

impl Shell {
    /// The registered folder of the row `vault` and its session location. `NotFound` for a row of another list or an
    /// ID not on the list. The folder is checked again (it may have moved drives since it was added) inside the open,
    /// where a lock of all vaults during the check is seen.
    fn registered(&self, vault: VaultRef) -> ShellResult<(PathBuf, Location)> {
        let dir = self.registry.path_of(vault).ok_or(ShellError::NotFound)?;
        let location = Location::folder(&dir)?;
        Ok((dir, location))
    }

    /// Unlocks the vault `vault` of the vault list with its password. The row is looked up again inside the open,
    /// once the open is registered: a Remove that finished since the first look leaves nothing to unlock (`NotFound`),
    /// and one that starts later finds the open under way (`Busy`). The lock epoch is read before the first look, so a
    /// lock of all vaults between the look and the open's registration answers `Locked`.
    pub fn unlock_vault(
        &self,
        vault: VaultRef,
        password: Zeroizing<String>,
    ) -> ShellResult<Tagged<UnlockView>> {
        let epoch = self.sessions.epoch();
        let (dir, location) = self.registered(vault)?;
        #[cfg(test)]
        test_step(LOOKED_UP)?;
        let again = location.clone();
        let answer = self
            .sessions
            .open_since(epoch, Some(location.clone()), None, |_| {
                let listed = self.registry.path_of(vault).ok_or(ShellError::NotFound)?;
                if Location::folder(&listed)? != location {
                    return Err(ShellError::NotFound);
                }
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
            Some(unlocked) => {
                // Only a closure that ran proved the password: an unlock answered for a vault already unlocked
                // checked nothing, so it grants nothing.
                self.enter_21f(session, generation, info.read_only);
                unlock_view(info, unlocked)
            }
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

    /// 28b's check of a forgotten password's way back (spec §5.3): whether the recovery key typed opens the recovery
    /// slot of the vault `vault`, without opening the vault. Not a job: the key's derivation is HKDF, no Argon2. The order:
    /// the vault is on the list (`NotFound`), it is not unlocked (`"vault is unlocked"`: its password is changed from
    /// the open vault), the key's form (a word that is no word of the list, the wrong number of words, a failed 8-bit
    /// check: no derivation is spent on a typo), the vault's folder as the location check finds it, then the engine's
    /// read-only check ([`Vault::check_recovery_key`]: no `.lock`, no cleanup, no repair, nothing written). A key that
    /// opens no slot (another vault's, or one replaced since) is `WrongPassword`: the cipher cannot tell them apart.
    ///
    /// On success the key waits in Rust as a recovery choice ([`PendingChoice::Recovery`]), bound to the vault's
    /// registered place and to both header files' bytes as read, with the launch's lock epoch: the answer carries the
    /// token (`choice`), the name in the header that opened, and `header_changed` when that header failed its MAC (the
    /// page asks before it goes on). A lock of all vaults while the check ran holds nothing (`Locked`). A refusal holds
    /// nothing. An earlier choice is never replaced: the page forgets its old one ([`recover_forget`]).
    ///
    /// [`recover_forget`]: Self::recover_forget
    pub fn recover_check(
        &self,
        vault: VaultRef,
        recovery_key: Zeroizing<String>,
    ) -> ShellResult<RecoveryCheckView> {
        let epoch = self.sessions.epoch();
        let (dir, location) = self.registered(vault)?;
        if self.sessions.find(&location).is_some() {
            return Err(UNLOCKED);
        }
        let secret = RecoverySecret::parse(&recovery_key)?;
        drop(recovery_key);
        #[cfg(test)]
        test_step(CHECKING)?;
        let check = self.check_location(&dir)?;
        same_place(&check, &location)?;
        let found = Vault::check_recovery_key(&check.path, &secret)?;
        let RecoveryCheck {
            header_mac_mismatch,
            name,
            main,
            backup,
        } = found;
        let kind = match header_mac_mismatch {
            true => RecoveryCheckKind::HeaderChanged,
            false => RecoveryCheckKind::Checked,
        };
        let choice = self.sessions.pending().put_at(
            PendingChoice::Recovery(RecoveryChoice {
                vault,
                location,
                epoch,
                secret,
                main,
                backup,
                header_changed: header_mac_mismatch,
            }),
            self.os.clock.now(),
        );
        // A lock of all vaults came while the check ran (or the app is closing): what was just held is no one's.
        if self.locked_since(epoch) {
            self.sessions.pending().forget_recovery(&choice);
            return Err(ShellError::Locked);
        }
        Ok(RecoveryCheckView {
            kind,
            choice,
            vault_name: name,
        })
    }

    /// 28d's finish: sets `new_password` on the vault whose recovery key `choice` holds, and opens it, as
    /// [`unlock_vault`](Self::unlock_vault) answers. The refusals, in order: a new password under 12 characters after NFC
    /// first, with no lookup and the choice kept; a choice that is not there (used, forgotten, dropped by a lock, five
    /// minutes old, never made, or another kind's, which is left alone) is `ChoiceExpired`; `accept_changed_header:
    /// false` on a choice whose header failed its MAC is refused with the choice kept (the yes comes first). Then the
    /// choice is taken, and under the opening guard (`Sessions::open_choice`, so a lock either comes first or sees the
    /// open under way and discards what it makes): a vault unlocked since is refused; the registry entry must still be
    /// the folder the check bound, both header files must be byte for byte as the check read them, and the key must
    /// still open, else the choice is gone: `ChoiceExpired`, the key is checked again, and a changed header gets a
    /// fresh decision. Then the vault is unlocked with the key, the changed header is accepted when asked, the new
    /// password is set, and only then is a usable session published. A lock before the password was written is
    /// `Locked`, one after it `LockedAfterChange { "password", vault }`, with the registry ID the choice holds.
    pub fn recover_finish(
        &self,
        choice: &Token,
        new_password: Zeroizing<String>,
        accept_changed_header: bool,
    ) -> ShellResult<Outcome<Tagged<UnlockView>>> {
        // Before anything is looked up, and with the choice kept.
        check_new_password(&new_password)?;
        let (vault, header_changed) = self
            .sessions
            .pending()
            .recovery_of(choice)
            .ok_or(ShellError::ChoiceExpired)?;
        if header_changed && !accept_changed_header {
            return Err(CHANGED_HEADER_NOT_ACCEPTED);
        }
        // Another kind's choice is handed back as it is, to be dropped with nothing else changed (the look above found
        // a recovery choice; one that has gone since is `NotFound`, answered as expired below).
        #[allow(clippy::result_large_err)]
        let pick = |held| match held {
            PendingChoice::Recovery(recovery) => Ok((Some(recovery.location.clone()), recovery)),
            other => Err(other),
        };
        let answer = self
            .sessions
            .open_choice(
                choice,
                Some(password_change(vault.id)),
                pick,
                |recovery, cancel| {
                    self.finish_in(recovery, new_password, accept_changed_header, cancel)
                },
            )
            .map_err(|refusal| match refusal {
                ShellError::NotFound => ShellError::ChoiceExpired,
                other => other,
            })?;
        self.recovered(answer).map(Outcome::Done)
    }

    /// The opening closure of [`recover_finish`](Self::recover_finish): everything the choice bound is checked again
    /// before a byte is written.
    fn finish_in(
        &self,
        recovery: RecoveryChoice,
        new_password: Zeroizing<String>,
        accept_changed_header: bool,
        cancel: &CancelToken,
    ) -> ShellResult<OpenStep<Unlocked>> {
        let RecoveryChoice {
            vault: row,
            location,
            epoch,
            secret,
            main,
            backup,
            header_changed,
        } = recovery;
        // A choice of another lock epoch is no one's (a lock of all vaults drops it, so this is a race's leftover).
        if epoch != self.sessions.epoch() {
            return Err(ShellError::ChoiceExpired);
        }
        // The registry entry is still the folder the check bound: the same row of the same list, so a Remove since the
        // check (or a new list) leaves the choice expired.
        let dir = self
            .registry
            .path_of(row)
            .ok_or(ShellError::ChoiceExpired)?;
        if Location::folder(&dir)? != location {
            return Err(ShellError::ChoiceExpired);
        }
        #[cfg(test)]
        test_step(CHECKING)?;
        let check = self.check_location(&dir)?;
        same_place(&check, &location)?;
        not_cancelled(cancel)?;
        // Both header files and the key, as they were checked: anything else is a new decision.
        let now = match Vault::check_recovery_key(&check.path, &secret) {
            Ok(now) => now,
            Err(
                CoreError::WrongPassword
                | CoreError::Damaged { .. }
                | CoreError::NotFound
                | CoreError::UnsupportedVersion,
            ) => return Err(ShellError::ChoiceExpired),
            Err(other) => return Err(other.into()),
        };
        if now.main != main || now.backup != backup || now.header_mac_mismatch != header_changed {
            return Err(ShellError::ChoiceExpired);
        }
        let (mut vault, mut report) = Vault::unlock_with_recovery(&check.path, &secret)?;
        // A header changed in the moments between the look above and the unlock is a new decision too.
        if report.header_mac_mismatch != header_changed {
            return Err(ShellError::ChoiceExpired);
        }
        not_cancelled(cancel)?;
        if header_changed && accept_changed_header {
            vault.accept_header()?;
        }
        // The stop check right before the header writes, after the new password's derivation, as a password change
        // has it: a lock during that second is `Locked`, with nothing written.
        if let Err(error) =
            vault.change_password_with(&new_password, || before_header_writes(cancel))
        {
            if let CoreError::Cancelled = error {
                return Err(ShellError::Locked);
            }
            // As a change from an open vault: the engine's `commit` reads `vault.json` back after a failed write and
            // makes the new header live when it landed. If it holds the new password, the change happened though
            // the write came back as an error: say so, never "nothing changed".
            return Err(match vault.check_password(&new_password) {
                Ok(()) => {
                    let change = password_change(row.id);
                    ShellError::LockedAfterChange {
                        what: change.what,
                        vault: change.vault,
                    }
                }
                Err(_) => error.into(),
            });
        }
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
    }

    /// Back, No to a changed header, or leaving: drops the recovery choice `choice`. A choice that is already gone (used,
    /// forgotten, dropped by a lock, expired), never made, or another kind's, is nothing to forget: success.
    pub fn recover_forget(&self, choice: &Token) -> ShellResult<()> {
        self.sessions.pending().forget_recovery(choice);
        Ok(())
    }

    /// Sets a new password, checking the current one in the same call. All inside one `write_change` closure, which
    /// holds the vault's write lock, so no other change comes between the check and the writes: the new password's
    /// length first (no Argon2 spent on a password that is refused), then the current password, then the new key's
    /// derivation, then the stop check right before the header writes (`before_header_writes`), then the writes. A
    /// wrong current password changes nothing. A lock that came before the writes answers `Locked`, with nothing
    /// written; one that came during them answers `LockedAfterChange { what: "password", vault }` and no word of
    /// anything else (the lease's generation check on the answer). A write that came back as an error after
    /// `vault.json` landed (the engine's `commit` read it back and made the new header live) is the same change: the
    /// vault is locked and the answer is `LockedAfterChange`; one that failed before it stays the plain error.
    pub fn change_password(
        &self,
        session: SessionId,
        generation: u64,
        current_password: Zeroizing<String>,
        new_password: Zeroizing<String>,
    ) -> ShellResult<Tagged<()>> {
        let change = Change {
            what: "password",
            vault: self.registry_id_of(session),
        };
        let answer = self
            .sessions
            .write_change(session, generation, change, |vault, cancel| {
                check_new_password(&new_password)?;
                vault.check_password(&current_password)?;
                #[cfg(test)]
                test_step(PASSWORD_CHECKED)?;
                match vault.change_password_with(&new_password, || before_header_writes(cancel)) {
                    Ok(()) => Ok(()),
                    // A lock before the writes: nothing was written.
                    Err(lockbox_core::CoreError::Cancelled) => Err(ShellError::Locked),
                    Err(error) => {
                        // The engine's `commit` reads `vault.json` back after a failed write and makes the new
                        // header live when it landed. If the live header now holds the new password, the change
                        // happened though the write came back as an error: say so (below), never "nothing changed".
                        if vault.check_password(&new_password).is_ok() {
                            Err(ShellError::LockedAfterChange {
                                what: change.what,
                                vault: change.vault,
                            })
                        } else {
                            Err(error.into())
                        }
                    }
                }
            });
        if let Err(ShellError::LockedAfterChange { .. }) = &answer {
            // The page is told what a lock that overtakes a change is told: this vault is locked (its lock event
            // goes out before this answer), so its Ask 16 says the new password is in effect and is then true. A
            // lock that already came leaves nothing to lock.
            if let Some(done) = self.sessions.revoke_some(
                &[(session, Some(generation))],
                crate::session::LockReason::Manual,
            ) {
                done.wait();
            }
        }
        answer
    }

    /// A new recovery key the person asks for from inside the vault, with the current password checked in the same
    /// call (the key it replaces may be one they still have): the password, then the "not confirmed" mark, then the
    /// stop check, then the key, all inside one closure holding the vault's write lock. A wrong password writes no
    /// mark and changes nothing. This does not give the session 21f's permission: the key it makes awaits its
    /// confirmation, and a direct `regenerate_recovery` stays refused.
    pub fn new_recovery_key(
        &self,
        session: SessionId,
        generation: u64,
        current_password: Zeroizing<String>,
    ) -> ShellResult<Tagged<NewKeyView>> {
        let change = Change {
            what: "recovery key",
            vault: self.registry_id_of(session),
        };
        self.sessions
            .write_keys(session, generation, Some(change), |vault, keys, cancel| {
                vault.check_password(&current_password)?;
                #[cfg(test)]
                test_step(PASSWORD_CHECKED)?;
                self.make_key(vault, keys, cancel)
            })
    }

    /// A new recovery key for a session in 21f (a key made and never confirmed, found at unlock or at creation): no
    /// password is asked, since the person is in the step that makes the key they never saw. Refused
    /// (`InvalidInput`) unless the session holds 21f's permission (see `enter_21f`, `KeyState`): any other session
    /// asks for the password through `new_recovery_key`. The permission stays for this step's retries and ends when
    /// the current key is confirmed. The mark is written first, as for any key: if it cannot be written, no key is
    /// made (`TooLarge { what: "vault state" }` or an I/O refusal), and a mark stays if the engine then fails (the old
    /// key may still work, and one more new key costs less than a key nobody saw).
    pub fn regenerate_recovery(
        &self,
        session: SessionId,
        generation: u64,
    ) -> ShellResult<Tagged<NewKeyView>> {
        let change = Change {
            what: "recovery key",
            vault: self.registry_id_of(session),
        };
        self.sessions
            .write_keys(session, generation, Some(change), |vault, keys, cancel| {
                if !keys.may_make_without_password() {
                    return Err(ShellError::InvalidInput {
                        what: "recovery key",
                    });
                }
                self.make_key(vault, keys, cancel)
            })
    }

    /// The part of making a key that follows its authorisation, inside the vault's write lock: the mark, the stop
    /// check, the key, and its `issue` number (given only to a key that was made).
    fn make_key(
        &self,
        vault: &mut Vault,
        keys: &mut KeyState,
        cancel: &CancelToken,
    ) -> ShellResult<NewKeyView> {
        // A lock that has come already leaves no mark behind (which would make the next unlock ask for a key).
        not_cancelled(cancel)?;
        self.vault_state.mark_unconfirmed(vault.dir())?;
        before_header_writes(cancel).map_err(stopped_by_a_lock)?;
        let words = vault.regenerate_recovery()?.to_display();
        Ok(NewKeyView {
            words,
            issue: keys.next_issue(),
        })
    }

    /// The person typed part of a recovery key back: `issue` names the key. When it is the latest one this session
    /// made, the "not confirmed" mark of the session's vault is cleared (a mark that is not there is a success) and
    /// 21f's permission ends: `Confirmed`. A key made since (the person asked for another before confirming this
    /// one) leaves both as they are: `Superseded`. Under the vault's write lock, so it never interleaves with a key
    /// being made. Refused, as any change is, on a stale generation, a session that is not there, and a read-only copy.
    pub fn recovery_confirmed(
        &self,
        session: SessionId,
        generation: u64,
        issue: u64,
    ) -> ShellResult<Tagged<Confirmation>> {
        self.sessions
            .write_keys(session, generation, None, |vault, keys, _| {
                if !keys.is_latest(issue) {
                    return Ok(Confirmation::Superseded);
                }
                self.vault_state.clear_unconfirmed(vault.dir())?;
                keys.revoke();
                Ok(Confirmation::Confirmed)
            })
    }

    /// Accepts a header changed outside Petalock (after `header_mac_mismatch`), once the user agreed.
    pub fn accept_header(&self, session: SessionId, generation: u64) -> ShellResult<Tagged<()>> {
        self.sessions
            .write(session, generation, |vault, _| Ok(vault.accept_header()?))
    }

    /// Gives the vault a new name (18d), signed again and written to both header files; the folder keeps its name. It
    /// asks for no password. Refused as a backup is (`details changed`, `details unchecked`, `password copies disagree`
    /// or `recovery key copies disagree`, from the engine's words), and for a name the engine will not keep (nothing but
    /// spaces, or over 200 characters). A lock that came first changes nothing (`Locked`); one that came during the
    /// writes answers `LockedAfterChange { what: "vault name", vault }`. A write that came back as an error after
    /// `vault.json` landed (the engine's `commit` read it back and made the new name live) is a success: the name is in
    /// effect and not secret, and the next writable unlock repairs `.bak`. Whenever the name is in effect, the session
    /// is listed under it, and the vault list keeps it as the vault's last-known name (best effort).
    pub fn rename_vault(
        &self,
        session: SessionId,
        generation: u64,
        name: String,
    ) -> ShellResult<Tagged<()>> {
        let change = Change {
            what: "vault name",
            vault: self.registry_id_of(session),
        };
        let answer = self
            .sessions
            .write_change(session, generation, change, |vault, cancel| {
                // A lock that came first changes nothing.
                before_header_writes(cancel).map_err(stopped_by_a_lock)?;
                let before = vault.name().to_owned();
                match vault.rename(&name) {
                    Ok(()) => Ok(()),
                    // The write came back as an error after `vault.json` landed: the new name is live.
                    Err(_) if before != name && vault.name() == name => Ok(()),
                    Err(error) => Err(backup_refusal(vault, error.into())),
                }
            });
        if matches!(answer, Ok(_) | Err(ShellError::LockedAfterChange { .. })) {
            self.sessions.set_name(session, &name);
            // The vault list keeps the name for a row whose folder goes away. Only a vault on the list has an ID (a
            // backup or an older copy has none and leaves the list alone); a failed write changes no answer, and
            // logs nothing (R5): the next list brings the name up to date from the header.
            // The row is named by its ID and the session's folder together, so a list that was started over in
            // between, and gave that ID to another vault, is left alone.
            let listed = self.registry_id_of(session);
            if let (true, Some(location)) = (listed != 0, self.sessions.location_of(session)) {
                let _ = self.registry.remember_name(listed, location.path(), &name);
            }
        }
        answer
    }
}

impl Shell {
    /// Takes the vault `vault` off the vault list (18g's Remove), leaving its folder and the shell's notes about it
    /// as they are. The location's guard ([`AutoLock::remove_location`](crate::autolock::AutoLock::remove_location))
    /// refuses (`Busy`) while an unlock of it is under way, another Remove is, or a job of it runs; an open vault is
    /// locked first (the person's own lock, its event goes out before this answers), and only then is the list
    /// written, with the location still held, so an unlock that arrives meanwhile is `Busy` and one that comes after
    /// finds no row (`NotFound`). A list that cannot be written leaves the vault locked and listed, and says so.
    /// `NotFound` for a row of another list, an ID not on the list, or a damaged list.
    pub fn forget_vault(&self, vault: VaultRef) -> ShellResult<()> {
        let dir = self.registry.path_of(vault).ok_or(ShellError::NotFound)?;
        // Canonical when it can be (as an unlock's location is); a folder that is gone is compared as listed.
        let location = Location::folder(&dir).unwrap_or(Location::Folder(dir));
        self.autolock.remove_location(&location, || {
            #[cfg(test)]
            test_step(REMOVING)?;
            self.registry.forget(vault)
        })
    }

    /// Shows the folder of the row `vault` in Explorer (a vault's menu, its unlock step), and only a folder: the
    /// listed path is checked to be a directory and not a link or junction (`InvalidInput { "folder" }`), and then
    /// handed to the launcher, which starts Explorer by its full path with the folder as its one argument and never
    /// runs it as a program. No session and no lock are involved: it works for an open, locked or unreadable vault.
    /// `NotFound` for a row of another list, an ID not on the list, a damaged list, or a folder that is not there.
    pub fn show_vault_in_explorer(&self, vault: VaultRef) -> ShellResult<()> {
        let dir = self.registry.path_of(vault).ok_or(ShellError::NotFound)?;
        self.open_only_a_folder(&dir)
    }

    /// Hands `dir` to the launcher only if it is a directory and not a link or junction (`InvalidInput { "folder" }`;
    /// `NotFound` if it is not there): every Show in Explorer goes through here.
    pub(crate) fn open_only_a_folder(&self, dir: &Path) -> ShellResult<()> {
        let meta = match fs::symlink_metadata(dir) {
            Ok(meta) => meta,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(ShellError::NotFound),
            Err(e) => return Err(e.into()),
        };
        // A file (`...\run.exe`), or a link or junction (`is_symlink` is true for both on Windows: name surrogates).
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(ShellError::InvalidInput { what: "folder" });
        }
        self.os.launcher.open_folder(dir)?;
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VaultArg {
    vault: VaultRef,
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
    vault: VaultRef,
    password: Zeroizing<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecoverCheck {
    vault: VaultRef,
    recovery_key: Zeroizing<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecoverFinish {
    choice: Token,
    new_password: Zeroizing<String>,
    accept_changed_header: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecoverForget {
    choice: Token,
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
    current_password: Zeroizing<String>,
    new_password: Zeroizing<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NewRecoveryKey {
    session: SessionId,
    generation: u64,
    current_password: Zeroizing<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecoveryConfirmed {
    session: SessionId,
    generation: u64,
    issue: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RenameVault {
    session: SessionId,
    generation: u64,
    name: String,
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
    let VaultArg { vault } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.forget_vault(vault)).await
}

/// Shows a vault's folder in Explorer. The page names the row (`{ list, id }`), never a path.
#[tauri::command]
pub(super) async fn show_vault_in_explorer(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<()> {
    let VaultArg { vault } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.show_vault_in_explorer(vault)).await
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
    let UnlockVault { vault, password } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.unlock_vault(vault, password)).await
}

#[tauri::command]
pub(super) async fn recover_check(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<RecoveryCheckView> {
    let RecoverCheck {
        vault,
        recovery_key,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.recover_check(vault, recovery_key)).await
}

#[tauri::command]
pub(super) async fn recover_finish(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Outcome<Tagged<UnlockView>>> {
    let RecoverFinish {
        choice,
        new_password,
        accept_changed_header,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.recover_finish(&choice, new_password, accept_changed_header)).await
}

#[tauri::command]
pub(super) async fn recover_forget(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<()> {
    let RecoverForget { choice } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.recover_forget(&choice)).await
}

#[tauri::command]
pub(super) async fn change_password(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<()>> {
    let ChangePassword {
        session,
        generation,
        current_password,
        new_password,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.change_password(session, generation, current_password, new_password))
        .await
}

#[tauri::command]
pub(super) async fn new_recovery_key(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<NewKeyView>> {
    let NewRecoveryKey {
        session,
        generation,
        current_password,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.new_recovery_key(session, generation, current_password)).await
}

#[tauri::command]
pub(super) async fn regenerate_recovery(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<NewKeyView>> {
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
) -> ShellResult<Tagged<Confirmation>> {
    let RecoveryConfirmed {
        session,
        generation,
        issue,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.recovery_confirmed(session, generation, issue)).await
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

#[tauri::command]
pub(super) async fn rename_vault(
    shell: State<'_, Arc<Shell>>,
    request: Request<'_>,
) -> ShellResult<Tagged<()>> {
    let RenameVault {
        session,
        generation,
        name,
    } = args(&request)?;
    let shell = Arc::clone(&shell);
    blocking(move || shell.rename_vault(session, generation, name)).await
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
    use std::time::{Duration, Instant, SystemTime};

    use lockbox_core::blob::NoProgress;
    use lockbox_core::internals::fsio::failpoint;
    use lockbox_core::internals::fsio::testutil::make_dir_link;
    use lockbox_core::internals::header::{
        HEADER_BACKUP, HEADER_FILE, parse_header, serialize_header,
    };
    use lockbox_core::internals::lockfile::VaultLock;
    use lockbox_core::{CoreError, Credential, ReadOnlyVault, read_vault_name};
    use serde_json::{Value, json};
    use tauri::ipc::InvokeBody;
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

    use super::super::{MALFORMED, parse};
    use super::*;
    use crate::jobs::JobKind;
    use crate::os::{DriveType, KnownFolder};
    use crate::paths::MAX_STATE_FILE;
    use crate::registry::MAX_VAULTS;
    use crate::session::{LockReason, SessionKind, SessionState};
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
        registered_as(ts, "Family")
    }

    /// [`registered`] for a vault named `name`.
    fn registered_as(ts: &TestShell, name: &str) -> (u32, PathBuf, Zeroizing<String>) {
        let created = heavy(|| Vault::create(&ts.vaults(), name, PW)).unwrap();
        let dir = fs::canonicalize(created.vault.dir()).unwrap();
        let recovery = created.recovery.to_display();
        drop(created);
        (ts.shell.registry.add(&dir).unwrap().id, dir, recovery)
    }

    /// Whether nothing holds the vault in `dir`: its `.lock` is free.
    fn is_free(dir: &Path) -> bool {
        VaultLock::acquire(dir).is_ok()
    }

    /// Changes the vault's header outside Petalock (its name, which the header MAC covers), in both copies.
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

    /// 28b's check: `key` for the vault `id`. A refused key holds nothing.
    fn check(ts: &TestShell, id: u32, key: &str) -> ShellResult<RecoveryCheckView> {
        ts.shell.recover_check(ts.vault(id), secret(key))
    }

    /// 28d's finish, on the pool's rules for a test (an Argon2 run is under way).
    fn finish(
        ts: &TestShell,
        choice: &Token,
        new_password: &str,
        accept: bool,
    ) -> ShellResult<Outcome<Tagged<UnlockView>>> {
        heavy(|| {
            ts.shell
                .recover_finish(choice, secret(new_password), accept)
        })
    }

    /// The whole recovery as the page does it: the check, then the finish (accepting a changed header).
    fn recover(
        ts: &TestShell,
        id: u32,
        key: &str,
        new_password: &str,
    ) -> ShellResult<Tagged<UnlockView>> {
        let checked = check(ts, id, key)?;
        Ok(done(finish(ts, &checked.choice, new_password, true)?))
    }

    /// The token under which a choice is held, as the page would send it back.
    fn token_of(text: &str) -> Token {
        serde_json::from_value(json!(text)).unwrap()
    }

    /// Whether a recovery choice is held under `choice` now.
    fn is_held(ts: &TestShell, choice: &Token) -> bool {
        ts.shell.sessions.pending().recovery_of(choice).is_some()
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
        let parent = ts.env.folder(KnownFolder::Profile).join("Petalock Vaults");
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

    /// Plan 4C Task 13b: the cloud question names the provider the check found, so 18c can say "OneDrive syncs this
    /// folder"; the page reads it in this JSON shape (`ui/src/api.create.test.ts`), a fixed name and never a path.
    #[test]
    fn cloud_question_names_the_provider_in_its_json() {
        for (name, provider, said) in [
            ("OneDrive - Personal", CloudProvider::OneDrive, "OneDrive"),
            ("Google Drive", CloudProvider::GoogleDrive, "GoogleDrive"),
            ("Dropbox", CloudProvider::Dropbox, "Dropbox"),
            ("Nextcloud", CloudProvider::Other, "Other"),
        ] {
            let ts = TestShell::new();
            let synced = ts.vaults();
            ts.volumes.add_sync_root_named(&synced, name);
            ts.dialogs.answer(Some(synced.clone()));
            let asked = ts.shell.create_vault("Family".into(), secret(PW), true);
            let Ok(Outcome::Confirm(Confirm::CloudFolder {
                provider: found, ..
            })) = &asked
            else {
                panic!("a cloud folder asks first");
            };
            assert_eq!(*found, provider, "{name}");
            let json = serde_json::to_value(asked.unwrap()).unwrap();
            assert_eq!(
                json["Confirm"]["CloudFolder"]["provider"],
                json!(said),
                "{name}"
            );
            assert!(json["Confirm"]["CloudFolder"]["token"].is_string());
            // The question holds the token and the provider's name, nothing else: no path can reach the page in it.
            let mut keys: Vec<&String> = json["Confirm"]["CloudFolder"]
                .as_object()
                .expect("the question is an object")
                .keys()
                .collect();
            keys.sort();
            assert_eq!(keys, ["provider", "token"], "{name}");
            assert_eq!(json.as_object().map(|top| top.len()), Some(1));

            // Adding an existing vault folder asks the same way.
            let added = TestShell::new();
            let created = heavy(|| Vault::create(&added.vaults(), "Family", PW)).unwrap();
            let dir = created.vault.dir().to_path_buf();
            drop(created);
            added.volumes.add_sync_root_named(&added.vaults(), name);
            added.dialogs.answer(Some(dir));
            let Ok(Outcome::Confirm(Confirm::CloudFolder {
                provider: found, ..
            })) = added.shell.add_existing_vault()
            else {
                panic!("a cloud folder asks first");
            };
            assert_eq!(found, provider, "{name}");
        }
    }

    #[test]
    fn cloud_folder_needs_confirmation() {
        let ts = TestShell::new();
        let synced = ts.vaults();
        ts.volumes.add_sync_root(&synced);
        ts.dialogs.answer(Some(synced.clone()));
        let answer = ts.shell.create_vault("Family".into(), secret(PW), true);
        let Ok(Outcome::Confirm(Confirm::CloudFolder { token, .. })) = answer else {
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
        let token = ts
            .shell
            .recover_check(ts.vault(id), recovery)
            .unwrap()
            .choice;
        assert!(matches!(
            ts.shell.create_vault_confirm(&token),
            Err(ShellError::NotFound)
        ));
        assert!(!is_held(&ts, &token), "the choice that waited is dropped");
        assert_eq!(
            finish(&ts, &token, NEW_PW, true).err(),
            Some(ShellError::ChoiceExpired)
        );
        assert!(password_works(&dir, PW), "nothing changed");
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
        let entries = ts.shell.registry.entries();
        assert_eq!(entries.len(), 1, "the new vault is on the list");
        assert_ne!(entries[0].0, 0, "a registry ID is never 0");
        assert_eq!(
            answer.err(),
            Some(ShellError::LockedAfterChange {
                what: "vault created",
                vault: entries[0].0
            }),
            "the answer names the vault the list gave"
        );
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
        let checked = ts.shell.recover_check(ts.vault(id), recovery).unwrap();
        assert_eq!(checked.kind, RecoveryCheckKind::HeaderChanged);
        let token = checked.choice;
        let locker = lock_once_taken(&ts);
        let answer = finish(&ts, &token, NEW_PW, true);
        join(&locker);
        match answer.err() {
            Some(ShellError::Locked) => assert_eq!(headers(&dir), before, "nothing changed"),
            Some(ShellError::LockedAfterChange {
                what: "password",
                vault,
            }) => {
                assert_eq!(vault, id, "the vault the change was made to");
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
            let Ok(Outcome::Confirm(Confirm::CloudFolder { token, .. })) = answer else {
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
                vault,
            }) => {
                assert_eq!(entries.len(), 2, "the new vault is on the list");
                assert_eq!(vault, entries[1].0, "the vault the create made");
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
        let entries = ts.shell.registry.entries();
        assert_eq!(entries.len(), listed + 1);
        assert_eq!(
            answer.err(),
            Some(ShellError::LockedAfterChange {
                what: "vault created",
                vault: entries[listed].0
            }),
            "the vault this confirm made, the newest on the list here"
        );
        assert!(ts.shell.sessions.list().is_empty());
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
        let default = ts.env.folder(KnownFolder::Profile).join("Petalock Vaults");
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
        let default = ts.env.folder(KnownFolder::Profile).join("Petalock Vaults");
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
        let default = ts.env.folder(KnownFolder::Profile).join("Petalock Vaults");
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

    /// A vault folder made by the engine in the test's vaults folder, closed and not on the list: its canonical folder.
    fn unlisted_vault(ts: &TestShell, name: &str) -> PathBuf {
        let made = heavy(|| Vault::create(&ts.vaults(), name, PW)).unwrap();
        let dir = fs::canonicalize(made.vault.dir()).unwrap();
        drop(made);
        dir
    }

    /// Task 7: the create's answer carries the ID the vault list gave the new vault (on both ways to create), so the
    /// page knows its vault without reading the list again.
    #[test]
    fn create_answers_the_registry_id_it_registered() {
        let ts = TestShell::new();
        // Two vaults listed first, so the new vault's ID is not simply 1.
        registered_as(&ts, "One");
        registered_as(&ts, "Two");
        let tagged =
            done(heavy(|| ts.shell.create_vault("Family".into(), secret(PW), false)).unwrap());
        // The ID the list holds for the session's own folder, found by path, not taken from the answer.
        let listed = ts.shell.registry_id_of(tagged.session);
        assert_eq!(listed, 3, "the next ID on the list");
        assert_eq!(tagged.data.vault_id, listed);
        let json = serde_json::to_value(&tagged).unwrap();
        assert_eq!(json["data"]["vault_id"], 3);

        // After a yes to the cloud question, the same.
        let synced = ts.temp.path().join("synced");
        fs::create_dir(&synced).unwrap();
        ts.volumes.add_sync_root(&synced);
        ts.dialogs.answer(Some(synced));
        let Ok(Outcome::Confirm(Confirm::CloudFolder { token, .. })) =
            ts.shell.create_vault("Work".into(), secret(PW), true)
        else {
            panic!("a cloud folder asks first");
        };
        let confirmed = done(heavy(|| ts.shell.create_vault_confirm(&token)).unwrap());
        assert_eq!(
            confirmed.data.vault_id,
            ts.shell.registry_id_of(confirmed.session)
        );
        assert_eq!(confirmed.data.vault_id, 4);
        assert_ne!(confirmed.data.vault_id, tagged.data.vault_id);
    }

    /// Task 7: making a vault while another is open leaves the other open, with its own generation.
    #[test]
    fn creating_a_vault_while_another_is_open_leaves_it_open() {
        let ts = TestShell::new();
        let (first, generation) = ts.open_vault("First");
        let first_id = ts.shell.registry_id_of(first);
        let second =
            done(heavy(|| ts.shell.create_vault("Second".into(), secret(PW), false)).unwrap());
        assert_ne!(second.session, first);
        assert_ne!(second.data.vault_id, first_id);
        assert_eq!(state(&ts, first), Some(SessionState::Unlocked));
        assert_eq!(state(&ts, second.session), Some(SessionState::Unlocked));
        let still = ts
            .shell
            .sessions
            .list()
            .into_iter()
            .find(|info| info.session == first)
            .unwrap();
        assert_eq!(still.generation, generation, "the same unlock");
        ts.shell
            .sessions
            .read(first, generation, |_, _| Ok(()))
            .expect("the first vault still answers with its generation");
        assert_eq!(ts.shell.registry.entries().len(), 2);
    }

    /// Task 7: a create and an add at once (as in two windows) each get their own ID, and the create's answer names
    /// its own vault, not the newest on the list.
    #[test]
    fn a_create_and_an_add_at_once_each_get_their_own_id() {
        let ts = TestShell::new();
        let work = unlisted_vault(&ts, "Work");
        ts.dialogs.answer(Some(work.clone()));
        // The add reaches the creation lock while the create holds it, and takes the next place after the create.
        let add = second_at_staging(&ts, |shell| shell.add_existing_vault());
        let (created, added) = heavy(|| {
            let created = ts.shell.create_vault("Family".into(), secret(PW), false);
            (created, joined(&add))
        });
        failpoint::disarm_all();
        let created = done(created.unwrap());
        let added = done(added.unwrap());
        assert_ne!(created.data.vault_id, added.id);
        assert_eq!(
            created.data.vault_id,
            ts.shell.registry_id_of(created.session),
            "the create's own ID"
        );
        assert_eq!(ts.shell.registry.path(added.id), Some(work));
        assert_eq!(added.id, created.data.vault_id + 1, "the add came after");
        assert_eq!(ts.shell.registry.entries().len(), 2);
    }

    /// Task 7: a create a lock overtook after the vault was made and listed answers the ID it was listed under: when
    /// the lock lands in the open (the epoch's path), and when it lands after the open, before the answer is built
    /// (the good answer delayed). In both, an add listed the next ID in between, so the newest on the list is wrong.
    #[test]
    fn a_create_overtaken_by_a_lock_answers_its_vault_id() {
        // The lock lands while the create runs; the add (after the lock) takes the next place.
        let ts = TestShell::new();
        let work = unlisted_vault(&ts, "Work");
        ts.dialogs.answer(Some(work.clone()));
        let add = second_at_staging(&ts, |shell| {
            shell.sessions.lock_all(LockReason::WindowsLocked);
            shell.add_existing_vault()
        });
        let (answer, added) = heavy(|| {
            let answer = ts.shell.create_vault("Family".into(), secret(PW), false);
            (answer, joined(&add))
        });
        failpoint::disarm_all();
        let added = done(added.unwrap());
        let entries = ts.shell.registry.entries();
        assert_eq!(entries.len(), 2);
        let (made, _) = entries.iter().find(|(_, dir)| *dir != work).unwrap();
        assert_ne!(*made, 0);
        assert_ne!(*made, added.id, "not the add's, the newest on the list");
        assert_eq!(
            answer.err(),
            Some(ShellError::LockedAfterChange {
                what: "vault created",
                vault: *made
            })
        );
        assert!(ts.shell.sessions.list().is_empty(), "not open");

        // The open went well and a lock came before the answer was built: the same ID.
        let ts = TestShell::new();
        let work = unlisted_vault(&ts, "Work");
        ts.dialogs.answer(Some(work.clone()));
        let add = second_at_staging(&ts, |shell| shell.add_existing_vault());
        let made = Cell::new(0);
        let epoch = ts.shell.sessions.epoch();
        let (opened, added) = heavy(|| {
            let opened = ts
                .shell
                .sessions
                .open_since(epoch, None, Some(VAULT_CREATED), |cancel| {
                    ts.shell.create_in(
                        ts.vaults(),
                        "Family".into(),
                        secret(PW),
                        false,
                        &made,
                        cancel,
                    )
                })
                .unwrap();
            (opened, joined(&add))
        });
        failpoint::disarm_all();
        let added = done(added.unwrap());
        assert!(matches!(opened, Outcome::Done(_)), "a good answer");
        ts.shell.sessions.lock_all(LockReason::WindowsLocked);
        let answer = ts.shell.created(&made, Ok(opened));
        let entries = ts.shell.registry.entries();
        let (listed, _) = entries.iter().find(|(_, dir)| *dir != work).unwrap();
        assert_ne!(*listed, added.id, "not the add's, the newest on the list");
        assert_eq!(
            answer.err(),
            Some(ShellError::LockedAfterChange {
                what: "vault created",
                vault: *listed
            })
        );
        assert!(
            ts.shell
                .sessions
                .list()
                .iter()
                .all(|info| info.state != SessionState::Unlocked),
            "the new session is locked with the rest"
        );
    }

    /// Task 7, the design's "Vault made but not listed": the list refused the vault and it could not be removed
    /// again. The answer says so, as the first run has always said it: the vault stays on disk, off the list, with
    /// its "not confirmed" mark, and nothing is open.
    #[test]
    fn a_vault_written_but_not_registered_answers_so() {
        let ts = TestShell::new();
        let default = ts.env.folder(KnownFolder::Profile).join("Petalock Vaults");
        let held: Rc<RefCell<Option<fs::File>>> = Rc::default();
        let hold = Rc::clone(&held);
        let parent = default.clone();
        // Once the vault is published: the list's write fails, and the vault's header is held open without delete
        // sharing, so the removal fails too.
        failpoint::observe(
            "create.before_rename",
            Box::new(move || {
                failpoint::arm("atomic_write.before_replace");
                let (hold, parent) = (Rc::clone(&hold), parent.clone());
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
                    }),
                );
            }),
        );
        let answer = heavy(|| ts.shell.create_vault("Family".into(), secret(PW), false));
        failpoint::disarm_all();
        assert!(held.borrow().is_some(), "the header was held");
        let refused = answer.err().expect("refused");
        assert_eq!(
            serde_json::to_value(refused).unwrap(),
            json!({ "code": "invalid_input", "what": "vault not listed" })
        );
        let left = vault_folders(&default);
        assert_eq!(left.len(), 1, "still on disk");
        let left = fs::canonicalize(&left[0]).unwrap();
        assert!(ts.shell.vault_state.is_unconfirmed(&left), "the mark stays");
        assert!(ts.shell.sessions.list().is_empty());
        assert!(ts.shell.registry.entries().is_empty(), "not listed");
        drop(held.borrow_mut().take());
    }

    /// Task 7: a full list refuses a create before anything is written, with the list's own refusal, on both ways to
    /// create (the cloud question comes first, and the refusal after the yes).
    #[test]
    fn create_refused_when_the_list_is_full_says_so() {
        let ts = TestShell::new();
        let base = fs::canonicalize(ts.temp.path()).unwrap();
        let listed: Vec<_> = (1..=MAX_VAULTS as u32)
            .map(|id| json!({ "id": id, "path": base.join(format!("v{id}")) }))
            .collect();
        fs::create_dir_all(&ts.shell.paths.root).unwrap();
        fs::write(
            &ts.shell.paths.registry,
            json!({ "version": 1, "vaults": listed }).to_string(),
        )
        .unwrap();
        let full = json!({ "code": "too_large", "what": "vault list" });
        let default = ts.env.folder(KnownFolder::Profile).join("Petalock Vaults");

        let answer = heavy(|| ts.shell.create_vault("Family".into(), secret(PW), false));
        assert_eq!(
            serde_json::to_value(answer.err().expect("refused")).unwrap(),
            full
        );
        assert!(!default.exists(), "nothing written, not even the folder");

        let synced = ts.temp.path().join("synced");
        fs::create_dir(&synced).unwrap();
        ts.volumes.add_sync_root(&synced);
        ts.dialogs.answer(Some(synced.clone()));
        let Ok(Outcome::Confirm(Confirm::CloudFolder { token, .. })) =
            ts.shell.create_vault("Work".into(), secret(PW), true)
        else {
            panic!("a cloud folder asks first");
        };
        let answer = heavy(|| ts.shell.create_vault_confirm(&token));
        assert_eq!(
            serde_json::to_value(answer.err().expect("refused")).unwrap(),
            full
        );
        assert_eq!(fs::read_dir(&synced).unwrap().count(), 0, "nothing written");
        assert!(ts.shell.sessions.list().is_empty());
        assert_eq!(ts.shell.registry.entries().len(), MAX_VAULTS);
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
        let link_id = ts.shell.registry.add(&via_link).unwrap().id;
        move_during_check(&listed_link, &other_vault);
        let view = heavy(|| ts.shell.unlock_vault(ts.vault(link_id), secret(PW))).unwrap();
        assert_eq!(view.data.info.name, "Family");
        ts.shell.sessions.lock_all(LockReason::Manual);

        // Recover: the check and the finish each look at the folder their own check found.
        retarget(&listed_link, &made[0]);
        move_during_check(&listed_link, &other_vault);
        let checked = check(&ts, link_id, &created.data.recovery_key).unwrap();
        assert_eq!(checked.vault_name, "Family");
        retarget(&listed_link, &made[0]);
        move_during_check(&listed_link, &other_vault);
        let recovered = done(finish(&ts, &checked.choice, NEW_PW, true).unwrap());
        assert_eq!(recovered.data.info.name, "Family");
    }

    /// Fix round 3 (H2): a listed folder that leads elsewhere by the time it is checked (a junction moved after the
    /// session's place was read) is refused, so a session never holds one vault under another's place. The other
    /// vault's own password and recovery key are used: without the refusal they would open it.
    #[test]
    fn session_is_named_by_the_checked_folder() {
        let ts = TestShell::new();
        let (_, family, family_key) = registered(&ts);
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
            .unwrap()
            .id;
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
        let answer = heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(NEW_PW)));
        failpoint::disarm_all();
        assert_eq!(answer.err(), refused);

        // The recovery check: the other vault's own key would open it, but the check looked at the folder it was
        // given, so nothing is held.
        move_once_open();
        let answer = check(&ts, id, &work_key);
        failpoint::disarm_all();
        assert_eq!(answer.err(), refused);
        assert_eq!(ts.shell.sessions.pending().len(), 0, "no choice held");

        // The finish: a vault checked at its own folder, then the junction moved before the finish's check.
        retarget(&link, &family);
        let checked = check(&ts, id, &family_key).unwrap();
        move_once_open();
        let answer = finish(&ts, &checked.choice, PW, true);
        failpoint::disarm_all();
        assert_eq!(answer.err(), refused);
        assert!(!is_held(&ts, &checked.choice), "the choice is gone");

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
            ts.shell.unlock_vault(ts.vault(id + 1), secret(PW)).err(),
            Some(ShellError::NotFound)
        );
        assert_eq!(
            heavy(|| ts
                .shell
                .unlock_vault(ts.vault(id), secret("not the password")))
            .err(),
            Some(wrong_password())
        );
        assert!(ts.shell.sessions.list().is_empty());
        let tagged = heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(PW))).unwrap();
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
        assert_eq!(
            ts.shell.unlock_vault(ts.vault(id), secret(PW)).err(),
            refused
        );
        assert_eq!(check(&ts, id, &recovery).err(), refused);
        assert!(ts.shell.sessions.list().is_empty());
        assert_eq!(ts.shell.sessions.pending().len(), 0, "no choice held");
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
            heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(PW))).err(),
            Some(ShellError::Locked)
        );
        assert!(ts.shell.sessions.list().is_empty());
        assert!(is_free(&dir));

        // Fix round 2 (G6): the open checks its cancel before the step it cannot undo, so a lock seen during the
        // check changes nothing: no new password, no accepted header, no new vault.
        // The recovery check: a lock seen during its location check keeps nothing.
        lock_now();
        assert_eq!(check(&ts, id, &recovery).err(), Some(ShellError::Locked));
        assert_eq!(ts.shell.sessions.pending().len(), 0, "no choice held");

        // The finish: the same lock changes nothing, and the choice is gone with it.
        let checked = check(&ts, id, &recovery).unwrap();
        lock_now();
        assert_eq!(
            finish(&ts, &checked.choice, NEW_PW, true).err(),
            Some(ShellError::Locked)
        );
        assert!(ts.shell.sessions.list().is_empty());
        assert!(is_free(&dir));
        assert!(password_works(&dir, PW), "the password is unchanged");

        change_header(&dir);
        let before = headers(&dir);
        let checked = check(&ts, id, &recovery).unwrap();
        assert_eq!(checked.kind, RecoveryCheckKind::HeaderChanged);
        lock_now();
        assert_eq!(
            finish(&ts, &checked.choice, NEW_PW, true).err(),
            Some(ShellError::Locked)
        );
        assert_eq!(headers(&dir), before, "nothing accepted");
        assert!(is_free(&dir));

        lock_now();
        assert_eq!(
            heavy(|| ts.shell.create_vault("Work".into(), secret(PW), false)).err(),
            Some(ShellError::Locked)
        );
        let default = ts.env.folder(KnownFolder::Profile).join("Petalock Vaults");
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
        ts.dialogs.answer(Some(local.join("Petalock.")));
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
    fn recover_finish_rechecks_location() {
        let ts = TestShell::new();
        let (id, dir, recovery) = registered(&ts);
        change_header(&dir);
        let before = headers(&dir);
        let checked = check(&ts, id, &recovery).unwrap();
        ts.volumes.mount(
            &ts.vaults(),
            FakeVolume {
                drive: DriveType::Removable,
                ..LOCAL_NTFS
            },
        );
        assert_eq!(
            finish(&ts, &checked.choice, NEW_PW, true).err(),
            Some(ShellError::InvalidInput {
                what: "removable drive"
            })
        );
        assert!(ts.shell.sessions.list().is_empty());
        assert!(is_free(&dir));
        assert_eq!(headers(&dir), before, "nothing accepted");
        assert!(!is_held(&ts, &checked.choice), "the choice is gone");
    }

    #[test]
    fn unlock_report_flags_reach_the_view() {
        let ts = TestShell::new();
        let (id, dir, _) = registered(&ts);

        // Fix round 1 (F13): `vault.json` damaged and its repair fails (the engine's failpoint on the repair write):
        // opened from `.bak`, and the failed repair reported.
        fs::write(dir.join(HEADER_FILE), b"damaged").unwrap();
        failpoint::arm("unlock.repair_write");
        let view = heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(PW)));
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
        let view = heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(PW)))
            .unwrap()
            .data;
        assert!(view.used_backup_header && !view.header_mac_mismatch && !view.header_repair_failed);
        assert_eq!(view.cleanup.partials_removed, 1);
        assert_eq!(view.cleanup.orphans_quarantined, 1);
        assert!(dir.join("files").join("orphaned").join(&orphan).exists());

        // Unlocking it again while it is unlocked: the same session, no warnings, nothing cleaned.
        let again = ts.shell.unlock_vault(ts.vault(id), secret(PW)).unwrap();
        assert_eq!(again.session, view.info.session);
        assert!(!again.data.used_backup_header && !again.data.header_mac_mismatch);
        assert_eq!(again.data.cleanup, CleanupView::default());

        // The header changed outside Petalock: reported, and accepted through the session.
        ts.shell.sessions.lock_all(LockReason::Manual);
        change_header(&dir);
        let tagged = heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(PW))).unwrap();
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
        let view = heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(PW)))
            .unwrap()
            .data;
        assert!(!view.header_mac_mismatch);
    }

    #[test]
    fn recover_finish_sets_the_password_before_the_session_is_usable() {
        let ts = TestShell::new();
        let (id, dir, recovery) = registered(&ts);

        // Fix round 1 (F13): the new password cannot be written: no session ever opens, the vault is closed again,
        // and the old password still works. The choice was used up: the key is checked again.
        let checked = check(&ts, id, &recovery).unwrap();
        failpoint::arm("write_headers.before_first");
        let answer = finish(&ts, &checked.choice, NEW_PW, true);
        failpoint::disarm_all();
        assert!(matches!(answer, Err(ShellError::Core(_))));
        assert!(ts.shell.sessions.list().is_empty(), "no session");
        assert!(is_free(&dir));
        assert!(password_works(&dir, PW));
        assert_eq!(
            finish(&ts, &checked.choice, NEW_PW, true).err(),
            Some(ShellError::ChoiceExpired)
        );

        let tagged = recover(&ts, id, &recovery, NEW_PW).unwrap();
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

    /// A new password under 12 is refused first, before the choice is looked up (a made-up token gets the same
    /// answer) and before a changed header is accepted, and the choice is kept: the person types another one.
    #[test]
    fn recover_finish_refuses_a_short_password_and_keeps_the_choice() {
        let ts = TestShell::new();
        let (id, dir, recovery) = registered(&ts);
        let short: ShellError = CoreError::PasswordTooShort { min: 12 }.into();
        let checked = check(&ts, id, &recovery).unwrap();
        for password in ["short", ""] {
            assert_eq!(
                finish(&ts, &checked.choice, password, true).err(),
                Some(short)
            );
            assert!(is_held(&ts, &checked.choice), "kept: {password:?}");
        }
        assert_eq!(
            finish(&ts, &token_of(FAKE_TOKEN), "short", true).err(),
            Some(short),
            "refused before any lookup"
        );
        assert!(ts.shell.sessions.list().is_empty());
        assert!(is_free(&dir));
        assert!(password_works(&dir, PW));

        // Fix round 1 (F11): refused before anything else, so a changed header is not accepted first: both header
        // files stay as they were.
        change_header(&dir);
        let before = headers(&dir);
        let changed = check(&ts, id, &recovery).unwrap();
        assert_eq!(changed.kind, RecoveryCheckKind::HeaderChanged);
        assert_eq!(
            finish(&ts, &changed.choice, "short", true).err(),
            Some(short)
        );
        assert_eq!(headers(&dir), before);
        assert!(is_held(&ts, &changed.choice));
        assert!(ts.shell.sessions.list().is_empty());
        assert!(is_free(&dir));

        // The kept choice still finishes, with a password that is long enough.
        let tagged = done(finish(&ts, &changed.choice, NEW_PW, true).unwrap());
        assert_eq!(tagged.data.info.name, "Renamed");
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

    /// The changed header is asked about first (the check's `header_changed`), and the answer is `accept_changed_header`:
    /// a finish without it is refused with the choice kept, a lock before the answer drops the choice, and a yes accepts
    /// the header, sets the new password and opens the session.
    #[test]
    fn recover_finish_after_a_changed_header_yes_accepts_then_sets() {
        let ts = TestShell::new();
        let (id, dir, recovery) = registered(&ts);
        change_header(&dir);
        let before = headers(&dir);
        let ask = || {
            let checked = check(&ts, id, &recovery).expect("a changed header still opens the key");
            assert_eq!(checked.kind, RecoveryCheckKind::HeaderChanged);
            assert_eq!(
                checked.vault_name, "Renamed",
                "the name in the header that opened"
            );
            assert!(ts.shell.sessions.list().is_empty(), "no session yet");
            assert!(
                is_free(&dir),
                "no vault is held open while the question waits"
            );
            assert_eq!(headers(&dir), before, "the check wrote nothing");
            checked.choice
        };

        // No yes, only the finish: refused, the choice kept, nothing changed.
        let token = ask();
        let no_yes = ShellError::InvalidInput {
            what: "header changed on disk",
        };
        assert_eq!(finish(&ts, &token, NEW_PW, false).err(), Some(no_yes));
        assert!(is_held(&ts, &token));
        assert_eq!(headers(&dir), before);
        assert!(is_free(&dir));

        // Every vault locks before the yes: the choice is gone.
        ts.shell.sessions.lock_all(LockReason::WindowsLocked);
        assert!(!is_held(&ts, &token));
        assert_eq!(
            finish(&ts, &token, NEW_PW, true).err(),
            Some(ShellError::ChoiceExpired)
        );
        assert_eq!(headers(&dir), before);

        // Yes: the header is accepted and the new password set, then the session opens.
        let token = ask();
        let tagged = done(finish(&ts, &token, NEW_PW, true).unwrap());
        assert_eq!(tagged.data.info.name, "Renamed");
        assert!(!tagged.data.header_mac_mismatch, "accepted by the yes");
        assert_eq!(state(&ts, tagged.session), Some(SessionState::Unlocked));
        assert!(!is_held(&ts, &token), "used up");
        ts.shell.sessions.lock_all(LockReason::Manual);
        let (_, report) = heavy(|| Vault::unlock_with_password(&dir, NEW_PW)).unwrap();
        assert!(!report.header_mac_mismatch);
        assert!(!password_works(&dir, PW), "the old password is refused");
    }

    /// "No" to the changed header is `recover_forget`: the key is dropped and nothing was ever written. Forgetting is
    /// idempotent, and only a recovery choice answers to it.
    #[test]
    fn recover_forget_after_no_changes_nothing() {
        let ts = TestShell::new();
        let (id, dir, recovery) = registered(&ts);
        change_header(&dir);
        let before = headers(&dir);
        let checked = check(&ts, id, &recovery).unwrap();
        let token = checked.choice;
        assert!(is_held(&ts, &token));
        let other = ts.shell.sessions.pending().put(PendingChoice::Test(None));
        // Another kind's token and one never made are nothing to forget, and the choice stays.
        ts.shell.recover_forget(&other).unwrap();
        ts.shell.recover_forget(&token_of(FAKE_TOKEN)).unwrap();
        assert!(is_held(&ts, &token));
        assert!(
            ts.shell.sessions.pending().take(&other).is_ok(),
            "the other kind's choice is left alone"
        );

        ts.shell.recover_forget(&token).unwrap();
        assert!(!is_held(&ts, &token));
        assert_eq!(ts.shell.sessions.pending().len(), 0);
        assert_eq!(headers(&dir), before, "nothing changed on disk");
        assert!(is_free(&dir));
        assert!(ts.shell.sessions.list().is_empty());
        assert_eq!(
            finish(&ts, &token, NEW_PW, true).err(),
            Some(ShellError::ChoiceExpired)
        );
        // A choice already gone is a success, as is a second forget.
        ts.shell.recover_forget(&token).unwrap();
        assert!(password_works(&dir, PW));
    }

    /// Fix round 1 (F13): a lock that lands after the finish set the new password and accepted the header, before the
    /// session opens: the change is reported (`LockedAfterChange`) with the vault it was made to, and nothing stays open.
    #[test]
    fn a_lock_after_finish_landed_answers_locked_after_change_with_the_vault() {
        let ts = TestShell::new();
        let (other_id, ..) = registered_as(&ts, "Other");
        let (id, dir, recovery) = registered(&ts);
        assert_ne!(id, other_id);
        change_header(&dir);
        let checked = check(&ts, id, &recovery).unwrap();
        let shell = Arc::clone(&ts.shell);
        failpoint::observe(
            PASSWORD_SET,
            Box::new(move || shell.sessions.lock_all(LockReason::WindowsLocked)),
        );
        let answer = finish(&ts, &checked.choice, NEW_PW, true);
        failpoint::disarm_all();
        let error = answer.err().expect("overtaken by the lock");
        assert_eq!(
            error,
            ShellError::LockedAfterChange {
                what: "password",
                vault: id
            }
        );
        assert_eq!(
            serde_json::to_string(&error).unwrap(),
            format!(r#"{{"code":"locked_after_change","what":"password","vault":{id}}}"#)
        );
        assert!(ts.shell.sessions.list().is_empty());
        assert!(is_free(&dir));
        assert!(password_works(&dir, NEW_PW), "the change went through");
        let (_, report) = heavy(|| Vault::unlock_with_password(&dir, NEW_PW)).unwrap();
        assert!(!report.header_mac_mismatch, "and the header was accepted");
    }

    /// A lock before the new password was written answers `Locked` (nothing was written), not a change that landed.
    #[test]
    fn a_lock_before_finish_wrote_anything_answers_locked() {
        let ts = TestShell::new();
        let (id, dir, recovery) = registered(&ts);
        let before = headers(&dir);
        let checked = check(&ts, id, &recovery).unwrap();
        let shell = Arc::clone(&ts.shell);
        failpoint::observe(
            CHECKING,
            Box::new(move || shell.sessions.lock_all(LockReason::WindowsLocked)),
        );
        let answer = finish(&ts, &checked.choice, NEW_PW, true);
        failpoint::disarm_all();
        assert_eq!(answer.err(), Some(ShellError::Locked));
        assert_eq!(headers(&dir), before);
        assert!(ts.shell.sessions.list().is_empty());
        assert!(password_works(&dir, PW));
    }

    /// A lock during the new password's derivation (after the last check before it, before the header writes) is seen
    /// at the stop check right before the writes, as in a password change: `Locked`, with nothing written.
    #[test]
    fn a_lock_during_finish_derivation_writes_nothing() {
        let ts = TestShell::new();
        let (id, dir, recovery) = registered(&ts);
        let before = headers(&dir);
        let checked = check(&ts, id, &recovery).unwrap();
        let shell = Arc::clone(&ts.shell);
        failpoint::observe(
            BEFORE_HEADER_WRITES,
            Box::new(move || shell.sessions.lock_all(LockReason::WindowsLocked)),
        );
        let answer = finish(&ts, &checked.choice, NEW_PW, true);
        failpoint::disarm_all();
        assert_eq!(answer.err(), Some(ShellError::Locked));
        assert_eq!(headers(&dir), before, "no header was written");
        assert!(ts.shell.sessions.list().is_empty());
        assert!(is_free(&dir));
        assert!(password_works(&dir, PW));
    }

    /// The check and the finish are refused for a vault that is not on the list and for one that is unlocked, the
    /// unlocked one before the key is even read; an unlocked vault found by the finish is refused and its choice gone.
    #[test]
    fn recover_check_and_finish_refused_for_an_unknown_or_unlocked_vault() {
        let ts = TestShell::new();
        let (id, dir, recovery) = registered(&ts);
        // An ID the list never had.
        assert_eq!(
            check(&ts, id + 1, &recovery).err(),
            Some(ShellError::NotFound)
        );
        assert_eq!(check(&ts, 0, &recovery).err(), Some(ShellError::NotFound));
        // A vault the list forgot since the check: the choice answers `ChoiceExpired`.
        let held = check(&ts, id, &recovery).unwrap();
        ts.shell.registry.forget(ts.vault(id)).unwrap();
        assert_eq!(
            finish(&ts, &held.choice, NEW_PW, true).err(),
            Some(ShellError::ChoiceExpired)
        );
        assert!(!is_held(&ts, &held.choice));
        assert!(password_works(&dir, PW));
        // The check refuses the removed entry too, and holds nothing.
        assert_eq!(check(&ts, id, &recovery).err(), Some(ShellError::NotFound));
        assert_eq!(ts.shell.sessions.pending().len(), 0);
        let id = ts.shell.registry.add(&dir).unwrap().id;

        // Unlocked: refused before the key is read (not a typo error for this one), and nothing is held.
        let session = heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(PW))).unwrap();
        let unlocked = ShellError::InvalidInput {
            what: "vault is unlocked",
        };
        assert_eq!(check(&ts, id, "not a recovery key").err(), Some(unlocked));
        assert_eq!(check(&ts, id, &recovery).err(), Some(unlocked));
        assert_eq!(ts.shell.sessions.pending().len(), 0);
        ts.shell.sessions.lock_all(LockReason::Manual);

        // Checked while locked, unlocked since: the finish refuses, drops the choice, and changes nothing.
        let checked = check(&ts, id, &recovery).unwrap();
        let reopened = heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(PW))).unwrap();
        assert_ne!(reopened.generation, session.generation);
        let before = headers(&dir);
        assert_eq!(
            finish(&ts, &checked.choice, NEW_PW, true).err(),
            Some(unlocked)
        );
        assert!(!is_held(&ts, &checked.choice), "gone");
        assert_eq!(headers(&dir), before);
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert!(password_works(&dir, PW));
    }

    // ---- Forgot password, in two steps (Plan 4C, Task 4) ----

    /// `key` with its first word swapped for another listed word, so it fails the 8-bit check.
    fn with_a_typo(key: &str) -> String {
        let words: Vec<&str> = key.split(' ').collect();
        for other in ["abandon", "ability", "able", "about", "above"] {
            let mut changed = words.clone();
            changed[0] = other;
            let text = changed.join(" ");
            if matches!(
                RecoverySecret::parse(&text),
                Err(CoreError::RecoveryKeyTypo)
            ) {
                return text;
            }
        }
        panic!("no swapped word failed the check");
    }

    /// The answer's JSON, for a refusal.
    fn said(error: Option<ShellError>) -> Value {
        serde_json::to_value(error.expect("refused")).unwrap()
    }

    /// 28b's refusals, each its own fixed kind with its number, and nothing held after any of them. The cipher cannot
    /// tell another vault's key from an old key: both are `wrong_password`, which the page words as "doesn't open".
    #[test]
    fn recover_check_says_which_refusal() {
        let ts = TestShell::new();
        let (id, dir, recovery) = registered(&ts);
        let (_, _, others_key) = registered_as(&ts, "Work");
        let before = headers(&dir);

        // A word swapped for another listed word: the 8-bit check fails.
        assert_eq!(
            said(check(&ts, id, &with_a_typo(&recovery)).err()),
            json!({ "code": "core", "kind": "recovery_key_typo" })
        );
        // Word 7 is not in the list.
        let mut words: Vec<&str> = recovery.split(' ').collect();
        words[6] = "zzzz";
        assert_eq!(
            said(check(&ts, id, &words.join(" ")).err()),
            json!({ "code": "core", "kind": "recovery_key_word", "position": 7 })
        );
        // Not 24 words: one short, and one too many.
        let short = recovery.split(' ').take(23).collect::<Vec<_>>().join(" ");
        assert_eq!(
            said(check(&ts, id, &short).err()),
            json!({ "code": "core", "kind": "recovery_key_count", "found": 23 })
        );
        let long = format!("{} {}", recovery.as_str(), "abandon");
        assert_eq!(
            said(check(&ts, id, &long).err()),
            json!({ "code": "core", "kind": "recovery_key_count", "found": 25 })
        );
        // Another vault's key.
        assert_eq!(
            said(check(&ts, id, &others_key).err()),
            json!({ "code": "core", "kind": "wrong_password" })
        );
        // An old key: the vault has a new one since.
        let (mut vault, _) = heavy(|| Vault::unlock_with_password(&dir, PW)).unwrap();
        let fresh = vault.regenerate_recovery().unwrap().to_display();
        drop(vault);
        let before_fresh = headers(&dir);
        assert_eq!(
            said(check(&ts, id, &recovery).err()),
            json!({ "code": "core", "kind": "wrong_password" })
        );
        assert_eq!(
            ts.shell.sessions.pending().len(),
            0,
            "no refusal holds a choice"
        );
        assert_ne!(before, before_fresh, "the new key was written");
        assert_eq!(headers(&dir), before_fresh, "no check wrote anything");

        // The current key opens, and is held.
        let checked = check(&ts, id, &fresh).unwrap();
        assert_eq!(checked.kind, RecoveryCheckKind::Checked);
        assert_eq!(checked.vault_name, "Family");
        assert!(is_held(&ts, &checked.choice));
        assert_eq!(headers(&dir), before_fresh);
    }

    /// A key typed wrongly never reaches the derivation: no typo, unlisted word or wrong count opens a header, and no
    /// unknown or unlocked vault does either. The engine's check is reached once, by the key that is well formed.
    #[test]
    fn recover_check_spends_no_derivation_on_a_typo() {
        let ts = TestShell::new();
        let (id, dir, recovery) = registered(&ts);
        let reached = Rc::new(Cell::new(0));
        let count = Rc::clone(&reached);
        failpoint::observe(
            "recovery_check.start",
            Box::new(move || count.set(count.get() + 1)),
        );
        let mut unlisted: Vec<&str> = recovery.split(' ').collect();
        unlisted[6] = "zzzz";
        let short = recovery.split(' ').take(23).collect::<Vec<_>>().join(" ");
        for key in [
            with_a_typo(&recovery),
            unlisted.join(" "),
            short,
            String::new(),
            "not a recovery key".to_owned(),
        ] {
            assert!(check(&ts, id, &key).is_err());
        }
        assert!(check(&ts, id + 1, &recovery).is_err(), "an unknown vault");
        assert_eq!(reached.get(), 0, "nothing was derived");

        // A well formed key that opens nothing does reach it (the hook is live), and a good key too.
        let (_, _, others_key) = registered_as(&ts, "Work");
        assert!(check(&ts, id, &others_key).is_err());
        assert_eq!(reached.get(), 1);
        assert!(check(&ts, id, &recovery).is_ok());
        assert_eq!(reached.get(), 2);
        failpoint::disarm_all();

        // An unlocked vault is refused before that too.
        heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(PW))).unwrap();
        let reached = Rc::new(Cell::new(0));
        let count = Rc::clone(&reached);
        failpoint::observe(
            "recovery_check.start",
            Box::new(move || count.set(count.get() + 1)),
        );
        assert!(check(&ts, id, &recovery).is_err());
        failpoint::disarm_all();
        assert_eq!(reached.get(), 0);
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert!(password_works(&dir, PW));
    }

    /// The checked key waits in Rust, not on the page. It is dropped by Back (`recover_forget`), by every lock of all
    /// vaults (an idle one, Windows locking and sleeping too), by its five minutes and by the app closing, and used up
    /// by the finish: but not by a finish that was refused for a short password, or for lacking the yes.
    #[test]
    fn recover_check_holds_the_key_until_finish_and_drops_it_on_back_lock_all_expiry_and_close() {
        let ts = TestShell::new();
        let (id, dir, recovery) = registered(&ts);
        let pending = ts.shell.sessions.pending();
        let held = || check(&ts, id, &recovery).unwrap().choice;

        // Held: a refused finish (short, or no yes to a changed header) keeps it.
        let token = held();
        assert!(is_held(&ts, &token));
        assert_eq!(pending.len(), 1);
        assert!(finish(&ts, &token, "short", true).is_err());
        assert!(is_held(&ts, &token));
        // Back.
        ts.shell.recover_forget(&token).unwrap();
        assert!(!is_held(&ts, &token));
        assert_eq!(pending.len(), 0);

        // Every lock of all vaults, whatever its reason: the key is gone, and the finish says to check again.
        for reason in [
            LockReason::Manual,
            LockReason::Idle,
            LockReason::WindowsLocked,
            LockReason::Sleep,
        ] {
            let token = held();
            ts.shell.sessions.lock_all(reason);
            assert!(!is_held(&ts, &token), "{reason:?}");
            assert_eq!(pending.len(), 0, "{reason:?}");
            assert_eq!(
                finish(&ts, &token, NEW_PW, true).err(),
                Some(ShellError::ChoiceExpired),
                "{reason:?}"
            );
        }

        // Five minutes: the sweep drops it, and so does the lookup.
        let token = held();
        pending.sweep_at(Instant::now() + Duration::from_secs(10 * 60));
        assert!(!is_held(&ts, &token));
        assert_eq!(
            finish(&ts, &token, NEW_PW, true).err(),
            Some(ShellError::ChoiceExpired)
        );
        assert_eq!(pending.len(), 0);

        // Used up by a finish that opens the vault (the yes is ignored on a key that needs none).
        let token = held();
        let tagged = done(finish(&ts, &token, NEW_PW, false).unwrap());
        assert_eq!(tagged.data.info.name, "Family");
        assert!(!is_held(&ts, &token));
        assert_eq!(pending.len(), 0);
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert!(password_works(&dir, NEW_PW));

        // The app closing.
        let token = held();
        if let Some(done) = ts.shell.sessions.close() {
            done.wait();
        }
        assert!(!is_held(&ts, &token));
        assert_eq!(pending.len(), 0);
    }

    /// A check that a lock overtakes holds nothing: the lock is seen at the end, where the choice would be parked.
    #[test]
    fn a_lock_during_the_check_holds_nothing() {
        let ts = TestShell::new();
        let (id, dir, recovery) = registered(&ts);
        let shell = Arc::clone(&ts.shell);
        failpoint::observe(
            "recovery_check.start",
            Box::new(move || shell.sessions.lock_all(LockReason::WindowsLocked)),
        );
        assert_eq!(check(&ts, id, &recovery).err(), Some(ShellError::Locked));
        failpoint::disarm_all();
        assert_eq!(ts.shell.sessions.pending().len(), 0);
        assert!(password_works(&dir, PW));
    }

    /// Two vaults of the same name, a made-up token, and another kind's token: the finish answers `ChoiceExpired` for
    /// each and leaves another kind's choice where it was.
    #[test]
    fn recover_finish_answers_only_to_its_own_choice() {
        let ts = TestShell::new();
        let (id, dir, recovery) = registered(&ts);
        let (other_id, other_dir, other_key) = registered_as(&ts, "Family");
        assert_ne!(id, other_id);
        let mine = check(&ts, id, &recovery).unwrap().choice;
        let theirs = check(&ts, other_id, &other_key).unwrap().choice;
        let foreign = ts.shell.sessions.pending().put(PendingChoice::Test(None));
        for token in [token_of(FAKE_TOKEN), foreign.clone()] {
            assert_eq!(
                finish(&ts, &token, NEW_PW, true).err(),
                Some(ShellError::ChoiceExpired)
            );
        }
        assert!(
            ts.shell.sessions.pending().take(&foreign).is_ok(),
            "another kind's choice is left alone"
        );
        assert!(is_held(&ts, &mine) && is_held(&ts, &theirs));

        // Each choice sets its own vault's password, and the other vault is untouched.
        let (before_other, before_mine) = (headers(&other_dir), headers(&dir));
        let tagged = done(finish(&ts, &mine, NEW_PW, true).unwrap());
        assert_eq!(tagged.data.info.name, "Family");
        assert_eq!(headers(&other_dir), before_other);
        assert_ne!(headers(&dir), before_mine);
        assert!(is_held(&ts, &theirs), "a finish takes only its own choice");
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert!(password_works(&dir, NEW_PW));
        assert!(password_works(&other_dir, PW));
    }

    /// A header file replaced between the check and the finish (changed, one file only, or one gone) is never written
    /// over: the finish says `ChoiceExpired`, nothing changes on disk, and the key is checked again, so a header that
    /// changed gets a fresh decision. With nothing replaced the same finish succeeds.
    #[test]
    fn a_header_replaced_between_check_and_finish_needs_the_key_again() {
        let ts = TestShell::new();
        let (id, dir, recovery) = registered(&ts);
        let original = headers(&dir);

        // The header changed outside Petalock after a clean check: the person has not been asked about it.
        let checked = check(&ts, id, &recovery).unwrap();
        assert_eq!(checked.kind, RecoveryCheckKind::Checked);
        change_header(&dir);
        let changed = headers(&dir);
        assert_ne!(changed, original);
        assert_eq!(
            finish(&ts, &checked.choice, NEW_PW, true).err(),
            Some(ShellError::ChoiceExpired)
        );
        assert_eq!(headers(&dir), changed, "nothing accepted, nothing set");
        assert!(!is_held(&ts, &checked.choice), "the choice is gone");
        assert!(ts.shell.sessions.list().is_empty());
        assert!(is_free(&dir));

        // Checked again, it is a changed header, asked about, and the yes goes through.
        let again = check(&ts, id, &recovery).unwrap();
        assert_eq!(again.kind, RecoveryCheckKind::HeaderChanged);

        // The spare alone replaced (a different name under the same vault).
        let mut header = parse_header(&changed.0).unwrap();
        header.name = "Spare".to_owned();
        fs::write(dir.join(HEADER_BACKUP), serialize_header(&header)).unwrap();
        let spare_changed = headers(&dir);
        assert_eq!(
            finish(&ts, &again.choice, NEW_PW, true).err(),
            Some(ShellError::ChoiceExpired)
        );
        assert_eq!(headers(&dir), spare_changed);

        // The spare gone.
        let again = check(&ts, id, &recovery).unwrap();
        fs::remove_file(dir.join(HEADER_BACKUP)).unwrap();
        assert_eq!(
            finish(&ts, &again.choice, NEW_PW, true).err(),
            Some(ShellError::ChoiceExpired)
        );
        assert!(
            !dir.join(HEADER_BACKUP).exists(),
            "not repaired by a refused finish"
        );

        // The header changed back to what the check saw: the same bytes are as bound.
        fs::write(dir.join(HEADER_BACKUP), &changed.1).unwrap();
        let again = check(&ts, id, &recovery).unwrap();
        assert_eq!(again.kind, RecoveryCheckKind::HeaderChanged);
        let tagged = done(finish(&ts, &again.choice, NEW_PW, true).unwrap());
        assert_eq!(tagged.data.info.name, "Renamed");
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert!(
            password_works(&dir, NEW_PW),
            "with nothing replaced it goes through"
        );
        assert!(!password_works(&dir, PW));
    }

    /// Copies a folder, leaving out the `.lock` a live vault holds.
    fn copy_folder(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for entry in fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_folder(&entry.path(), &target);
            } else if entry.file_name() != ".lock" {
                fs::copy(entry.path(), target).unwrap();
            }
        }
    }

    /// Opens `dir` read-only with `credential`: whether it opened. A read-only open writes nothing.
    fn opens_read_only(dir: &Path, credential: Credential) -> bool {
        ReadOnlyVault::open_folder(dir, credential, &CancelToken::new(), &NoProgress).is_ok()
    }

    /// What [`interrupted_finish`] leaves: the folder, its registry ID, the recovery key and the two header files.
    type Interrupted = (PathBuf, u32, Zeroizing<String>, (Vec<u8>, Vec<u8>));

    /// A finish that died after `vault.json` and before `.bak` (the engine's partial-write hook): the change landed,
    /// so the answer is `LockedAfterChange` with the vault, never "nothing changed". Returns the folder, its registry
    /// ID, the recovery key and the two header files as the interruption left them, which differ.
    fn interrupted_finish(ts: &TestShell) -> Interrupted {
        let (id, dir, recovery) = registered(ts);
        let before = headers(&dir);
        let checked = check(ts, id, &recovery).unwrap();
        failpoint::arm("write_headers.before_second");
        let answer = finish(ts, &checked.choice, NEW_PW, true);
        failpoint::disarm_all();
        assert_eq!(
            answer.err(),
            Some(ShellError::LockedAfterChange {
                what: "password",
                vault: id
            })
        );
        assert!(ts.shell.sessions.list().is_empty(), "no session");
        assert!(is_free(&dir));
        let left = headers(&dir);
        assert_ne!(left.0, before.0, "vault.json holds the new password");
        assert_eq!(left.1, before.1, ".bak is one version behind");
        (dir, id, recovery, left)
    }

    /// That interrupted folder opened with the new password on its own copy: `vault.json` opens (no Ask 9), a read-only
    /// open writes nothing, a writable unlock repairs the spare, and the old password is then refused.
    #[test]
    fn recover_finish_interrupted_opens_with_the_new_password_on_its_own_copy() {
        let ts = TestShell::new();
        let (dir, _, _, (main, bak)) = interrupted_finish(&ts);
        let copy = ts.vaults().join("interrupted-new");
        copy_folder(&dir, &copy);
        let copy = fs::canonicalize(&copy).unwrap();
        let id = ts.shell.registry.add(&copy).unwrap().id;

        assert!(opens_read_only(&copy, Credential::Password(NEW_PW)));
        assert_eq!(
            headers(&copy),
            (main.clone(), bak),
            "a read-only open writes nothing"
        );
        let view = heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(NEW_PW)))
            .unwrap()
            .data;
        assert!(!view.used_backup_header && !view.header_repair_failed);
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert_eq!(
            headers(&copy),
            (main.clone(), main),
            "the spare is repaired"
        );
        assert!(
            !password_works(&copy, PW),
            "once the pair agrees, the old password is refused"
        );
        assert!(password_works(&copy, NEW_PW));
    }

    /// The same folder opened with the old password on its own copy: it opens through the spare (Ask 9), and the new
    /// password is refused until the change is made again.
    #[test]
    fn recover_finish_interrupted_opens_with_the_old_password_through_the_spare_on_its_own_copy() {
        let ts = TestShell::new();
        let (dir, _, _, (main, bak)) = interrupted_finish(&ts);
        let copy = ts.vaults().join("interrupted-old");
        copy_folder(&dir, &copy);
        let copy = fs::canonicalize(&copy).unwrap();
        let id = ts.shell.registry.add(&copy).unwrap().id;

        assert!(opens_read_only(&copy, Credential::Password(PW)));
        assert_eq!(headers(&copy), (main, bak.clone()));
        let view = heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(PW)))
            .unwrap()
            .data;
        assert!(view.used_backup_header, "Ask 9: the spare opened");
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert_eq!(
            headers(&copy),
            (bak.clone(), bak),
            "vault.json repaired from the spare"
        );
        assert!(!password_works(&copy, NEW_PW));
        assert!(password_works(&copy, PW));
    }

    /// The same folder opened with the recovery key on its own copy: the key's slot is the same in both files, so the
    /// check opens `vault.json` and writes nothing; the finish that follows completes the change in both files, and
    /// only the password it set opens the vault afterwards.
    #[test]
    fn recover_finish_interrupted_opens_with_the_key_on_its_own_copy() {
        let ts = TestShell::new();
        let (dir, _, recovery, (main, bak)) = interrupted_finish(&ts);
        let copy = ts.vaults().join("interrupted-key");
        copy_folder(&dir, &copy);
        let copy = fs::canonicalize(&copy).unwrap();
        let id = ts.shell.registry.add(&copy).unwrap().id;

        assert!(opens_read_only(
            &copy,
            Credential::Recovery(&RecoverySecret::parse(&recovery).unwrap())
        ));
        let checked = check(&ts, id, &recovery).unwrap();
        assert_eq!(checked.kind, RecoveryCheckKind::Checked, "its MAC verifies");
        assert_eq!(
            headers(&copy),
            (main.clone(), bak),
            "the check writes nothing"
        );
        assert!(is_free(&copy));
        let later = "another long password";
        let view = done(finish(&ts, &checked.choice, later, true).unwrap()).data;
        assert!(!view.used_backup_header, "vault.json opened, not the spare");
        ts.shell.sessions.lock_all(LockReason::Manual);
        let after = headers(&copy);
        assert_eq!(after.0, after.1, "the change is whole in both files");
        assert_ne!(after.0, main);
        assert!(password_works(&copy, later));
        assert!(
            !password_works(&copy, NEW_PW),
            "the interrupted password is replaced"
        );
        assert!(!password_works(&copy, PW));
    }

    /// The minimum counts Unicode characters after NFC, as 21b's count does: a letter and its combining accent are
    /// one, and an emoji outside the Basic Multilingual Plane is one (not two). Eleven are refused with the choice
    /// kept; twelve set the password.
    #[test]
    fn the_minimum_after_nfc_at_recovery() {
        let ts = TestShell::new();
        let (id, dir, recovery) = registered(&ts);
        let short: ShellError = CoreError::PasswordTooShort { min: 12 }.into();
        let accent = "e\u{301}";
        let emoji = "\u{1F600}";
        let eleven = [
            format!("abcdefghij{accent}"),
            format!("abcdefghij{emoji}"),
            format!("abcdefghi{accent}{emoji}"),
        ];
        let twelve = [
            format!("abcdefghi{accent}{emoji}x"),
            format!("abcdefghij{emoji}{emoji}"),
        ];
        for password in &eleven {
            // The boundary: counted by code points (or UTF-16 units) it is twelve, counted after NFC it is eleven.
            assert!(
                password.chars().count() == 12 || password.encode_utf16().count() == 12,
                "{password:?}"
            );
            let checked = check(&ts, id, &recovery).unwrap();
            assert_eq!(
                finish(&ts, &checked.choice, password, true).err(),
                Some(short)
            );
            assert!(is_held(&ts, &checked.choice), "kept");
            ts.shell.recover_forget(&checked.choice).unwrap();
        }
        assert!(password_works(&dir, PW), "nothing was set by a refused one");
        for password in &twelve {
            let tagged = recover(&ts, id, &recovery, password).unwrap();
            assert_eq!(tagged.data.info.name, "Family");
            ts.shell.sessions.lock_all(LockReason::Manual);
            assert!(password_works(&dir, password));
        }
    }

    /// Through the bridge: each request's fields (and nothing else), a choice that is not a token, and each answer's
    /// JSON, with the refusals the page maps.
    #[test]
    fn recover_json_shapes() {
        let token = FAKE_TOKEN;
        // The requests: every field named in snake_case, nothing more allowed.
        refuses_a_path::<RecoverCheck>(
            json!({ "vault": { "list": 7, "id": 1 }, "recovery_key": "x" }),
        );
        refuses_a_path::<RecoverFinish>(
            json!({ "choice": token, "new_password": NEW_PW, "accept_changed_header": false }),
        );
        refuses_a_path::<RecoverForget>(json!({ "choice": token }));
        // A missing, extra or wrongly typed field, and a choice that is not 32 lowercase hex, is no request.
        let malformed = |body: Value| InvokeBody::Json(body);
        for body in [
            json!({ "vault": { "list": 7, "id": 1 } }),
            json!({ "recovery_key": "x" }),
            json!({ "id": 1, "recovery_key": "x" }),
            json!({ "vault": { "list": 7, "id": "1" }, "recovery_key": "x" }),
            json!({ "vault": { "list": 7, "id": 1 }, "recovery_key": 7 }),
            json!({ "vault": { "list": 7, "id": 1 }, "recoveryKey": "x" }),
        ] {
            assert_eq!(
                parse::<RecoverCheck>(&malformed(body)).err(),
                Some(MALFORMED)
            );
        }
        for body in [
            json!({ "choice": token, "new_password": NEW_PW }),
            json!({ "choice": token, "accept_changed_header": true }),
            json!({ "new_password": NEW_PW, "accept_changed_header": true }),
            json!({ "choice": token, "new_password": NEW_PW, "accept_changed_header": "yes" }),
            json!({ "choice": token, "new_password": 5, "accept_changed_header": true }),
            json!({ "choice": 7, "new_password": NEW_PW, "accept_changed_header": true }),
            json!({ "choice": "ABABABABABABABABABABABABABABABAB", "new_password": NEW_PW, "accept_changed_header": true }),
            json!({ "choice": "abab", "new_password": NEW_PW, "accept_changed_header": true }),
            json!({ "token": token, "new_password": NEW_PW, "accept_changed_header": true }),
        ] {
            assert_eq!(
                parse::<RecoverFinish>(&malformed(body)).err(),
                Some(MALFORMED)
            );
        }
        for body in [
            json!({}),
            json!({ "choice": "abab" }),
            json!({ "token": token }),
        ] {
            assert_eq!(
                parse::<RecoverForget>(&malformed(body)).err(),
                Some(MALFORMED)
            );
        }

        // The answers, from the real commands.
        let ts = TestShell::new();
        let (id, dir, recovery) = registered(&ts);
        let clean = check(&ts, id, &recovery).unwrap();
        let json = serde_json::to_value(&clean).unwrap();
        assert_eq!(json.as_object().unwrap().len(), 3);
        assert_eq!(json["kind"], "checked");
        assert_eq!(json["vault_name"], "Family");
        let text = json["choice"].as_str().unwrap();
        assert!(
            text.len() == 32
                && text
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        );
        ts.shell.recover_forget(&clean.choice).unwrap();
        // A choice already gone answers `null` too.
        assert_eq!(ts.shell.recover_forget(&clean.choice), Ok(()));
        assert_eq!(serde_json::to_value(()).unwrap(), Value::Null);

        change_header(&dir);
        let changed = check(&ts, id, &recovery).unwrap();
        let json = serde_json::to_value(&changed).unwrap();
        assert_eq!(json["kind"], "header_changed");
        assert_eq!(json["vault_name"], "Renamed");

        let answer = finish(&ts, &changed.choice, NEW_PW, true).unwrap();
        let json = serde_json::to_value(&answer).unwrap();
        let tagged = &json["Done"];
        assert_eq!(json.as_object().unwrap().len(), 1, "Done and nothing else");
        assert!(tagged["session"].is_u64() && tagged["generation"].is_u64());
        let data = &tagged["data"];
        assert_eq!(data["info"]["name"], "Renamed");
        for flag in [
            "used_backup_header",
            "header_mac_mismatch",
            "header_repair_failed",
        ] {
            assert!(data[flag].is_boolean(), "{flag}");
        }
        assert_eq!(data["header_mac_mismatch"], false, "accepted");
        assert!(data["recovery_unconfirmed"].is_boolean() && data["cleanup"].is_object());
        assert!(data.get("cloud").is_some());
        ts.shell.sessions.lock_all(LockReason::Manual);

        // The refusals, each the exact fixed JSON.
        let refused = |error: ShellError, expected: Value| {
            assert_eq!(serde_json::to_value(error).unwrap(), expected)
        };
        refused(ShellError::NotFound, json!({ "code": "not_found" }));
        refused(
            UNLOCKED,
            json!({ "code": "invalid_input", "what": "vault is unlocked" }),
        );
        refused(
            CoreError::PasswordTooShort { min: 12 }.into(),
            json!({ "code": "core", "kind": "password_too_short", "min": 12 }),
        );
        refused(
            ShellError::ChoiceExpired,
            json!({ "code": "choice_expired" }),
        );
        refused(
            ShellError::InvalidInput {
                what: "header changed on disk",
            },
            json!({ "code": "invalid_input", "what": "header changed on disk" }),
        );
        refused(ShellError::Locked, json!({ "code": "locked" }));
        refused(
            ShellError::LockedAfterChange {
                what: "password",
                vault: 3,
            },
            json!({ "code": "locked_after_change", "what": "password", "vault": 3 }),
        );
        // A finish and a check of the real commands answer with those.
        assert_eq!(
            said(check(&ts, id + 1, &recovery).err()),
            json!({ "code": "not_found" })
        );
        assert_eq!(
            said(finish(&ts, &changed.choice, NEW_PW, true).err()),
            json!({ "code": "choice_expired" })
        );
        assert_eq!(
            said(finish(&ts, &changed.choice, "short", true).err()),
            json!({ "code": "core", "kind": "password_too_short", "min": 12 })
        );
    }

    #[test]
    fn password_and_recovery_key_changed_from_the_session() {
        let ts = TestShell::new();
        let (id, dir, old_recovery) = registered(&ts);
        let tagged = heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(PW))).unwrap();
        let (session, generation) = (tagged.session, tagged.generation);
        let changed = heavy(|| {
            ts.shell
                .change_password(session, generation, secret(PW), secret(NEW_PW))
        });
        assert_eq!(changed.unwrap().generation, generation);
        // The new key asks for the password that is current now: the new one.
        let recovery = heavy(|| {
            ts.shell
                .new_recovery_key(session, generation, secret(NEW_PW))
        })
        .unwrap();
        assert_ne!(recovery.data.words.as_str(), old_recovery.as_str());
        // A stale generation is refused.
        assert_eq!(
            ts.shell.accept_header(session, generation + 1).err(),
            Some(ShellError::Locked)
        );
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert!(password_works(&dir, NEW_PW));
        let new_key = RecoverySecret::parse(&recovery.data.words).unwrap();
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
            let Ok(Outcome::Confirm(Confirm::CloudFolder { token, .. })) =
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
        let Ok(Outcome::Confirm(Confirm::CloudFolder { token, .. })) = asked else {
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
        let view = heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(PW)))
            .unwrap()
            .data;
        assert_eq!(view.cloud, None);
        assert_eq!(serde_json::to_value(&view).unwrap()["cloud"], Value::Null);
        ts.shell.sessions.lock_all(LockReason::Manual);

        ts.env.set_var("OneDrive", ts.vaults().into_os_string());
        let view = heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(PW)))
            .unwrap()
            .data;
        assert_eq!(view.cloud, Some(CloudProvider::OneDrive));
        assert_eq!(serde_json::to_value(&view).unwrap()["cloud"], "OneDrive");
        ts.shell.sessions.lock_all(LockReason::Manual);

        let view = recover(&ts, id, &recovery, NEW_PW).unwrap().data;
        assert_eq!(view.cloud, Some(CloudProvider::OneDrive));

        // After a changed header, the yes says so too.
        ts.shell.sessions.lock_all(LockReason::Manual);
        change_header(&dir);
        let checked = check(&ts, id, &recovery).unwrap();
        assert_eq!(checked.kind, RecoveryCheckKind::HeaderChanged);
        let view = done(finish(&ts, &checked.choice, PW, true).unwrap()).data;
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
        let tagged = recover(&ts, id, &recovery, NEW_PW).unwrap();
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
        let checked = check(&ts, id, &recovery).unwrap();
        let view = done(finish(&ts, &checked.choice, PW, true).unwrap()).data;
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
        let view = heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(PW))).unwrap();
        assert!(view.data.recovery_unconfirmed);
        assert_eq!(view.session, tagged.session);
    }

    /// A refusal to write the mark stops the create before anything is made: no vault, no staging folder, no list
    /// entry, no session, so no key was ever made.
    #[test]
    fn no_key_made_if_mark_cannot_be_written() {
        let ts = TestShell::new();
        let default = ts.env.folder(KnownFolder::Profile).join("Petalock Vaults");
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
        let Ok(Outcome::Confirm(Confirm::CloudFolder { token, .. })) = answer else {
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
        let default = ts.env.folder(KnownFolder::Profile).join("Petalock Vaults");
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
                what: "vault created",
                vault: ts.shell.registry.entries()[0].0
            })
        );
        assert!(ts.shell.vault_state.is_unconfirmed(&listed_dir(&ts)));
        assert_eq!(state_file(&ts)["vaults"].as_array().unwrap().len(), 1);
    }

    /// A mark that cannot be read for a reason other than damage (another program holds the file) is taken for a mark,
    /// not for none: the unlock then makes a new key rather than letting the person fill a vault whose key they never
    /// saw. A damaged file is another matter (it reads as empty; see `damaged_state_file_starts_empty`).
    #[test]
    fn an_unreadable_state_file_counts_as_a_mark() {
        let ts = TestShell::new();
        let (session, generation) = ts.open_vault("Family");
        ts.shell.recovery_confirmed(session, generation, 1).unwrap();
        let id = ts.shell.registry.entries()[0].0;
        ts.shell.sessions.lock_all(LockReason::Manual);
        let view = heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(PW))).unwrap();
        assert!(
            !view.data.recovery_unconfirmed,
            "a confirmed key shows nothing"
        );
        ts.shell.sessions.lock_all(LockReason::Manual);

        // A folder where the file should be: opening it for reading fails, and it is not a damaged file.
        fs::remove_file(&ts.shell.paths.vault_state).unwrap();
        fs::create_dir(&ts.shell.paths.vault_state).unwrap();
        let view = heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(PW))).unwrap();
        assert!(view.data.recovery_unconfirmed);
        // Unlocking again while unlocked reads it again.
        assert!(
            ts.shell
                .unlock_vault(ts.vault(id), secret(PW))
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

        let view = heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(PW))).unwrap();
        assert!(view.data.recovery_unconfirmed);
        assert_eq!(
            serde_json::to_value(&view.data).unwrap()["recovery_unconfirmed"],
            true
        );
        // Unlocking again while unlocked: no other warning, and the mark is read again.
        let again = ts.shell.unlock_vault(ts.vault(id), secret(PW)).unwrap();
        assert_eq!(again.session, view.session);
        assert!(!again.data.used_backup_header && again.data.cleanup == CleanupView::default());
        assert!(again.data.recovery_unconfirmed);

        // The new key needs no password; once confirmed, the next unlock says nothing.
        let (session, generation) = (view.session, view.generation);
        let fresh = heavy(|| ts.shell.regenerate_recovery(session, generation)).unwrap();
        assert_ne!(fresh.data.words.as_str(), key.as_str());
        assert_eq!(fresh.data.issue, 1, "the first key this session made");
        let after = ts.shell.unlock_vault(ts.vault(id), secret(PW)).unwrap();
        assert!(after.data.recovery_unconfirmed, "still unconfirmed");
        let confirmed = ts
            .shell
            .recovery_confirmed(session, generation, fresh.data.issue)
            .unwrap();
        assert_eq!(confirmed.data, Confirmation::Confirmed);
        assert!(
            !ts.shell
                .unlock_vault(ts.vault(id), secret(PW))
                .unwrap()
                .data
                .recovery_unconfirmed
        );
        ts.shell.sessions.lock_all(LockReason::Manual);
        let view = heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(PW))).unwrap();
        assert!(!view.data.recovery_unconfirmed);
        ts.shell.sessions.lock_all(LockReason::Manual);

        // A mark again (a vault the person made a new key for and never confirmed): by the recovery key.
        ts.shell.vault_state.mark_unconfirmed(&dir).unwrap();
        let recovered = recover(&ts, id, &fresh.data.words, NEW_PW);
        assert!(recovered.unwrap().data.recovery_unconfirmed);
        ts.shell.sessions.lock_all(LockReason::Manual);

        // And through the changed header's yes.
        change_header(&dir);
        let checked = check(&ts, id, &fresh.data.words).unwrap();
        assert_eq!(checked.kind, RecoveryCheckKind::HeaderChanged);
        let view = done(finish(&ts, &checked.choice, PW, true).unwrap());
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
        let backup = backups.join("Family.petalock-backup");
        ts.dialogs.answer(Some(backup.clone()));
        done(
            heavy(|| ts.shell.backup_vault(session, generation, 1))
                .unwrap()
                .data,
        );
        ts.shell.sessions.lock_all(LockReason::Manual);

        // The copy holds the vault's ID and is opened read-only.
        let credential = super::super::backup::CredentialArg::Password(secret(PW));
        let opened = ts.open_backup_read_only(&backup, credential);
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
                .recovery_confirmed(opened.session, opened.generation, 1)
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
        let answer = ts.shell.recovery_confirmed(session, generation, 1).unwrap();
        assert_eq!(
            serde_json::to_value(&answer).unwrap(),
            json!({ "session": session.0, "generation": generation, "data": "Confirmed" })
        );
        assert!(!ts.shell.vault_state.is_unconfirmed(&dir));
        assert!(
            ts.shell.vault_state.is_unconfirmed(&other_dir),
            "only this session's vault"
        );
        // Clearing a mark that is not there is a success.
        ts.shell.recovery_confirmed(session, generation, 1).unwrap();
        ts.shell.recovery_confirmed(other.0, other.1, 1).unwrap();
        ts.shell.sessions.lock_all(LockReason::Manual);
        let id = ts.shell.registry.entries()[0].0;
        let view = heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(PW))).unwrap();
        assert!(!view.data.recovery_unconfirmed);
    }

    #[test]
    fn recovery_confirmed_refused_stale_and_read_only() {
        let ts = TestShell::new();
        let (session, generation) = ts.open_vault("Family");
        let dir = listed_dir(&ts);
        // A stale generation, a session that is not there, and a session that has locked since.
        assert_eq!(
            ts.shell
                .recovery_confirmed(session, generation + 1, 1)
                .err(),
            Some(ShellError::Locked)
        );
        assert_eq!(
            ts.shell
                .recovery_confirmed(SessionId(session.0 + 100), generation, 1)
                .err(),
            Some(ShellError::NotFound)
        );
        assert!(ts.shell.vault_state.is_unconfirmed(&dir), "nothing cleared");
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert_eq!(
            ts.shell.recovery_confirmed(session, generation, 1).err(),
            Some(ShellError::Locked)
        );
        assert!(ts.shell.vault_state.is_unconfirmed(&dir));
        // A read-only copy is refused (also in `read_only_copy_with_same_id_never_shows_the_mark`).
        let (session, generation) = ts.open_vault("Work");
        let backup = ts.folder("Backups").join("Work.petalock-backup");
        ts.dialogs.answer(Some(backup.clone()));
        done(
            heavy(|| ts.shell.backup_vault(session, generation, 1))
                .unwrap()
                .data,
        );
        ts.shell.sessions.lock_all(LockReason::Manual);
        let credential = super::super::backup::CredentialArg::Password(secret(PW));
        let copy = ts.open_backup_read_only(&backup, credential);
        let refused = ts
            .shell
            .recovery_confirmed(copy.session, copy.generation, 1);
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
            kind: SessionKind::Vault,
        };
        let cleanup = r#"{"partials_removed":0,"temps_removed":0,"retired_deleted":0,"purges_finished":0,"orphans_quarantined":0,"orphans_restored":0,"skipped_damaged":0,"failed":0}"#;
        let expected = |mark: bool| {
            format!(
                r#"{{"info":{{"session":7,"generation":3,"name":"Family","read_only":false,"state":"unlocked","kind":"vault"}},"used_backup_header":false,"header_mac_mismatch":false,"header_repair_failed":false,"cleanup":{cleanup},"cloud":null,"recovery_unconfirmed":{mark}}}"#
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
        for (data, text) in [
            (Confirmation::Confirmed, "Confirmed"),
            (Confirmation::Superseded, "Superseded"),
        ] {
            let answer = Tagged {
                session: SessionId(7),
                generation: 3,
                data,
            };
            assert_eq!(
                serde_json::to_string(&answer).unwrap(),
                format!(r#"{{"session":7,"generation":3,"data":"{text}"}}"#)
            );
        }
        // `regenerate_recovery` and `accept_header` take no more than the session and its generation.
        refuses_a_path::<SessionArg>(json!({ "session": 7, "generation": 3 }));
        // `recovery_confirmed` names the key it confirms.
        refuses_a_path::<RecoveryConfirmed>(json!({ "session": 7, "generation": 3, "issue": 2 }));
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
        // `forget_vault` and `show_vault_in_explorer`.
        refuses_a_path::<VaultArg>(json!({ "vault": { "list": 7, "id": 1 } }));
        // `create_vault_confirm` and `add_existing_vault_confirm`.
        refuses_a_path::<TokenArg>(json!({ "token": token }));
        refuses_a_path::<UnlockVault>(json!({ "vault": { "list": 7, "id": 1 }, "password": PW }));
        refuses_a_path::<RecoverCheck>(
            json!({ "vault": { "list": 7, "id": 1 }, "recovery_key": "x" }),
        );
        refuses_a_path::<RecoverFinish>(
            json!({ "choice": token, "new_password": NEW_PW, "accept_changed_header": true }),
        );
        refuses_a_path::<RecoverForget>(json!({ "choice": token }));
        refuses_a_path::<SessionArg>(json!({ "session": 1, "generation": 1 }));
        refuses_a_path::<ChangePassword>(
            json!({ "session": 1, "generation": 1, "current_password": PW, "new_password": NEW_PW }),
        );
        refuses_a_path::<NewRecoveryKey>(
            json!({ "session": 1, "generation": 1, "current_password": PW }),
        );
    }

    // ---- The current password, checked in the same call; 21f's permission and the confirmation (Plan 4C, Task 2) ----

    /// A new vault, made through the shell, whose creation key is confirmed (issue 1): an unlocked session with no
    /// mark and no 21f permission, like one opened after a confirmed key.
    fn confirmed_session(ts: &TestShell, name: &str) -> (SessionId, u64) {
        let (session, generation) = ts.open_vault(name);
        let answer = ts.shell.recovery_confirmed(session, generation, 1).unwrap();
        assert_eq!(answer.data, Confirmation::Confirmed);
        (session, generation)
    }

    /// The folder a session holds.
    fn folder_of(ts: &TestShell, session: SessionId) -> PathBuf {
        ts.shell
            .sessions
            .location_of(session)
            .expect("the session is there")
            .path()
            .to_path_buf()
    }

    /// The registry ID of the vault a session holds.
    fn registry_id(ts: &TestShell, session: SessionId) -> u32 {
        let folder = folder_of(ts, session);
        ts.shell
            .registry
            .entries()
            .into_iter()
            .find(|(_, listed)| crate::os::same_path(listed, &folder))
            .expect("the vault is listed")
            .0
    }

    /// Everything a refused change must leave alone: both header files and the vault-state file (`None`: not there).
    fn on_disk(ts: &TestShell, dir: &Path) -> OnDisk {
        (headers(dir), fs::read(&ts.shell.paths.vault_state).ok())
    }

    /// The two header files' bytes and the state file's (`None`: not there).
    type OnDisk = ((Vec<u8>, Vec<u8>), Option<Vec<u8>>);

    /// Locks every vault when the command reaches the test step `step` (`PASSWORD_CHECKED`, `BEFORE_HEADER_WRITES`, or
    /// one of the engine's own failpoints), on the thread that runs the command.
    fn lock_at(ts: &TestShell, step: &'static str) {
        let shell = Arc::clone(&ts.shell);
        failpoint::observe(
            step,
            Box::new(move || shell.sessions.lock_all(LockReason::Manual)),
        );
    }

    #[test]
    fn wrong_current_password_changes_nothing() {
        let ts = TestShell::new();
        let (session, generation) = confirmed_session(&ts, "Family");
        let dir = folder_of(&ts, session);
        let before = on_disk(&ts, &dir);
        for wrong in [
            "another long password",
            "correct horse batter",
            "CORRECT HORSE BATTERY",
        ] {
            let changed = heavy(|| {
                ts.shell
                    .change_password(session, generation, secret(wrong), secret(NEW_PW))
            });
            assert_eq!(changed.err(), Some(wrong_password()), "{wrong}");
            let key = heavy(|| {
                ts.shell
                    .new_recovery_key(session, generation, secret(wrong))
            });
            assert_eq!(key.err(), Some(wrong_password()), "{wrong}");
            assert_eq!(
                on_disk(&ts, &dir),
                before,
                "{wrong}: both headers and the state file"
            );
        }
        // The vault still opens with its password, and with nothing else.
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert!(password_works(&dir, PW));
        assert!(!password_works(&dir, NEW_PW));
        assert_eq!(on_disk(&ts, &dir), before);
    }

    #[test]
    fn change_password_with_the_current_password_sets_the_new_one() {
        let ts = TestShell::new();
        let (session, generation) = confirmed_session(&ts, "Family");
        let dir = folder_of(&ts, session);
        let before = headers(&dir);
        let changed = heavy(|| {
            ts.shell
                .change_password(session, generation, secret(PW), secret(NEW_PW))
        })
        .unwrap();
        assert_eq!(
            serde_json::to_value(&changed).unwrap(),
            json!({ "session": session.0, "generation": generation, "data": null })
        );
        assert_ne!(headers(&dir), before);
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert!(password_works(&dir, NEW_PW));
        assert!(!password_works(&dir, PW));
    }

    /// The new password's length is checked first: a refused password spends no Argon2 (the step after the current
    /// password's check is never reached), whatever the current password is.
    #[test]
    fn change_password_refuses_a_short_new_password_before_checking() {
        let ts = TestShell::new();
        let (session, generation) = confirmed_session(&ts, "Family");
        let dir = folder_of(&ts, session);
        let before = on_disk(&ts, &dir);
        let reached = Rc::new(Cell::new(false));
        let seen = Rc::clone(&reached);
        failpoint::observe(PASSWORD_CHECKED, Box::new(move || seen.set(true)));
        let too_short = ShellError::from(CoreError::PasswordTooShort { min: 12 });
        for current in [PW, "another long password"] {
            let answer =
                ts.shell
                    .change_password(session, generation, secret(current), secret("too short"));
            assert_eq!(answer.err(), Some(too_short), "current: {current}");
        }
        failpoint::disarm_all();
        assert!(!reached.get(), "the current password was never checked");
        assert_eq!(on_disk(&ts, &dir), before);
    }

    /// The engine's fixture: a password slot that opens with the typed password and wraps another key than the vault's.
    /// Both commands refuse it, changing nothing (headers and state file).
    #[test]
    fn change_password_and_new_recovery_key_refuse_a_slot_wrapping_another_key() {
        let ts = TestShell::new();
        let (session, generation) = confirmed_session(&ts, "Family");
        let dir = folder_of(&ts, session);
        ts.shell
            .sessions
            .write(session, generation, |vault, _| {
                lockbox_core::internals::fixture::password_slot_wrapping_another_key(vault, PW);
                Ok(())
            })
            .unwrap();
        let before = on_disk(&ts, &dir);
        let changed = heavy(|| {
            ts.shell
                .change_password(session, generation, secret(PW), secret(NEW_PW))
        });
        assert_eq!(changed.err(), Some(wrong_password()));
        let key = heavy(|| ts.shell.new_recovery_key(session, generation, secret(PW)));
        assert_eq!(key.err(), Some(wrong_password()));
        assert_eq!(
            on_disk(&ts, &dir),
            before,
            "headers and state file unchanged"
        );
    }

    /// A lock that comes while the current password is checked: nothing is written, and the answer is `Locked`.
    #[test]
    fn a_lock_during_the_password_check_changes_nothing_and_answers_locked() {
        let ts = TestShell::new();
        for command in ["change_password", "new_recovery_key"] {
            let (session, generation) = confirmed_session(&ts, command);
            let dir = folder_of(&ts, session);
            let before = on_disk(&ts, &dir);
            lock_at(&ts, PASSWORD_CHECKED);
            let answer = match command {
                "change_password" => heavy(|| {
                    ts.shell
                        .change_password(session, generation, secret(PW), secret(NEW_PW))
                        .map(|_| ())
                }),
                _ => heavy(|| {
                    ts.shell
                        .new_recovery_key(session, generation, secret(PW))
                        .map(|_| ())
                }),
            };
            failpoint::disarm_all();
            assert_eq!(answer.err(), Some(ShellError::Locked), "{command}");
            assert_eq!(on_disk(&ts, &dir), before, "{command}");
            assert!(password_works(&dir, PW), "{command}");
        }
    }

    /// A lock that comes after everything slow is done, just before the header writes: the stop check sees it, so
    /// nothing is written and the answer is `Locked`.
    #[test]
    fn a_stop_just_before_the_header_writes_changes_nothing_and_answers_locked() {
        let ts = TestShell::new();
        for command in ["change_password", "new_recovery_key"] {
            let (session, generation) = confirmed_session(&ts, command);
            let dir = folder_of(&ts, session);
            let before = headers(&dir);
            lock_at(&ts, BEFORE_HEADER_WRITES);
            let answer = match command {
                "change_password" => heavy(|| {
                    ts.shell
                        .change_password(session, generation, secret(PW), secret(NEW_PW))
                        .map(|_| ())
                }),
                _ => heavy(|| {
                    ts.shell
                        .new_recovery_key(session, generation, secret(PW))
                        .map(|_| ())
                }),
            };
            failpoint::disarm_all();
            assert_eq!(answer.err(), Some(ShellError::Locked), "{command}");
            assert_eq!(headers(&dir), before, "{command}: nothing was written");
            assert!(password_works(&dir, PW), "{command}");
            assert!(!password_works(&dir, NEW_PW), "{command}");
        }
    }

    /// A lock that comes between the two header writes: the change is whole on disk, so the answer says it landed, for
    /// the vault it landed in (its registry ID), and carries nothing of the new key.
    #[test]
    fn a_lock_after_the_change_landed_answers_locked_after_change_with_the_vault() {
        let ts = TestShell::new();
        let (other, _) = confirmed_session(&ts, "Other");
        let (session, generation) = confirmed_session(&ts, "Family");
        let (id, other_id) = (registry_id(&ts, session), registry_id(&ts, other));
        assert_ne!(id, other_id);
        let dir = folder_of(&ts, session);
        lock_at(&ts, "write_headers.before_second");
        let answer = heavy(|| {
            ts.shell
                .change_password(session, generation, secret(PW), secret(NEW_PW))
                .map(|_| ())
        });
        failpoint::disarm_all();
        let error = answer.expect_err("overtaken by the lock");
        assert_eq!(
            error,
            ShellError::LockedAfterChange {
                what: "password",
                vault: id
            }
        );
        assert_eq!(
            serde_json::to_string(&error).unwrap(),
            format!(r#"{{"code":"locked_after_change","what":"password","vault":{id}}}"#)
        );
        assert!(password_works(&dir, NEW_PW), "the new password landed");

        // A new key: the same, and the answer holds no words.
        let (session, generation) = confirmed_session(&ts, "Third");
        let (id, dir) = (registry_id(&ts, session), folder_of(&ts, session));
        let before = headers(&dir);
        lock_at(&ts, "write_headers.before_second");
        let answer = heavy(|| ts.shell.new_recovery_key(session, generation, secret(PW)));
        failpoint::disarm_all();
        let Err(error) = answer else {
            panic!("overtaken by the lock");
        };
        assert_eq!(
            serde_json::to_string(&error).unwrap(),
            format!(r#"{{"code":"locked_after_change","what":"recovery key","vault":{id}}}"#)
        );
        let after = headers(&dir);
        assert_ne!(after, before, "the new key's header landed");
        assert_eq!(after.0, after.1, "in both files");
    }

    /// The engine's `commit` reads `vault.json` back after a failed write and makes the new header live when it landed (the
    /// partial-write hook of `vault_stays_usable_after_a_partial_header_write`: after `vault.json`, before `.bak`). The
    /// change did happen, so the person must not be told it didn't: the vault is locked and the answer is
    /// `LockedAfterChange` with its registry ID and nothing else, which the page shows as "Your new password was saved, but
    /// the vault locked before Petalock could say so." (true). Another vault stays open.
    #[test]
    fn a_change_that_landed_though_its_write_failed_locks_the_vault_and_says_so() {
        let ts = TestShell::new();
        let (other, other_generation) = confirmed_session(&ts, "Other");
        let (session, generation) = confirmed_session(&ts, "Family");
        let id = registry_id(&ts, session);
        let dir = folder_of(&ts, session);
        let before = headers(&dir);
        failpoint::arm("write_headers.before_second");
        let answer = heavy(|| {
            ts.shell
                .change_password(session, generation, secret(PW), secret(NEW_PW))
                .map(|_| ())
        });
        failpoint::disarm_all();
        let error = answer.expect_err("the write failed");
        assert_eq!(
            error,
            ShellError::LockedAfterChange {
                what: "password",
                vault: id
            }
        );
        let said = serde_json::to_string(&error).unwrap();
        assert_eq!(
            said,
            format!(r#"{{"code":"locked_after_change","what":"password","vault":{id}}}"#)
        );
        assert!(!said.contains(PW) && !said.contains(NEW_PW));
        // `vault.json` is ahead of `.bak`: the new password's header landed in one file only.
        let (main, spare) = headers(&dir);
        assert_ne!(main, before.0);
        assert_eq!(spare, before.1);
        // The vault's session is locked (a command in its generation is refused as locked); the other one is not.
        let after = ts.shell.sessions.write(session, generation, |_, _| Ok(()));
        assert_eq!(after.err(), Some(ShellError::Locked));
        assert!(
            ts.shell
                .sessions
                .write(other, other_generation, |_, _| Ok(()))
                .is_ok()
        );
        assert!(password_works(&dir, NEW_PW), "the new password opens it");
    }

    /// The same failure before `vault.json` was touched: nothing landed, so the answer stays the plain error, the
    /// session stays open, and the old password still opens.
    #[test]
    fn a_change_whose_write_failed_before_vault_json_changes_nothing_and_stays_open() {
        let ts = TestShell::new();
        let (session, generation) = confirmed_session(&ts, "Family");
        let dir = folder_of(&ts, session);
        let before = headers(&dir);
        failpoint::arm("write_headers.before_first");
        let answer = heavy(|| {
            ts.shell
                .change_password(session, generation, secret(PW), secret(NEW_PW))
                .map(|_| ())
        });
        failpoint::disarm_all();
        let error = answer.expect_err("the write failed");
        assert!(
            !matches!(
                error,
                ShellError::Locked | ShellError::LockedAfterChange { .. }
            ),
            "a plain refusal: {error:?}"
        );
        assert_eq!(headers(&dir), before, "nothing was written");
        assert!(
            ts.shell
                .sessions
                .write(session, generation, |_, _| Ok(()))
                .is_ok(),
            "the session is still open"
        );
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert!(password_works(&dir, PW));
        assert!(!password_works(&dir, NEW_PW));
    }

    /// Two changes that hold the same current password: the vault's write lock keeps them apart, so one wins and the
    /// other is refused (busy while the first runs; wrong password once the first is done).
    #[test]
    fn two_changes_with_one_current_password_one_wins_the_other_is_refused() {
        let ts = TestShell::new();
        let (session, generation) = confirmed_session(&ts, "Family");
        let dir = folder_of(&ts, session);
        const OTHER_PW: &str = "yet another long password";

        // The second starts while the first sits just after its password check, inside the write lock.
        let second = Rc::new(RefCell::new(None));
        let (shell, record) = (Arc::clone(&ts.shell), Rc::clone(&second));
        failpoint::observe(
            PASSWORD_CHECKED,
            Box::new(move || {
                let shell = Arc::clone(&shell);
                let racer = thread::spawn(move || {
                    shell
                        .change_password(session, generation, secret(PW), secret(OTHER_PW))
                        .map(|_| ())
                });
                *record.borrow_mut() = Some(racer.join().unwrap());
            }),
        );
        let first = heavy(|| {
            ts.shell
                .change_password(session, generation, secret(PW), secret(NEW_PW))
        });
        failpoint::disarm_all();
        assert!(first.is_ok());
        let racer = second.borrow_mut().take().expect("the second ran");
        assert_eq!(
            racer.err(),
            Some(ShellError::Busy {
                what: "operation in progress"
            })
        );

        // Once the first is done, the same current password is the old one.
        let third = heavy(|| {
            ts.shell
                .change_password(session, generation, secret(PW), secret(OTHER_PW))
        });
        assert_eq!(third.err(), Some(wrong_password()));
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert!(password_works(&dir, NEW_PW));
        assert!(!password_works(&dir, OTHER_PW));
        assert!(!password_works(&dir, PW));
    }

    #[test]
    fn new_recovery_key_checks_the_current_password_first() {
        let ts = TestShell::new();
        let (session, generation) = confirmed_session(&ts, "Family");
        let dir = folder_of(&ts, session);
        let before = on_disk(&ts, &dir);
        assert!(!ts.shell.vault_state.is_unconfirmed(&dir));
        let wrong = heavy(|| {
            ts.shell
                .new_recovery_key(session, generation, secret(NEW_PW))
        });
        assert_eq!(wrong.err(), Some(wrong_password()));
        assert_eq!(on_disk(&ts, &dir), before, "no mark, header unchanged");
        assert!(!ts.shell.vault_state.is_unconfirmed(&dir));

        let key = heavy(|| ts.shell.new_recovery_key(session, generation, secret(PW))).unwrap();
        assert_eq!(key.data.issue, 2, "the creation key was 1");
        assert!(
            ts.shell.vault_state.is_unconfirmed(&dir),
            "marked until confirmed"
        );
        assert_ne!(headers(&dir), before.0);
    }

    /// The mark is on disk when the first header file is written, and an interruption after the spare leaves it:
    /// the next unlock makes another key (21f).
    #[test]
    fn new_recovery_key_writes_the_mark_before_the_header() {
        let ts = TestShell::new();
        let (session, generation) = confirmed_session(&ts, "Family");
        let dir = folder_of(&ts, session);
        let id = registry_id(&ts, session);
        let seen = Rc::new(Cell::new(None));
        let (shell, record, dir_seen) = (Arc::clone(&ts.shell), Rc::clone(&seen), dir.clone());
        failpoint::observe(
            "write_headers.before_first",
            Box::new(move || record.set(Some(shell.vault_state.is_unconfirmed(&dir_seen)))),
        );
        let key = heavy(|| ts.shell.new_recovery_key(session, generation, secret(PW)));
        failpoint::disarm_all();
        key.unwrap();
        assert_eq!(seen.get(), Some(true), "marked when the header was written");
        assert!(
            ts.shell.vault_state.is_unconfirmed(&dir),
            "and stays marked"
        );

        // Interrupted after the spare (`.bak`), before vault.json: the mark stays, and 21f follows at the next unlock.
        let (session, generation) = confirmed_session(&ts, "Work");
        let work = folder_of(&ts, session);
        let before = headers(&work);
        failpoint::arm("write_headers.before_second");
        let key = heavy(|| ts.shell.new_recovery_key(session, generation, secret(PW)));
        failpoint::disarm_all();
        assert!(matches!(key.err(), Some(ShellError::Core(view)) if view.kind == "io"));
        let after = headers(&work);
        assert_eq!(after.0, before.0, "vault.json still holds the old key");
        assert_ne!(after.1, before.1, "the spare holds the undelivered one");
        assert!(ts.shell.vault_state.is_unconfirmed(&work));
        ts.shell.sessions.lock_all(LockReason::Manual);
        let work_id = ts
            .shell
            .registry
            .entries()
            .into_iter()
            .find(|(_, listed)| crate::os::same_path(listed, &work))
            .unwrap()
            .0;
        assert_ne!(work_id, id);
        let view = heavy(|| ts.shell.unlock_vault(ts.vault(work_id), secret(PW))).unwrap();
        assert!(view.data.recovery_unconfirmed, "21f follows");
        // 21f's step may make the key it asks for without the password.
        let made = heavy(|| ts.shell.regenerate_recovery(view.session, view.generation));
        assert!(made.is_ok());
    }

    #[test]
    fn regenerate_recovery_refused_without_the_sessions_21f_permission() {
        let ts = TestShell::new();
        // An unlocked session with no mark: the vault's key was confirmed.
        let (id, dir, _) = registered(&ts);
        let opened = heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(PW))).unwrap();
        assert!(!opened.data.recovery_unconfirmed);
        let (session, generation) = (opened.session, opened.generation);
        let before = on_disk(&ts, &dir);
        let refused = heavy(|| ts.shell.regenerate_recovery(session, generation));
        assert_eq!(
            refused.err(),
            Some(ShellError::InvalidInput {
                what: "recovery key"
            })
        );
        assert_eq!(on_disk(&ts, &dir), before);

        // A session whose voluntary key (made with the password) awaits confirmation: still no permission.
        let key = heavy(|| ts.shell.new_recovery_key(session, generation, secret(PW))).unwrap();
        assert!(ts.shell.vault_state.is_unconfirmed(&dir));
        let after_key = on_disk(&ts, &dir);
        let refused = heavy(|| ts.shell.regenerate_recovery(session, generation));
        assert_eq!(
            refused.err(),
            Some(ShellError::InvalidInput {
                what: "recovery key"
            })
        );
        assert_eq!(on_disk(&ts, &dir), after_key, "nothing changed");
        // Its confirmation is the way out.
        let confirmed = ts
            .shell
            .recovery_confirmed(session, generation, key.data.issue)
            .unwrap();
        assert_eq!(confirmed.data, Confirmation::Confirmed);
        assert!(!ts.shell.vault_state.is_unconfirmed(&dir));
    }

    /// A mark the shell could not read (another program holds the file) shows 21f, at the cost of one extra key, but
    /// never grants a key without the password.
    #[test]
    fn an_unreadable_state_file_never_grants_a_key_without_the_password() {
        let ts = TestShell::new();
        let (session, _) = confirmed_session(&ts, "Family");
        let id = registry_id(&ts, session);
        let dir = folder_of(&ts, session);
        ts.shell.sessions.lock_all(LockReason::Manual);
        // A folder where the file should be: reading it fails, and it is not a damaged file.
        fs::remove_file(&ts.shell.paths.vault_state).unwrap();
        fs::create_dir(&ts.shell.paths.vault_state).unwrap();
        let view = heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(PW))).unwrap();
        assert!(view.data.recovery_unconfirmed, "21f still shows");
        let before = headers(&dir);
        let refused = heavy(|| ts.shell.regenerate_recovery(view.session, view.generation));
        assert_eq!(
            refused.err(),
            Some(ShellError::InvalidInput {
                what: "recovery key"
            }),
            "refused for want of permission, not for the unreadable file"
        );
        assert_eq!(headers(&dir), before);
        assert!(ts.shell.paths.vault_state.is_dir(), "left as it was");
        // With the password it is a different matter: the way out of 21f stays open (and fails only on the file).
        let with_password = heavy(|| {
            ts.shell
                .new_recovery_key(view.session, view.generation, secret(PW))
        });
        assert!(matches!(
            with_password.err(),
            Some(ShellError::Core(error)) if error.kind == "io"
        ));
        assert_eq!(headers(&dir), before);
    }

    /// An unlock of a vault that is already unlocked answers with its session without checking the password it was
    /// given, so it must grant nothing: only an unlock whose closure ran proved a password.
    #[test]
    fn unlocking_an_open_vault_checks_nothing_and_grants_nothing() {
        let ts = TestShell::new();
        let (session, generation) = confirmed_session(&ts, "Family");
        let id = registry_id(&ts, session);
        let dir = folder_of(&ts, session);
        ts.shell.vault_state.mark_unconfirmed(&dir).unwrap();
        let before = on_disk(&ts, &dir);
        let again = ts
            .shell
            .unlock_vault(ts.vault(id), secret("not the password at all"));
        let again = again.expect("an unlock of an open vault answers with its session");
        assert_eq!((again.session, again.generation), (session, generation));
        assert!(again.data.recovery_unconfirmed, "21f shows");
        let refused = heavy(|| ts.shell.regenerate_recovery(session, generation));
        assert_eq!(
            refused.err(),
            Some(ShellError::InvalidInput {
                what: "recovery key"
            })
        );
        assert_eq!(on_disk(&ts, &dir), before);
    }

    /// A recovery (the recovery key and a new password, so a credential was proved) that enters 21f is given 21f's
    /// permission, straight and through the changed-header question's yes; one with no mark is given none.
    #[test]
    fn a_recovery_that_enters_21f_grants_the_permission() {
        let ts = TestShell::new();
        let (id, dir, recovery) = registered(&ts);
        let refused = ShellError::InvalidInput {
            what: "recovery key",
        };

        // No mark: the recovery opens the vault, and no key may be made without the password.
        let plain = recover(&ts, id, &recovery, NEW_PW).unwrap();
        assert!(!plain.data.recovery_unconfirmed);
        let none = heavy(|| {
            ts.shell
                .regenerate_recovery(plain.session, plain.generation)
        });
        assert_eq!(none.err(), Some(refused));
        ts.shell.sessions.lock_all(LockReason::Manual);

        // A mark: the recovery enters 21f, and the key it asks for is made without the password.
        ts.shell.vault_state.mark_unconfirmed(&dir).unwrap();
        let marked = recover(&ts, id, &recovery, NEW_PW).unwrap();
        assert!(marked.data.recovery_unconfirmed);
        let made = heavy(|| {
            ts.shell
                .regenerate_recovery(marked.session, marked.generation)
        });
        let made = made.expect("21f may make a key");
        assert_eq!(made.data.issue, 1);
        ts.shell.sessions.lock_all(LockReason::Manual);

        // The same through the changed header's yes (with the key that was just made: the first one stopped working).
        let current = made.data.words.clone();
        change_header(&dir);
        let checked = check(&ts, id, &current).unwrap();
        assert_eq!(checked.kind, RecoveryCheckKind::HeaderChanged);
        let accepted = done(finish(&ts, &checked.choice, NEW_PW, true).unwrap());
        assert!(accepted.data.recovery_unconfirmed);
        let key = heavy(|| {
            ts.shell
                .regenerate_recovery(accepted.session, accepted.generation)
        });
        assert!(key.is_ok());
    }

    /// The mark is the folder's, not the vault ID's: a copy of a vault in another folder keeps its ID but not the
    /// mark, so unlocking it grants nothing, while the marked folder's session is granted.
    #[test]
    fn a_copy_with_the_same_vault_id_in_another_folder_gets_no_permission() {
        let ts = TestShell::new();
        let id = VaultId::random();
        let (one, two) = (ts.folder("one"), ts.folder("two"));
        let (a, b) = heavy(|| {
            let a = Vault::create_with_id(&one, "Family", PW, id).unwrap();
            let b = Vault::create_with_id(&two, "Family", PW, id).unwrap();
            (
                fs::canonicalize(a.vault.dir()).unwrap(),
                fs::canonicalize(b.vault.dir()).unwrap(),
            )
        });
        let (a_id, b_id) = (
            ts.shell.registry.add(&a).unwrap().id,
            ts.shell.registry.add(&b).unwrap().id,
        );
        ts.shell.vault_state.mark_unconfirmed(&a).unwrap();

        let copy = heavy(|| ts.shell.unlock_vault(ts.vault(b_id), secret(PW))).unwrap();
        assert!(!copy.data.recovery_unconfirmed);
        let before = on_disk(&ts, &b);
        let refused = heavy(|| ts.shell.regenerate_recovery(copy.session, copy.generation));
        assert_eq!(
            refused.err(),
            Some(ShellError::InvalidInput {
                what: "recovery key"
            })
        );
        assert_eq!(on_disk(&ts, &b), before);

        let marked = heavy(|| ts.shell.unlock_vault(ts.vault(a_id), secret(PW))).unwrap();
        assert!(marked.data.recovery_unconfirmed);
        assert!(
            heavy(|| ts
                .shell
                .regenerate_recovery(marked.session, marked.generation))
            .is_ok()
        );
    }

    /// 21f and its Try again, unchanged: a created vault and a 21f unlock each make a key without the password, any
    /// number of times, each with its own `issue`.
    #[test]
    fn regenerate_recovery_with_the_permission_still_makes_a_key() {
        let ts = TestShell::new();
        let (session, generation) = ts.open_vault("Family");
        let dir = folder_of(&ts, session);
        let first = heavy(|| ts.shell.regenerate_recovery(session, generation)).unwrap();
        let again = heavy(|| ts.shell.regenerate_recovery(session, generation)).unwrap();
        assert_eq!((first.data.issue, again.data.issue), (2, 3));
        assert_ne!(first.data.words.as_str(), again.data.words.as_str());
        assert_eq!(
            serde_json::to_value(&again).unwrap(),
            json!({
                "session": session.0,
                "generation": generation,
                "data": { "words": again.data.words.as_str(), "issue": 3 }
            })
        );
        assert!(ts.shell.vault_state.is_unconfirmed(&dir));
        // The newest key is the vault's; the first stopped working.
        let id = registry_id(&ts, session);
        ts.shell.sessions.lock_all(LockReason::Manual);
        let newest = RecoverySecret::parse(&again.data.words).unwrap();
        let oldest = RecoverySecret::parse(&first.data.words).unwrap();
        assert!(heavy(|| Vault::unlock_with_recovery(&dir, &newest)).is_ok());
        assert!(heavy(|| Vault::unlock_with_recovery(&dir, &oldest)).is_err());

        // A 21f unlock: the same, numbered from 1 in the new session.
        let view = heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(PW))).unwrap();
        assert!(view.data.recovery_unconfirmed);
        let key = heavy(|| ts.shell.regenerate_recovery(view.session, view.generation)).unwrap();
        assert_eq!(key.data.issue, 1);
    }

    /// A confirmation names its key. An older key's confirmation leaves the mark and the permission, so the newer key
    /// is still the one to confirm; the reply for the newer key then clears both.
    #[test]
    fn confirming_an_older_key_leaves_the_mark_set() {
        let ts = TestShell::new();
        let (session, generation) = ts.open_vault("Family");
        let dir = folder_of(&ts, session);
        let newer = heavy(|| ts.shell.regenerate_recovery(session, generation)).unwrap();
        assert_eq!(newer.data.issue, 2);
        for older in [1, 0, 3, 99] {
            let answer = ts
                .shell
                .recovery_confirmed(session, generation, older)
                .unwrap();
            assert_eq!(answer.data, Confirmation::Superseded, "issue {older}");
            assert!(
                ts.shell.vault_state.is_unconfirmed(&dir),
                "issue {older}: the mark stays"
            );
        }
        // The permission stayed too: 21f's Try again still works.
        let retry = heavy(|| ts.shell.regenerate_recovery(session, generation)).unwrap();
        assert_eq!(retry.data.issue, 3);
        // The reply for the key before it is now the older one.
        let late = ts.shell.recovery_confirmed(session, generation, 2).unwrap();
        assert_eq!(late.data, Confirmation::Superseded);
        assert!(ts.shell.vault_state.is_unconfirmed(&dir));
        let current = ts.shell.recovery_confirmed(session, generation, 3).unwrap();
        assert_eq!(current.data, Confirmation::Confirmed);
        assert!(!ts.shell.vault_state.is_unconfirmed(&dir));
    }

    /// Confirming the current key ends 21f's permission: a direct `regenerate_recovery` is refused after it, for a
    /// created vault and for a 21f unlock.
    #[test]
    fn confirming_the_current_key_revokes_the_permission() {
        let ts = TestShell::new();
        let refused = ShellError::InvalidInput {
            what: "recovery key",
        };

        // A created vault: confirming its creation key.
        let (session, generation) = ts.open_vault("Family");
        let id = registry_id(&ts, session);
        let answer = ts.shell.recovery_confirmed(session, generation, 1).unwrap();
        assert_eq!(answer.data, Confirmation::Confirmed);
        let before = headers(&folder_of(&ts, session));
        let direct = heavy(|| ts.shell.regenerate_recovery(session, generation));
        assert_eq!(direct.err(), Some(refused));
        assert_eq!(headers(&folder_of(&ts, session)), before);

        // A 21f unlock: a key made in its step, then confirmed.
        ts.shell
            .vault_state
            .mark_unconfirmed(&folder_of(&ts, session))
            .unwrap();
        ts.shell.sessions.lock_all(LockReason::Manual);
        let view = heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(PW))).unwrap();
        assert!(view.data.recovery_unconfirmed);
        let key = heavy(|| ts.shell.regenerate_recovery(view.session, view.generation)).unwrap();
        let answer = ts
            .shell
            .recovery_confirmed(view.session, view.generation, key.data.issue)
            .unwrap();
        assert_eq!(answer.data, Confirmation::Confirmed);
        let direct = heavy(|| ts.shell.regenerate_recovery(view.session, view.generation));
        assert_eq!(direct.err(), Some(refused));
    }

    /// 21c's direct key is the new vault's alone: another vault's session, unlocked beside it, has no permission.
    #[test]
    fn a_direct_regenerate_during_21c_is_allowed_only_for_the_new_vault() {
        let ts = TestShell::new();
        let (id, dir, _) = registered(&ts);
        let existing = heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(PW))).unwrap();
        let (new_session, new_generation) = ts.open_vault("Work");
        let before = on_disk(&ts, &dir);
        let refused = heavy(|| {
            ts.shell
                .regenerate_recovery(existing.session, existing.generation)
        });
        assert_eq!(
            refused.err(),
            Some(ShellError::InvalidInput {
                what: "recovery key"
            })
        );
        assert_eq!(on_disk(&ts, &dir), before);
        assert!(heavy(|| ts.shell.regenerate_recovery(new_session, new_generation)).is_ok());
        // The new vault's confirmation does not reach the other one's session, nor the other way round.
        assert_eq!(
            ts.shell
                .recovery_confirmed(existing.session, existing.generation, 1)
                .unwrap()
                .data,
            Confirmation::Superseded
        );
    }

    /// The creation key is numbered 1, on an ordinary create and on one that asked about a cloud folder first.
    #[test]
    fn creation_answers_its_keys_issue() {
        let ts = TestShell::new();
        let created =
            done(heavy(|| ts.shell.create_vault("Family".into(), secret(PW), false)).unwrap());
        assert_eq!(created.data.issue, 1);
        let json = serde_json::to_value(&created).unwrap();
        assert_eq!(json["data"]["issue"], 1);
        assert_eq!(
            ts.shell
                .recovery_confirmed(created.session, created.generation, created.data.issue)
                .unwrap()
                .data,
            Confirmation::Confirmed
        );

        let synced = ts.folder("synced");
        ts.volumes.add_sync_root(&synced);
        ts.dialogs.answer(Some(synced));
        let asked = ts.shell.create_vault("Work".into(), secret(PW), true);
        let Ok(Outcome::Confirm(Confirm::CloudFolder { token, .. })) = asked else {
            panic!("a cloud folder asks first");
        };
        let confirmed = done(heavy(|| ts.shell.create_vault_confirm(&token)).unwrap());
        assert_eq!(confirmed.data.issue, 1);
        assert_eq!(
            serde_json::to_value(&confirmed).unwrap()["data"]["issue"],
            1
        );
        // And its 21c retries are allowed: this key is the next one.
        let retry = heavy(|| {
            ts.shell
                .regenerate_recovery(confirmed.session, confirmed.generation)
        });
        assert_eq!(retry.unwrap().data.issue, 2);
    }

    /// The mark cannot be written: neither header changes, for both commands. (A vault in 21f has the mark already, so
    /// the state file is made to lose it first, as a program deleting or rewriting the file would.)
    #[test]
    fn no_mark_written_means_no_header_change() {
        let ts = TestShell::new();
        let (confirmed, confirmed_generation) = confirmed_session(&ts, "Family");
        let (creating, creating_generation) = ts.open_vault("Work");
        let (confirmed_dir, creating_dir) = (folder_of(&ts, confirmed), folder_of(&ts, creating));
        let before = (headers(&confirmed_dir), headers(&creating_dir));
        let reached = Rc::new(Cell::new(false));
        let watch_headers = || {
            let seen = Rc::clone(&reached);
            failpoint::observe(
                "write_headers.before_first",
                Box::new(move || seen.set(true)),
            );
        };
        watch_headers();
        let both = |ts: &TestShell| {
            (
                heavy(|| {
                    ts.shell
                        .new_recovery_key(confirmed, confirmed_generation, secret(PW))
                        .map(|_| ())
                }),
                heavy(|| {
                    ts.shell
                        .regenerate_recovery(creating, creating_generation)
                        .map(|_| ())
                }),
            )
        };

        // The write fails.
        fs::remove_file(&ts.shell.paths.vault_state).unwrap();
        failpoint::arm("atomic_write.before_replace");
        let (key, direct) = both(&ts);
        failpoint::disarm_all();
        watch_headers();
        assert!(matches!(key.err(), Some(ShellError::Core(view)) if view.kind == "io"));
        assert!(matches!(direct.err(), Some(ShellError::Core(view)) if view.kind == "io"));
        assert!(!reached.get());
        assert_eq!((headers(&confirmed_dir), headers(&creating_dir)), before);

        // The note would not fit.
        let seed = nearly_full_state(&ts);
        let (key, direct) = both(&ts);
        let too_large = Some(ShellError::TooLarge {
            what: "vault state",
        });
        assert_eq!(key.err(), too_large);
        assert_eq!(direct.err(), too_large);
        assert!(!reached.get());
        assert_eq!((headers(&confirmed_dir), headers(&creating_dir)), before);
        assert_eq!(
            fs::read_to_string(&ts.shell.paths.vault_state).unwrap(),
            seed
        );
        failpoint::disarm_all();
    }

    /// A stale generation, a foreign session and a read-only copy: no key, no password change, no mark.
    #[test]
    fn change_password_and_new_recovery_key_refused_stale_foreign_and_read_only() {
        let ts = TestShell::new();
        let (session, generation) = confirmed_session(&ts, "Family");
        let dir = folder_of(&ts, session);
        let before = on_disk(&ts, &dir);
        type Command = fn(&TestShell, SessionId, u64) -> ShellResult<()>;
        let commands: [(&str, Command); 3] = [
            ("change_password", |ts, session, generation| {
                heavy(|| {
                    ts.shell
                        .change_password(session, generation, secret(PW), secret(NEW_PW))
                })
                .map(|_| ())
            }),
            ("new_recovery_key", |ts, session, generation| {
                heavy(|| ts.shell.new_recovery_key(session, generation, secret(PW))).map(|_| ())
            }),
            ("regenerate_recovery", |ts, session, generation| {
                heavy(|| ts.shell.regenerate_recovery(session, generation)).map(|_| ())
            }),
        ];
        for (name, command) in commands {
            assert_eq!(
                command(&ts, session, generation + 1).err(),
                Some(ShellError::Locked),
                "{name}"
            );
            assert_eq!(
                command(&ts, SessionId(session.0 + 100), generation).err(),
                Some(ShellError::NotFound),
                "{name}"
            );
            assert_eq!(on_disk(&ts, &dir), before, "{name}");
        }

        // A read-only copy: refused, and nothing is written for it or anything else.
        let backup = ts.folder("Backups").join("Family.petalock-backup");
        ts.dialogs.answer(Some(backup.clone()));
        done(
            heavy(|| ts.shell.backup_vault(session, generation, 1))
                .unwrap()
                .data,
        );
        ts.shell.sessions.lock_all(LockReason::Manual);
        let credential = super::super::backup::CredentialArg::Password(secret(PW));
        let copy = ts.open_backup_read_only(&backup, credential);
        assert!(copy.data.read_only);
        let before = on_disk(&ts, &dir);
        for (name, command) in commands {
            assert_eq!(
                command(&ts, copy.session, copy.generation).err(),
                Some(ShellError::ReadOnly),
                "{name}"
            );
        }
        assert_eq!(on_disk(&ts, &dir), before);

        // A session that has locked since.
        for (name, command) in commands {
            assert_eq!(
                command(&ts, session, generation).err(),
                Some(ShellError::Locked),
                "{name}"
            );
        }
        assert_eq!(on_disk(&ts, &dir), before);
    }

    /// The commands that run Argon2 are `async` and hand their work to the blocking pool, never doing it on the
    /// async runtime. (A Tauri test app cannot run a command inside this test program, so this reads the commands'
    /// own source.)
    #[test]
    fn change_password_and_new_recovery_key_run_on_the_blocking_pool() {
        let source = include_str!("vaults.rs");
        for (name, method) in [
            ("change_password", "shell.change_password("),
            ("new_recovery_key", "shell.new_recovery_key("),
            ("regenerate_recovery", "shell.regenerate_recovery("),
            ("recovery_confirmed", "shell.recovery_confirmed("),
            ("rename_vault", "shell.rename_vault("),
            ("forget_vault", "shell.forget_vault("),
            ("show_vault_in_explorer", "shell.show_vault_in_explorer("),
            ("unlock_vault", "shell.unlock_vault("),
            ("recover_check", "shell.recover_check("),
            ("recover_finish", "shell.recover_finish("),
            ("recover_forget", "shell.recover_forget("),
        ] {
            let start = source
                .find(&format!("pub(super) async fn {name}("))
                .unwrap_or_else(|| panic!("{name} is an async command"));
            let end = start + source[start..].find("\n}\n").expect("the command ends");
            let command = &source[start..end];
            assert!(
                source[..start].trim_end().ends_with("#[tauri::command]"),
                "{name} is a command"
            );
            let blocking = command
                .find("blocking(")
                .unwrap_or_else(|| panic!("{name} uses the pool"));
            let call = command
                .find(method)
                .unwrap_or_else(|| panic!("{name} calls its method"));
            assert!(
                blocking < call,
                "{name}: the method runs inside the pool's closure"
            );
            assert!(command.contains(".await"), "{name} awaits the pool");
        }
    }

    /// Through the bridge: each request's fields (and nothing else), and each answer's JSON.
    #[test]
    fn new_key_view_and_change_password_json_shapes() {
        // The requests: every field named, the secrets as strings, nothing more allowed.
        refuses_a_path::<ChangePassword>(
            json!({ "session": 7, "generation": 3, "current_password": PW, "new_password": NEW_PW }),
        );
        refuses_a_path::<NewRecoveryKey>(
            json!({ "session": 7, "generation": 3, "current_password": PW }),
        );
        refuses_a_path::<RecoveryConfirmed>(json!({ "session": 7, "generation": 3, "issue": 2 }));
        // A change without the current password, or a confirmation without the key's number, is no request.
        for body in [
            json!({ "session": 7, "generation": 3, "new_password": NEW_PW }),
            json!({ "session": 7, "generation": 3, "current_password": PW }),
        ] {
            assert_eq!(
                parse::<ChangePassword>(&InvokeBody::Json(body)).err(),
                Some(MALFORMED)
            );
        }
        assert_eq!(
            parse::<NewRecoveryKey>(&InvokeBody::Json(json!({ "session": 7, "generation": 3 })))
                .err(),
            Some(MALFORMED)
        );
        assert_eq!(
            parse::<RecoveryConfirmed>(&InvokeBody::Json(json!({ "session": 7, "generation": 3 })))
                .err(),
            Some(MALFORMED)
        );

        // The answers.
        let words = "alpha bravo charlie";
        let key = Tagged {
            session: SessionId(7),
            generation: 3,
            data: NewKeyView {
                words: secret(words),
                issue: 4,
            },
        };
        assert_eq!(
            serde_json::to_string(&key).unwrap(),
            r#"{"session":7,"generation":3,"data":{"words":"alpha bravo charlie","issue":4}}"#
        );
        let changed = Tagged {
            session: SessionId(7),
            generation: 3,
            data: (),
        };
        assert_eq!(
            serde_json::to_string(&changed).unwrap(),
            r#"{"session":7,"generation":3,"data":null}"#
        );
        // The refusals: a wrong current password is the existing one, and an overtaken change names its vault.
        assert_eq!(
            serde_json::to_value(wrong_password()).unwrap(),
            json!({ "code": "core", "kind": "wrong_password" })
        );
        assert_eq!(
            serde_json::to_value(ShellError::LockedAfterChange {
                what: "recovery key",
                vault: 2
            })
            .unwrap(),
            json!({ "code": "locked_after_change", "what": "recovery key", "vault": 2 })
        );
        // The creation answer carries the key's number beside the key, and the registry ID the vault was listed under.
        let info = SessionInfo {
            session: SessionId(7),
            generation: 3,
            name: "Family".to_owned(),
            read_only: false,
            state: SessionState::Unlocked,
            kind: SessionKind::Vault,
        };
        let created = Outcome::Done(Tagged {
            session: SessionId(7),
            generation: 3,
            data: CreatedView {
                info,
                recovery_key: secret(words),
                issue: 1,
                vault_id: 4,
            },
        });
        assert_eq!(
            serde_json::to_value(&created).unwrap(),
            json!({ "Done": { "session": 7, "generation": 3, "data": {
                "info": {
                    "session": 7,
                    "generation": 3,
                    "name": "Family",
                    "read_only": false,
                    "state": "unlocked",
                    "kind": "vault"
                },
                "recovery_key": words,
                "issue": 1,
                "vault_id": 4
            } } })
        );
        // A create a lock overtook names the vault it made.
        assert_eq!(
            serde_json::to_value(ShellError::LockedAfterChange {
                what: "vault created",
                vault: 4
            })
            .unwrap(),
            json!({ "code": "locked_after_change", "what": "vault created", "vault": 4 })
        );
    }

    // ---- Rename a vault (Plan 4C, Task 8) ----

    /// `vault`, opened through the engine, as the shell's writable session at its folder (listed or not).
    fn session_over(ts: &TestShell, vault: Vault) -> (SessionId, u64) {
        let location = Location::folder(vault.dir()).unwrap();
        let opened = ts.shell.sessions.open(Some(location.clone()), None, |_| {
            Ok(OpenStep::Session(location, Opened::Writable(vault), ()))
        });
        let Ok(Outcome::Done(tagged)) = opened else {
            panic!("the session did not open");
        };
        (tagged.session, tagged.generation)
    }

    /// Edits `vault.json` alone, outside Petalock.
    fn edit_main(dir: &Path, edit: impl FnOnce(&mut lockbox_core::internals::header::VaultHeader)) {
        let mut header = parse_header(&fs::read(dir.join(HEADER_FILE)).unwrap()).unwrap();
        edit(&mut header);
        fs::write(dir.join(HEADER_FILE), serialize_header(&header)).unwrap();
    }

    fn rename(
        ts: &TestShell,
        session: SessionId,
        generation: u64,
        name: &str,
    ) -> ShellResult<Tagged<()>> {
        ts.shell.rename_vault(session, generation, name.to_owned())
    }

    /// The name the vault list shows for the vault `id` (read from its header).
    fn listed_name(ts: &TestShell, id: u32) -> Option<String> {
        let entries = ts.shell.registry.list().unwrap();
        entries.into_iter().find(|e| e.id == id).unwrap().name
    }

    /// The name the session list shows for `session`, and its state.
    fn session_line(ts: &TestShell, session: SessionId) -> (String, SessionState) {
        let info = ts
            .shell
            .sessions
            .list()
            .into_iter()
            .find(|info| info.session == session)
            .expect("the session is listed");
        (info.name, info.state)
    }

    /// A stale generation, a foreign session and a read-only copy: no rename, and no header written. The session's
    /// gate comes before the name is looked at, so a refused session is never told about a bad name.
    #[test]
    fn rename_vault_refused_stale_foreign_and_read_only() {
        let ts = TestShell::new();
        let (session, generation) = confirmed_session(&ts, "Family");
        let dir = folder_of(&ts, session);
        let before = on_disk(&ts, &dir);
        for name in ["Renamed", "   "] {
            assert_eq!(
                rename(&ts, session, generation + 1, name).err(),
                Some(ShellError::Locked),
                "{name:?}"
            );
            assert_eq!(
                rename(&ts, SessionId(session.0 + 100), generation, name).err(),
                Some(ShellError::NotFound),
                "{name:?}"
            );
            assert_eq!(on_disk(&ts, &dir), before, "{name:?}");
        }
        assert_eq!(session_line(&ts, session).0, "Family");

        // A read-only copy: refused, and nothing is written for it or anything else.
        let backup = ts.folder("Backups").join("Family.petalock-backup");
        ts.dialogs.answer(Some(backup.clone()));
        done(
            heavy(|| ts.shell.backup_vault(session, generation, 1))
                .unwrap()
                .data,
        );
        ts.shell.sessions.lock_all(LockReason::Manual);
        let credential = super::super::backup::CredentialArg::Password(secret(PW));
        let copy = ts.open_backup_read_only(&backup, credential);
        assert!(copy.data.read_only);
        // (The backup noted its date in the state file: what a refused rename must leave alone is what is there now.)
        let before = on_disk(&ts, &dir);
        for name in ["Renamed", "   "] {
            assert_eq!(
                rename(&ts, copy.session, copy.generation, name).err(),
                Some(ShellError::ReadOnly),
                "{name:?}"
            );
        }
        assert_eq!(on_disk(&ts, &dir), before);

        // A session that has locked since.
        assert_eq!(
            rename(&ts, session, generation, "Renamed").err(),
            Some(ShellError::Locked)
        );
        assert_eq!(on_disk(&ts, &dir), before);
        assert_eq!(read_vault_name(&dir).unwrap(), "Family");
    }

    /// Each request's fields (and nothing else), and each answer and refusal as the page reads it.
    #[test]
    fn rename_json_shapes() {
        refuses_a_path::<RenameVault>(json!({ "session": 7, "generation": 3, "name": "Family" }));
        // No name, a name that is not text, a missing session or generation, or an extra field: no request.
        for body in [
            json!({ "session": 7, "generation": 3 }),
            json!({ "session": 7, "generation": 3, "name": 5 }),
            json!({ "session": 7, "generation": 3, "name": null }),
            json!({ "generation": 3, "name": "Family" }),
            json!({ "session": 7, "name": "Family" }),
            json!({ "session": "7", "generation": 3, "name": "Family" }),
            json!({ "session": 7, "generation": 3, "name": "Family", "password": PW }),
        ] {
            assert_eq!(
                parse::<RenameVault>(&InvokeBody::Json(body.clone())).err(),
                Some(MALFORMED),
                "{body}"
            );
        }
        let Ok(RenameVault {
            session,
            generation,
            name,
        }) = parse::<RenameVault>(&InvokeBody::Json(
            json!({ "session": 7, "generation": 3, "name": "Family" }),
        ))
        else {
            panic!("a whole request is read");
        };
        assert_eq!(
            (session, generation, name.as_str()),
            (SessionId(7), 3, "Family")
        );

        // Row 16: success.
        let renamed = Tagged {
            session: SessionId(7),
            generation: 3,
            data: (),
        };
        assert_eq!(
            serde_json::to_string(&renamed).unwrap(),
            r#"{"session":7,"generation":3,"data":null}"#
        );
        // Rows 2 to 5: the session gate.
        for (error, wire) in [
            (ShellError::NotFound, json!({ "code": "not_found" })),
            (ShellError::Locked, json!({ "code": "locked" })),
            (ShellError::ReadOnly, json!({ "code": "read_only" })),
            (
                ShellError::Busy {
                    what: "operation in progress",
                },
                json!({ "code": "busy", "what": "operation in progress" }),
            ),
            // Row 7: a name the engine won't keep.
            (
                CoreError::InvalidInput { what: "vault name" }.into(),
                json!({ "code": "core", "kind": "invalid_input", "what": "vault name" }),
            ),
            // Rows 8 to 11: the backup's four refusals.
            (
                ShellError::InvalidInput {
                    what: "details changed",
                },
                json!({ "code": "invalid_input", "what": "details changed" }),
            ),
            (
                ShellError::InvalidInput {
                    what: "details unchecked",
                },
                json!({ "code": "invalid_input", "what": "details unchecked" }),
            ),
            (
                ShellError::InvalidInput {
                    what: "password copies disagree",
                },
                json!({ "code": "invalid_input", "what": "password copies disagree" }),
            ),
            (
                ShellError::InvalidInput {
                    what: "recovery key copies disagree",
                },
                json!({ "code": "invalid_input", "what": "recovery key copies disagree" }),
            ),
            // Row 12: a header too big to write.
            (
                CoreError::TooLarge {
                    what: "vault header",
                }
                .into(),
                json!({ "code": "core", "kind": "too_large", "what": "vault header" }),
            ),
            // Row 14: a lock overtook a rename that landed.
            (
                ShellError::LockedAfterChange {
                    what: "vault name",
                    vault: 2,
                },
                json!({ "code": "locked_after_change", "what": "vault name", "vault": 2 }),
            ),
        ] {
            assert_eq!(serde_json::to_value(error).unwrap(), wire);
        }
    }

    /// A rename shows in the vault's header (both files), the vault list, the session list (locked or not), and
    /// nowhere else: the folder keeps its name and a second vault of the same name keeps its.
    #[test]
    fn rename_vault_changes_the_vault_it_was_asked_for() {
        let ts = TestShell::new();
        let (first, _) = confirmed_session(&ts, "Family");
        let (second, second_generation) = confirmed_session(&ts, "Family");
        let (first_dir, second_dir) = (folder_of(&ts, first), folder_of(&ts, second));
        assert_ne!(first_dir, second_dir);
        let (first_id, second_id) = (registry_id(&ts, first), registry_id(&ts, second));
        let first_before = headers(&first_dir);

        let answer = rename(&ts, second, second_generation, "Work").unwrap();
        assert_eq!(
            serde_json::to_value(&answer).unwrap(),
            json!({ "session": second.0, "generation": second_generation, "data": null })
        );
        let (main, bak) = headers(&second_dir);
        assert_eq!(main, bak, "both header files");
        assert_eq!(read_vault_name(&second_dir).unwrap(), "Work");
        assert_eq!(parse_header(&bak).unwrap().name, "Work", "the spare too");
        assert_eq!(listed_name(&ts, second_id).as_deref(), Some("Work"));
        assert_eq!(
            session_line(&ts, second),
            ("Work".to_owned(), SessionState::Unlocked)
        );
        assert_eq!(
            folder_of(&ts, second),
            second_dir,
            "the folder keeps its name"
        );
        assert!(second_dir.is_dir());

        // The other vault, called the same before, is untouched everywhere.
        assert_eq!(headers(&first_dir), first_before);
        assert_eq!(listed_name(&ts, first_id).as_deref(), Some("Family"));
        assert_eq!(
            session_line(&ts, first),
            ("Family".to_owned(), SessionState::Unlocked)
        );

        // A lock keeps the name; so does an unlock (it reads the header).
        ts.shell.sessions.lock_all(LockReason::Manual);
        assert_eq!(
            session_line(&ts, second),
            ("Work".to_owned(), SessionState::Locked)
        );
        let again = heavy(|| ts.shell.unlock_vault(ts.vault(second_id), secret(PW))).unwrap();
        assert_eq!(again.data.info.name, "Work");
    }

    /// Rows 7 to 11, each from a real engine state: nothing is written, the session keeps its name, and the answer is
    /// the page's key. The name's own refusal comes first.
    #[test]
    fn rename_vault_says_which_case_for_each_engine_refusal() {
        let ts = TestShell::new();
        let wire = |error: ShellError| serde_json::to_value(error).unwrap();
        let refused = |ts: &TestShell, session, generation, name: &str, dir: &Path| {
            let before = headers(dir);
            let error = rename(ts, session, generation, name)
                .err()
                .expect("refused");
            assert_eq!(headers(dir), before, "nothing was written");
            assert_eq!(session_line(ts, session).0, "Family");
            error
        };

        // A header changed outside Petalock, not yet accepted.
        let (_, dir, _) = registered(&ts);
        edit_main(&dir, |h| h.name = "Changed".to_owned());
        let vault = heavy(|| Vault::unlock_with_password(&dir, PW)).unwrap().0;
        let (session, generation) = session_over(&ts, vault);
        // (the session says what it opened with: the changed header's name)
        let name_on_screen = session_line(&ts, session).0;
        assert_eq!(name_on_screen, "Changed");
        let before = headers(&dir);
        let error = rename(&ts, session, generation, "Another")
            .err()
            .expect("refused");
        assert_eq!(
            wire(error),
            json!({ "code": "invalid_input", "what": "details changed" })
        );
        assert_eq!(headers(&dir), before);
        assert_eq!(session_line(&ts, session).0, "Changed");
        let error = rename(&ts, session, generation, "  ")
            .err()
            .expect("refused");
        assert_eq!(
            wire(error),
            json!({ "code": "core", "kind": "invalid_input", "what": "vault name" })
        );
        ts.shell.sessions.lock_all(LockReason::Manual);

        // The copies disagree on the recovery key: a password unlock cannot check that slot.
        let (_, dir, _) = registered(&ts);
        edit_main(&dir, |h| h.slots[1].ciphertext[0] ^= 1);
        let vault = heavy(|| Vault::unlock_with_password(&dir, PW)).unwrap().0;
        let (session, generation) = session_over(&ts, vault);
        let error = refused(&ts, session, generation, "Another", &dir);
        assert_eq!(
            wire(error),
            json!({ "code": "invalid_input", "what": "recovery key copies disagree" })
        );
        ts.shell.sessions.lock_all(LockReason::Manual);

        // The copies disagree on the password: a recovery unlock cannot check that slot.
        let (_, dir, recovery) = registered(&ts);
        edit_main(&dir, |h| h.slots[0].ciphertext[0] ^= 1);
        let key = RecoverySecret::parse(&recovery).unwrap();
        let vault = heavy(|| Vault::unlock_with_recovery(&dir, &key)).unwrap().0;
        let (session, generation) = session_over(&ts, vault);
        let error = refused(&ts, session, generation, "Another", &dir);
        assert_eq!(
            wire(error),
            json!({ "code": "invalid_input", "what": "password copies disagree" })
        );
        ts.shell.sessions.lock_all(LockReason::Manual);

        // A failed header write left the state unknown: "details couldn't be checked".
        let (_, dir, _) = registered(&ts);
        edit_main(&dir, |h| h.slots[0].ciphertext[0] ^= 1);
        failpoint::arm("unlock.repair_write");
        let mut vault = heavy(|| Vault::unlock_with_password(&dir, PW)).unwrap().0;
        failpoint::disarm_all();
        failpoint::arm("write_headers.before_first");
        assert!(vault.change_password(NEW_PW).is_err());
        failpoint::disarm_all();
        let (session, generation) = session_over(&ts, vault);
        let error = refused(&ts, session, generation, "Another", &dir);
        assert_eq!(
            wire(error),
            json!({ "code": "invalid_input", "what": "details unchecked" })
        );
        ts.shell.sessions.lock_all(LockReason::Manual);
    }

    /// A lock that comes after everything else is checked, just before the header writes: nothing is written, the
    /// answer is `Locked`, and the session list says the old name.
    #[test]
    fn a_lock_before_the_rename_writes_changes_nothing_and_answers_locked() {
        let ts = TestShell::new();
        let (session, generation) = confirmed_session(&ts, "Family");
        let dir = folder_of(&ts, session);
        let before = headers(&dir);
        lock_at(&ts, BEFORE_HEADER_WRITES);
        let answer = rename(&ts, session, generation, "Work");
        failpoint::disarm_all();
        assert_eq!(answer.err(), Some(ShellError::Locked));
        assert_eq!(headers(&dir), before, "nothing was written");
        assert_eq!(
            session_line(&ts, session),
            ("Family".to_owned(), SessionState::Locked)
        );
        assert_eq!(read_vault_name(&dir).unwrap(), "Family");
    }

    /// A lock that comes between the two header writes: the rename is whole on disk, so the answer says it landed, for
    /// the vault it landed in, and the session list (which a lock does not empty) already says the new name.
    #[test]
    fn a_lock_after_the_rename_landed_answers_locked_after_change_with_the_vault() {
        let ts = TestShell::new();
        let (other, _) = confirmed_session(&ts, "Other");
        let (session, generation) = confirmed_session(&ts, "Family");
        let (id, other_id) = (registry_id(&ts, session), registry_id(&ts, other));
        assert_ne!(id, other_id);
        let dir = folder_of(&ts, session);
        lock_at(&ts, "write_headers.before_second");
        let answer = rename(&ts, session, generation, "Work");
        failpoint::disarm_all();
        let Err(error) = answer else {
            panic!("overtaken by the lock");
        };
        assert_eq!(
            serde_json::to_string(&error).unwrap(),
            format!(r#"{{"code":"locked_after_change","what":"vault name","vault":{id}}}"#)
        );
        let (main, bak) = headers(&dir);
        assert_eq!(main, bak, "whole on disk");
        assert_eq!(read_vault_name(&dir).unwrap(), "Work");
        assert_eq!(
            session_line(&ts, session),
            ("Work".to_owned(), SessionState::Locked)
        );
        assert_eq!(listed_name(&ts, id).as_deref(), Some("Work"));
        // The other vault was locked by the same lock and keeps its own name.
        assert_eq!(session_line(&ts, other).0, "Other");
    }

    /// A write that came back as an error after `vault.json` landed: the name is in effect (the engine made it live),
    /// so it is a success, the session is still open, and a second rename goes through. `.bak` is a version behind
    /// until the next writable unlock.
    #[test]
    fn a_rename_whose_write_failed_after_vault_json_landed_is_a_success() {
        let ts = TestShell::new();
        let (session, generation) = confirmed_session(&ts, "Family");
        let dir = folder_of(&ts, session);
        let (_, old_bak) = headers(&dir);
        failpoint::arm("write_headers.before_second");
        let answer = rename(&ts, session, generation, "Work");
        failpoint::disarm_all();
        let answer = answer.expect("the name is in effect");
        assert_eq!(
            serde_json::to_value(&answer).unwrap(),
            json!({ "session": session.0, "generation": generation, "data": null })
        );
        let (main, bak) = headers(&dir);
        assert_eq!(bak, old_bak, "the spare is one version behind");
        assert_eq!(parse_header(&main).unwrap().name, "Work");
        assert_eq!(
            session_line(&ts, session),
            ("Work".to_owned(), SessionState::Unlocked)
        );

        rename(&ts, session, generation, "Work again").unwrap();
        let (main, bak) = headers(&dir);
        assert_eq!(main, bak);
        assert_eq!(read_vault_name(&dir).unwrap(), "Work again");
    }

    /// A write that died before `vault.json` was touched: the old name is still the vault's, in the files and in the
    /// session list, and the refusal is the engine's own.
    #[test]
    fn a_rename_that_failed_before_vault_json_leaves_the_old_name() {
        let ts = TestShell::new();
        let (session, generation) = confirmed_session(&ts, "Family");
        let dir = folder_of(&ts, session);
        let before = headers(&dir);
        failpoint::arm("write_headers.before_first");
        let answer = rename(&ts, session, generation, "Work");
        failpoint::disarm_all();
        let error = answer.err().expect("the write failed");
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            json!({ "code": "core", "kind": "io" })
        );
        assert_eq!(headers(&dir), before);
        assert_eq!(
            session_line(&ts, session),
            ("Family".to_owned(), SessionState::Unlocked)
        );
        rename(&ts, session, generation, "Work").unwrap();
        assert_eq!(read_vault_name(&dir).unwrap(), "Work");
    }

    // ---- An unavailable vault keeps its name (Plan 4C, Task 9b) ----

    /// The `name` the vault list's file holds for the vault `id` (`None`: no name kept), read from the file itself.
    fn kept_name(ts: &TestShell, id: u32) -> Option<String> {
        let written: Value =
            serde_json::from_slice(&fs::read(&ts.shell.paths.registry).unwrap()).unwrap();
        let rows = written["vaults"].as_array().expect("rows");
        let row = rows.iter().find(|row| row["id"] == id).expect("listed");
        row["name"].as_str().map(str::to_owned)
    }

    /// A rename is kept by the list for that vault alone, so its row says the new name when the folder is gone, and a
    /// second vault of the same name keeps its own.
    #[test]
    fn a_rename_updates_the_kept_name() {
        let ts = TestShell::new();
        let (session, generation) = confirmed_session(&ts, "Family");
        let (other, _) = confirmed_session(&ts, "Family");
        let (id, other_id) = (registry_id(&ts, session), registry_id(&ts, other));
        assert_eq!(kept_name(&ts, id).as_deref(), Some("Family"));

        rename(&ts, session, generation, "Work").unwrap();
        assert_eq!(kept_name(&ts, id).as_deref(), Some("Work"));
        assert_eq!(kept_name(&ts, other_id).as_deref(), Some("Family"));

        // The folder goes: the row says the name it was renamed to.
        let dir = folder_of(&ts, session);
        ts.shell.sessions.lock_all(LockReason::Manual);
        fs::rename(&dir, ts.temp.path().join("moved away")).unwrap();
        let row = ts
            .shell
            .registry
            .list()
            .unwrap()
            .into_iter()
            .find(|e| e.id == id)
            .unwrap();
        assert_eq!((row.name.as_deref(), row.available), (Some("Work"), false));
    }

    /// A lock that overtook the rename after it landed: the name is in effect, so the list keeps it.
    #[test]
    fn a_rename_a_lock_overtook_after_it_landed_updates_the_kept_name() {
        let ts = TestShell::new();
        let (session, generation) = confirmed_session(&ts, "Family");
        let id = registry_id(&ts, session);
        lock_at(&ts, "write_headers.before_second");
        let answer = rename(&ts, session, generation, "Work");
        failpoint::disarm_all();
        assert!(matches!(
            answer,
            Err(ShellError::LockedAfterChange {
                what: "vault name",
                ..
            })
        ));
        assert_eq!(kept_name(&ts, id).as_deref(), Some("Work"));
    }

    /// A rename that changed nothing (refused, or a lock that came first) leaves the kept name as it was.
    #[test]
    fn a_rename_that_changed_nothing_leaves_the_kept_name() {
        let ts = TestShell::new();
        let (session, generation) = confirmed_session(&ts, "Family");
        let id = registry_id(&ts, session);
        assert!(rename(&ts, session, generation, "   ").is_err());
        failpoint::arm("write_headers.before_first");
        assert!(rename(&ts, session, generation, "Work").is_err());
        failpoint::disarm_all();
        assert_eq!(kept_name(&ts, id).as_deref(), Some("Family"));
    }

    /// A backup (a read-only session) and a copy of a vault that is not on the list have no row, so a rename leaves
    /// the list's file as it is, byte for byte, and the listed vault's kept name too.
    #[test]
    fn a_rename_of_a_backup_or_older_copy_leaves_the_list_alone() {
        let ts = TestShell::new();
        let (id, dir, _) = registered(&ts);
        let before = fs::read(&ts.shell.paths.registry).unwrap();
        assert_eq!(kept_name(&ts, id).as_deref(), Some("Family"));

        // An older copy of the vault's folder, opened as its own writable session: not on the list.
        let copy = ts.vaults().join("older copy");
        copy_folder(&dir, &copy);
        let copy = fs::canonicalize(&copy).unwrap();
        let vault = heavy(|| Vault::unlock_with_password(&copy, PW)).unwrap().0;
        let (session, generation) = session_over(&ts, vault);
        assert_eq!(ts.shell.registry_id_of(session), 0, "not listed");
        rename(&ts, session, generation, "Older").unwrap();
        assert_eq!(read_vault_name(&copy).unwrap(), "Older", "it was renamed");
        assert_eq!(fs::read(&ts.shell.paths.registry).unwrap(), before);
        ts.shell.sessions.lock_all(LockReason::Manual);

        // A backup opened read-only: the rename is refused and the list is not touched.
        let (session, generation) = confirmed_session(&ts, "Work");
        let work_id = registry_id(&ts, session);
        let backup = ts.folder("Backups").join("Work.petalock-backup");
        ts.dialogs.answer(Some(backup.clone()));
        done(
            heavy(|| ts.shell.backup_vault(session, generation, 1))
                .unwrap()
                .data,
        );
        ts.shell.sessions.lock_all(LockReason::Manual);
        let opened = ts.open_backup_read_only(
            &backup,
            super::super::backup::CredentialArg::Password(secret(PW)),
        );
        assert!(opened.data.read_only);
        let list_now = fs::read(&ts.shell.paths.registry).unwrap();
        assert_eq!(
            rename(&ts, opened.session, opened.generation, "Backup name").err(),
            Some(ShellError::ReadOnly)
        );
        assert_eq!(fs::read(&ts.shell.paths.registry).unwrap(), list_now);
        assert_eq!(kept_name(&ts, work_id).as_deref(), Some("Work"));
    }

    /// The list's file cannot be written (held, so it cannot be replaced): the rename answers as it did before, its
    /// name is in effect, the file is as it was, and the next list brings the kept name up to date.
    #[test]
    fn a_failed_name_write_changes_no_answer() {
        use std::os::windows::fs::OpenOptionsExt;

        let ts = TestShell::new();
        let (session, generation) = confirmed_session(&ts, "Family");
        let id = registry_id(&ts, session);
        let before = fs::read(&ts.shell.paths.registry).unwrap();
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&ts.shell.paths.registry)
            .unwrap();
        let answer =
            rename(&ts, session, generation, "Work").expect("a rename the list could not note");
        assert_eq!(
            serde_json::to_value(&answer).unwrap(),
            json!({ "session": session.0, "generation": generation, "data": null })
        );
        assert_eq!(
            session_line(&ts, session),
            ("Work".to_owned(), SessionState::Unlocked)
        );
        assert_eq!(read_vault_name(&folder_of(&ts, session)).unwrap(), "Work");
        // (the hold works: the write was refused)
        assert_eq!(fs::read(&ts.shell.paths.registry).unwrap(), before);
        assert_eq!(kept_name(&ts, id).as_deref(), Some("Family"));
        // A list answers the header's name all the same, and cannot write it either.
        assert_eq!(listed_name(&ts, id).as_deref(), Some("Work"));
        assert_eq!(fs::read(&ts.shell.paths.registry).unwrap(), before);

        drop(held);
        assert_eq!(listed_name(&ts, id).as_deref(), Some("Work"));
        assert_eq!(kept_name(&ts, id).as_deref(), Some("Work"), "tried again");
    }

    /// Ask 8's row: neither header copy can be read, so the vault's own name is not there, and the row says the name
    /// the list kept (the last one, after a rename).
    #[test]
    fn an_unreadable_header_shows_the_kept_name() {
        let ts = TestShell::new();
        let (session, generation) = confirmed_session(&ts, "Family");
        let id = registry_id(&ts, session);
        let dir = folder_of(&ts, session);
        rename(&ts, session, generation, "Work").unwrap();
        ts.shell.sessions.lock_all(LockReason::Manual);
        fs::write(dir.join(HEADER_FILE), b"damaged").unwrap();
        fs::write(dir.join(HEADER_BACKUP), b"damaged").unwrap();
        let row = ts
            .shell
            .registry
            .list()
            .unwrap()
            .into_iter()
            .find(|e| e.id == id)
            .unwrap();
        assert_eq!(
            (row.name.as_deref(), row.available, row.details_damaged),
            (Some("Work"), true, true)
        );
        // The unlock of such a row is still refused as before: the name is only for showing.
        assert!(heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(PW))).is_err());
    }

    // ---- Remove, Show in Explorer and unavailable vaults (Plan 4C, Task 9) ----

    fn busy() -> ShellError {
        ShellError::Busy {
            what: "operation in progress",
        }
    }

    /// A new plain folder `name` in the test's temp folder, listed as a vault (no vault is made in it: Show in Explorer
    /// and Remove look at the list and the folder only): its row and canonical folder.
    fn listed_folder(ts: &TestShell, name: &str) -> (VaultRef, PathBuf) {
        let dir = ts.folder(name);
        (ts.shell.registry.add(&dir).unwrap(), dir)
    }

    /// The row the page would send for the vault an open session holds.
    fn row_of(ts: &TestShell, session: SessionId) -> VaultRef {
        ts.vault(registry_id(ts, session))
    }

    /// One entry of [`tree`]: the path under the folder, whether it is a folder, its bytes, and its two times.
    type Node = (PathBuf, bool, Vec<u8>, SystemTime, SystemTime);

    /// Every file and folder under `root`, with each file's bytes and each one's modified and created times.
    fn tree(root: &Path) -> Vec<Node> {
        fn walk(dir: &Path, root: &Path, out: &mut Vec<Node>) {
            let mut paths: Vec<_> = fs::read_dir(dir)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect();
            paths.sort();
            for path in paths {
                let meta = fs::symlink_metadata(&path).unwrap();
                let (modified, created) = (meta.modified().unwrap(), meta.created().unwrap());
                let relative = path.strip_prefix(root).unwrap().to_path_buf();
                let bytes = match meta.is_dir() {
                    true => Vec::new(),
                    false => fs::read(&path).unwrap(),
                };
                out.push((relative, meta.is_dir(), bytes, modified, created));
                if meta.is_dir() {
                    walk(&path, root, out);
                }
            }
        }
        let mut found = Vec::new();
        walk(root, root, &mut found);
        found
    }

    /// An ID a Remove took off the list is never given to another vault, so a row the page still holds for the old
    /// one can never act on the new one (Show in Explorer opening the wrong folder, Remove taking the wrong vault off).
    #[test]
    fn a_removed_vaults_id_is_never_given_to_another() {
        let ts = TestShell::new();
        let (first, first_dir) = listed_folder(&ts, "First");
        let (second, _) = listed_folder(&ts, "Second");
        assert_eq!((first.id, second.id), (1, 2));
        ts.shell.forget_vault(second).unwrap();

        let (third, third_dir) = listed_folder(&ts, "Third");
        assert_eq!(third.list, second.list, "the same list");
        assert_ne!(third.id, second.id, "the highest ID was not given again");
        assert_eq!(third.id, 3);

        // The row the page still holds for the removed vault names nothing: not Show, not Remove, not an unlock.
        assert_eq!(
            ts.shell.show_vault_in_explorer(second),
            Err(ShellError::NotFound)
        );
        assert_eq!(ts.shell.forget_vault(second), Err(ShellError::NotFound));
        assert_eq!(
            ts.shell.unlock_vault(second, secret(PW)).err(),
            Some(ShellError::NotFound)
        );
        assert!(ts.launcher.opened_folders().is_empty(), "nothing was shown");
        assert_eq!(
            ts.shell.registry.entries(),
            vec![(1, first_dir), (3, third_dir.clone())],
            "the stale Remove took nothing off"
        );

        // The new vault's own row works.
        ts.shell.show_vault_in_explorer(third).unwrap();
        assert_eq!(ts.launcher.opened_folders(), vec![third_dir]);
    }

    /// Ask 12's "Start a new list": IDs start at 1 again, so only the list's identity tells a row of the old list from
    /// a vault added back on the new one in the same launch.
    #[test]
    fn a_row_from_before_a_new_list_is_refused() {
        let ts = TestShell::new();
        let (old, dir) = listed_folder(&ts, "Family");
        assert_eq!(old.id, 1);
        // The list is damaged, and started over.
        fs::write(&ts.shell.paths.registry, b"{ damaged").unwrap();
        assert!(ts.shell.registry.list().is_err());
        ts.shell.registry.start_new_list().unwrap();
        // The same folder is added back: ID 1 again, on a new list.
        let new = ts.shell.registry.add(&dir).unwrap();
        assert_eq!(new.id, old.id, "the new list starts at 1 again");
        assert_ne!(new.list, old.list, "under a new identity");

        assert_eq!(
            ts.shell.show_vault_in_explorer(old),
            Err(ShellError::NotFound)
        );
        assert_eq!(ts.shell.forget_vault(old), Err(ShellError::NotFound));
        assert_eq!(
            ts.shell.unlock_vault(old, secret(PW)).err(),
            Some(ShellError::NotFound)
        );
        let check = ts.shell.recover_check(old, secret("x")).err();
        assert_eq!(check, Some(ShellError::NotFound));
        assert!(ts.launcher.opened_folders().is_empty());
        assert_eq!(
            ts.shell.registry.entries(),
            vec![(1, dir.clone())],
            "the vault on the new list is still there"
        );

        ts.shell.show_vault_in_explorer(new).unwrap();
        assert_eq!(ts.launcher.opened_folders(), vec![dir]);
        ts.shell.forget_vault(new).unwrap();
        assert!(ts.shell.registry.entries().is_empty());
    }

    /// A listed path may be tampered with: one that names a program (a file), or a link or junction, is never handed to
    /// the launcher; only a plain folder is.
    #[test]
    fn show_vault_in_explorer_opens_only_a_folder() {
        let ts = TestShell::new();
        let (folder, dir) = listed_folder(&ts, "Family");

        // A listed path that names a program.
        let program = dir.join("run.exe");
        fs::write(&program, b"MU-not a program").unwrap();
        let program_row = ts.shell.registry.add(&program).unwrap();
        // A listed path that is a junction to a folder.
        let link = ts.vaults().join("a-link");
        make_dir_link(&link, &dir);
        let via_link = fs::canonicalize(ts.vaults()).unwrap().join("a-link");
        let link_row = ts.shell.registry.add(&via_link).unwrap();
        assert!(
            fs::symlink_metadata(&via_link)
                .unwrap()
                .file_type()
                .is_symlink(),
            "the junction is the kind of link the check must refuse"
        );
        let refused = Err(ShellError::InvalidInput { what: "folder" });
        assert_eq!(ts.shell.show_vault_in_explorer(program_row), refused);
        assert_eq!(ts.shell.show_vault_in_explorer(link_row), refused);
        assert_eq!(
            ts.launcher.opened_folders(),
            Vec::<PathBuf>::new(),
            "the launcher was never given either"
        );

        // A folder that is not there: not found, and nothing opened.
        let (gone, gone_dir) = listed_folder(&ts, "Gone");
        fs::remove_dir(&gone_dir).unwrap();
        assert_eq!(
            ts.shell.show_vault_in_explorer(gone),
            Err(ShellError::NotFound)
        );
        assert!(ts.launcher.opened_folders().is_empty());

        // A plain folder is handed over, once, as listed.
        assert_eq!(ts.shell.show_vault_in_explorer(folder), Ok(()));
        assert_eq!(ts.launcher.opened_folders(), vec![dir.clone()]);

        // Explorer that cannot start: the engine's `io` answer, nothing else.
        ts.launcher.fail_next_folder();
        let failed = ts.shell.show_vault_in_explorer(folder).err().unwrap();
        assert_eq!(
            serde_json::to_value(failed).unwrap(),
            json!({ "code": "core", "kind": "io" })
        );
    }

    /// The request names a row, never a path: an old `{ id }` body, a path beside the row or inside it, and a list or
    /// ID that is not a whole number are all the fixed refusal.
    #[test]
    fn show_vault_in_explorer_takes_an_id_never_a_path() {
        refuses_a_path::<VaultArg>(json!({ "vault": { "list": 7, "id": 1 } }));
        let bodies = [
            json!({ "id": 1 }),
            json!({ "vault": { "list": 7, "id": 1, "path": "SENTINEL-7f3a" } }),
            json!({ "vault": { "list": 7, "id": 1 }, "path": "SENTINEL-7f3a" }),
            json!({ "vault": { "list": "7", "id": 1 } }),
            json!({ "vault": { "list": 7, "id": "1" } }),
            json!({ "vault": { "list": 7.5, "id": 1 } }),
            json!({ "vault": { "list": -7, "id": 1 } }),
            json!({ "vault": { "list": 7, "id": 4294967296u64 } }),
            json!({ "vault": { "list": 7 } }),
            json!({ "vault": { "id": 1 } }),
            json!({ "vault": 7 }),
            json!({ "vault": null }),
            json!({}),
        ];
        let mut refused = 0;
        for body in &bodies {
            assert_eq!(
                parse::<VaultArg>(&InvokeBody::Json(body.clone())).err(),
                Some(MALFORMED),
                "{body}"
            );
            refused += 1;
        }
        assert_eq!(refused, bodies.len());
        let Ok(VaultArg { vault }) = parse::<VaultArg>(&InvokeBody::Json(
            json!({ "vault": { "list": 9007199254740991u64, "id": 4 } }),
        )) else {
            panic!("a whole row is read");
        };
        assert_eq!(
            vault,
            VaultRef {
                list: 9_007_199_254_740_991,
                id: 4
            }
        );
    }

    /// Two vaults with the same name: each row opens its own folder.
    #[test]
    fn show_vault_in_explorer_names_the_right_folder_for_two_vaults_named_alike() {
        let ts = TestShell::new();
        let (first, first_dir, _) = registered_as(&ts, "Family");
        let (second, second_dir, _) = registered_as(&ts, "Family");
        assert_ne!(first_dir, second_dir);
        let names = ts.shell.registry.list().unwrap();
        assert_eq!(names[0].name, names[1].name, "named alike");

        ts.shell.show_vault_in_explorer(ts.vault(second)).unwrap();
        ts.shell.show_vault_in_explorer(ts.vault(first)).unwrap();
        assert_eq!(
            ts.launcher.opened_folders(),
            vec![second_dir, first_dir],
            "the exact listed folder of each"
        );
    }

    /// Remove writes only `vaults.json`: the folder's every file (bytes and times) and the shell's notes about the
    /// vault are as they were, and the vault can be added back and opened.
    #[test]
    fn remove_leaves_the_folder_untouched() {
        let ts = TestShell::new();
        let (id, dir, _) = registered(&ts);
        // An unlock writes in the folder (the cleanup, `.lock`), and a mark is noted: both are done before the snapshot.
        let opened = heavy(|| ts.shell.unlock_vault(ts.vault(id), secret(PW))).unwrap();
        ts.shell
            .vault_state
            .mark_unconfirmed(&dir)
            .expect("a note about the vault");
        ts.shell.sessions.lock(opened.session, LockReason::Manual);
        assert!(is_free(&dir));
        let before = tree(&dir);
        assert!(
            before
                .iter()
                .any(|(path, folder, bytes, ..)| path == Path::new("vault.json")
                    && !folder
                    && !bytes.is_empty()),
            "the snapshot holds the vault's files"
        );
        let state = fs::read(&ts.shell.paths.vault_state).unwrap();
        let list_before = fs::read(&ts.shell.paths.registry).unwrap();

        assert_eq!(ts.shell.forget_vault(ts.vault(id)), Ok(()));

        assert_eq!(tree(&dir), before, "every file's bytes and times");
        assert_eq!(fs::read(&ts.shell.paths.vault_state).unwrap(), state);
        assert_ne!(fs::read(&ts.shell.paths.registry).unwrap(), list_before);
        assert!(ts.shell.registry.entries().is_empty());
        assert!(ts.shell.registry.list().unwrap().is_empty());

        // Added back (as 26a does): a new ID on the same list, and it still opens with its password.
        ts.dialogs.answer(Some(dir.clone()));
        let entry = done(ts.shell.add_existing_vault().unwrap());
        assert_eq!(entry.name.as_deref(), Some("Family"));
        assert_ne!(entry.id, id, "an ID is not given twice");
        let again = heavy(|| {
            ts.shell.unlock_vault(
                VaultRef {
                    list: entry.list,
                    id: entry.id,
                },
                secret(PW),
            )
        })
        .unwrap();
        assert_eq!(again.data.info.name, "Family");
    }

    /// Remove locks an open vault first (the person's own lock, its event before the list is written), changes no other
    /// session, and takes the vault off the list.
    #[test]
    fn remove_an_open_vault_locks_it_first_and_leaves_the_others_open() {
        let ts = TestShell::new();
        let (family, family_generation) = confirmed_session(&ts, "Family");
        let (work, work_generation) = confirmed_session(&ts, "Work");
        let (family_dir, work_dir) = (folder_of(&ts, family), folder_of(&ts, work));
        let row = row_of(&ts, family);
        let family_headers = headers(&family_dir);

        // What the world looks like at the moment the list is about to be written.
        type Seen = (Option<SessionState>, Option<SessionState>, usize, usize);
        let seen: Rc<RefCell<Option<Seen>>> = Rc::default();
        {
            let (shell, events, seen) =
                (Arc::clone(&ts.shell), Arc::clone(&ts.events), seen.clone());
            failpoint::observe(
                REMOVING,
                Box::new(move || {
                    let state = |id: SessionId| {
                        shell
                            .sessions
                            .list()
                            .into_iter()
                            .find(|info| info.session == id)
                            .map(|info| info.state)
                    };
                    let locks = events.locked();
                    *seen.borrow_mut() = Some((
                        state(family),
                        state(work),
                        locks.len(),
                        shell.registry.entries().len(),
                    ));
                    assert_eq!(locks, [(family, family_generation + 1, LockReason::Manual)]);
                }),
            );
        }
        let removed = ts.shell.forget_vault(row);
        failpoint::disarm_all();
        assert_eq!(removed, Ok(()));
        assert_eq!(
            *seen.borrow(),
            Some((
                Some(SessionState::Locked),
                Some(SessionState::Unlocked),
                1,
                2
            )),
            "locked first, with its event out, the list not yet written, the other vault untouched"
        );

        // Afterwards: off the list, the folder and its header as they were, the lock released.
        assert_eq!(ts.shell.registry.entries().len(), 1);
        assert_eq!(registry_id(&ts, work), 2);
        assert_eq!(headers(&family_dir), family_headers);
        assert!(is_free(&family_dir));
        // The vault that stays is open and working; the removed one answers `Locked` to its old generation.
        assert!(!is_free(&work_dir));
        assert!(
            ts.shell
                .sessions
                .read(work, work_generation, |_, _| Ok(()))
                .is_ok()
        );
        assert_eq!(
            ts.shell
                .sessions
                .read(family, family_generation, |_, _| Ok(()))
                .err(),
            Some(ShellError::Locked)
        );
        assert_eq!(ts.events.locked().len(), 1, "no other lock was sent");
    }

    /// A job of the vault's session running: Remove is `Busy` and changes nothing; once the job ends it goes through.
    /// A job of another vault does not stand in its way.
    #[test]
    fn remove_refused_while_its_job_runs() {
        let ts = TestShell::new();
        let (family, family_generation) = confirmed_session(&ts, "Family");
        let (work, _) = confirmed_session(&ts, "Work");
        let row = row_of(&ts, family);
        let list_before = fs::read(&ts.shell.paths.registry).unwrap();

        let job = ts
            .shell
            .autolock
            .begin(Some(family), JobKind::Import, CancelToken::new());
        assert_eq!(ts.shell.forget_vault(row), Err(busy()));
        assert_eq!(
            serde_json::to_value(ts.shell.forget_vault(row).unwrap_err()).unwrap(),
            json!({ "code": "busy", "what": "operation in progress" })
        );
        assert_eq!(fs::read(&ts.shell.paths.registry).unwrap(), list_before);
        assert_eq!(ts.shell.registry.entries().len(), 2);
        assert_eq!(state(&ts, family), Some(SessionState::Unlocked));
        assert!(ts.events.locked().is_empty(), "nothing was locked");
        assert!(
            ts.shell
                .sessions
                .read(family, family_generation, |_, _| Ok(()))
                .is_ok()
        );
        // The failed Remove holds nothing: an unlock of the vault is not told `Busy` by it afterwards.
        assert!(
            ts.shell
                .unlock_vault(row, secret(PW))
                .is_ok_and(|opened| opened.session == family)
        );

        // A job of the other vault is nothing to this one's Remove.
        drop(job);
        let other_job = ts
            .shell
            .autolock
            .begin(Some(work), JobKind::Import, CancelToken::new());
        assert_eq!(ts.shell.forget_vault(row), Ok(()));
        drop(other_job);
        assert_eq!(state(&ts, family), Some(SessionState::Locked));
        assert_eq!(state(&ts, work), Some(SessionState::Unlocked));
        assert_eq!(ts.shell.registry.entries().len(), 1);
    }

    /// A job begun after the vault was locked for its Remove is refused (the old generation answers `Locked`) and
    /// registers nothing that runs: from inside the Remove, and after it.
    #[test]
    fn a_job_admitted_after_remove_is_refused() {
        let ts = TestShell::new();
        let (session, generation) = confirmed_session(&ts, "Family");
        let row = row_of(&ts, session);

        type Inside = (Option<ShellError>, Vec<JobKind>);
        let inside: Rc<RefCell<Option<Inside>>> = Rc::default();
        {
            let (shell, inside) = (Arc::clone(&ts.shell), inside.clone());
            failpoint::observe(
                REMOVING,
                Box::new(move || {
                    let refused = shell.backup_vault(session, generation, 1).err();
                    *inside.borrow_mut() = Some((refused, shell.autolock.running_kinds()));
                }),
            );
        }
        assert_eq!(ts.shell.forget_vault(row), Ok(()));
        failpoint::disarm_all();
        assert_eq!(
            *inside.borrow(),
            Some((Some(ShellError::Locked), vec![])),
            "from inside the Remove: refused, nothing registered"
        );

        let after = ts.shell.backup_vault(session, generation, 1).err();
        assert_eq!(after, Some(ShellError::Locked));
        assert!(ts.shell.autolock.running_kinds().is_empty());
        assert_eq!(
            ts.dialogs.opened(),
            0,
            "no save dialog was shown for either"
        );
    }

    /// An unlock and a Remove of the same vault at the same moment: one of them wins and the other is refused, in
    /// either order, and the vault is never left open and off the list, or listed and gone.
    #[test]
    fn remove_racing_an_unlock_one_wins_cleanly() {
        // Order A: the Remove arrives while the unlock is under way (held at its location check): `Busy`, the unlock
        // finishes, the vault stays listed.
        let ts = TestShell::new();
        let (id, dir, _) = registered(&ts);
        let row = ts.vault(id);
        let answer: Rc<RefCell<Option<ShellResult<()>>>> = Rc::default();
        {
            let (shell, answer) = (Arc::clone(&ts.shell), answer.clone());
            failpoint::observe(
                CHECKING,
                Box::new(move || *answer.borrow_mut() = Some(shell.forget_vault(row))),
            );
        }
        let unlocked = heavy(|| ts.shell.unlock_vault(row, secret(PW)));
        failpoint::disarm_all();
        let unlocked = unlocked.expect("the unlock won");
        assert_eq!(*answer.borrow(), Some(Err(busy())));
        assert_eq!(state(&ts, unlocked.session), Some(SessionState::Unlocked));
        assert_eq!(ts.shell.registry.entries(), vec![(id, dir.clone())]);
        ts.shell.sessions.lock_all(LockReason::Manual);

        // Order B: the unlock arrives while the Remove is under way (held where the list is about to be written):
        // `Busy`, the Remove finishes, and a later unlock finds no row.
        let answer: Rc<RefCell<Option<ShellResult<()>>>> = Rc::default();
        {
            let (shell, answer) = (Arc::clone(&ts.shell), answer.clone());
            failpoint::observe(
                REMOVING,
                Box::new(move || {
                    *answer.borrow_mut() = Some(shell.unlock_vault(row, secret(PW)).map(|_| ()))
                }),
            );
        }
        let removed = ts.shell.forget_vault(row);
        failpoint::disarm_all();
        assert_eq!(removed, Ok(()));
        assert_eq!(*answer.borrow(), Some(Err(busy())));
        assert!(ts.shell.registry.entries().is_empty());
        assert!(is_free(&dir), "the unlock opened nothing");
        assert_eq!(state(&ts, unlocked.session), Some(SessionState::Locked));
        assert_eq!(
            ts.shell.unlock_vault(row, secret(PW)).err(),
            Some(ShellError::NotFound)
        );

        // Order B on a vault that is open: the unlock is `Busy`, never answered with the session the Remove locked.
        let (session, _) = confirmed_session(&ts, "Work");
        let row = row_of(&ts, session);
        let answer: Rc<RefCell<Option<ShellResult<()>>>> = Rc::default();
        {
            let (shell, answer) = (Arc::clone(&ts.shell), answer.clone());
            failpoint::observe(
                REMOVING,
                Box::new(move || {
                    *answer.borrow_mut() = Some(shell.unlock_vault(row, secret(PW)).map(|_| ()))
                }),
            );
        }
        let removed = ts.shell.forget_vault(row);
        failpoint::disarm_all();
        assert_eq!(removed, Ok(()));
        assert_eq!(*answer.borrow(), Some(Err(busy())));
        assert_eq!(state(&ts, session), Some(SessionState::Locked));
    }

    /// A Remove that finishes between an unlock's lookup of its row and the registration of its open: the unlock looks
    /// the row up again inside the open and finds nothing, so a vault off the list is never opened.
    #[test]
    fn an_unlock_that_lost_its_row_to_a_remove_is_refused() {
        let ts = TestShell::new();
        let (id, dir, _) = registered(&ts);
        let row = ts.vault(id);
        let removed: Rc<RefCell<Option<ShellResult<()>>>> = Rc::default();
        {
            let (shell, removed) = (Arc::clone(&ts.shell), removed.clone());
            failpoint::observe(
                LOOKED_UP,
                Box::new(move || *removed.borrow_mut() = Some(shell.forget_vault(row))),
            );
        }
        let answer = heavy(|| ts.shell.unlock_vault(row, secret(PW)));
        failpoint::disarm_all();
        assert_eq!(*removed.borrow(), Some(Ok(())), "the Remove finished");
        assert_eq!(answer.err(), Some(ShellError::NotFound));
        assert!(ts.shell.sessions.list().is_empty());
        assert!(is_free(&dir), "nothing opened it");
    }

    /// A Lock all (or Windows lock, or sleep) that lands between an unlock's lookup of its row and the registration of
    /// its open: the epoch read before the lookup has moved, so the unlock is refused and nothing stays unlocked.
    #[test]
    fn an_unlock_looked_up_before_a_lock_of_all_vaults_is_refused() {
        let ts = TestShell::new();
        let (id, dir, _) = registered(&ts);
        let row = ts.vault(id);
        {
            let shell = Arc::clone(&ts.shell);
            failpoint::observe(
                LOOKED_UP,
                Box::new(move || shell.sessions.lock_all(LockReason::WindowsLocked)),
            );
        }
        let answer = heavy(|| ts.shell.unlock_vault(row, secret(PW)));
        failpoint::disarm_all();
        assert_eq!(answer.err(), Some(ShellError::Locked));
        assert!(ts.shell.sessions.list().is_empty(), "no session was made");
        assert!(is_free(&dir), "nothing opened it");
    }

    /// The answers of Remove that need a state of their own: a list that cannot be written (row 4) leaves the open
    /// vault locked and listed and says so, and each refusal is the JSON the page reads.
    #[test]
    fn remove_answers_as_the_table_says() {
        let ts = TestShell::new();
        let wire = |answer: ShellResult<()>| serde_json::to_value(answer.unwrap_err()).unwrap();

        // Row 2: a row of another list, an ID that is not listed.
        let (session, _) = confirmed_session(&ts, "Family");
        let row = row_of(&ts, session);
        let other_list = VaultRef {
            list: row.list + 1,
            id: row.id,
        };
        let unlisted = VaultRef {
            list: row.list,
            id: row.id + 40,
        };
        for stale in [other_list, unlisted] {
            assert_eq!(
                wire(ts.shell.forget_vault(stale)),
                json!({ "code": "not_found" })
            );
            assert_eq!(
                wire(ts.shell.show_vault_in_explorer(stale)),
                json!({ "code": "not_found" })
            );
        }
        assert_eq!(
            state(&ts, session),
            Some(SessionState::Unlocked),
            "a stale row locks nothing"
        );

        // Row 4: the list's write fails after the lock: locked and still listed.
        failpoint::arm("atomic_write.before_replace");
        let failed = ts.shell.forget_vault(row);
        failpoint::disarm_all();
        assert_eq!(wire(failed), json!({ "code": "core", "kind": "io" }));
        assert_eq!(state(&ts, session), Some(SessionState::Locked));
        assert_eq!(ts.shell.registry.entries().len(), 1, "still listed");

        // Row 4: the list went damaged between the lookup and the write.
        let list_file = ts.shell.paths.registry.clone();
        failpoint::observe(
            REMOVING,
            Box::new(move || fs::write(&list_file, b"{ damaged").unwrap()),
        );
        let damaged = ts.shell.forget_vault(row);
        failpoint::disarm_all();
        assert_eq!(
            wire(damaged),
            json!({ "code": "core", "kind": "damaged", "what": "vault list" })
        );
        assert_eq!(
            fs::read(&ts.shell.paths.registry).unwrap(),
            b"{ damaged",
            "kept as it was"
        );
        // And a damaged list is a row that names nothing.
        assert_eq!(
            wire(ts.shell.forget_vault(row)),
            json!({ "code": "not_found" })
        );

        // Row 5: done, `null`: the command's own answer, on a list started over.
        ts.shell.registry.start_new_list().unwrap();
        let (listed, _) = listed_folder(&ts, "Done");
        let answer = ts.shell.forget_vault(listed);
        assert_eq!(answer, Ok(()));
        assert_eq!(serde_json::to_value(answer.ok()).unwrap(), Value::Null);
        assert!(ts.shell.registry.entries().is_empty(), "it was removed");
    }

    /// The shapes of the vault list as the page reads them: an entry's whole JSON carries the list's identity as a number
    /// JavaScript keeps exactly, and the two requests that name a row refuse a path and every other shape.
    #[test]
    fn vault_ref_json_shapes() {
        let entry = VaultEntry {
            list: 6_029_157_341_982_211,
            id: 1,
            name: Some("Family".to_owned()),
            available: true,
            details_damaged: false,
        };
        assert_eq!(
            serde_json::to_string(&entry).unwrap(),
            r#"{"list":6029157341982211,"id":1,"name":"Family","available":true,"details_damaged":false}"#
        );
        assert_eq!(
            serde_json::to_value(VaultRef { list: 7, id: 2 }).unwrap(),
            json!({ "list": 7, "id": 2 })
        );

        // From a real list: exactly these five fields, the identity a safe whole number.
        let ts = TestShell::new();
        let (row, _) = listed_folder(&ts, "Family");
        let listed = serde_json::to_value(ts.shell.registry.list().unwrap()).unwrap();
        let entry = &listed[0];
        assert_eq!(entry.as_object().unwrap().len(), 5, "{entry}");
        assert_eq!(entry["list"], json!(row.list));
        assert!(row.list >= 1 && row.list < (1 << 53));
        assert_eq!(
            (entry["id"].as_u64(), entry["available"].as_bool()),
            (Some(1), Some(true))
        );

        // The requests that name a row (the unlock and the recovery check as well as the two of this task).
        refuses_a_path::<VaultArg>(json!({ "vault": { "list": 7, "id": 1 } }));
        refuses_a_path::<UnlockVault>(json!({ "vault": { "list": 7, "id": 1 }, "password": PW }));
        refuses_a_path::<RecoverCheck>(
            json!({ "vault": { "list": 7, "id": 1 }, "recovery_key": "x" }),
        );
        for body in [
            json!({ "id": 1 }),
            json!({ "vault": { "list": 7, "id": 1, "path": "SENTINEL-7f3a" } }),
            json!({ "vault": { "list": "7", "id": 1 } }),
        ] {
            assert_eq!(
                parse::<VaultArg>(&InvokeBody::Json(body.clone())).err(),
                Some(MALFORMED),
                "{body}"
            );
        }
        assert_eq!(
            parse::<UnlockVault>(&InvokeBody::Json(json!({ "id": 1, "password": PW }))).err(),
            Some(MALFORMED)
        );

        // The answers of Show in Explorer, rows 2 to 5, as exact JSON.
        let wire = |answer: ShellResult<()>| serde_json::to_value(answer.unwrap_err()).unwrap();
        let stale = VaultRef {
            list: row.list + 1,
            id: 1,
        };
        assert_eq!(
            wire(ts.shell.show_vault_in_explorer(stale)),
            json!({ "code": "not_found" })
        );
        let (gone, gone_dir) = listed_folder(&ts, "Gone");
        fs::remove_dir(&gone_dir).unwrap();
        assert_eq!(
            wire(ts.shell.show_vault_in_explorer(gone)),
            json!({ "code": "not_found" })
        );
        let file = ts.temp.path().join("a-file");
        fs::write(&file, b"MU-text").unwrap();
        let file_row = ts
            .shell
            .registry
            .add(&fs::canonicalize(&file).unwrap())
            .unwrap();
        assert_eq!(
            wire(ts.shell.show_vault_in_explorer(file_row)),
            json!({ "code": "invalid_input", "what": "folder" })
        );
        ts.launcher.fail_next_folder();
        assert_eq!(
            wire(ts.shell.show_vault_in_explorer(row)),
            json!({ "code": "core", "kind": "io" })
        );
        // Row 6: Explorer started, `null`: the command's own answer.
        let answer = ts.shell.show_vault_in_explorer(row);
        assert_eq!(answer, Ok(()));
        assert_eq!(serde_json::to_value(answer.ok()).unwrap(), Value::Null);
        assert_eq!(
            ts.launcher.opened_folders().len(),
            2,
            "the failed try and this one"
        );
    }

    /// 30a: a folder with no vault in it is refused with the words the page reads, and nothing is added or written there.
    #[test]
    fn add_existing_on_a_folder_that_is_not_a_vault_says_so() {
        let ts = TestShell::new();
        let plain = ts.folder("Not a vault");
        fs::write(plain.join("notes.txt"), b"MU-notes").unwrap();
        let before = tree(&plain);
        ts.dialogs.answer(Some(plain.clone()));
        let refused = ts.shell.add_existing_vault().err().unwrap();
        assert_eq!(
            serde_json::to_value(refused).unwrap(),
            json!({ "code": "invalid_input", "what": "not a vault folder" })
        );
        assert!(ts.shell.registry.entries().is_empty(), "not added");
        assert_eq!(tree(&plain), before, "nothing was written there");
        assert_eq!(ts.dialogs.opened(), 1);
    }

    /// The location table (`locations_refused_table`), through Add existing vault folder: every drive and file system the
    /// table refuses, the app-data folders, and a USB hard drive that Windows reports as fixed (accepted, spec 6.10).
    /// The folders only hold a header file, which is all the add looks for.
    #[test]
    fn add_existing_follows_the_location_table() {
        let ts = TestShell::new();
        let vault_in = |parent: &Path, name: &str| {
            let dir = parent.join(name);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("vault.json"), b"MU-header").unwrap();
            dir
        };
        let table = [
            (DriveType::Removable, "NTFS", "removable drive"),
            (DriveType::Remote, "NTFS", "network drive"),
            (DriveType::CdRom, "NTFS", "drive type not supported"),
            (DriveType::RamDisk, "NTFS", "drive type not supported"),
            (DriveType::Unknown, "NTFS", "drive type not supported"),
            (DriveType::Fixed, "FAT32", "file system not supported"),
            (DriveType::Fixed, "exFAT", "file system not supported"),
            (DriveType::Fixed, "ReFS", "file system not supported"),
        ];
        let mut refused = 0;
        for (at, (drive, file_system, what)) in table.into_iter().enumerate() {
            let root = ts.folder(&format!("volume-{at}"));
            ts.volumes.mount(
                &root,
                FakeVolume {
                    drive,
                    file_system,
                    label: "Volume",
                },
            );
            let dir = vault_in(&root, "Vault");
            ts.dialogs.answer(Some(dir));
            assert_eq!(
                ts.shell.add_existing_vault().err(),
                Some(ShellError::InvalidInput { what }),
                "{what}"
            );
            refused += 1;
        }
        // Inside each forbidden folder.
        let forbidden = [
            ts.app_dirs[0].clone(),
            ts.app_dirs[1].clone(),
            ts.env.folder(KnownFolder::RoamingAppData),
            ts.shell.paths.root.clone(),
        ];
        for root in &forbidden {
            let dir = vault_in(root, "Vault");
            ts.dialogs.answer(Some(dir));
            assert_eq!(
                ts.shell.add_existing_vault().err(),
                Some(ShellError::InvalidInput {
                    what: "app data folder"
                })
            );
            refused += 1;
        }
        assert_eq!(refused, table.len() + forbidden.len(), "every row was run");
        assert!(ts.shell.registry.entries().is_empty(), "none was added");
        assert!(!ts.shell.paths.registry.exists(), "no list was written");

        // A USB hard drive that Windows reports as a fixed NTFS disk is accepted.
        let usb = ts.folder("usb");
        ts.volumes.mount(
            &usb,
            FakeVolume {
                drive: DriveType::Fixed,
                file_system: "NTFS",
                label: "USB disk",
            },
        );
        ts.dialogs.answer(Some(vault_in(&usb, "Vault")));
        let added = done(ts.shell.add_existing_vault().unwrap());
        assert_eq!(added.id, 1);
        assert!(added.available);
    }

    /// A vault that is unavailable can be taken off the list and added back once its folder is there again.
    #[test]
    fn an_unavailable_vault_can_be_removed_and_added_back() {
        let ts = TestShell::new();
        let (id, dir, _) = registered(&ts);
        let moved = ts.temp.path().join("moved away");
        fs::rename(&dir, &moved).unwrap();
        let listed = ts.shell.registry.list().unwrap();
        assert!(!listed[0].available, "its folder is not there");
        // Show in Explorer: the folder is not there.
        assert_eq!(
            ts.shell.show_vault_in_explorer(ts.vault(id)),
            Err(ShellError::NotFound)
        );
        assert!(ts.launcher.opened_folders().is_empty());
        // Remove from list works on it.
        assert_eq!(ts.shell.forget_vault(ts.vault(id)), Ok(()));
        assert!(ts.shell.registry.list().unwrap().is_empty());
        fs::rename(&moved, &dir).unwrap();
        ts.dialogs.answer(Some(dir));
        let entry = done(ts.shell.add_existing_vault().unwrap());
        assert!(entry.available);
        assert_ne!(entry.id, id);
    }
}
