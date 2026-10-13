//! Order book matching: R16 placement and matching, R17 maker price, R20 self-trade, R53 fill
//! events naming both sides, R7 supply unchanged by the book.

mod common;
mod orderbook_support;

use common::*;
use meridian::errors::MeridianError;
use meridian::state::*;
use orderbook_support::*;

use OrderKind::{Limit, Market as Mkt, PostOnly};
use Side::{Ask, Bid};

// ---- R16 escrow and validation -----------------------------------------------------------------

#[test]
fn r16_bid_escrows_price_times_qty_usdc() {
    let (mut env, m) = trading_setup();
    let buyer = env.trader(&m, 10, 0);
    let before = env.balance(&buyer.usdc);

    assert!(env.limit(&buyer, &m, Bid, 65, 4).is_empty());

    assert_eq!(env.balance(&buyer.usdc), before - usdc_at(65, 4));
    assert_eq!(env.balance(&m.usdc_escrow), usdc_at(65, 4));
    assert_eq!(
        env.resting(&m, Bid),
        vec![Resting {
            order_id: env.order_id(&m, Bid, &buyer.pubkey()),
            owner: buyer.pubkey(),
            price: 65,
            qty: 4
        }]
    );
    assert_eq!(env.free(&m, &buyer.pubkey()), (0, 0));
    env.assert_escrow_backs_book(&m);
}

#[test]
fn r16_ask_escrows_qty_yes() {
    let (mut env, m) = trading_setup();
    let seller = env.trader(&m, 0, 5);

    assert!(env.limit(&seller, &m, Ask, 70, 3).is_empty());

    assert_eq!(env.balance(&seller.yes), 2 * UNIT);
    assert_eq!(env.balance(&m.yes_escrow), 3 * UNIT);
    assert_eq!(env.resting_of(&m, Ask, &seller.pubkey())[0].qty, 3);
    env.assert_escrow_backs_book(&m);
}

#[test]
fn r16_rejects_price_outside_1_to_99_and_zero_qty() {
    let (mut env, m) = trading_setup();
    let user = env.trader(&m, 10, 5);
    for (side, price) in [(Bid, 0), (Bid, 100), (Ask, 0), (Ask, 100)] {
        assert_meridian_err(
            env.place(&user, &m, side, Limit, price, 1),
            MeridianError::InvalidPrice,
        );
    }
    assert_meridian_err(
        env.place(&user, &m, Bid, Limit, 50, 0),
        MeridianError::ZeroAmount,
    );
    // The bounds themselves are valid prices.
    assert_ok(env.place(&user, &m, Bid, Limit, 1, 1));
    assert_ok(env.place(&user, &m, Ask, Limit, 99, 1));
}

// ---- R16 price-time priority -------------------------------------------------------------------

#[test]
fn r16_better_ask_fills_first_then_earlier_at_equal_price() {
    let (mut env, m) = trading_setup();
    let early = env.trader(&m, 0, 1);
    let late = env.trader(&m, 0, 1);
    let best = env.trader(&m, 0, 1);
    env.limit(&early, &m, Ask, 60, 1);
    env.limit(&late, &m, Ask, 60, 1);
    env.limit(&best, &m, Ask, 58, 1);
    let early_id = env.order_id(&m, Ask, &early.pubkey());
    let best_id = env.order_id(&m, Ask, &best.pubkey());

    let buyer = env.trader(&m, 10, 0);
    let f = env.limit(&buyer, &m, Bid, 60, 2);

    assert_eq!(f.len(), 2, "{f:?}");
    assert_eq!(
        (f[0].maker, f[0].maker_order_id, f[0].price),
        (best.pubkey(), best_id, 58)
    );
    assert_eq!(
        (f[1].maker, f[1].maker_order_id, f[1].price),
        (early.pubkey(), early_id, 60)
    );
    let left = env.resting(&m, Ask);
    assert_eq!(left.len(), 1);
    assert_eq!(
        (left[0].owner, left[0].price, left[0].qty),
        (late.pubkey(), 60, 1)
    );
    assert!(env.resting(&m, Bid).is_empty());
    env.assert_escrow_backs_book(&m);
}

