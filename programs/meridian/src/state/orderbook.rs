//! Order book types: one Yes-vs-USDC book per market (ARCHITECTURE.md §3.2, §3.7).
//!
//! Units: prices are whole cents from `MIN_PRICE` to `MAX_PRICE`, quantities are whole Yes
//! tokens (lot size `UNIT`), and seat balances are token base units.

use anchor_lang::prelude::*;

use super::{OrderBook, UNIT};
use crate::errors::MeridianError;

/// Resting orders per side.
pub const BOOK_SIDE_CAPACITY: usize = 32;
/// Trader seats per book.
pub const SEAT_CAPACITY: usize = 32;
/// Matches (fills plus self-trade cancels) per `place_order`.
pub const MAX_FILLS_PER_ORDER: usize = 16;
pub const MIN_PRICE: u8 = 1;
pub const MAX_PRICE: u8 = 99;
/// USDC base units per cent per whole token.
pub const USDC_PER_CENT: u64 = 10_000;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    /// Buy Yes with USDC.
    Bid,
    /// Sell Yes for USDC.
    Ask,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrderKind {
    /// Matches, then rests the remainder.
    Limit,
    /// Matches up to `price` as a worst price, never rests, returns unfilled escrow.
    Market,
    /// Rejected if it would cross; otherwise rests.
    PostOnly,
}

/// A resting order. A slot with `qty == 0` is empty.
#[zero_copy]
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Order {
    pub order_id: u64,
    /// Remaining whole tokens.
    pub qty: u64,
    /// Cents.
    pub price: u8,
    /// Index into `OrderBook::seats`.
    pub seat: u8,
    pub _padding: [u8; 6],
}

/// A trader's seat inside the book. A seat with `owner == Pubkey::default()` is free. Locked
/// amounts are derived from the owner's resting orders.
#[zero_copy]
#[derive(Debug, Default, PartialEq, Eq)]
pub struct OpenOrders {
    pub owner: Pubkey,
    /// Yes base units the owner can withdraw with `settle_funds`.
    pub free_yes: u64,
    /// USDC base units the owner can withdraw with `settle_funds`.
    pub free_usdc: u64,
}

impl Side {
    pub fn opposite(self) -> Side {
        match self {
            Side::Bid => Side::Ask,
            Side::Ask => Side::Bid,
        }
    }
}

/// Whether an incoming order on `taker_side` with limit `price` matches a resting order at
/// `resting_price`. Equal prices cross.
pub fn crosses(taker_side: Side, price: u8, resting_price: u8) -> bool {
    match taker_side {
        Side::Bid => resting_price <= price,
        Side::Ask => resting_price >= price,
    }
}

/// USDC base units for `qty` whole tokens at `price` cents.
pub fn usdc_amount(price: u8, qty: u64) -> Result<u64> {
    (price as u64)
        .checked_mul(USDC_PER_CENT)
        .and_then(|v| v.checked_mul(qty))
        .ok_or_else(|| error!(MeridianError::MathOverflow))
}

/// Yes base units for `qty` whole tokens.
pub fn yes_units(qty: u64) -> Result<u64> {
    qty.checked_mul(UNIT)
        .ok_or_else(|| error!(MeridianError::MathOverflow))
}

/// One fill against a resting order, for the `OrderFilled` event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BookFill {
    pub maker: Pubkey,
    pub maker_order_id: u64,
    /// Cents: the maker's price.
    pub price: u8,
    /// Whole tokens.
    pub qty: u64,
}

impl OrderBook {
    pub fn orders(&self, side: Side) -> &[Order; BOOK_SIDE_CAPACITY] {
        match side {
            Side::Bid => &self.bids,
            Side::Ask => &self.asks,
        }
    }

    fn orders_mut(&mut self, side: Side) -> &mut [Order; BOOK_SIDE_CAPACITY] {
        match side {
            Side::Bid => &mut self.bids,
            Side::Ask => &mut self.asks,
        }
    }

    pub fn find_seat(&self, owner: &Pubkey) -> Option<usize> {
        self.seats.iter().position(|s| s.owner == *owner)
    }

    /// The owner's seat, claiming a free one if it has none.
    fn seat_for(&mut self, owner: Pubkey) -> Result<usize> {
        if let Some(i) = self.find_seat(&owner) {
            return Ok(i);
        }
        let free = Pubkey::default();
        let i = self
            .find_seat(&free)
            .ok_or_else(|| error!(MeridianError::SeatsFull))?;
        self.seats[i].owner = owner;
        Ok(i)
    }

