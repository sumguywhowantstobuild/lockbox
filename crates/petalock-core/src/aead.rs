//! The one place XChaCha20-Poly1305 is called for whole-buffer sealing (key slots, items).
//! Both functions work inside the caller's buffer, so a wiped buffer never leaves a stray copy.

use crate::secret::Key32;
use chacha20poly1305::XChaCha20Poly1305;
use chacha20poly1305::aead::{AeadInOut, Error, KeyInit};

/// Encrypts `buf` in place and appends the 16-byte tag. Reserve 16 spare bytes in `buf`
/// first, or the vector reallocates and leaves an unwiped copy behind.
///
/// # Panics
/// If `buf` is beyond the cipher's length limit (about 256 GiB); callers cap far below that.
pub(crate) fn encrypt_in_place(key: &Key32, nonce: &[u8; 24], ad: &[u8], buf: &mut Vec<u8>) {
    XChaCha20Poly1305::new(key.as_bytes().into())
        .encrypt_in_place(nonce.into(), ad, buf)
        .expect("plaintext within the cipher's length limit");
}

/// Verifies the tag and decrypts `buf` in place, leaving just the plaintext. On failure the
/// contents of `buf` are unspecified. The cipher cannot say why it failed (wrong key, edited
/// data, wrong AD), so neither can this.
pub(crate) fn decrypt_in_place(
    key: &Key32,
    nonce: &[u8; 24],
    ad: &[u8],
    buf: &mut Vec<u8>,
) -> Result<(), Error> {
    XChaCha20Poly1305::new(key.as_bytes().into()).decrypt_in_place(nonce.into(), ad, buf)
}
