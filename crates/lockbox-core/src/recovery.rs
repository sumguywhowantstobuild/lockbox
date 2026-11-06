//! The recovery secret: 256 random bits plus an 8-bit checksum (the first byte of the secret's SHA-256), cut into 24
//! pieces of 11 bits, one word each from the BIP39 English list (spec 5.2). This is BIP39's encoding of the secret
//! only: its seed step is not used, so the key is derived from the secret exactly as before. The checksum catches a
//! wrong but listed word 255 times in 256 before any unwrap attempt.

use crate::error::{CoreError, Result};
use crate::secret::{Key32, fill_random};
use sha2::{Digest, Sha256};
use std::fmt;
use std::sync::LazyLock;
use zeroize::Zeroizing;

const INFO: &[u8] = b"lockbox recovery key v1";
/// Trezor's `python-mnemonic` copy of the BIP39 English list (MIT; see THIRD-PARTY-NOTICES.md): 2,048 sorted words, LF
/// endings. A test pins its SHA-256.
const LIST: &str = include_str!("wordlist/english.txt");
const WORDS: usize = 24;
const WORD_BITS: usize = 11;
/// The secret's bytes, then the checksum byte.
const SECRET_BYTES: usize = 32;
const BIT_BYTES: usize = SECRET_BYTES + 1; // 24 * 11 = 264 bits
/// The longest word in the list, for sizing the text to show.
const LONGEST_WORD: usize = 8;

/// The list's words in order. The words are public, not secret.
static LIST_WORDS: LazyLock<Vec<&'static str>> = LazyLock::new(|| LIST.lines().collect());

/// 32 secret bytes. Wiped on drop; deliberately not `Clone`, `PartialEq` or `Display`.
pub struct RecoverySecret(Zeroizing<[u8; 32]>);

impl fmt::Debug for RecoverySecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RecoverySecret(<redacted>)")
    }
}

/// The first byte of SHA-256 of the secret: BIP39's 8 checksum bits for 256 bits of entropy.
fn checksum(secret: &[u8; SECRET_BYTES]) -> u8 {
    let mut hash = Zeroizing::new([0u8; 32]);
    Sha256::new()
        .chain_update(secret)
        .finalize_into((&mut *hash).into());
    hash[0]
}

/// The 11 bits of `bits` (big-endian) for word number `i`, as the word's place in the list.
fn read_word_index(bits: &[u8; BIT_BYTES], i: usize) -> usize {
    let mut index = 0;
    for pos in i * WORD_BITS..(i + 1) * WORD_BITS {
        index = (index << 1) | usize::from((bits[pos / 8] >> (7 - pos % 8)) & 1);
    }
    index
}

/// Writes `index` as word number `i`. The target bits must still be zero.
fn write_word_index(bits: &mut [u8; BIT_BYTES], i: usize, index: u16) {
    for b in 0..WORD_BITS {
        let pos = i * WORD_BITS + b;
        let set = (index >> (WORD_BITS - 1 - b)) & 1 == 1;
        bits[pos / 8] |= u8::from(set) << (7 - pos % 8);
    }
}

/// The separators between typed words: spaces, tabs, line breaks, commas and periods.
fn is_separator(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | ',' | '.')
}

/// A word number, which is dropped: only digits, or digits followed by `)` (a `.` is a separator already).
fn is_word_number(token: &str) -> bool {
    let digits = token.trim_end_matches(')');
    token.len() - digits.len() <= 1
        && !digits.is_empty()
        && digits.bytes().all(|b| b.is_ascii_digit())
}

/// The first four letters of a word, or the whole word when it is shorter than four. They pick one word.
fn key_of(word: &[u8]) -> &[u8] {
    &word[..word.len().min(4)]
}

/// The place in the list of the word a typed token stands for: its first four letters match (ASCII lowercase only),
/// or it is the whole of a word shorter than four. Letters after the fourth are not looked at.
fn find_word(token: &[u8]) -> Option<u16> {
    let mut key = Zeroizing::new([0u8; 4]);
    let len = token.len().min(4);
    for (k, b) in key.iter_mut().zip(token) {
        *k = b.to_ascii_lowercase();
    }
    let key = &key[..len];
    LIST_WORDS
        .binary_search_by(|word| key_of(word.as_bytes()).cmp(key))
        .ok()
        .map(|index| index as u16)
}

