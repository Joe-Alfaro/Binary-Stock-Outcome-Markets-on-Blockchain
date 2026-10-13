use anchor_lang::prelude::*;

pub mod error;
pub mod state;

pub use error::OracleError;
pub use state::*;

declare_id!("3HDbiFX8iSf7zXfaYmFRPNnKsjUiLvF55rHperUvjjVY");

pub const SIGNERS_SEED: &[u8] = b"signers";
pub const PRICE_SEED: &[u8] = b"price";
pub const CLOSE_SEED: &[u8] = b"close";
pub const LATEST_SEED: &[u8] = b"latest";

/// A `publish_time` further than this past the cluster clock is rejected.
pub const MAX_FUTURE_SECS: i64 = 60;
/// Capacity of the signer registry.
pub const MAX_SIGNERS: usize = 8;

// The handlers below are interface stubs for the test-first workflow: the accounts, arguments,
// state and errors are the contract the tests in `tests/` rely on. Each handler still has to be
// implemented, including the account constraints (PDA seeds, `init`, owner checks).
// Argument names are part of the contract too: Anchor names the instruction-data fields after
// them.
#[program]
#[allow(unused_variables)]
pub mod meridian_oracle {
    use super::*;

    /// Placeholder instruction so the scaffold builds, deploys and has a smoke test.
    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        msg!("meridian_oracle ping");
        Ok(())
    }

    /// Creates the `SignerRegistry` at `["signers"]` with `admin` as its admin. Only the program's
    /// upgrade authority may call it, so nobody can front-run it after deploy.
    pub fn initialize_registry(ctx: Context<InitializeRegistry>, admin: Pubkey) -> Result<()> {
        err!(OracleError::NotImplemented)
    }

    /// Admin only. Registers a relay signer.
    pub fn add_signer(ctx: Context<UpdateRegistry>, signer: Pubkey) -> Result<()> {
        err!(OracleError::NotImplemented)
    }

    /// Admin only. Deregisters a relay signer; it can no longer publish.
    pub fn remove_signer(ctx: Context<UpdateRegistry>, signer: Pubkey) -> Result<()> {
        err!(OracleError::NotImplemented)
    }

    /// Registered signer only. Creates an append-only `PriceUpdate` at
    /// `["price", signer, ticker, publish_time (i64 LE)]`.
    pub fn publish_price(
        ctx: Context<PublishPrice>,
        ticker: Ticker,
        input: PriceInput,
    ) -> Result<()> {
        err!(OracleError::NotImplemented)
    }

    /// Registered signer only. Creates the write-once `CloseRecord` at
    /// `["close", signer, ticker, trading_day (u32 LE)]` from the signer's own `PriceUpdate`s for
    /// that ticker. One update forms an official close (flagged) or an exact-timestamp close
    /// (`publish_time == close_ts`); two updates form an interpolation pair
    /// (`first.publish_time < close_ts < second.publish_time`).
    pub fn publish_close(
        ctx: Context<PublishClose>,
        ticker: Ticker,
        trading_day: u32,
        close_ts: i64,
    ) -> Result<()> {
        err!(OracleError::NotImplemented)
    }

    /// Registered signer only. Creates or overwrites in place the `LatestPrice` at
    /// `["latest", signer, ticker]`. `publish_time` must be strictly greater than the stored one.
    pub fn publish_latest(
        ctx: Context<PublishLatest>,
        ticker: Ticker,
        input: PriceInput,
    ) -> Result<()> {
        err!(OracleError::NotImplemented)
    }
}

#[derive(Accounts)]
pub struct Ping {}

#[derive(Accounts)]
pub struct InitializeRegistry<'info> {
    /// Must be the program's upgrade authority. Pays for the registry.
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: stub; the `SignerRegistry` PDA `["signers"]`.
    #[account(mut)]
    pub registry: UncheckedAccount<'info>,
    /// CHECK: stub; this program's account.
    pub program: UncheckedAccount<'info>,
    /// CHECK: stub; this program's program-data account.
    pub program_data: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateRegistry<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: stub; the `SignerRegistry` PDA `["signers"]`.
    #[account(mut)]
    pub registry: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct PublishPrice<'info> {
    /// The relay signer. Pays for the record.
    #[account(mut)]
    pub signer: Signer<'info>,
    /// CHECK: stub; the `SignerRegistry` PDA `["signers"]`.
    pub registry: UncheckedAccount<'info>,
    /// CHECK: stub; the `PriceUpdate` PDA.
    #[account(mut)]
    pub price_update: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PublishClose<'info> {
    /// The relay signer. Pays for the record.
    #[account(mut)]
    pub signer: Signer<'info>,
    /// CHECK: stub; the `SignerRegistry` PDA `["signers"]`.
    pub registry: UncheckedAccount<'info>,
    /// CHECK: stub; the `CloseRecord` PDA.
    #[account(mut)]
    pub close_record: UncheckedAccount<'info>,
    /// CHECK: stub; a `PriceUpdate` owned by this program, from `signer` and for `ticker`.
    pub first_update: UncheckedAccount<'info>,
    /// CHECK: stub; the second `PriceUpdate` of an interpolation pair.
    pub second_update: Option<UncheckedAccount<'info>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PublishLatest<'info> {
    /// The relay signer. Pays for the account the first time.
    #[account(mut)]
    pub signer: Signer<'info>,
    /// CHECK: stub; the `SignerRegistry` PDA `["signers"]`.
    pub registry: UncheckedAccount<'info>,
    /// CHECK: stub; the `LatestPrice` PDA.
    #[account(mut)]
    pub latest_price: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
