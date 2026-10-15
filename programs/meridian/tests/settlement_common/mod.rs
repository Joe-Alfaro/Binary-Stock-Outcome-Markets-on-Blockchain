//! Settlement helpers on top of `common`: `meridian_oracle` accounts, the settlement and redeem
//! instruction builders, and event decoding.
//!
//! Oracle accounts are written straight into LiteSVM with `meridian_oracle`'s own types, so a test
//! can build any record the relay could publish (and spoofs it couldn't). `load_oracle` deploys the
//! real oracle program for the end-to-end tests that publish through it.
#![allow(dead_code, clippy::result_large_err)]

use anchor_lang::__private::base64::{engine::general_purpose::STANDARD, Engine};
use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{
    AccountSerialize, AnchorDeserialize, Discriminator, InstructionData, Space, ToAccountMetas,
};
use litesvm::types::{TransactionMetadata, TransactionResult};
use meridian::state::*;
use meridian_oracle::{CloseRecord, CloseShape, LatestPrice, PriceInput, PriceUpdate, Session};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_signer::Signer;

use crate::common::*;

pub const ORACLE_SO: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/deploy/meridian_oracle.so"
);

/// Index of oracle slot 1 in `Config.oracle_slots`.
pub const SLOT_1: u8 = 0;
/// The settle transaction lands 12 minutes after close.
pub const T_SETTLE: i64 = T_CLOSE + 12 * 60;
/// 3:59:30 PM and 4:00:30 PM ET.
pub const T_BEFORE: i64 = T_CLOSE - 30;
pub const T_AFTER: i64 = T_CLOSE + 30;
/// Price exponent of every oracle price in these tests, the same as `STRIKE_EXPO`.
pub const EXPO: i32 = -2;
pub const PREV_DAY: u32 = 20261012;

/// A regular-session price of `price / 100` with a 1-cent confidence.
pub fn regular(price: i64, publish_time: i64) -> PriceInput {
    PriceInput {
        price,
        conf: 1,
        expo: EXPO,
        publish_time,
        session: Session::Regular,
        official_close: false,
    }
}

pub fn official(price: i64, publish_time: i64) -> PriceInput {
    PriceInput {
        official_close: true,
        ..regular(price, publish_time)
    }
}

pub fn close_pda(signer: &Pubkey, ticker: Ticker, trading_day: u32) -> Pubkey {
    Pubkey::find_program_address(
        &[
            meridian_oracle::CLOSE_SEED,
            signer.as_ref(),
            &ticker,
            &trading_day.to_le_bytes(),
        ],
        &meridian_oracle::ID,
    )
    .0
}

pub fn price_pda(signer: &Pubkey, ticker: Ticker, publish_time: i64) -> Pubkey {
    Pubkey::find_program_address(
        &[
            meridian_oracle::PRICE_SEED,
            signer.as_ref(),
            &ticker,
            &publish_time.to_le_bytes(),
        ],
        &meridian_oracle::ID,
    )
    .0
}

pub fn latest_pda(signer: &Pubkey, ticker: Ticker) -> Pubkey {
    Pubkey::find_program_address(
        &[meridian_oracle::LATEST_SEED, signer.as_ref(), &ticker],
        &meridian_oracle::ID,
    )
    .0
}

pub fn oracle_registry_pda() -> Pubkey {
    Pubkey::find_program_address(&[meridian_oracle::SIGNERS_SEED], &meridian_oracle::ID).0
}

/// Shape implied by the inputs, as `publish_close` would infer it.
pub fn shape_of(first: &PriceInput, second: Option<&PriceInput>) -> CloseShape {
    match second {
        Some(_) => CloseShape::Interpolation,
        None if first.official_close => CloseShape::OfficialClose,
        None => CloseShape::ExactTimestamp,
    }
}

/// Decodes every `T` event emitted (as `Program data:` log lines) by a transaction.
pub fn events<T: AnchorDeserialize + Discriminator>(meta: &TransactionMetadata) -> Vec<T> {
    meta.logs
        .iter()
        .filter_map(|line| line.strip_prefix("Program data: "))
        .filter_map(|b64| STANDARD.decode(b64).ok())
        .filter(|data| data.starts_with(T::DISCRIMINATOR))
        .map(|data| {
            T::deserialize(&mut &data[T::DISCRIMINATOR.len()..]).expect("deserialize event")
        })
        .collect()
}

impl Env {
    // ---- oracle accounts ---------------------------------------------------------------------