impl RecoverySecret {
    pub(crate) fn generate() -> Self {
        let mut bytes = Zeroizing::new([0u8; 32]);
        fill_random(&mut *bytes);
        Self(bytes)
    }

    /// The text to show the user, once: the 24 words, lowercase, joined by single spaces (the page numbers them).
    /// Built in a pre-sized buffer so it never reallocates.
    pub fn to_display(&self) -> Zeroizing<String> {
        let mut bits = Zeroizing::new([0u8; BIT_BYTES]);
        bits[..SECRET_BYTES].copy_from_slice(&*self.0);
        bits[SECRET_BYTES] = checksum(&self.0);
        let mut text = Zeroizing::new(String::with_capacity(WORDS * (LONGEST_WORD + 1)));
        for i in 0..WORDS {
            if i > 0 {
                text.push(' ');
            }
            text.push_str(LIST_WORDS[read_word_index(&bits, i)]);
        }
        text
    }

    /// Reads typed words (spec 5.2). The text is split at spaces, tabs, line breaks, commas and periods; a token of
    /// only digits, or digits and a `)`, is a word number and is dropped; every other token must be a word of the list
    /// by its first four letters (ASCII case ignored; a word shorter than four is read whole only). The first token
    /// that is no word is `RecoveryKeyWord` with its place among the words; then anything but 24 words is
    /// `RecoveryKeyCount`; then a failed 8-bit check is `RecoveryKeyTypo`. Nothing of the text is kept or put in an
    /// error. The earlier 52-character form has no place here: its first group is no word.
    pub fn parse(input: &str) -> Result<Self> {
        let mut indices = Zeroizing::new([0u16; WORDS]);
        let mut found = 0usize;
        for token in input.split(is_separator).filter(|t| !t.is_empty()) {
            if is_word_number(token) {
                continue;
            }
            let index = find_word(token.as_bytes()).ok_or(CoreError::RecoveryKeyWord {
                position: found + 1,
            })?;
            if found < WORDS {
                indices[found] = index;
            }
            found += 1;
        }
        if found != WORDS {
            return Err(CoreError::RecoveryKeyCount { found });
        }
        let mut bits = Zeroizing::new([0u8; BIT_BYTES]);
        for (i, &index) in indices.iter().enumerate() {
            write_word_index(&mut bits, i, index);
        }
        let mut bytes = Zeroizing::new([0u8; SECRET_BYTES]);
        bytes.copy_from_slice(&bits[..SECRET_BYTES]);
        if bits[SECRET_BYTES] != checksum(&bytes) {
            return Err(CoreError::RecoveryKeyTypo);
        }
        Ok(Self(bytes))
    }
}

