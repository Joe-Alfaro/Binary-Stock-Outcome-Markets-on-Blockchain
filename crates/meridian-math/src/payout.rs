use crate::closing::{ClosingPrice, ClosingPriceError};

/// USDC base units paid per winning token ($1.00).
pub const PAYOUT_UNIT: u64 = 1_000_000;

/// A market strike, `value × 10^expo`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Strike {
    pub value: i64,
    pub expo: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Yes,
    No,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Yes,
    No,
}

/// Yes wins when the closing price is at or above the strike, compared exactly with `i128`
/// cross-multiplication and no division. Fails with `ExpoMismatch` when the scales differ.
pub fn settle_outcome(
    closing: &ClosingPrice,
    strike: &Strike,
) -> Result<Outcome, ClosingPriceError> {
    let _ = (closing, strike);
    todo!("settle_outcome")
}

/// USDC base units paid per token of `side` once the market settled with `outcome`.
pub fn payout_per_token(outcome: Outcome, side: Side) -> u64 {
    let _ = (outcome, side);
    todo!("payout_per_token")
}
