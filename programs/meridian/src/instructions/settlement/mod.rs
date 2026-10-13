//! Settlement: `settle_market`, the delayed admin fallback and `redeem`.
//!
//! One price settles every strike of a ticker and trading day. The first settlement writes it to
//! the `TickerDay` and marks it `Final`; every later strike reuses it.

pub mod admin;
pub mod redeem;
pub mod settle;

pub use admin::*;
pub use redeem::*;
pub use settle::*;

/// Exponent of an admin-entered price: whole cents, the same scale as the strikes.
pub const ADMIN_PRICE_EXPO: i32 = -2;

use anchor_lang::prelude::*;
use meridian_math::{ClosingPrice, ClosingShape};

use crate::errors::MeridianError;
use crate::state::TickerDay;

/// The ticker-day's exact final price, rebuilt from the stored rational.
fn final_price(day: &TickerDay) -> ClosingPrice {
    ClosingPrice {
        // Only the value matters from here on; the shape is not stored.
        shape: ClosingShape::OfficialClose,
        expo: day.settle_expo,
        numerator: day.settle_numerator,
        denominator: day.settle_denominator,
        settle_price: day.settle_price,
    }
}

/// The same exact value as `price`, expressed at `expo`. Exact both ways: a smaller exponent
/// scales the numerator up, a larger one scales the denominator up.
fn rescale(price: &ClosingPrice, expo: i32) -> Result<ClosingPrice> {
    let factor = |diff: i32| {
        10i128
            .checked_pow(diff.unsigned_abs())
            .ok_or(MeridianError::MathOverflow)
    };
    let (numerator, denominator) = if price.expo >= expo {
        let f = factor(price.expo - expo)?;
        (price.numerator.checked_mul(f), Some(price.denominator))
    } else {
        let f = factor(expo - price.expo)?;
        (Some(price.numerator), price.denominator.checked_mul(f))
    };
    Ok(ClosingPrice {
        expo,
        numerator: numerator.ok_or(MeridianError::MathOverflow)?,
        denominator: denominator.ok_or(MeridianError::MathOverflow)?,
        ..*price
    })
}
