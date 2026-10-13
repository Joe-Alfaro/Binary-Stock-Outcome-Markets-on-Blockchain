use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::*;

/// `settle_market` for oracle kinds whose inputs are signed reports passed as instruction data
/// (`ChainlinkDataStreams`). Each report is verified by CPI to the slot's verifier program, which
/// returns the decoded report as return data. The verifier's own accounts follow, in the order
/// its `verify` instruction takes them (`caller` signs as its `user`).
#[derive(Accounts)]
pub struct SettleMarketWithReports<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, address = market.ticker_day)]
    pub ticker_day: Account<'info, TickerDay>,
    #[account(mut)]
    pub market: Box<Account<'info, Market>>,
    /// CHECK: must be the slot's `verifier_program`.
    pub verifier_program: UncheckedAccount<'info>,
    /// CHECK: the verifier's state account, checked by the verifier.
    pub verifier_account: UncheckedAccount<'info>,
    /// CHECK: the verifier's access controller, checked by the verifier.
    pub access_controller: UncheckedAccount<'info>,
    /// CHECK: the verifier's report config account, checked by the verifier.
    pub report_config: UncheckedAccount<'info>,
}

pub fn handle_settle_market_with_reports(
    _ctx: Context<SettleMarketWithReports>,
    _slot: u8,
    _reports: Vec<Vec<u8>>,
) -> Result<()> {
    err!(MeridianError::NotImplemented)
}
