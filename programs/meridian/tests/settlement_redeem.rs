//! After settlement: R5 redeem, R4 merge after settlement, R6 post-settlement vault accounting
//! (INV-2), and R2 / INV-3 end to end.

mod common;
mod settlement_common;

use common::*;
use meridian::errors::MeridianError;
use meridian::state::*;
use meridian_math::{settle_outcome, ClosingPrice, ClosingShape, Strike};
use meridian_oracle::PriceInput;
use settlement_common::*;

/// One AAPL market at `STRIKE` and a user holding 10 pairs. Clock at `T_SETTLE`, not settled.
fn setup() -> (Env, MarketKeys, User) {
    let mut env = Env::initialized();
    let m = env.create_market(STRIKE);
    let user = env.user_with_pairs(&m, 10);
    env.set_time(T_SETTLE);
    (env, m, user)
}

/// Settles `m` from a slot-1 official close at `price`.
fn settle_at(env: &mut Env, m: &MarketKeys, price: i64) {
    let record = env.relay_official_close(price);
    assert_ok(env.settle(m, record));
}

/// `setup()` settled with Yes winning ($691.00 close).
fn settled_yes() -> (Env, MarketKeys, User) {
    let (mut env, m, user) = setup();
    settle_at(&mut env, &m, 69_100);
    (env, m, user)
}

/// INV-2: the counter covers every winning token, and the vault covers the counter.
fn assert_inv2(env: &Env, m: &MarketKeys) {
    let market = env.market(m);
    let winning_mint = match market.outcome.expect("settled") {
        Outcome::Yes => m.yes_mint,
        Outcome::No => m.no_mint,
    };
    // Supply is in base units, and each winning base unit is owed one USDC base unit.
    assert!(
        market.collateral >= env.supply(&winning_mint),
        "collateral {} < winning supply {}",
        market.collateral,
        env.supply(&winning_mint)
    );
    assert!(env.balance(&m.vault) >= market.collateral);
}

// ---- R5 redeem --------------------------------------------------------------------------------

#[test]
fn r5_redeem_before_settlement_fails() {
    let (mut env, m, user) = setup();
    assert_meridian_err(
        env.redeem(&user, &m, 10 * UNIT, 10 * UNIT),
        MeridianError::MarketNotSettled,
    );
    assert_eq!(env.balance(&user.yes), 10 * UNIT);
    assert_eq!(env.balance(&user.no), 10 * UNIT);
}

#[test]
fn r5_redeem_pays_one_usdc_per_winning_token_and_nothing_per_losing_token() {
    let (mut env, m, user) = settled_yes();
    let usdc = env.balance(&user.usdc);
    let vault = env.balance(&m.vault);
    assert_ok(env.redeem(&user, &m, 10 * UNIT, 10 * UNIT));

    assert_eq!(env.balance(&user.usdc), usdc + 10 * UNIT);
    assert_eq!(env.balance(&m.vault), vault - 10 * UNIT);
    assert_eq!(env.balance(&user.yes), 0);
    assert_eq!(env.balance(&user.no), 0);
    assert_eq!(env.supply(&m.yes_mint), 0);
    assert_eq!(env.supply(&m.no_mint), 0);
    assert_eq!(env.market(&m).collateral, 0);
}

#[test]
fn r5_redeem_pays_no_holders_when_no_wins() {
    let (mut env, m, user) = setup();
    settle_at(&mut env, &m, 68_999);
    let usdc = env.balance(&user.usdc);
    assert_ok(env.redeem(&user, &m, 0, 4 * UNIT));
    assert_eq!(env.balance(&user.usdc), usdc + 4 * UNIT);
    assert_ok(env.redeem(&user, &m, 10 * UNIT, 0));
    assert_eq!(env.balance(&user.usdc), usdc + 4 * UNIT);
    assert_eq!(env.balance(&user.no), 6 * UNIT);
    assert_eq!(env.balance(&user.yes), 0);
}

#[test]
fn r5_redeem_pays_per_base_unit_for_fractional_amounts() {
    let (mut env, m, user) = settled_yes();
    let usdc = env.balance(&user.usdc);
    assert_ok(env.redeem(&user, &m, 2_500_000, 0));
    assert_eq!(env.balance(&user.usdc), usdc + 2_500_000);
    assert_eq!(env.balance(&user.yes), 10 * UNIT - 2_500_000);
}

