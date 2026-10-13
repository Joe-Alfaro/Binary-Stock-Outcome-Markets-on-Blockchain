use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod schedule;
pub mod state;

pub use instructions::*;
pub use state::{OrderKind, Side};

declare_id!("9o9a9HpN6Aq4UBeozWshAKBugjtToxWdsVzSMPkVHEMX");

#[program]
pub mod meridian {
    use super::*;

    /// Placeholder instruction so the scaffold builds, deploys and has a smoke test.
    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        msg!("meridian ping");
        Ok(())
    }

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        args: InitializeConfigArgs,
    ) -> Result<()> {
        instructions::config::handle_initialize_config(ctx, args)
    }

    pub fn update_config(ctx: Context<AdminConfig>, args: UpdateConfigArgs) -> Result<()> {
        instructions::config::handle_update_config(ctx, args)
    }

    pub fn pause(ctx: Context<AdminConfig>) -> Result<()> {
        instructions::config::handle_pause(ctx)
    }

    pub fn unpause(ctx: Context<AdminConfig>) -> Result<()> {
        instructions::config::handle_unpause(ctx)
    }

    /// Only in builds with the `devnet` feature, which is on by default; a mainnet build turns
    /// it off with `--no-default-features` (D21, D52).
    #[cfg(feature = "devnet")]
    pub fn set_demo_mode(ctx: Context<AdminConfig>, enabled: bool) -> Result<()> {
        instructions::config::handle_set_demo_mode(ctx, enabled)
    }

    pub fn create_strike_market(ctx: Context<CreateMarket>, args: CreateMarketArgs) -> Result<()> {
        instructions::market::handle_create_strike_market(ctx, args)
    }

    pub fn add_strike(ctx: Context<CreateMarket>, args: CreateMarketArgs) -> Result<()> {
        instructions::market::handle_add_strike(ctx, args)
    }

    pub fn mint_pair(ctx: Context<Collateral>, n: u64) -> Result<()> {
        instructions::collateral::handle_mint_pair(ctx, n)
    }

    pub fn merge_pair(ctx: Context<Collateral>, n: u64) -> Result<()> {
        instructions::collateral::handle_merge_pair(ctx, n)
    }

    pub fn merge_pair_up_to(ctx: Context<Collateral>, max_n: u64, keep_yes: u64) -> Result<()> {
        instructions::collateral::handle_merge_pair_up_to(ctx, max_n, keep_yes)
    }

    pub fn place_order(
        ctx: Context<PlaceOrder>,
        side: Side,
        kind: OrderKind,
        price: u8,
        qty: u64,
    ) -> Result<()> {
        instructions::orderbook::handle_place_order(ctx, side, kind, price, qty)
    }

    pub fn cancel_order(ctx: Context<CancelOrder>, order_id: u64) -> Result<()> {
        instructions::orderbook::handle_cancel_order(ctx, order_id)
    }

    pub fn settle_funds(ctx: Context<SettleFunds>) -> Result<()> {
        instructions::orderbook::handle_settle_funds(ctx)
    }

    pub fn settle_market(ctx: Context<SettleMarket>, slot: u8) -> Result<()> {
        instructions::settlement::handle_settle_market(ctx, slot)
    }

    pub fn settle_market_with_reports(
        ctx: Context<SettleMarketWithReports>,
        slot: u8,
        reports: Vec<Vec<u8>>,
    ) -> Result<()> {
        instructions::settlement::handle_settle_market_with_reports(ctx, slot, reports)
    }

    pub fn propose_admin_price(
        ctx: Context<ProposeAdminPrice>,
        ticker: [u8; 8],
        trading_day: u32,
        price: i64,
    ) -> Result<()> {
        instructions::settlement::handle_propose_admin_price(ctx, ticker, trading_day, price)
    }

    pub fn finalize_admin_settle(
        ctx: Context<FinalizeAdminSettle>,
        ticker: [u8; 8],
        trading_day: u32,
    ) -> Result<()> {
        instructions::settlement::handle_finalize_admin_settle(ctx, ticker, trading_day)
    }

    pub fn redeem(ctx: Context<Redeem>, yes_amount: u64, no_amount: u64) -> Result<()> {
        instructions::settlement::handle_redeem(ctx, yes_amount, no_amount)
    }
}

#[derive(Accounts)]
pub struct Ping {}
