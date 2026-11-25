//! Choices waiting for the user's yes ([`Pending`]), each behind a one-time [`Token`] the confirming command sends
//! back. What waits can be a typed password or an unlocked vault, so a lock of all vaults drops everything here
//! (`Sessions::lock_all`). A pasted `.env`'s values wait here too, tied to their vault, so a lock of that one vault
//! drops them as well (`Pending::drop_env_pastes`, from a lock hook).

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use petalock_core::env_file::EnvEntry;
use petalock_core::ids::{FileId, ItemId, VaultId};
use petalock_core::recovery::RecoverySecret;
use serde::de::{self, Deserializer};
use serde::ser::Serializer;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::commands::readable::ReadableJob;
use crate::error::{ShellError, ShellResult};
use crate::lock;
use crate::registry::VaultRef;
use crate::restore::Checked;
use crate::session::{Location, SessionId};

/// How long a choice waits for its answer.
const LIFETIME: Duration = Duration::from_secs(5 * 60);

/// A one-time confirmation token: 128 random bits from the OS, as 32 lowercase hex characters (a JSON string, so
/// JavaScript keeps every bit). Parsed back only in that exact form. Cloned only to answer with the token a command was
/// given (Pick more keeps its token).
#[derive(Clone)]
pub struct Token(String);

impl Token {
    /// The engine's random ID is exactly this: 16 bytes from the OS random source, written and parsed as 32
    /// lowercase hex characters and nothing else.
    fn random() -> Token {
        Token(VaultId::random().to_hex())
    }

    fn parse(text: String) -> Option<Token> {
        VaultId::from_hex(&text).is_ok().then_some(Token(text))
    }

    /// Compares every byte, whatever the first difference, so the time taken does not tell how much of a guess was
    /// right.
    fn matches(&self, other: &Token) -> bool {
        let (a, b) = (self.0.as_bytes(), other.0.as_bytes());
        a.len() == b.len() && a.iter().zip(b).fold(0, |diff, (x, y)| diff | (x ^ y)) == 0
    }
}

impl Serialize for Token {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Token {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Token::parse(String::deserialize(deserializer)?).ok_or_else(|| de::Error::custom("token"))
    }
}

/// Never shows the token: it is what confirms the choice.
impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Token(..)")
    }
}

/// The names a paste's answer showed Keep both: by place (a live folder, or none), each clashing row's number and the
/// name it would be saved under there. The user's own names: never in an error or a log (R5).
pub type ShownNames = HashMap<Option<ItemId>, HashMap<u32, String>>;

/// What waits in [`Pending`] for the user's answer. Each task adds the variants it needs; a typed password is kept
/// as a `Zeroizing<String>`. No `Debug`: it holds passwords, names and paths (R5).
pub enum PendingChoice {
    /// `create_vault` in a cloud folder, waiting for the user's yes (`Confirm::CloudFolder`): the folder chosen
    /// (canonical, as checked), so the dialog is not shown again, and what the vault is created with.
    CreateVault {
        parent: PathBuf,
        name: String,
        password: Zeroizing<String>,
    },
    /// `recover_check`'s recovery key, waiting for `recover_finish` (the forgotten-password flow, 28b to 28d): the key
    /// that opened the vault's recovery slot, with what it was checked against. It holds no unlocked vault and no
    /// `.lock`, and no password: the new one is typed after the check. Launch-scoped as a held restore pick is: dropped
    /// by `recover_finish` (used up), `recover_forget`, every lock of all vaults (an idle one too), Windows locking or
    /// sleeping, closing, and its five minutes ([`Pending::drain`], [`Pending::sweep_expired`]). Holds a secret.
    Recovery(RecoveryChoice),
    /// `add_existing_vault` of a folder a cloud provider syncs, waiting for the user's yes (`Confirm::CloudFolder`):
    /// the folder chosen (canonical), so the dialog is not shown again.
    AddVault { dir: PathBuf },
    /// `restore_prepare` waiting for a yes (`Confirm::CloudFolder` or `Confirm::NewFolder`): the held pick it was asked
    /// for (by its token) and what the yes decides, so the confirming command neither asks for files again nor lets
    /// another backup in. It holds no credential and no path: those wait in the pick, which a refusal of the copy leaves
    /// held.
    Restore(crate::restore::RestoreChoice),
    /// `save_readable` to a cloud folder, waiting for the user's yes (`Confirm::CloudFolder`): the session and
    /// generation that asked (the yes goes on only while that session is still unlocked in that generation, never for
    /// another one), the job, and the destination (its folder canonical, as checked), so the dialog is not shown again.
    Readable {
        session: SessionId,
        generation: u64,
        job: ReadableJob,
        dest: PathBuf,
    },
    /// `save_file_copy` to a cloud folder, waiting for the user's yes (`Confirm::CloudFolder`): the session and generation
    /// that asked (the yes goes on only while that session is still unlocked in that generation), the stored file by its
    /// item and file IDs, and the destination (its folder canonical, as checked), so the dialog is not shown again. It
    /// holds no secret, but it is the vault's: dropped by the lock of that one vault too
    /// ([`Pending::drop_stored_copies`]), not only by Lock all.
    StoredCopy {
        session: SessionId,
        generation: u64,
        id: ItemId,
        file_id: FileId,
        dest: PathBuf,
    },
    /// `env_read`'s keys (or `capture_env`'s), waiting for `env_save`: the session and generation that read the paste (a
    /// save from any other is refused), and each key read, in the paste's order, its value wiped when dropped. Dropped
    /// by the lock of that one vault too ([`Pending::drop_env_pastes`]), not only by Lock all.
    EnvPaste {
        session: SessionId,
        generation: u64,
        entries: Vec<EnvEntry>,
        /// The text the keys were read from, wiped when dropped: what the clipboard is compared with when the save is
        /// asked to clear it afterwards.
        source: Zeroizing<String>,
        /// The name Keep both was shown for each clashing row in each place, so the save can tell that the place has
        /// changed since.
        shown: ShownNames,
    },
    /// The files picked to be added to a vault (`pick_files_to_add`), waiting for `add_files`: the session and generation
    /// that picked them (a command from any other is refused), and their paths in the order picked. The paths never go to
    /// the page. One entry for the whole pick session: Pick more and Remove change the list in place under the same token
    /// and start its five minutes again ([`Pending::update_picked`]); the add takes it once. Dropped by the lock of that
    /// one vault too ([`Pending::drop_picked_files`]), not only by Lock all. Holds no secret.
    PickedFiles {
        session: SessionId,
        generation: u64,
        paths: Vec<PathBuf>,
    },
    /// Save all of a folder's files (`save_all_files`), parked from the plan to the start (`save_all_start`, which uses it
    /// up): the session and generation that planned it (nothing of it goes on for any other), the folder, the destination
    /// folder (canonical, as checked) and the stored files planned, as (item, file) IDs in the order they are saved. The
    /// page sees names and sizes only, never a path. A plan always holds at least one file: the cloud folder's question is
    /// this same variant with none, so it can only be answered by `save_all_files_confirm` and a plan only by the start.
    /// Holds no secret, but it is the vault's: dropped by the lock of that one vault too ([`Pending::drop_save_alls`]).
    SaveAll {
        session: SessionId,
        generation: u64,
        folder: ItemId,
        dest: PathBuf,
        files: Vec<(ItemId, FileId)>,
    },
    /// The summary of a Save all or of an export, for Show in Explorer: the folder the files were saved in, behind a token
    /// the page holds, for the session and generation that saved them. Read, never used up (it can be used again); dropped when the
    /// summary closes (`close_output`), by the lock of that one vault ([`Pending::drop_saved_folders`]), Lock all, Windows
    /// locking or sleep, the app closing, and its five minutes.
    SavedFolder {
        session: SessionId,
        generation: u64,
        folder: PathBuf,
    },
    /// The backup picked to be tested (`test_backup_pick`, or a finished backup's own offer), waiting for `test_backup`: its
    /// path, which never goes to the page, and the lock epoch it was held in. Launch-scoped: no session owns it, so a lock
    /// of one vault leaves it, and a lock of all vaults, an idle lock, Windows locking or sleeping, and closing drop it
    /// with the rest ([`Pending::drain`]). Kept through every answer of `test_backup`, each one starting its five minutes
    /// again ([`Pending::use_test_backup`]); dropped by [`Pending::forget_test_backup`]. Holds no secret.
    TestBackup { path: PathBuf, epoch: u64 },
    /// The backup picked to be opened read-only (`open_backup_pick`), waiting for `open_backup_read_only`: held exactly as
    /// [`PendingChoice::TestBackup`] is (its path never goes to the page; launch-scoped; every answer but a session opened
    /// keeps it, each use starting its five minutes again, [`Pending::use_open_backup`]; dropped by
    /// [`Pending::forget_open_backup`]), and another kind of choice: a test choice never answers for an open and an open
    /// choice never for a test. Holds no secret.
    OpenBackup { path: PathBuf, epoch: u64 },
    /// The backup picked to be restored (`restore_pick`), waiting for the password check, the folder and the copy: its
    /// path, which never goes to the page, the lock epoch it was held in, and, once the password has worked
    /// (`restore_check`), what that found and the credential that worked, which waits here and not on the page (zeroized,
    /// never logged). Launch-scoped as a held test backup is: a lock of one vault leaves it, and every lock of all vaults
    /// (an idle one too), Windows locking or sleeping and closing drop it with the rest ([`Pending::drain`]). Kept
    /// through a wrong password and through a refusal of the copy, each use starting its five minutes again
    /// ([`Pending::use_restore_pick`]); dropped by [`Pending::forget_restore_pick`]. Holds a secret once checked.
    /// `vault`: the listed vault the pick was made for (Ask 4 and Ask 8 offer a backup for one), whose folder's parent the
    /// check makes the restore's folder instead of the usual one.
    RestorePick {
        path: PathBuf,
        epoch: u64,
        vault: Option<u32>,
        checked: Option<crate::restore::Checked>,
    },
    /// Tests only: a choice that may hold an unlocked vault, to see it dropped.
    #[cfg(test)]
    Test(Option<Box<petalock_core::Vault>>),
    /// Tests only: records when it is dropped.
    #[cfg(test)]
    Marker(DropMarker),
}

