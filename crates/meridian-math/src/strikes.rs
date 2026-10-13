/// Strikes for one ticker and day, in whole dollars: `round_to_10(prev × (1 ± p))` for
/// p ∈ {3%, 6%, 9%} plus `round_to_10(prev)`, deduplicated and sorted ascending. Halves round up.
/// `prev_price × 10^prev_expo` is the previous close. Integer math only.
pub fn compute_strikes(prev_price: i64, prev_expo: i32) -> Vec<u64> {
    let _ = (prev_price, prev_expo);
    todo!("compute_strikes")
}
