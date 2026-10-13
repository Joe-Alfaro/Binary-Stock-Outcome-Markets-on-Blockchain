//! R5 redeem as the SDK's `buildRedeem` sends it: one wallet-signed transaction that creates the
//! wallet's USDC, Yes and No associated token accounts idempotently, then redeems. `redeem` needs
//! all three accounts to exist, so a wallet holding only Yes can redeem only because the same
//! transaction creates its No account.

#![allow(clippy::result_large_err)]

mod common;
mod settlement_common;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::system_program;
use common::*;
use litesvm::types::TransactionResult;
use meridian::state::UNIT;
use settlement_common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

const ATA_PROGRAM: Pubkey = anchor_lang::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[
            owner.as_ref(),
            spl_token_interface::ID.as_ref(),
            mint.as_ref(),
        ],
        &ATA_PROGRAM,
    )
    .0
}

/// The associated token program's `CreateIdempotent`, paid by the owner.
fn ix_create_ata_idempotent(owner: &Pubkey, mint: &Pubkey) -> Instruction {
    Instruction {
        program_id: ATA_PROGRAM,
        accounts: vec![
            AccountMeta::new(*owner, true),
            AccountMeta::new(ata(owner, mint), false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(spl_token_interface::ID, false),
        ],
        data: vec![1],
    }
}

/// A market settled Yes and a wallet whose only token account is a Yes associated token account
/// holding `qty` whole Yes, minted by another wallet and transferred to it. No USDC or No account.
fn settled_yes_only_holder(qty: u64) -> (Env, MarketKeys, User) {
    let mut env = Env::initialized();
    let m = env.create_market(STRIKE);
    let minter = env.user_with_pairs(&m, qty);

    let kp = Keypair::new();
    env.svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
    let owner = kp.pubkey();
    let holder = User {
        usdc: ata(&owner, &env.usdc_mint),
        yes: ata(&owner, &m.yes_mint),
        no: ata(&owner, &m.no_mint),
        kp,
    };
    let create_yes = ix_create_ata_idempotent(&owner, &m.yes_mint);
    let holder_kp = holder.kp.insecure_clone();
    assert_ok(env.send(&[create_yes], &holder_kp, &[]));
    assert_ok(env.token_transfer(&minter.yes, &holder.yes, &minter.kp, qty * UNIT));

    env.set_time(T_SETTLE);
    let record = env.relay_official_close(69_100);
    assert_ok(env.settle(&m, record));

    assert_eq!(env.balance(&holder.yes), qty * UNIT);
    assert!(!env.exists(&holder.no), "the holder has no No account");
    assert!(!env.exists(&holder.usdc), "the holder has no USDC account");
    (env, m, holder)
}

/// The transaction `buildRedeem` sends: create the USDC, Yes and No accounts, then redeem.
fn send_builder_redeem(env: &mut Env, m: &MarketKeys, user: &User, yes: u64) -> TransactionResult {
    let owner = user.pubkey();
    let ixs = [
        ix_create_ata_idempotent(&owner, &env.usdc_mint.clone()),
        ix_create_ata_idempotent(&owner, &m.yes_mint),
        ix_create_ata_idempotent(&owner, &m.no_mint),
        env.ix_redeem(user, m, yes, 0),
    ];
    let kp = user.kp.insecure_clone();
    env.send(&ixs, &kp, &[])
}

#[test]
fn r5_redeem_without_the_no_account_fails() {
    let (mut env, m, holder) = settled_yes_only_holder(10);
    let create_usdc = ix_create_ata_idempotent(&holder.pubkey(), &env.usdc_mint.clone());
    let redeem = env.ix_redeem(&holder, &m, 10 * UNIT, 0);
    let kp = holder.kp.insecure_clone();

    assert_failed(env.send(&[create_usdc, redeem], &kp, &[]));
    assert_eq!(env.balance(&holder.yes), 10 * UNIT);
}

#[test]
fn r5_redeem_succeeds_for_a_yes_only_wallet_when_the_builder_creates_the_no_account() {
    let (mut env, m, holder) = settled_yes_only_holder(10);
    let vault = env.balance(&m.vault);

    assert_ok(send_builder_redeem(&mut env, &m, &holder, 10 * UNIT));

    assert_eq!(
        env.balance(&holder.usdc),
        10 * UNIT,
        "one USDC per winning Yes"
    );
    assert_eq!(env.balance(&holder.yes), 0, "the Yes is burned");
    assert_eq!(
        env.balance(&holder.no),
        0,
        "the No account exists and stays empty"
    );
    assert_eq!(env.supply(&m.yes_mint), 0);
    assert_eq!(env.balance(&m.vault), vault - 10 * UNIT);
}

#[test]
fn r5_builder_redeem_is_idempotent_about_accounts_that_already_exist() {
    let (mut env, m, holder) = settled_yes_only_holder(10);

    // The Yes account exists already; a second redeem finds all three accounts in place.
    assert_ok(send_builder_redeem(&mut env, &m, &holder, 4 * UNIT));
    assert_ok(send_builder_redeem(&mut env, &m, &holder, 6 * UNIT));

    assert_eq!(env.balance(&holder.usdc), 10 * UNIT);
    assert_eq!(env.balance(&holder.yes), 0);
}
