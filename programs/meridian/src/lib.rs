use anchor_lang::prelude::*;

declare_id!("9o9a9HpN6Aq4UBeozWshAKBugjtToxWdsVzSMPkVHEMX");

#[program]
pub mod meridian {
    use super::*;

    /// Placeholder instruction so the scaffold builds, deploys and has a smoke test.
    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        msg!("meridian ping");
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}
