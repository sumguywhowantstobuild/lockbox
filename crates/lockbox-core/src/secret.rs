//! Secret key types. Keys are wiped from memory when dropped and never printed.

use hkdf::Hkdf;
use sha2::Sha256;
use std::fmt;
use zeroize::Zeroizing;

/// The one place the crate asks the OS for randomness.
pub(crate) fn fill_random(buf: &mut [u8]) {
    // No safe way to continue without OS randomness, so fail loudly.
    getrandom::fill(buf).expect("OS random source failed");
}

/// `N` random bytes from the OS. Panics only if the OS random source is unavailable.
/// The result is a plain array that is not wiped; for secrets use [`Key32::random`].
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    fill_random(&mut bytes);
    bytes
}

/// A 32-byte secret key. Wiped on drop; deliberately not `Clone`, `Display` or serde,
/// and `Debug` never shows the bytes.
pub struct Key32(Zeroizing<[u8; 32]>);

impl Key32 {
    /// A fresh random key, filled directly inside the wiped buffer (no stray copy).
    pub fn random() -> Self {
        let mut key = Zeroizing::new([0u8; 32]);
        fill_random(&mut *key);
        Self(key)
    }

    /// Lets `fill` write the key directly inside the wiped buffer (no stray copy).
    pub(crate) fn fill_with(
        fill: impl FnOnce(&mut [u8; 32]) -> crate::Result<()>,
    ) -> crate::Result<Self> {
        let mut key = Zeroizing::new([0u8; 32]);
        fill(&mut key)?;
        Ok(Self(key))
    }

    /// HKDF-SHA256 (RFC 5869) from `ikm` into a new key, written straight into the wiped buffer.
    pub(crate) fn hkdf_sha256(salt: Option<&[u8]>, ikm: &[u8], info: &[u8]) -> Self {
        Self::fill_with(|out| {
            Hkdf::<Sha256>::new(salt, ikm)
                .expand(info, out)
                .map_err(|_| crate::CoreError::InvalidInput { what: "key length" })
        })
        .expect("HKDF-SHA256 can produce 32 bytes")
    }

    /// Takes ownership of key bytes. The caller's own copy of `bytes` is not wiped here.
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(Zeroizing::new(bytes))
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Debug for Key32 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Key32(<redacted>)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_output_is_redacted() {
        let key = Key32::from_bytes([0xAB; 32]);
        let out = format!("{key:?}");
        assert_eq!(out, "Key32(<redacted>)");
        assert!(!out.to_lowercase().contains("ab"));
        assert!(!out.contains("171")); // 0xAB in decimal, as `{:?}` on a byte array would print
    }

    #[test]
    fn random_keys_differ() {
        assert_ne!(Key32::random().as_bytes(), Key32::random().as_bytes());
    }

    #[test]
    fn from_bytes_round_trips() {
        assert_eq!(Key32::from_bytes([7; 32]).as_bytes(), &[7; 32]);
    }

    #[test]
    fn random_bytes_differ() {
        assert_ne!(random_bytes::<16>(), random_bytes::<16>());
    }
}
