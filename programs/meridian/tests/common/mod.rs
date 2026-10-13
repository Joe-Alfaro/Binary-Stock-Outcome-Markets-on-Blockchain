//! In-process harness for the `meridian` program on LiteSVM.
//!
//! Loads `target/deploy/meridian.so` (run `anchor build` first), deploys it under the
//! upgradeable loader with a known upgrade authority, and provides a mock 6-decimal USDC mint,
//! clock control and instruction builders.
#![allow(dead_code, clippy::result_large_err)]

use agave_feature_set::FeatureSet;
use anchor_lang::error::ERROR_CODE_OFFSET;
use anchor_lang::prelude::{Clock, Pubkey};
use anchor_lang::solana_program::bpf_loader_upgradeable;
use anchor_lang::solana_program::instruction::error::InstructionError;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{
    system_program, AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas,
};
use litesvm::types::TransactionResult;
use litesvm::LiteSVM;
use meridian::errors::MeridianError;
use meridian::state::*;
use meridian::{CreateMarketArgs, InitializeConfigArgs, UpdateConfigArgs};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_program_option::COption;
use solana_program_pack::Pack;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use spl_token_interface::state::{Account as TokenAccount, AccountState, Mint};

pub const PROGRAM_SO: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/deploy/meridian.so"
);

/// Trading day used by every test: Tuesday 2026-10-13 (EDT, UTC-4).
pub const DAY: u32 = 20261013;
pub const DAY0_UTC: i64 = 1_791_849_600;
/// 6:00 AM ET, when the morning job creates markets.
pub const T_CREATE: i64 = DAY0_UTC + 10 * 3600;
/// 9:00 AM ET.
pub const T_MINT_OPEN: i64 = DAY0_UTC + 13 * 3600;
/// 9:30 AM ET.
pub const T_TRADING_OPEN: i64 = DAY0_UTC + 13 * 3600 + 1800;
/// 4:00 PM ET.
pub const T_CLOSE: i64 = DAY0_UTC + 20 * 3600;

pub const STRIKE_EXPO: i32 = -2;
/// $690.00 at `STRIKE_EXPO`.
pub const STRIKE: i64 = 69_000;
pub const TICKERS: [&str; TICKER_COUNT] = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];

pub fn ticker(s: &str) -> [u8; TICKER_LEN] {
    let mut out = [0u8; TICKER_LEN];
    out[..s.len()].copy_from_slice(s.as_bytes());
    out
}

pub fn custom_code(e: MeridianError) -> u32 {
    ERROR_CODE_OFFSET + e as u32
}

/// Asserts the transaction failed with the given Meridian error.
pub fn assert_meridian_err(res: TransactionResult, expected: MeridianError) {
    let code = custom_code(expected);
    match res {
        Ok(_) => panic!("expected {expected:?} ({code}), but the transaction succeeded"),
        Err(f) => match &f.err {
            TransactionError::InstructionError(_, InstructionError::Custom(c)) if *c == code => {}
            other => panic!(
                "expected {expected:?} ({code}), got {other:?}\nlogs:\n{}",
                f.meta.logs.join("\n")
            ),
        },
    }
}

pub fn assert_ok(res: TransactionResult) -> litesvm::types::TransactionMetadata {
    match res {
        Ok(meta) => meta,
        Err(f) => panic!(
            "transaction failed: {:?}\nlogs:\n{}",
            f.err,
            f.meta.logs.join("\n")
        ),
    }
}

pub fn assert_failed(res: TransactionResult) {
    assert!(
        res.is_err(),
        "expected the transaction to fail, but it succeeded"
    );
}

#[derive(Clone, Copy, Debug)]
pub struct MarketKeys {
    pub ticker: [u8; TICKER_LEN],
    pub trading_day: u32,
    pub strike: i64,
    pub market: Pubkey,
    pub ticker_day: Pubkey,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub vault: Pubkey,
    pub book: Pubkey,
    pub yes_escrow: Pubkey,
    pub usdc_escrow: Pubkey,
}

