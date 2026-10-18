//! Lockbox core: the vault engine. All encryption and key handling live here.

// `deny`, not `forbid`: only `fsio::windows` may opt in, for documented Win32 calls.
#![deny(unsafe_code)]

pub mod ad;
pub(crate) mod aead;
pub mod archive;
pub mod blob;
pub mod error;
pub mod fsio;
pub mod generator;
pub mod header;
pub mod ids;
pub mod item;
pub mod kdf;
pub mod limits;
pub mod lockfile;
pub mod manifest;
pub mod recovery;
pub mod search;
pub mod secret;
pub(crate) mod serde_b64;
pub mod slots;
pub mod vault;

pub use error::{CoreError, Result};
pub use vault::{
    BackupReport, BackupSummary, CleanupReport, CreatedVault, Credential, UnlockReport, Vault,
    read_vault_name, verify_backup,
};

/// The version of this crate, as set in `Cargo.toml`.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    #[test]
    fn version_matches_cargo() {
        assert_eq!(super::version(), "0.1.0");
    }
}
