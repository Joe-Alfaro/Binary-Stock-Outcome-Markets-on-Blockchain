//! The four trade paths as single transactions (ARCHITECTURE.md §3.4): R23 Buy Yes, R24 Sell Yes,
//! R25 Buy No, R26 Sell No and R27 one signature from a fresh wallet within 1232 bytes and the
//! compute budget. Each path is built here exactly as the SDK builds it, including the idempotent
//! associated-token-account creation a fresh wallet needs, and the merge that ends market Buy No
//! and Sell No is `merge_pair_up_to(max_n, keep_yes)` (decision D18).

#![allow(clippy::result_large_err)]

mod common;
mod orderbook_support;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::{system_program, InstructionData};
use common::*;
use litesvm::types::{TransactionMetadata, TransactionResult};
use meridian::errors::MeridianError;
use meridian::state::*;
use orderbook_support::*;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_program_option::COption;
use solana_program_pack::Pack;
use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_token_interface::state::{Account as TokenAccount, AccountState};

use OrderKind::{Limit, Market as Mkt};
use Side::{Ask, Bid};

/// Solana's maximum serialized transaction size.
const MAX_TX_BYTES: usize = 1232;
/// The local validator's per-transaction compute ceiling.
const MAX_TX_COMPUTE_UNITS: u32 = 1_400_000;
const ATA_PROGRAM: Pubkey = anchor_lang::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// ---- associated token accounts -----------------------------------------------------------------

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

/// The associated token program's `CreateIdempotent`, built by hand to avoid another dependency.
fn ix_create_ata_idempotent(payer: &Pubkey, owner: &Pubkey, mint: &Pubkey) -> Instruction {
    Instruction {
        program_id: ATA_PROGRAM,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(ata(owner, mint), false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(spl_token_interface::ID, false),
        ],
        data: vec![1],
    }
}

// ---- wire size -----------------------------------------------------------------------------------

fn short_vec_len(n: usize) -> usize {
    match n {
        0..=0x7f => 1,
        0x80..=0x3fff => 2,
        _ => 3,
    }
}

/// Serialized size of a signed legacy transaction, as the cluster counts it against 1232 bytes.
fn wire_size(tx: &Transaction) -> usize {
    let msg = &tx.message;
    let ixs: usize = msg
        .instructions
        .iter()
        .map(|ix| {
            1 + short_vec_len(ix.accounts.len())
                + ix.accounts.len()
                + short_vec_len(ix.data.len())
                + ix.data.len()
        })
        .sum();
    short_vec_len(tx.signatures.len())
        + 64 * tx.signatures.len()
        + 3
        + short_vec_len(msg.account_keys.len())
        + 32 * msg.account_keys.len()
        + 32
        + short_vec_len(msg.instructions.len())
        + ixs
}

/// What one trade-path transaction produced.
struct Sent {
    result: TransactionResult,
    bytes: usize,
    signatures: usize,
}

impl Sent {
    /// Asserts R27 (one signature, at most 1232 bytes) and that the transaction succeeded.
    fn ok(self) -> TransactionMetadata {
        assert_eq!(self.signatures, 1, "one wallet signature");
        assert!(
            self.bytes <= MAX_TX_BYTES,
            "transaction is {} bytes",
            self.bytes
        );
        assert_ok(self.result)
    }
}

// ---- wallets ---------------------------------------------------------------------------------------

/// A wallet whose Yes, No and USDC fields are its associated token accounts.
fn ata_user(kp: Keypair, usdc_mint: &Pubkey, m: &MarketKeys) -> User {
    let owner = kp.pubkey();
    User {
        usdc: ata(&owner, usdc_mint),
        yes: ata(&owner, &m.yes_mint),
        no: ata(&owner, &m.no_mint),
        kp,
    }
}

