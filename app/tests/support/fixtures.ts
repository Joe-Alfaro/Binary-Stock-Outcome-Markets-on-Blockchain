import type { BookSide, ProgramEvent } from '@meridian/sdk'
import type { ContractSummary } from '../../src/lib/chain'

const utc = (iso: string) => Date.parse(iso) / 1000

/** Monday 2026-10-12, a regular day: 10:20:00 AM ET (EDT), close at 4:00 PM ET. */
export const REGULAR_NOW = utc('2026-10-12T14:20:00Z')
export const REGULAR_CLOSE = utc('2026-10-12T20:00:00Z')

/** Friday 2026-11-27, the early-close day after Thanksgiving: 11:00 AM ET (EST), close at 1:00 PM ET. */
export const EARLY_NOW = utc('2026-11-27T16:00:00Z')
export const EARLY_CLOSE = utc('2026-11-27T18:00:00Z')

export function contract(
  overrides: Partial<ContractSummary> & Pick<ContractSummary, 'market' | 'strike'>,
): ContractSummary {
  return {
    ticker: 'AAPL',
    closeTs: REGULAR_CLOSE,
    status: 'Open',
    demo: false,
    yesPriceCents: 62,
    settlement: null,
    ...overrides,
  }
}

export function fill(
  market: string,
  signature: string,
  maker: string,
  taker: string,
  takerSide: BookSide,
  priceCents: number,
  qty: number,
): ProgramEvent {
  return {
    kind: 'OrderFilled',
    signature,
    ts: REGULAR_NOW,
    market,
    maker,
    taker,
    makerOrderId: `o-${signature}`,
    takerSide,
    priceCents,
    qty,
  }
}

export function mint(market: string, signature: string, owner: string, qty: number): ProgramEvent {
  return { kind: 'PairMinted', signature, ts: REGULAR_NOW, market, owner, qty }
}

export function merge(market: string, signature: string, owner: string, qty: number): ProgramEvent {
  return { kind: 'PairMerged', signature, ts: REGULAR_NOW, market, owner, qty }
}
