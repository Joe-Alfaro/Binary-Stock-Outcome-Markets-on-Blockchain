use anchor_lang::prelude::*;
use meridian_math::{
    closing_price, settle_outcome, ClosingPrice, ClosingPriceError, NormalizedPrice,
    SettlementParams, Strike, MAX_EXPO, MIN_EXPO,
};
use meridian_oracle::{CloseRecord, PriceInput};

use super::{final_price, rescale};
use crate::errors::MeridianError;
use crate::events::{AdminPriceMismatch, MarketSettled};
use crate::state::*;

/// Permissionless. `slot` is the oracle slot index (0 or 1) in `Config.oracle_slots`.
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
    /// `["close", slot relay signer, ticker, trading_day (u32 LE)]`. Validated in the handler,
    /// because it is legitimately uninitialized when the ticker-day is final from an admin price.
    pub close_record: UncheckedAccount<'info>,
}

/// Settles one strike. The first strike of a ticker-day computes the closing price from the
/// slot's close record and makes the ticker-day `Final`; every later strike reuses that exact
/// price and ignores the record, so one price settles every strike. Allowed while paused.
pub fn handle_settle_market(ctx: Context<SettleMarket>, slot: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let market = &ctx.accounts.market;
    require!(
        market.status == MarketStatus::Open,
        MeridianError::MarketSettled
    );
    require!(now >= market.close_ts, MeridianError::SettleTooEarly);

    if ctx.accounts.ticker_day.status == TickerDayStatus::Open {
        let (price, source) = oracle_close(&ctx, slot, now)?;
        finalize_from_oracle(&mut ctx.accounts.ticker_day, &price, source)?;
    }

    let day = &ctx.accounts.ticker_day;
    let strike = Strike {
        value: market.strike,
        expo: market.strike_expo,
    };
    let exact = rescale(&final_price(day), strike.expo)?;
    let outcome = match settle_outcome(&exact, &strike).map_err(math_error)? {
        meridian_math::Outcome::Yes => Outcome::Yes,
        meridian_math::Outcome::No => Outcome::No,
    };

    let (settle_price, settle_expo, settle_source) =
        (day.settle_price, day.settle_expo, day.settle_source);
    let market = &mut ctx.accounts.market;
    market.status = MarketStatus::Settled;
    market.outcome = Some(outcome);
    market.settle_price = settle_price;
    market.settle_source = settle_source;
    emit!(MarketSettled {
        market: market.key(),
        ticker: market.ticker,
        trading_day: market.trading_day,
        strike: market.strike,
        outcome,
        settle_price,
        settle_expo,
        settle_source,
    });
    Ok(())
}

/// Validates the slot and its close record, then applies the closing-price rule to the record's
/// updates. Staleness is measured from the market's `close_ts`, never from `now`.
fn oracle_close(
    ctx: &Context<SettleMarket>,
    slot: u8,
    now: i64,
) -> Result<(ClosingPrice, SettleSource)> {
    let config = &ctx.accounts.config;
    let market = &ctx.accounts.market;
    let (oracle_slot, source) = match slot {
        0 => (&config.oracle_slots[0], SettleSource::OracleSlot0),
        1 => (&config.oracle_slots[1], SettleSource::OracleSlot1),
        _ => return err!(MeridianError::InvalidOracleAccount),
    };
    match oracle_slot.kind {
        OracleKind::MeridianRelay => {}
        OracleKind::Disabled => return err!(MeridianError::OracleSlotDisabled),
        // Pyth and Data Streams adapters aren't built yet; no record of theirs is accepted.
        OracleKind::Pyth | OracleKind::ChainlinkDataStreams => {
            return err!(MeridianError::InvalidOracleAccount)
        }
    }

    let record = load_close_record(
        &ctx.accounts.close_record,
        &oracle_slot.relay_signer,
        market,
    )?;
    require!(
        record.close_ts == market.close_ts,
        MeridianError::CloseTsMismatch
    );

    let normalize = |input: &PriceInput| -> Result<NormalizedPrice> {
        require!(
            (MIN_EXPO..=MAX_EXPO).contains(&input.expo),
            MeridianError::NoValidClosePrice
        );
        Ok(NormalizedPrice {
            ticker: record.ticker,
            price: input.price,
            conf: input.conf,
            expo: input.expo,
            publish_time: input.publish_time,
            session: match input.session {
                meridian_oracle::Session::Regular => meridian_math::Session::Regular,
                meridian_oracle::Session::OutsideRegular => meridian_math::Session::OutsideRegular,
            },
            official_close: input.official_close,
        })
    };
    let mut updates = vec![normalize(&record.first)?];
    if let Some(second) = &record.second {
        updates.push(normalize(second)?);
    }
    let params = SettlementParams {
        ticker: market.ticker,
        close_ts: market.close_ts,
        settle_ts: now,
        max_staleness_secs: config.max_staleness_secs,
        max_conf_bps: u32::from(config.max_conf_bps),
    };
    let price = closing_price(&updates, &params).map_err(math_error)?;
    Ok((price, source))
}

/// The canonical `CloseRecord` for `signer` and the market's ticker and day, or
/// `InvalidOracleAccount` for any other account: wrong owner, wrong type, wrong address or not
/// yet published.
fn load_close_record(
    account: &AccountInfo,
    signer: &Pubkey,
    market: &Market,
) -> Result<CloseRecord> {
    require_keys_eq!(
        *account.owner,
        meridian_oracle::ID,
        MeridianError::InvalidOracleAccount
    );
    let data = account.try_borrow_data()?;
    let record = CloseRecord::try_deserialize(&mut &data[..])
        .map_err(|_| error!(MeridianError::InvalidOracleAccount))?;
    let trading_day = market.trading_day.to_le_bytes();
    // The canonical address, not one rebuilt from the record's own `bump` field.
    let (expected, _) = Pubkey::find_program_address(
        &[
            meridian_oracle::CLOSE_SEED,
            signer.as_ref(),
            &market.ticker,
            &trading_day,
        ],
        &meridian_oracle::ID,
    );
    require!(
        expected == account.key()
            && record.signer == *signer
            && record.ticker == market.ticker
            && record.trading_day == market.trading_day,
        MeridianError::InvalidOracleAccount
    );
    Ok(record)
}

/// Writes the oracle closing price to the ticker-day and marks it `Final`. A pending admin price
/// that differs from it is dropped in favor of the oracle, with an `AdminPriceMismatch` event.
fn finalize_from_oracle(
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
        // The record's PDA already pins the ticker, so a mismatch is a malformed record.
        ClosingPriceError::WrongTicker
        | ClosingPriceError::ExpoMismatch
        | ClosingPriceError::NoValidShape => error!(MeridianError::NoValidClosePrice),
    }
}