/// What a checked recovery key holds (see [`PendingChoice::Recovery`]): the vault's row on the list (the list's identity
/// and its registry ID) and its place as the check found them, the lock epoch it was held in, the key (wiped when
/// dropped), the bytes of both header files as the check read them (`None`: the file was not there), and whether the
/// header that opened failed its MAC. Internal to Rust: the page sees only the token. No `Debug`: it holds a secret.
pub struct RecoveryChoice {
    pub vault: VaultRef,
    pub location: Location,
    pub epoch: u64,
    pub secret: RecoverySecret,
    pub main: Option<Vec<u8>>,
    pub backup: Option<Vec<u8>>,
    pub header_changed: bool,
}

/// What a plan of Save all, or its cloud question, holds (see [`PendingChoice::SaveAll`]). No `Debug`: the folder is the
/// user's own.
pub struct SaveAllChoice {
    pub session: SessionId,
    pub generation: u64,
    pub folder: ItemId,
    pub dest: PathBuf,
    pub files: Vec<(ItemId, FileId)>,
}

impl SaveAllChoice {
    fn of(choice: &PendingChoice) -> Option<SaveAllChoice> {
        match choice {
            PendingChoice::SaveAll {
                session,
                generation,
                folder,
                dest,
                files,
            } => Some(SaveAllChoice {
                session: *session,
                generation: *generation,
                folder: *folder,
                dest: dest.clone(),
                files: files.clone(),
            }),
            _ => None,
        }
    }
}

/// Tests only: sets its flag when dropped.
#[cfg(test)]
pub struct DropMarker(std::sync::Arc<std::sync::atomic::AtomicBool>);

#[cfg(test)]
impl Drop for DropMarker {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// The choices waiting for an answer, each until it is taken, it expires, or every vault locks.
#[derive(Default)]
pub struct Pending {
    parked: Mutex<Vec<Parked>>,
    /// Tests only: run once, right after the next take has removed its choice (with `parked` released), so a test can
    /// lock every vault at exactly that point.
    #[cfg(test)]
    after_take: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

struct Parked {
    token: Token,
    until: Instant,
    /// The attempts running on a held backup ([`Pending::use_test_backup`], [`Pending::use_open_backup`],
    /// [`Pending::use_restore_pick`]): while any does, it is not swept for being old. Always 0 for every other choice.
    in_use: u32,
    choice: PendingChoice,
}

/// The two held backups that are only a path and an epoch: one picked to be tested, one to be opened read-only. They
/// are held, used, forgotten and expired alike; they are never each other's.
#[derive(Clone, Copy, PartialEq, Eq)]
enum HeldBackup {
    Test,
    Open,
}

impl HeldBackup {
    /// The path and the epoch of `choice`, when it is a held backup of this kind.
    fn of(self, choice: &PendingChoice) -> Option<(&Path, u64)> {
        match (self, choice) {
            (HeldBackup::Test, PendingChoice::TestBackup { path, epoch })
            | (HeldBackup::Open, PendingChoice::OpenBackup { path, epoch }) => Some((path, *epoch)),
            _ => None,
        }
    }
}

/// A held backup an attempt is using: it is not swept for being old while this lives, and its five minutes start again
/// when it is dropped ([`Pending::use_test_backup`], [`Pending::use_open_backup`]).
pub struct HeldBackupUse<'a> {
    pending: &'a Pending,
    kind: HeldBackup,
    token: Token,
    path: PathBuf,
    clock: &'a dyn Fn() -> Instant,
}

impl HeldBackupUse<'_> {
    /// The backup's path: never sent to the page.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for HeldBackupUse<'_> {
    fn drop(&mut self) {
        self.pending
            .end_held_backup(self.kind, &self.token, (self.clock)());
    }
}

/// A held restore pick a check or a copy is using: it is not swept for being old while this lives, and its five minutes
/// start again when it is dropped ([`Pending::use_restore_pick`]). It carries what the pick held when the use began,
/// the working credential included (shared, so a lock that drops the pick cannot pull it out from under the engine, which
/// a lock cancels at once).
pub struct RestorePickUse<'a> {
    pending: &'a Pending,
    token: Token,
    path: PathBuf,
    vault: Option<u32>,
    checked: Option<Checked>,
    clock: &'a dyn Fn() -> Instant,
}

impl RestorePickUse<'_> {
    /// The backup's path: never sent to the page.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The listed vault the pick was made for, if one.
    pub fn vault(&self) -> Option<u32> {
        self.vault
    }

    /// What the last successful check found, when one has.
    pub fn checked(&self) -> Option<&Checked> {
        self.checked.as_ref()
    }

    /// Lets go of the copy of what the pick found that this use carries, the credential among it: the use goes on as a
    /// guard only (the pick is still in use, and not swept), and a long wait (a dialog) holds no secret outside the
    /// pending table, whose drain then wipes it.
    pub fn release_checked(&mut self) {
        self.checked = None;
    }

    /// Keeps `checked` in the held pick, replacing what was there. Whether the pick was still held (a lock or a forget
    /// has dropped it otherwise, and nothing is kept).
    pub fn set_checked(&self, checked: Checked) -> bool {
        self.pending.update_restore_pick(&self.token, |held| {
            *held = Some(checked);
            true
        })
    }

    /// Moves the held pick's folder, keeping the rest of what it found and the credential. Whether it could: false for a
    /// pick that is gone or not yet checked.
    pub fn set_parent(&self, parent: PathBuf, usual: bool) -> bool {
        self.pending.update_restore_pick(&self.token, |held| {
            held.as_mut().is_some_and(|checked| {
                checked.move_to(parent, usual);
                true
            })
        })
    }
}

impl Drop for RestorePickUse<'_> {
    fn drop(&mut self) {
        self.pending.end_restore_pick(&self.token, (self.clock)());
    }
}

impl Pending {
    /// Parks `choice` and returns the token that takes it back. Expired choices are dropped on the way.
    pub fn put(&self, choice: PendingChoice) -> Token {
        self.put_at(choice, Instant::now())
    }

    /// Takes the choice parked under `token`, once. `NotFound` for a token taken before, expired, or dropped by a
    /// lock. Expired choices are dropped on the way.
    pub fn take(&self, token: &Token) -> ShellResult<PendingChoice> {
        self.take_at(token, Instant::now())
    }

    /// Drops every expired choice: an unlocked vault waiting for a yes holds its key and its `.lock`, so it should
    /// not outlive its five minutes. For a periodic caller (Task 11's idle tick); `put` and `take` sweep too.
    pub fn sweep_expired(&self) {
        self.sweep_at(Instant::now());
    }

    /// Like [`put`](Self::put), for a caller holding the sessions mutex (`Sessions::open`): the expired choices are
    /// handed back, to be dropped once that mutex is released, since one may be a vault.
    pub(crate) fn park(&self, choice: PendingChoice) -> (Token, Vec<PendingChoice>) {
        self.park_at(choice, Instant::now())
    }

    /// Removes every choice, for the caller to drop.
    pub(crate) fn drain(&self) -> Vec<PendingChoice> {
        lock(&self.parked)
            .drain(..)
            .map(|parked| parked.choice)
            .collect()
    }

    /// Drops the pasted keys waiting for `only` (those of every session when `None`), and nothing else here: the lock
    /// hook's work, since a lock of one vault drains nothing of its own. The values are wiped as they drop, after the
    /// mutex is released.
    pub(crate) fn drop_env_pastes(&self, only: Option<SessionId>) {
        let dropped = {
            let mut parked = lock(&self.parked);
            let ours = |p: &Parked| match &p.choice {
                PendingChoice::EnvPaste { session, .. } => {
                    only.is_none_or(|locked| locked == *session)
                }
                _ => false,
            };
            let (gone, kept): (Vec<Parked>, Vec<Parked>) =
                std::mem::take(&mut *parked).into_iter().partition(ours);
            *parked = kept;
            gone
        };
        // Dropped here, with the mutex released: each value is wiped as it goes.
        drop(dropped);
    }

    /// Drops the copies waiting in a cloud folder's question for `only` (those of every session when `None`), and nothing
    /// else here: the lock hook's work, as for the pasted keys.
    pub(crate) fn drop_stored_copies(&self, only: Option<SessionId>) {
        let dropped = {
            let mut parked = lock(&self.parked);
            let ours = |p: &Parked| match &p.choice {
                PendingChoice::StoredCopy { session, .. } => {
                    only.is_none_or(|locked| locked == *session)
                }
                _ => false,
            };
            let (gone, kept): (Vec<Parked>, Vec<Parked>) =
                std::mem::take(&mut *parked).into_iter().partition(ours);
            *parked = kept;
            gone
        };
        drop(dropped);
    }

    /// Drops the files picked for `only` (those of every session when `None`), and nothing else here: the lock hook's work,
    /// as for the pasted keys.
    pub(crate) fn drop_picked_files(&self, only: Option<SessionId>) {
        let dropped = {
            let mut parked = lock(&self.parked);
            let ours = |p: &Parked| match &p.choice {
                PendingChoice::PickedFiles { session, .. } => {
                    only.is_none_or(|locked| locked == *session)
                }
                _ => false,
            };
            let (gone, kept): (Vec<Parked>, Vec<Parked>) =
                std::mem::take(&mut *parked).into_iter().partition(ours);
            *parked = kept;
            gone
        };
        drop(dropped);
    }

    /// Drops the plans and cloud questions of Save all waiting for `only` (those of every session when `None`), and
    /// nothing else here: the lock hook's work, as for the pasted keys.
    pub(crate) fn drop_save_alls(&self, only: Option<SessionId>) {
        self.drop_where(|choice| match choice {
            PendingChoice::SaveAll { session, .. } => only.is_none_or(|locked| locked == *session),
            _ => false,
        });
    }

