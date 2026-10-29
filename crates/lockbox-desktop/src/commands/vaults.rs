//! The vault list, and opening vaults: create, unlock, recover (spec §5.3, §6.10). Vaults are named by registry ID
//! or session ID; their folders come only from the registry and from Rust's own dialogs (spec §4.1).
//!
//! Each command is a thin wrapper that parses its request and runs a [`Shell`] method below on the blocking pool:
//! a key derivation takes about a second, and a dialog waits for the user.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use lockbox_core::recovery::RecoverySecret;
use lockbox_core::{CleanupReport, UnlockReport, Vault};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Request;
use zeroize::Zeroizing;

use super::{NoArgs, args, blocking};
use crate::error::{Confirm, Outcome, ShellError, ShellResult};
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

/// `recover_vault`'s answer: the session, once the closure that sets the new password ran, or its question. A
/// session already unlocked there (the closure skipped, the password not set) is refused.
fn recovered(answer: OpenAnswer<()>) -> ShellResult<Outcome<Tagged<SessionInfo>>> {
    Ok(match answer {
        Outcome::Done(Tagged {
            session,
            generation,
            data: (info, Some(())),
        }) => Outcome::Done(Tagged {
            session,
            generation,
            data: info,
        }),
        Outcome::Done(_) => return Err(UNLOCKED),
        Outcome::Confirm(question) => Outcome::Confirm(question),
        Outcome::Dismissed => Outcome::Dismissed,
    })
}

impl Shell {
    /// Adds a vault folder the user picks. `Dismissed` when the dialog is closed; refused when the folder may not
    /// hold a vault or holds none.
    pub fn add_existing_vault(&self) -> ShellResult<Outcome<VaultEntry>> {
        let Some(dir) = self.os.dialogs.pick_folder("Add an existing vault") else {
            return Ok(Outcome::Dismissed);
        };
        self.check_location(&dir)?;
        if !HEADER_FILES.iter().any(|file| dir.join(file).is_file()) {
            return Err(ShellError::InvalidInput {
                what: "not a vault folder",
            });
        }
        let dir = fs::canonicalize(&dir)?;
        let id = self.registry.add(&dir)?;
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
        self.create_in(parent, name, password, false)
    }

    /// The user's yes to creating the vault in a cloud folder: goes on with the folder chosen before.
    pub fn create_vault_confirm(&self, token: &Token) -> ShellResult<Outcome<Tagged<CreatedView>>> {
        match self.sessions.pending().take(token)? {
            PendingChoice::CreateVault {
                parent,
                name,
                password,
            } => self.create_in(parent, name, password, true),
            // A token for another question: used up, and its choice dropped.
            _ => Err(ShellError::NotFound),
        }
    }

