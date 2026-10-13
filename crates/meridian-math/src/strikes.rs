use alloc::vec::Vec;

use crate::price::{MAX_EXPO, MIN_EXPO};

/// Percentage offsets from the previous close: ±9%, ±6%, ±3% and 0.
const OFFSETS_PCT: [i128; 7] = [-9, -6, -3, 0, 3, 6, 9];

/// Strikes for one ticker and day, in whole dollars: `round_to_10(prev × (1 ± p))` for
/// p ∈ {3%, 6%, 9%} plus `round_to_10(prev)`, deduplicated and sorted ascending. Halves round up.
/// `prev_price × 10^prev_expo` is the previous close. Integer math only.
///
/// Returns no strikes for a non-positive price or an exponent outside `MIN_EXPO..=MAX_EXPO`, and
/// drops any strike that rounds to $0.
pub fn compute_strikes(prev_price: i64, prev_expo: i32) -> Vec<u64> {
    if prev_price <= 0 || !(MIN_EXPO..=MAX_EXPO).contains(&prev_expo) {
        return Vec::new();
    }
    // prev × (100 + pct) / 100 is in units of 10^prev_expo dollars; dividing by
    // 10 × 100 × 10^−prev_expo gives tens of dollars.
    let divisor = 1_000 * 10i128.pow(prev_expo.unsigned_abs());
    let mut strikes: Vec<u64> = OFFSETS_PCT
        .iter()
        .map(|pct| {
            let scaled = i128::from(prev_price) * (100 + pct);
            ((2 * scaled + divisor) / (2 * divisor) * 10) as u64
        })
        .filter(|&strike| strike > 0)
        .collect();
    strikes.sort_unstable();
    strikes.dedup();
    strikes
}
