//! R12 create strike market, R13 add strike, and the R7 mint-authority checks.

mod common;

use common::*;
use meridian::errors::MeridianError;
use meridian::state::*;
use solana_keypair::Keypair;
use solana_program_option::COption;
use solana_signer::Signer;

fn assert_market_absent(env: &Env, m: &MarketKeys) {
    for key in [
        m.market,
        m.yes_mint,
        m.no_mint,
        m.vault,
        m.book,
        m.yes_escrow,
        m.usdc_escrow,
    ] {
        assert!(!env.exists(&key), "account {key} must not exist");
    }
}

// ---- R12 ---------------------------------------------------------------------------------------

#[test]
fn r12_admin_creates_one_market_with_mints_vault_book_and_escrows() {
    let mut env = Env::initialized();
    let m = env.create_market(STRIKE);
    let market_pda = m.market;

    let market = env.market(&m);
    assert_eq!(market.ticker, ticker("AAPL"));
    assert_eq!(market.trading_day, DAY);
    assert_eq!(market.strike, STRIKE);
    assert_eq!(market.strike_expo, STRIKE_EXPO);
    assert_eq!(market.close_ts, T_CLOSE);
    assert_eq!(market.mint_open_ts, T_MINT_OPEN);
    assert_eq!(market.trading_open_ts, T_TRADING_OPEN);
    assert_eq!(market.ticker_day, m.ticker_day);
    assert_eq!(market.yes_mint, m.yes_mint);
    assert_eq!(market.no_mint, m.no_mint);
    assert_eq!(market.vault, m.vault);
    assert_eq!(market.book, m.book);
    assert_eq!(market.collateral, 0);
    assert_eq!(market.pairs_outstanding, 0);
    assert_eq!(market.status, MarketStatus::Open);
    assert_eq!(market.outcome, None);
    assert_eq!(market.settle_source, SettleSource::None);
    assert!(!market.demo);
    assert_eq!(market.created_at, T_CREATE);

    // R7: mint authority is the market PDA, no freeze authority, 6 decimals.
    for mint_key in [m.yes_mint, m.no_mint] {
        let mint = env.mint(&mint_key);
        assert_eq!(mint.decimals, 6);
        assert_eq!(mint.mint_authority, COption::Some(market_pda));
        assert_eq!(mint.freeze_authority, COption::None);
        assert_eq!(mint.supply, 0);
    }

    let vault = env.token_account(&m.vault);
    assert_eq!(vault.mint, env.usdc_mint);
    assert_eq!(vault.owner, market_pda);
    assert_eq!(vault.amount, 0);

    let book = env.raw(&m.book);
    assert_eq!(book.owner, meridian::ID);
    assert_eq!(
        &book.data[8..40],
        market_pda.as_ref(),
        "OrderBook.market is the first field"
    );

    let yes_escrow = env.token_account(&m.yes_escrow);
    assert_eq!(yes_escrow.mint, m.yes_mint);
    assert_eq!(yes_escrow.owner, m.book);
    let usdc_escrow = env.token_account(&m.usdc_escrow);
    assert_eq!(usdc_escrow.mint, env.usdc_mint);
    assert_eq!(usdc_escrow.owner, m.book);
    assert_ne!(
        m.usdc_escrow, m.vault,
        "order escrow never lives in the collateral vault"
    );

    let day = env.ticker_day(&m);
    assert_eq!(day.ticker, ticker("AAPL"));
    assert_eq!(day.trading_day, DAY);
    assert_eq!(day.close_ts, T_CLOSE);
    assert_eq!(day.status, TickerDayStatus::Open);
}

#[test]
fn r12_automation_authority_can_create_market() {
    let mut env = Env::initialized();
    let args = env.market_args("MSFT", 50_000);
    let auto = env.automation.insecure_clone();
    let ix = env.ix_create_strike_market(&auto.pubkey(), args);
    assert_ok(env.send_one(ix, &auto));
    let m = MarketKeys::derive(args.ticker, DAY, 50_000);
    assert_eq!(env.market(&m).strike, 50_000);
}

#[test]
fn r12_other_signers_cannot_create_market() {
    let mut env = Env::initialized();
    let args = env.market_args("AAPL", STRIKE);
    let m = MarketKeys::derive(args.ticker, DAY, STRIKE);
    for signer in [env.upgrade_authority.insecure_clone(), Keypair::new()] {
        env.svm.airdrop(&signer.pubkey(), 10_000_000_000).unwrap();
        let ix = env.ix_create_strike_market(&signer.pubkey(), args);
        assert_meridian_err(env.send_one(ix, &signer), MeridianError::Unauthorized);
        assert_market_absent(&env, &m);
    }
}

#[test]
fn r12_creating_the_same_market_twice_fails() {
    let mut env = Env::initialized();
    let m = env.create_market(STRIKE);
    let before = env.raw(&m.market);

    let args = env.market_args("AAPL", STRIKE);
    for signer in [env.admin.insecure_clone(), env.automation.insecure_clone()] {
        let ix = env.ix_create_strike_market(&signer.pubkey(), args);
        assert_failed(env.send_one(ix, &signer));
    }
    assert_eq!(env.raw(&m.market).data, before.data);
}

