use anchor_lang::prelude::*;

#[error_code]
pub enum OracleError {
    #[msg("Signer is not the program's upgrade authority")]
    NotUpgradeAuthority,
    #[msg("Signer is not the registry admin")]
    Unauthorized,
    #[msg("Signer is not a registered relay signer")]
    UnregisteredSigner,
    #[msg("Signer is already registered")]
    SignerAlreadyRegistered,
    #[msg("Signer registry is full")]
    RegistryFull,
    #[msg("publish_time is more than 60 s in the future")]
    PublishTimeInFuture,
    #[msg("publish_time must be greater than the stored one")]
    PublishTimeNotIncreasing,
    #[msg("Price update is from another signer or for another ticker")]
    UpdateMismatch,
    #[msg("Price updates don't form a valid close shape")]
    InvalidCloseShape,
    /// Stub marker for the test-first workflow. Remove once every handler is implemented.
    #[msg("Not implemented")]
    NotImplemented,
}
