//! The regular market schedule in America/New_York (R12, R13, R44, D49).
//!
//! A regular market on `trading_day` mints from 9:00 AM, trades from 9:30 AM and closes at
//! 4:00 PM, or 1:00 PM on an early close. The UTC offset follows the US daylight-saving rule:
//! UTC−4 from the second Sunday of March to the first Sunday of November, UTC−5 otherwise. The
//! clock changes at 2:00 AM, before any market time, so the date alone decides the offset.

const HOUR: i64 = 3600;
const DAY: i64 = 24 * HOUR;

/// Whether the times are the regular schedule of `trading_day` (YYYYMMDD).
pub fn is_regular_schedule(
    trading_day: u32,
    mint_open_ts: i64,
    trading_open_ts: i64,
    close_ts: i64,
) -> bool {
    let Some((year, month, day)) = parse_day(trading_day) else {
        return false;
    };
    let date = days_from_civil(year, month, day);
    let offset = if is_daylight_saving(year, date) {
        4 * HOUR
    } else {
        5 * HOUR
    };
    let et = |secs: i64| date * DAY + secs + offset;
    mint_open_ts == et(9 * HOUR)
        && trading_open_ts == et(9 * HOUR + HOUR / 2)
        && (close_ts == et(16 * HOUR) || close_ts == et(13 * HOUR))
}

/// Splits YYYYMMDD and rejects dates that don't exist.
fn parse_day(trading_day: u32) -> Option<(i64, u32, u32)> {
    let year = i64::from(trading_day / 10_000);
    let month = trading_day / 100 % 100;
    let day = trading_day % 100;
    if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
        return None;
    }
    Some((year, month, day))
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days since 1970-01-01 (Howard Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = i64::from(month);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// 0 is Sunday. 1970-01-01 was a Thursday.
fn weekday(date: i64) -> i64 {
    (date + 4).rem_euclid(7)
}

/// The `nth` (1-based) Sunday of the month, as days since the epoch.
fn nth_sunday(year: i64, month: u32, nth: i64) -> i64 {
    let first = days_from_civil(year, month, 1);
    first + (7 - weekday(first)) % 7 + 7 * (nth - 1)
}

fn is_daylight_saving(year: i64, date: i64) -> bool {
    nth_sunday(year, 3, 2) <= date && date < nth_sunday(year, 11, 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn regular(day: u32, day0_utc: i64, offset_hours: i64, close_hour: i64) -> bool {
        let et = |secs: i64| day0_utc + secs + offset_hours * HOUR;
        is_regular_schedule(
            day,
            et(9 * HOUR),
            et(9 * HOUR + 1800),
            et(close_hour * HOUR),
        )
    }

    #[test]
    fn epoch_and_weekdays() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2026, 10, 13) * DAY, 1_791_849_600);
        // 2026-10-13 is a Tuesday.
        assert_eq!(weekday(days_from_civil(2026, 10, 13)), 2);
    }

    #[test]
    fn daylight_saving_boundaries() {
        // 2026: March 8 to November 1.
        assert_eq!(nth_sunday(2026, 3, 2), days_from_civil(2026, 3, 8));
        assert_eq!(nth_sunday(2026, 11, 1), days_from_civil(2026, 11, 1));
        assert!(!is_daylight_saving(2026, days_from_civil(2026, 3, 7)));
        assert!(is_daylight_saving(2026, days_from_civil(2026, 3, 8)));
        assert!(is_daylight_saving(2026, days_from_civil(2026, 10, 31)));
        assert!(!is_daylight_saving(2026, days_from_civil(2026, 11, 1)));
        // 2027 starts on March 14.
        assert_eq!(nth_sunday(2027, 3, 2), days_from_civil(2027, 3, 14));
    }

    #[test]
    fn accepts_regular_days_and_early_closes() {
        assert!(regular(20261013, 1_791_849_600, 4, 16));
        assert!(regular(20261013, 1_791_849_600, 4, 13));
        assert!(regular(20261127, 1_795_737_600, 5, 13));
    }

    #[test]
    fn rejects_wrong_offsets_and_bad_dates() {
        assert!(!regular(20261013, 1_791_849_600, 5, 16));
        assert!(!regular(20261013, 1_791_849_600, 4, 15));
        for bad in [0, 20261301, 20260230, 20261000, 20261032] {
            assert!(!is_regular_schedule(bad, 0, 1800, 25_200), "{bad}");
        }
        // 2028-02-29 exists; 2100-02-29 does not.
        assert!(parse_day(20280229).is_some());
        assert!(parse_day(21000229).is_none());
    }
}
