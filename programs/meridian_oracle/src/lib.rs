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

#[program]
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
        let registry = &mut ctx.accounts.registry;
        registry.admin = admin;
        registry.signers = Vec::new();
        registry.bump = ctx.bumps.registry;
        Ok(())
    }

    /// Admin only. Registers a relay signer.
    pub fn add_signer(ctx: Context<UpdateRegistry>, signer: Pubkey) -> Result<()> {
        let signers = &mut ctx.accounts.registry.signers;
        require!(
            !signers.contains(&signer),
            OracleError::SignerAlreadyRegistered
        );
        require!(signers.len() < MAX_SIGNERS, OracleError::RegistryFull);
        signers.push(signer);
        Ok(())
    }

    /// Admin only. Deregisters a relay signer; it can no longer publish.
    pub fn remove_signer(ctx: Context<UpdateRegistry>, signer: Pubkey) -> Result<()> {
        let signers = &mut ctx.accounts.registry.signers;
        let index = signers
            .iter()
            .position(|registered| *registered == signer)
            .ok_or(OracleError::UnregisteredSigner)?;
        signers.remove(index);
        Ok(())
    }

    /// Registered signer only. Creates an append-only `PriceUpdate` at
    /// `["price", signer, ticker, publish_time (i64 LE)]`.
    pub fn publish_price(
        ctx: Context<PublishPrice>,
        ticker: Ticker,
        input: PriceInput,
    ) -> Result<()> {
        check_not_in_future(input.publish_time)?;
        let update = &mut ctx.accounts.price_update;
        update.signer = ctx.accounts.signer.key();
        update.ticker = ticker;
        update.set_input(&input);
        update.bump = ctx.bumps.price_update;
        Ok(())
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
        let first = ctx.accounts.first_update.input();
        let second = ctx
            .accounts
            .second_update
            .as_ref()
            .map(|update| update.input());
        let shape = close_shape(&first, second.as_ref(), close_ts)?;

        let record = &mut ctx.accounts.close_record;
        record.signer = ctx.accounts.signer.key();
        record.ticker = ticker;
        record.trading_day = trading_day;
        record.close_ts = close_ts;
        record.shape = shape;
        record.first = first;
        record.second = second;
        record.bump = ctx.bumps.close_record;
        Ok(())
    }

    /// Registered signer only. Creates or overwrites in place the `LatestPrice` at
    /// `["latest", signer, ticker]`. `publish_time` must be strictly greater than the stored one.
    pub fn publish_latest(
        ctx: Context<PublishLatest>,
        ticker: Ticker,
        input: PriceInput,
    ) -> Result<()> {
        check_not_in_future(input.publish_time)?;
        let latest = &mut ctx.accounts.latest_price;
        // A freshly created account is all zeroes, so its signer is the default key.
        let created = latest.signer == Pubkey::default();
        require!(
            created || input.publish_time > latest.publish_time,
            OracleError::PublishTimeNotIncreasing
        );
        latest.signer = ctx.accounts.signer.key();
        latest.ticker = ticker;
        latest.set_input(&input);
        latest.bump = ctx.bumps.latest_price;
        Ok(())
    }
}

fn check_not_in_future(publish_time: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        publish_time <= now.saturating_add(MAX_FUTURE_SECS),
        OracleError::PublishTimeInFuture
    );
    Ok(())
}

/// Infers the close shape from the updates. A pair must straddle `close_ts` strictly, so an update
/// at the close itself has to be published as an exact-timestamp close instead.
fn close_shape(
    first: &PriceInput,
    second: Option<&PriceInput>,
    close_ts: i64,
) -> Result<CloseShape> {
    match second {
        Some(second) if first.publish_time < close_ts && close_ts < second.publish_time => {
            Ok(CloseShape::Interpolation)
        }
        Some(_) => err!(OracleError::InvalidCloseShape),
        None if first.official_close => Ok(CloseShape::OfficialClose),
        None if first.publish_time == close_ts => Ok(CloseShape::ExactTimestamp),
        None => err!(OracleError::InvalidCloseShape),
    }
}

#[derive(Accounts)]
pub struct Ping {}

#[derive(Accounts)]
pub struct InitializeRegistry<'info> {
    /// Must be the program's upgrade authority. Pays for the registry.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + SignerRegistry::INIT_SPACE,
        seeds = [SIGNERS_SEED],
        bump,
    )]
    pub registry: Account<'info, SignerRegistry>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, program::MeridianOracle>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ OracleError::NotUpgradeAuthority,
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateRegistry<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [SIGNERS_SEED],
        bump = registry.bump,
        has_one = admin @ OracleError::Unauthorized,
    )]
    pub registry: Account<'info, SignerRegistry>,
}

#[derive(Accounts)]
#[instruction(ticker: Ticker, input: PriceInput)]
pub struct PublishPrice<'info> {
    /// The relay signer. Pays for the record.
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(
        seeds = [SIGNERS_SEED],
        bump = registry.bump,
        constraint = registry.signers.contains(&signer.key()) @ OracleError::UnregisteredSigner,
    )]
    pub registry: Account<'info, SignerRegistry>,
    #[account(
        init,
        payer = signer,
        space = 8 + PriceUpdate::INIT_SPACE,
        seeds = [PRICE_SEED, signer.key().as_ref(), &ticker, &input.publish_time.to_le_bytes()],
        bump,
    )]
    pub price_update: Account<'info, PriceUpdate>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(ticker: Ticker, trading_day: u32)]
pub struct PublishClose<'info> {
    /// The relay signer. Pays for the record.
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(
        seeds = [SIGNERS_SEED],
        bump = registry.bump,
        constraint = registry.signers.contains(&signer.key()) @ OracleError::UnregisteredSigner,
    )]
    pub registry: Account<'info, SignerRegistry>,
    /// `init` makes the record write-once: any second call for the same key fails.
    #[account(
        init,
        payer = signer,
        space = 8 + CloseRecord::INIT_SPACE,
        seeds = [CLOSE_SEED, signer.key().as_ref(), &ticker, &trading_day.to_le_bytes()],
        bump,
    )]
    pub close_record: Account<'info, CloseRecord>,
    /// `Account` checks the owner and the `PriceUpdate` discriminator, so only updates this program
    /// wrote through `publish_price` are accepted.
    #[account(
        constraint = first_update.signer == signer.key() && first_update.ticker == ticker
            @ OracleError::UpdateMismatch,
    )]
    pub first_update: Account<'info, PriceUpdate>,
    /// The second `PriceUpdate` of an interpolation pair.
    #[account(
        constraint = second_update.signer == signer.key() && second_update.ticker == ticker
            @ OracleError::UpdateMismatch,
    )]
    pub second_update: Option<Account<'info, PriceUpdate>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(ticker: Ticker)]
pub struct PublishLatest<'info> {
    /// The relay signer. Pays for the account the first time.
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(
        seeds = [SIGNERS_SEED],
        bump = registry.bump,
        constraint = registry.signers.contains(&signer.key()) @ OracleError::UnregisteredSigner,
    )]
    pub registry: Account<'info, SignerRegistry>,
    #[account(
        init_if_needed,
        payer = signer,
        space = 8 + LatestPrice::INIT_SPACE,
        seeds = [LATEST_SEED, signer.key().as_ref(), &ticker],
        bump,
    )]
    pub latest_price: Account<'info, LatestPrice>,
    pub system_program: Program<'info, System>,
}
