//! Order book helpers on top of `common`: instruction builders, book and seat readers,
//! `OrderFilled` decoding and the escrow conservation check.
#![allow(dead_code, clippy::result_large_err)]

use crate::common::*;
use anchor_lang::event::EVENT_IX_TAG_LE;
use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas};
use litesvm::types::{TransactionMetadata, TransactionResult};
use meridian::events::OrderFilled;
use meridian::state::*;

pub use meridian::state::{OrderKind, Side};

pub const COMPUTE_BUDGET_PROGRAM: Pubkey =
    anchor_lang::pubkey!("ComputeBudget111111111111111111111111111111");

/// USDC base units for `qty` whole tokens at `price` cents.
pub fn usdc_at(price: u8, qty: u64) -> u64 {
    price as u64 * qty * USDC_PER_CENT
}

pub fn event_authority() -> Pubkey {
    Pubkey::find_program_address(&[b"__event_authority"], &meridian::ID).0
}

/// `SetComputeUnitLimit(units)`, built by hand to avoid another dependency.
pub fn ix_compute_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction {
        program_id: COMPUTE_BUDGET_PROGRAM,
        accounts: vec![],
        data,
    }
}

/// A resting order with its seat resolved to the owner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Resting {
    pub order_id: u64,
    pub owner: Pubkey,
    pub price: u8,
    pub qty: u64,
}

/// The fields of one `OrderFilled` event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fill {
    pub market: Pubkey,
    pub maker: Pubkey,
    pub taker: Pubkey,
    pub maker_order_id: u64,
    pub taker_side: Side,
    pub price: u8,
    pub qty: u64,
    pub ts: i64,
}

/// Every `OrderFilled` emitted through `emit_cpi!` in the transaction, in order.
pub fn fills(meta: &TransactionMetadata) -> Vec<Fill> {
    let disc = OrderFilled::DISCRIMINATOR;
    let mut out = Vec::new();
    for inner in &meta.inner_instructions {
        for ix in inner {
            let data = &ix.instruction.data;
            let Some(rest) = data.strip_prefix(EVENT_IX_TAG_LE) else {
                continue;
            };
            let Some(mut body) = rest.strip_prefix(disc) else {
                continue;
            };
            let e = OrderFilled::deserialize(&mut body).expect("decode OrderFilled");
            out.push(Fill {
                market: e.market,
                maker: e.maker,
                taker: e.taker,
                maker_order_id: e.maker_order_id,
                taker_side: e.taker_side,
                price: e.price,
                qty: e.qty,
                ts: e.ts,
            });
        }
    }
    out
}

/// Initialized config, one AAPL market and the clock one minute after trading opens.
pub fn trading_setup() -> (Env, MarketKeys) {
    let mut env = Env::initialized();
    let m = env.create_market(STRIKE);
    env.set_time(T_TRADING_OPEN + 60);
    (env, m)
}

impl Env {
    /// A wallet with `usdc_whole` USDC and `yes_whole` Yes (and as many No), minted through
    /// `mint_pair`.
    pub fn trader(&mut self, m: &MarketKeys, usdc_whole: u64, yes_whole: u64) -> User {
        let user = self.new_user(m, usdc_whole + yes_whole);
        if yes_whole > 0 {
            assert_ok(self.mint_pair(&user, m, yes_whole));
        }
        user
    }

