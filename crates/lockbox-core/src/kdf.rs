//! Password key derivation: Argon2id over the NFC-normalised password.
//! Parameters read from a vault file are untrusted and checked before any work is done.

use crate::error::{CoreError, Result};
use crate::secret::Key32;
use argon2::{Algorithm, Argon2, AssociatedData, Error, ParamsBuilder, Version};
use serde::{Deserialize, Serialize};
use std::ops::RangeInclusive;
use std::time::{Duration, Instant};
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

/// Minimum length of a new master password, in Unicode characters after NFC.
pub const MIN_PASSWORD_CHARS: usize = 12;

// Bounds accepted when reading a vault file (spec 5.2). Creation clamps tighter.
const READ_MEMORY_KIB: RangeInclusive<u32> = 65_536..=1_048_576;
const READ_ITERATIONS: RangeInclusive<u32> = 3..=10;
const READ_PARALLELISM: RangeInclusive<u32> = 4..=16;
const CREATE_MAX_MEMORY_KIB: u32 = 262_144;
const CREATE_PARALLELISM: u32 = 4;

/// Argon2id cost settings. Stored in key slots, so they are untrusted when read back.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Argon2Params {
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
}

impl Argon2Params {
    /// Refuses settings outside the accepted bounds. Call before any derivation.
    pub fn validate_for_read(&self) -> Result<()> {
        if READ_MEMORY_KIB.contains(&self.memory_kib)
            && READ_ITERATIONS.contains(&self.iterations)
            && READ_PARALLELISM.contains(&self.parallelism)
        {
            Ok(())
        } else {
            Err(CoreError::ParamsOutOfBounds)
        }
    }

    /// Picks settings that take about `target` on this machine, within the creation clamp:
    /// grow memory first (while a run takes under half the target), then iterations.
    pub fn calibrate(target: Duration) -> Self {
        let mut params = Self {
            memory_kib: *READ_MEMORY_KIB.start(),
            iterations: *READ_ITERATIONS.start(),
            parallelism: CREATE_PARALLELISM,
        };
        let Some(mut elapsed) = params.time_one_run() else {
            return params;
        };
        while elapsed < target / 2 && params.memory_kib < CREATE_MAX_MEMORY_KIB {
            let grown = Self {
                memory_kib: params.memory_kib * 2,
                ..params
            };
            let Some(took) = grown.time_one_run() else {
                return params;
            };
            (params, elapsed) = (grown, took);
        }
        while elapsed < target && params.iterations < *READ_ITERATIONS.end() {
            let grown = Self {
                iterations: params.iterations + 1,
                ..params
            };
            let Some(took) = grown.time_one_run() else {
                return params;
            };
            (params, elapsed) = (grown, took);
        }
        params
    }

    /// The settings as bytes for a key slot's authenticated data: m, t, p, each u32 little-endian.
    // `&self` so `Option<&Argon2Params>::map` can take it by name (`slots::slot_ad`); clippy asks
    // for `self` only now that the type is no longer exported.
    #[allow(clippy::wrong_self_convention)]
    pub fn to_ad_bytes(&self) -> [u8; 12] {
        let mut bytes = [0u8; 12];
        bytes[0..4].copy_from_slice(&self.memory_kib.to_le_bytes());
        bytes[4..8].copy_from_slice(&self.iterations.to_le_bytes());
        bytes[8..12].copy_from_slice(&self.parallelism.to_le_bytes());
        bytes
    }

    /// One derivation with throwaway inputs; `None` if it could not run (e.g. out of memory).
    fn time_one_run(&self) -> Option<Duration> {
        let start = Instant::now();
        let mut out = [0u8; 32];
        argon2id_raw(
            b"lockbox calibration",
            &[0u8; 16],
            self.memory_kib,
            self.iterations,
            self.parallelism,
            None,
            None,
            &mut out,
        )
        .ok()?;
        Some(start.elapsed())
    }
}

