//! Pre-settlement collateral: R3 mint_pair, R4 merge_pair, R6 vault accounting, R7 supply
//! control, R8 no fees, R41 pause.

mod common;

use common::*;
use meridian::errors::MeridianError;
use meridian::state::*;

/// Initialized config, one AAPL market, clock just after the mint opens, one user with 100 USDC.
fn setup() -> (Env, MarketKeys, User) {
    let mut env = Env::initialized();
    let m = env.create_market(STRIKE);
    env.set_time(T_MINT_OPEN + 60);
    let user = env.new_user(&m, 100);
    (env, m, user)
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
struct Snapshot {
    user_usdc: u64,
    user_yes: u64,
    user_no: u64,
    vault: u64,
    yes_supply: u64,
    no_supply: u64,
    collateral: u64,
    pairs: u64,
}

fn snap(env: &Env, m: &MarketKeys, u: &User) -> Snapshot {
    let market = env.market(m);
    Snapshot {
        user_usdc: env.balance(&u.usdc),
        user_yes: env.balance(&u.yes),
        user_no: env.balance(&u.no),
        vault: env.balance(&m.vault),
        yes_supply: env.supply(&m.yes_mint),
        no_supply: env.supply(&m.no_mint),
        collateral: market.collateral,
        pairs: market.pairs_outstanding,
    }
}

/// R6 INV-1 with the internal counter: exact collateral, vault at least collateral, supplies no
/// more than the pairs outstanding.
fn assert_inv1(env: &Env, m: &MarketKeys) {
    let market = env.market(m);
    assert_eq!(
        market.collateral,
        market.pairs_outstanding * UNIT,
        "collateral == pairs_outstanding x 1_000_000"
    );
    assert!(
        env.balance(&m.vault) >= market.collateral,
        "vault.amount >= collateral"
    );
    assert!(env.supply(&m.yes_mint) <= market.pairs_outstanding * UNIT);
    assert!(env.supply(&m.no_mint) <= market.pairs_outstanding * UNIT);
}

// ---- R3 mint_pair ------------------------------------------------------------------------------

#[test]
fn r3_mint_pair_moves_exact_usdc_and_mints_n_yes_and_n_no() {
    let (mut env, m, user) = setup();
    let before = snap(&env, &m, &user);
    assert_ok(env.mint_pair(&user, &m, 3));
    let after = snap(&env, &m, &user);

    assert_eq!(after.user_usdc, before.user_usdc - 3 * UNIT);
    assert_eq!(after.vault, before.vault + 3 * UNIT);
    assert_eq!(after.user_yes, 3 * UNIT);
    assert_eq!(after.user_no, 3 * UNIT);
    assert_eq!(after.yes_supply, 3 * UNIT);
    assert_eq!(after.no_supply, 3 * UNIT);
    assert_eq!(after.collateral, 3 * UNIT);
    assert_eq!(after.pairs, 3);
    assert_inv1(&env, &m);
}

#[test]
fn r3_mint_pair_allowed_from_mint_open_until_just_before_close() {
    let (mut env, m, user) = setup();
    env.set_time(T_MINT_OPEN);
    assert_ok(env.mint_pair(&user, &m, 1));
    env.set_time(T_CLOSE - 1);
    assert_ok(env.mint_pair(&user, &m, 1));
    assert_eq!(env.market(&m).pairs_outstanding, 2);
}

fn assert_mint_rejected(env: &mut Env, m: &MarketKeys, user: &User, n: u64, err: MeridianError) {
    let before = snap(env, m, user);
    assert_meridian_err(env.mint_pair(user, m, n), err);
    assert_eq!(
        snap(env, m, user),
        before,
        "a rejected mint changes nothing"
    );
}

#[test]
fn r3_mint_pair_fails_when_paused() {
    let (mut env, m, user) = setup();
    env.pause();
    assert_mint_rejected(&mut env, &m, &user, 1, MeridianError::Paused);
}

#[test]
fn r3_mint_pair_fails_before_mint_open() {
    let (mut env, m, user) = setup();
    for t in [T_CREATE, T_MINT_OPEN - 1] {
        env.set_time(t);
        assert_mint_rejected(&mut env, &m, &user, 1, MeridianError::MintNotOpen);
    }
}

#[test]
fn r3_mint_pair_fails_at_and_after_close() {
    let (mut env, m, user) = setup();
    for t in [T_CLOSE, T_CLOSE + 1, T_CLOSE + 86_400] {
        env.set_time(t);
        assert_mint_rejected(&mut env, &m, &user, 1, MeridianError::MarketClosed);
    }
}

#[test]
fn r3_mint_pair_fails_after_settlement() {
    let (mut env, m, user) = setup();
    env.force_settle(&m, Outcome::Yes);
    assert_mint_rejected(&mut env, &m, &user, 1, MeridianError::MarketSettled);
}

#[test]
fn r3_mint_pair_fails_with_zero() {
    let (mut env, m, user) = setup();
    assert_mint_rejected(&mut env, &m, &user, 0, MeridianError::ZeroAmount);
}

#[test]
fn r3_mint_pair_fails_without_enough_usdc() {
    let (mut env, m, user) = setup();
    let before = snap(&env, &m, &user);
    assert_failed(env.mint_pair(&user, &m, 101));
    assert_eq!(snap(&env, &m, &user), before);
}

// ---- R4 merge_pair -----------------------------------------------------------------------------

#[test]
fn r4_merge_pair_burns_n_of_each_and_pays_n_usdc() {
    let (mut env, m, user) = setup();
    assert_ok(env.mint_pair(&user, &m, 5));
    let before = snap(&env, &m, &user);
    assert_ok(env.merge_pair(&user, &m, 2));
    let after = snap(&env, &m, &user);

    assert_eq!(after.user_usdc, before.user_usdc + 2 * UNIT);
    assert_eq!(after.vault, before.vault - 2 * UNIT);
    assert_eq!(after.user_yes, 3 * UNIT);
    assert_eq!(after.user_no, 3 * UNIT);
    assert_eq!(after.yes_supply, 3 * UNIT);
    assert_eq!(after.no_supply, 3 * UNIT);
    assert_eq!(after.collateral, 3 * UNIT);
    assert_eq!(after.pairs, 3);
    assert_inv1(&env, &m);
}

#[test]
fn r4_merge_pair_works_while_paused() {
    let (mut env, m, user) = setup();
    assert_ok(env.mint_pair(&user, &m, 2));
    env.pause();
    let before = env.balance(&user.usdc);
    assert_ok(env.merge_pair(&user, &m, 2));
    assert_eq!(env.balance(&user.usdc), before + 2 * UNIT);
    assert_inv1(&env, &m);
}

#[test]
fn r4_merge_pair_works_after_close() {
    let (mut env, m, user) = setup();
    assert_ok(env.mint_pair(&user, &m, 2));
    env.set_time(T_CLOSE);
    assert_ok(env.merge_pair(&user, &m, 1));
    env.set_time(T_CLOSE + 7 * 86_400);
    assert_ok(env.merge_pair(&user, &m, 1));
    assert_eq!(env.balance(&user.usdc), 100 * UNIT);
    assert_eq!(env.market(&m).pairs_outstanding, 0);
}

#[test]
fn r4_merge_pair_fails_after_settlement() {
    let (mut env, m, user) = setup();
    assert_ok(env.mint_pair(&user, &m, 2));
    env.force_settle(&m, Outcome::No);
    let before = snap(&env, &m, &user);
    assert_meridian_err(env.merge_pair(&user, &m, 1), MeridianError::MarketSettled);
    assert_eq!(snap(&env, &m, &user), before);
}

#[test]
fn r4_merge_pair_fails_when_holding_fewer_yes_than_n() {
    let (mut env, m, user) = setup();
    let other = env.new_user(&m, 0);
    assert_ok(env.mint_pair(&user, &m, 3));
    assert_ok(env.token_transfer(&user.yes, &other.yes, &user.kp, UNIT));
    let before = snap(&env, &m, &user);
    assert_failed(env.merge_pair(&user, &m, 3));
    assert_eq!(snap(&env, &m, &user), before);
    assert_ok(env.merge_pair(&user, &m, 2));
}

#[test]
fn r4_merge_pair_fails_when_holding_fewer_no_than_n() {
    let (mut env, m, user) = setup();
    let other = env.new_user(&m, 0);
    assert_ok(env.mint_pair(&user, &m, 3));
    assert_ok(env.token_transfer(&user.no, &other.no, &user.kp, 2 * UNIT));
    let before = snap(&env, &m, &user);
    assert_failed(env.merge_pair(&user, &m, 2));
    assert_eq!(snap(&env, &m, &user), before);
    assert_ok(env.merge_pair(&user, &m, 1));
}

#[test]
fn r4_merge_pair_cannot_burn_someone_elses_tokens() {
    let (mut env, m, user) = setup();
    let thief = env.new_user(&m, 0);
    assert_ok(env.mint_pair(&user, &m, 2));
    // The thief signs but names the victim's Yes and No accounts and their own USDC account.
    let victim_accounts = User {
        kp: thief.kp.insecure_clone(),
        usdc: thief.usdc,
        yes: user.yes,
        no: user.no,
    };
    assert_failed(env.merge_pair(&victim_accounts, &m, 2));
    assert_eq!(env.balance(&user.yes), 2 * UNIT);
    assert_eq!(env.balance(&thief.usdc), 0);
}

// ---- R6 vault accounting -----------------------------------------------------------------------

#[test]
fn r6_collateral_equals_pairs_outstanding_after_every_mint_and_merge() {
    let (mut env, m, alice) = setup();
    let bob = env.new_user(&m, 50);
    let steps: [(bool, bool, u64); 6] = [
        (true, true, 4),   // alice mints 4
        (false, true, 7),  // bob mints 7
        (true, false, 1),  // alice merges 1
        (false, false, 7), // bob merges 7
        (true, true, 2),   // alice mints 2
        (true, false, 5),  // alice merges 5
    ];
    let mut expected_pairs = 0u64;
    for (is_alice, is_mint, n) in steps {
        let u = if is_alice { &alice } else { &bob };
        if is_mint {
            assert_ok(env.mint_pair(u, &m, n));
            expected_pairs += n;
        } else {
            assert_ok(env.merge_pair(u, &m, n));
            expected_pairs -= n;
        }
        assert_inv1(&env, &m);
        let market = env.market(&m);
        assert_eq!(market.pairs_outstanding, expected_pairs);
        assert_eq!(env.balance(&m.vault), expected_pairs * UNIT);
        assert_eq!(env.supply(&m.yes_mint), expected_pairs * UNIT);
        assert_eq!(env.supply(&m.no_mint), expected_pairs * UNIT);
    }
    assert_eq!(expected_pairs, 0);
}

#[test]
fn r6_donation_to_vault_does_not_break_mint_or_merge() {
    let (mut env, m, user) = setup();
    let donor = env.new_user(&m, 5);
    assert_ok(env.token_transfer(&donor.usdc, &m.vault, &donor.kp, 5 * UNIT));

    let start = env.balance(&user.usdc);
    assert_ok(env.mint_pair(&user, &m, 2));
    assert_eq!(env.balance(&user.usdc), start - 2 * UNIT);
    assert_inv1(&env, &m);

    assert_ok(env.merge_pair(&user, &m, 1));
    assert_eq!(env.balance(&user.usdc), start - UNIT);
    assert_inv1(&env, &m);

    assert_ok(env.mint_pair(&user, &m, 3));
    assert_ok(env.merge_pair(&user, &m, 4));
    assert_eq!(
        env.balance(&user.usdc),
        start,
        "merge pays exactly n x 1_000_000, never the donation"
    );

    let market = env.market(&m);
    assert_eq!(market.pairs_outstanding, 0);
    assert_eq!(market.collateral, 0);
    assert_eq!(
        env.balance(&m.vault),
        5 * UNIT,
        "the donation stays in the vault"
    );
}

#[test]
fn r6_direct_burns_of_yes_and_no_do_not_break_the_market() {
    let (mut env, m, alice) = setup();
    let bob = env.new_user(&m, 10);
    assert_ok(env.mint_pair(&alice, &m, 4));
    assert_ok(env.mint_pair(&bob, &m, 2));

    // Alice burns one Yes and two No straight through the token program.
    assert_ok(env.token_burn(&alice.yes, &m.yes_mint, &alice.kp, UNIT));
    assert_ok(env.token_burn(&alice.no, &m.no_mint, &alice.kp, 2 * UNIT));
    assert_inv1(&env, &m);

    assert_ok(env.merge_pair(&alice, &m, 2));
    assert_inv1(&env, &m);
    assert_ok(env.mint_pair(&alice, &m, 1));
    assert_inv1(&env, &m);
    assert_ok(env.merge_pair(&bob, &m, 2));
    assert_inv1(&env, &m);

    let market = env.market(&m);
    assert_eq!(market.pairs_outstanding, 4 + 2 - 2 + 1 - 2);
    assert_eq!(market.collateral, 3 * UNIT);
    assert_eq!(env.supply(&m.yes_mint), 2 * UNIT);
    assert_eq!(env.supply(&m.no_mint), UNIT);
    assert_eq!(
        env.balance(&m.vault),
        3 * UNIT,
        "collateral behind burned tokens stays in the vault"
    );
    assert_eq!(env.balance(&bob.usdc), 10 * UNIT);
}

// ---- R7 supply control -------------------------------------------------------------------------

#[test]
fn r7_supply_changes_only_through_mint_and_merge() {
    let (mut env, m, user) = setup();
    let other = env.new_user(&m, 0);
    assert_ok(env.mint_pair(&user, &m, 3));
    // Moving tokens between wallets never changes supply.
    assert_ok(env.token_transfer(&user.yes, &other.yes, &user.kp, UNIT));
    assert_ok(env.token_transfer(&user.no, &other.no, &user.kp, UNIT));
    assert_eq!(env.supply(&m.yes_mint), 3 * UNIT);
    assert_eq!(env.supply(&m.no_mint), 3 * UNIT);
    assert_ok(env.merge_pair(&other, &m, 1));
    assert_eq!(env.supply(&m.yes_mint), 2 * UNIT);
    assert_eq!(env.supply(&m.no_mint), 2 * UNIT);
}

// ---- R8 no fees --------------------------------------------------------------------------------

#[test]
fn r8_mint_and_merge_charge_no_fee() {
    let (mut env, m, user) = setup();
    for (is_mint, n) in [(true, 7u64), (false, 3), (true, 1), (false, 5)] {
        let usdc_before = env.balance(&user.usdc);
        let vault_before = env.balance(&m.vault);
        let sol_before = env.lamports(&user.pubkey());
        let meta = if is_mint {
            assert_ok(env.mint_pair(&user, &m, n))
        } else {
            assert_ok(env.merge_pair(&user, &m, n))
        };
        let moved = n * UNIT;
        if is_mint {
            assert_eq!(env.balance(&user.usdc), usdc_before - moved);
            assert_eq!(env.balance(&m.vault), vault_before + moved);
        } else {
            assert_eq!(env.balance(&user.usdc), usdc_before + moved);
            assert_eq!(env.balance(&m.vault), vault_before - moved);
        }
        assert_eq!(
            env.lamports(&user.pubkey()),
            sol_before - meta.fee,
            "only the network fee is paid in SOL"
        );
    }
    assert_eq!(env.balance(&user.usdc), 100 * UNIT);
}

#[test]
fn r8_mint_and_merge_touch_no_other_usdc_account() {
    let (env, m, user) = setup();
    for ix in [
        env.ix_mint_pair(&user, &m, 1),
        env.ix_merge_pair(&user, &m, 1),
    ] {
        let usdc_accounts: Vec<_> = ix
            .accounts
            .iter()
            .filter(|a| a.is_writable)
            .map(|a| a.pubkey)
            .filter(|k| {
                env.svm.get_account(k).is_some_and(|acc| {
                    acc.owner == spl_token_interface::ID && acc.data.len() == 165
                })
            })
            .filter(|k| env.token_account(k).mint == env.usdc_mint)
            .collect();
        assert_eq!(usdc_accounts, vec![m.vault, user.usdc]);
    }
}

// ---- R41 pause ---------------------------------------------------------------------------------

#[test]
fn r41_pause_blocks_mint_pair_and_unpause_restores_it() {
    let (mut env, m, user) = setup();
    assert_ok(env.mint_pair(&user, &m, 2));
    env.pause();
    assert_mint_rejected(&mut env, &m, &user, 1, MeridianError::Paused);
    assert_ok(env.merge_pair(&user, &m, 1));
    env.unpause();
    assert_ok(env.mint_pair(&user, &m, 1));
    assert_eq!(env.market(&m).pairs_outstanding, 2);
    assert_inv1(&env, &m);
}