    /// Creates the vault in `parent` after checking the folder (again, after a yes: it may have changed since), and
    /// asks first about a cloud folder unless `cloud_confirmed`. A lock of all vaults before the answer still leaves
    /// the vault on disk and on the vault list: `LockedAfterChange { what: "vault created" }`.
    fn create_in(
        &self,
        parent: PathBuf,
        name: String,
        password: Zeroizing<String>,
        cloud_confirmed: bool,
    ) -> ShellResult<Outcome<Tagged<CreatedView>>> {
        let answer = self.sessions.open(None, Some("vault created"), |_| {
            let check = self.check_location(&parent)?;
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
            // Before anything is written, so a full or damaged list never leaves the new vault off it.
            self.registry.check_room()?;
            // The default vaults folder is made on first use; a folder the user picked exists already.
            fs::create_dir_all(&parent)?;
            let created = Vault::create(&parent, &name, &password)?;
            let dir = fs::canonicalize(created.vault.dir())?;
            self.registry.add(&dir)?;
            Ok(OpenStep::Session(
                Location::Folder(dir),
                Opened::Writable(created.vault),
                created.recovery.to_display(),
            ))
        })?;
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

    /// The registered folder of the vault `id`, checked again (it may have moved drives since it was added), and
    /// its session location. `NotFound` for an ID not on the list.
    fn registered(&self, id: u32) -> ShellResult<(PathBuf, Location)> {
        let dir = self.registry.path(id).ok_or(ShellError::NotFound)?;
        self.check_location(&dir)?;
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
            let (vault, report) = Vault::unlock_with_password(&dir, &password)?;
            Ok(OpenStep::Session(location, Opened::Writable(vault), report))
        })?;
        let Tagged {
            session,
            generation,
            data: (info, report),
        } = opened(answer)?;
        let view = match report {
            Some(UnlockReport {
                used_backup_header,
                header_mac_mismatch,
                header_repair_failed,
                cleanup,
            }) => UnlockView {
                info,
                used_backup_header,
                header_mac_mismatch,
                header_repair_failed,
                cleanup: cleanup.into(),
            },
            None => UnlockView {
                info,
                used_backup_header: false,
                header_mac_mismatch: false,
                header_repair_failed: false,
                cleanup: CleanupView::default(),
            },
        };
        Ok(Tagged {
            session,
            generation,
            data: view,
        })
    }

    /// Unlocks the vault `id` with its recovery key and sets `new_password` before the session can be used (spec
    /// §5.3). A header changed outside Lockbox asks first (`Confirm::HeaderChanged`): the engine refuses a password
    /// change until it is accepted. A vault already unlocked is refused: its password is changed from the open
    /// vault.
    pub fn recover_vault(
        &self,
        id: u32,
        recovery_key: Zeroizing<String>,
        new_password: Zeroizing<String>,
    ) -> ShellResult<Outcome<Tagged<SessionInfo>>> {
        let (dir, location) = self.registered(id)?;
        if self.sessions.find(&location).is_some() {
            return Err(UNLOCKED);
        }
        let secret = RecoverySecret::parse(&recovery_key)?;
        let answer = self
            .sessions
            .open(Some(location.clone()), Some("password"), |_| {
                let (mut vault, report) = Vault::unlock_with_recovery(&dir, &secret)?;
                if report.header_mac_mismatch {
                    let choice = PendingChoice::RecoverVault {
                        location,
                        vault: Box::new(vault),
                        new_password,
                    };
                    return Ok(OpenStep::Ask(choice, |token| Confirm::HeaderChanged {
                        token,
                    }));
                }
                vault.change_password(&new_password)?;
                Ok(OpenStep::Session(location, Opened::Writable(vault), ()))
            })?;
        recovered(answer)
    }

    /// The user's answer about the changed header: yes accepts it, sets the new password and opens the session; no
    /// closes the vault with nothing changed (`Dismissed`).
    pub fn recover_vault_confirm(
        &self,
        token: &Token,
        accept: bool,
    ) -> ShellResult<Outcome<Tagged<SessionInfo>>> {
        let PendingChoice::RecoverVault {
            location,
            vault,
            new_password,
        } = self.sessions.pending().take(token)?
        else {
            // A token for another question: used up, and its choice dropped.
            return Err(ShellError::NotFound);
        };
        if !accept {
            drop(vault);
            return Ok(Outcome::Dismissed);
        }
        let answer = self
            .sessions
            .open(Some(location.clone()), Some("password"), |_| {
                let mut vault = *vault;
                vault.accept_header()?;
                vault.change_password(&new_password)?;
                Ok(OpenStep::Session(location, Opened::Writable(vault), ()))
            })?;
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
) -> ShellResult<Outcome<Tagged<SessionInfo>>> {
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
) -> ShellResult<Outcome<Tagged<SessionInfo>>> {
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

    #[test]
    fn unlock_report_flags_reach_the_view() {
        let ts = TestShell::new();
        let (id, dir, _) = registered(&ts);

        // `vault.json` damaged: opened from `.bak` (which the unlock then repairs). A leftover partial file is
        // cleaned up.
        fs::write(dir.join(HEADER_FILE), b"damaged").unwrap();
        fs::write(
            dir.join("files").join("0123456789abcdef.blob.partial"),
            b"x",
        )
        .unwrap();
        let view = heavy(|| ts.shell.unlock_vault(id, secret(PW)))
            .unwrap()
            .data;
        assert!(view.used_backup_header && !view.header_mac_mismatch && !view.header_repair_failed);
        assert_eq!(view.cleanup.partials_removed, 1);

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
        let tagged = done(heavy(|| ts.shell.recover_vault(id, recovery, secret(NEW_PW))).unwrap());
        assert_eq!(tagged.data.name, "Family");
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
            heavy(|| ts.shell.recover_vault(id, recovery, secret("short"))).err(),
            Some(CoreError::PasswordTooShort { min: 12 }.into())
        );
        assert!(ts.shell.sessions.list().is_empty());
        assert!(is_free(&dir));
        assert!(password_works(&dir, PW));
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
        assert_eq!(tagged.data.name, "Renamed");
        assert_eq!(state(&ts, tagged.session), Some(SessionState::Unlocked));
        ts.shell.sessions.lock_all(LockReason::Manual);
        let (_, report) = heavy(|| Vault::unlock_with_password(&dir, NEW_PW)).unwrap();
        assert!(!report.header_mac_mismatch);
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
