//! Order book cancel and trading window: R18 cancel, R21 trading window, R41 pause.

mod common;
mod orderbook_support;

use common::*;
use meridian::errors::MeridianError;
use meridian::state::*;
use orderbook_support::*;

use OrderKind::{Limit, Market as Mkt, PostOnly};
use Side::{Ask, Bid};

/// A bidder resting 3 @ 40 and an asker resting 2 @ 70.
fn resting_setup() -> (Env, MarketKeys, User, User) {
    let (mut env, m) = trading_setup();
    let bidder = env.trader(&m, 10, 0);
    let asker = env.trader(&m, 0, 2);
    env.limit(&bidder, &m, Bid, 40, 3);
    env.limit(&asker, &m, Ask, 70, 2);
    (env, m, bidder, asker)
}

fn assert_cancel_returns_escrow(env: &mut Env, m: &MarketKeys, bidder: &User, asker: &User) {
    let bid = env.order_id(m, Bid, &bidder.pubkey());
    let ask = env.order_id(m, Ask, &asker.pubkey());
    let wallets = (env.balance(&bidder.usdc), env.balance(&asker.yes));

    assert_ok(env.cancel(bidder, m, bid));
    assert_ok(env.cancel(asker, m, ask));

    assert!(env.resting(m, Bid).is_empty());
    assert!(env.resting(m, Ask).is_empty());
    assert_eq!(env.free(m, &bidder.pubkey()), (0, usdc_at(40, 3)));
    assert_eq!(env.free(m, &asker.pubkey()), (2 * UNIT, 0));
    // Cancel only moves escrow to the free balance; settle_funds pays it out.
    assert_eq!(
        (env.balance(&bidder.usdc), env.balance(&asker.yes)),
        wallets
    );
    env.assert_escrow_backs_book(m);

    assert_ok(env.settle_funds(bidder, m));
    assert_ok(env.settle_funds(asker, m));
    assert_eq!(env.balance(&bidder.usdc), wallets.0 + usdc_at(40, 3));
    assert_eq!(env.balance(&asker.yes), wallets.1 + 2 * UNIT);
}

// ---- R18 cancel --------------------------------------------------------------------------------

#[test]
fn r18_cancel_returns_bid_and_ask_escrow_to_free_balance() {
    let (mut env, m, bidder, asker) = resting_setup();
    assert_cancel_returns_escrow(&mut env, &m, &bidder, &asker);
}

#[test]
fn r18_cancel_of_a_partly_filled_order_returns_only_the_remainder() {
    let (mut env, m, bidder, _asker) = resting_setup();
    let seller = env.trader(&m, 0, 1);
    env.limit(&seller, &m, Ask, 40, 1);
    let bid = env.order_id(&m, Bid, &bidder.pubkey());

    assert_ok(env.cancel(&bidder, &m, bid));

    assert_eq!(env.free(&m, &bidder.pubkey()), (UNIT, usdc_at(40, 2)));
    env.assert_escrow_backs_book(&m);
}

#[test]
fn r18_non_owner_cancel_fails_and_leaves_the_book_unchanged() {
    let (mut env, m, bidder, asker) = resting_setup();
    let bid = env.order_id(&m, Bid, &bidder.pubkey());
    let stranger = env.trader(&m, 10, 0);
    let book0 = env.book_bytes(&m);

    // The asker has a seat; the stranger has none. Neither owns the bid.
    assert_meridian_err(env.cancel(&asker, &m, bid), MeridianError::Unauthorized);
    assert_meridian_err(env.cancel(&stranger, &m, bid), MeridianError::Unauthorized);

    assert_eq!(env.book_bytes(&m), book0);
    assert_eq!(env.resting_of(&m, Bid, &bidder.pubkey())[0].qty, 3);
}

#[test]
fn r18_cancel_of_an_unknown_order_fails() {
    let (mut env, m, bidder, _asker) = resting_setup();
    let bid = env.order_id(&m, Bid, &bidder.pubkey());
    assert_ok(env.cancel(&bidder, &m, bid));
    assert_meridian_err(env.cancel(&bidder, &m, bid), MeridianError::OrderNotFound);
    assert_meridian_err(
        env.cancel(&bidder, &m, u64::MAX),
        MeridianError::OrderNotFound,
    );
}