#[test]
fn r16_better_bid_fills_first_then_earlier_at_equal_price() {
    let (mut env, m) = trading_setup();
    let early = env.trader(&m, 10, 0);
    let late = env.trader(&m, 10, 0);
    let best = env.trader(&m, 10, 0);
    env.limit(&early, &m, Bid, 40, 1);
    env.limit(&late, &m, Bid, 40, 1);
    env.limit(&best, &m, Bid, 42, 1);

    let seller = env.trader(&m, 0, 2);
    let f = env.limit(&seller, &m, Ask, 40, 2);

    assert_eq!(f.len(), 2, "{f:?}");
    assert_eq!((f[0].maker, f[0].price), (best.pubkey(), 42));
    assert_eq!((f[1].maker, f[1].price), (early.pubkey(), 40));
    let left = env.resting(&m, Bid);
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].owner, late.pubkey());
    env.assert_escrow_backs_book(&m);
}

// ---- R16 order kinds ---------------------------------------------------------------------------

#[test]
fn r16_limit_remainder_rests() {
    let (mut env, m) = trading_setup();
    let seller = env.trader(&m, 0, 2);
    env.limit(&seller, &m, Ask, 60, 2);
    let buyer = env.trader(&m, 10, 0);
    let usdc0 = env.balance(&buyer.usdc);

    let f = env.limit(&buyer, &m, Bid, 60, 5);

    assert_eq!(f.iter().map(|f| f.qty).sum::<u64>(), 2);
    assert!(env.resting(&m, Ask).is_empty());
    let mine = env.resting_of(&m, Bid, &buyer.pubkey());
    assert_eq!(mine.len(), 1);
    assert_eq!((mine[0].price, mine[0].qty), (60, 3));
    assert_eq!(env.balance(&buyer.usdc), usdc0 - usdc_at(60, 5));
    assert_eq!(env.free(&m, &buyer.pubkey()), (2 * UNIT, 0));
    env.assert_escrow_backs_book(&m);
}

#[test]
fn r16_market_order_never_rests_and_returns_unfilled_escrow() {
    let (mut env, m) = trading_setup();
    let seller = env.trader(&m, 0, 2);
    env.limit(&seller, &m, Ask, 60, 2);
    let buyer = env.trader(&m, 10, 0);
    let usdc0 = env.balance(&buyer.usdc);

    let f = fills(&assert_ok(env.place(&buyer, &m, Bid, Mkt, 65, 5)));

    assert_eq!(f.len(), 1);
    assert_eq!((f[0].price, f[0].qty), (60, 2));
    assert!(
        env.resting(&m, Bid).is_empty(),
        "a market order never rests"
    );
    // Everything not spent on the 2 filled tokens is back with the buyer (wallet or seat).
    let (free_yes, free_usdc) = env.free(&m, &buyer.pubkey());
    assert_eq!(env.balance(&buyer.usdc) + free_usdc, usdc0 - usdc_at(60, 2));
    assert_eq!(env.balance(&buyer.yes) + free_yes, 2 * UNIT);
    env.assert_escrow_backs_book(&m);

    assert_ok(env.settle_funds(&buyer, &m));
    assert_eq!(env.balance(&buyer.usdc), usdc0 - usdc_at(60, 2));
    assert_eq!(env.balance(&buyer.yes), 2 * UNIT);
}

#[test]
fn r16_market_sell_on_empty_book_returns_everything() {
    let (mut env, m) = trading_setup();
    let seller = env.trader(&m, 0, 3);

    let f = fills(&assert_ok(env.place(&seller, &m, Ask, Mkt, 1, 3)));

    assert!(f.is_empty());
    assert!(env.resting(&m, Ask).is_empty());
    let (free_yes, _) = env.free(&m, &seller.pubkey());
    assert_eq!(env.balance(&seller.yes) + free_yes, 3 * UNIT);
    assert_ok(env.settle_funds(&seller, &m));
    assert_eq!(env.balance(&seller.yes), 3 * UNIT);
    assert_eq!(env.balance(&m.yes_escrow), 0);
}