impl MarketKeys {
    pub fn derive(ticker: [u8; TICKER_LEN], trading_day: u32, strike: i64) -> Self {
        let pda = |seeds: &[&[u8]]| Pubkey::find_program_address(seeds, &meridian::ID).0;
        let day = trading_day.to_le_bytes();
        let market = pda(&[MARKET_SEED, &ticker, &day, &strike.to_le_bytes()]);
        Self {
            ticker,
            trading_day,
            strike,
            market,
            ticker_day: pda(&[TICKER_DAY_SEED, &ticker, &day]),
            yes_mint: pda(&[YES_MINT_SEED, market.as_ref()]),
            no_mint: pda(&[NO_MINT_SEED, market.as_ref()]),
            vault: pda(&[VAULT_SEED, market.as_ref()]),
            book: pda(&[BOOK_SEED, market.as_ref()]),
            yes_escrow: pda(&[YES_ESCROW_SEED, market.as_ref()]),
            usdc_escrow: pda(&[USDC_ESCROW_SEED, market.as_ref()]),
        }
    }
}

pub struct User {
    pub kp: Keypair,
    pub usdc: Pubkey,
    pub yes: Pubkey,
    pub no: Pubkey,
}

impl User {
    pub fn pubkey(&self) -> Pubkey {
        self.kp.pubkey()
    }
}

pub fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[CONFIG_SEED], &meridian::ID).0
}

pub fn program_data_pda(program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[program_id.as_ref()], &bpf_loader_upgradeable::ID).0
}

pub struct Env {
    pub svm: LiteSVM,
    pub upgrade_authority: Keypair,
    pub admin: Keypair,
    pub automation: Keypair,
    pub usdc_authority: Keypair,
    pub usdc_mint: Pubkey,
    pub relay_signer: Pubkey,
}

impl Env {
    /// Program deployed, USDC mint created, config not initialized. Clock at `T_CREATE`.
    pub fn new() -> Self {
        let mut svm = new_svm();
        let upgrade_authority = Keypair::new();
        deploy_upgradeable(&mut svm, meridian::ID, &upgrade_authority.pubkey());

        let admin = Keypair::new();
        let automation = Keypair::new();
        let usdc_authority = Keypair::new();
        for kp in [&upgrade_authority, &admin, &automation, &usdc_authority] {
            svm.airdrop(&kp.pubkey(), 100_000_000_000).unwrap();
        }
        let usdc_mint = Keypair::new().pubkey();
        let mut env = Self {
            svm,
            upgrade_authority,
            admin,
            automation,
            usdc_authority,
            usdc_mint,
            relay_signer: Keypair::new().pubkey(),
        };
        let usdc_auth = env.usdc_authority.pubkey();
        env.set_mint(usdc_mint, Some(usdc_auth), 6);
        env.set_time(T_CREATE);
        env
    }

    /// `new()` plus `initialize_config` with `default_init_args()`.
    pub fn initialized() -> Self {
        let mut env = Self::new();
        let args = env.default_init_args();
        let ix = env.ix_initialize_config(&env.upgrade_authority.pubkey(), args);
        let ua = env.upgrade_authority.insecure_clone();
        assert_ok(env.send(&[ix], &ua, &[]));
        env
    }

    // ---- clock -------------------------------------------------------------------------------

