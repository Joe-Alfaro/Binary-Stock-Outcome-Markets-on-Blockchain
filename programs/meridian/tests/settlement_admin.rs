//! R36 admin fallback with delay: `propose_admin_price` and `finalize_admin_settle`, and how they
//! interact with `settle_market` (R31 one price per ticker and day, R9 immutability).

mod common;
mod settlement_common;

use anchor_lang::prelude::Pubkey;
use common::*;
use meridian::errors::MeridianError;
use meridian::events::{AdminPriceMismatch, MarketSettled};
use meridian::state::*;
use settlement_common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

const PROPOSE_AT: i64 = T_CLOSE + 900;
const FINALIZE_AT: i64 = T_CLOSE + 3600;

/// Initialized config and one AAPL market at `STRIKE` ($690.00). Clock at `PROPOSE_AT`.
fn setup() -> (Env, MarketKeys) {
    let mut env = Env::initialized();
    let m = env.create_market(STRIKE);
    env.set_time(PROPOSE_AT);
    (env, m)
}

/// The slot-1 close record address for AAPL on `DAY`, which the relay never published.
fn missing_record(env: &Env) -> Pubkey {
    close_pda(&env.relay_signer, ticker("AAPL"), DAY)
}

// ---- propose_admin_price --------------------------------------------------------------------

#[test]
fn r36_propose_admin_price_is_admin_only() {
    let (mut env, m) = setup();
    let automation = env.automation.insecure_clone();
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    for signer in [&automation, &stranger] {
        let ix = env.ix_propose_admin_price(&signer.pubkey(), ticker("AAPL"), DAY, 69_100);
        assert_meridian_err(env.send_one(ix, signer), MeridianError::Unauthorized);
    }
    assert_eq!(env.ticker_day(&m).pending_admin_at, 0);
    assert_ok(env.propose(69_100));
}

#[test]
fn r36_propose_fails_at_close_plus_899_and_succeeds_at_900() {
    let (mut env, m) = setup();
    env.set_time(T_CLOSE + 899);
    assert_meridian_err(env.propose(69_100), MeridianError::AdminProposeTooEarly);
    assert_eq!(env.ticker_day(&m).pending_admin_at, 0);

    env.set_time(T_CLOSE + 900);
    assert_ok(env.propose(69_100));
    let day = env.ticker_day(&m);
    assert_eq!(day.pending_admin_price, 69_100);
    assert_eq!(day.pending_admin_at, T_CLOSE + 900);
    // A proposal alone settles nothing.
    assert_eq!(day.status, TickerDayStatus::Open);
    assert_eq!(env.market(&m).status, MarketStatus::Open);
}

#[test]
fn r36_propose_delay_follows_config() {
    let (mut env, _m) = setup();
    env.update_config_with(meridian::UpdateConfigArgs {
        admin_propose_delay_secs: Some(1200),
        ..Default::default()
    });
    env.set_time(T_CLOSE + 1199);
    assert_meridian_err(env.propose(69_100), MeridianError::AdminProposeTooEarly);
    env.set_time(T_CLOSE + 1200);
    assert_ok(env.propose(69_100));
}

#[test]
fn r36_a_later_proposal_replaces_the_pending_one() {
    let (mut env, m) = setup();
    assert_ok(env.propose(69_100));
    env.set_time(PROPOSE_AT + 600);
    assert_ok(env.propose(68_900));
    let day = env.ticker_day(&m);
    assert_eq!(day.pending_admin_price, 68_900);
    assert_eq!(day.pending_admin_at, PROPOSE_AT + 600);

    env.set_time(FINALIZE_AT);
    assert_ok(env.finalize());
    assert_eq!(env.ticker_day(&m).settle_price, 68_900);
}

#[test]
fn r36_propose_rejects_a_non_positive_price() {
    let (mut env, m) = setup();
    assert_meridian_err(env.propose(0), MeridianError::NonPositivePrice);
    assert_meridian_err(env.propose(-69_000), MeridianError::NonPositivePrice);
    assert_eq!(env.ticker_day(&m).pending_admin_at, 0);
}

#[test]
fn r36_proposal_is_per_ticker_and_day() {
    let mut env = Env::initialized();
    let aapl_low = env.create_market(68_000);
    let aapl_high = env.create_market(70_000);
    let msft = env.create_ticker_market("MSFT", STRIKE);
    env.set_time(PROPOSE_AT);
    assert_ok(env.propose(69_100));
    assert_eq!(env.ticker_day(&aapl_low).pending_admin_price, 69_100);
    assert_eq!(env.ticker_day(&msft).pending_admin_at, 0);

    env.set_time(FINALIZE_AT);
    assert_ok(env.finalize());
    let record = missing_record(&env);
    for m in [&aapl_low, &aapl_high] {
        assert_ok(env.settle(m, record));
    }
    assert_eq!(env.market(&aapl_low).outcome, Some(Outcome::Yes));
    assert_eq!(env.market(&aapl_high).outcome, Some(Outcome::No));
    assert_eq!(env.ticker_day(&msft).status, TickerDayStatus::Open);
    // MSFT has neither a final price nor a close record, so it can't settle.
    let msft_record = close_pda(&env.relay_signer, ticker("MSFT"), DAY);
    assert_failed(env.settle(&msft, msft_record));
    assert_eq!(env.market(&msft).status, MarketStatus::Open);
}

