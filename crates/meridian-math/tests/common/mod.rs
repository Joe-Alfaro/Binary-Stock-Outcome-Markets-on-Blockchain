//! Loads the shared JSON fixtures in `fixtures/`, which the TypeScript twin also runs.

#![allow(dead_code)]

use meridian_math::{NormalizedPrice, Session, SettlementParams, Ticker};
use serde_json::Value;

pub const CLOSING_PRICE_FIXTURE: &str = include_str!("../../../../fixtures/closing-price.json");
pub const STRIKES_FIXTURE: &str = include_str!("../../../../fixtures/strikes.json");

pub fn ticker(symbol: &str) -> Ticker {
    let mut out = [0u8; 8];
    out[..symbol.len()].copy_from_slice(symbol.as_bytes());
    out
}

pub fn parse(json: &str) -> Value {
    serde_json::from_str(json).expect("fixture is valid JSON")
}

pub fn int(value: &Value, field: &str) -> i64 {
    value[field]
        .as_i64()
        .unwrap_or_else(|| panic!("{field} is an integer"))
}

pub fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value[field]
        .as_str()
        .unwrap_or_else(|| panic!("{field} is a string"))
}

/// A field from the case, falling back to the fixture defaults.
pub fn with_default<'a>(case: &'a Value, defaults: &'a Value, field: &str) -> &'a Value {
    if case[field].is_null() {
        &defaults[field]
    } else {
        &case[field]
    }
}

pub struct ClosingCase {
    pub name: String,
    pub params: SettlementParams,
    pub updates: Vec<NormalizedPrice>,
    pub expo: i32,
    pub expect: Value,
}

pub fn closing_cases() -> Vec<ClosingCase> {
    let fixture = parse(CLOSING_PRICE_FIXTURE);
    let defaults = &fixture["defaults"];
    let default_expo = int(defaults, "expo") as i32;
    let default_ticker = str_field(defaults, "ticker");
    fixture["cases"]
        .as_array()
        .expect("cases is an array")
        .iter()
        .map(|case| {
            let close_ts = with_default(case, defaults, "closeTs").as_i64().unwrap();
            let settle_offset = with_default(case, defaults, "settleOffset")
                .as_i64()
                .unwrap();
            let params = SettlementParams {
                ticker: ticker(default_ticker),
                close_ts,
                settle_ts: close_ts + settle_offset,
                max_staleness_secs: with_default(case, defaults, "maxStalenessSecs")
                    .as_u64()
                    .unwrap() as u32,
                max_conf_bps: with_default(case, defaults, "maxConfBps").as_u64().unwrap() as u32,
            };
            let updates = case["updates"]
                .as_array()
                .expect("updates is an array")
                .iter()
                .map(|u| NormalizedPrice {
                    ticker: ticker(u["ticker"].as_str().unwrap_or(default_ticker)),
                    price: int(u, "price"),
                    conf: u["conf"].as_u64().unwrap_or(0),
                    expo: u["expo"].as_i64().map_or(default_expo, |e| e as i32),
                    publish_time: close_ts + int(u, "offset"),
                    session: match u["session"].as_str().unwrap_or("Regular") {
                        "Regular" => Session::Regular,
                        "OutsideRegular" => Session::OutsideRegular,
                        other => panic!("unknown session {other}"),
                    },
                    official_close: u["officialClose"].as_bool().unwrap_or(false),
                })
                .collect();
            ClosingCase {
                name: str_field(case, "name").to_owned(),
                params,
                updates,
                expo: default_expo,
                expect: case["expect"].clone(),
            }
        })
        .collect()
}
