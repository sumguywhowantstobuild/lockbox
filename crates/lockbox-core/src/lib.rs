//! Lockbox core: the vault engine. All encryption and key handling live here.

#![forbid(unsafe_code)]

pub mod ad;
pub mod error;
pub mod ids;
pub mod kdf;
pub mod limits;
pub mod recovery;
pub mod secret;

pub use error::{CoreError, Result};

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