    /// Drops the summary handles of Save all kept for `only` (those of every session when `None`), and nothing else here.
    pub(crate) fn drop_saved_folders(&self, only: Option<SessionId>) {
        self.drop_where(|choice| match choice {
            PendingChoice::SavedFolder { session, .. } => {
                only.is_none_or(|locked| locked == *session)
            }
            _ => false,
        });
    }

    /// Removes every choice `ours` accepts, and drops them with the table's lock released.
    fn drop_where(&self, ours: impl Fn(&PendingChoice) -> bool) {
        let dropped = {
            let mut parked = lock(&self.parked);
            let (gone, kept): (Vec<Parked>, Vec<Parked>) = std::mem::take(&mut *parked)
                .into_iter()
                .partition(|p| ours(&p.choice));
            *parked = kept;
            gone
        };
        drop(dropped);
    }

    /// The plan of Save all parked under `token`, read: nothing is used up and the five minutes are not lengthened.
    /// `ChoiceExpired` for a token that is not there, was used, has expired, belongs to another kind of choice or is the
    /// cloud question's (a question is no plan).
    pub fn peek_save_all(&self, token: &Token) -> ShellResult<SaveAllChoice> {
        self.peek_save_all_at(token, Instant::now())
    }

    pub(crate) fn peek_save_all_at(
        &self,
        token: &Token,
        now: Instant,
    ) -> ShellResult<SaveAllChoice> {
        self.claim_where(token, now, false, |choice| {
            SaveAllChoice::of(choice).filter(|plan| !plan.files.is_empty())
        })
    }

    /// Uses up the plan parked under `token`, once: `ChoiceExpired` as for [`peek_save_all`](Self::peek_save_all), and
    /// then nothing is changed.
    pub fn use_up_save_all(&self, token: &Token) -> ShellResult<()> {
        self.use_up_save_all_at(token, Instant::now())
    }

    pub(crate) fn use_up_save_all_at(&self, token: &Token, now: Instant) -> ShellResult<()> {
        self.claim_where(token, now, true, |choice| {
            SaveAllChoice::of(choice)
                .filter(|plan| !plan.files.is_empty())
                .map(drop)
        })
    }

    /// Takes the cloud question of Save all parked under `token`, once (the yes goes on with what it holds):
    /// `ChoiceExpired` for a token that is not there, was used, has expired, belongs to another kind of choice or is a
    /// plan's (a plan is no question), and then nothing is changed.
    pub fn take_cloud_question(&self, token: &Token) -> ShellResult<SaveAllChoice> {
        self.take_cloud_question_at(token, Instant::now())
    }

    pub(crate) fn take_cloud_question_at(
        &self,
        token: &Token,
        now: Instant,
    ) -> ShellResult<SaveAllChoice> {
        self.claim_where(token, now, true, |choice| {
            SaveAllChoice::of(choice).filter(|question| question.files.is_empty())
        })
    }

    /// The summary handle parked under `token`, read as [`peek_save_all`](Self::peek_save_all) reads a plan: the session
    /// and generation that saved the files, and the folder. `ChoiceExpired` for any other token.
    pub fn peek_saved_folder(&self, token: &Token) -> ShellResult<(SessionId, u64, PathBuf)> {
        self.peek_saved_folder_at(token, Instant::now())
    }

    pub(crate) fn peek_saved_folder_at(
        &self,
        token: &Token,
        now: Instant,
    ) -> ShellResult<(SessionId, u64, PathBuf)> {
        self.claim_where(token, now, false, |choice| match choice {
            PendingChoice::SavedFolder {
                session,
                generation,
                folder,
            } => Some((*session, *generation, folder.clone())),
            _ => None,
        })
    }

    /// Drops the summary handle parked under `token`. Nothing else is touched, and a token that is not a handle (never
    /// given, already closed, expired, a plan's) is no error: closing is idempotent.
    pub fn close_saved_folder(&self, token: &Token) {
        let _ = self.claim_where(token, Instant::now(), true, |choice| match choice {
            PendingChoice::SavedFolder { .. } => Some(()),
            _ => None,
        });
    }

    /// What `pick` makes of the choice parked under `token`, if it makes something of it; the choice is removed too when
    /// `remove`. Expired choices are dropped on the way, after the table's lock is released. A token that is not there or
    /// that `pick` has no use for is `ChoiceExpired`, with nothing changed.
    fn claim_where<R>(
        &self,
        token: &Token,
        now: Instant,
        remove: bool,
        pick: impl Fn(&PendingChoice) -> Option<R>,
    ) -> ShellResult<R> {
        let (answer, expired, removed) = {
            let mut parked = lock(&self.parked);
            let expired = take_expired(&mut parked, now);
            let hit = parked.iter().enumerate().find_map(|(at, p)| {
                let wanted = p.token.matches(token).then(|| pick(&p.choice)).flatten()?;
                Some((at, wanted))
            });
            let removed = match hit {
                Some((at, _)) if remove => Some(parked.swap_remove(at)),
                _ => None,
            };
            (hit.map(|(_, wanted)| wanted), expired, removed)
        };
        drop(expired);
        drop(removed);
        answer.ok_or(ShellError::ChoiceExpired)
    }

    /// Changes the list of picked files parked under `token` in place, for the session and generation that picked it: `f`
    /// is given the paths, and its answer is returned. The token stays, and its five minutes start again. `ChoiceExpired`
    /// for a token that is not there, is another kind of choice, or belongs to another session or generation, with
    /// nothing changed. `f` runs under the table's lock: no slow work in it.
    pub fn update_picked<R>(
        &self,
        token: &Token,
        session: SessionId,
        generation: u64,
        f: impl FnOnce(&mut Vec<PathBuf>) -> ShellResult<R>,
    ) -> ShellResult<R> {
        self.update_picked_at(token, session, generation, Instant::now(), f)
    }

    pub(crate) fn update_picked_at<R>(
        &self,
        token: &Token,
        session: SessionId,
        generation: u64,
        now: Instant,
        f: impl FnOnce(&mut Vec<PathBuf>) -> ShellResult<R>,
    ) -> ShellResult<R> {
        let (answer, expired) = {
            let mut parked = lock(&self.parked);
            let expired = take_expired(&mut parked, now);
            let answer = match find_picked(&mut parked, token, session, generation) {
                Some((until, paths)) => {
                    *until = now + LIFETIME;
                    f(paths)
                }
                None => Err(ShellError::ChoiceExpired),
            };
            (answer, expired)
        };
        drop(expired);
        answer
    }

    /// The paths of the picked files parked under `token`, as [`update_picked`](Self::update_picked) finds them, and
    /// nothing changed (the lifetime included).
    pub fn peek_picked(
        &self,
        token: &Token,
        session: SessionId,
        generation: u64,
    ) -> ShellResult<Vec<PathBuf>> {
        self.peek_picked_at(token, session, generation, Instant::now())
    }

    pub(crate) fn peek_picked_at(
        &self,
        token: &Token,
        session: SessionId,
        generation: u64,
        now: Instant,
    ) -> ShellResult<Vec<PathBuf>> {
        let (answer, expired) = {
            let mut parked = lock(&self.parked);
            let expired = take_expired(&mut parked, now);
            let answer = find_picked(&mut parked, token, session, generation)
                .map(|(_, paths)| paths.clone())
                .ok_or(ShellError::ChoiceExpired);
            (answer, expired)
        };
        drop(expired);
        answer
    }

    /// Takes the picked files parked under `token` for good, once, but only if they are still exactly `checked` (what the
    /// caller measured and checked before the job): a list changed since, a used or expired choice, or another session's
    /// or generation's is `ChoiceExpired`, and what is parked stays.
    pub fn take_picked(
        &self,
        token: &Token,
        session: SessionId,
        generation: u64,
        checked: &[PathBuf],
    ) -> ShellResult<()> {
        self.take_picked_at(token, session, generation, checked, Instant::now())
    }

    pub(crate) fn take_picked_at(
        &self,
        token: &Token,
        session: SessionId,
        generation: u64,
        checked: &[PathBuf],
        now: Instant,
    ) -> ShellResult<()> {
        let (taken, expired) = {
            let mut parked = lock(&self.parked);
            let expired = take_expired(&mut parked, now);
            let found = parked.iter().position(|p| {
                p.token.matches(token)
                    && matches!(&p.choice, PendingChoice::PickedFiles { session: s, generation: g, paths }
                        if *s == session && *g == generation && paths == checked)
            });
            (found.map(|at| parked.swap_remove(at)), expired)
        };
        drop(expired);
        taken.map(drop).ok_or(ShellError::ChoiceExpired)
    }