/// Password to 32-byte key: Argon2id over the UTF-8 bytes of the NFC-normalised password.
/// The settings are checked first, so a hostile vault file cannot make us do heavy work.
pub fn derive_password_key(
    password: &str,
    salt: &[u8; 16],
    params: &Argon2Params,
) -> Result<Key32> {
    params.validate_for_read()?;
    if password.is_empty() {
        return Err(CoreError::InvalidInput {
            what: "password is empty",
        });
    }
    // Pre-sized so it never reallocates and leaves an unwiped copy behind
    // (NFC can lengthen text, but nowhere near 3x for real passwords).
    let mut normalised = Zeroizing::new(String::with_capacity(password.len() * 3));
    normalised.extend(password.nfc());
    Key32::fill_with(|out| {
        argon2id_raw(
            normalised.as_bytes(),
            salt,
            params.memory_kib,
            params.iterations,
            params.parallelism,
            None,
            None,
            out,
        )
    })
}

/// Checks a password being **set** (vault creation, password change). Never call at unlock,
/// so raising the minimum later cannot lock anyone out.
pub fn check_new_password(password: &str) -> Result<()> {
    if password.nfc().count() < MIN_PASSWORD_CHARS {
        return Err(CoreError::PasswordTooShort {
            min: MIN_PASSWORD_CHARS,
        });
    }
    Ok(())
}

/// Raw Argon2id (version 19) with no bounds checks, so tests and the recovery-key code can use
/// its secret and associated-data inputs. Callers holding untrusted settings must validate first.
// Eight parameters mirror the Argon2 inputs one-to-one; a struct would only add noise here.
#[allow(clippy::too_many_arguments)]
pub(crate) fn argon2id_raw(
    password: &[u8],
    salt: &[u8],
    m: u32,
    t: u32,
    p: u32,
    secret: Option<&[u8]>,
    ad: Option<&[u8]>,
    out: &mut [u8],
) -> Result<()> {
    const BAD_INPUT: CoreError = CoreError::InvalidInput {
        what: "key derivation input",
    };
    #[cfg(test)]
    ARGON2_RUNS.with(|n| n.set(n.get() + 1));
    let mut builder = ParamsBuilder::new();
    builder.m_cost(m).t_cost(t).p_cost(p);
    if let Some(ad) = ad {
        builder.data(AssociatedData::new(ad).map_err(|_| BAD_INPUT)?);
    }
    let params = builder.build().map_err(|_| BAD_INPUT)?;
    let argon2 = match secret {
        Some(secret) => {
            Argon2::new_with_secret(secret, Algorithm::Argon2id, Version::V0x13, params)
                .map_err(|_| BAD_INPUT)?
        }
        None => Argon2::new(Algorithm::Argon2id, Version::V0x13, params),
    };
    argon2
        .hash_password_into(password, salt, out)
        .map_err(|e| match e {
            Error::OutOfMemory => CoreError::TooLarge {
                what: "key derivation memory",
            },
            _ => BAD_INPUT,
        })
}

