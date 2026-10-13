//! `place_order`, `cancel_order` and `settle_funds` (ARCHITECTURE.md §3.3, §3.7).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::MeridianError;
use crate::events::OrderFilled;
use crate::state::*;

/// Escrows `price × qty` USDC (bid) or `qty` Yes (ask) from the owner's wallet into the book's
/// escrow vaults, matches at the maker's price and credits both seats.
#[event_cpi]
#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(has_one = book)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut)]
    pub book: AccountLoader<'info, OrderBook>,
    #[account(mut, seeds = [YES_ESCROW_SEED, market.key().as_ref()], bump)]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [USDC_ESCROW_SEED, market.key().as_ref()], bump)]
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = owner)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.yes_mint, token::authority = owner)]
    pub user_yes: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Only the order's owner. Moves escrow to the owner's free balance; no tokens move.
#[derive(Accounts)]
pub struct CancelOrder<'info> {
    pub owner: Signer<'info>,
    #[account(has_one = book)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut)]
    pub book: AccountLoader<'info, OrderBook>,
}

/// Withdraws the owner's free Yes and USDC from the escrow vaults. Allowed at any time.
#[derive(Accounts)]
pub struct SettleFunds<'info> {
    pub owner: Signer<'info>,
    #[account(has_one = book)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut)]
    pub book: AccountLoader<'info, OrderBook>,
    #[account(mut, seeds = [YES_ESCROW_SEED, market.key().as_ref()], bump)]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [USDC_ESCROW_SEED, market.key().as_ref()], bump)]
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.yes_mint, token::authority = owner)]
    pub user_yes: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_escrow.mint, token::authority = owner)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_place_order(
    ctx: Context<PlaceOrder>,
    side: Side,
    kind: OrderKind,
    price: u8,
    qty: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let market = &ctx.accounts.market;
    require!(!ctx.accounts.config.paused, MeridianError::Paused);
    require!(now >= market.trading_open_ts, MeridianError::TradingNotOpen);
    require!(now < market.close_ts, MeridianError::MarketClosed);
    require!(
        market.status == MarketStatus::Open,
        MeridianError::MarketSettled
    );
    require!(
        (MIN_PRICE..=MAX_PRICE).contains(&price),
        MeridianError::InvalidPrice
    );
    require!(qty > 0, MeridianError::ZeroAmount);

    let accounts = &ctx.accounts;
    let (from, to, amount) = match side {
        Side::Bid => (
            &accounts.user_usdc,
            &accounts.usdc_escrow,
            usdc_amount(price, qty)?,
        ),
        Side::Ask => (&accounts.user_yes, &accounts.yes_escrow, yes_units(qty)?),
    };
    token::transfer(
        CpiContext::new(
            accounts.token_program.key(),
            Transfer {
                from: from.to_account_info(),
                to: to.to_account_info(),
                authority: accounts.owner.to_account_info(),
            },
        ),
        amount,
    )?;

    let taker = accounts.owner.key();
    let fills = accounts
        .book
        .load_mut()?
        .place(taker, side, kind, price, qty)?;
    let market = accounts.market.key();
    for fill in fills {
        emit_cpi!(OrderFilled {
            market,
            maker: fill.maker,
            taker,
            maker_order_id: fill.maker_order_id,
            taker_side: side,
            price: fill.price,
            qty: fill.qty,
            ts: now,
        });
    }
    Ok(())
}

pub fn handle_cancel_order(ctx: Context<CancelOrder>, order_id: u64) -> Result<()> {
    ctx.accounts
        .book
        .load_mut()?
        .cancel(&ctx.accounts.owner.key(), order_id)
}

pub fn handle_settle_funds(ctx: Context<SettleFunds>) -> Result<()> {
    let accounts = &ctx.accounts;
    // The book signs the transfers below, so its data must not stay borrowed during the CPIs.
    let ((yes, usdc), bump) = {
        let mut book = accounts.book.load_mut()?;
        (book.withdraw(&accounts.owner.key())?, book.bump)
    };
    let market = accounts.market.key();
    let seeds: &[&[u8]] = &[BOOK_SEED, market.as_ref(), &[bump]];
    for (from, to, amount) in [
        (&accounts.yes_escrow, &accounts.user_yes, yes),
        (&accounts.usdc_escrow, &accounts.user_usdc, usdc),
    ] {
        if amount == 0 {
            continue;
        }
        token::transfer(
            CpiContext::new_with_signer(
                accounts.token_program.key(),
                Transfer {
                    from: from.to_account_info(),
                    to: to.to_account_info(),
                    authority: accounts.book.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
    }
    Ok(())
}
