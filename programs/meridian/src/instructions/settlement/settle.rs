use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::*;

/// Permissionless. `slot` is the oracle slot index (0 or 1) in `Config.oracle_slots`.
#[derive(Accounts)]
pub struct SettleMarket<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub ticker_day: Account<'info, TickerDay>,
    #[account(mut)]
    pub market: Box<Account<'info, Market>>,
    /// CHECK: for a relay slot, the `meridian_oracle` `CloseRecord` at
    /// `["close", slot relay signer, ticker, trading_day (u32 LE)]`. Validated in the handler,
    /// because it is legitimately uninitialized when the ticker-day is final from an admin price.
    pub close_record: UncheckedAccount<'info>,
}

pub fn handle_settle_market(_ctx: Context<SettleMarket>, _slot: u8) -> Result<()> {
    err!(MeridianError::NotImplemented)
}