    /// Writes `data` at `key` with the given owner, rent-exempt.
    pub fn put_account(&mut self, key: Pubkey, data: Vec<u8>, owner: Pubkey) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                key,
                Account {
                    lamports,
                    data,
                    owner,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }

    fn put_anchor<T: AccountSerialize>(&mut self, key: Pubkey, value: &T, space: usize) {
        let mut data = Vec::with_capacity(space);
        value.try_serialize(&mut data).unwrap();
        data.resize(space, 0);
        self.put_account(key, data, meridian_oracle::ID);
    }

    pub fn close_record_value(
        signer: Pubkey,
        ticker: Ticker,
        trading_day: u32,
        close_ts: i64,
        first: PriceInput,
        second: Option<PriceInput>,
    ) -> CloseRecord {
        CloseRecord {
            signer,
            ticker,
            trading_day,
            close_ts,
            shape: shape_of(&first, second.as_ref()),
            first,
            second,
            bump: 255,
        }
    }

    /// Writes a `CloseRecord` at `key`, owned by `meridian_oracle`.
    pub fn write_close_record_at(&mut self, key: Pubkey, record: &CloseRecord) {
        self.put_anchor(key, record, 8 + CloseRecord::INIT_SPACE);
    }

    /// Writes the canonical `CloseRecord` for `signer`, ticker and day, and returns its address.
    pub fn write_close(
        &mut self,
        signer: Pubkey,
        ticker: Ticker,
        trading_day: u32,
        first: PriceInput,
        second: Option<PriceInput>,
    ) -> Pubkey {
        let key = close_pda(&signer, ticker, trading_day);
        let record = Self::close_record_value(signer, ticker, trading_day, T_CLOSE, first, second);
        self.write_close_record_at(key, &record);
        key
    }

    /// The slot-1 relay's AAPL close record for `DAY`.
    pub fn relay_close(&mut self, first: PriceInput, second: Option<PriceInput>) -> Pubkey {
        let signer = self.relay_signer;
        self.write_close(signer, ticker("AAPL"), DAY, first, second)
    }

    /// The slot-1 relay's AAPL official close at `price`, published at the close.
    pub fn relay_official_close(&mut self, price: i64) -> Pubkey {
        self.relay_close(official(price, T_CLOSE), None)
    }

    pub fn write_price_update(
        &mut self,
        signer: Pubkey,
        ticker: Ticker,
        input: PriceInput,
    ) -> Pubkey {
        let key = price_pda(&signer, ticker, input.publish_time);
        let update = PriceUpdate {
            signer,
            ticker,
            price: input.price,
            conf: input.conf,
            expo: input.expo,
            publish_time: input.publish_time,
            session: input.session,
            official_close: input.official_close,
            bump: 255,
        };
        self.put_anchor(key, &update, 8 + PriceUpdate::INIT_SPACE);
        key
    }

    pub fn write_latest_price(
        &mut self,
        signer: Pubkey,
        ticker: Ticker,
        input: PriceInput,
    ) -> Pubkey {
        let key = latest_pda(&signer, ticker);
        let latest = LatestPrice {
            signer,
            ticker,
            price: input.price,
            conf: input.conf,
            expo: input.expo,
            publish_time: input.publish_time,
            session: input.session,
            official_close: input.official_close,
            bump: 255,
        };
        self.put_anchor(key, &latest, 8 + LatestPrice::INIT_SPACE);
        key
    }

    /// Deploys the real `meridian_oracle` program with `upgrade_authority` as its upgrade
    /// authority, initializes its registry with `admin` as registry admin, and registers a new
    /// relay signer that it also sets as Meridian's slot-1 signer. Returns the relay keypair.
    pub fn load_oracle_with_relay(&mut self) -> Keypair {
        let bytes = std::fs::read(ORACLE_SO).unwrap_or_else(|e| {
            panic!("read {ORACLE_SO}: {e}. Run `anchor build` before `cargo test`.")
        });
        self.svm.add_program(meridian_oracle::ID, &bytes).unwrap();
        let pd_key = program_data_pda(&meridian_oracle::ID);
        let mut pd = self.svm.get_account(&pd_key).expect("program data account");
        pd.data[12] = 1;
        pd.data[13..45].copy_from_slice(self.upgrade_authority.pubkey().as_ref());
        self.svm.set_account(pd_key, pd).unwrap();

        let ua = self.upgrade_authority.insecure_clone();
        let admin = self.admin.insecure_clone();
        let relay = Keypair::new();
        self.svm.airdrop(&relay.pubkey(), 10_000_000_000).unwrap();
        let init = Instruction {
            program_id: meridian_oracle::ID,
            accounts: meridian_oracle::accounts::InitializeRegistry {
                authority: ua.pubkey(),
                registry: oracle_registry_pda(),
                program: meridian_oracle::ID,
                program_data: pd_key,
                system_program: Pubkey::default(),
            }
            .to_account_metas(None),
            data: meridian_oracle::instruction::InitializeRegistry {
                admin: admin.pubkey(),
            }
            .data(),
        };
        assert_ok(self.send_one(init, &ua));
        let add = self.ix_oracle_add_signer(relay.pubkey());
        assert_ok(self.send_one(add, &admin));
        self.set_slot_1_signer(relay.pubkey());
        relay
    }