    /// Whether any resting order belongs to `seat`.
    pub fn seat_has_orders(&self, seat: usize) -> bool {
        self.bids
            .iter()
            .chain(self.asks.iter())
            .any(|o| o.qty > 0 && o.seat as usize == seat)
    }

    /// Index of the highest-priority resting order on `side`: best price, then lowest ID.
    pub fn best(&self, side: Side) -> Option<usize> {
        let mut best: Option<(usize, &Order)> = None;
        for (i, o) in self.orders(side).iter().enumerate() {
            if o.qty == 0 {
                continue;
            }
            let better = match best {
                None => true,
                Some((_, b)) => {
                    let better_price = match side {
                        Side::Bid => o.price > b.price,
                        Side::Ask => o.price < b.price,
                    };
                    better_price || (o.price == b.price && o.order_id < b.order_id)
                }
            };
            if better {
                best = Some((i, o));
            }
        }
        best.map(|(i, _)| i)
    }

    /// The best resting order on `side` if an incoming `taker_side` order at `price` crosses it.
    fn best_crossing(&self, side: Side, taker_side: Side, price: u8) -> Option<usize> {
        self.best(side)
            .filter(|&i| crosses(taker_side, price, self.orders(side)[i].price))
    }

    fn credit(&mut self, seat: usize, yes: u64, usdc: u64) -> Result<()> {
        let s = &mut self.seats[seat];
        s.free_yes = s
            .free_yes
            .checked_add(yes)
            .ok_or(MeridianError::MathOverflow)?;
        s.free_usdc = s
            .free_usdc
            .checked_add(usdc)
            .ok_or(MeridianError::MathOverflow)?;
        Ok(())
    }

    /// Credits what an order of `qty` at `price` on `side` locks to `seat`'s free balance.
    fn release(&mut self, side: Side, seat: usize, price: u8, qty: u64) -> Result<()> {
        match side {
            Side::Bid => self.credit(seat, 0, usdc_amount(price, qty)?),
            Side::Ask => self.credit(seat, yes_units(qty)?, 0),
        }
    }

    /// Matches an incoming order whose escrow is already in the vaults, then rests or returns
    /// the remainder. Every proceed and refund goes to a seat's free balance; no tokens move.
    pub fn place(
        &mut self,
        owner: Pubkey,
        side: Side,
        kind: OrderKind,
        price: u8,
        qty: u64,
    ) -> Result<Vec<BookFill>> {
        let taker = self.seat_for(owner)?;
        let resting_side = side.opposite();
        if kind == OrderKind::PostOnly {
            require!(
                self.best_crossing(resting_side, side, price).is_none(),
                MeridianError::PostOnlyWouldCross
            );
        }

        let mut fills = Vec::with_capacity(MAX_FILLS_PER_ORDER);
        let mut remaining = qty;
        let mut matches = 0;
        while remaining > 0 && matches < MAX_FILLS_PER_ORDER {
            let Some(i) = self.best_crossing(resting_side, side, price) else {
                break;
            };
            matches += 1;
            let maker = self.orders(resting_side)[i];
            let maker_seat = maker.seat as usize;
            if maker_seat == taker {
                // R20: cancel our own resting order and keep matching.
                self.orders_mut(resting_side)[i] = Order::default();
                self.release(resting_side, maker_seat, maker.price, maker.qty)?;
                continue;
            }
            let n = remaining.min(maker.qty);
            remaining -= n;
            if n == maker.qty {
                self.orders_mut(resting_side)[i] = Order::default();
            } else {
                self.orders_mut(resting_side)[i].qty -= n;
            }
            match side {
                Side::Bid => {
                    // R17: the taker pays the maker's price; the rest of its escrow is refunded.
                    self.credit(taker, yes_units(n)?, usdc_amount(price - maker.price, n)?)?;
                    self.credit(maker_seat, 0, usdc_amount(maker.price, n)?)?;
                }
                Side::Ask => {
                    self.credit(taker, 0, usdc_amount(maker.price, n)?)?;
                    self.credit(maker_seat, yes_units(n)?, 0)?;
                }
            }
            fills.push(BookFill {
                maker: self.seats[maker_seat].owner,
                maker_order_id: maker.order_id,
                price: maker.price,
                qty: n,
            });
        }

        if remaining > 0 {
            // A limit order that hit the fill cap while still crossing returns the rest rather
            // than resting on a crossed book.
            let rests = kind != OrderKind::Market
                && self.best_crossing(resting_side, side, price).is_none();
            if rests {
                let order_id = self.next_seq;
                self.next_seq = order_id.checked_add(1).ok_or(MeridianError::MathOverflow)?;
                let slot = self
                    .orders_mut(side)
                    .iter_mut()
                    .find(|o| o.qty == 0)
                    .ok_or_else(|| error!(MeridianError::BookSideFull))?;
                *slot = Order {
                    order_id,
                    qty: remaining,
                    price,
                    seat: taker as u8,
                    _padding: [0; 6],
                };
            } else {
                self.release(side, taker, price, remaining)?;
            }
        }
        Ok(fills)
    }