#[test]
fn r16_post_only_that_would_cross_is_rejected() {
    let (mut env, m) = trading_setup();
    let seller = env.trader(&m, 0, 1);
    env.limit(&seller, &m, Ask, 60, 1);
    let buyer = env.trader(&m, 10, 0);
    let book0 = env.book_bytes(&m);
    let usdc0 = env.balance(&buyer.usdc);

    for price in [60, 75] {
        assert_meridian_err(
            env.place(&buyer, &m, Bid, PostOnly, price, 1),
            MeridianError::PostOnlyWouldCross,
        );
    }
    assert_eq!(env.book_bytes(&m), book0, "book unchanged");
    assert_eq!(env.balance(&buyer.usdc), usdc0);

    // Just below the best ask it rests.
    assert!(fills(&assert_ok(env.place(&buyer, &m, Bid, PostOnly, 59, 1))).is_empty());
    assert_eq!(env.resting_of(&m, Bid, &buyer.pubkey())[0].price, 59);
    env.assert_escrow_backs_book(&m);
}

// ---- R16 seats and settle_funds ----------------------------------------------------------------

#[test]
fn r16_fills_credit_both_seats_and_settle_funds_withdraws() {
    let (mut env, m) = trading_setup();
    let seller = env.trader(&m, 0, 4);
    let buyer = env.trader(&m, 10, 0);
    env.limit(&seller, &m, Ask, 55, 4);
    let seller_usdc0 = env.balance(&seller.usdc);
    let buyer_usdc0 = env.balance(&buyer.usdc);

    env.limit(&buyer, &m, Bid, 55, 3);

    assert_eq!(env.free(&m, &seller.pubkey()), (0, usdc_at(55, 3)));
    assert_eq!(env.free(&m, &buyer.pubkey()), (3 * UNIT, 0));
    env.assert_escrow_backs_book(&m);

    assert_ok(env.settle_funds(&seller, &m));
    assert_ok(env.settle_funds(&buyer, &m));

    assert_eq!(env.balance(&seller.usdc), seller_usdc0 + usdc_at(55, 3));
    assert_eq!(
        env.balance(&seller.yes),
        0,
        "1 Yes still locked in the resting ask"
    );
    assert_eq!(env.balance(&buyer.yes), 3 * UNIT);
    assert_eq!(env.balance(&buyer.usdc), buyer_usdc0 - usdc_at(55, 3));
    assert_eq!(env.free(&m, &seller.pubkey()), (0, 0));
    assert_eq!(env.free(&m, &buyer.pubkey()), (0, 0));
    assert_eq!(env.balance(&m.yes_escrow), UNIT);
    assert_eq!(env.balance(&m.usdc_escrow), 0);
    env.assert_escrow_backs_book(&m);
}

#[test]
fn r16_settle_funds_releases_an_empty_seat_but_keeps_one_with_resting_orders() {
    let (mut env, m) = trading_setup();
    let seller = env.trader(&m, 0, 2);
    let buyer = env.trader(&m, 10, 0);
    env.limit(&seller, &m, Ask, 50, 2);
    env.limit(&buyer, &m, Bid, 50, 2);

    assert_ok(env.settle_funds(&buyer, &m));
    assert!(
        env.seat(&m, &buyer.pubkey()).is_none(),
        "empty seat released"
    );

    let resting = env.trader(&m, 10, 0);
    env.limit(&resting, &m, Bid, 10, 1);
    assert_ok(env.settle_funds(&resting, &m));
    assert!(
        env.seat(&m, &resting.pubkey()).is_some(),
        "a seat with a resting order is kept"
    );
}

// ---- R17 maker price ---------------------------------------------------------------------------

