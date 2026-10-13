use anchor_lang::prelude::*;
use meridian_math::{
    closing_price, settle_outcome, ClosingPrice, ClosingPriceError, NormalizedPrice,
    SettlementParams, Strike,
};

use super::{final_price, rescale};
use crate::errors::MeridianError;
use crate::events::{AdminPriceMismatch, MarketSettled};
use crate::price_adapter;
use crate::state::*;

/// Permissionless, except the first settle from a third-party slot (§4.3). `slot` is the oracle slot index (0 or 1) in `Config.oracle_slots`.
#[derive(Accounts)]
pub struct SettleMarket<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, address = market.ticker_day)]
    pub ticker_day: Account<'info, TickerDay>,
    #[account(mut)]
    pub market: Box<Account<'info, Market>>,
    /// CHECK: for a relay slot, the `meridian_oracle` `CloseRecord` at
    /// `["close", slot relay signer, ticker, trading_day (u32 LE)]`; for a Pyth slot, the first
    /// receiver price update. Validated in the handler, because it is legitimately uninitialized
    /// when the ticker-day is final from an admin price.
    pub close_record: UncheckedAccount<'info>,
}

/// Settles one strike. The first strike of a ticker-day computes the closing price from the
/// slot's inputs and makes the ticker-day `Final`; every later strike reuses that exact price and
/// ignores the inputs, so one price settles every strike. Allowed while paused.
///
/// A relay slot reads its `CloseRecord` from `close_record`. A Pyth slot reads `close_record`
/// and any remaining accounts as receiver price updates. Data Streams reports are instruction
/// data, so they settle through `settle_market_with_reports` instead.
pub fn handle_settle_market(ctx: Context<SettleMarket>, slot: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require_settleable(&ctx.accounts.market, now)?;

    if ctx.accounts.ticker_day.status == TickerDayStatus::Open {
        let accounts = &ctx.accounts;
        let (oracle_slot, source) = oracle_slot(&accounts.config, slot)?;
        let updates = match oracle_slot.kind {
            OracleKind::MeridianRelay => price_adapter::relay::updates(
                &accounts.close_record,
                &oracle_slot.relay_signer,
                &accounts.market,
            )?,
            OracleKind::Pyth => {
                require_third_party_settler(&accounts.config, &accounts.caller)?;
                price_adapter::pyth::updates(
                    &accounts.close_record,
                    ctx.remaining_accounts,
                    oracle_slot,
                    &accounts.config,
                    &accounts.market,
                )?
            }
            OracleKind::Disabled => return err!(MeridianError::OracleSlotDisabled),
            OracleKind::ChainlinkDataStreams => return err!(MeridianError::InvalidOracleAccount),
        };
        let price = closing_price_of(&updates, &accounts.config, &accounts.market, now)?;
        finalize_from_oracle(&mut ctx.accounts.ticker_day, &price, source)?;
    }

    settle_strike(&ctx.accounts.ticker_day, &mut ctx.accounts.market)
}

/// The market is open and at or past its close.
pub(super) fn require_settleable(market: &Market, now: i64) -> Result<()> {
    require!(
        market.status == MarketStatus::Open,
        MeridianError::MarketSettled
    );
    require!(now >= market.close_ts, MeridianError::SettleTooEarly);
    Ok(())
}

/// Slot `slot` (0 or 1) and the settle source it records.
pub(super) fn oracle_slot(config: &Config, slot: u8) -> Result<(&OracleSlot, SettleSource)> {
    match slot {
        0 => Ok((&config.oracle_slots[0], SettleSource::OracleSlot0)),
        1 => Ok((&config.oracle_slots[1], SettleSource::OracleSlot1)),
        _ => err!(MeridianError::InvalidOracleAccount),
    }
}

/// Third-party inputs can be fetched for many timestamps and the program can't tell which pair is
/// canonical, so their first settle needs the automation authority or the admin (§4.3).
pub(super) fn require_third_party_settler(config: &Config, caller: &Signer) -> Result<()> {
    require!(
        caller.key() == config.automation_authority || caller.key() == config.admin,
        MeridianError::Unauthorized
    );
    Ok(())
}

/// Applies the closing-price rule to normalized updates from any oracle kind. Staleness is
/// measured from the market's `close_ts`, never from `now`.
pub(super) fn closing_price_of(
    updates: &[NormalizedPrice],
    config: &Config,
    market: &Market,
    now: i64,
) -> Result<ClosingPrice> {
    let params = SettlementParams {
        ticker: market.ticker,
        close_ts: market.close_ts,
        settle_ts: now,
        max_staleness_secs: config.max_staleness_secs,
        max_conf_bps: u32::from(config.max_conf_bps),
    };
    closing_price(updates, &params).map_err(math_error)
}

/// Writes the outcome of the ticker-day's final price against the market's strike.
pub(super) fn settle_strike(day: &TickerDay, market: &mut Account<Market>) -> Result<()> {
    let strike = Strike {
        value: market.strike,
        expo: market.strike_expo,
    };
    let exact = rescale(&final_price(day), strike.expo)?;
    let outcome = match settle_outcome(&exact, &strike).map_err(math_error)? {
        meridian_math::Outcome::Yes => Outcome::Yes,
        meridian_math::Outcome::No => Outcome::No,
    };

    market.status = MarketStatus::Settled;
    market.outcome = Some(outcome);
    market.settle_price = day.settle_price;
    market.settle_source = day.settle_source;
    emit!(MarketSettled {
        market: market.key(),
        ticker: market.ticker,
        trading_day: market.trading_day,
        strike: market.strike,
        outcome,
        settle_price: day.settle_price,
        settle_expo: day.settle_expo,
        settle_source: day.settle_source,
    });
    Ok(())
}

/// Writes the oracle closing price to the ticker-day and marks it `Final`. A pending admin price
/// that differs from it is dropped in favor of the oracle, with an `AdminPriceMismatch` event.
pub(super) fn finalize_from_oracle(
    day: &mut Account<TickerDay>,
    price: &ClosingPrice,
    source: SettleSource,
) -> Result<()> {
    if day.pending_admin_at != 0 {
        let exact = rescale(price, super::ADMIN_PRICE_EXPO)?;
        let admin = i128::from(day.pending_admin_price)
            .checked_mul(exact.denominator)
            .ok_or(MeridianError::MathOverflow)?;
        if admin != exact.numerator {
            emit!(AdminPriceMismatch {
                ticker_day: day.key(),
                ticker: day.ticker,
                trading_day: day.trading_day,
                oracle_price: price.settle_price,
                admin_price: day.pending_admin_price,
            });
        }
    }
    day.status = TickerDayStatus::Final;
    day.settle_price = price.settle_price;
    day.settle_expo = price.expo;
    day.settle_source = source;
    day.settle_numerator = price.numerator;
    day.settle_denominator = price.denominator;
    Ok(())
}

fn math_error(e: ClosingPriceError) -> Error {
    match e {
        ClosingPriceError::NonPositivePrice => error!(MeridianError::NonPositivePrice),
        ClosingPriceError::OutsideRegularSession => error!(MeridianError::OutsideRegularSession),
        ClosingPriceError::ConfidenceTooWide => error!(MeridianError::ConfidenceTooWide),
        ClosingPriceError::Stale => error!(MeridianError::StalePrice),
        // Every adapter stamps the market's own ticker, so a mismatch is a malformed input.
        ClosingPriceError::WrongTicker
        | ClosingPriceError::ExpoMismatch
        | ClosingPriceError::NoValidShape => error!(MeridianError::NoValidClosePrice),
    }
}
