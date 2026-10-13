use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
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
}

#[derive(Accounts)]
pub struct Ping {}
