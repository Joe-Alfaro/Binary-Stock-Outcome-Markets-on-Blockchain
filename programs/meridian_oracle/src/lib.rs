use anchor_lang::prelude::*;

declare_id!("3HDbiFX8iSf7zXfaYmFRPNnKsjUiLvF55rHperUvjjVY");

#[program]
pub mod meridian_oracle {
    use super::*;

    /// Placeholder instruction so the scaffold builds, deploys and has a smoke test.
    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        msg!("meridian_oracle ping");
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}
