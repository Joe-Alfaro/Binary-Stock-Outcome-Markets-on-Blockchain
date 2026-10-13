use anchor_lang::prelude::*;

use super::ADMIN_PRICE_EXPO;
use crate::errors::MeridianError;
use crate::state::*;

/// Admin only. `price` is at `ADMIN_PRICE_EXPO` and applies to every strike of the ticker-day.
#[derive(Accounts)]
#[instruction(ticker: Ticker, trading_day: u32)]
pub struct ProposeAdminPrice<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [TICKER_DAY_SEED, ticker.as_ref(), &trading_day.to_le_bytes()],
        bump = ticker_day.bump,
    )]
    pub ticker_day: Account<'info, TickerDay>,
}

/// Anyone. Marks the ticker-day `Final` with the pending admin price.
#[derive(Accounts)]
#[instruction(ticker: Ticker, trading_day: u32)]
pub struct FinalizeAdminSettle<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [TICKER_DAY_SEED, ticker.as_ref(), &trading_day.to_le_bytes()],
        bump = ticker_day.bump,
    )]
    pub ticker_day: Account<'info, TickerDay>,
}

/// Records (or replaces) the pending admin price. Allowed from `close_ts +
/// admin_propose_delay_secs` until the ticker-day is final. A proposal alone settles nothing.
pub fn handle_propose_admin_price(
    ctx: Context<ProposeAdminPrice>,
    _ticker: Ticker,
    _trading_day: u32,
    price: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let config = &ctx.accounts.config;
    require_keys_eq!(
        ctx.accounts.admin.key(),
        config.admin,
        MeridianError::Unauthorized
    );
    let day = &mut ctx.accounts.ticker_day;
    require!(
        day.status == TickerDayStatus::Open,
        MeridianError::TickerDayFinal
    );
    require!(price > 0, MeridianError::NonPositivePrice);
    let opens_at = day
        .close_ts
        .checked_add(i64::from(config.admin_propose_delay_secs))
        .ok_or(MeridianError::MathOverflow)?;
    require!(now >= opens_at, MeridianError::AdminProposeTooEarly);

    day.pending_admin_price = price;
    day.pending_admin_at = now;
    Ok(())
}

/// Makes the pending admin price the ticker-day's final price, from `close_ts +
/// admin_finalize_delay_secs` on. Each strike then settles from it through `settle_market`.
pub fn handle_finalize_admin_settle(
    ctx: Context<FinalizeAdminSettle>,
    _ticker: Ticker,
    _trading_day: u32,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let config = &ctx.accounts.config;
    let day = &mut ctx.accounts.ticker_day;
    require!(
        day.status == TickerDayStatus::Open,
        MeridianError::TickerDayFinal
    );
    require!(
        day.pending_admin_at != 0,
        MeridianError::NoPendingAdminPrice
    );
    let opens_at = day
        .close_ts
        .checked_add(i64::from(config.admin_finalize_delay_secs))
        .ok_or(MeridianError::MathOverflow)?;
    require!(now >= opens_at, MeridianError::AdminFinalizeTooEarly);

    day.status = TickerDayStatus::Final;
    day.settle_price = day.pending_admin_price;
    day.settle_expo = ADMIN_PRICE_EXPO;
    day.settle_source = SettleSource::Admin;
    day.settle_numerator = i128::from(day.pending_admin_price);
    day.settle_denominator = 1;
    Ok(())
}
