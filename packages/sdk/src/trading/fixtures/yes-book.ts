import type { YesBook } from '../types.js'

/** Shared Yes book fixture: the web app renders both views from it and the R29 test checks them. */
export const yesBookFixture: YesBook = {
  bids: [
    { priceCents: 58, qty: 40 },
    { priceCents: 60, qty: 25 },
    { priceCents: 55, qty: 100 },
  ],
  asks: [
    { priceCents: 70, qty: 30 },
    { priceCents: 65, qty: 10 },
    { priceCents: 67, qty: 50 },
  ],
}
