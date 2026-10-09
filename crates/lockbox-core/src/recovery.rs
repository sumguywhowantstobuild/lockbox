//! The recovery secret: 256 random bits plus a 4-bit checksum, written as 52 Crockford
//! base32 symbols in 13 groups of 4. The checksum catches a mistyped symbol 15 times
//! in 16 before any unwrap attempt.

use crate::error::{CoreError, Result};
use crate::secret::{Key32, fill_random};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use std::fmt;
use zeroize::Zeroizing;

const INFO: &[u8] = b"lockbox recovery key v1";
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SYMBOLS: usize = 52; // 260 bits / 5
const GROUP: usize = 4;

/// 32 secret bytes. Wiped on drop; deliberately not `Clone`, `PartialEq` or `Display`.
pub struct RecoverySecret(Zeroizing<[u8; 32]>);

impl fmt::Debug for RecoverySecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RecoverySecret(<redacted>)")
    }
}

/// The first 4 bits of SHA-256 of the secret, in the low half of the returned byte.
fn checksum(secret: &[u8; 32]) -> u8 {
    Sha256::digest(secret)[0] >> 4
}

/// The 5 bits of `bits` (big-endian, 33 bytes) for symbol number `i`.
fn read_symbol(bits: &[u8; 33], i: usize) -> u8 {
    let pos = i * 5;
    let two = u16::from_be_bytes([bits[pos / 8], bits[pos / 8 + 1]]);
    ((two >> (11 - pos % 8)) & 0x1F) as u8
}

/// Writes the 5-bit `value` as symbol number `i`. The target bits must still be zero.
fn write_symbol(bits: &mut [u8; 33], i: usize, value: u8) {
    let pos = i * 5;
    let two = u16::from(value) << (11 - pos % 8);
    bits[pos / 8] |= (two >> 8) as u8;
    bits[pos / 8 + 1] |= two as u8;
}

/// The symbol value for a typed character, or `None` if it is not Crockford base32.
fn symbol_value(c: char) -> Option<u8> {
    let c = match c.to_ascii_uppercase() {
        'O' => '0',
        'I' | 'L' => '1',
        other => other,
    };
    ALPHABET
        .iter()
        .position(|&a| char::from(a) == c)
        .map(|v| v as u8)
}

impl RecoverySecret {
    pub fn generate() -> Self {
        let mut bytes = Zeroizing::new([0u8; 32]);
        fill_random(&mut *bytes);
        Self(bytes)
    }

    /// The text to show the user, once. Built in a pre-sized buffer so it never reallocates.
    pub fn to_display(&self) -> Zeroizing<String> {
        let mut bits = Zeroizing::new([0u8; 33]);
        bits[..32].copy_from_slice(&*self.0);
        bits[32] = checksum(&self.0) << 4;
        let mut text = Zeroizing::new(String::with_capacity(SYMBOLS + SYMBOLS / GROUP));
        for i in 0..SYMBOLS {
            if i > 0 && i % GROUP == 0 {
                text.push('-');
            }
            text.push(char::from(ALPHABET[usize::from(read_symbol(&bits, i))]));
        }
        text
    }

    /// Reads typed text: ignores spaces, dashes and case; maps O to 0 and I/L to 1.
    /// A wrong length or a foreign character is `InvalidInput`; a well-formed key whose
    /// checksum does not match is `RecoveryKeyTypo`.
    pub fn parse(input: &str) -> Result<Self> {
        const BAD: CoreError = CoreError::InvalidInput {
            what: "recovery key",
        };
        let mut bits = Zeroizing::new([0u8; 33]);
        let mut count = 0;
        for c in input.chars().filter(|c| !matches!(c, ' ' | '-')) {
            let value = symbol_value(c).ok_or(BAD)?;
            if count == SYMBOLS {
                return Err(BAD);
            }
            write_symbol(&mut bits, count, value);
            count += 1;
        }
        if count != SYMBOLS {
            return Err(BAD);
        }
        let mut bytes = Zeroizing::new([0u8; 32]);
        bytes.copy_from_slice(&bits[..32]);
        if bits[32] >> 4 != checksum(&bytes) {
            return Err(CoreError::RecoveryKeyTypo);
        }
        Ok(Self(bytes))
    }
}