#[test]
fn r5_redeeming_only_losing_tokens_burns_them_and_pays_zero_without_error() {
    let (mut env, m, user) = settled_yes();
    let usdc = env.balance(&user.usdc);
    let vault = env.balance(&m.vault);
    let collateral = env.market(&m).collateral;
    assert_ok(env.redeem(&user, &m, 0, 10 * UNIT));
    assert_eq!(env.balance(&user.usdc), usdc);
    assert_eq!(env.balance(&m.vault), vault);
    assert_eq!(env.market(&m).collateral, collateral);
    assert_eq!(env.balance(&user.no), 0);
    assert_eq!(env.supply(&m.no_mint), 0);
}

#[test]
fn r5_redeem_more_than_held_fails() {
    let (mut env, m, user) = settled_yes();
    assert_failed(env.redeem(&user, &m, 11 * UNIT, 0));
    assert_failed(env.redeem(&user, &m, 0, 11 * UNIT));
    assert_eq!(env.balance(&user.yes), 10 * UNIT);
    assert_eq!(env.balance(&user.no), 10 * UNIT);
}

#[test]
fn r5_redeem_works_while_paused() {
    let (mut env, m, user) = settled_yes();
    env.pause();
    let usdc = env.balance(&user.usdc);
    assert_ok(env.redeem(&user, &m, 10 * UNIT, 10 * UNIT));
    assert_eq!(env.balance(&user.usdc), usdc + 10 * UNIT);
}

#[test]
fn r5_redeem_works_365_days_after_settlement_and_nothing_is_closed() {
    let (mut env, m, user) = settled_yes();
    env.set_time(T_SETTLE + 365 * 86_400);
    let usdc = env.balance(&user.usdc);
    assert_ok(env.redeem(&user, &m, 10 * UNIT, 10 * UNIT));
    assert_eq!(env.balance(&user.usdc), usdc + 10 * UNIT);
    for key in [
        m.market,
        m.ticker_day,
        m.yes_mint,
        m.no_mint,
        m.vault,
        m.book,
    ] {
        assert!(env.exists(&key), "{key} must never be closed");
    }
}

// ---- R4 merge after settlement --------------------------------------------------------------

#[test]
fn r4_merge_pair_fails_after_settlement() {
    let (mut env, m, user) = settled_yes();
    assert_meridian_err(env.merge_pair(&user, &m, 1), MeridianError::MarketSettled);
    assert_eq!(env.balance(&user.yes), 10 * UNIT);
    assert_eq!(env.balance(&user.no), 10 * UNIT);
}

// ---- R6 vault accounting after settlement (INV-2) -------------------------------------------

#[test]
fn r6_collateral_covers_the_winning_supply_after_every_redeem() {
    let mut env = Env::initialized();
    let m = env.create_market(STRIKE);
    let alice = env.user_with_pairs(&m, 7);
    let bob = env.user_with_pairs(&m, 3);
    env.set_time(T_SETTLE);
    settle_at(&mut env, &m, 69_100);
    assert_eq!(env.market(&m).collateral, 10 * UNIT);
    assert_inv2(&env, &m);

    let steps: [(&User, u64, u64); 5] = [
        (&alice, 2 * UNIT, 0),
        (&bob, 0, 3 * UNIT),
        (&alice, 5 * UNIT, 7 * UNIT),
        (&bob, 1_500_000, 0),
        (&bob, 1_500_000, 0),
    ];
    for (user, yes, no) in steps {
        let collateral = env.market(&m).collateral;
        let vault = env.balance(&m.vault);
        assert_ok(env.redeem(user, &m, yes, no));
        // Only the winning side is paid, from the counter and the vault alike.
        assert_eq!(env.market(&m).collateral, collateral - yes);
        assert_eq!(env.balance(&m.vault), vault - yes);
        assert_inv2(&env, &m);
    }
    assert_eq!(env.market(&m).collateral, 0);
    assert_eq!(env.balance(&m.vault), 0);
}

#[test]
fn r6_donation_to_the_vault_does_not_change_settlement_or_redeem_amounts() {
    let (mut env, m, user) = setup();
    let donor = env.new_user(&m, 10);
    assert_ok(env.token_transfer(&donor.usdc, &m.vault, &donor.kp, 5 * UNIT));
    settle_at(&mut env, &m, 69_100);
    assert_ok(env.token_transfer(&donor.usdc, &m.vault, &donor.kp, UNIT));
    assert_eq!(env.market(&m).collateral, 10 * UNIT);
    assert_inv2(&env, &m);

    let usdc = env.balance(&user.usdc);
    assert_ok(env.redeem(&user, &m, 10 * UNIT, 10 * UNIT));
    // Exactly the winning tokens are paid. The donation stays in the vault, never paid out.
    assert_eq!(env.balance(&user.usdc), usdc + 10 * UNIT);
    assert_eq!(env.market(&m).collateral, 0);
    assert_eq!(env.balance(&m.vault), 6 * UNIT);
}

