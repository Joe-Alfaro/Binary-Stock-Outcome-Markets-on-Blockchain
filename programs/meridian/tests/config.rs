//! R10 initialize config, R41 pause/unpause authority, R42 config changes can't touch markets.

mod common;

use common::*;
use meridian::errors::MeridianError;
use meridian::state::*;
use meridian::UpdateConfigArgs;
use solana_keypair::Keypair;
use solana_signer::Signer;

// ---- R10 ---------------------------------------------------------------------------------------

#[test]
fn r10_upgrade_authority_initializes_config_with_every_field() {
    let mut env = Env::new();
    let args = env.default_init_args();
    let ua = env.upgrade_authority.insecure_clone();
    let ix = env.ix_initialize_config(&ua.pubkey(), args.clone());
    assert_ok(env.send_one(ix, &ua));

    let c = env.config();
    assert_eq!(c.admin, args.admin);
    assert_eq!(c.automation_authority, args.automation_authority);
    assert_eq!(c.usdc_mint, env.usdc_mint);
    assert_eq!(c.tickers, args.tickers);
    assert_eq!(c.oracle_slots, args.oracle_slots);
    assert_eq!(c.max_staleness_secs, 300);
    assert_eq!(c.max_conf_bps, 50);
    assert_eq!(c.admin_propose_delay_secs, 900);
    assert_eq!(c.admin_finalize_delay_secs, 3600);
    assert!(!c.paused);
    assert!(!c.demo_mode);
    let (_, bump) =
        anchor_lang::prelude::Pubkey::find_program_address(&[CONFIG_SEED], &meridian::ID);
    assert_eq!(c.bump, bump);
}

#[test]
fn r10_signer_other_than_upgrade_authority_cannot_initialize() {
    let mut env = Env::new();
    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 10_000_000_000).unwrap();
    // The attacker names themselves admin, as a front-runner would.
    let mut args = env.default_init_args();
    args.admin = attacker.pubkey();
    let ix = env.ix_initialize_config(&attacker.pubkey(), args);
    assert_meridian_err(env.send_one(ix, &attacker), MeridianError::Unauthorized);
    assert!(!env.exists(&config_pda()), "config must not be created");
}

#[test]
fn r10_admin_who_is_not_upgrade_authority_cannot_initialize() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let args = env.default_init_args();
    let ix = env.ix_initialize_config(&admin.pubkey(), args);
    assert_meridian_err(env.send_one(ix, &admin), MeridianError::Unauthorized);
    assert!(!env.exists(&config_pda()));
}

#[test]
fn r10_program_data_of_another_program_is_rejected() {
    // The attacker deploys their own copy of the program, so they are the upgrade authority of
    // *that* program-data account, and passes it alongside the real program.
    let mut env = Env::new();
    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 10_000_000_000).unwrap();
    let other_program = Keypair::new().pubkey();
    deploy_upgradeable(&mut env.svm, other_program, &attacker.pubkey());

    let mut args = env.default_init_args();
    args.admin = attacker.pubkey();
    let ix =
        env.ix_initialize_config_with(&attacker.pubkey(), args, program_data_pda(&other_program));
    assert_failed(env.send_one(ix, &attacker));
    assert!(!env.exists(&config_pda()));

    // The real upgrade authority can still initialize afterwards.
    let ua = env.upgrade_authority.insecure_clone();
    let ix = env.ix_initialize_config(&ua.pubkey(), env.default_init_args());
    assert_ok(env.send_one(ix, &ua));
    assert_eq!(env.config().admin, env.admin.pubkey());
}

#[test]
fn r10_second_initialize_fails_and_leaves_config_unchanged() {
    let mut env = Env::initialized();
    let before = env.config();

    let ua = env.upgrade_authority.insecure_clone();
    let mut args = env.default_init_args();
    args.admin = ua.pubkey();
    args.max_staleness_secs = 1;
    let ix = env.ix_initialize_config(&ua.pubkey(), args);
    assert_failed(env.send_one(ix, &ua));
    assert_eq!(env.config(), before);
}

// ---- R41 admin-only pause / unpause ------------------------------------------------------------

#[test]
fn r41_admin_pauses_and_unpauses() {
    let mut env = Env::initialized();
    env.pause();
    assert!(env.config().paused);
    env.unpause();
    assert!(!env.config().paused);
}