/// The key that wraps the vault key in the recovery slot (HKDF-SHA256, spec 5.2).
pub fn derive_recovery_key(secret: &RecoverySecret, salt: &[u8; 16]) -> Key32 {
    Key32::fill_with(|out| {
        Hkdf::<Sha256>::new(Some(salt), &*secret.0)
            .expand(INFO, out)
            .map_err(|_| CoreError::InvalidInput { what: "key length" })
    })
    .expect("HKDF-SHA256 can produce 32 bytes")
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD_CHARS: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

    /// Symbols 0..24 are `0`, 24..48 are `1`, so the forgiving-input test has something to mangle.
    fn zeros_and_ones() -> RecoverySecret {
        let mut b = [0u8; 32];
        for start in [15, 20, 25] {
            b[start..start + 5].copy_from_slice(&[0x08, 0x42, 0x10, 0x84, 0x21]);
        }
        b[30] = 0x5A;
        b[31] = 0xC3;
        RecoverySecret(Zeroizing::new(b))
    }

    #[test]
    fn display_format() {
        let shown = RecoverySecret::generate().to_display();
        let groups: Vec<&str> = shown.split('-').collect();
        assert_eq!(groups.len(), 13);
        assert!(groups.iter().all(|g| g.len() == 4));
        assert!(
            shown
                .chars()
                .filter(|c| *c != '-')
                .all(|c| GOOD_CHARS.contains(c))
        );
    }

    #[test]
    fn round_trip() {
        let secret = RecoverySecret::generate();
        let back = RecoverySecret::parse(&secret.to_display()).unwrap();
        assert_eq!(*back.0, *secret.0);
    }

    #[test]
    fn parse_is_forgiving() {
        let secret = zeros_and_ones();
        let shown = secret.to_display();
        assert!(shown.contains('0') && shown.contains('1'));
        let spaced_lower = shown.replace('-', " ").to_lowercase();
        let mangled_o_i = shown.replace('0', "O").replace('1', "I");
        let mangled_l = shown.replace('1', "l").replace('-', "");
        for text in [spaced_lower, mangled_o_i, mangled_l] {
            assert_eq!(
                *RecoverySecret::parse(&text).unwrap().0,
                *secret.0,
                "{text}"
            );
        }
    }

    #[test]
    fn typo_detected() {
        const POSITION: usize = 10; // a symbol made only of secret bits
        let (mut detected, mut total) = (0, 0);
        for seed in 0..64usize {
            let secret = RecoverySecret(Zeroizing::new(std::array::from_fn(|j| {
                (seed * 37 + j * 11 + 5) as u8
            })));
            let shown = secret.to_display().as_bytes().to_vec();
            let at = POSITION + POSITION / GROUP; // skip the dashes before it
            for &sym in ALPHABET.iter().filter(|&&s| s != shown[at]) {
                let mut typo = shown.clone();
                typo[at] = sym;
                total += 1;
                match RecoverySecret::parse(std::str::from_utf8(&typo).unwrap()) {
                    Err(CoreError::RecoveryKeyTypo) => detected += 1,
                    Ok(other) => assert_ne!(*other.0, *secret.0),
                    Err(e) => panic!("unexpected error: {e}"),
                }
            }
        }
        assert_eq!(total, 64 * 31);
        // The checksum has 4 bits, so about 15 in 16 are caught; require at least 14 in 16.
        assert!(
            detected * 16 >= total * 14,
            "caught only {detected} of {total}"
        );
        println!("typo detection: {detected}/{total}");
    }

    #[test]
    fn wrong_length_or_bad_char_rejected() {
        let shown = RecoverySecret::generate().to_display();
        let compact: String = shown.chars().filter(|c| *c != '-').collect();
        let too_short = &compact[..51];
        let too_long = format!("{compact}0");
        let with_u = format!("U{}", &compact[1..]);
        let with_symbol = format!("!{}", &compact[1..]);
        for text in [
            too_short,
            too_long.as_str(),
            with_u.as_str(),
            with_symbol.as_str(),
            "",
        ] {
            assert!(
                matches!(
                    RecoverySecret::parse(text),
                    Err(CoreError::InvalidInput { .. })
                ),
                "{text:?}"
            );
        }
    }

    #[test]
    fn debug_output_is_redacted() {
        let out = format!("{:?}", zeros_and_ones());
        assert_eq!(out, "RecoverySecret(<redacted>)");
    }

    #[test]
    fn derived_key_depends_on_salt() {
        let secret = zeros_and_ones();
        let a = derive_recovery_key(&secret, &[1; 16]);
        let b = derive_recovery_key(&secret, &[2; 16]);
        assert_ne!(a.as_bytes(), b.as_bytes());
        assert_eq!(
            a.as_bytes(),
            derive_recovery_key(&secret, &[1; 16]).as_bytes()
        );
    }
}
