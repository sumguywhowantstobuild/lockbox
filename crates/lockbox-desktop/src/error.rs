//! What a command answers besides its result: a refusal ([`ShellError`]) or a question for the user first
//! ([`Outcome`]). Every field is fixed text or a number: no path, name, secret or input ever crosses (spec §8, R5).

use lockbox_core::CoreError;
use serde::Serialize;

use crate::pending::Token;

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
}

pub type ShellResult<T> = Result<T, ShellError>;

impl CoreErrorView {
    fn kind(kind: &'static str) -> Self {
        CoreErrorView {
            kind,
            what: None,
            needed: None,
            available: None,
            max_file: None,
            min: None,
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