#[test]
fn r41_non_admin_cannot_pause() {
    let mut env = Env::initialized();
    for signer in [
        env.automation.insecure_clone(),
        env.upgrade_authority.insecure_clone(),
        Keypair::new(),
    ] {
        env.svm.airdrop(&signer.pubkey(), 1_000_000_000).unwrap();
        let ix = env.ix_pause(&signer.pubkey());
        assert_meridian_err(env.send_one(ix, &signer), MeridianError::Unauthorized);
        assert!(!env.config().paused);
    }
}

#[test]
fn r41_non_admin_cannot_unpause() {
    let mut env = Env::initialized();
    env.pause();
    for signer in [
        env.automation.insecure_clone(),
        env.upgrade_authority.insecure_clone(),
        Keypair::new(),
    ] {
        env.svm.airdrop(&signer.pubkey(), 1_000_000_000).unwrap();
        let ix = env.ix_unpause(&signer.pubkey());
        assert_meridian_err(env.send_one(ix, &signer), MeridianError::Unauthorized);
        assert!(env.config().paused);
    }
}

// ---- R42 ---------------------------------------------------------------------------------------

fn full_update(env: &Env) -> UpdateConfigArgs {
    UpdateConfigArgs {
        automation_authority: Some(Keypair::new().pubkey()),
        oracle_slots: Some([disabled_slot(), relay_slot(env.relay_signer)]),
        max_staleness_secs: Some(120),
        max_conf_bps: Some(10),
        admin_propose_delay_secs: Some(1200),
        admin_finalize_delay_secs: Some(7200),
    }
}

#[test]
fn r42_admin_update_config_changes_config_fields() {
    let mut env = Env::initialized();
    let args = full_update(&env);
    let admin = env.admin.insecure_clone();
    let ix = env.ix_update_config(&admin.pubkey(), args.clone());
    assert_ok(env.send_one(ix, &admin));

    let c = env.config();
    assert_eq!(c.automation_authority, args.automation_authority.unwrap());
    assert_eq!(c.oracle_slots, args.oracle_slots.unwrap());
    assert_eq!(c.max_staleness_secs, 120);
    assert_eq!(c.max_conf_bps, 10);
    assert_eq!(c.admin_propose_delay_secs, 1200);
    assert_eq!(c.admin_finalize_delay_secs, 7200);
    // Not updatable through update_config.
    assert_eq!(c.admin, admin.pubkey());
    assert_eq!(c.usdc_mint, env.usdc_mint);
}

#[test]
fn r42_update_config_with_no_fields_changes_nothing() {
    let mut env = Env::initialized();
    let before = env.config();
    let admin = env.admin.insecure_clone();
    let ix = env.ix_update_config(&admin.pubkey(), UpdateConfigArgs::default());
    assert_ok(env.send_one(ix, &admin));
    assert_eq!(env.config(), before);
}

#[test]
fn r42_non_admin_cannot_update_config() {
    let mut env = Env::initialized();
    let before = env.config();
    for signer in [
        env.automation.insecure_clone(),
        env.upgrade_authority.insecure_clone(),
        Keypair::new(),
    ] {
        env.svm.airdrop(&signer.pubkey(), 1_000_000_000).unwrap();
        let ix = env.ix_update_config(&signer.pubkey(), full_update(&env));
        assert_meridian_err(env.send_one(ix, &signer), MeridianError::Unauthorized);
        assert_eq!(env.config(), before);
    }
}

#[test]
fn r42_update_config_takes_no_market_accounts() {
    let env = Env::initialized();
    let ix = env.ix_update_config(&env.admin.pubkey(), UpdateConfigArgs::default());
    let keys: Vec<_> = ix.accounts.iter().map(|a| a.pubkey).collect();
    assert_eq!(keys, vec![env.admin.pubkey(), config_pda()]);
}

#[test]
fn r42_update_config_leaves_existing_markets_untouched() {
    let mut env = Env::initialized();
    let m = env.create_market(STRIKE);
    env.set_time(T_MINT_OPEN + 60);
    let user = env.new_user(&m, 10);
    assert_ok(env.mint_pair(&user, &m, 2));
    let market_before = env.raw(&m.market);
    let day_before = env.raw(&m.ticker_day);

    let admin = env.admin.insecure_clone();
    let ix = env.ix_update_config(&admin.pubkey(), full_update(&env));
    assert_ok(env.send_one(ix, &admin));

    assert_eq!(env.raw(&m.market).data, market_before.data);
    assert_eq!(env.raw(&m.ticker_day).data, day_before.data);
    let market = env.market(&m);
    assert_eq!(market.strike, STRIKE);
    assert_eq!(market.close_ts, T_CLOSE);
    assert_eq!(market.status, MarketStatus::Open);
    assert_eq!(market.outcome, None);
}
