//! The one error type for the core. Every message is a fixed string: no password,
//! key, recovery secret or item content ever appears in an error (rule R5).

use thiserror::Error;

#[derive(Error)]
pub enum CoreError {
    #[error("wrong password")]
    WrongPassword,
    #[error("recovery key has a typing mistake")]
    RecoveryKeyTypo,
    #[error("invalid recovery key")]
    InvalidRecoveryKey,
    #[error("damaged data: {what}")]
    Damaged { what: &'static str },
    #[error("password is too short (minimum {min} characters)")]
    PasswordTooShort { min: usize },
    #[error("not enough disk space (needed {needed} bytes, available {available} bytes)")]
    NotEnoughSpace { needed: u64, available: u64 },
    #[error("file is too large for this file system (maximum {max_file} bytes)")]
    FileSystemLimit { max_file: u64 },
    #[error("unsupported vault version")]
    UnsupportedVersion,
    #[error("key-derivation settings are out of bounds")]
    ParamsOutOfBounds,
    #[error("too large: {what}")]
    TooLarge { what: &'static str },
    #[error("invalid input: {what}")]
    InvalidInput { what: &'static str },
    #[error("vault is in use by another process")]
    VaultInUse,
    #[error("not found")]
    NotFound,
    #[error("cancelled")]
    Cancelled,
    // Fixed text on purpose; the OS error stays reachable through `source()`.
    #[error("file system error")]
    Io(#[from] std::io::Error),
}

/// Written by hand: a derived `Debug` would print the nested I/O error's message, which can
/// carry text from a caller's reader or writer. The other variants hold fixed text only.
impl std::fmt::Debug for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CoreError::Io(e) => f.debug_tuple("Io").field(&e.kind()).finish(),
            other => write!(f, "{other}"),
        }
    }
}

pub type Result<T> = std::result::Result<T, CoreError>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::error::Error;

    /// Final review, Important 5: an I/O error can carry text from a caller's reader or
    /// writer. Neither `Display` nor `Debug` may show it; `source()` still reaches it.
    #[test]
    fn io_errors_never_print_their_message() {
        let error = CoreError::from(std::io::Error::other("SECRET-MARKER"));
        assert!(!error.to_string().contains("SECRET-MARKER"));
        assert!(!format!("{error:?}").contains("SECRET-MARKER"));
        assert!(!format!("{error:#?}").contains("SECRET-MARKER"));
        assert!(
            error
                .source()
                .unwrap()
                .to_string()
                .contains("SECRET-MARKER")
        );
    }
}