    /// Removes `owner`'s resting order `order_id` and credits its escrow to the free balance.
    pub fn cancel(&mut self, owner: &Pubkey, order_id: u64) -> Result<()> {
        for side in [Side::Bid, Side::Ask] {
            let Some(i) = self
                .orders(side)
                .iter()
                .position(|o| o.qty > 0 && o.order_id == order_id)
            else {
                continue;
            };
            let order = self.orders(side)[i];
            let seat = order.seat as usize;
            require!(
                self.seats[seat].owner == *owner,
                MeridianError::Unauthorized
            );
            self.orders_mut(side)[i] = Order::default();
            return self.release(side, seat, order.price, order.qty);
        }
        err!(MeridianError::OrderNotFound)
    }

    /// Zeroes `owner`'s free balances and returns them as (yes, usdc). Releases the seat when
    /// no resting order uses it.
    pub fn withdraw(&mut self, owner: &Pubkey) -> Result<(u64, u64)> {
        let seat = self
            .find_seat(owner)
            .ok_or_else(|| error!(MeridianError::NoSeat))?;
        let s = self.seats[seat];
        if self.seat_has_orders(seat) {
            self.seats[seat].free_yes = 0;
            self.seats[seat].free_usdc = 0;
        } else {
            self.seats[seat] = OpenOrders::default();
        }
        Ok((s.free_yes, s.free_usdc))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn book() -> Box<OrderBook> {
        Box::new(bytemuck::Zeroable::zeroed())
    }

    #[test]
    fn a_limit_order_stopped_by_the_fill_cap_while_crossing_returns_the_rest() {
        let mut b = book();
        let maker = Pubkey::new_unique();
        let taker = Pubkey::new_unique();
        let resting = MAX_FILLS_PER_ORDER as u64 + 2;
        for _ in 0..resting {
            b.place(maker, Side::Ask, OrderKind::Limit, 50, 1).unwrap();
        }

        let fills = b
            .place(taker, Side::Bid, OrderKind::Limit, 60, resting)
            .unwrap();

        assert_eq!(fills.len(), MAX_FILLS_PER_ORDER);
        assert!(b.bids.iter().all(|o| o.qty == 0), "no crossed resting bid");
        let seat = b.seats[b.find_seat(&taker).unwrap()];
        let filled = MAX_FILLS_PER_ORDER as u64;
        assert_eq!(seat.free_yes, filled * UNIT);
        // 10¢ improvement on the filled tokens plus the full 60¢ on the two returned ones.
        assert_eq!(
            seat.free_usdc,
            usdc_amount(10, filled).unwrap() + usdc_amount(60, 2).unwrap()
        );
    }

    #[test]
    fn a_limit_order_stopped_by_the_fill_cap_rests_once_the_book_no_longer_crosses() {
        let mut b = book();
        let maker = Pubkey::new_unique();
        let taker = Pubkey::new_unique();
        for _ in 0..MAX_FILLS_PER_ORDER {
            b.place(maker, Side::Ask, OrderKind::Limit, 50, 1).unwrap();
        }

        b.place(taker, Side::Bid, OrderKind::Limit, 60, 20).unwrap();

        let rested: Vec<_> = b.bids.iter().filter(|o| o.qty > 0).collect();
        assert_eq!(rested.len(), 1);
        assert_eq!((rested[0].price, rested[0].qty), (60, 4));
    }
}
