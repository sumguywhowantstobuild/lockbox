//! The calendar dates the shell writes and reads: the moment a backup finished (kept in `vault-state.json`) and the
//! moment a vault was made (in its header, written by the engine). One shape only, `YYYY-MM-DDTHH:MM:SSZ` (RFC 3339,
//! UTC, whole seconds), which is exactly what both of them are written as. Anything else is not a date here, so a note
//! something else wrote counts as no date rather than a guess. No dependency: the calendar arithmetic is Howard
//! Hinnant's `civil_from_days` and `days_from_civil`, as the engine's own writer uses.

use std::time::{SystemTime, UNIX_EPOCH};

const DAY: u64 = 86_400;

/// `time` as `YYYY-MM-DDTHH:MM:SSZ`. A clock set before 1970 is written as the epoch itself: not worth failing a
/// backup over.
pub fn rfc3339_utc(time: SystemTime) -> String {
    let secs = unix_secs(time);
    let (year, month, day) = civil_from_days((secs / DAY) as i64);
    let rest = secs % DAY;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

/// Seconds since the Unix epoch of a date in exactly the shape [`rfc3339_utc`] writes, or `None` for anything else
/// (another shape, a date that does not exist, a date before 1970).
pub fn parse_utc(text: &str) -> Option<u64> {
    let bytes = text.as_bytes();
    if bytes.len() != 20 {
        return None;
    }
    for (at, mark) in [
        (4, b'-'),
        (7, b'-'),
        (10, b'T'),
        (13, b':'),
        (16, b':'),
        (19, b'Z'),
    ] {
        if bytes[at] != mark {
            return None;
        }
    }
    let number = |from: usize, to: usize| -> Option<u64> {
        let digits = &bytes[from..to];
        if !digits.iter().all(u8::is_ascii_digit) {
            return None;
        }
        Some(digits.iter().fold(0, |n, d| n * 10 + u64::from(d - b'0')))
    };
    let (year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    let (hour, minute, second) = (number(11, 13)?, number(14, 16)?, number(17, 19)?);
    if year < 1970 || !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let days = days_from_civil(year as i64, month as i64, day as i64);
    Some(days as u64 * DAY + hour * 3600 + minute * 60 + second)
}

/// The date (`YYYY-MM-DD`) the moment `secs` (seconds since the Unix epoch, UTC) falls on in a zone `offset_secs` east of
/// UTC (negative: west): the day a person there calls it.
pub fn local_date_of(secs: u64, offset_secs: i64) -> String {
    let moved = i64::try_from(secs)
        .unwrap_or(i64::MAX)
        .saturating_add(offset_secs);
    let (year, month, day) = civil_from_days(moved.div_euclid(DAY as i64));
    format!("{year:04}-{month:02}-{day:02}")
}

/// Seconds since the Unix epoch of a civil time (the same moment in whatever zone the numbers are read in: the caller
/// subtracts one reading from another to learn the zone). Before 1970 is negative.
pub fn civil_secs(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64) -> i64 {
    days_from_civil(year, month, day) * DAY as i64 + hour * 3600 + minute * 60 + second
}

/// Seconds since the Unix epoch of `time`; none for a clock set before 1970.
pub fn unix_secs(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// How many whole days lie between `then` and `now` (both seconds since the epoch): none when `now` is not later,
/// which is what a clock set back looks like.
pub fn whole_days_since(then: u64, now: u64) -> u32 {
    u32::try_from(now.saturating_sub(then) / DAY).unwrap_or(u32::MAX)
}

fn days_in_month(year: u64, month: u64) -> u64 {
    match month {
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days since 1970-01-01 to (year, month, day) in the proleptic Gregorian calendar.
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

/// (year, month, day) to days since 1970-01-01, the inverse of [`civil_from_days`].
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year.rem_euclid(400);
    let shifted_month = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, UNIX_EPOCH};

    use super::*;

    fn at(secs: u64) -> std::time::SystemTime {
        UNIX_EPOCH + Duration::from_secs(secs)
    }

    #[test]
    fn known_dates_format_as_rfc_3339_utc() {
        assert_eq!(rfc3339_utc(at(0)), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_utc(at(951_782_400)), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339_utc(at(1_794_830_400)), "2026-11-16T12:00:00Z");
        // 2100 is not a leap year.
        assert_eq!(rfc3339_utc(at(4_107_542_399)), "2100-02-28T23:59:59Z");
        assert_eq!(rfc3339_utc(at(4_107_542_400)), "2100-03-01T00:00:00Z");
        // A clock set before 1970 is not worth failing a backup over.
        assert_eq!(
            rfc3339_utc(UNIX_EPOCH - Duration::from_secs(5)),
            "1970-01-01T00:00:00Z"
        );
    }

    #[test]
    fn what_is_written_reads_back_exactly() {
        for secs in (0..5_000_000_000u64).step_by(86_399 * 7 + 13) {
            let text = rfc3339_utc(at(secs));
            assert_eq!(parse_utc(&text), Some(secs), "{text}");
        }
        assert_eq!(parse_utc("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_utc("2000-02-29T23:59:59Z"), Some(951_868_799));
        assert_eq!(parse_utc("2026-11-16T12:00:00Z"), Some(1_794_830_400));
    }

    /// Only the one shape the engine and the shell write is read: anything else is not a date here, so a note that
    /// something else wrote counts as no backup.
    #[test]
    fn only_the_written_shape_is_read() {
        for bad in [
            "",
            "yesterday",
            "2026-11-06",
            "2026-11-06T09:30:00",
            "2026-11-06T09:30:00z",
            "2026-11-06t09:30:00Z",
            "2026-11-06 09:30:00Z",
            "2026-11-06T09:30:00+00:00",
            "2026-11-06T09:30:00.5Z",
            " 2026-11-06T09:30:00Z",
            "2026-11-06T09:30:00Z ",
            "2026-11-06T09:30:00Z\n",
            "+026-11-06T09:30:00Z",
            "2026-1-06T09:30:00ZZ",
            "2026-13-01T00:00:00Z",
            "2026-00-10T00:00:00Z",
            "2026-11-00T00:00:00Z",
            "2026-11-31T00:00:00Z",
            "2026-02-29T00:00:00Z",
            "2026-11-06T24:00:00Z",
            "2026-11-06T09:60:00Z",
            "2026-11-06T09:30:60Z",
            "1969-12-31T23:59:59Z",
            "２０２６-11-06T09:30:00Z",
            "2026-11-06T09:30:0\u{0663}Z",
        ] {
            assert_eq!(parse_utc(bad), None, "{bad:?}");
        }
        // A leap day is a day.
        assert_eq!(parse_utc("2024-02-29T00:00:00Z"), Some(1_709_164_800));
    }

    /// Whole days between two instants: floored, and nothing when the second is not later.
    #[test]
    fn whole_days_floor_and_never_go_negative() {
        assert_eq!(whole_days_since(1_000, 1_000), 0);
        assert_eq!(whole_days_since(1_000, 1_000 + 86_399), 0);
        assert_eq!(whole_days_since(1_000, 1_000 + 86_400), 1);
        assert_eq!(whole_days_since(1_000, 1_000 + 30 * 86_400 + 5), 30);
        assert_eq!(whole_days_since(5_000, 1_000), 0);
        assert_eq!(whole_days_since(0, u64::MAX), u32::MAX);
    }

    /// The date a person calls a moment: the UTC moment moved by the PC's zone. A backup made at 07:30 in Manila is the
    /// 17th there and the 16th in UTC.
    #[test]
    fn the_zone_moves_the_date() {
        let local = |text: &str, hours: i64| local_date_of(parse_utc(text).unwrap(), hours * 3600);
        assert_eq!(local("2026-11-16T23:30:00Z", 0), "2026-11-16");
        assert_eq!(local("2026-11-16T23:30:00Z", 8), "2026-11-17");
        assert_eq!(local("2026-11-16T16:00:00Z", 8), "2026-11-17");
        assert_eq!(local("2026-11-16T15:59:59Z", 8), "2026-11-16");
        assert_eq!(local("2026-11-17T01:00:00Z", -5), "2026-11-16");
        assert_eq!(local("2026-12-31T20:00:00Z", 5), "2027-01-01");
        assert_eq!(local("2024-03-01T01:00:00Z", -2), "2024-02-29");
        // Half an hour, and before 1970 once the zone is applied.
        assert_eq!(
            local_date_of(parse_utc("2026-11-16T18:29:59Z").unwrap(), 19_800),
            "2026-11-16"
        );
        assert_eq!(
            local_date_of(parse_utc("2026-11-16T18:30:00Z").unwrap(), 19_800),
            "2026-11-17"
        );
        assert_eq!(local_date_of(0, -3600), "1969-12-31");
    }

    /// The seconds of a civil time, which the real clock reads its zone from (two readings of the same moment).
    #[test]
    fn civil_seconds_match_the_epoch_ones() {
        assert_eq!(civil_secs(1970, 1, 1, 0, 0, 0), 0);
        assert_eq!(civil_secs(2026, 11, 16, 12, 0, 0), 1_794_830_400);
        assert_eq!(civil_secs(1969, 12, 31, 23, 59, 59), -1);
        assert_eq!(
            civil_secs(2026, 11, 17, 7, 30, 0) - civil_secs(2026, 11, 16, 23, 30, 0),
            8 * 3600
        );
    }
}