    pub fn ix_place_order(
        &self,
        user: &User,
        m: &MarketKeys,
        side: Side,
        kind: OrderKind,
        price: u8,
        qty: u64,
    ) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::PlaceOrder {
                owner: user.pubkey(),
                config: config_pda(),
                market: m.market,
                book: m.book,
                yes_escrow: m.yes_escrow,
                usdc_escrow: m.usdc_escrow,
                user_usdc: user.usdc,
                user_yes: user.yes,
                token_program: spl_token_interface::ID,
                event_authority: event_authority(),
                program: meridian::ID,
            }
            .to_account_metas(None),
            data: meridian::instruction::PlaceOrder {
                side,
                kind,
                price,
                qty,
            }
            .data(),
        }
    }

    pub fn place(
        &mut self,
        user: &User,
        m: &MarketKeys,
        side: Side,
        kind: OrderKind,
        price: u8,
        qty: u64,
    ) -> TransactionResult {
        let ix = self.ix_place_order(user, m, side, kind, price, qty);
        self.send_one(ix, &user.kp)
    }

    /// Places a limit order that must succeed, and returns its fills.
    pub fn limit(
        &mut self,
        user: &User,
        m: &MarketKeys,
        side: Side,
        price: u8,
        qty: u64,
    ) -> Vec<Fill> {
        fills(&assert_ok(self.place(
            user,
            m,
            side,
            OrderKind::Limit,
            price,
            qty,
        )))
    }

    pub fn ix_cancel_order(&self, user: &User, m: &MarketKeys, order_id: u64) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::CancelOrder {
                owner: user.pubkey(),
                market: m.market,
                book: m.book,
            }
            .to_account_metas(None),
            data: meridian::instruction::CancelOrder { order_id }.data(),
        }
    }

    pub fn cancel(&mut self, user: &User, m: &MarketKeys, order_id: u64) -> TransactionResult {
        let ix = self.ix_cancel_order(user, m, order_id);
        self.send_one(ix, &user.kp)
    }

    pub fn ix_settle_funds(&self, user: &User, m: &MarketKeys) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::SettleFunds {
                owner: user.pubkey(),
                market: m.market,
                book: m.book,
                yes_escrow: m.yes_escrow,
                usdc_escrow: m.usdc_escrow,
                user_yes: user.yes,
                user_usdc: user.usdc,
                token_program: spl_token_interface::ID,
            }
            .to_account_metas(None),
            data: meridian::instruction::SettleFunds {}.data(),
        }
    }

    pub fn settle_funds(&mut self, user: &User, m: &MarketKeys) -> TransactionResult {
        let ix = self.ix_settle_funds(user, m);
        self.send_one(ix, &user.kp)
    }

    pub fn book(&self, m: &MarketKeys) -> OrderBook {
        let data = self.raw(&m.book).data;
        let size = std::mem::size_of::<OrderBook>();
        assert!(
            data.len() >= 8 + size,
            "book account is {} bytes, expected {}",
            data.len(),
            8 + size
        );
        bytemuck::pod_read_unaligned(&data[8..8 + size])
    }

    /// Resting orders on one side, in array order (not priority order).
    pub fn resting(&self, m: &MarketKeys, side: Side) -> Vec<Resting> {
        let book = self.book(m);
        let orders = match side {
            Side::Bid => &book.bids,
            Side::Ask => &book.asks,
        };
        orders
            .iter()
            .filter(|o| o.qty > 0)
            .map(|o| Resting {
                order_id: o.order_id,
                owner: book.seats[o.seat as usize].owner,
                price: o.price,
                qty: o.qty,
            })
            .collect()
    }

    pub fn resting_of(&self, m: &MarketKeys, side: Side, owner: &Pubkey) -> Vec<Resting> {
        self.resting(m, side)
            .into_iter()
            .filter(|r| r.owner == *owner)
            .collect()
    }

    /// The single resting order of `owner` on `side`.
    pub fn order_id(&self, m: &MarketKeys, side: Side, owner: &Pubkey) -> u64 {
        let mine = self.resting_of(m, side, owner);
        assert_eq!(
            mine.len(),
            1,
            "expected one resting {side:?} for {owner}: {mine:?}"
        );
        mine[0].order_id
    }

    pub fn seat(&self, m: &MarketKeys, owner: &Pubkey) -> Option<OpenOrders> {
        self.book(m)
            .seats
            .iter()
            .find(|s| s.owner == *owner)
            .copied()
    }

    /// (free_yes, free_usdc) of `owner`'s seat, or zeros without one.
    pub fn free(&self, m: &MarketKeys, owner: &Pubkey) -> (u64, u64) {
        self.seat(m, owner)
            .map(|s| (s.free_yes, s.free_usdc))
            .unwrap_or((0, 0))
    }

    pub fn book_bytes(&self, m: &MarketKeys) -> Vec<u8> {
        self.raw(&m.book).data
    }

    /// The escrow vaults hold exactly the seats' free balances plus what resting orders lock:
    /// `price × qty` USDC per bid and `qty` Yes per ask.
    pub fn assert_escrow_backs_book(&self, m: &MarketKeys) {
        let book = self.book(m);
        let mut usdc: u64 = book.seats.iter().map(|s| s.free_usdc).sum();
        let mut yes: u64 = book.seats.iter().map(|s| s.free_yes).sum();
        for o in book.bids.iter().filter(|o| o.qty > 0) {
            usdc += usdc_at(o.price, o.qty);
        }
        for o in book.asks.iter().filter(|o| o.qty > 0) {
            yes += o.qty * UNIT;
        }
        assert_eq!(
            self.balance(&m.usdc_escrow),
            usdc,
            "USDC escrow == free + locked"
        );
        assert_eq!(
            self.balance(&m.yes_escrow),
            yes,
            "Yes escrow == free + locked"
        );
    }
}