#[test]
fn r18_cancel_works_while_paused() {
    let (mut env, m, bidder, asker) = resting_setup();
    env.pause();
    assert_cancel_returns_escrow(&mut env, &m, &bidder, &asker);
}

#[test]
fn r18_cancel_works_after_close() {
    let (mut env, m, bidder, asker) = resting_setup();
    env.set_time(T_CLOSE + 3600);
    assert_cancel_returns_escrow(&mut env, &m, &bidder, &asker);
}

#[test]
fn r18_cancel_works_after_settlement() {
    let (mut env, m, bidder, asker) = resting_setup();
    env.set_time(T_CLOSE + 600);
    env.force_settle(&m, Outcome::Yes);
    assert_cancel_returns_escrow(&mut env, &m, &bidder, &asker);
}

// ---- R21 trading window ------------------------------------------------------------------------

#[test]
fn r21_place_order_fails_before_trading_open_and_works_from_it() {
    let mut env = Env::initialized();
    let m = env.create_market(STRIKE);
    env.set_time(T_MINT_OPEN + 60);
    let user = env.trader(&m, 10, 2);

    env.set_time(T_TRADING_OPEN - 1);
    for (side, kind) in [(Bid, Limit), (Ask, Mkt), (Bid, PostOnly)] {
        assert_meridian_err(
            env.place(&user, &m, side, kind, 50, 1),
            MeridianError::TradingNotOpen,
        );
    }
    env.set_time(T_TRADING_OPEN);
    assert_ok(env.place(&user, &m, Bid, Limit, 50, 1));
}

#[test]
fn r21_place_order_fails_at_and_after_close() {
    let (mut env, m) = trading_setup();
    let user = env.trader(&m, 10, 2);

    env.set_time(T_CLOSE - 1);
    assert_ok(env.place(&user, &m, Bid, Limit, 50, 1));
    for t in [T_CLOSE, T_CLOSE + 1, T_CLOSE + 86_400] {
        env.set_time(t);
        assert_meridian_err(
            env.place(&user, &m, Bid, Limit, 50, 1),
            MeridianError::MarketClosed,
        );
        assert_meridian_err(
            env.place(&user, &m, Ask, Mkt, 1, 1),
            MeridianError::MarketClosed,
        );
    }
}

#[test]
fn r21_r41_place_order_fails_while_paused_and_works_after_unpause() {
    let (mut env, m) = trading_setup();
    let user = env.trader(&m, 10, 2);
    env.pause();
    for (side, kind) in [(Bid, Limit), (Ask, Limit), (Bid, Mkt), (Ask, PostOnly)] {
        assert_meridian_err(
            env.place(&user, &m, side, kind, 50, 1),
            MeridianError::Paused,
        );
    }
    env.unpause();
    assert_ok(env.place(&user, &m, Bid, Limit, 50, 1));
}

// ---- R41 pause ---------------------------------------------------------------------------------

#[test]
fn r41_pause_blocks_place_order_but_cancel_and_settle_funds_still_work() {
    let (mut env, m, bidder, asker) = resting_setup();
    let buyer = env.trader(&m, 10, 0);
    env.limit(&buyer, &m, Bid, 75, 1);
    assert_eq!(env.free(&m, &buyer.pubkey()), (UNIT, usdc_at(5, 1)));
    let buyer_usdc = env.balance(&buyer.usdc);

    env.pause();
    assert_meridian_err(
        env.place(&bidder, &m, Bid, Limit, 41, 1),
        MeridianError::Paused,
    );

    assert_ok(env.settle_funds(&buyer, &m));
    assert_eq!(env.balance(&buyer.yes), UNIT);
    assert_eq!(env.balance(&buyer.usdc), buyer_usdc + usdc_at(5, 1));
    assert_ok(env.settle_funds(&asker, &m));
    assert_eq!(env.balance(&asker.usdc), usdc_at(70, 1));
    let bid = env.order_id(&m, Bid, &bidder.pubkey());
    assert_ok(env.cancel(&bidder, &m, bid));
    assert_ok(env.settle_funds(&bidder, &m));
    assert_eq!(env.balance(&bidder.usdc), 10 * UNIT);
}
