//! Property tests: R2 (Yes + No payout is always $1.00), the interpolated comparison against an
//! exact rational reference (R33), and R31's outcome monotonicity in strike.

mod common;

use common::ticker;
use meridian_math::{
    closing_price, payout_per_token, settle_outcome, NormalizedPrice, Outcome, Session,
    SettlementParams, Side, Strike, MAX_EXPO, MIN_EXPO, PAYOUT_UNIT,
};
use num_bigint::BigInt;
use num_rational::BigRational;
use proptest::prelude::*;

const CLOSE_TS: i64 = 1_793_390_400;

fn params() -> SettlementParams {
    SettlementParams {
        ticker: ticker("AAPL"),
        close_ts: CLOSE_TS,
        settle_ts: CLOSE_TS + 60,
        max_staleness_secs: 300,
        max_conf_bps: 50,
    }
}

fn update(price: i64, expo: i32, offset: i64, official_close: bool) -> NormalizedPrice {
    NormalizedPrice {
        ticker: ticker("AAPL"),
        price,
        conf: 0,
        expo,
        publish_time: CLOSE_TS + offset,
        session: Session::Regular,
        official_close,
    }
}

/// Valid settlement inputs of every shape: an official close, an exact-timestamp update or an
/// interpolation pair.
fn any_inputs() -> impl Strategy<Value = Vec<NormalizedPrice>> {
    let price = 1..=i64::MAX;
    let expo = MIN_EXPO..=MAX_EXPO;
    prop_oneof![
        (price.clone(), expo.clone(), 0i64..=300)
            .prop_map(|(p, e, offset)| vec![update(p, e, offset, true)]),
        (price.clone(), expo.clone()).prop_map(|(p, e)| vec![update(p, e, 0, false)]),
        (price.clone(), price, expo, 1i64..=300, 1i64..=300).prop_map(|(p1, p2, e, d1, d2)| {
            vec![update(p1, e, -d1, false), update(p2, e, d2, false)]
        }),
    ]
}

fn rational(numerator: BigInt, denominator: BigInt) -> BigRational {
    BigRational::new(numerator, denominator)
}

/// Linear interpolation at close as an exact rational, computed independently of the crate.
fn reference_value(p1: i64, t1: i64, p2: i64, t2: i64) -> BigRational {
    let slope = rational(BigInt::from(p2) - BigInt::from(p1), BigInt::from(t2 - t1));
    BigRational::from_integer(BigInt::from(p1))
        + slope * BigRational::from_integer(BigInt::from(CLOSE_TS - t1))
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(10_000))]

    /// R2 / INV-3: for any valid closing price and strike, Yes payout + No payout = 1_000_000.
    #[test]
    fn yes_plus_no_pays_exactly_one_dollar(updates in any_inputs(), strike in 1..=i64::MAX) {
        let closing = closing_price(&updates, &params()).expect("valid inputs settle");
        let outcome = settle_outcome(&closing, &Strike { value: strike, expo: updates[0].expo })
            .expect("same scale");
        prop_assert_eq!(
            payout_per_token(outcome, Side::Yes) + payout_per_token(outcome, Side::No),
            PAYOUT_UNIT
        );
    }

    /// R33: the i128 cross-multiplied comparison matches an exact rational reference, including
    /// strikes right at the interpolated value.
    #[test]
    fn interpolated_comparison_matches_exact_rational(
        p1 in 1..=i64::MAX,
        p2 in 1..=i64::MAX,
        d1 in 1i64..=300,
        d2 in 1i64..=300,
        expo in MIN_EXPO..=MAX_EXPO,
        near in any::<bool>(),
        delta in -2i64..=2,
        far_strike in 1..=i64::MAX,
    ) {
        let (t1, t2) = (CLOSE_TS - d1, CLOSE_TS + d2);
        let updates = [update(p1, expo, -d1, false), update(p2, expo, d2, false)];
        let reference = reference_value(p1, t1, p2, t2);
        let floor: i64 = reference.floor().to_integer().try_into().expect("between p1 and p2");
        let strike = if near { floor.saturating_add(delta).max(1) } else { far_strike };

        let closing = closing_price(&updates, &params()).expect("valid pair settles");
        prop_assert_eq!(
            rational(BigInt::from(closing.numerator), BigInt::from(closing.denominator)),
            reference.clone()
        );

        let expected = if reference >= BigRational::from_integer(BigInt::from(strike)) {
            Outcome::Yes
        } else {
            Outcome::No
        };
        prop_assert_eq!(settle_outcome(&closing, &Strike { value: strike, expo }), Ok(expected));
    }

    /// R31: with one closing price per ticker and day, Yes wins for every strike at or below
    /// the price and loses for every strike above it.
    #[test]
    fn outcome_is_monotone_in_strike(
        updates in any_inputs(),
        a in 1..=i64::MAX,
        b in 1..=i64::MAX,
    ) {
        let (low, high) = (a.min(b), a.max(b));
        let expo = updates[0].expo;
        let closing = closing_price(&updates, &params()).expect("valid inputs settle");
        let low_outcome = settle_outcome(&closing, &Strike { value: low, expo }).unwrap();
        let high_outcome = settle_outcome(&closing, &Strike { value: high, expo }).unwrap();
        if high_outcome == Outcome::Yes {
            prop_assert_eq!(low_outcome, Outcome::Yes);
        }
        if low_outcome == Outcome::No {
            prop_assert_eq!(high_outcome, Outcome::No);
        }
    }

    /// R31 for single-price shapes: Yes exactly when strike ≤ price.
    #[test]
    fn single_price_yes_iff_strike_at_or_below(
        price in 1..=i64::MAX,
        expo in MIN_EXPO..=MAX_EXPO,
        official_close in any::<bool>(),
        strike in 1..=i64::MAX,
    ) {
        let updates = [update(price, expo, 0, official_close)];
        let closing = closing_price(&updates, &params()).expect("valid price settles");
        let expected = if strike <= price { Outcome::Yes } else { Outcome::No };
        prop_assert_eq!(settle_outcome(&closing, &Strike { value: strike, expo }), Ok(expected));
    }
}
