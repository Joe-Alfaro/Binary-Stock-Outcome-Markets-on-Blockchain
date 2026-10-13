use crate::price::{NormalizedPrice, Ticker};

/// Market-level inputs to the closing-price rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SettlementParams {
    /// The market's ticker. Every update must match it.
    pub ticker: Ticker,
    /// The market close (4:00 PM ET, or 1:00 PM ET on early-close days). Staleness and the
    /// interpolation window are measured against this, never against `settle_ts`.
    pub close_ts: i64,
    /// When the settle transaction lands. It must not affect which prices are accepted.
    pub settle_ts: i64,
    /// An update is stale when `|publish_time − close_ts| > max_staleness_secs` (default 300).
    /// This is also the interpolation window.
    pub max_staleness_secs: u32,
    /// An update is rejected when `conf / price > max_conf_bps / 10_000`.
    pub max_conf_bps: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClosingShape {
    /// Shape 1: an update labeled as the official close.
    OfficialClose,
    /// Shape 2: a regular-session update with `publish_time == close_ts`.
    ExactTimestamp,
    /// Shape 3: linear interpolation between the nearest update in `[close_ts − window, close_ts)`
    /// and the nearest update in `(close_ts, close_ts + window]`.
    Interpolated,
}

/// The closing price as an exact rational, `numerator / denominator`, scaled by `10^expo`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClosingPrice {
    pub shape: ClosingShape,
    pub expo: i32,
    pub numerator: i128,
    /// Always positive. 1 for shapes 1 and 2.
    pub denominator: i128,
    /// The value rounded to `expo`, stored as the market's `settle_price` for display only.
    pub settle_price: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClosingPriceError {
    WrongTicker,
    NonPositivePrice,
    OutsideRegularSession,
    ConfidenceTooWide,
    Stale,
    ExpoMismatch,
    NoValidShape,
}

/// Applies the closing-price rule. Every update passed in is validated, in this order: ticker,
/// positive price, regular session, confidence, staleness against `close_ts`, then a shared
/// exponent across updates. Any invalid update fails the whole call. Then the shapes are tried in order: official close, exact
/// timestamp, interpolation.
pub fn closing_price(
    updates: &[NormalizedPrice],
    params: &SettlementParams,
) -> Result<ClosingPrice, ClosingPriceError> {
    let _ = (updates, params);
    todo!("closing_price")
}