/// The key that wraps the vault key in the recovery slot (HKDF-SHA256, spec 5.2).
pub fn derive_recovery_key(secret: &RecoverySecret, salt: &[u8; 16]) -> Key32 {
    Key32::hkdf_sha256(Some(salt), &*secret.0, INFO)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Trezor's `python-mnemonic` copy of the BIP39 English list, as embedded.
    const LIST: &str = include_str!("wordlist/english.txt");
    /// SHA-256 of that file, equal to the copy `bitcoin/bips` publishes (compared when the file was added).
    const LIST_SHA256: &str = "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda";

    fn list() -> Vec<&'static str> {
        LIST.lines().collect()
    }

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect()
    }

    /// A fixed secret that differs with `seed`.
    fn secret_from_seed(seed: usize) -> RecoverySecret {
        RecoverySecret(Zeroizing::new(std::array::from_fn(|j| {
            (seed * 37 + j * 11 + 5) as u8
        })))
    }

    /// A fixed secret whose first word is word number `index` of the list.
    fn secret_with_first_word(index: usize, seed: usize) -> RecoverySecret {
        let mut bytes: [u8; 32] = std::array::from_fn(|j| (seed * 37 + j * 11 + 5) as u8);
        bytes[0] = (index >> 3) as u8;
        bytes[1] = (bytes[1] & 0x1F) | ((index & 7) << 5) as u8;
        RecoverySecret(Zeroizing::new(bytes))
    }

    fn words_of(secret: &RecoverySecret) -> Vec<String> {
        secret.to_display().split(' ').map(str::to_string).collect()
    }

    fn parsed_equals(text: &str, secret: &RecoverySecret) -> bool {
        matches!(RecoverySecret::parse(text), Ok(back) if *back.0 == *secret.0)
    }

    #[test]
    fn words_match_bip39_test_vectors() {
        // The 256-bit entropy vectors of Trezor's `vectors.json` (python-mnemonic, "english"), mnemonic only: the
        // seed step (PBKDF2) is not used here. (entropy hex, mnemonic)
        let vectors = [
            (
                "0000000000000000000000000000000000000000000000000000000000000000",
                "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
            ),
            (
                "7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f",
                "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title",
            ),
            (
                "8080808080808080808080808080808080808080808080808080808080808080",
                "letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic bless",
            ),
            (
                "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote",
            ),
            (
                "68a79eaca2324873eacc50cb9c6eca8cc68ea5d936f98787c60c7ebc74e6ce7c",
                "hamster diagram private dutch cause delay private meat slide toddler razor book happy fancy gospel tennis maple dilemma loan word shrug inflict delay length",
            ),
            (
                "9f6a2878b2520799a44ef18bc7df394e7061a224d2c33cd015b157d746869863",
                "panda eyebrow bullet gorilla call smoke muffin taste mesh discover soft ostrich alcohol speed nation flash devote level hobby quick inner drive ghost inside",
            ),
            (
                "066dca1a2bb7e8a1db2832148ce9933eea0f3ac9548d793112d9a95c9407efad",
                "all hour make first leader extend hole alien behind guard gospel lava path output census museum junior mass reopen famous sing advance salt reform",
            ),
            (
                "f585c11aec520db57dd353c69554b21a89b20fb0650966fa0a9d6f74fd989d8f",
                "void come effort suffer camp survey warrior heavy shoot primary clutch crush open amazing screen patrol group space point ten exist slush involve unfold",
            ),
        ];
        for (entropy, mnemonic) in vectors {
            let bytes: [u8; 32] = hex(entropy).try_into().unwrap();
            let secret = RecoverySecret(Zeroizing::new(bytes));
            assert_eq!(&**secret.to_display(), mnemonic, "{entropy}");
            let back = RecoverySecret::parse(mnemonic).unwrap();
            assert_eq!(*back.0, bytes, "{mnemonic}");
        }
    }

    #[test]
    fn wordlist_is_pinned_and_well_formed() {
        let digest = Sha256::digest(LIST.as_bytes());
        let hash: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hash, LIST_SHA256);
        assert!(!LIST.contains('\r'), "LF endings only");
        assert!(LIST.ends_with('\n'));
        let words = list();
        assert_eq!(words.len(), 2048);
        for word in &words {
            assert!((3..=8).contains(&word.len()), "{word}");
            assert!(word.bytes().all(|b| b.is_ascii_lowercase()), "{word}");
        }
        assert!(
            words.windows(2).all(|pair| pair[0] < pair[1]),
            "sorted, unique"
        );
        // The first four letters (the whole word when shorter) pick one word.
        let mut keys: Vec<&str> = words.iter().map(|w| &w[..w.len().min(4)]).collect();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), 2048);
    }

    #[test]
    fn display_is_24_lowercase_words() {
        let words = list();
        for seed in 0..16 {
            let shown = secret_from_seed(seed).to_display();
            assert!(!shown.starts_with(' ') && !shown.ends_with(' '));
            assert!(shown.bytes().all(|b| b.is_ascii_lowercase() || b == b' '));
            let tokens: Vec<&str> = shown.split(' ').collect();
            assert_eq!(tokens.len(), 24, "single spaces only");
            assert!(tokens.iter().all(|t| words.contains(t)));
        }
        let generated = RecoverySecret::generate().to_display();
        assert_eq!(generated.split(' ').count(), 24);
    }

    #[test]
    fn round_trip_through_words() {
        for seed in 0..32 {
            let secret = secret_from_seed(seed);
            assert!(parsed_equals(&secret.to_display(), &secret));
        }
        let secret = RecoverySecret::generate();
        assert!(parsed_equals(&secret.to_display(), &secret));
    }

    #[test]
    fn first_four_letters_are_enough() {
        let secret = secret_from_seed(3);
        let first_four = |w: &str| w[..w.len().min(4)].to_string();
        let four: Vec<String> = words_of(&secret).iter().map(|w| first_four(w)).collect();
        assert!(parsed_equals(&four.join(" "), &secret));
        // A slip after the fourth letter still reads as the intended word.
        let slipped: Vec<String> = four.iter().map(|w| format!("{w}zz")).collect();
        // (a word shorter than four takes no extra letters, so only the long ones are slipped)
        let mixed: Vec<String> = four
            .iter()
            .zip(&slipped)
            .map(|(short, slip)| {
                if short.len() == 4 {
                    slip.clone()
                } else {
                    short.clone()
                }
            })
            .collect();
        assert!(parsed_equals(&mixed.join(" "), &secret));
    }

    #[test]
    fn short_words_match_whole_only() {
        let words = list();
        let index_of = |word: &str| words.iter().position(|w| *w == word).unwrap();
        let with_first = |secret: &RecoverySecret, token: &str| {
            let mut tokens = words_of(secret);
            tokens[0] = token.to_string();
            tokens.join(" ")
        };

        // "act" is a word; "action" starts with it. Each reads as itself and as nothing else.
        let act = secret_with_first_word(index_of("act"), 1);
        let action = secret_with_first_word(index_of("action"), 1);
        assert_eq!(words_of(&act)[0], "act");
        assert_eq!(words_of(&action)[0], "action");
        assert!(parsed_equals(&with_first(&act, "act"), &act));
        assert!(!parsed_equals(&with_first(&act, "acti"), &act));
        assert!(!parsed_equals(&with_first(&action, "act"), &action));
        assert!(parsed_equals(&with_first(&action, "acti"), &action));
        assert!(parsed_equals(&with_first(&action, "ACTION"), &action));

        // Every short word reads only whole; no shorter start of it is a word.
        let short: Vec<&str> = words.iter().copied().filter(|w| w.len() < 4).collect();
        assert!(short.len() > 10);
        for word in short {
            let secret = secret_with_first_word(index_of(word), 2);
            assert_eq!(words_of(&secret)[0], word);
            assert!(parsed_equals(&with_first(&secret, word), &secret), "{word}");
            for end in 1..word.len() {
                assert!(
                    matches!(
                        RecoverySecret::parse(&with_first(&secret, &word[..end])),
                        Err(CoreError::RecoveryKeyWord { position: 1 })
                    ),
                    "{word}"
                );
            }
        }

        // Three letters of a longer word are not enough.
        let base = secret_from_seed(9);
        for word in words.iter().filter(|w| w.len() >= 4) {
            if !words.contains(&&word[..3]) {
                assert!(
                    matches!(
                        RecoverySecret::parse(&with_first(&base, &word[..3])),
                        Err(CoreError::RecoveryKeyWord { position: 1 })
                    ),
                    "{word}"
                );
            }
        }
    }

    #[test]
    fn numbering_case_and_separators_ignored() {
        let secret = secret_from_seed(5);
        let words = words_of(&secret);
        let join = |f: &dyn Fn(usize, &str) -> String| {
            words
                .iter()
                .enumerate()
                .map(|(i, w)| f(i + 1, w))
                .collect::<Vec<_>>()
        };
        let numbered_dots = join(&|n, w| format!("{n}. {w}")).join("\n");
        let numbered_brackets = join(&|n, w| format!("{n}) {w}")).join("\r\n");
        let numbered_bare = join(&|n, w| format!("{n} {w}")).join("  ");
        let numbered_glued = join(&|n, w| format!("{n}.{w}")).join(" ");
        let zero_padded = join(&|n, w| format!("{n:02} {w}")).join(" ");
        let upper = secret.to_display().to_uppercase();
        let capitalised: Vec<String> = words
            .iter()
            .map(|w| format!("{}{}", w[..1].to_uppercase(), &w[1..]))
            .collect();
        let commas = words.join(", ");
        let periods = words.join(". ");
        let tabs = format!("  \t{}\n\n", words.join("\t"));
        let columns = words
            .chunks(2)
            .map(|pair| pair.join("   "))
            .collect::<Vec<_>>()
            .join("\n");
        for text in [
            numbered_dots,
            numbered_brackets,
            numbered_bare,
            numbered_glued,
            zero_padded,
            upper,
            capitalised.join(" "),
            commas,
            periods,
            tabs,
            columns,
        ] {
            assert!(parsed_equals(&text, &secret), "{text:?}");
        }
        // Only the listed separators: a dash does not split, so these words run into one.
        assert!(matches!(
            RecoverySecret::parse(&words.join("-")),
            Err(CoreError::RecoveryKeyCount { found: 1 })
        ));
    }

    #[test]
    fn unknown_word_reports_its_position() {
        let secret = secret_from_seed(7);
        let mut words = words_of(&secret);
        let original = words[6].clone();
        for bad in [
            "zzzz",
            "ab",
            "abx1",
            "w0rd",
            "caf\u{e9}",
            "\u{FF21}\u{FF22}\u{FF23}\u{FF24}", // full-width letters
            "\u{430}bandon",                    // Cyrillic a
            "\u{212A}iwi", // Kelvin sign: Unicode lowercases it to k, ASCII rules do not
        ] {
            words[6] = bad.to_string();
            let plain = words.join(" ");
            let numbered: String = words
                .iter()
                .enumerate()
                .map(|(i, w)| format!("{}. {w}\n", i + 1))
                .collect();
            for text in [plain, numbered] {
                assert!(
                    matches!(
                        RecoverySecret::parse(&text),
                        Err(CoreError::RecoveryKeyWord { position: 7 })
                    ),
                    "{bad:?}"
                );
            }
        }
        words[6] = original;
        // A bad word wins over a wrong count; the first bad word is the one reported.
        words.truncate(20);
        words[2] = "qqqq".into();
        words[4] = "wwww".into();
        assert!(matches!(
            RecoverySecret::parse(&words.join(" ")),
            Err(CoreError::RecoveryKeyWord { position: 3 })
        ));
    }

    #[test]
    fn wrong_count_reports_found() {
        let secret = secret_from_seed(8);
        let words = words_of(&secret);
        let count = |text: &str| match RecoverySecret::parse(text) {
            Err(CoreError::RecoveryKeyCount { found }) => found,
            other => panic!("expected a count refusal, got {other:?}"),
        };
        assert_eq!(count(&words[..23].join(" ")), 23);
        assert_eq!(count(&words[..12].join(" ")), 12);
        assert_eq!(count(&words[..1].join(" ")), 1);
        assert_eq!(count(&format!("{} {}", words.join(" "), words[0])), 25);
        assert_eq!(count(&vec![words.join(" "); 3].join(" ")), 72);
        assert_eq!(count(""), 0);
        assert_eq!(count("  \n\t "), 0);
        assert_eq!(count("1. 2. 3."), 0);
        // Word numbers are not words.
        assert_eq!(count(&format!("1 2 3 {}", words[..22].join(" "))), 22);
    }

    #[test]
    fn listed_wrong_word_caught_at_least_250_in_256() {
        let list = list();
        let (mut detected, mut total) = (0, 0);
        for seed in 0..64usize {
            let secret = secret_from_seed(seed);
            for t in 0..64usize {
                let mut words = words_of(&secret);
                let at = (seed + t) % 24;
                let replacement = list[(seed * 131 + t * 17 + 3) % 2048];
                if words[at] == replacement {
                    continue;
                }
                words[at] = replacement.to_string();
                total += 1;
                match RecoverySecret::parse(&words.join(" ")) {
                    Err(CoreError::RecoveryKeyTypo) => detected += 1,
                    Ok(other) => assert_ne!(*other.0, *secret.0),
                    Err(e) => panic!("unexpected error: {e}"),
                }
            }
        }
        assert!(total > 4000);
        // The check has 8 bits: 255 in 256 are caught; require at least 250 in 256.
        assert!(
            detected * 256 >= total * 250,
            "caught only {detected} of {total}"
        );
        println!("typo detection: {detected}/{total}");
    }

    #[test]
    fn a_very_long_text_is_counted_not_stored() {
        // Only 24 places are kept, whatever the text; the count and the time grow in a straight line with it.
        let started = std::time::Instant::now();
        let text = "abandon ".repeat(500_000);
        assert!(matches!(
            RecoverySecret::parse(&text),
            Err(CoreError::RecoveryKeyCount { found: 500_000 })
        ));
        let junk = format!("{text}zzzz");
        assert!(matches!(
            RecoverySecret::parse(&junk),
            Err(CoreError::RecoveryKeyWord { position: 500_001 })
        ));
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
    }

    #[test]
    fn a_changed_check_word_is_a_typo() {
        // Flipping the last bit of the last word changes only the checksum.
        let list = list();
        let secret = secret_from_seed(11);
        let mut words = words_of(&secret);
        let last = list.iter().position(|w| *w == words[23]).unwrap();
        words[23] = list[last ^ 1].to_string();
        assert!(matches!(
            RecoverySecret::parse(&words.join(" ")),
            Err(CoreError::RecoveryKeyTypo)
        ));
    }

    #[test]
    fn old_character_form_refused() {
        // The earlier 52-character form, as it was shown and as it might be typed.
        let zero = "0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0006";
        let counting = "000G-40R4-0M30-E209-185G-R38E-1W81-24GK-2GAH-C5RR-34D1-P70X-3RFP";
        for text in [
            zero.to_string(),
            counting.to_string(),
            counting.replace('-', " "),
            counting.replace('-', ""),
            counting.to_lowercase(),
        ] {
            assert!(
                matches!(
                    RecoverySecret::parse(&text),
                    Err(CoreError::RecoveryKeyWord { position: 1 })
                ),
                "{text}"
            );
        }
        // Text that is all digits reads as word numbers, so nothing is left to count.
        for text in [zero.replace('-', " "), zero.replace('-', "")] {
            assert!(
                matches!(
                    RecoverySecret::parse(&text),
                    Err(CoreError::RecoveryKeyCount { found: 0 })
                ),
                "{text}"
            );
        }
    }

    #[test]
    fn debug_output_is_redacted() {
        let out = format!("{:?}", secret_from_seed(1));
        assert_eq!(out, "RecoverySecret(<redacted>)");
    }

    #[test]
    fn derived_key_depends_on_salt() {
        let secret = secret_from_seed(1);
        let a = derive_recovery_key(&secret, &[1; 16]);
        let b = derive_recovery_key(&secret, &[2; 16]);
        assert_ne!(a.as_bytes(), b.as_bytes());
        assert_eq!(
            a.as_bytes(),
            derive_recovery_key(&secret, &[1; 16]).as_bytes()
        );
    }

    #[test]
    fn derivation_unchanged() {
        // RFC 5869 HKDF-SHA256, computed independently of this code (Python hmac/hashlib) when the key was still
        // shown in 52 characters; the words are only a new way to write the same secret, so the answer is the same.
        //
        //   def hkdf(ikm, salt, info, L=32):
        //       prk = hmac.new(salt, ikm, hashlib.sha256).digest()          # extract
        //       okm, t, i = b"", b"", 1
        //       while len(okm) < L:                                         # expand
        //           t = hmac.new(prk, t + info + bytes([i]), hashlib.sha256).digest(); okm += t; i += 1
        //       return okm[:L]
        //   print(hkdf(bytes(range(32)), bytes(range(100,116)), b"lockbox recovery key v1").hex())
        let secret = RecoverySecret(Zeroizing::new(std::array::from_fn(|i| i as u8)));
        let salt: [u8; 16] = std::array::from_fn(|i| 100 + i as u8);
        let key = derive_recovery_key(&secret, &salt);
        let hex: String = key.as_bytes().iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex,
            "a51e62b8529288c24770254cb810ad39c53c7d79096392b3945f2ab26bd66cbe"
        );
        // And the words of that secret parse back to it.
        assert!(parsed_equals(&secret.to_display(), &secret));
    }
}
