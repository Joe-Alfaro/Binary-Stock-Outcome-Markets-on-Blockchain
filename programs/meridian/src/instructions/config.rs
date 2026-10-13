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
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ MeridianError::Unauthorized,
    )]
    pub config: Account<'info, Config>,
}

pub fn handle_initialize_config(
    ctx: Context<InitializeConfig>,
    args: InitializeConfigArgs,
) -> Result<()> {
    // The program-data account must be this program's, and its upgrade authority the signer.
    let program_data = &ctx.accounts.program_data;
    require!(
        ctx.accounts.program.programdata_address()? == Some(program_data.key()),
        MeridianError::Unauthorized
    );
    require!(
        program_data.upgrade_authority_address == Some(ctx.accounts.authority.key()),
        MeridianError::Unauthorized
    );

    ctx.accounts.config.set_inner(Config {
        admin: args.admin,
        automation_authority: args.automation_authority,
        usdc_mint: ctx.accounts.usdc_mint.key(),
        tickers: args.tickers,
        oracle_slots: args.oracle_slots,
        max_staleness_secs: args.max_staleness_secs,
        max_conf_bps: args.max_conf_bps,
        admin_propose_delay_secs: args.admin_propose_delay_secs,
        admin_finalize_delay_secs: args.admin_finalize_delay_secs,
        paused: false,
        demo_mode: false,
        bump: ctx.bumps.config,
    });
    Ok(())
}

pub fn handle_update_config(ctx: Context<AdminConfig>, args: UpdateConfigArgs) -> Result<()> {
    let config = &mut ctx.accounts.config;
    if let Some(v) = args.automation_authority {
        config.automation_authority = v;
    }
    if let Some(v) = args.oracle_slots {
        config.oracle_slots = v;
    }
    if let Some(v) = args.max_staleness_secs {
        config.max_staleness_secs = v;
    }
    if let Some(v) = args.max_conf_bps {
        config.max_conf_bps = v;
    }
    if let Some(v) = args.admin_propose_delay_secs {
        config.admin_propose_delay_secs = v;
    }
    if let Some(v) = args.admin_finalize_delay_secs {
        config.admin_finalize_delay_secs = v;
    }
    Ok(())
}

pub fn handle_pause(ctx: Context<AdminConfig>) -> Result<()> {
    ctx.accounts.config.paused = true;
    Ok(())
}

pub fn handle_unpause(ctx: Context<AdminConfig>) -> Result<()> {
    ctx.accounts.config.paused = false;
    Ok(())
}