#[test]
fn r17_bid_at_70_against_ask_at_60_fills_at_60_and_refunds_10_cents_per_token() {
    let (mut env, m) = trading_setup();
    let seller = env.trader(&m, 0, 3);
    env.limit(&seller, &m, Ask, 60, 3);
    let buyer = env.trader(&m, 10, 0);
    let usdc0 = env.balance(&buyer.usdc);

    let f = env.limit(&buyer, &m, Bid, 70, 3);

    assert_eq!(f.len(), 1);
    assert_eq!((f[0].price, f[0].qty), (60, 3));
    // The taker escrowed 70¢ × 3 and gets the unused 10¢ × 3 back in its free balance.
    assert_eq!(env.balance(&buyer.usdc), usdc0 - usdc_at(70, 3));
    assert_eq!(env.free(&m, &buyer.pubkey()), (3 * UNIT, usdc_at(10, 3)));
    assert_eq!(env.free(&m, &seller.pubkey()), (0, usdc_at(60, 3)));
    assert!(env.resting(&m, Bid).is_empty());
    env.assert_escrow_backs_book(&m);

    assert_ok(env.settle_funds(&buyer, &m));
    assert_eq!(env.balance(&buyer.usdc), usdc0 - usdc_at(60, 3));
    assert_eq!(env.balance(&buyer.yes), 3 * UNIT);
}

#[test]
fn r17_ask_at_50_against_bid_at_70_fills_at_70() {
    let (mut env, m) = trading_setup();
    let buyer = env.trader(&m, 10, 0);
    env.limit(&buyer, &m, Bid, 70, 2);
    let seller = env.trader(&m, 0, 2);

    let f = env.limit(&seller, &m, Ask, 50, 2);

    assert_eq!(f.len(), 1);
    assert_eq!((f[0].price, f[0].qty), (70, 2));
    assert_eq!(env.free(&m, &seller.pubkey()), (0, usdc_at(70, 2)));
    assert_eq!(env.free(&m, &buyer.pubkey()), (2 * UNIT, 0));
    env.assert_escrow_backs_book(&m);
}

// ---- R20 self-trade ----------------------------------------------------------------------------

#[test]
fn r20_self_trade_cancels_the_resting_order_returns_escrow_and_keeps_matching() {
    let (mut env, m) = trading_setup();
    let me = env.trader(&m, 10, 2);
    let other = env.trader(&m, 0, 1);
    env.limit(&me, &m, Ask, 60, 2);
    env.limit(&other, &m, Ask, 61, 1);
    let my_ask = env.order_id(&m, Ask, &me.pubkey());
    let usdc0 = env.balance(&me.usdc);

    let f = env.limit(&me, &m, Bid, 65, 2);

    assert!(
        f.iter().all(|f| f.maker != f.taker),
        "no fill against oneself: {f:?}"
    );
    assert_eq!(f.len(), 1, "{f:?}");
    assert_eq!(
        (f[0].maker, f[0].taker, f[0].price, f[0].qty),
        (other.pubkey(), me.pubkey(), 61, 1)
    );
    assert!(
        env.resting(&m, Ask).iter().all(|r| r.order_id != my_ask),
        "own resting ask cancelled"
    );
    assert!(env.resting(&m, Ask).is_empty());
    // The cancelled ask's 2 Yes and the 1 Yes bought are free; 1 token still bids at 65.
    let (free_yes, free_usdc) = env.free(&m, &me.pubkey());
    assert_eq!(free_yes, 3 * UNIT);
    assert_eq!(free_usdc, usdc_at(65 - 61, 1));
    assert_eq!(env.balance(&me.usdc), usdc0 - usdc_at(65, 2));
    let mine = env.resting_of(&m, Bid, &me.pubkey());
    assert_eq!(mine.len(), 1);
    assert_eq!((mine[0].price, mine[0].qty), (65, 1));
    env.assert_escrow_backs_book(&m);
}

// ---- R53 fill events ---------------------------------------------------------------------------