    pub fn set_time(&mut self, unix_timestamp: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp = unix_timestamp;
        clock.slot += 1;
        self.svm.set_sysvar(&clock);
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    // ---- transactions ------------------------------------------------------------------------

    pub fn send(
        &mut self,
        ixs: &[Instruction],
        payer: &Keypair,
        others: &[&Keypair],
    ) -> TransactionResult {
        // A fresh blockhash per transaction, so a repeated instruction is never rejected as a
        // duplicate signature instead of by the program.
        self.svm.expire_blockhash();
        let mut signers: Vec<&Keypair> = vec![payer];
        signers.extend_from_slice(others);
        let tx = Transaction::new_signed_with_payer(
            ixs,
            Some(&payer.pubkey()),
            &signers,
            self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx)
    }

    pub fn send_one(&mut self, ix: Instruction, signer: &Keypair) -> TransactionResult {
        self.send(&[ix], signer, &[])
    }

    // ---- config ------------------------------------------------------------------------------

    pub fn default_init_args(&self) -> InitializeConfigArgs {
        let mut tickers = [[0u8; TICKER_LEN]; TICKER_COUNT];
        for (i, t) in TICKERS.iter().enumerate() {
            tickers[i] = ticker(t);
        }
        InitializeConfigArgs {
            admin: self.admin.pubkey(),
            automation_authority: self.automation.pubkey(),
            tickers,
            oracle_slots: [relay_slot(self.relay_signer), disabled_slot()],
            max_staleness_secs: 300,
            max_conf_bps: 50,
            admin_propose_delay_secs: 900,
            admin_finalize_delay_secs: 3600,
        }
    }

    pub fn ix_initialize_config(
        &self,
        authority: &Pubkey,
        args: InitializeConfigArgs,
    ) -> Instruction {
        self.ix_initialize_config_with(authority, args, program_data_pda(&meridian::ID))
    }

    pub fn ix_initialize_config_with(
        &self,
        authority: &Pubkey,
        args: InitializeConfigArgs,
        program_data: Pubkey,
    ) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::InitializeConfig {
                authority: *authority,
                config: config_pda(),
                usdc_mint: self.usdc_mint,
                program: meridian::ID,
                program_data,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: meridian::instruction::InitializeConfig { args }.data(),
        }
    }

    fn admin_metas(admin: &Pubkey) -> Vec<anchor_lang::solana_program::instruction::AccountMeta> {
        meridian::accounts::AdminConfig {
            admin: *admin,
            config: config_pda(),
        }
        .to_account_metas(None)
    }