#[test]
fn r36_propose_fails_once_the_ticker_day_is_final() {
    let (mut env, m) = setup();
    let record = env.relay_official_close(69_050);
    assert_ok(env.settle(&m, record));
    assert_meridian_err(env.propose(69_100), MeridianError::TickerDayFinal);
    assert_eq!(env.ticker_day(&m).settle_price, 69_050);
}

// ---- finalize_admin_settle ------------------------------------------------------------------

/// The automation key and a stranger: every signer other than the admin.
fn non_admins(env: &mut Env) -> [Keypair; 2] {
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    [env.automation.insecure_clone(), stranger]
}

#[test]
fn r10_r36_finalize_from_a_non_admin_fails_at_any_time() {
    let (mut env, m) = setup();
    assert_ok(env.propose(69_100));
    let signers = non_admins(&mut env);
    for offset in [900, 3599, 3600, 3601, 7200, 86_400] {
        env.set_time(T_CLOSE + offset);
        for signer in &signers {
            assert_meridian_err(env.finalize_as(signer), MeridianError::Unauthorized);
        }
    }
    let day = env.ticker_day(&m);
    assert_eq!(day.status, TickerDayStatus::Open);
    assert_eq!(day.settle_source, SettleSource::None);
    assert_eq!(
        day.pending_admin_price, 69_100,
        "the pending price is untouched"
    );

    // The admin can still finalize afterwards.
    assert_ok(env.finalize());
    assert_eq!(env.ticker_day(&m).status, TickerDayStatus::Final);
}

#[test]
fn r10_r36_finalize_from_a_non_admin_without_a_pending_price_is_unauthorized() {
    let (mut env, m) = setup();
    env.set_time(FINALIZE_AT);
    let signers = non_admins(&mut env);
    for signer in &signers {
        assert_meridian_err(env.finalize_as(signer), MeridianError::Unauthorized);
    }
    assert_eq!(env.ticker_day(&m).status, TickerDayStatus::Open);
}

#[test]
fn r36_admin_finalize_fails_at_close_plus_3599_and_succeeds_at_3600() {
    let (mut env, m) = setup();
    assert_ok(env.propose(69_100));
    env.set_time(T_CLOSE + 3599);
    assert_meridian_err(env.finalize(), MeridianError::AdminFinalizeTooEarly);
    assert_eq!(env.ticker_day(&m).status, TickerDayStatus::Open);

    env.set_time(T_CLOSE + 3600);
    assert_ok(env.finalize());
    let day = env.ticker_day(&m);
    assert_eq!(day.status, TickerDayStatus::Final);
    assert_eq!(day.settle_price, 69_100);
    assert_eq!(day.settle_expo, meridian::ADMIN_PRICE_EXPO);
    assert_eq!(day.settle_source, SettleSource::Admin);
}

#[test]
fn r36_finalize_without_a_pending_price_fails() {
    let (mut env, m) = setup();
    env.set_time(FINALIZE_AT);
    assert_meridian_err(env.finalize(), MeridianError::NoPendingAdminPrice);
    assert_eq!(env.ticker_day(&m).status, TickerDayStatus::Open);
}

#[test]
fn r36_finalize_twice_fails() {
    let (mut env, m) = setup();
    assert_ok(env.propose(69_100));
    env.set_time(FINALIZE_AT);
    assert_ok(env.finalize());
    env.set_time(FINALIZE_AT + 60);
    assert_meridian_err(env.finalize(), MeridianError::TickerDayFinal);
    assert_eq!(env.ticker_day(&m).settle_price, 69_100);
}

#[test]
fn r36_admin_price_settles_every_strike_by_the_at_or_above_rule() {
    let mut env = Env::initialized();
    let strikes = [68_000, 69_099, 69_100, 69_101, 70_000];
    let markets: Vec<MarketKeys> = strikes.iter().map(|&s| env.create_market(s)).collect();
    env.set_time(PROPOSE_AT);
    assert_ok(env.propose(69_100));
    env.set_time(FINALIZE_AT);
    assert_ok(env.finalize());

    let record = missing_record(&env);
    for m in &markets {
        let meta = assert_ok(env.settle(m, record));
        let settled = events::<MarketSettled>(&meta);
        assert_eq!(settled.len(), 1);
        assert_eq!(settled[0].settle_source, SettleSource::Admin);
    }
    for (m, strike) in markets.iter().zip(strikes) {
        let market = env.market(m);
        let expected = if strike <= 69_100 {
            Outcome::Yes
        } else {
            Outcome::No
        };
        assert_eq!(market.outcome, Some(expected), "strike {strike}");
        assert_eq!(market.settle_price, 69_100);
        assert_eq!(market.settle_source, SettleSource::Admin);
    }
}

