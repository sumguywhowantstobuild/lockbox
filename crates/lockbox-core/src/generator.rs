//! Password and passphrase generator. All randomness comes from the OS (`secret::fill_random`).
//!
//! Output goes straight into a pre-sized, wiped-on-drop buffer, so no unwiped copy of a
//! generated secret is made along the way. Errors never contain generated text (rule R5).

use crate::secret::random_bytes;
use crate::{CoreError, Result};
use std::sync::LazyLock;
use zeroize::Zeroizing;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasswordOptions {
    /// 8..=128.
    pub length: u8,
    pub lowercase: bool,
    pub uppercase: bool,
    pub digits: bool,
    pub symbols: bool,
    /// Removes `0 O 1 l I |` from every class.
    pub avoid_ambiguous: bool,
}

impl Default for PasswordOptions {
    fn default() -> Self {
        Self {
            length: 20,
            lowercase: true,
            uppercase: true,
            digits: true,
            symbols: true,
            avoid_ambiguous: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PassphraseOptions {
    /// 3..=12.
    pub words: u8,
    /// Not alphanumeric and not a control character.
    pub separator: char,
    /// Upper-case the first letter of each word.
    pub capitalize: bool,
    /// Append one random digit to the end of one randomly chosen word.
    pub include_number: bool,
}

impl Default for PassphraseOptions {
    fn default() -> Self {
        Self {
            words: 5,
            separator: '-',
            capitalize: true,
            include_number: false,
        }
    }
}

const LOWER: &[u8] = b"abcdefghijklmnopqrstuvwxyz";
const UPPER: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS: &[u8] = b"0123456789";
const SYMBOLS: &[u8] = b"!@#$%^&*()-_=+[]{};:,.<>/?~";
const AMBIGUOUS: &[u8] = b"0O1lI|";

/// Longest possible word plus separator and digit, rounded up: sizes the output buffer so it
/// never grows (a growing buffer would leave an unwiped copy behind).
const PASSPHRASE_BYTES_PER_WORD: usize = 16;

fn invalid(what: &'static str) -> CoreError {
    CoreError::InvalidInput { what }
}

/// A fair number in `0..n`: random 32-bit values below `2^32 mod n` are thrown away, so every
/// result is equally likely (plain `% n` would favour small numbers). `n == 0` gives 0.
fn uniform(n: u32) -> u32 {
    if n == 0 {
        return 0;
    }
    let reject_below = n.wrapping_neg() % n; // 2^32 mod n
    loop {
        let r = u32::from_le_bytes(random_bytes::<4>());
        if r >= reject_below {
            return r % n;
        }
    }
}

/// Index in `0..len`. Every slice used here is tiny, so the cast cannot truncate.
fn pick_index(len: usize) -> usize {
    uniform(len as u32) as usize
}

/// Fisher-Yates shuffle driven by `uniform`.
fn shuffle(buf: &mut [u8]) {
    for i in (1..buf.len()).rev() {
        buf.swap(i, pick_index(i + 1));
    }
}

/// The wordlist, parsed once. Each line is `<dice number><TAB><word>`.
fn words() -> &'static [&'static str] {
    static WORDS: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
        include_str!("../wordlists/eff_large_wordlist.txt")
            .lines()
            .map(|l| l.split_once('\t').expect("wordlist line has a tab").1)
            .collect()
    });
    &WORDS
}

pub fn generate_password(o: &PasswordOptions) -> Result<Zeroizing<String>> {
    if !(8..=128).contains(&o.length) {
        return Err(invalid("password length"));
    }
    let classes: Vec<Vec<u8>> = [
        (o.lowercase, LOWER),
        (o.uppercase, UPPER),
        (o.digits, DIGITS),
        (o.symbols, SYMBOLS),
    ]
    .into_iter()
    .filter(|(on, _)| *on)
    .map(|(_, set)| {
        set.iter()
            .copied()
            .filter(|b| !(o.avoid_ambiguous && AMBIGUOUS.contains(b)))
            .collect()
    })
    .collect();
    if classes.is_empty() {
        return Err(invalid("no character class selected"));
    }
    let pool: Vec<u8> = classes.concat();

    // One character from each chosen class first, the rest from the whole pool, then shuffle.
    let mut buf = Zeroizing::new(Vec::with_capacity(o.length as usize));
    buf.extend(classes.iter().map(|c| c[pick_index(c.len())]));
    while buf.len() < o.length as usize {
        buf.push(pool[pick_index(pool.len())]);
    }
    shuffle(&mut buf);
    // All bytes are ASCII; `from_utf8` takes the buffer over without copying it.
    let text = String::from_utf8(std::mem::take(&mut *buf)).expect("ASCII only");
    Ok(Zeroizing::new(text))
}