#[test]
fn r12_unknown_ticker_fails() {
    let mut env = Env::initialized();
    let args = env.market_args("IBM", 10_000);
    let admin = env.admin.insecure_clone();
    let ix = env.ix_create_strike_market(&admin.pubkey(), args);
    assert_meridian_err(env.send_one(ix, &admin), MeridianError::UnknownTicker);
    assert_market_absent(&env, &MarketKeys::derive(args.ticker, DAY, 10_000));
}

#[test]
fn r12_each_call_creates_exactly_one_strike_and_strikes_share_the_ticker_day() {
    let mut env = Env::initialized();
    let a = env.create_market(STRIKE);
    for neighbour in [STRIKE - 1_000, STRIKE + 1_000] {
        assert_market_absent(&env, &MarketKeys::derive(a.ticker, DAY, neighbour));
    }

    let b = env.create_market(STRIKE + 1_000);
    assert_ne!(a.market, b.market);
    assert_eq!(a.ticker_day, b.ticker_day);
    assert_eq!(env.market(&b).ticker_day, a.ticker_day);
    assert_eq!(env.market(&a).strike, STRIKE);
    assert_eq!(env.market(&b).strike, STRIKE + 1_000);
}

#[test]
fn r12_strikes_of_one_ticker_day_must_share_close_ts() {
    let mut env = Env::initialized();
    env.create_market(STRIKE);
    let mut args = env.market_args("AAPL", STRIKE + 1_000);
    args.close_ts = T_CLOSE - 3 * 3600;
    let admin = env.admin.insecure_clone();
    let ix = env.ix_create_strike_market(&admin.pubkey(), args);
    assert_meridian_err(env.send_one(ix, &admin), MeridianError::CloseTsMismatch);
}

// ---- R13 ---------------------------------------------------------------------------------------

#[test]
fn r13_admin_adds_strike_intraday_before_close() {
    let mut env = Env::initialized();
    env.create_market(STRIKE);
    env.set_time(T_CLOSE - 3600);
    let args = env.market_args("AAPL", STRIKE + 2_000);
    let admin = env.admin.insecure_clone();
    let ix = env.ix_add_strike(&admin.pubkey(), args);
    assert_ok(env.send_one(ix, &admin));

    let m = MarketKeys::derive(args.ticker, DAY, args.strike);
    let market = env.market(&m);
    assert_eq!(market.strike, STRIKE + 2_000);
    assert_eq!(market.close_ts, T_CLOSE);
    assert_eq!(market.status, MarketStatus::Open);
    assert_eq!(
        env.mint(&m.yes_mint).mint_authority,
        COption::Some(m.market)
    );
}

#[test]
fn r13_non_admin_cannot_add_strike() {
    let mut env = Env::initialized();
    env.set_time(T_CLOSE - 3600);
    let args = env.market_args("AAPL", STRIKE);
    let m = MarketKeys::derive(args.ticker, DAY, STRIKE);
    for signer in [
        env.automation.insecure_clone(),
        env.upgrade_authority.insecure_clone(),
        Keypair::new(),
    ] {
        env.svm.airdrop(&signer.pubkey(), 10_000_000_000).unwrap();
        let ix = env.ix_add_strike(&signer.pubkey(), args);
        assert_meridian_err(env.send_one(ix, &signer), MeridianError::Unauthorized);
        assert_market_absent(&env, &m);
    }
}

#[test]
fn r13_add_strike_at_or_after_close_fails() {
    let mut env = Env::initialized();
    let admin = env.admin.insecure_clone();
    for (i, t) in [T_CLOSE, T_CLOSE + 1, T_CLOSE + 86_400]
        .into_iter()
        .enumerate()
    {
        env.set_time(t);
        let strike = STRIKE + (i as i64 + 1) * 1_000;
        let args = env.market_args("AAPL", strike);
        let ix = env.ix_add_strike(&admin.pubkey(), args);
        assert_meridian_err(env.send_one(ix, &admin), MeridianError::MarketClosed);
        assert_market_absent(&env, &MarketKeys::derive(args.ticker, DAY, strike));
    }
}

#[test]
fn r13_add_strike_unknown_ticker_fails() {
    let mut env = Env::initialized();
    let args = env.market_args("IBM", 10_000);
    let admin = env.admin.insecure_clone();
    let ix = env.ix_add_strike(&admin.pubkey(), args);
    assert_meridian_err(env.send_one(ix, &admin), MeridianError::UnknownTicker);
}

// ---- R7 ----------------------------------------------------------------------------------------

#[test]
fn r7_nobody_can_mint_yes_or_no_outside_meridian() {
    let mut env = Env::initialized();
    let m = env.create_market(STRIKE);
    let user = env.new_user(&m, 0);
    for (mint, dest) in [(m.yes_mint, user.yes), (m.no_mint, user.no)] {
        let ix = spl_token_interface::instruction::mint_to(
            &spl_token_interface::ID,
            &mint,
            &dest,
            &user.pubkey(),
            &[],
            1_000_000,
        )
        .unwrap();
        assert_failed(env.send_one(ix, &user.kp));
        assert_eq!(env.supply(&mint), 0);
    }
}
