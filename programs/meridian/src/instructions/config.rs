use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::errors::MeridianError;
use crate::program::Meridian;
use crate::state::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub struct InitializeConfigArgs {
    pub admin: Pubkey,
    pub automation_authority: Pubkey,
    pub tickers: [Ticker; TICKER_COUNT],
    pub oracle_slots: [OracleSlot; 2],
    pub max_staleness_secs: u32,
    pub max_conf_bps: u16,
    pub admin_propose_delay_secs: u32,
    pub admin_finalize_delay_secs: u32,
}

/// `None` leaves a field unchanged.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Default)]
pub struct UpdateConfigArgs {
    pub automation_authority: Option<Pubkey>,
    pub oracle_slots: Option<[OracleSlot; 2]>,
    pub max_staleness_secs: Option<u32>,
    pub max_conf_bps: Option<u16>,
    pub admin_propose_delay_secs: Option<u32>,
    pub admin_finalize_delay_secs: Option<u32>,
}

/// Only the program's upgrade authority (from the program-data account) may sign.
#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,
    pub usdc_mint: Account<'info, Mint>,
    pub program: Program<'info, Meridian>,
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

/// Shared by `update_config`, `pause` and `unpause`. Deliberately has no market accounts (R42).
#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

pub fn handle_initialize_config(
    _ctx: Context<InitializeConfig>,
    _args: InitializeConfigArgs,
) -> Result<()> {
    err!(MeridianError::NotImplemented)
}

pub fn handle_update_config(_ctx: Context<AdminConfig>, _args: UpdateConfigArgs) -> Result<()> {
    err!(MeridianError::NotImplemented)
}

pub fn handle_pause(_ctx: Context<AdminConfig>) -> Result<()> {
    err!(MeridianError::NotImplemented)
}

pub fn handle_unpause(_ctx: Context<AdminConfig>) -> Result<()> {
    err!(MeridianError::NotImplemented)
}