pub fn generate_passphrase(o: &PassphraseOptions) -> Result<Zeroizing<String>> {
    if !(3..=12).contains(&o.words) {
        return Err(invalid("word count"));
    }
    if o.separator.is_alphanumeric() || o.separator.is_control() {
        return Err(invalid("passphrase separator"));
    }
    let list = words();
    let n = o.words as usize;
    // Which word gets the digit; `n` means none.
    let numbered = if o.include_number { pick_index(n) } else { n };
    let mut out = Zeroizing::new(String::with_capacity(n * PASSPHRASE_BYTES_PER_WORD));
    for i in 0..n {
        if i > 0 {
            out.push(o.separator);
        }
        let word = list[pick_index(list.len())];
        if o.capitalize {
            // Words are lowercase ASCII, so the first byte is the first letter.
            out.push(word.as_bytes()[0].to_ascii_uppercase() as char);
            out.push_str(&word[1..]);
        } else {
            out.push_str(word);
        }
        if i == numbered {
            out.push(char::from(b'0' + uniform(10) as u8));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    const LISTED_SYMBOLS: &str = "!@#$%^&*()-_=+[]{};:,.<>/?~";

    fn only(lower: bool, upper: bool, digits: bool, symbols: bool, length: u8) -> PasswordOptions {
        PasswordOptions {
            length,
            lowercase: lower,
            uppercase: upper,
            digits,
            symbols,
            avoid_ambiguous: false,
        }
    }

    fn spaced(words: u8) -> PassphraseOptions {
        PassphraseOptions {
            words,
            separator: ' ',
            capitalize: false,
            include_number: false,
        }
    }

    #[test]
    fn length_respected() {
        for length in [8u8, 20, 64, 128] {
            let o = PasswordOptions {
                length,
                ..Default::default()
            };
            assert_eq!(
                generate_password(&o).unwrap().chars().count(),
                length as usize
            );
        }
    }

    #[test]
    fn every_selected_class_present() {
        let o = PasswordOptions {
            length: 8,
            ..Default::default()
        };
        for _ in 0..1000 {
            let p = generate_password(&o).unwrap();
            assert!(p.chars().any(|c| c.is_ascii_lowercase()));
            assert!(p.chars().any(|c| c.is_ascii_uppercase()));
            assert!(p.chars().any(|c| c.is_ascii_digit()));
            assert!(p.chars().any(|c| LISTED_SYMBOLS.contains(c)));
        }
    }

    #[test]
    fn only_selected_classes_used() {
        let p = generate_password(&only(false, false, true, false, 128)).unwrap();
        assert!(p.chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn symbol_set_is_exactly_the_listed_one() {
        let mut seen = BTreeSet::new();
        for _ in 0..200 {
            seen.extend(
                generate_password(&only(false, false, false, true, 128))
                    .unwrap()
                    .chars(),
            );
        }
        assert_eq!(seen, LISTED_SYMBOLS.chars().collect::<BTreeSet<_>>());
    }

    #[test]
    fn no_class_selected_rejected() {
        let o = only(false, false, false, false, 20);
        assert!(matches!(
            generate_password(&o),
            Err(CoreError::InvalidInput { .. })
        ));
    }

    #[test]
    fn out_of_range_length_rejected() {
        for length in [0u8, 7, 129, 255] {
            let o = PasswordOptions {
                length,
                ..Default::default()
            };
            assert!(matches!(
                generate_password(&o),
                Err(CoreError::InvalidInput { .. })
            ));
        }
    }

    #[test]
    fn ambiguous_excluded() {
        let o = PasswordOptions {
            length: 128,
            avoid_ambiguous: true,
            ..Default::default()
        };
        for _ in 0..200 {
            let p = generate_password(&o).unwrap();
            assert!(!p.chars().any(|c| "0O1lI|".contains(c)));
        }
    }

    #[test]
    fn ambiguous_filter_keeps_every_class_available() {
        // Each class still has characters left after the filter, so all four stay present.
        let o = PasswordOptions {
            length: 8,
            avoid_ambiguous: true,
            ..Default::default()
        };
        for _ in 0..200 {
            let p = generate_password(&o).unwrap();
            assert!(p.chars().any(|c| c.is_ascii_digit()));
            assert!(p.chars().any(|c| c.is_ascii_uppercase()));
        }
    }

    #[test]
    fn passphrase_word_count_and_separator() {
        for n in [3u8, 5, 12] {
            let o = PassphraseOptions {
                separator: '.',
                ..spaced(n)
            };
            let p = generate_passphrase(&o).unwrap();
            // The separator is never a letter, and no word contains '.', so the split is exact.
            assert_eq!(p.split('.').count(), n as usize);
        }
    }

    #[test]
    fn words_come_from_list() {
        let list: BTreeSet<&str> = words().iter().copied().collect();
        let p = generate_passphrase(&spaced(12)).unwrap();
        for w in p.split(' ') {
            assert!(list.contains(w), "word not in list");
        }
    }

    #[test]
    fn out_of_range_words_rejected() {
        for n in [0u8, 2, 13, 255] {
            assert!(matches!(
                generate_passphrase(&spaced(n)),
                Err(CoreError::InvalidInput { .. })
            ));
        }
    }

    #[test]
    fn bad_separator_rejected() {
        for separator in ['a', 'Z', '7', 'é', '\n', '\t', '\0'] {
            let o = PassphraseOptions {
                separator,
                ..spaced(5)
            };
            assert!(
                matches!(generate_passphrase(&o), Err(CoreError::InvalidInput { .. })),
                "separator {separator:?} should be rejected"
            );
        }
        for separator in [' ', '-', '_', '.', '/', '·'] {
            let o = PassphraseOptions {
                separator,
                ..spaced(5)
            };
            assert!(generate_passphrase(&o).is_ok());
        }
    }

    #[test]
    fn capitalize_upper_cases_each_first_letter() {
        let list: BTreeSet<&str> = words().iter().copied().collect();
        let o = PassphraseOptions {
            capitalize: true,
            ..spaced(12)
        };
        let p = generate_passphrase(&o).unwrap();
        for w in p.split(' ') {
            let first = w.chars().next().unwrap();
            assert!(first.is_ascii_uppercase());
            let lowered = format!("{}{}", first.to_ascii_lowercase(), &w[1..]);
            assert!(list.contains(lowered.as_str()), "rest of word changed");
        }
    }

    #[test]
    fn include_number_adds_exactly_one_digit_at_the_end_of_one_word() {
        let list: BTreeSet<&str> = words().iter().copied().collect();
        let o = PassphraseOptions {
            include_number: true,
            ..spaced(5)
        };
        let mut positions = BTreeSet::new();
        let mut digits = BTreeSet::new();
        for _ in 0..500 {
            let p = generate_passphrase(&o).unwrap();
            assert_eq!(p.chars().filter(|c| c.is_ascii_digit()).count(), 1);
            let tokens: Vec<&str> = p.split(' ').collect();
            assert_eq!(tokens.len(), 5);
            for (i, t) in tokens.iter().enumerate() {
                match t.strip_suffix(|c: char| c.is_ascii_digit()) {
                    Some(word) => {
                        assert!(list.contains(word));
                        positions.insert(i);
                        digits.insert(t.chars().last().unwrap());
                    }
                    None => assert!(list.contains(t)),
                }
            }
        }
        assert_eq!(
            positions.len(),
            5,
            "every word position gets chosen sometimes"
        );
        assert_eq!(digits.len(), 10, "every digit appears sometimes");
    }

    #[test]
    fn wordlist_has_7776_unique_words() {
        let w = words();
        assert_eq!(w.len(), 7776);
        assert_eq!(w.iter().collect::<BTreeSet<_>>().len(), 7776);
        assert!(
            w.iter()
                .all(|w| !w.is_empty() && w.bytes().all(|b| b.is_ascii_lowercase() || b == b'-'))
        );
    }

    #[test]
    fn wordlist_file_is_dice_tab_word() {
        let raw = include_str!("../wordlists/eff_large_wordlist.txt");
        assert_eq!(raw.lines().count(), 7776);
        for line in raw.lines() {
            let (dice, word) = line.split_once('\t').unwrap();
            assert!(dice.len() == 5 && dice.bytes().all(|b| (b'1'..=b'6').contains(&b)));
            assert!(!word.is_empty() && word.bytes().all(|b| b.is_ascii_lowercase() || b == b'-'));
        }
    }

    #[test]
    fn uniform_distribution_rough() {
        let mut counts = [0u32; 10];
        for _ in 0..100_000 {
            counts[uniform(10) as usize] += 1;
        }
        // Standard deviation is about 95, so +/-500 is more than 5 sigma.
        for c in counts {
            assert!((9_500..=10_500).contains(&c), "bucket count {c}");
        }
    }

    #[test]
    fn uniform_edges() {
        assert_eq!(uniform(0), 0);
        assert_eq!(uniform(1), 0);
        for n in [2u32, 3, 1 << 31, u32::MAX] {
            assert!(uniform(n) < n);
        }
    }
}
