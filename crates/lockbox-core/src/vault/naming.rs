//! Vault names, folder names and the creation time. Pure functions, no file access.

use crate::ids::VaultId;
use crate::{CoreError, Result};
use std::time::{SystemTime, UNIX_EPOCH};

/// Longest vault name accepted, in Unicode scalar values.
const MAX_NAME_CHARS: usize = 200;
/// Longest folder name produced: Windows tools cope badly with long paths.
const MAX_FOLDER_CHARS: usize = 64;
/// Characters of the vault ID appended to the folder name.
const SHORT_ID_CHARS: usize = 8;

/// A name must contain something visible and stay under [`MAX_NAME_CHARS`].
pub(super) fn validate_name(name: &str) -> Result<()> {
    if name.trim().is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Err(CoreError::InvalidInput { what: "vault name" });
    }
    Ok(())
}

/// The folder a vault lives in: the name reduced to `[A-Za-z0-9 _-]`, then `-` and the
/// first 8 hex characters of the ID, at most 64 characters in all. The exact name is
/// kept in `vault.json`; the folder name only has to be safe and recognisable.
pub(crate) fn folder_name(name: &str, id: &VaultId) -> String {
    let suffix = format!("-{}", &id.to_hex()[..SHORT_ID_CHARS]);
    let base: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '-'))
        .take(MAX_FOLDER_CHARS - suffix.len())
        .collect();
    // Windows silently drops trailing spaces from folder names.
    let base = base.trim_end_matches(' ');
    format!("{}{suffix}", if base.is_empty() { "Vault" } else { base })
}

/// Seconds since the Unix epoch.
pub(super) fn now_secs() -> u64 {
    // A clock set before 1970 is not worth failing a vault change over.
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Now as `YYYY-MM-DDTHH:MM:SSZ` (RFC 3339, UTC).
pub(super) fn created_at_now() -> String {
    rfc3339_utc(now_secs())
}

/// Seconds since the Unix epoch as `YYYY-MM-DDTHH:MM:SSZ`.
pub(super) fn rfc3339_utc(secs: u64) -> String {
    let (year, month, day) = civil_from_days((secs / 86_400) as i64);
    let rest = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

/// Days since 1970-01-01 to (year, month, day) in the proleptic Gregorian calendar
/// (Howard Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153; // 0 = March
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: VaultId = VaultId([0xAB; 16]);

    #[test]
    fn created_at_known_dates() {
        assert_eq!(rfc3339_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_utc(951_782_400), "2000-02-29T00:00:00Z");
        // 2100 is not a leap year: the day after 28 February is 1 March.
        assert_eq!(rfc3339_utc(4_107_542_399), "2100-02-28T23:59:59Z");
        assert_eq!(rfc3339_utc(4_107_542_400), "2100-03-01T00:00:00Z");
    }

    #[test]
    fn created_at_now_has_the_right_shape() {
        let now = created_at_now();
        assert_eq!(now.len(), 20);
        assert!(now.starts_with("20") && now.ends_with('Z') && now.as_bytes()[10] == b'T');
    }

    #[test]
    fn names_are_validated_by_character_count() {
        assert!(validate_name("Family").is_ok());
        assert!(validate_name(&"é".repeat(200)).is_ok()); // 400 bytes, 200 characters
        for bad in ["", "  \t\n", &"x".repeat(201)] {
            assert!(matches!(
                validate_name(bad),
                Err(CoreError::InvalidInput { .. })
            ));
        }
    }

    #[test]
    fn folder_names_are_safe_and_short() {
        assert_eq!(folder_name("Family", &ID), "Family-abababab");
        assert_eq!(folder_name("Clients 🔐", &ID), "Clients-abababab");
        assert_eq!(folder_name("a<b>:c\"d/e\\f|g?h*", &ID), "abcdefgh-abababab");
        assert_eq!(folder_name("My_vault - 2", &ID), "My_vault - 2-abababab");
        // Nothing usable left: fall back, never produce an empty base.
        assert_eq!(folder_name("🔐🔐", &ID), "Vault-abababab");
        assert_eq!(folder_name("é".repeat(200).as_str(), &ID), "Vault-abababab");
        assert_eq!(folder_name("CON", &ID), "CON-abababab");
        let long = folder_name(&"x".repeat(200), &ID);
        assert_eq!(long.len(), 64);
        assert!(long.ends_with("-abababab"));
        // Cutting at the cap must not leave a trailing space before the suffix.
        let spaced = folder_name(&format!("{} y", "x".repeat(54)), &ID);
        assert_eq!(spaced, format!("{}-abababab", "x".repeat(54)));
    }
}
