//! The one error type for the core. Every message is a fixed string: no password,
//! key, recovery secret or item content ever appears in an error (rule R5).

use thiserror::Error;

#[derive(Debug, Error)]
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

pub type Result<T> = std::result::Result<T, CoreError>;