#[test]
fn r53_every_fill_emits_order_filled_naming_maker_and_taker() {
    let (mut env, m) = trading_setup();
    let maker_a = env.trader(&m, 0, 2);
    let maker_b = env.trader(&m, 0, 3);
    env.limit(&maker_a, &m, Ask, 52, 2);
    env.limit(&maker_b, &m, Ask, 54, 3);
    let id_a = env.order_id(&m, Ask, &maker_a.pubkey());
    let id_b = env.order_id(&m, Ask, &maker_b.pubkey());
    let taker = env.trader(&m, 10, 0);
    let now = env.now();

    // Only the taker signs; both makers are named in its transaction's events.
    let meta = assert_ok(env.place(&taker, &m, Bid, Mkt, 60, 4));
    let f = fills(&meta);

    let expect = |maker: &User, id, price, qty| Fill {
        market: m.market,
        maker: maker.pubkey(),
        taker: taker.pubkey(),
        maker_order_id: id,
        taker_side: Bid,
        price,
        qty,
        ts: now,
    };
    assert_eq!(
        f,
        vec![expect(&maker_a, id_a, 52, 2), expect(&maker_b, id_b, 54, 2)]
    );

    let seller = env.trader(&m, 0, 1);
    env.limit(&taker, &m, Bid, 45, 1);
    let bid_id = env.order_id(&m, Bid, &taker.pubkey());
    let f = env.limit(&seller, &m, Ask, 45, 1);
    assert_eq!(f.len(), 1);
    assert_eq!(
        (
            f[0].maker,
            f[0].taker,
            f[0].maker_order_id,
            f[0].taker_side,
            f[0].price,
            f[0].qty
        ),
        (taker.pubkey(), seller.pubkey(), bid_id, Ask, 45, 1)
    );
}

// ---- R7 supply -----------------------------------------------------------------------------------

#[test]
fn r7_matching_cancel_and_settle_funds_never_change_supply() {
    let (mut env, m) = trading_setup();
    let a = env.trader(&m, 10, 10);
    let b = env.trader(&m, 10, 0);
    let c = env.trader(&m, 10, 0);
    let yes0 = env.supply(&m.yes_mint);
    let no0 = env.supply(&m.no_mint);
    let vault0 = env.balance(&m.vault);
    let market0 = env.market(&m);
    assert_eq!(yes0, 10 * UNIT);

    let check = |env: &Env, step: &str| {
        assert_eq!(env.supply(&m.yes_mint), yes0, "Yes supply after {step}");
        assert_eq!(env.supply(&m.no_mint), no0, "No supply after {step}");
        assert_eq!(
            env.balance(&m.vault),
            vault0,
            "collateral vault after {step}"
        );
        let market = env.market(&m);
        assert_eq!(
            market.collateral, market0.collateral,
            "collateral after {step}"
        );
        assert_eq!(market.pairs_outstanding, market0.pairs_outstanding);
        assert_eq!(
            env.mint(&m.yes_mint).mint_authority,
            env.mint(&m.no_mint).mint_authority
        );
        env.assert_escrow_backs_book(&m);
    };

    env.limit(&a, &m, Ask, 60, 5);
    check(&env, "ask 5 @ 60");
    env.limit(&a, &m, Ask, 62, 3);
    check(&env, "ask 3 @ 62");
    let f = env.limit(&b, &m, Bid, 61, 4);
    assert_eq!(f.len(), 1);
    check(&env, "bid 4 @ 61");
    let f = fills(&assert_ok(env.place(&c, &m, Bid, Mkt, 65, 10)));
    assert_eq!(f.iter().map(|f| f.qty).sum::<u64>(), 4);
    check(&env, "market bid 10 @ 65");
    env.limit(&a, &m, Ask, 70, 2);
    let id = env.order_id(&m, Ask, &a.pubkey());
    assert_ok(env.cancel(&a, &m, id));
    check(&env, "cancel ask");
    env.limit(&b, &m, Bid, 30, 1);
    let id = env.order_id(&m, Bid, &b.pubkey());
    assert_ok(env.cancel(&b, &m, id));
    check(&env, "cancel bid");
    for u in [&a, &b, &c] {
        assert_ok(env.settle_funds(u, &m));
        check(&env, "settle_funds");
    }
    assert_eq!(env.balance(&m.yes_escrow), 0);
    assert_eq!(env.balance(&m.usdc_escrow), 0);
    assert_eq!(
        env.balance(&a.yes) + env.balance(&b.yes) + env.balance(&c.yes),
        yes0
    );
}