    pub fn ix_update_config(&self, admin: &Pubkey, args: UpdateConfigArgs) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: Self::admin_metas(admin),
            data: meridian::instruction::UpdateConfig { args }.data(),
        }
    }

    pub fn ix_pause(&self, admin: &Pubkey) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: Self::admin_metas(admin),
            data: meridian::instruction::Pause {}.data(),
        }
    }

    pub fn ix_unpause(&self, admin: &Pubkey) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: Self::admin_metas(admin),
            data: meridian::instruction::Unpause {}.data(),
        }
    }

    pub fn pause(&mut self) {
        let admin = self.admin.insecure_clone();
        let ix = self.ix_pause(&admin.pubkey());
        assert_ok(self.send_one(ix, &admin));
    }

    pub fn unpause(&mut self) {
        let admin = self.admin.insecure_clone();
        let ix = self.ix_unpause(&admin.pubkey());
        assert_ok(self.send_one(ix, &admin));
    }

    // ---- markets -----------------------------------------------------------------------------

    pub fn market_args(&self, ticker_str: &str, strike: i64) -> CreateMarketArgs {
        CreateMarketArgs {
            ticker: ticker(ticker_str),
            trading_day: DAY,
            strike,
            strike_expo: STRIKE_EXPO,
            close_ts: T_CLOSE,
            mint_open_ts: T_MINT_OPEN,
            trading_open_ts: T_TRADING_OPEN,
        }
    }

    fn create_metas(
        &self,
        authority: &Pubkey,
        args: &CreateMarketArgs,
    ) -> Vec<anchor_lang::solana_program::instruction::AccountMeta> {
        let k = MarketKeys::derive(args.ticker, args.trading_day, args.strike);
        meridian::accounts::CreateMarket {
            authority: *authority,
            config: config_pda(),
            ticker_day: k.ticker_day,
            market: k.market,
            yes_mint: k.yes_mint,
            no_mint: k.no_mint,
            vault: k.vault,
            book: k.book,
            yes_escrow: k.yes_escrow,
            usdc_escrow: k.usdc_escrow,
            usdc_mint: self.usdc_mint,
            token_program: spl_token_interface::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None)
    }

    pub fn ix_create_strike_market(
        &self,
        authority: &Pubkey,
        args: CreateMarketArgs,
    ) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: self.create_metas(authority, &args),
            data: meridian::instruction::CreateStrikeMarket { args }.data(),
        }
    }

    pub fn ix_add_strike(&self, authority: &Pubkey, args: CreateMarketArgs) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: self.create_metas(authority, &args),
            data: meridian::instruction::AddStrike { args }.data(),
        }
    }

    /// Creates the AAPL market at `strike` as the admin and returns its keys.
    pub fn create_market(&mut self, strike: i64) -> MarketKeys {
        let args = self.market_args("AAPL", strike);
        let admin = self.admin.insecure_clone();
        let ix = self.ix_create_strike_market(&admin.pubkey(), args);
        assert_ok(self.send_one(ix, &admin));
        MarketKeys::derive(args.ticker, args.trading_day, args.strike)
    }

    // ---- mint and merge ----------------------------------------------------------------------

    fn collateral_metas(
        &self,
        user: &User,
        m: &MarketKeys,
    ) -> Vec<anchor_lang::solana_program::instruction::AccountMeta> {
        meridian::accounts::Collateral {
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
        .to_account_metas(None)
    }

    pub fn ix_mint_pair(&self, user: &User, m: &MarketKeys, n: u64) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: self.collateral_metas(user, m),
            data: meridian::instruction::MintPair { n }.data(),
        }
    }

    pub fn ix_merge_pair(&self, user: &User, m: &MarketKeys, n: u64) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: self.collateral_metas(user, m),
            data: meridian::instruction::MergePair { n }.data(),
        }
    }

    pub fn mint_pair(&mut self, user: &User, m: &MarketKeys, n: u64) -> TransactionResult {
        let ix = self.ix_mint_pair(user, m, n);
        self.send_one(ix, &user.kp)
    }

    pub fn merge_pair(&mut self, user: &User, m: &MarketKeys, n: u64) -> TransactionResult {
        let ix = self.ix_merge_pair(user, m, n);
        self.send_one(ix, &user.kp)
    }

    /// A funded wallet with `usdc_whole` USDC and empty Yes and No accounts for `m`.
    pub fn new_user(&mut self, m: &MarketKeys, usdc_whole: u64) -> User {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
        let owner = kp.pubkey();
        let usdc = self.set_token_account(self.usdc_mint, owner, usdc_whole * UNIT);
        let yes = self.set_token_account(m.yes_mint, owner, 0);
        let no = self.set_token_account(m.no_mint, owner, 0);
        User { kp, usdc, yes, no }
    }

    // ---- direct SPL token actions (outside Meridian) -----------------------------------------

    pub fn token_transfer(
        &mut self,
        from: &Pubkey,
        to: &Pubkey,
        owner: &Keypair,
        amount: u64,
    ) -> TransactionResult {
        let ix = spl_token_interface::instruction::transfer(
            &spl_token_interface::ID,
            from,
            to,
            &owner.pubkey(),
            &[],
            amount,
        )
        .unwrap();
        self.send_one(ix, owner)
    }

    pub fn token_burn(
        &mut self,
        account: &Pubkey,
        mint: &Pubkey,
        owner: &Keypair,
        amount: u64,
    ) -> TransactionResult {
        let ix = spl_token_interface::instruction::burn(
            &spl_token_interface::ID,
            account,
            mint,
            &owner.pubkey(),
            &[],
            amount,
        )
        .unwrap();
        self.send_one(ix, owner)
    }

    // ---- account readers ---------------------------------------------------------------------

    pub fn anchor_account<T: AccountDeserialize>(&self, key: &Pubkey) -> T {
        let acc = self
            .svm
            .get_account(key)
            .unwrap_or_else(|| panic!("account {key} does not exist"));
        T::try_deserialize(&mut acc.data.as_slice()).expect("deserialize anchor account")
    }

    pub fn exists(&self, key: &Pubkey) -> bool {
        self.svm.get_account(key).is_some_and(|a| a.lamports > 0)
    }

    pub fn config(&self) -> Config {
        self.anchor_account(&config_pda())
    }

    pub fn market(&self, m: &MarketKeys) -> Market {
        self.anchor_account(&m.market)
    }

    pub fn ticker_day(&self, m: &MarketKeys) -> TickerDay {
        self.anchor_account(&m.ticker_day)
    }

    pub fn raw(&self, key: &Pubkey) -> Account {
        self.svm
            .get_account(key)
            .unwrap_or_else(|| panic!("account {key} does not exist"))
    }

    pub fn token_account(&self, key: &Pubkey) -> TokenAccount {
        TokenAccount::unpack(&self.raw(key).data).expect("unpack token account")
    }

    pub fn balance(&self, key: &Pubkey) -> u64 {
        self.token_account(key).amount
    }

    pub fn mint(&self, key: &Pubkey) -> Mint {
        Mint::unpack(&self.raw(key).data).expect("unpack mint")
    }

    pub fn supply(&self, key: &Pubkey) -> u64 {
        self.mint(key).supply
    }

    pub fn lamports(&self, key: &Pubkey) -> u64 {
        self.svm.get_account(key).map(|a| a.lamports).unwrap_or(0)
    }

    // ---- state injection ---------------------------------------------------------------------

    /// Marks a market settled by rewriting its account. Settlement itself belongs to a later
    /// package; this lets the pre-settlement instructions be tested against a settled market.
    pub fn force_settle(&mut self, m: &MarketKeys, outcome: Outcome) {
        let mut market = self.market(m);
        market.status = MarketStatus::Settled;
        market.outcome = Some(outcome);
        market.settle_price = m.strike;
        market.settle_source = SettleSource::Admin;
        let mut acc = self.raw(&m.market);
        let mut data = Vec::with_capacity(acc.data.len());
        market.try_serialize(&mut data).unwrap();
        data.resize(acc.data.len(), 0);
        acc.data = data;
        self.svm.set_account(m.market, acc).unwrap();
    }

    pub fn set_mint(&mut self, key: Pubkey, authority: Option<Pubkey>, decimals: u8) {
        let mint = Mint {
            mint_authority: authority.map(COption::Some).unwrap_or(COption::None),
            supply: 0,
            decimals,
            is_initialized: true,
            freeze_authority: COption::None,
        };
        let mut data = vec![0u8; Mint::LEN];
        Mint::pack(mint, &mut data).unwrap();
        self.put(key, data, spl_token_interface::ID);
    }

    pub fn set_token_account(&mut self, mint: Pubkey, owner: Pubkey, amount: u64) -> Pubkey {
        let key = Keypair::new().pubkey();
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
        self.put(key, data, spl_token_interface::ID);
        key
    }

    fn put(&mut self, key: Pubkey, data: Vec<u8>, owner: Pubkey) {
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
}