    /// Starts an attempt on the backup held under `token`, which must have been held in lock epoch `epoch` (the current
    /// one): its path is the answer's [`path`](HeldBackupUse::path). While the answer lives the backup is in use and no
    /// sweep (the timer's, or any put or take) drops it for being old, however long the attempt runs; when the answer is
    /// dropped its five minutes start again, by `clock`. A forget, a new pick or a lock of all vaults still drops it, in
    /// use or not. `ChoiceExpired` for a token that is not there, was used or dropped, is five minutes old and not in
    /// use, holds another kind of choice (a held open pick too) or a backup of another epoch, with nothing changed. Never
    /// the generic `NotFound`.
    pub fn use_test_backup<'a>(
        &'a self,
        token: &Token,
        epoch: u64,
        clock: &'a dyn Fn() -> Instant,
    ) -> ShellResult<HeldBackupUse<'a>> {
        self.use_held_backup(HeldBackup::Test, token, epoch, clock)
    }

    /// [`use_test_backup`](Self::use_test_backup) for the backup picked to be opened read-only (`open_backup_read_only`):
    /// the same rules, and a held test backup under the token is another kind of choice (`ChoiceExpired`).
    pub fn use_open_backup<'a>(
        &'a self,
        token: &Token,
        epoch: u64,
        clock: &'a dyn Fn() -> Instant,
    ) -> ShellResult<HeldBackupUse<'a>> {
        self.use_held_backup(HeldBackup::Open, token, epoch, clock)
    }

    fn use_held_backup<'a>(
        &'a self,
        kind: HeldBackup,
        token: &Token,
        epoch: u64,
        clock: &'a dyn Fn() -> Instant,
    ) -> ShellResult<HeldBackupUse<'a>> {
        let now = clock();
        let (answer, expired) = {
            let mut parked = lock(&self.parked);
            let expired = take_expired(&mut parked, now);
            let answer = parked
                .iter_mut()
                .find_map(|p| match kind.of(&p.choice) {
                    Some((path, held)) if held == epoch && p.token.matches(token) => {
                        let path = path.to_path_buf();
                        p.until = now + LIFETIME;
                        p.in_use += 1;
                        Some(path)
                    }
                    _ => None,
                })
                .ok_or(ShellError::ChoiceExpired);
            (answer, expired)
        };
        drop(expired);
        answer.map(|path| HeldBackupUse {
            pending: self,
            kind,
            token: Token(token.0.clone()),
            path,
            clock,
        })
    }

    /// The end of an attempt ([`HeldBackupUse`] dropped): one less in use, and five minutes from `now`. Nothing for a
    /// choice a forget or a lock has dropped since.
    fn end_held_backup(&self, kind: HeldBackup, token: &Token, now: Instant) {
        let mut parked = lock(&self.parked);
        if let Some(p) = parked
            .iter_mut()
            .find(|p| p.token.matches(token) && kind.of(&p.choice).is_some())
        {
            p.in_use = p.in_use.saturating_sub(1);
            p.until = now + LIFETIME;
        }
    }

    /// Starts a use of the restore pick held under `token`, which must have been held in lock epoch `epoch` (the current
    /// one), as [`use_test_backup`](Self::use_test_backup) does for a held test backup: its path and what it found
    /// so far are the answer's, it is in use (no sweep drops it for being old) until the answer is dropped, and its five
    /// minutes start again then, by `clock`. A forget, a new pick or a lock of all vaults still drops it, in use or not.
    /// `ChoiceExpired` for a token that is not there, was dropped, is five minutes old and not in use, holds another kind
    /// of choice (a held test backup too) or a pick of another epoch, with nothing changed. Never the generic `NotFound`.
    pub fn use_restore_pick<'a>(
        &'a self,
        token: &Token,
        epoch: u64,
        clock: &'a dyn Fn() -> Instant,
    ) -> ShellResult<RestorePickUse<'a>> {
        let now = clock();
        let (answer, expired) = {
            let mut parked = lock(&self.parked);
            let expired = take_expired(&mut parked, now);
            let answer = parked
                .iter_mut()
                .find_map(|p| match &p.choice {
                    PendingChoice::RestorePick {
                        path,
                        epoch: held,
                        vault,
                        checked,
                    } if *held == epoch && p.token.matches(token) => {
                        let found = (path.clone(), *vault, checked.clone());
                        p.until = now + LIFETIME;
                        p.in_use += 1;
                        Some(found)
                    }
                    _ => None,
                })
                .ok_or(ShellError::ChoiceExpired);
            (answer, expired)
        };
        drop(expired);
        answer.map(|(path, vault, checked)| RestorePickUse {
            pending: self,
            token: Token(token.0.clone()),
            path,
            vault,
            checked,
            clock,
        })
    }

    /// The end of a use ([`RestorePickUse`] dropped): one less in use, and five minutes from `now`. Nothing for a pick a
    /// forget or a lock has dropped since.
    fn end_restore_pick(&self, token: &Token, now: Instant) {
        let mut parked = lock(&self.parked);
        if let Some(p) = parked.iter_mut().find(|p| {
            p.token.matches(token) && matches!(p.choice, PendingChoice::RestorePick { .. })
        }) {
            p.in_use = p.in_use.saturating_sub(1);
            p.until = now + LIFETIME;
        }
    }

    /// Changes what the restore pick held under `token` found, in place: `change` is given it, and its answer (whether it
    /// changed anything) is returned; false for a pick that is not there. Under the table's lock: nothing slow in it.
    fn update_restore_pick(
        &self,
        token: &Token,
        change: impl FnOnce(&mut Option<Checked>) -> bool,
    ) -> bool {
        let mut parked = lock(&self.parked);
        let held = parked.iter_mut().find_map(|p| match &mut p.choice {
            PendingChoice::RestorePick { checked, .. } if p.token.matches(token) => Some(checked),
            _ => None,
        });
        held.is_some_and(change)
    }

    /// Drops the restore pick held under `token`, and nothing else: a token that is not there, was dropped already, or
    /// holds another kind of choice (a held test backup included) is left alone, with no error (forgetting is
    /// idempotent). What it held, the credential among it, is wiped as it drops, with the table's lock released.
    pub fn forget_restore_pick(&self, token: &Token) {
        let gone = {
            let mut parked = lock(&self.parked);
            let found = parked.iter().position(|p| {
                p.token.matches(token) && matches!(p.choice, PendingChoice::RestorePick { .. })
            });
            found.map(|at| parked.swap_remove(at))
        };
        drop(gone);
    }

    /// What the recovery choice held under `token` is for, without taking it or starting its five minutes again: the
    /// row of its vault on the list and whether its header failed the MAC. `None` for a token that is not there, was
    /// dropped, is five minutes old or holds another kind of choice, which is left alone.
    pub fn recovery_of(&self, token: &Token) -> Option<(VaultRef, bool)> {
        self.recovery_of_at(token, Instant::now())
    }

    fn recovery_of_at(&self, token: &Token, now: Instant) -> Option<(VaultRef, bool)> {
        let (found, expired) = {
            let mut parked = lock(&self.parked);
            let expired = take_expired(&mut parked, now);
            let found = parked.iter().find_map(|p| match &p.choice {
                PendingChoice::Recovery(held) if p.token.matches(token) => {
                    Some((held.vault, held.header_changed))
                }
                _ => None,
            });
            (found, expired)
        };
        drop(expired);
        found
    }

    /// Drops the recovery choice held under `token`, and nothing else: a token that is not there, was dropped already
    /// or holds another kind of choice is left alone, with no error (forgetting is idempotent). The key is wiped as it
    /// drops, with the table's lock released.
    pub fn forget_recovery(&self, token: &Token) {
        let gone = {
            let mut parked = lock(&self.parked);
            let found = parked.iter().position(|p| {
                p.token.matches(token) && matches!(p.choice, PendingChoice::Recovery(_))
            });
            found.map(|at| parked.swap_remove(at))
        };
        drop(gone);
    }

    /// Drops the backup held under `token`, and nothing else: a token that is not there, was dropped already, or holds
    /// another kind of choice is left alone, with no error (forgetting is idempotent).
    pub fn forget_test_backup(&self, token: &Token) {
        self.forget_held_backup(HeldBackup::Test, token);
    }

    /// [`forget_test_backup`](Self::forget_test_backup) for the backup picked to be opened read-only: a held test backup,
    /// or any other kind of choice, under the token is left alone.
    pub fn forget_open_backup(&self, token: &Token) {
        self.forget_held_backup(HeldBackup::Open, token);
    }

    fn forget_held_backup(&self, kind: HeldBackup, token: &Token) {
        let gone = {
            let mut parked = lock(&self.parked);
            let found = parked
                .iter()
                .position(|p| p.token.matches(token) && kind.of(&p.choice).is_some());
            found.map(|at| parked.swap_remove(at))
        };
        drop(gone);
    }

    fn park_at(&self, choice: PendingChoice, now: Instant) -> (Token, Vec<PendingChoice>) {
        let token = Token::random();
        let mut parked = lock(&self.parked);
        let expired = take_expired(&mut parked, now);
        parked.push(Parked {
            token: Token(token.0.clone()),
            until: now + LIFETIME,
            in_use: 0,
            choice,
        });
        (token, expired)
    }

    /// Like [`put`](Self::put), with the time of the caller's own clock (the shell's, which a test moves).
    pub(crate) fn put_at(&self, choice: PendingChoice, now: Instant) -> Token {
        // The expired choices are dropped here, after the lock is released.
        let (token, _expired) = self.park_at(choice, now);
        token
    }

    /// Like [`take`](Self::take), for a caller holding the sessions mutex (`Sessions::open_choice`): the choice
    /// parked under `token` (`None` for a token taken before, expired, or dropped by a lock) and the expired choices
    /// are handed back, to be dropped (whatever the caller does not keep) once that mutex is released.
    pub(crate) fn claim(&self, token: &Token) -> (Option<PendingChoice>, Vec<PendingChoice>) {
        self.claim_at(token, Instant::now())
    }

    fn claim_at(&self, token: &Token, now: Instant) -> (Option<PendingChoice>, Vec<PendingChoice>) {
        let mut parked = lock(&self.parked);
        let expired = take_expired(&mut parked, now);
        let found = parked
            .iter()
            .position(|p| p.token.matches(token))
            .map(|at| parked.swap_remove(at).choice);
        drop(parked);
        #[cfg(test)]
        self.run_after_take();
        (found, expired)
    }

    fn take_at(&self, token: &Token, now: Instant) -> ShellResult<PendingChoice> {
        let (found, expired) = self.claim_at(token, now);
        // The expired choices close here, with no lock held.
        drop(expired);
        found.ok_or(ShellError::NotFound)
    }

    /// Tests only: runs `hook` once, right after the next take removes its choice.
    #[cfg(test)]
    pub(crate) fn after_take(&self, hook: Box<dyn FnOnce() + Send>) {
        *lock(&self.after_take) = Some(hook);
    }

    #[cfg(test)]
    fn run_after_take(&self) {
        let hook = lock(&self.after_take).take();
        if let Some(hook) = hook {
            hook();
        }
    }

    /// [`sweep_expired`](Self::sweep_expired) at `now`: the auto-lock's tick passes its own time.
    pub(crate) fn sweep_at(&self, now: Instant) {
        let expired = take_expired(&mut lock(&self.parked), now);
        drop(expired);
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        lock(&self.parked).len()
    }
}

