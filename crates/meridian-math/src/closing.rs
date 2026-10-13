use crate::price::{NormalizedPrice, Session, Ticker};

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
/// exponent across updates. Any invalid update fails the whole call. Then the shapes are tried in
/// order: official close, exact timestamp, interpolation.
///
/// When several updates qualify for a shape, the one nearest `close_ts` wins, and ties go to the
/// one passed first.
pub fn closing_price(
    updates: &[NormalizedPrice],
    params: &SettlementParams,
) -> Result<ClosingPrice, ClosingPriceError> {
    updates.iter().try_for_each(|u| validate(u, params))?;
    let expo = updates.first().ok_or(ClosingPriceError::NoValidShape)?.expo;
    if updates.iter().any(|u| u.expo != expo) {
        return Err(ClosingPriceError::ExpoMismatch);
    }

    let close_ts = params.close_ts;
    let nearest = |filter: &dyn Fn(&NormalizedPrice) -> bool| {
        updates
            .iter()
            .filter(|u| filter(u))
            .min_by_key(|u| u.publish_time.abs_diff(close_ts))
    };

    if let Some(u) = nearest(&|u| u.official_close) {
        return Ok(single(ClosingShape::OfficialClose, u));
    }
    if let Some(u) = nearest(&|u| u.publish_time == close_ts) {
        return Ok(single(ClosingShape::ExactTimestamp, u));
    }
    match (
        nearest(&|u| u.publish_time < close_ts),
        nearest(&|u| u.publish_time > close_ts),
    ) {
        (Some(before), Some(after)) => Ok(interpolate(before, after, close_ts)),
        _ => Err(ClosingPriceError::NoValidShape),
    }
}

fn validate(update: &NormalizedPrice, params: &SettlementParams) -> Result<(), ClosingPriceError> {
    if update.ticker != params.ticker {
        return Err(ClosingPriceError::WrongTicker);
    }
    if update.price <= 0 {
        return Err(ClosingPriceError::NonPositivePrice);
    }
    if update.session != Session::Regular {
        return Err(ClosingPriceError::OutsideRegularSession);
    }
    // conf / price > max_conf_bps / 10_000, cross-multiplied. Price is positive here.
    if u128::from(update.conf) * 10_000 > update.price as u128 * u128::from(params.max_conf_bps) {
        return Err(ClosingPriceError::ConfidenceTooWide);
    }
    if update.publish_time.abs_diff(params.close_ts) > u64::from(params.max_staleness_secs) {
        return Err(ClosingPriceError::Stale);
    }
    Ok(())
}

fn single(shape: ClosingShape, update: &NormalizedPrice) -> ClosingPrice {
    ClosingPrice {
        shape,
        expo: update.expo,
        numerator: i128::from(update.price),
        denominator: 1,
        settle_price: update.price,
    }
}

/// `p1 + (p2 − p1) × d1 / (d1 + d2)` = `(p1 × d2 + p2 × d1) / (d1 + d2)`, where `d1` and `d2` are
/// the distances from close. Staleness bounds both by a `u32`, so this fits in `i128`.
fn interpolate(before: &NormalizedPrice, after: &NormalizedPrice, close_ts: i64) -> ClosingPrice {
    let d1 = i128::from(close_ts.abs_diff(before.publish_time));
    let d2 = i128::from(after.publish_time.abs_diff(close_ts));
    let numerator = i128::from(before.price) * d2 + i128::from(after.price) * d1;
    let denominator = d1 + d2;
    // Halves round up. The value lies between the two prices, so the rounded value fits in i64.
    let rounded = (2 * numerator + denominator) / (2 * denominator);
    ClosingPrice {
        shape: ClosingShape::Interpolated,
        expo: before.expo,
        numerator,
        denominator,
        settle_price: rounded as i64,
    }
}
