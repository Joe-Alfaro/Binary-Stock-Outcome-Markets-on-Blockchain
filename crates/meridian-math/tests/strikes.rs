//! R11 against the shared fixture `fixtures/strikes.json`.

mod common;

use common::{int, parse, str_field, STRIKES_FIXTURE};
use meridian_math::compute_strikes;

#[test]
fn every_fixture_ladder_matches() {
    let fixture = parse(STRIKES_FIXTURE);
    let cases = fixture["cases"].as_array().expect("cases is an array");
    assert!(cases.len() >= 10, "fixture has all cases");
    for case in cases {
        let prev = &case["prevClose"];
        let expected: Vec<u64> = case["strikes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_u64().unwrap())
            .collect();
        assert_eq!(
            compute_strikes(int(prev, "price"), int(prev, "expo") as i32),
            expected,
            "{}",
            str_field(case, "name")
        );
    }
}

#[test]
fn required_ladders() {
    assert_eq!(
        compute_strikes(68_000, -2),
        vec![620, 640, 660, 680, 700, 720, 740]
    );
    assert_eq!(compute_strikes(23_000, -2), vec![210, 220, 230, 240, 250]);
    assert_eq!(compute_strikes(22_648, -2), vec![210, 220, 230, 240, 250]);
}

#[test]
fn halves_round_up() {
    assert!(compute_strikes(68_500, -2).contains(&690));
}