    pub fn ix_oracle_add_signer(&self, signer: Pubkey) -> Instruction {
        Instruction {
            program_id: meridian_oracle::ID,
            accounts: meridian_oracle::accounts::UpdateRegistry {
                admin: self.admin.pubkey(),
                registry: oracle_registry_pda(),
            }
            .to_account_metas(None),
            data: meridian_oracle::instruction::AddSigner { signer }.data(),
        }
    }

    /// Publishes a `PriceUpdate` through the oracle program. The clock must be at most 60 s
    /// before `input.publish_time`.
    pub fn oracle_publish_price(
        &mut self,
        relay: &Keypair,
        ticker: Ticker,
        input: PriceInput,
    ) -> Pubkey {
        let key = price_pda(&relay.pubkey(), ticker, input.publish_time);
        let ix = Instruction {
            program_id: meridian_oracle::ID,
            accounts: meridian_oracle::accounts::PublishPrice {
                signer: relay.pubkey(),
                registry: oracle_registry_pda(),
                price_update: key,
                system_program: Pubkey::default(),
            }
            .to_account_metas(None),
            data: meridian_oracle::instruction::PublishPrice { ticker, input }.data(),
        };
        assert_ok(self.send_one(ix, relay));
        key
    }

    /// Publishes the `CloseRecord` through the oracle program and returns its address.
    pub fn oracle_publish_close(
        &mut self,
        relay: &Keypair,
        ticker: Ticker,
        first: Pubkey,
        second: Option<Pubkey>,
    ) -> Pubkey {
        let key = close_pda(&relay.pubkey(), ticker, DAY);
        let ix = Instruction {
            program_id: meridian_oracle::ID,
            accounts: meridian_oracle::accounts::PublishClose {
                signer: relay.pubkey(),
                registry: oracle_registry_pda(),
                close_record: key,
                first_update: first,
                second_update: second,
                system_program: Pubkey::default(),
            }
            .to_account_metas(None),
            data: meridian_oracle::instruction::PublishClose {
                ticker,
                trading_day: DAY,
                close_ts: T_CLOSE,
            }
            .data(),
        };
        assert_ok(self.send_one(ix, relay));
        key
    }

    /// Points oracle slot 1 at `signer` through `update_config`.
    pub fn set_slot_1_signer(&mut self, signer: Pubkey) {
        let mut slots = self.config().oracle_slots;
        slots[SLOT_1 as usize] = relay_slot(signer);
        self.update_config_with(meridian::UpdateConfigArgs {
            oracle_slots: Some(slots),
            ..Default::default()
        });
    }

    pub fn update_config_with(&mut self, args: meridian::UpdateConfigArgs) {
        let admin = self.admin.insecure_clone();
        let ix = self.ix_update_config(&admin.pubkey(), args);
        assert_ok(self.send_one(ix, &admin));
    }

    // ---- markets -----------------------------------------------------------------------------

    /// Creates a market for `ticker_str` at `strike` on `DAY` as the admin.
    pub fn create_ticker_market(&mut self, ticker_str: &str, strike: i64) -> MarketKeys {
        let args = self.market_args(ticker_str, strike);
        let admin = self.admin.insecure_clone();
        let ix = self.ix_create_strike_market(&admin.pubkey(), args);
        assert_ok(self.send_one(ix, &admin));
        MarketKeys::derive(args.ticker, args.trading_day, args.strike)
    }

    /// A user holding `pairs` Yes/No pairs of `m` (minted at the mint open) and no spare USDC.
    /// Leaves the clock at the mint open.
    pub fn user_with_pairs(&mut self, m: &MarketKeys, pairs: u64) -> User {
        self.set_time(T_MINT_OPEN + 60);
        let user = self.new_user(m, pairs);
        if pairs > 0 {
            assert_ok(self.mint_pair(&user, m, pairs));
        }
        user
    }

    // ---- settlement --------------------------------------------------------------------------

