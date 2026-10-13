use anchor_lang::prelude::*;

use super::settle::{
    closing_price_of, finalize_from_oracle, oracle_slot, require_settleable,
    require_third_party_settler, settle_strike,
};
use crate::errors::MeridianError;
use crate::price_adapter::data_streams::{self, Verifier};
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

/// Same flow as `settle_market`: the first strike of a ticker-day settles from the verified
/// reports, every later strike copies the ticker-day's price. Only report kinds are read here.
pub fn handle_settle_market_with_reports(
    ctx: Context<SettleMarketWithReports>,
    slot: u8,
    reports: Vec<Vec<u8>>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require_settleable(&ctx.accounts.market, now)?;
    let (oracle_slot, source) = oracle_slot(&ctx.accounts.config, slot)?;
    require!(
        oracle_slot.kind == OracleKind::ChainlinkDataStreams,
        MeridianError::InvalidOracleAccount
    );

    if ctx.accounts.ticker_day.status == TickerDayStatus::Open {
        let accounts = &ctx.accounts;
        require_third_party_settler(&accounts.config, &accounts.caller)?;
        let verifier = Verifier {
            program: &accounts.verifier_program,
            verifier_account: &accounts.verifier_account,
            access_controller: &accounts.access_controller,
            user: &accounts.caller,
            report_config: &accounts.report_config,
        };
        let updates = data_streams::updates(
            &verifier,
            &reports,
            oracle_slot,
            &accounts.config,
            &accounts.market,
        )?;
        let price = closing_price_of(&updates, &accounts.config, &accounts.market, now)?;
        finalize_from_oracle(&mut ctx.accounts.ticker_day, &price, source)?;
    }

    settle_strike(&ctx.accounts.ticker_day, &mut ctx.accounts.market)
}