pub fn relay_slot(signer: Pubkey) -> OracleSlot {
    OracleSlot {
        kind: OracleKind::MeridianRelay,
        relay_signer: signer,
        ..disabled_slot()
    }
}

pub fn disabled_slot() -> OracleSlot {
    OracleSlot {
        kind: OracleKind::Disabled,
        relay_signer: Pubkey::default(),
        feed_ids: [[0u8; 32]; TICKER_COUNT],
        verifier_program: Pubkey::default(),
        min_verification_level: 0,
    }
}

/// `LiteSVM::new()` with every feature enabled, as on the local test validator. The mainnet set
/// `new()` uses lacks SBPF v3, which the pinned platform tools emit.
pub fn new_svm() -> LiteSVM {
    LiteSVM::default()
        .with_feature_set(FeatureSet::all_enabled())
        .with_builtins()
        .with_lamports(1_000_000_000_000_000_000)
        .with_sysvars()
        .with_feature_accounts()
        .with_default_programs()
        .with_sigverify(true)
        .with_blockhash_check(true)
}

/// Deploys `meridian.so` at `program_id` under the upgradeable loader and sets its upgrade
/// authority (LiteSVM's `add_program` leaves it empty).
pub fn deploy_upgradeable(svm: &mut LiteSVM, program_id: Pubkey, authority: &Pubkey) {
    let bytes = std::fs::read(PROGRAM_SO).unwrap_or_else(|e| {
        panic!("read {PROGRAM_SO}: {e}. Run `anchor build` before `cargo test`.")
    });
    svm.add_program(program_id, &bytes).unwrap();
    let pd_key = program_data_pda(&program_id);
    let mut pd = svm.get_account(&pd_key).expect("program data account");
    // ProgramData metadata (bincode): u32 tag, u64 slot, Option<Pubkey> upgrade authority.
    pd.data[12] = 1;
    pd.data[13..45].copy_from_slice(authority.as_ref());
    svm.set_account(pd_key, pd).unwrap();
}