    pub fn ix_settle_market_with(
        &self,
        caller: &Pubkey,
        ticker_day: Pubkey,
        market: Pubkey,
        close_record: Pubkey,
        slot: u8,
    ) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::SettleMarket {
                caller: *caller,
                config: config_pda(),
                ticker_day,
                market,
                close_record,
            }
            .to_account_metas(None),
            data: meridian::instruction::SettleMarket { slot }.data(),
        }
    }

    pub fn ix_settle_market(
        &self,
        caller: &Pubkey,
        m: &MarketKeys,
        close_record: Pubkey,
    ) -> Instruction {
        self.ix_settle_market_with(caller, m.ticker_day, m.market, close_record, SLOT_1)
    }

    /// `settle_market` on slot 1, signed by a fresh third party (it is permissionless).
    pub fn settle(&mut self, m: &MarketKeys, close_record: Pubkey) -> TransactionResult {
        let ix = self.ix_settle_market(&Pubkey::default(), m, close_record);
        self.send_as_anyone(ix)
    }

    /// Sends `ix` with its first account (the caller) replaced by a fresh funded keypair.
    pub fn send_as_anyone(&mut self, mut ix: Instruction) -> TransactionResult {
        let anyone = Keypair::new();
        self.svm.airdrop(&anyone.pubkey(), 1_000_000_000).unwrap();
        ix.accounts[0].pubkey = anyone.pubkey();
        self.send_one(ix, &anyone)
    }

    pub fn ix_propose_admin_price(
        &self,
        admin: &Pubkey,
        ticker: Ticker,
        trading_day: u32,
        price: i64,
    ) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::ProposeAdminPrice {
                admin: *admin,
                config: config_pda(),
                ticker_day: MarketKeys::derive(ticker, trading_day, 0).ticker_day,
            }
            .to_account_metas(None),
            data: meridian::instruction::ProposeAdminPrice {
                ticker,
                trading_day,
                price,
            }
            .data(),
        }
    }

    /// The admin proposes `price` (cents) for AAPL on `DAY`.
    pub fn propose(&mut self, price: i64) -> TransactionResult {
        let admin = self.admin.insecure_clone();
        let ix = self.ix_propose_admin_price(&admin.pubkey(), ticker("AAPL"), DAY, price);
        self.send_one(ix, &admin)
    }

    pub fn ix_finalize_admin_settle(
        &self,
        caller: &Pubkey,
        ticker: Ticker,
        trading_day: u32,
    ) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::FinalizeAdminSettle {
                caller: *caller,
                config: config_pda(),
                ticker_day: MarketKeys::derive(ticker, trading_day, 0).ticker_day,
            }
            .to_account_metas(None),
            data: meridian::instruction::FinalizeAdminSettle {
                ticker,
                trading_day,
            }
            .data(),
        }
    }

    /// The admin finalizes the pending AAPL admin price for `DAY` (admin-only, D93).
    pub fn finalize(&mut self) -> TransactionResult {
        let admin = self.admin.insecure_clone();
        self.finalize_as(&admin)
    }

    /// `signer` tries to finalize the pending AAPL admin price for `DAY`.
    pub fn finalize_as(&mut self, signer: &Keypair) -> TransactionResult {
        let ix = self.ix_finalize_admin_settle(&signer.pubkey(), ticker("AAPL"), DAY);
        self.send_one(ix, signer)
    }

    // ---- redeem ------------------------------------------------------------------------------

    pub fn ix_redeem(&self, user: &User, m: &MarketKeys, yes: u64, no: u64) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::Redeem {
                user: user.pubkey(),
                config: config_pda(),
                market: m.market,
                yes_mint: m.yes_mint,
                no_mint: m.no_mint,
                vault: m.vault,
                user_usdc: user.usdc,
                user_yes: user.yes,
                user_no: user.no,
                token_program: spl_token_interface::ID,
            }
            .to_account_metas(None),
            data: meridian::instruction::Redeem {
                yes_amount: yes,
                no_amount: no,
            }
            .data(),
        }
    }

    /// Redeems `yes` and `no` base units of `m` for `user`.
    pub fn redeem(&mut self, user: &User, m: &MarketKeys, yes: u64, no: u64) -> TransactionResult {
        let ix = self.ix_redeem(user, m, yes, no);
        self.send_one(ix, &user.kp)
    }
}

/// The fields INV-5 protects.
pub fn settled_fields(market: &Market) -> (MarketStatus, Option<Outcome>, i64, SettleSource) {
    (
        market.status,
        market.outcome,
        market.settle_price,
        market.settle_source,
    )
}
