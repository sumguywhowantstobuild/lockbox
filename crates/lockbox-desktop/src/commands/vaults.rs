//! The vault list, and opening vaults: create, unlock, recover (spec §5.3, §6.10). Vaults are named by registry ID
//! or session ID; their folders come only from the registry and from Rust's own dialogs (spec §4.1).
//!
//! Each command is a thin wrapper that parses its request and runs a [`Shell`] method below on the blocking pool:
//! a key derivation takes about a second, and a dialog waits for the user.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use lockbox_core::fsio::remove_dir_all_retry;
use lockbox_core::kdf::check_new_password;
use lockbox_core::recovery::RecoverySecret;
use lockbox_core::{CleanupReport, UnlockReport, Vault};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Request;
use zeroize::Zeroizing;

use super::{NoArgs, args, blocking};
use crate::error::{Confirm, Outcome, ShellError, ShellResult};
use crate::locations::CloudProvider;
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
}

/// What an unlock's opening closure gives back: the engine's report, and the cloud provider its location check found.
type Unlocked = (UnlockReport, Option<CloudProvider>);

/// The view of an unlock (`unlock_vault`, `recover_vault`): `None` when the vault was already unlocked, every flag
/// then false.
fn unlock_view(info: SessionInfo, unlocked: Option<Unlocked>) -> UnlockView {
    let Some((report, cloud)) = unlocked else {
        return UnlockView {
            info,
            used_backup_header: false,
            header_mac_mismatch: false,
            header_repair_failed: false,
            cleanup: CleanupView::default(),
            cloud: None,
        };
    };
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

/// Tests only: the step a recovery reaches once the new password is set, just before it gives back the session.
#[cfg(test)]
const PASSWORD_SET: &str = "shell.recover.password_set";

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
            data: unlock_view(info, Some(unlocked)),
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
        let Some(dir) = self.os.dialogs.pick_folder("Add an existing vault") else {
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
        let parent = match choose_folder {
            true => match self
                .os
                .dialogs
                .pick_folder("Choose where to create the vault")
            {
                Some(parent) => parent,
                None => return Ok(Outcome::Dismissed),
            },
            false => default_vault_parent(self.os.env.as_ref())?,
        };
        let answer = self.sessions.open(None, Some(VAULT_CREATED), |_| {
            self.create_in(parent, name, password, false)
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
            |(parent, name, password), _| self.create_in(parent, name, password, true),
        )?;
        created(answer)
    }

    /// The opening closure of a create: checks `parent` (again, after a yes: it may have changed since), asks first
    /// about a cloud folder unless `cloud_confirmed`, then creates the vault there and adds it to the vault list. A
    /// lock of all vaults before the answer still leaves the vault on disk and on the vault list:
    /// `LockedAfterChange { what: "vault created" }`.
    fn create_in(
        &self,
        parent: PathBuf,
        name: String,
        password: Zeroizing<String>,
        cloud_confirmed: bool,
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
        // The default vaults folder is made on first use; a folder the user picked exists already.
        fs::create_dir_all(&parent)?;
        let created = Vault::create(&parent, &name, &password)?;
        let listed = fs::canonicalize(created.vault.dir())
            .map_err(ShellError::from)
            .and_then(|dir| self.registry.add(&dir).map(|_| dir));
        drop(creating);
        let dir = match listed {
            Ok(dir) => dir,
            Err(e) => {
                // Not on the list (its write failed, or it would grow too large): removed again, so no vault is left
                // that Lockbox cannot show and whose recovery key was never shown. The vault closes first, freeing its
                // `.lock`; only the folder this create made is removed, best effort.
                let made = created.vault.dir().to_path_buf();
                drop(created);
                let _ = remove_dir_all_retry(&made);
                return Err(e);
            }
        };
        Ok(OpenStep::Session(
            Location::Folder(dir),
            Opened::Writable(created.vault),
            created.recovery.to_display(),
        ))
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
        let answer = self.sessions.open(Some(location.clone()), None, |_| {
            let check = self.check_location(&dir)?;
            let (vault, report) = Vault::unlock_with_password(&check.path, &password)?;
            let unlocked = (report, check.cloud);
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
        Ok(Tagged {
            session,
            generation,
            data: unlock_view(info, unlocked),
        })
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
            .open(Some(location.clone()), Some("password"), |_| {
                let check = self.check_location(&dir)?;
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
                vault.change_password(&new_password)?;
                #[cfg(test)]
                test_step(PASSWORD_SET)?;
                let unlocked = (report, check.cloud);
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
            |(location, vault, new_password, mut report), _| {
                // Before `accept_header` writes anything.
                check_new_password(&new_password)?;
                // Checked again: the folder may have moved drives while the question waited.
                let check = self.check_location(location.path())?;
                let mut vault = *vault;
                vault.accept_header()?;
                vault.change_password(&new_password)?;
                #[cfg(test)]
                test_step(PASSWORD_SET)?;
                // The changed header the report found is accepted now.
                report.header_mac_mismatch = false;
                let unlocked = (report, check.cloud);
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

    /// A new recovery key, shown once; the old one stops working.
    pub fn regenerate_recovery(
        &self,
        session: SessionId,
        generation: u64,
    ) -> ShellResult<Tagged<Zeroizing<String>>> {
        self.sessions
            .write_change(session, generation, "recovery key", |vault, _| {
                Ok(vault.regenerate_recovery()?.to_display())
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
    use std::path::Path;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;
    use std::time::{Duration, Instant};

    use lockbox_core::internals::fsio::failpoint;
    use lockbox_core::internals::header::{
        HEADER_BACKUP, HEADER_FILE, parse_header, serialize_header,
    };
    use lockbox_core::internals::lockfile::VaultLock;
    use lockbox_core::{CoreError, read_vault_name};
    use serde_json::{Value, json};
    use tauri::ipc::InvokeBody;

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

        // Recovery: the header accepted and the password set, but the session never opens.
        let (id, dir, recovery) = registered(&ts);
        change_header(&dir);
        let asked = heavy(|| ts.shell.recover_vault(id, recovery, secret(NEW_PW))).unwrap();
        let Outcome::Confirm(Confirm::HeaderChanged { token }) = asked else {
            panic!("the changed header asks first");
        };
        let locker = lock_once_taken(&ts);
        let answer = heavy(|| ts.shell.recover_vault_confirm(&token, true));
        join(&locker);
        assert_eq!(
            answer.err(),
            Some(ShellError::LockedAfterChange { what: "password" })
        );
        assert!(ts.shell.sessions.list().is_empty(), "no session");
        assert!(is_free(&dir));

        // Creation in a cloud folder: the vault is made and listed, but not opened.
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
        assert_eq!(
            answer.err(),
            Some(ShellError::LockedAfterChange {
                what: "vault created"
            })
        );
        assert!(ts.shell.sessions.list().is_empty(), "no session");
        let entries = ts.shell.registry.entries();
        assert_eq!(entries.len(), 2, "the new vault is on the list");
        assert!(is_free(&entries[1].1));

        // A lock before the yes: the choice is gone, nothing is created.
        let token = ask();
        ts.shell.sessions.lock_all(LockReason::WindowsLocked);
        assert_eq!(
            ts.shell.create_vault_confirm(&token).err(),
            Some(ShellError::NotFound)
        );
        assert_eq!(ts.shell.registry.entries().len(), 2);

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
        assert_eq!(ts.shell.registry.entries().len(), 3);
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
        let second = second_at_staging(&ts, |shell| {
            shell.create_vault("Work".into(), secret(PW), true)
        });
        let (first, second) = heavy(|| {
            let first = ts.shell.create_vault("Family".into(), secret(PW), false);
            (first, joined(&second))
        });
        failpoint::disarm_all();
        let full = ShellError::TooLarge { what: "vault list" };
        let answers = [first.map(|_| ()), second.map(|_| ())];
        assert_eq!(
            answers.iter().filter(|answer| answer.is_ok()).count(),
            1,
            "exactly one through"
        );
        assert!(answers.contains(&Err(full)));
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

        lock_now();
        assert!(matches!(
            heavy(|| ts.shell.recover_vault(id, recovery, secret(NEW_PW))),
            Err(ShellError::Locked | ShellError::LockedAfterChange { .. })
        ));
        assert!(ts.shell.sessions.list().is_empty());
        assert!(is_free(&dir));
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
        // `add_existing_vault` and `list_vaults`.
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
