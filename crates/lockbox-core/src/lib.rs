//! Lockbox core: the vault engine. All encryption and key handling live here.

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
