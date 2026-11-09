//! What a command answers besides its result: a refusal ([`ShellError`]) or a question for the user first
//! ([`Outcome`]). A refusal's every field is fixed text or a number: no path, name, secret or input ever crosses (spec
//! §8, R5). A question may name what it asks about, for the user to answer: file names, or the user's own folders when a
//! restore cannot finish.

use lockbox_core::CoreError;
use serde::Serialize;

use crate::pending::Token;
use crate::restore::{Leaves, RestoreNotice};

/// A command's refusal, serialised as `{ "code": "<snake_case>", ... }` with fixed fields only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum ShellError {
    /// The session is locked, or locked while the command ran: nothing it read is returned (spec §7.4).
    Locked,
    /// The change was made, but the session locked before the answer could be shown (spec §7.4).
    LockedAfterChange {
        what: &'static str,
    },
    NotFound,
    Busy {
        what: &'static str,
    },
    /// A write to a read-only session.
    ReadOnly,
    TooLarge {
        what: &'static str,
    },
    InvalidInput {
        what: &'static str,
    },
    Cancelled,
    /// A print of the page did not happen: `"pdf"` when no PDF came (nothing is left on disk), `"print"` when the
    /// job could not be sent to the printer that was picked. A print already running is `Busy { what: "printer" }`
    /// instead.
    PrintFailed {
        what: &'static str,
    },
    Core(CoreErrorView),
}

/// An engine error as the UI sees it: the variant's name, its fixed text, and its numbers when it has them (§8
/// shows "needs 50 GB, 12 GB free").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CoreErrorView {
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub what: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_file: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<usize>,
    /// Where in the typed recovery key the word that is not in the list stands, counting from 1. A `u32` (not `usize`)
    /// so that the refusal stays under clippy's size limit for an `Err` (`result_large_err`) across the whole shell.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<u32>,
    /// How many words the typed recovery key had (a `u32` for the same reason).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub found: Option<u32>,
}

/// A count of words for the page: saturates, which a pasted text of four billion words is the only way to reach.
fn small(count: usize) -> u32 {
    u32::try_from(count).unwrap_or(u32::MAX)
}

pub type ShellResult<T> = Result<T, ShellError>;

/// A create whose vault the vault list could not take, and that could not be removed again: the vault is on disk,
/// in the folder the user chose, but not on the list and its recovery key never shown. The page tells the user to add
/// it with "Add existing vault" and make a new recovery key. Fixed text, no path (R5).
/// A print of Lockbox's own is still running (WebView2 takes one at a time): try again once it ends.
pub const PRINTER_BUSY: ShellError = ShellError::Busy { what: "printer" };
/// The recovery key PDF did not come: nothing was saved and nothing is left on disk.
pub const PDF_NOT_MADE: ShellError = ShellError::PrintFailed { what: "pdf" };
/// The print job could not be sent to the printer that was picked.
pub const PRINT_NOT_SENT: ShellError = ShellError::PrintFailed { what: "print" };
/// The printer that was picked is not among the ones Lockbox lists any more.
pub const PRINTER_GONE: ShellError = ShellError::InvalidInput {
    what: "printer name",
};

pub const VAULT_NOT_LISTED: ShellError = ShellError::InvalidInput {
    what: "vault not listed",
};

impl ShellError {
    /// Whether this refusal reports something already left on disk that the user must act on
    /// ([`VAULT_NOT_LISTED`]). It is answered as it is even when a lock overtook the command: `Locked` would hide it.
    pub fn reports_a_leftover(&self) -> bool {
        *self == VAULT_NOT_LISTED
    }
}

impl CoreErrorView {
    fn kind(kind: &'static str) -> Self {
        CoreErrorView {
            kind,
            what: None,
            needed: None,
            available: None,
            max_file: None,
            min: None,
            position: None,
            found: None,
        }
    }
}

impl From<CoreError> for ShellError {
    fn from(error: CoreError) -> Self {
        let view = CoreErrorView::kind;
        ShellError::Core(match error {
            // A cancel is the shell's own (a lock or Windows stopped the operation), whichever layer noticed it.
            CoreError::Cancelled => return ShellError::Cancelled,
            CoreError::WrongPassword => view("wrong_password"),
            CoreError::RecoveryKeyTypo => view("recovery_key_typo"),
            CoreError::InvalidRecoveryKey => view("invalid_recovery_key"),
            CoreError::RecoveryKeyWord { position } => CoreErrorView {
                position: Some(small(position)),
                ..view("recovery_key_word")
            },
            CoreError::RecoveryKeyCount { found } => CoreErrorView {
                found: Some(small(found)),
                ..view("recovery_key_count")
            },
            CoreError::Damaged { what } => CoreErrorView {
                what: Some(what),
                ..view("damaged")
            },
            CoreError::PasswordTooShort { min } => CoreErrorView {
                min: Some(min),
                ..view("password_too_short")
            },
            CoreError::NotEnoughSpace { needed, available } => CoreErrorView {
                needed: Some(needed),
                available: Some(available),
                ..view("not_enough_space")
            },
            CoreError::FileSystemLimit { max_file } => CoreErrorView {
                max_file: Some(max_file),
                ..view("file_system_limit")
            },
            CoreError::UnsupportedVersion => view("unsupported_version"),
            CoreError::ParamsOutOfBounds => view("params_out_of_bounds"),
            CoreError::TooLarge { what } => CoreErrorView {
                what: Some(what),
                ..view("too_large")
            },
            CoreError::InvalidInput { what } => CoreErrorView {
                what: Some(what),
                ..view("invalid_input")
            },
            CoreError::VaultInUse => view("vault_in_use"),
            CoreError::RestorePending => view("restore_pending"),
            CoreError::NotFound => view("not_found"),
            // The OS message can name a path: only the kind crosses.
            CoreError::Io(_) => view("io"),
        })
    }
}