// How many times Argon2 was entered on this thread, so a test can prove it never ran.
#[cfg(test)]
thread_local! {
    static ARGON2_RUNS: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
mod tests {
    use super::*;

    const SALT: [u8; 16] = [9; 16];
    const MIN: Argon2Params = Argon2Params {
        memory_kib: 65_536,
        iterations: 3,
        parallelism: 4,
    };

    fn key_of(password: &str, salt: &[u8; 16]) -> Key32 {
        derive_password_key(password, salt, &MIN).unwrap()
    }

    #[test]
    fn rfc9106_argon2id_known_answer() {
        // RFC 9106 section 5.3 (Argon2id, version 19), tag copied from the RFC text.
        let expected: [u8; 32] = [
            0x0d, 0x64, 0x0d, 0xf5, 0x8d, 0x78, 0x76, 0x6c, 0x08, 0xc0, 0x37, 0xa3, 0x4a, 0x8b,
            0x53, 0xc9, 0xd0, 0x1e, 0xf0, 0x45, 0x2d, 0x75, 0xb6, 0x5e, 0xb5, 0x25, 0x20, 0xe9,
            0x6b, 0x01, 0xe6, 0x59,
        ];
        let mut out = [0u8; 32];
        argon2id_raw(
            &[0x01; 32],
            &[0x02; 16],
            32,
            3,
            4,
            Some(&[0x03; 8]),
            Some(&[0x04; 12]),
            &mut out,
        )
        .unwrap();
        assert_eq!(out, expected);
    }

    #[test]
    fn out_of_bounds_params_refused() {
        let bad = [
            Argon2Params {
                memory_kib: 65_535,
                ..MIN
            },
            Argon2Params {
                memory_kib: 1_048_577,
                ..MIN
            },
            Argon2Params {
                iterations: 2,
                ..MIN
            },
            Argon2Params {
                iterations: 11,
                ..MIN
            },
            Argon2Params {
                parallelism: 3,
                ..MIN
            },
            Argon2Params {
                parallelism: 17,
                ..MIN
            },
        ];
        for params in bad {
            assert!(matches!(
                params.validate_for_read(),
                Err(CoreError::ParamsOutOfBounds)
            ));
            let runs = ARGON2_RUNS.with(|n| n.get());
            let result = derive_password_key("a long enough password", &SALT, &params);
            assert!(matches!(result, Err(CoreError::ParamsOutOfBounds)));
            assert_eq!(
                ARGON2_RUNS.with(|n| n.get()),
                runs,
                "{params:?} reached Argon2"
            );
        }
        // The counter does count: a valid derivation moves it.
        let runs = ARGON2_RUNS.with(|n| n.get());
        derive_password_key("a long enough password", &SALT, &MIN).unwrap();
        assert_eq!(ARGON2_RUNS.with(|n| n.get()), runs + 1);
    }

    #[test]
    fn bounds_edges_accepted() {
        for params in [
            MIN,
            Argon2Params {
                memory_kib: 1_048_576,
                iterations: 10,
                parallelism: 16,
            },
        ] {
            params.validate_for_read().unwrap();
        }
    }

    #[test]
    fn calibration_always_within_read_bounds() {
        let params = Argon2Params::calibrate(Duration::from_millis(1000));
        params.validate_for_read().unwrap();
        assert_eq!(params.parallelism, 4);
        assert!(params.memory_kib <= 262_144);
    }

    #[test]
    fn calibration_with_tiny_target_gives_minimum_cost() {
        assert_eq!(Argon2Params::calibrate(Duration::ZERO), MIN);
    }

    #[test]
    fn ad_bytes_are_m_t_p_little_endian() {
        let params = Argon2Params {
            memory_kib: 0x0102_0304,
            iterations: 5,
            parallelism: 6,
        };
        assert_eq!(params.to_ad_bytes(), [4, 3, 2, 1, 5, 0, 0, 0, 6, 0, 0, 0]);
    }

    #[test]
    fn params_serde_round_trip() {
        let json = serde_json::to_string(&MIN).unwrap();
        assert_eq!(serde_json::from_str::<Argon2Params>(&json).unwrap(), MIN);
    }

    #[test]
    fn nfc_normalisation() {
        assert_eq!(
            key_of("caf\u{e9}", &SALT).as_bytes(),
            key_of("cafe\u{301}", &SALT).as_bytes()
        );
    }

    #[test]
    fn spaces_are_significant() {
        assert_ne!(
            key_of("pw ", &SALT).as_bytes(),
            key_of("pw", &SALT).as_bytes()
        );
    }

    #[test]
    fn empty_password_rejected() {
        assert!(matches!(
            derive_password_key("", &SALT, &MIN),
            Err(CoreError::InvalidInput { .. })
        ));
    }

    #[test]
    fn new_password_minimum() {
        assert!(matches!(
            check_new_password("elevenchars"),
            Err(CoreError::PasswordTooShort { min: 12 })
        ));
        check_new_password("twelvechars!").unwrap();
        // 11 plain characters plus "e" + combining accent (1 character after NFC) is 12.
        check_new_password("elevenchars\u{e9}").unwrap();
        assert!(matches!(
            check_new_password("elevenchar\u{e9}"),
            Err(CoreError::PasswordTooShort { min: 12 })
        ));
        assert!(matches!(
            check_new_password("elevenchare\u{301}"),
            Err(CoreError::PasswordTooShort { min: 12 })
        ));
        check_new_password("elevenchare\u{301}!").unwrap();
        check_new_password(&"\u{1F600}".repeat(12)).unwrap();
        assert!(check_new_password("").is_err());
    }

    #[test]
    fn same_inputs_same_key() {
        assert_eq!(
            key_of("same password", &SALT).as_bytes(),
            key_of("same password", &SALT).as_bytes()
        );
    }

    #[test]
    fn different_salt_different_key() {
        assert_ne!(
            key_of("same password", &SALT).as_bytes(),
            key_of("same password", &[8; 16]).as_bytes()
        );
    }
}