impl Env {
    fn put_token_account(&mut self, key: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64) {
        let acc = TokenAccount {
            mint,
            owner,
            amount,
            delegate: COption::None,
            state: AccountState::Initialized,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        };
        let mut data = vec![0u8; TokenAccount::LEN];
        TokenAccount::pack(acc, &mut data).unwrap();
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                key,
                Account {
                    lamports,
                    data,
                    owner: spl_token_interface::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }

    /// A fresh wallet (R27): SOL for fees and rent, a USDC associated token account holding
    /// `usdc_base` base units, no Yes or No account and no seat in the book.
    fn fresh(&mut self, m: &MarketKeys, usdc_base: u64) -> User {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
        let user = ata_user(kp, &self.usdc_mint.clone(), m);
        self.put_token_account(user.usdc, self.usdc_mint, user.pubkey(), usdc_base);
        self.assert_fresh(m, &user);
        user
    }

    /// A wallet with no seat and a single token account, holding `qty` whole tokens of
    /// `token_mint` that another wallet minted and transferred to it (so supply stays backed).
    fn fresh_holding(&mut self, m: &MarketKeys, token_mint: Pubkey, qty: u64) -> User {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
        let user = ata_user(kp, &self.usdc_mint.clone(), m);
        let source = self.trader(m, 0, qty);
        let (from, to) = if token_mint == m.yes_mint {
            (source.yes, user.yes)
        } else {
            (source.no, user.no)
        };
        self.put_token_account(to, token_mint, user.pubkey(), 0);
        assert_ok(self.token_transfer(&from, &to, &source.kp, qty * UNIT));
        user
    }

    fn assert_fresh(&self, m: &MarketKeys, user: &User) {
        assert!(!self.exists(&user.yes), "fresh wallet has no Yes account");
        assert!(!self.exists(&user.no), "fresh wallet has no No account");
        assert!(
            self.seat(m, &user.pubkey()).is_none(),
            "fresh wallet has no seat"
        );
    }

    fn ix_merge_pair_up_to(
        &self,
        user: &User,
        m: &MarketKeys,
        max_n: u64,
        keep_yes: u64,
    ) -> Instruction {
        let mut ix = self.ix_merge_pair(user, m, 1);
        ix.data = meridian::instruction::MergePairUpTo { max_n, keep_yes }.data();
        ix
    }

    // ---- the four paths (§3.4) -------------------------------------------------------------------

    fn buy_yes_ixs(
        &self,
        u: &User,
        m: &MarketKeys,
        kind: OrderKind,
        price: u8,
        qty: u64,
    ) -> Vec<Instruction> {
        let me = u.pubkey();
        vec![
            ix_compute_limit(MAX_TX_COMPUTE_UNITS),
            ix_create_ata_idempotent(&me, &me, &m.yes_mint),
            self.ix_place_order(u, m, Bid, kind, price, qty),
            self.ix_settle_funds(u, m),
        ]
    }

    fn sell_yes_ixs(
        &self,
        u: &User,
        m: &MarketKeys,
        kind: OrderKind,
        price: u8,
        qty: u64,
    ) -> Vec<Instruction> {
        let me = u.pubkey();
        vec![
            ix_compute_limit(MAX_TX_COMPUTE_UNITS),
            ix_create_ata_idempotent(&me, &me, &self.usdc_mint),
            self.ix_place_order(u, m, Ask, kind, price, qty),
            self.ix_settle_funds(u, m),
        ]
    }

    /// Mint `qty` pairs, sell the Yes at `100 − no_price` or better, settle, and for a market
    /// order merge back whatever Yes didn't sell.
    fn buy_no_ixs(
        &self,
        u: &User,
        m: &MarketKeys,
        kind: OrderKind,
        no_price: u8,
        qty: u64,
        keep_yes: u64,
    ) -> Vec<Instruction> {
        let me = u.pubkey();
        let mut ixs = vec![
            ix_compute_limit(MAX_TX_COMPUTE_UNITS),
            ix_create_ata_idempotent(&me, &me, &m.yes_mint),
            ix_create_ata_idempotent(&me, &me, &m.no_mint),
            self.ix_mint_pair(u, m, qty),
            self.ix_place_order(u, m, Ask, kind, 100 - no_price, qty),
            self.ix_settle_funds(u, m),
        ];
        if kind == Mkt {
            ixs.push(self.ix_merge_pair_up_to(u, m, qty, keep_yes));
        }
        ixs
    }

    /// Buy Yes at `100 − no_price` or better, settle, then merge the Yes it bought with No.
    fn sell_no_ixs(
        &self,
        u: &User,
        m: &MarketKeys,
        no_price: u8,
        qty: u64,
        keep_yes: u64,
    ) -> Vec<Instruction> {
        let me = u.pubkey();
        vec![
            ix_compute_limit(MAX_TX_COMPUTE_UNITS),
            ix_create_ata_idempotent(&me, &me, &m.yes_mint),
            self.ix_place_order(u, m, Bid, Mkt, 100 - no_price, qty),
            self.ix_settle_funds(u, m),
            self.ix_merge_pair_up_to(u, m, qty, keep_yes),
        ]
    }

    /// Signs with the wallet alone, as a browser wallet would, and records the wire size.
    fn send_path(&mut self, ixs: &[Instruction], user: &User) -> Sent {
        self.svm.expire_blockhash();
        let tx = Transaction::new_signed_with_payer(
            ixs,
            Some(&user.pubkey()),
            &[&user.kp],
            self.svm.latest_blockhash(),
        );
        let bytes = wire_size(&tx);
        let signatures = tx.message.header.num_required_signatures as usize;
        Sent {
            result: self.svm.send_transaction(tx),
            bytes,
            signatures,
        }
    }

    /// Wallet balances in base units, treating a missing account as 0.
    fn held(&self, key: &Pubkey) -> u64 {
        if self.exists(key) {
            self.balance(key)
        } else {
            0
        }
    }

    fn assert_never_both(&self, user: &User) {
        let (yes, no) = (self.held(&user.yes), self.held(&user.no));
        assert!(
            yes == 0 || no == 0,
            "wallet ends holding both Yes ({yes}) and No ({no})"
        );
    }
}

/// A new maker with a resting limit order of `qty` at `price` on `side`.
fn with_maker(env: &mut Env, m: &MarketKeys, side: Side, price: u8, qty: u64) -> User {
    let maker = match side {
        Bid => env.trader(m, 100, 0),
        Ask => env.trader(m, 0, qty),
    };
    env.limit(&maker, m, side, price, qty);
    maker
}

// ---- R23 Buy Yes ---------------------------------------------------------------------------------

#[test]
fn r23_market_buy_yes_from_a_fresh_wallet_is_one_signature_and_lands_yes_in_the_wallet() {
    let (mut env, m) = trading_setup();
    with_maker(&mut env, &m, Ask, 60, 5);
    let buyer = env.fresh(&m, 10 * UNIT);

    let ixs = env.buy_yes_ixs(&buyer, &m, Mkt, 65, 3);
    env.send_path(&ixs, &buyer).ok();

    assert_eq!(env.balance(&buyer.yes), 3 * UNIT);
    // Fills at the maker's 60, and the unused 5¢ per token comes back through settle_funds.
    assert_eq!(env.balance(&buyer.usdc), 10 * UNIT - usdc_at(60, 3));
    assert_eq!(env.free(&m, &buyer.pubkey()), (0, 0));
    assert!(env.resting_of(&m, Bid, &buyer.pubkey()).is_empty());
    env.assert_escrow_backs_book(&m);
}

#[test]
fn r23_limit_buy_yes_fills_what_crosses_and_rests_the_rest() {
    let (mut env, m) = trading_setup();
    with_maker(&mut env, &m, Ask, 60, 2);
    let buyer = env.fresh(&m, 10 * UNIT);

    let ixs = env.buy_yes_ixs(&buyer, &m, Limit, 62, 5);
    env.send_path(&ixs, &buyer).ok();

    assert_eq!(env.balance(&buyer.yes), 2 * UNIT);
    assert_eq!(
        env.balance(&buyer.usdc),
        10 * UNIT - usdc_at(60, 2) - usdc_at(62, 3)
    );
    let resting = env.resting_of(&m, Bid, &buyer.pubkey());
    assert_eq!(resting.len(), 1);
    assert_eq!((resting[0].price, resting[0].qty), (62, 3));
    env.assert_escrow_backs_book(&m);
}

// ---- R24 Sell Yes --------------------------------------------------------------------------------

#[test]
fn r24_market_sell_yes_fills_now_at_the_best_bids_and_pays_usdc() {
    let (mut env, m) = trading_setup();
    with_maker(&mut env, &m, Bid, 55, 2);
    with_maker(&mut env, &m, Bid, 50, 2);
    // Holds Yes but has no USDC account and no seat yet.
    let seller = env.fresh_holding(&m, m.yes_mint, 3);
    assert!(!env.exists(&seller.usdc));

    let ixs = env.sell_yes_ixs(&seller, &m, Mkt, 50, 3);
    env.send_path(&ixs, &seller).ok();

    assert_eq!(env.balance(&seller.yes), 0);
    assert_eq!(env.balance(&seller.usdc), usdc_at(55, 2) + usdc_at(50, 1));
    assert_eq!(env.free(&m, &seller.pubkey()), (0, 0));
    env.assert_escrow_backs_book(&m);
}

#[test]
fn r24_market_sell_yes_never_fills_below_its_worst_price() {
    let (mut env, m) = trading_setup();
    with_maker(&mut env, &m, Bid, 40, 3);
    let seller = env.fresh_holding(&m, m.yes_mint, 3);

    let ixs = env.sell_yes_ixs(&seller, &m, Mkt, 45, 3);
    env.send_path(&ixs, &seller).ok();

    assert_eq!(env.balance(&seller.yes), 3 * UNIT, "unfilled Yes returns");
    assert_eq!(env.balance(&seller.usdc), 0);
    assert!(env.resting_of(&m, Ask, &seller.pubkey()).is_empty());
    assert_eq!(env.resting(&m, Bid)[0].qty, 3, "maker bid untouched");
}

#[test]
fn r24_limit_sell_yes_rests_on_the_ask_side() {
    let (mut env, m) = trading_setup();
    let seller = env.fresh_holding(&m, m.yes_mint, 3);

    let ixs = env.sell_yes_ixs(&seller, &m, Limit, 70, 3);
    env.send_path(&ixs, &seller).ok();

    assert_eq!(env.balance(&seller.yes), 0);
    let resting = env.resting_of(&m, Ask, &seller.pubkey());
    assert_eq!(resting.len(), 1);
    assert_eq!((resting[0].price, resting[0].qty), (70, 3));
    env.assert_escrow_backs_book(&m);
}

// ---- R25 Buy No ----------------------------------------------------------------------------------

#[test]
fn r25_market_buy_no_costs_exactly_one_dollar_minus_the_yes_sale_price() {
    let (mut env, m) = trading_setup();
    with_maker(&mut env, &m, Bid, 40, 5);
    let buyer = env.fresh(&m, 10 * UNIT);

    let ixs = env.buy_no_ixs(&buyer, &m, Mkt, 60, 5, 0);
    env.send_path(&ixs, &buyer).ok();

    assert_eq!(env.balance(&buyer.no), 5 * UNIT);
    assert_eq!(env.balance(&buyer.yes), 0);
    assert_eq!(env.balance(&buyer.usdc), 10 * UNIT - usdc_at(60, 5));
    assert_eq!(env.market(&m).pairs_outstanding, 5);
    assert_eq!(env.free(&m, &buyer.pubkey()), (0, 0));
    env.assert_escrow_backs_book(&m);
}

#[test]
fn r25_market_buy_no_gets_the_better_bid_and_pays_one_dollar_minus_it() {
    let (mut env, m) = trading_setup();
    with_maker(&mut env, &m, Bid, 45, 4);
    let buyer = env.fresh(&m, 10 * UNIT);

    // Worst Yes price 40, but the bid is 45, so No costs 55¢, not 60¢.
    let ixs = env.buy_no_ixs(&buyer, &m, Mkt, 60, 4, 0);
    env.send_path(&ixs, &buyer).ok();

    assert_eq!(env.balance(&buyer.no), 4 * UNIT);
    assert_eq!(env.balance(&buyer.usdc), 10 * UNIT - usdc_at(55, 4));
}

#[test]
fn r25_partial_market_buy_no_merges_the_unfilled_pairs_in_the_same_transaction() {
    let (mut env, m) = trading_setup();
    with_maker(&mut env, &m, Bid, 40, 2);
    let buyer = env.fresh(&m, 10 * UNIT);

    let ixs = env.buy_no_ixs(&buyer, &m, Mkt, 60, 5, 0);
    env.send_path(&ixs, &buyer).ok();

    // No for the 2 filled, USDC back for the 3 unfilled, never a leftover pair.
    assert_eq!(env.balance(&buyer.no), 2 * UNIT);
    assert_eq!(env.balance(&buyer.yes), 0);
    assert_eq!(env.balance(&buyer.usdc), 10 * UNIT - usdc_at(60, 2));
    env.assert_never_both(&buyer);
    let market = env.market(&m);
    assert_eq!(market.pairs_outstanding, 2);
    assert_eq!(market.collateral, 2 * UNIT);
    assert_eq!(env.free(&m, &buyer.pubkey()), (0, 0));
    assert!(env.resting_of(&m, Ask, &buyer.pubkey()).is_empty());
    env.assert_escrow_backs_book(&m);
}

#[test]
fn r25_partial_market_buy_no_across_levels_stops_at_the_worst_price() {
    let (mut env, m) = trading_setup();
    with_maker(&mut env, &m, Bid, 45, 2);
    with_maker(&mut env, &m, Bid, 40, 2);
    with_maker(&mut env, &m, Bid, 30, 5);
    let buyer = env.fresh(&m, 10 * UNIT);

    let ixs = env.buy_no_ixs(&buyer, &m, Mkt, 60, 5, 0);
    env.send_path(&ixs, &buyer).ok();

    assert_eq!(env.balance(&buyer.no), 4 * UNIT);
    assert_eq!(env.balance(&buyer.yes), 0);
    assert_eq!(
        env.balance(&buyer.usdc),
        10 * UNIT - usdc_at(55, 2) - usdc_at(60, 2)
    );
    assert_eq!(env.resting(&m, Bid).len(), 1, "the 30¢ bid is untouched");
}

#[test]
fn r25_market_buy_no_worst_price_is_enforced_on_chain() {
    let (mut env, m) = trading_setup();
    with_maker(&mut env, &m, Bid, 35, 5);
    let buyer = env.fresh(&m, 10 * UNIT);

    // No at 60 means Yes must sell at 40 or better; the only bid is 35.
    let ixs = env.buy_no_ixs(&buyer, &m, Mkt, 60, 5, 0);
    env.send_path(&ixs, &buyer).ok();

    assert_eq!(env.balance(&buyer.usdc), 10 * UNIT);
    assert_eq!(env.balance(&buyer.yes), 0);
    assert_eq!(env.balance(&buyer.no), 0);
    assert_eq!(env.resting(&m, Bid)[0].qty, 5);
    assert_eq!(env.market(&m).pairs_outstanding, 0);
}

#[test]
fn r25_limit_buy_no_holds_no_and_rests_the_yes_ask_until_it_fills() {
    let (mut env, m) = trading_setup();
    let buyer = env.fresh(&m, 10 * UNIT);

    let ixs = env.buy_no_ixs(&buyer, &m, Limit, 60, 3, 0);
    env.send_path(&ixs, &buyer).ok();

    assert_eq!(env.balance(&buyer.no), 3 * UNIT);
    assert_eq!(env.balance(&buyer.usdc), 7 * UNIT);
    let resting = env.resting_of(&m, Ask, &buyer.pubkey());
    assert_eq!((resting[0].price, resting[0].qty), (40, 3));

    // A Yes buyer takes the ask; after settling, the No cost exactly 60¢.
    let taker = env.trader(&m, 10, 0);
    assert_ok(env.place(&taker, &m, Bid, Mkt, 40, 3));
    assert_ok(env.settle_funds(&buyer, &m));
    assert_eq!(env.balance(&buyer.usdc), 10 * UNIT - usdc_at(60, 3));
    assert_eq!(env.balance(&buyer.no), 3 * UNIT);
    assert_eq!(env.balance(&buyer.yes), 0);
}

// ---- R26 Sell No ---------------------------------------------------------------------------------

#[test]
fn r26_market_sell_no_pays_one_dollar_minus_the_yes_buy_price() {
    let (mut env, m) = trading_setup();
    with_maker(&mut env, &m, Ask, 30, 4);
    let seller = env.fresh_holding(&m, m.no_mint, 4);
    // USDC to escrow the Yes bid; the wallet has no Yes account and no seat.
    env.put_token_account(seller.usdc, env.usdc_mint, seller.pubkey(), 2 * UNIT);

    let ixs = env.sell_no_ixs(&seller, &m, 65, 4, 0);
    env.send_path(&ixs, &seller).ok();

    assert_eq!(env.balance(&seller.no), 0);
    assert_eq!(env.balance(&seller.yes), 0);
    assert_eq!(env.balance(&seller.usdc), 2 * UNIT + usdc_at(70, 4));
    assert_eq!(env.free(&m, &seller.pubkey()), (0, 0));
    env.assert_escrow_backs_book(&m);
}

#[test]
fn r26_partial_sell_no_reduces_no_by_exactly_the_filled_quantity_and_leaves_no_yes() {
    let (mut env, m) = trading_setup();
    with_maker(&mut env, &m, Ask, 30, 2);
    let seller = env.fresh_holding(&m, m.no_mint, 5);
    env.put_token_account(seller.usdc, env.usdc_mint, seller.pubkey(), 2 * UNIT);
    let pairs_before = env.market(&m).pairs_outstanding;

    let ixs = env.sell_no_ixs(&seller, &m, 65, 5, 0);
    env.send_path(&ixs, &seller).ok();

    assert_eq!(env.balance(&seller.no), 3 * UNIT);
    assert_eq!(env.balance(&seller.yes), 0);
    assert_eq!(env.balance(&seller.usdc), 2 * UNIT + usdc_at(70, 2));
    assert_eq!(env.market(&m).pairs_outstanding, pairs_before - 2);
    assert!(env.resting_of(&m, Bid, &seller.pubkey()).is_empty());
    assert_eq!(env.free(&m, &seller.pubkey()), (0, 0));
    env.assert_escrow_backs_book(&m);
}

#[test]
fn r26_sell_no_worst_price_is_enforced_on_chain() {
    let (mut env, m) = trading_setup();
    with_maker(&mut env, &m, Ask, 40, 3);
    let seller = env.fresh_holding(&m, m.no_mint, 3);
    env.put_token_account(seller.usdc, env.usdc_mint, seller.pubkey(), 2 * UNIT);

    // No at 65 means Yes must cost 35 or less; the only ask is 40.
    let ixs = env.sell_no_ixs(&seller, &m, 65, 3, 0);
    env.send_path(&ixs, &seller).ok();

    assert_eq!(env.balance(&seller.no), 3 * UNIT);
    assert_eq!(env.balance(&seller.yes), 0);
    assert_eq!(env.balance(&seller.usdc), 2 * UNIT);
    assert_eq!(env.resting(&m, Ask)[0].qty, 3);
}

#[test]
fn r26_sell_no_merges_only_the_yes_this_transaction_bought() {
    let (mut env, m) = trading_setup();
    with_maker(&mut env, &m, Ask, 30, 3);
    // A wallet that already holds 2 Yes and 5 No.
    let seller = env.trader(&m, 2, 5);
    assert_ok(env.token_burn(&seller.yes, &m.yes_mint, &seller.kp, 3 * UNIT));
    let yes_before = 2 * UNIT;
    let usdc_before = env.balance(&seller.usdc);

    let ixs = env.sell_no_ixs(&seller, &m, 65, 3, yes_before);
    env.send_path(&ixs, &seller).ok();

    assert_eq!(env.balance(&seller.yes), yes_before, "pre-held Yes kept");
    assert_eq!(env.balance(&seller.no), 2 * UNIT);
    assert_eq!(env.balance(&seller.usdc), usdc_before + usdc_at(70, 3));
}

// ---- merge_pair_up_to (D18) ----------------------------------------------------------------------

fn merge_up_to(
    env: &mut Env,
    user: &User,
    m: &MarketKeys,
    max_n: u64,
    keep_yes: u64,
) -> TransactionResult {
    let ix = env.ix_merge_pair_up_to(user, m, max_n, keep_yes);
    env.send_one(ix, &user.kp)
}

#[test]
fn d18_merge_up_to_merges_the_smaller_of_new_yes_no_and_max() {
    let mut env = Env::initialized();
    let m = env.create_market(STRIKE);
    env.set_time(T_MINT_OPEN + 60);
    let user = env.trader(&m, 0, 5);
    // Holds 5 Yes and 5 No; burn 2 No so No is the smaller side.
    assert_ok(env.token_burn(&user.no, &m.no_mint, &user.kp, 2 * UNIT));

    // min((5 − 1) Yes, 3 No, 10) = 3
    assert_ok(merge_up_to(&mut env, &user, &m, 10, UNIT));

    assert_eq!(env.balance(&user.yes), 2 * UNIT);
    assert_eq!(env.balance(&user.no), 0);
    assert_eq!(env.balance(&user.usdc), 3 * UNIT);
    let market = env.market(&m);
    assert_eq!(market.pairs_outstanding, 2);
    assert_eq!(market.collateral, 2 * UNIT);
}

#[test]
fn d18_merge_up_to_is_capped_by_max_n_and_by_keep_yes() {
    let mut env = Env::initialized();
    let m = env.create_market(STRIKE);
    env.set_time(T_MINT_OPEN + 60);
    let user = env.trader(&m, 0, 6);

    assert_ok(merge_up_to(&mut env, &user, &m, 2, 0));
    assert_eq!(env.balance(&user.yes), 4 * UNIT);
    assert_eq!(env.balance(&user.no), 4 * UNIT);

    assert_ok(merge_up_to(&mut env, &user, &m, 10, 3 * UNIT));
    assert_eq!(env.balance(&user.yes), 3 * UNIT);
    assert_eq!(env.balance(&user.no), 3 * UNIT);
    assert_eq!(env.balance(&user.usdc), 3 * UNIT);
}

#[test]
fn d18_merge_up_to_of_zero_succeeds_without_moving_anything() {
    let mut env = Env::initialized();
    let m = env.create_market(STRIKE);
    env.set_time(T_MINT_OPEN + 60);
    let user = env.trader(&m, 0, 3);

    // keep_yes covers every Yes held, and even exceeds it.
    assert_ok(merge_up_to(&mut env, &user, &m, 3, 3 * UNIT));
    assert_ok(merge_up_to(&mut env, &user, &m, 3, 9 * UNIT));

    assert_eq!(env.balance(&user.yes), 3 * UNIT);
    assert_eq!(env.balance(&user.no), 3 * UNIT);
    assert_eq!(env.balance(&user.usdc), 0);
    assert_eq!(env.market(&m).pairs_outstanding, 3);
}

#[test]
fn d18_merge_up_to_works_while_paused_and_fails_after_settlement() {
    let mut env = Env::initialized();
    let m = env.create_market(STRIKE);
    env.set_time(T_MINT_OPEN + 60);
    let user = env.trader(&m, 0, 4);

    env.pause();
    assert_ok(merge_up_to(&mut env, &user, &m, 1, 0));
    assert_eq!(env.balance(&user.no), 3 * UNIT);
    env.unpause();

    env.force_settle(&m, Outcome::Yes);
    assert_meridian_err(
        merge_up_to(&mut env, &user, &m, 1, 0),
        MeridianError::MarketSettled,
    );
}

// ---- R27 fresh wallet, one signature, size and compute --------------------------------------------

#[test]
fn r27_each_path_from_a_fresh_wallet_creates_its_accounts_and_seat_in_one_transaction() {
    let (mut env, m) = trading_setup();
    with_maker(&mut env, &m, Ask, 50, 10);
    with_maker(&mut env, &m, Bid, 45, 10);

    let buy_yes = env.fresh(&m, 10 * UNIT);
    let ixs = env.buy_yes_ixs(&buy_yes, &m, Mkt, 50, 1);
    env.send_path(&ixs, &buy_yes).ok();
    assert!(env.exists(&buy_yes.yes));

    let buy_no = env.fresh(&m, 10 * UNIT);
    let ixs = env.buy_no_ixs(&buy_no, &m, Mkt, 55, 1, 0);
    env.send_path(&ixs, &buy_no).ok();
    assert!(env.exists(&buy_no.yes) && env.exists(&buy_no.no));

    let sell_yes = env.fresh_holding(&m, m.yes_mint, 1);
    let ixs = env.sell_yes_ixs(&sell_yes, &m, Mkt, 45, 1);
    env.send_path(&ixs, &sell_yes).ok();
    assert!(env.exists(&sell_yes.usdc));

    let sell_no = env.fresh_holding(&m, m.no_mint, 1);
    env.put_token_account(sell_no.usdc, env.usdc_mint, sell_no.pubkey(), UNIT);
    let ixs = env.sell_no_ixs(&sell_no, &m, 50, 1, 0);
    env.send_path(&ixs, &sell_no).ok();
    assert!(env.exists(&sell_no.yes));

    for user in [&buy_yes, &buy_no, &sell_yes, &sell_no] {
        env.assert_never_both(user);
    }
}

#[test]
fn r27_market_buy_no_sweeping_the_fill_cap_fits_size_and_compute() {
    let (mut env, m) = trading_setup();
    let n = MAX_FILLS_PER_ORDER as u64;
    for i in 0..n {
        with_maker(&mut env, &m, Bid, 60 - i as u8, 1);
    }
    let buyer = env.fresh(&m, 100 * UNIT);

    let ixs = env.buy_no_ixs(&buyer, &m, Mkt, 99, n, 0);
    let meta = env.send_path(&ixs, &buyer).ok();

    assert_eq!(fills(&meta).len(), n as usize);
    assert!(
        meta.compute_units_consumed < MAX_TX_COMPUTE_UNITS as u64,
        "{} compute units",
        meta.compute_units_consumed
    );
    assert_eq!(env.balance(&buyer.no), n * UNIT);
    assert_eq!(env.balance(&buyer.yes), 0);
}

#[test]
fn r27_sell_no_sweeping_the_fill_cap_fits_size_and_compute() {
    let (mut env, m) = trading_setup();
    let n = MAX_FILLS_PER_ORDER as u64;
    for i in 0..n {
        with_maker(&mut env, &m, Ask, 40 + i as u8, 1);
    }
    let seller = env.fresh_holding(&m, m.no_mint, n);
    env.put_token_account(seller.usdc, env.usdc_mint, seller.pubkey(), 100 * UNIT);

    let ixs = env.sell_no_ixs(&seller, &m, 1, n, 0);
    let meta = env.send_path(&ixs, &seller).ok();

    assert_eq!(fills(&meta).len(), n as usize);
    assert!(
        meta.compute_units_consumed < MAX_TX_COMPUTE_UNITS as u64,
        "{} compute units",
        meta.compute_units_consumed
    );
    assert_eq!(env.balance(&seller.no), 0);
    assert_eq!(env.balance(&seller.yes), 0);
}