/// The shell's own file system calls: like an engine I/O error, only the kind crosses.
impl From<std::io::Error> for ShellError {
    fn from(error: std::io::Error) -> Self {
        CoreError::from(error).into()
    }
}

/// The answer of a command that may need the user's yes first (`Confirm`) or opens a dialog the user may close
/// (`Dismissed`).
#[derive(Serialize)]
pub enum Outcome<T> {
    Done(T),
    Confirm(Confirm),
    Dismissed,
}

/// A question the user answers before the command goes on. Not an error: it may carry the user's own data for
/// display (a suggested folder name, file names), never secrets. A variant with a `token` is confirmed by sending
/// the token back (the state waits in [`Pending`](crate::pending::Pending)); one without is confirmed by sending the
/// same command again with its flag set. Each task adds the variants it needs.
#[derive(Serialize)]
pub enum Confirm {
    /// The folder is synced by a cloud provider, which Lockbox does not support (spec §6.10): go on anyway?
    CloudFolder { token: Token },
    /// The vault's header was changed outside Lockbox (spec §5.2): accept it before the recovery goes on.
    HeaderChanged { token: Token },
    /// The stored file is of a type that can run code (spec §7.2): open it anyway? Confirmed by sending `open_file`
    /// again with `confirmed_executable`. Asked before anything is decrypted.
    Executable,
    /// The item being copied out of a backup has attachments the backup does not hold (spec §6.9): the names of those
    /// files, in the item's order, so the user can decide. Confirmed by sending `copy_item_to` again with
    /// `skip_missing`. The names are the user's own data, shown and never put in an error.
    MissingFiles { names: Vec<String> },
    /// A restore cannot tell the vault folder at its destination is the same vault (both header copies unreadable),
    /// and the default folder name is taken by it (spec §6.8): restore beside it in a new folder? `suggested` is
    /// `<folder name> (restored)`, the user's own data, shown and never put in an error. Confirmed by sending
    /// `restore_prepare_confirm` with the token and a folder name (the suggestion, or the user's own); the backup
    /// picked, the parent and the credential wait in [`Pending`](crate::pending::Pending).
    NewFolder { suggested: String, token: Token },
    /// Dismissing a restore journal that recovery could not act on (spec §6.8): what the dismissal leaves behind, so
    /// the user can act on it. Confirmed by sending `dismiss_restore` again with `confirm`.
    Dismissal { leaves: Leaves },
    /// Deleting a pre-restore folder is permanent. Confirmed by sending `delete_pre_restore` again with `confirm`.
    DeletePreRestore,
    /// Not a question: a restore journal was found, recovery ran and this is what it found. The page shows it, and
    /// the user starts the restore again (`restore_prepare`) or decides what to do with a journal that stays.
    Recovery { notice: RestoreNotice },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn core_errors_keep_their_numbers() {
        let json = |error: CoreError| serde_json::to_value(ShellError::from(error)).unwrap();
        assert_eq!(
            json(CoreError::NotEnoughSpace {
                needed: 5,
                available: 3
            }),
            json!({ "code": "core", "kind": "not_enough_space", "needed": 5, "available": 3 })
        );
        assert_eq!(
            json(CoreError::FileSystemLimit { max_file: 4 }),
            json!({ "code": "core", "kind": "file_system_limit", "max_file": 4 })
        );
        assert_eq!(
            json(CoreError::PasswordTooShort { min: 12 }),
            json!({ "code": "core", "kind": "password_too_short", "min": 12 })
        );
        assert_eq!(
            json(CoreError::Damaged { what: "item" }),
            json!({ "code": "core", "kind": "damaged", "what": "item" })
        );
        assert_eq!(
            json(CoreError::WrongPassword),
            json!({ "code": "core", "kind": "wrong_password" })
        );
        // The recovery key's refusals carry numbers only: the word's place, how many words were found.
        assert_eq!(
            json(CoreError::RecoveryKeyWord { position: 7 }),
            json!({ "code": "core", "kind": "recovery_key_word", "position": 7 })
        );
        assert_eq!(
            json(CoreError::RecoveryKeyCount { found: 23 }),
            json!({ "code": "core", "kind": "recovery_key_count", "found": 23 })
        );
        assert_eq!(
            json(CoreError::RecoveryKeyTypo),
            json!({ "code": "core", "kind": "recovery_key_typo" })
        );
        assert_eq!(
            json(CoreError::InvalidRecoveryKey),
            json!({ "code": "core", "kind": "invalid_recovery_key" })
        );
        // An I/O error's message can carry a path or text from a reader: only its kind crosses.
        let io = json(CoreError::from(std::io::Error::other("C:\\SECRET-7f3a")));
        assert_eq!(io, json!({ "code": "core", "kind": "io" }));
        // The shell's own refusals: a code and their fixed fields.
        assert_eq!(
            serde_json::to_value(ShellError::Busy { what: "opening" }).unwrap(),
            json!({ "code": "busy", "what": "opening" })
        );
        assert_eq!(
            serde_json::to_value(ShellError::LockedAfterChange { what: "password" }).unwrap(),
            json!({ "code": "locked_after_change", "what": "password" })
        );
        assert_eq!(
            serde_json::to_value(ShellError::Locked).unwrap(),
            json!({ "code": "locked" })
        );
    }
}
