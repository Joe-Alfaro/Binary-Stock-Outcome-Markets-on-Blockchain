//! R1, R33 and R34 against the shared fixture `fixtures/closing-price.json`.

mod common;

use common::{closing_cases, str_field, ClosingCase};
use meridian_math::{
    closing_price, payout_per_token, settle_outcome, ClosingPrice, ClosingPriceError, ClosingShape,
    Outcome, Side, Strike, PAYOUT_UNIT,
};

fn shape_named(name: &str) -> ClosingShape {
    match name {
        "OfficialClose" => ClosingShape::OfficialClose,
        "ExactTimestamp" => ClosingShape::ExactTimestamp,
        "Interpolated" => ClosingShape::Interpolated,
        other => panic!("unknown shape {other}"),
    }
}

fn error_named(name: &str) -> ClosingPriceError {
    match name {
        "WrongTicker" => ClosingPriceError::WrongTicker,
        "NonPositivePrice" => ClosingPriceError::NonPositivePrice,
        "OutsideRegularSession" => ClosingPriceError::OutsideRegularSession,
        "ConfidenceTooWide" => ClosingPriceError::ConfidenceTooWide,
        "Stale" => ClosingPriceError::Stale,
        "ExpoMismatch" => ClosingPriceError::ExpoMismatch,
        "NoValidShape" => ClosingPriceError::NoValidShape,
        other => panic!("unknown error {other}"),
    }
}

fn outcome_named(name: &str) -> Outcome {
    match name {
        "Yes" => Outcome::Yes,
        "No" => Outcome::No,
        other => panic!("unknown outcome {other}"),
    }
}

fn check_case(case: &ClosingCase) {
    let name = &case.name;
    let result = closing_price(&case.updates, &case.params);

    if let Some(error) = case.expect["error"].as_str() {
        assert_eq!(result, Err(error_named(error)), "{name}");
        return;
    }

    let closing = result.unwrap_or_else(|e| panic!("{name}: expected a price, got {e:?}"));
    assert_eq!(
        closing.shape,
        shape_named(str_field(&case.expect, "shape")),
        "{name}"
    );
    assert_eq!(closing.expo, case.expo, "{name}: expo");
    assert!(
        closing.denominator > 0,
        "{name}: denominator must be positive"
    );
    if let Some(settle_price) = case.expect["settlePrice"].as_i64() {
        assert_eq!(closing.settle_price, settle_price, "{name}: settle_price");
        assert_eq!(
            closing.numerator,
            i128::from(settle_price) * closing.denominator,
            "{name}: exact value"
        );
    }

    for strike_case in case.expect["strikes"].as_array().expect("strikes") {
        let strike = Strike {
            value: strike_case["strike"].as_i64().unwrap(),
            expo: case.expo,
        };
        let expected = outcome_named(str_field(strike_case, "outcome"));
        let outcome = settle_outcome(&closing, &strike);
        assert_eq!(outcome, Ok(expected), "{name}: strike {}", strike.value);

        let (yes, no) = match expected {
            Outcome::Yes => (PAYOUT_UNIT, 0),
            Outcome::No => (0, PAYOUT_UNIT),
        };
        assert_eq!(
            payout_per_token(expected, Side::Yes),
            yes,
            "{name}: Yes payout"
        );
        assert_eq!(
            payout_per_token(expected, Side::No),
            no,
            "{name}: No payout"
        );
    }
}

#[test]
fn every_fixture_case_matches() {
    let cases = closing_cases();
    assert!(cases.len() >= 30, "fixture has all cases");
    let failures: Vec<&str> = cases
        .iter()
        .filter(|case| std::panic::catch_unwind(|| check_case(case)).is_err())
        .map(|case| case.name.as_str())
        .collect();
    assert!(failures.is_empty(), "failing cases: {failures:#?}");
}

/// R34: staleness is measured against close_ts, so when the settle transaction lands never
/// changes the result.
#[test]
fn result_does_not_depend_on_when_settle_lands() {
    for case in closing_cases() {
        let baseline = closing_price(&case.updates, &case.params);
        [1, 720, 3_600, 86_400 * 365].iter().for_each(|offset| {
            let mut params = case.params;
            params.settle_ts = params.close_ts + offset;
            assert_eq!(
                closing_price(&case.updates, &params),
                baseline,
                "{}: settle at close + {offset}",
                case.name
            );
        });
    }
}

/// R1: every shape covers a strike exactly at the price, one below it and one above it.
#[test]
fn fixture_covers_at_above_and_below_for_every_shape() {
    let cases = closing_cases();
    for shape in ["OfficialClose", "ExactTimestamp", "Interpolated"] {
        let case = cases
            .iter()
            .find(|c| {
                c.expect["shape"].as_str() == Some(shape)
                    && c.expect["strikes"].as_array().is_some_and(|s| s.len() >= 3)
            })
            .unwrap_or_else(|| panic!("no at/above/below case for {shape}"));
        check_case(case);
    }
}

#[test]
fn yes_wins_pays_yes_holders_only() {
    assert_eq!(payout_per_token(Outcome::Yes, Side::Yes), 1_000_000);
    assert_eq!(payout_per_token(Outcome::Yes, Side::No), 0);
}

#[test]
fn no_wins_pays_no_holders_only() {
    assert_eq!(payout_per_token(Outcome::No, Side::Yes), 0);
    assert_eq!(payout_per_token(Outcome::No, Side::No), 1_000_000);
}

#[test]
fn strike_on_another_scale_is_rejected() {
    let closing = ClosingPrice {
        shape: ClosingShape::ExactTimestamp,
        expo: -2,
        numerator: 23_000,
        denominator: 1,
        settle_price: 23_000,
    };
    let strike = Strike {
        value: 2_300_000,
        expo: -4,
    };
    assert_eq!(
        settle_outcome(&closing, &strike),
        Err(ClosingPriceError::ExpoMismatch)
    );
}