#[test]
fn r36_pending_admin_price_alone_does_not_settle_a_market() {
    let (mut env, m) = setup();
    assert_ok(env.propose(69_100));
    env.set_time(FINALIZE_AT - 1);
    let record = missing_record(&env);
    assert_meridian_err(env.settle(&m, record), MeridianError::InvalidOracleAccount);
    assert_eq!(env.market(&m).status, MarketStatus::Open);
}

// ---- oracle versus pending admin price ------------------------------------------------------

#[test]
fn r36_oracle_settlement_before_finalize_wins_and_emits_admin_price_mismatch() {
    let (mut env, m) = setup();
    assert_ok(env.propose(70_000));
    env.set_time(PROPOSE_AT + 300);
    let record = env.relay_official_close(69_050);
    let meta = assert_ok(env.settle(&m, record));

    let market = env.market(&m);
    assert_eq!(market.settle_price, 69_050);
    assert_eq!(market.settle_source, SettleSource::OracleSlot0);
    assert_eq!(market.outcome, Some(Outcome::Yes));
    let mismatches = events::<AdminPriceMismatch>(&meta);
    assert_eq!(mismatches.len(), 1, "exactly one AdminPriceMismatch");
    let e = &mismatches[0];
    assert_eq!(e.ticker_day, m.ticker_day);
    assert_eq!(e.ticker, ticker("AAPL"));
    assert_eq!(e.trading_day, DAY);
    assert_eq!(e.oracle_price, 69_050);
    assert_eq!(e.admin_price, 70_000);

    env.set_time(FINALIZE_AT);
    assert_meridian_err(env.finalize(), MeridianError::TickerDayFinal);
    let day = env.ticker_day(&m);
    assert_eq!(day.settle_price, 69_050);
    assert_eq!(day.settle_source, SettleSource::OracleSlot0);
}

#[test]
fn r36_oracle_settlement_matching_the_pending_price_emits_no_mismatch() {
    let (mut env, m) = setup();
    assert_ok(env.propose(69_050));
    let record = env.relay_official_close(69_050);
    let meta = assert_ok(env.settle(&m, record));
    assert!(events::<AdminPriceMismatch>(&meta).is_empty());
    assert_eq!(events::<MarketSettled>(&meta).len(), 1);
}

#[test]
fn r36_a_final_admin_price_wins_over_a_later_oracle_record() {
    let mut env = Env::initialized();
    let first = env.create_market(STRIKE);
    let second = env.create_market(69_200);
    env.set_time(PROPOSE_AT);
    assert_ok(env.propose(69_100));
    env.set_time(FINALIZE_AT);
    assert_ok(env.finalize());
    let missing = missing_record(&env);
    assert_ok(env.settle(&first, missing));

    // The relay answers late with a different price. The ticker-day price is final.
    env.set_time(FINALIZE_AT + 600);
    let record = env.relay_official_close(69_500);
    assert_ok(env.settle(&second, record));
    let market = env.market(&second);
    assert_eq!(market.settle_price, 69_100);
    assert_eq!(market.settle_source, SettleSource::Admin);
    assert_eq!(market.outcome, Some(Outcome::No));
    assert_eq!(env.ticker_day(&first).settle_price, 69_100);
}

// ---- R9 ---------------------------------------------------------------------------------------

#[test]
fn r9_admin_settled_market_rejects_every_settlement_instruction() {
    let (mut env, m) = setup();
    assert_ok(env.propose(69_100));
    env.set_time(FINALIZE_AT);
    assert_ok(env.finalize());
    let missing = missing_record(&env);
    assert_ok(env.settle(&m, missing));
    let market_before = settled_fields(&env.market(&m));
    let day_before = env.ticker_day(&m);

    env.set_time(FINALIZE_AT + 600);
    let record = env.relay_official_close(60_000);
    assert_meridian_err(env.settle(&m, record), MeridianError::MarketSettled);
    assert_meridian_err(env.propose(60_000), MeridianError::TickerDayFinal);
    assert_meridian_err(env.finalize(), MeridianError::TickerDayFinal);

    assert_eq!(settled_fields(&env.market(&m)), market_before);
    assert_eq!(env.ticker_day(&m), day_before);
}