#[test]
fn r6_direct_burns_do_not_break_settlement_or_redeem() {
    let mut env = Env::initialized();
    let m = env.create_market(STRIKE);
    let alice = env.user_with_pairs(&m, 6);
    let bob = env.user_with_pairs(&m, 4);
    // Burned with the token program, outside Meridian, before and after settlement.
    assert_ok(env.token_burn(&alice.yes, &m.yes_mint, &alice.kp, 2 * UNIT));
    assert_ok(env.token_burn(&bob.no, &m.no_mint, &bob.kp, UNIT));
    env.set_time(T_SETTLE);
    settle_at(&mut env, &m, 69_100);
    assert_ok(env.token_burn(&bob.yes, &m.yes_mint, &bob.kp, UNIT));
    assert_inv2(&env, &m);

    let alice_usdc = env.balance(&alice.usdc);
    let bob_usdc = env.balance(&bob.usdc);
    assert_ok(env.redeem(&alice, &m, 4 * UNIT, 6 * UNIT));
    assert_inv2(&env, &m);
    assert_ok(env.redeem(&bob, &m, 3 * UNIT, 3 * UNIT));
    assert_inv2(&env, &m);
    assert_eq!(env.balance(&alice.usdc), alice_usdc + 4 * UNIT);
    assert_eq!(env.balance(&bob.usdc), bob_usdc + 3 * UNIT);
    // The 3 Yes burned directly leave their collateral in the vault.
    assert_eq!(env.market(&m).collateral, 3 * UNIT);
    assert_eq!(env.balance(&m.vault), 3 * UNIT);
    assert_eq!(env.supply(&m.yes_mint), 0);
}

// ---- R2 / INV-3 end to end ------------------------------------------------------------------

/// Expected outcome from `meridian-math` for an exact closing price `num / den` at `EXPO`.
fn math_outcome(numerator: i128, denominator: i128, strike: i64) -> Outcome {
    let closing = ClosingPrice {
        shape: ClosingShape::Interpolated,
        expo: EXPO,
        numerator,
        denominator,
        settle_price: 0,
    };
    let strike = Strike {
        value: strike,
        expo: STRIKE_EXPO,
    };
    match settle_outcome(&closing, &strike).unwrap() {
        meridian_math::Outcome::Yes => Outcome::Yes,
        meridian_math::Outcome::No => Outcome::No,
    }
}

#[test]
fn r2_inv3_yes_plus_no_pays_exactly_one_usdc_end_to_end() {
    // (first, second, exact closing price as numerator / denominator)
    let cases: [(PriceInput, Option<PriceInput>, i128, i128); 7] = [
        (official(68_999, T_CLOSE), None, 68_999, 1),
        (official(69_000, T_CLOSE), None, 69_000, 1),
        (official(69_001, T_CLOSE), None, 69_001, 1),
        (regular(1_000, T_CLOSE), None, 1_000, 1),
        (official(5_000_000, T_CLOSE), None, 5_000_000, 1),
        (
            regular(68_990, T_BEFORE),
            Some(regular(69_010, T_AFTER)),
            68_990 * 30 + 69_010 * 30,
            60,
        ),
        (
            regular(68_999, T_CLOSE - 200),
            Some(regular(69_000, T_CLOSE + 100)),
            68_999 * 100 + 69_000 * 200,
            300,
        ),
    ];
    for (first, second, num, den) in cases {
        let mut env = Env::initialized();
        let strikes = [68_999, STRIKE, 69_001];
        let markets: Vec<MarketKeys> = strikes.iter().map(|&s| env.create_market(s)).collect();
        let users: Vec<User> = markets.iter().map(|m| env.user_with_pairs(m, 3)).collect();
        env.set_time(T_SETTLE);
        let record = env.relay_close(first, second);

        for ((m, user), strike) in markets.iter().zip(&users).zip(strikes) {
            assert_ok(env.settle(m, record));
            let expected = math_outcome(num, den, strike);
            assert_eq!(env.market(m).outcome, Some(expected), "strike {strike}");

            let usdc = env.balance(&user.usdc);
            assert_ok(env.redeem(user, m, UNIT, 0));
            let yes_paid = env.balance(&user.usdc) - usdc;
            assert_ok(env.redeem(user, m, 0, UNIT));
            let no_paid = env.balance(&user.usdc) - usdc - yes_paid;
            assert_eq!(yes_paid + no_paid, UNIT, "Yes + No for strike {strike}");
            assert_ok(env.redeem(user, m, 2 * UNIT, 2 * UNIT));
            assert_eq!(env.balance(&user.usdc), usdc + 3 * UNIT);
            assert_eq!(env.market(m).collateral, 0);
        }
    }
}
