use anchor_lang::prelude::*;

#[event]
pub struct PairMinted {
    pub market: Pubkey,
    pub user: Pubkey,
    /// Whole pairs.
    pub n: u64,
}

#[event]
pub struct PairMerged {
    pub market: Pubkey,
    pub user: Pubkey,
    /// Whole pairs.
    pub n: u64,
}
