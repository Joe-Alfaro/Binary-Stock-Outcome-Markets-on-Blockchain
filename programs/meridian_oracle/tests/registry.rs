//! R30: the relay signer registry is admin-controlled.

mod common;

use common::*;
use meridian_oracle::{OracleError, SignerRegistry, MAX_SIGNERS};
use solana_keypair::Keypair;
use solana_signer::Signer;

#[test]
fn upgrade_authority_initializes_registry_with_admin() {
    let mut h = Harness::new();
    let authority = h.upgrade_authority.insecure_clone();
    let admin = h.admin.pubkey();

    h.initialize_registry(&authority, admin).unwrap();

    let registry: SignerRegistry = h.fetch(&registry_pda()).expect("registry exists");
    assert_eq!(registry.admin, admin);
    assert!(registry.signers.is_empty());
}

#[test]
fn initialize_registry_rejects_a_signer_other_than_the_upgrade_authority() {
    let mut h = Harness::new();
    let intruder = h.new_funded();

    let result = h.initialize_registry(&intruder, intruder.pubkey());

    assert_oracle_error(result, OracleError::NotUpgradeAuthority);
    assert!(h.account_data(&registry_pda()).is_none());
}

#[test]
fn initialize_registry_twice_fails_and_keeps_the_admin() {
    let mut h = Harness::with_registry();
    let authority = h.upgrade_authority.insecure_clone();

    let result = h.initialize_registry(&authority, Keypair::new().pubkey());

    assert!(result.is_err(), "second initialize_registry must fail");
    let registry: SignerRegistry = h.fetch(&registry_pda()).unwrap();
    assert_eq!(registry.admin, h.admin.pubkey());
}

#[test]
fn admin_adds_and_removes_signers() {
    let mut h = Harness::with_registry();
    let admin = h.admin.insecure_clone();
    let (a, b) = (Keypair::new().pubkey(), Keypair::new().pubkey());

    h.add_signer(&admin, a).unwrap();
    h.add_signer(&admin, b).unwrap();
    let registry: SignerRegistry = h.fetch(&registry_pda()).unwrap();
    assert_eq!(registry.signers, vec![a, b]);

    h.remove_signer(&admin, a).unwrap();
    let registry: SignerRegistry = h.fetch(&registry_pda()).unwrap();
    assert_eq!(registry.signers, vec![b]);
}

#[test]
fn non_admin_cannot_add_a_signer() {
    let mut h = Harness::with_registry();
    let intruder = h.new_funded();

    let result = h.add_signer(&intruder, intruder.pubkey());

    assert_oracle_error(result, OracleError::Unauthorized);
    let registry: SignerRegistry = h.fetch(&registry_pda()).unwrap();
    assert!(registry.signers.is_empty());
}

#[test]
fn non_admin_cannot_remove_a_signer() {
    let mut h = Harness::with_registry();
    let relay = h.new_relay();
    let intruder = h.new_funded();

    let result = h.remove_signer(&intruder, relay.pubkey());

    assert_oracle_error(result, OracleError::Unauthorized);
    let registry: SignerRegistry = h.fetch(&registry_pda()).unwrap();
    assert_eq!(registry.signers, vec![relay.pubkey()]);
}

#[test]
fn adding_a_registered_signer_again_fails() {
    let mut h = Harness::with_registry();
    let admin = h.admin.insecure_clone();
    let relay = h.new_relay();

    let result = h.add_signer(&admin, relay.pubkey());

    assert_oracle_error(result, OracleError::SignerAlreadyRegistered);
}

#[test]
fn registry_holds_at_most_max_signers() {
    let mut h = Harness::with_registry();
    let admin = h.admin.insecure_clone();
    for _ in 0..MAX_SIGNERS {
        h.add_signer(&admin, Keypair::new().pubkey()).unwrap();
    }

    let result = h.add_signer(&admin, Keypair::new().pubkey());

    assert_oracle_error(result, OracleError::RegistryFull);
}

#[test]
fn a_removed_signer_can_no_longer_publish() {
    let mut h = Harness::with_registry();
    let admin = h.admin.insecure_clone();
    let relay = h.new_relay();
    h.publish_price(&relay, AAPL, regular(25_000, CLOSE_TS - 1))
        .unwrap();

    h.remove_signer(&admin, relay.pubkey()).unwrap();

    let result = h.publish_price(&relay, AAPL, regular(25_010, CLOSE_TS + 1));
    assert_oracle_error(result, OracleError::UnregisteredSigner);
    let result = h.publish_latest(&relay, AAPL, regular(25_010, CLOSE_TS + 1));
    assert_oracle_error(result, OracleError::UnregisteredSigner);
}