/// The picked files parked under `token` for `session` in `generation`: when they expire and their paths. Nothing for a
/// token that is not there, another kind of choice, or another session or generation.
fn find_picked<'a>(
    parked: &'a mut [Parked],
    token: &Token,
    session: SessionId,
    generation: u64,
) -> Option<(&'a mut Instant, &'a mut Vec<PathBuf>)> {
    parked.iter_mut().find_map(|p| match &mut p.choice {
        PendingChoice::PickedFiles {
            session: s,
            generation: g,
            paths,
        } if *s == session && *g == generation && p.token.matches(token) => {
            Some((&mut p.until, paths))
        }
        _ => None,
    })
}

/// Takes the expired choices out of `parked`, for the caller to drop after releasing its lock. A held backup (a test's or a
/// restore's) a use is running on is not expired, whatever its age.
fn take_expired(parked: &mut Vec<Parked>, now: Instant) -> Vec<PendingChoice> {
    let (expired, live): (Vec<Parked>, Vec<Parked>) = std::mem::take(parked)
        .into_iter()
        .partition(|p| p.in_use == 0 && p.until <= now);
    *parked = live;
    expired.into_iter().map(|p| p.choice).collect()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    fn marker() -> (Arc<AtomicBool>, PendingChoice) {
        let dropped = Arc::new(AtomicBool::new(false));
        (dropped.clone(), PendingChoice::Marker(DropMarker(dropped)))
    }

    /// Fix round 1: an expired choice (it may hold an unlocked vault and its `.lock`) is dropped by the next put, not
    /// only refused by a take.
    #[test]
    fn expired_choice_dropped_on_next_put() {
        let pending = Pending::default();
        let now = Instant::now();
        let (dropped, choice) = marker();
        pending.put_at(choice, now);
        pending.put_at(
            PendingChoice::Test(None),
            now + LIFETIME - Duration::from_secs(1),
        );
        assert!(!dropped.load(Ordering::SeqCst), "not expired yet");
        pending.put_at(PendingChoice::Test(None), now + LIFETIME);
        assert!(dropped.load(Ordering::SeqCst), "the next put dropped it");
        assert_eq!(pending.len(), 2);
    }

    #[test]
    fn sweep_drops_expired_choices() {
        let pending = Pending::default();
        let now = Instant::now();
        let (dropped, choice) = marker();
        pending.put_at(choice, now);
        pending.sweep_at(now + LIFETIME - Duration::from_secs(1));
        assert!(!dropped.load(Ordering::SeqCst), "not expired yet");
        pending.sweep_at(now + LIFETIME);
        assert!(dropped.load(Ordering::SeqCst), "the sweep dropped it");
        assert_eq!(pending.len(), 0);
    }

    fn paste_of(session: u64) -> PendingChoice {
        PendingChoice::EnvPaste {
            session: SessionId(session),
            generation: 1,
            entries: vec![EnvEntry {
                name: "API_KEY".to_owned(),
                value: Zeroizing::new("made-up-value".to_owned()),
            }],
            source: Zeroizing::new("API_KEY=made-up-value".to_owned()),
            shown: ShownNames::new(),
        }
    }

    /// A lock of one vault drops the pasted keys of that vault and nothing else: another vault's paste and every other
    /// kind of waiting choice stay; a lock of all drops every paste (the choices of other kinds are Lock all's own).
    #[test]
    fn drop_env_pastes_takes_one_sessions_and_only_pastes() {
        let pending = Pending::default();
        let first = pending.put(paste_of(1));
        let second = pending.put(paste_of(2));
        let (dropped, marker) = marker();
        pending.put(marker);

        pending.drop_env_pastes(Some(SessionId(1)));
        assert_eq!(pending.len(), 2);
        assert!(!dropped.load(Ordering::SeqCst), "another kind stays");
        assert!(matches!(pending.take(&first), Err(ShellError::NotFound)));
        assert!(pending.take(&second).is_ok(), "the other session's stays");

        let third = pending.put(paste_of(3));
        pending.drop_env_pastes(None);
        assert_eq!(pending.len(), 1);
        assert!(!dropped.load(Ordering::SeqCst));
        assert!(matches!(pending.take(&third), Err(ShellError::NotFound)));
    }

    fn picked(session: u64, generation: u64, names: &[&str]) -> PendingChoice {
        PendingChoice::PickedFiles {
            session: SessionId(session),
            generation,
            paths: names.iter().map(PathBuf::from).collect(),
        }
    }

    fn paths(names: &[&str]) -> Vec<PathBuf> {
        names.iter().map(PathBuf::from).collect()
    }

    /// Picked files are kept under one token: updating them in place keeps the token, answers `ChoiceExpired` for a token
    /// that is not there or belongs to another session or generation, and changes nothing then.
    #[test]
    fn picked_files_update_in_place_for_their_own_session_only() {
        let pending = Pending::default();
        let now = Instant::now();
        let token = pending.put_at(picked(1, 1, &["a"]), now);
        let added = pending.update_picked_at(&token, SessionId(1), 1, now, |list| {
            list.push(PathBuf::from("b"));
            Ok(list.len())
        });
        assert_eq!(added, Ok(2));
        for (session, generation) in [(2, 1), (1, 2)] {
            let refused =
                pending.update_picked_at(&token, SessionId(session), generation, now, |list| {
                    list.clear();
                    Ok(())
                });
            assert_eq!(refused, Err(ShellError::ChoiceExpired));
        }
        let other = Token::random();
        assert_eq!(
            pending.update_picked_at(&other, SessionId(1), 1, now, |_| Ok(())),
            Err(ShellError::ChoiceExpired)
        );
        assert_eq!(
            pending.peek_picked_at(&token, SessionId(1), 1, now),
            Ok(paths(&["a", "b"]))
        );
        assert_eq!(pending.len(), 1);
        // A choice of another kind is no picked list.
        let test = pending.put_at(PendingChoice::Test(None), now);
        assert_eq!(
            pending.peek_picked_at(&test, SessionId(1), 1, now),
            Err(ShellError::ChoiceExpired)
        );
    }

    /// Updating the list starts its five minutes again; one not touched for five minutes is gone.
    #[test]
    fn picked_files_lifetime_restarts_with_each_update() {
        let pending = Pending::default();
        let now = Instant::now();
        let token = pending.put_at(picked(1, 1, &["a"]), now);
        let at = now + LIFETIME - Duration::from_secs(1);
        pending
            .update_picked_at(&token, SessionId(1), 1, at, |_| Ok(()))
            .unwrap();
        // Past the first five minutes, inside the second's.
        let later = now + LIFETIME + Duration::from_secs(10);
        assert_eq!(
            pending.peek_picked_at(&token, SessionId(1), 1, later),
            Ok(paths(&["a"]))
        );
        let expired = at + LIFETIME;
        assert_eq!(
            pending.update_picked_at(&token, SessionId(1), 1, expired, |_| Ok(())),
            Err(ShellError::ChoiceExpired)
        );
        assert_eq!(pending.len(), 0, "an expired list is dropped");
    }

    /// The list is taken once, and only as it was checked: a changed list, another session's or generation's token, or a
    /// second take is refused, and a refusal leaves what is there.
    #[test]
    fn picked_files_are_taken_once_and_only_as_checked() {
        let pending = Pending::default();
        let now = Instant::now();
        let token = pending.put_at(picked(1, 1, &["a", "b"]), now);
        let checked = paths(&["a", "b"]);
        for (session, generation, list) in [
            (2, 1, checked.clone()),
            (1, 2, checked.clone()),
            (1, 1, paths(&["a"])),
        ] {
            assert_eq!(
                pending.take_picked_at(&token, SessionId(session), generation, &list, now),
                Err(ShellError::ChoiceExpired)
            );
            assert_eq!(pending.len(), 1);
        }
        assert_eq!(
            pending.take_picked_at(&token, SessionId(1), 1, &checked, now),
            Ok(())
        );
        assert_eq!(pending.len(), 0);
        assert_eq!(
            pending.take_picked_at(&token, SessionId(1), 1, &checked, now),
            Err(ShellError::ChoiceExpired)
        );
    }

    /// A lock of one vault drops that vault's picked files and nothing else; a lock of all drops every list.
    #[test]
    fn drop_picked_files_takes_one_sessions_and_only_picks() {
        let pending = Pending::default();
        let first = pending.put(picked(1, 1, &["a"]));
        let second = pending.put(picked(2, 1, &["b"]));
        let (dropped, marker) = marker();
        pending.put(marker);

        pending.drop_picked_files(Some(SessionId(1)));
        assert_eq!(pending.len(), 2);
        assert!(!dropped.load(Ordering::SeqCst), "another kind stays");
        assert!(pending.peek_picked(&first, SessionId(1), 1).is_err());
        assert!(pending.peek_picked(&second, SessionId(2), 1).is_ok());

        pending.drop_picked_files(None);
        assert_eq!(pending.len(), 1);
        assert!(pending.peek_picked(&second, SessionId(2), 1).is_err());
    }

    fn plan(session: u64, generation: u64, files: usize) -> PendingChoice {
        PendingChoice::SaveAll {
            session: SessionId(session),
            generation,
            folder: ItemId::random(),
            dest: PathBuf::from("out"),
            files: (0..files)
                .map(|_| (ItemId::random(), FileId::random()))
                .collect(),
        }
    }

    fn handle(session: u64, generation: u64) -> PendingChoice {
        PendingChoice::SavedFolder {
            session: SessionId(session),
            generation,
            folder: PathBuf::from("out"),
        }
    }

    /// A plan of Save all is read without being used or lengthened, used up once by the start, and told apart from the
    /// cloud question that is parked as the same variant with no files: each answers `ChoiceExpired` for the other's token,
    /// for a token of another kind, for one used, one never given and one that has waited five minutes, and a refusal
    /// leaves what is parked.
    #[test]
    fn a_plan_and_its_cloud_question_are_told_apart_and_used_once() {
        let pending = Pending::default();
        let now = Instant::now();
        let planned = pending.put_at(plan(1, 3, 2), now);
        let asked = pending.put_at(plan(1, 3, 0), now);
        let test = pending.put_at(PendingChoice::Test(None), now);
        let made_up = Token::random();

        let read = pending.peek_save_all_at(&planned, now).unwrap();
        assert_eq!(
            (read.session, read.generation, read.files.len()),
            (SessionId(1), 3, 2)
        );
        // The question is no plan, a plan is no question, and neither is another kind.
        for token in [&asked, &test, &made_up] {
            assert_eq!(
                pending.peek_save_all_at(token, now).err(),
                Some(ShellError::ChoiceExpired)
            );
            assert_eq!(
                pending.use_up_save_all_at(token, now).err(),
                Some(ShellError::ChoiceExpired)
            );
        }
        for token in [&planned, &test, &made_up] {
            assert_eq!(
                pending.take_cloud_question_at(token, now).err(),
                Some(ShellError::ChoiceExpired)
            );
        }
        assert_eq!(pending.len(), 3, "a refusal uses nothing up");

        // Reading does not lengthen the five minutes.
        assert!(
            pending
                .peek_save_all_at(&planned, now + LIFETIME - Duration::from_secs(1))
                .is_ok()
        );
        assert_eq!(
            pending.peek_save_all_at(&planned, now + LIFETIME).err(),
            Some(ShellError::ChoiceExpired)
        );
        assert_eq!(pending.len(), 0, "an expired choice is dropped");

        let planned = pending.put_at(plan(1, 3, 2), now);
        let asked = pending.put_at(plan(2, 4, 0), now);
        assert!(pending.use_up_save_all_at(&planned, now).is_ok());
        assert_eq!(
            pending.use_up_save_all_at(&planned, now).err(),
            Some(ShellError::ChoiceExpired)
        );
        let question = pending.take_cloud_question_at(&asked, now).unwrap();
        assert_eq!((question.session, question.generation), (SessionId(2), 4));
        assert_eq!(
            pending.take_cloud_question_at(&asked, now).err(),
            Some(ShellError::ChoiceExpired)
        );
        assert_eq!(pending.len(), 0);
    }

    /// The summary's handle is read without being used or lengthened, closed by `close_saved_folder` (and closing a
    /// handle that is not there is no error), and no other kind of token reads as one.
    #[test]
    fn a_saved_folder_handle_is_read_not_used_and_closed_once() {
        let pending = Pending::default();
        let now = Instant::now();
        let token = pending.put_at(handle(1, 2), now);
        let other = pending.put_at(plan(1, 2, 1), now);
        for _ in 0..3 {
            let (session, generation, folder) = pending.peek_saved_folder_at(&token, now).unwrap();
            assert_eq!(
                (session, generation, folder),
                (SessionId(1), 2, PathBuf::from("out"))
            );
        }
        assert_eq!(
            pending.peek_saved_folder_at(&other, now).err(),
            Some(ShellError::ChoiceExpired)
        );
        assert_eq!(pending.len(), 2);

        let closed = pending.put_at(handle(1, 2), now);
        pending.close_saved_folder(&closed);
        pending.close_saved_folder(&closed);
        pending.close_saved_folder(&other);
        assert_eq!(
            pending.peek_saved_folder_at(&closed, now).err(),
            Some(ShellError::ChoiceExpired)
        );
        assert!(
            pending.peek_save_all_at(&other, now).is_ok(),
            "closing a handle never closes another kind of choice"
        );
        // Five minutes after it was made, a handle is gone.
        assert_eq!(
            pending.peek_saved_folder_at(&token, now + LIFETIME).err(),
            Some(ShellError::ChoiceExpired)
        );
    }

    /// A lock of one vault drops that vault's plans, cloud questions and summary handles and nothing else; a lock of all
    /// drops every one.
    #[test]
    fn drop_save_alls_and_saved_folders_take_one_session_and_only_those() {
        let pending = Pending::default();
        let first = pending.put(plan(1, 1, 2));
        let second = pending.put(plan(2, 1, 2));
        let asked = pending.put(plan(1, 1, 0));
        let shown = pending.put(handle(1, 1));
        let theirs = pending.put(handle(2, 1));
        let (dropped, marker) = marker();
        pending.put(marker);

        pending.drop_save_alls(Some(SessionId(1)));
        assert_eq!(pending.len(), 4);
        assert!(pending.peek_save_all(&first).is_err());
        assert!(pending.take_cloud_question(&asked).is_err());
        assert!(pending.peek_save_all(&second).is_ok());
        assert!(
            pending.peek_saved_folder(&shown).is_ok(),
            "a handle is the other drop's"
        );
        pending.drop_saved_folders(Some(SessionId(1)));
        assert!(pending.peek_saved_folder(&shown).is_err());
        assert!(pending.peek_saved_folder(&theirs).is_ok());
        assert!(!dropped.load(Ordering::SeqCst), "another kind stays");

        pending.drop_save_alls(None);
        pending.drop_saved_folders(None);
        assert_eq!(pending.len(), 1);
        assert!(pending.peek_save_all(&second).is_err());
        assert!(pending.peek_saved_folder(&theirs).is_err());
        assert!(!dropped.load(Ordering::SeqCst));
    }

    fn held(epoch: u64) -> PendingChoice {
        PendingChoice::TestBackup {
            path: PathBuf::from("a.petalock-backup"),
            epoch,
        }
    }

    /// A held backup is used by its own token in the epoch it was held in, and by nothing else: another kind of choice
    /// under the token, a token that is not there and another epoch's choice answer `ChoiceExpired` (never `NotFound`),
    /// and what is parked stays.
    #[test]
    fn a_held_backup_is_used_by_its_token_and_epoch_only() {
        let pending = Pending::default();
        let now = Instant::now();
        let token = pending.put_at(held(3), now);
        let other = pending.put_at(picked(1, 1, &["a"]), now);
        assert_eq!(
            used(&pending, &token, 3, now),
            Ok(PathBuf::from("a.petalock-backup"))
        );
        assert_eq!(
            used(&pending, &token, 4, now),
            Err(ShellError::ChoiceExpired)
        );
        assert_eq!(
            used(&pending, &other, 3, now),
            Err(ShellError::ChoiceExpired)
        );
        assert_eq!(
            used(&pending, &Token::random(), 3, now),
            Err(ShellError::ChoiceExpired)
        );
        assert_eq!(pending.len(), 2, "nothing was taken");
        assert!(pending.take_at(&token, now).is_ok());
        assert_eq!(
            used(&pending, &token, 3, now),
            Err(ShellError::ChoiceExpired)
        );
    }

    /// One whole attempt on the held backup at `now`: begun and ended at the same moment.
    fn used(pending: &Pending, token: &Token, epoch: u64, now: Instant) -> ShellResult<PathBuf> {
        let clock = || now;
        pending
            .use_test_backup(token, epoch, &clock)
            .map(|attempt| attempt.path().to_path_buf())
    }

    /// Fix round 2: a held backup an attempt is using is not swept, however long the attempt runs (a sweep from the
    /// timer, or any put or take, finds it in use), and its five minutes start again when the attempt ends. Only after
    /// that does it expire. A use that was refused holds nothing.
    #[test]
    fn a_held_backup_in_use_is_not_swept_and_restarts_when_the_attempt_ends() {
        let pending = Pending::default();
        let now = Instant::now();
        let token = pending.put_at(held(1), now);
        let time = std::cell::Cell::new(now);
        let clock = || time.get();

        let attempt = pending.use_test_backup(&token, 1, &clock).unwrap();
        time.set(now + LIFETIME + Duration::from_secs(60));
        pending.sweep_at(time.get());
        assert_eq!(pending.len(), 1, "swept while in use");
        let other = pending.put_at(PendingChoice::Test(None), time.get());
        assert_eq!(pending.len(), 2, "a put swept it while in use");
        assert!(pending.take_at(&other, time.get()).is_ok());
        assert_eq!(pending.len(), 1, "a take swept it while in use");

        time.set(time.get() + Duration::from_secs(60));
        let ended = time.get();
        drop(attempt);
        pending.sweep_at(ended + LIFETIME - Duration::from_secs(1));
        assert_eq!(pending.len(), 1, "five minutes from the end");
        assert_eq!(
            used(
                &pending,
                &token,
                1,
                ended + LIFETIME - Duration::from_secs(1)
            ),
            Ok(PathBuf::from("a.petalock-backup")),
            "still there to try again"
        );
        let again = ended + LIFETIME - Duration::from_secs(1) + LIFETIME;
        pending.sweep_at(again);
        assert_eq!(pending.len(), 0, "five minutes after the last use");
        assert_eq!(
            used(&pending, &token, 1, again),
            Err(ShellError::ChoiceExpired)
        );

        // A refused use (another epoch) holds nothing: it expires on time.
        let stray = pending.put_at(held(1), again);
        assert!(used(&pending, &stray, 2, again).is_err());
        pending.sweep_at(again + LIFETIME);
        assert_eq!(pending.len(), 0);
    }

    /// Two attempts at once keep the hold until the last one ends.
    #[test]
    fn a_held_backup_stays_while_any_attempt_uses_it() {
        let pending = Pending::default();
        let now = Instant::now();
        let token = pending.put_at(held(1), now);
        let time = std::cell::Cell::new(now);
        let clock = || time.get();
        let first = pending.use_test_backup(&token, 1, &clock).unwrap();
        let second = pending.use_test_backup(&token, 1, &clock).unwrap();
        time.set(now + LIFETIME * 2);
        drop(first);
        time.set(now + LIFETIME * 4);
        pending.sweep_at(time.get());
        assert_eq!(pending.len(), 1, "the second attempt still runs");
        drop(second);
        pending.sweep_at(time.get() + LIFETIME);
        assert_eq!(pending.len(), 0);
    }

    /// Being in use does not keep a choice against a forget or a lock of all vaults, and the attempt's end then
    /// brings nothing back.
    #[test]
    fn a_held_backup_in_use_is_still_forgotten_and_drained() {
        let pending = Pending::default();
        let now = Instant::now();
        let clock = || now;

        let token = pending.put_at(held(1), now);
        let attempt = pending.use_test_backup(&token, 1, &clock).unwrap();
        pending.forget_test_backup(&token);
        assert_eq!(pending.len(), 0);
        drop(attempt);
        assert_eq!(pending.len(), 0, "the end of the attempt brought it back");

        let token = pending.put_at(held(1), now);
        let attempt = pending.use_test_backup(&token, 1, &clock).unwrap();
        drop(pending.drain());
        assert_eq!(pending.len(), 0);
        drop(attempt);
        assert_eq!(
            used(&pending, &token, 1, now),
            Err(ShellError::ChoiceExpired)
        );
    }

    /// Each use starts the five minutes again, so someone retrying passwords is not timed out; one left alone for five
    /// minutes is gone.
    #[test]
    fn a_held_backups_lifetime_restarts_with_each_use() {
        let pending = Pending::default();
        let now = Instant::now();
        let token = pending.put_at(held(1), now);
        let at = now + LIFETIME - Duration::from_secs(1);
        assert!(used(&pending, &token, 1, at).is_ok());
        let later = now + LIFETIME + Duration::from_secs(10);
        assert!(used(&pending, &token, 1, later).is_ok());
        let expired = later + LIFETIME;
        assert_eq!(
            used(&pending, &token, 1, expired),
            Err(ShellError::ChoiceExpired)
        );
        assert_eq!(pending.len(), 0, "an expired one is dropped");
    }

    /// Forgetting drops a held backup and only that: another kind of choice under the token stays, and an unknown or
    /// already-dropped token is nothing to forget, with no error.
    #[test]
    fn forget_test_backup_drops_only_a_held_backup() {
        let pending = Pending::default();
        let now = Instant::now();
        let token = pending.put_at(held(1), now);
        let other = pending.put_at(picked(1, 1, &["a"]), now);
        pending.forget_test_backup(&other);
        assert_eq!(pending.len(), 2);
        pending.forget_test_backup(&token);
        assert_eq!(pending.len(), 1);
        pending.forget_test_backup(&token);
        pending.forget_test_backup(&Token::random());
        assert_eq!(pending.len(), 1);
        assert!(pending.peek_picked(&other, SessionId(1), 1).is_ok());
    }

    /// A lock of one vault leaves a held backup alone (it has no vault); a lock of all vaults drains it with the rest.
    #[test]
    fn locking_one_vault_leaves_a_held_backup_and_draining_drops_it() {
        let pending = Pending::default();
        let token = pending.put(held(1));
        pending.drop_env_pastes(Some(SessionId(1)));
        pending.drop_stored_copies(Some(SessionId(1)));
        pending.drop_picked_files(Some(SessionId(1)));
        let now = Instant::now();
        assert!(used(&pending, &token, 1, now).is_ok());
        drop(pending.drain());
        assert_eq!(
            used(&pending, &token, 1, now),
            Err(ShellError::ChoiceExpired)
        );
    }

    fn held_open(epoch: u64) -> PendingChoice {
        PendingChoice::OpenBackup {
            path: PathBuf::from("b.petalock-backup"),
            epoch,
        }
    }

    /// One whole attempt on the held open pick at `now`: begun and ended at the same moment.
    fn open_used(
        pending: &Pending,
        token: &Token,
        epoch: u64,
        now: Instant,
    ) -> ShellResult<PathBuf> {
        let clock = || now;
        pending
            .use_open_backup(token, epoch, &clock)
            .map(|attempt| attempt.path().to_path_buf())
    }

    /// A held open pick is used by its own token in the epoch it was held in, and by nothing else: a held test backup
    /// under the token (and the other way round), another kind, a token that is not there and another epoch's pick
    /// answer `ChoiceExpired` (never `NotFound`), and what is parked stays.
    #[test]
    fn a_held_open_backup_is_used_by_its_token_and_epoch_only() {
        let pending = Pending::default();
        let now = Instant::now();
        let open = pending.put_at(held_open(3), now);
        let test = pending.put_at(held(3), now);
        let other = pending.put_at(picked(1, 1, &["a"]), now);
        assert_eq!(
            open_used(&pending, &open, 3, now),
            Ok(PathBuf::from("b.petalock-backup"))
        );
        for (token, epoch) in [(&open, 4), (&test, 3), (&other, 3), (&Token::random(), 3)] {
            assert_eq!(
                open_used(&pending, token, epoch, now),
                Err(ShellError::ChoiceExpired)
            );
        }
        assert_eq!(
            used(&pending, &open, 3, now),
            Err(ShellError::ChoiceExpired),
            "an open pick is no test pick"
        );
        assert_eq!(pending.len(), 3, "nothing was taken");
        assert!(pending.take_at(&open, now).is_ok());
        assert_eq!(
            open_used(&pending, &open, 3, now),
            Err(ShellError::ChoiceExpired)
        );
    }

    /// An attempt in use is not swept, however long it runs, and its five minutes start again when it ends; each use
    /// restarts them; a forget or a lock of all vaults still drops it in use, and the end brings nothing back.
    #[test]
    fn a_held_open_backup_in_use_is_not_swept_and_restarts_when_the_attempt_ends() {
        let pending = Pending::default();
        let now = Instant::now();
        let token = pending.put_at(held_open(1), now);
        let time = std::cell::Cell::new(now);
        let clock = || time.get();

        let attempt = pending.use_open_backup(&token, 1, &clock).unwrap();
        time.set(now + LIFETIME + Duration::from_secs(60));
        pending.sweep_at(time.get());
        assert_eq!(pending.len(), 1, "swept while in use");
        time.set(time.get() + Duration::from_secs(60));
        let ended = time.get();
        drop(attempt);
        pending.sweep_at(ended + LIFETIME - Duration::from_secs(1));
        assert_eq!(pending.len(), 1, "five minutes from the end");
        let again = ended + LIFETIME - Duration::from_secs(1);
        assert!(open_used(&pending, &token, 1, again).is_ok());
        pending.sweep_at(again + LIFETIME);
        assert_eq!(pending.len(), 0, "five minutes after the last use");
        assert_eq!(
            open_used(&pending, &token, 1, again + LIFETIME),
            Err(ShellError::ChoiceExpired)
        );

        let token = pending.put_at(held_open(1), again);
        let attempt = pending.use_open_backup(&token, 1, &clock).unwrap();
        pending.forget_open_backup(&token);
        assert_eq!(pending.len(), 0);
        drop(attempt);
        assert_eq!(pending.len(), 0, "the end of the attempt brought it back");

        let token = pending.put_at(held_open(1), again);
        let attempt = pending.use_open_backup(&token, 1, &clock).unwrap();
        drop(pending.drain());
        drop(attempt);
        assert_eq!(
            open_used(&pending, &token, 1, again),
            Err(ShellError::ChoiceExpired)
        );
    }

    /// Forgetting drops a held open pick and only that: a held test backup, a restore pick or another kind of choice under
    /// the token stays, and an unknown or dropped token is nothing to forget, with no error. And the other kinds' forgets
    /// leave an open pick where it is.
    #[test]
    fn forget_open_backup_drops_only_a_held_open_backup() {
        let pending = Pending::default();
        let now = Instant::now();
        let open = pending.put_at(held_open(1), now);
        let test = pending.put_at(held(1), now);
        let restore = pending.put_at(restore_pick(1), now);
        let other = pending.put_at(picked(1, 1, &["a"]), now);
        for token in [&test, &restore, &other] {
            pending.forget_open_backup(token);
        }
        assert_eq!(pending.len(), 4);
        pending.forget_test_backup(&open);
        pending.forget_restore_pick(&open);
        assert_eq!(pending.len(), 4, "the other kinds' forgets");
        pending.forget_open_backup(&open);
        assert_eq!(pending.len(), 3);
        pending.forget_open_backup(&open);
        pending.forget_open_backup(&Token::random());
        assert_eq!(pending.len(), 3);
        assert!(pending.peek_picked(&other, SessionId(1), 1).is_ok());
    }

    /// A lock of one vault leaves a held open pick alone (it has no vault); a lock of all vaults drains it with the rest.
    #[test]
    fn locking_one_vault_leaves_a_held_open_backup_and_draining_drops_it() {
        let pending = Pending::default();
        let token = pending.put(held_open(1));
        pending.drop_env_pastes(Some(SessionId(1)));
        pending.drop_stored_copies(Some(SessionId(1)));
        pending.drop_picked_files(Some(SessionId(1)));
        pending.drop_save_alls(Some(SessionId(1)));
        pending.drop_saved_folders(Some(SessionId(1)));
        let now = Instant::now();
        assert!(open_used(&pending, &token, 1, now).is_ok());
        drop(pending.drain());
        assert_eq!(
            open_used(&pending, &token, 1, now),
            Err(ShellError::ChoiceExpired)
        );
    }

    fn restore_pick(epoch: u64) -> PendingChoice {
        PendingChoice::RestorePick {
            path: PathBuf::from("a.petalock-backup"),
            epoch,
            vault: None,
            checked: None,
        }
    }

    fn checked(parent: &str) -> crate::restore::Checked {
        crate::restore::Checked::new(
            crate::commands::backup::Typed::Password(Zeroizing::new("made-up".to_owned())),
            "Family".to_owned(),
            VaultId::random(),
            Some("2026-11-16".to_owned()),
            PathBuf::from(parent),
            true,
        )
    }

    /// One whole use of the held restore pick at `now`.
    fn restore_used(
        pending: &Pending,
        token: &Token,
        epoch: u64,
        now: Instant,
    ) -> ShellResult<PathBuf> {
        let clock = || now;
        pending
            .use_restore_pick(token, epoch, &clock)
            .map(|held| held.path().to_path_buf())
    }

    /// A held restore pick is used by its own token in the epoch it was held in, and by nothing else: another kind of
    /// choice under the token (a held test backup too), a token that is not there and another epoch's pick answer
    /// `ChoiceExpired` (never `NotFound`), and what is parked stays. The two held backups never take each other's.
    #[test]
    fn a_held_restore_pick_is_used_by_its_token_and_epoch_only() {
        let pending = Pending::default();
        let now = Instant::now();
        let token = pending.put_at(restore_pick(3), now);
        let test_pick = pending.put_at(held(3), now);
        let other = pending.put_at(picked(1, 1, &["a"]), now);
        assert_eq!(
            restore_used(&pending, &token, 3, now),
            Ok(PathBuf::from("a.petalock-backup"))
        );
        for (token, epoch) in [
            (&token, 4),
            (&test_pick, 3),
            (&other, 3),
            (&Token::random(), 3),
        ] {
            assert_eq!(
                restore_used(&pending, token, epoch, now),
                Err(ShellError::ChoiceExpired)
            );
        }
        assert_eq!(
            used(&pending, &token, 3, now),
            Err(ShellError::ChoiceExpired),
            "a restore pick is no test backup"
        );
        assert_eq!(pending.len(), 3, "nothing was taken");
        assert!(pending.take_at(&token, now).is_ok());
        assert_eq!(
            restore_used(&pending, &token, 3, now),
            Err(ShellError::ChoiceExpired)
        );
    }

    /// A held restore pick a use holds (a check, the copy) is not swept however long it runs, and its five minutes start
    /// again when the use ends; each use starts them again, and one left alone is gone. A forget or a lock still drops
    /// it in use, and the end of the use brings nothing back.
    #[test]
    fn a_held_restore_pick_in_use_is_not_swept_and_restarts_when_the_use_ends() {
        let pending = Pending::default();
        let now = Instant::now();
        let token = pending.put_at(restore_pick(1), now);
        let time = std::cell::Cell::new(now);
        let clock = || time.get();

        let held = pending.use_restore_pick(&token, 1, &clock).unwrap();
        time.set(now + LIFETIME + Duration::from_secs(60));
        pending.sweep_at(time.get());
        assert_eq!(pending.len(), 1, "swept while in use");
        let ended = time.get();
        drop(held);
        pending.sweep_at(ended + LIFETIME - Duration::from_secs(1));
        assert_eq!(pending.len(), 1, "five minutes from the end");
        let again = ended + LIFETIME - Duration::from_secs(1);
        assert!(restore_used(&pending, &token, 1, again).is_ok());
        pending.sweep_at(again + LIFETIME);
        assert_eq!(pending.len(), 0, "five minutes after the last use");

        let token = pending.put_at(restore_pick(1), again);
        let held = pending.use_restore_pick(&token, 1, &clock).unwrap();
        pending.forget_restore_pick(&token);
        drop(held);
        assert_eq!(pending.len(), 0, "the end of the use brought it back");
        let token = pending.put_at(restore_pick(1), again);
        let held = pending.use_restore_pick(&token, 1, &clock).unwrap();
        drop(pending.drain());
        drop(held);
        assert_eq!(
            restore_used(&pending, &token, 1, again),
            Err(ShellError::ChoiceExpired)
        );
    }

    /// Forgetting drops a held restore pick and only that: a held test backup under the token stays, and an unknown or
    /// already-dropped token is nothing to forget, with no error.
    #[test]
    fn forget_restore_pick_drops_only_a_restore_pick() {
        let pending = Pending::default();
        let now = Instant::now();
        let token = pending.put_at(restore_pick(1), now);
        let test_pick = pending.put_at(held(1), now);
        pending.forget_restore_pick(&test_pick);
        assert_eq!(pending.len(), 2);
        pending.forget_test_backup(&token);
        assert_eq!(pending.len(), 2, "a test backup's forget leaves a pick");
        pending.forget_restore_pick(&token);
        assert_eq!(pending.len(), 1);
        pending.forget_restore_pick(&token);
        pending.forget_restore_pick(&Token::random());
        assert_eq!(pending.len(), 1);
        assert!(used(&pending, &test_pick, 1, now).is_ok());
    }

    /// What the check found waits in the pick: put there once, replaced by the next check, its folder changed in place
    /// with the credential kept; gone with the pick (a forget, a lock), and putting it back then says so.
    #[test]
    fn the_checked_credential_waits_in_the_pick_and_goes_with_it() {
        let pending = Pending::default();
        let now = Instant::now();
        let clock = || now;
        let token = pending.put_at(restore_pick(1), now);

        let held = pending.use_restore_pick(&token, 1, &clock).unwrap();
        assert!(held.checked().is_none(), "nothing checked yet");
        assert!(!held.set_parent(PathBuf::from("early"), false), "no check");
        assert!(held.set_checked(checked("usual")));
        drop(held);

        let held = pending.use_restore_pick(&token, 1, &clock).unwrap();
        let first = held.checked().unwrap();
        assert_eq!(
            (first.name(), first.parent(), first.usual()),
            ("Family", Path::new("usual"), true)
        );
        assert!(held.set_parent(PathBuf::from("elsewhere"), false));
        drop(held);

        let held = pending.use_restore_pick(&token, 1, &clock).unwrap();
        let moved = held.checked().unwrap();
        assert_eq!(
            (moved.name(), moved.parent(), moved.usual()),
            ("Family", Path::new("elsewhere"), false),
            "the folder moved, the rest stayed"
        );
        assert!(matches!(
            moved.credential(),
            petalock_core::Credential::Password("made-up")
        ));
        // Another check replaces it.
        assert!(held.set_checked(checked("again")));
        drop(held);
        let held = pending.use_restore_pick(&token, 1, &clock).unwrap();
        assert_eq!(held.checked().unwrap().parent(), Path::new("again"));

        pending.forget_restore_pick(&token);
        assert!(!held.set_checked(checked("late")), "the pick is gone");
        assert!(!held.set_parent(PathBuf::from("late"), true));
        drop(held);
        assert_eq!(
            restore_used(&pending, &token, 1, now),
            Err(ShellError::ChoiceExpired)
        );
    }

    /// A lock of one vault leaves a held restore pick alone (it has no vault); a lock of all vaults drains it.
    #[test]
    fn locking_one_vault_leaves_a_restore_pick_and_draining_drops_it() {
        let pending = Pending::default();
        let token = pending.put(restore_pick(1));
        pending.drop_env_pastes(Some(SessionId(1)));
        pending.drop_stored_copies(Some(SessionId(1)));
        pending.drop_picked_files(Some(SessionId(1)));
        pending.drop_save_alls(Some(SessionId(1)));
        let now = Instant::now();
        assert!(restore_used(&pending, &token, 1, now).is_ok());
        drop(pending.drain());
        assert_eq!(
            restore_used(&pending, &token, 1, now),
            Err(ShellError::ChoiceExpired)
        );
    }

    /// A paste waits five minutes like every other choice.
    #[test]
    fn env_paste_expires_with_the_rest() {
        let pending = Pending::default();
        let now = Instant::now();
        let token = pending.put_at(paste_of(1), now);
        assert_eq!(pending.len(), 1);
        assert!(matches!(
            pending.take_at(&token, now + LIFETIME),
            Err(ShellError::NotFound)
        ));
        assert_eq!(pending.len(), 0, "an expired paste is dropped");
    }

    #[test]
    fn token_expires_after_five_minutes() {
        let pending = Pending::default();
        let now = Instant::now();
        let token = pending.put_at(PendingChoice::Test(None), now);
        assert!(
            pending
                .take_at(&token, now + LIFETIME - Duration::from_secs(1))
                .is_ok()
        );

        let token = pending.put_at(PendingChoice::Test(None), now);
        assert!(matches!(
            pending.take_at(&token, now + LIFETIME),
            Err(ShellError::NotFound)
        ));
        assert_eq!(pending.len(), 0, "an expired choice is dropped");
    }

    /// The row `id` on a list whose identity is 5.
    fn row(id: u32) -> VaultRef {
        VaultRef { list: 5, id }
    }

    fn recovery(vault: u32, header_changed: bool) -> PendingChoice {
        PendingChoice::Recovery(RecoveryChoice {
            vault: row(vault),
            location: Location::Folder(PathBuf::from("a")),
            epoch: 1,
            secret: petalock_core::internals::recovery::generate(),
            main: Some(b"main".to_vec()),
            backup: None,
            header_changed,
        })
    }

    /// A recovery choice is looked at by its own token only (a peek that takes nothing and starts no new five minutes),
    /// forgotten by it alone (another kind's token and a token that is not there are nothing to forget), and dropped
    /// by a lock of all vaults and by its five minutes, the lookup included.
    #[test]
    fn a_recovery_choice_is_seen_and_forgotten_by_its_own_token_only() {
        let pending = Pending::default();
        let now = Instant::now();
        let token = pending.put_at(recovery(7, true), now);
        let plain = pending.put_at(recovery(8, false), now);
        let other = pending.put_at(held(1), now);

        assert_eq!(pending.recovery_of_at(&token, now), Some((row(7), true)));
        assert_eq!(pending.recovery_of_at(&plain, now), Some((row(8), false)));
        assert_eq!(pending.recovery_of_at(&other, now), None, "another kind");
        assert_eq!(pending.recovery_of_at(&Token::random(), now), None);
        assert_eq!(pending.len(), 3, "a look takes nothing");
        // A look does not start the five minutes again.
        assert_eq!(
            pending.recovery_of_at(&token, now + LIFETIME - Duration::from_secs(1)),
            Some((row(7), true))
        );
        assert_eq!(pending.recovery_of_at(&token, now + LIFETIME), None);
        assert_eq!(pending.len(), 0, "an expired choice is dropped by the look");

        let token = pending.put_at(recovery(7, true), now);
        let other = pending.put_at(held(1), now);
        pending.forget_recovery(&other);
        pending.forget_recovery(&Token::random());
        assert_eq!(pending.len(), 2, "another kind's choice is left alone");
        pending.forget_recovery(&token);
        pending.forget_recovery(&token);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending.recovery_of_at(&token, now), None);

        let token = pending.put_at(recovery(7, false), now);
        drop(pending.drain());
        assert_eq!(pending.recovery_of_at(&token, now), None, "a lock drops it");
    }
}
