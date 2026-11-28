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
///
/// The bytes live in their own heap allocation, so moving a `Key32` (or the record or list that holds it, as a `Vec`
/// does when it grows) moves only the pointer: the key is never copied and the old place left unwiped. On drop the
/// bytes are wiped where they are, then the allocation is freed. (`Zeroizing<Box<[u8; 32]>>` has no `Zeroize` impl in
/// zeroize 1.9, so the wipe sits inside the box.)
pub struct Key32(Box<Zeroizing<[u8; 32]>>);

impl Key32 {
    /// The allocation first, all zero; the key is written into it in place.
    fn zeroed() -> Box<Zeroizing<[u8; 32]>> {
        Box::new(Zeroizing::new([0u8; 32]))
    }

    /// A fresh random key, filled directly inside its own wiped allocation (no stray copy).
    pub fn random() -> Self {
        let mut key = Self::zeroed();
        fill_random(&mut **key);
        Self(key)
    }

    /// Lets `fill` write the key directly inside its own wiped allocation (no stray copy). A key that `fill` fails on
    /// is wiped as it is dropped.
    pub(crate) fn fill_with(
        fill: impl FnOnce(&mut [u8; 32]) -> crate::Result<()>,
    ) -> crate::Result<Self> {
        let mut key = Self::zeroed();
        fill(&mut key)?;
        Ok(Self(key))
    }

    /// HKDF-SHA256 (RFC 5869) from `ikm` into a new key, written straight into the wiped buffer.
    // shortcut: hkdf 0.13 leaves its PRK and last output block unwiped on the stack (no zeroize feature); upgrade when a release wipes them.
    pub(crate) fn hkdf_sha256(salt: Option<&[u8]>, ikm: &[u8], info: &[u8]) -> Self {
        Self::fill_with(|out| {
            Hkdf::<Sha256>::new(salt, ikm)
                .expand(info, out)
                .map_err(|_| crate::CoreError::InvalidInput { what: "key length" })
        })
        .expect("HKDF-SHA256 can produce 32 bytes")
    }

    /// Copies key bytes into a new allocation. The caller's own copy of `bytes` (the by-value argument) is not wiped
    /// here; only tests and the test-internals build call this, with fixed bytes.
    #[cfg_attr(not(any(test, feature = "test-internals")), allow(dead_code))]
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self::fill_with(|key| {
            key.copy_from_slice(&bytes);
            Ok(())
        })
        .expect("copying a key cannot fail")
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
    fn a_moved_key_keeps_its_address() {
        let key = Key32::random();
        let address = key.as_bytes().as_ptr();
        let moved = Box::new(key);
        let list: Vec<Key32> = std::iter::once(*moved).collect();
        assert_eq!(list[0].as_bytes().as_ptr(), address);
    }

    #[test]
    fn random_bytes_differ() {
        assert_ne!(random_bytes::<16>(), random_bytes::<16>());
    }
}
