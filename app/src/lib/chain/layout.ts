import type { BookLevel, OutcomeSide, ProgramEvent, YesBook } from '@meridian/sdk'
import { PublicKey } from '@solana/web3.js'
import type { SettlementSource } from './types'

/**
 * Byte layouts of the `meridian` and `meridian_oracle` accounts and events the app reads, decoded
 * without an IDL so the app doesn't depend on `anchor build` output. Anchor accounts are Borsh
 * after an 8-byte discriminator (`sha256("account:<Name>")[..8]`); `OrderBook` is zero-copy
 * (`repr(C)`). Discriminators are checked against their hash in `tests/lib/layout.test.ts`.
 */
export const DISCRIMINATORS = {
  Market: [219, 190, 213, 55, 0, 227, 198, 154],
  OrderBook: [55, 230, 125, 218, 149, 39, 65, 248],
  Config: [155, 12, 170, 224, 30, 250, 204, 130],
  TickerDay: [140, 217, 51, 148, 18, 80, 48, 168],
  LatestPrice: [37, 138, 32, 102, 133, 25, 241, 164],
} as const

export const EVENT_DISCRIMINATORS = {
  OrderFilled: [120, 124, 109, 66, 249, 116, 174, 30],
  PairMinted: [24, 66, 202, 249, 156, 196, 33, 51],
  PairMerged: [122, 77, 149, 132, 211, 248, 245, 212],
  Redeemed: [14, 29, 183, 71, 31, 165, 107, 38],
  MarketSettled: [237, 212, 22, 175, 201, 117, 215, 99],
} as const

/** `emit_cpi!` prefixes the self-CPI data with `EVENT_IX_TAG` (0x1d9acb512ea545e4) little-endian. */
export const EVENT_IX_TAG = [228, 69, 165, 46, 81, 203, 154, 29] as const

export const TICKER_LEN = 8
export const UNIT = 1_000_000

export function startsWith(data: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  return prefix.every((byte, i) => data[offset + i] === byte)
}

/** Sequential little-endian Borsh reader. */
export class Reader {
  private offset: number
  private readonly view: DataView

  constructor(
    private readonly data: Uint8Array,
    offset = 0,
  ) {
    this.offset = offset
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  }

  skip(bytes: number): this {
    this.offset += bytes
    return this
  }

  u8(): number {
    const value = this.view.getUint8(this.offset)
    this.offset += 1
    return value
  }

  bool(): boolean {
    return this.u8() !== 0
  }

  u32(): number {
    const value = this.view.getUint32(this.offset, true)
    this.offset += 4
    return value
  }

  i32(): number {
    const value = this.view.getInt32(this.offset, true)
    this.offset += 4
    return value
  }

  u64(): bigint {
    const value = this.view.getBigUint64(this.offset, true)
    this.offset += 8
    return value
  }

  i64(): bigint {
    const value = this.view.getBigInt64(this.offset, true)
    this.offset += 8
    return value
  }

  pubkey(): PublicKey {
    const key = new PublicKey(this.data.subarray(this.offset, this.offset + 32))
    this.offset += 32
    return key
  }

  ticker(): string {
    const bytes = this.data.subarray(this.offset, this.offset + TICKER_LEN)
    this.offset += TICKER_LEN
    return String.fromCharCode(...bytes.filter((b) => b !== 0))
  }
}

/** Ticker padded with zero bytes to 8, as stored in accounts and seeds. */
export function tickerBytes(ticker: string): Uint8Array {
  const bytes = new Uint8Array(TICKER_LEN)
  ;[...ticker].forEach((char, i) => {
    bytes[i] = char.charCodeAt(0)
  })
  return bytes
}

/** `value × 10^expo` as a JS number. */
export function scaled(value: bigint, expo: number): number {
  return Number(value) * 10 ** expo
}

export interface MarketAccount {
  ticker: string
  tradingDay: number
  strike: bigint
  strikeExpo: number
  closeTs: number
  mintOpenTs: number
  tradingOpenTs: number
  yesMint: PublicKey
  noMint: PublicKey
  vault: PublicKey
  book: PublicKey
  settled: boolean
  outcome: OutcomeSide | null
  settlePrice: bigint
  settleSource: SettlementSource | null
  demo: boolean
}

const SETTLE_SOURCES: (SettlementSource | null)[] = [null, 'Oracle', 'Oracle', 'Admin']

export function decodeMarket(data: Uint8Array): MarketAccount {
  if (!startsWith(data, DISCRIMINATORS.Market)) throw new Error('not a Market account')
  const r = new Reader(data, 8)
  const ticker = r.ticker()
  const tradingDay = r.u32()
  const strike = r.i64()
  const strikeExpo = r.i32()
  const closeTs = Number(r.i64())
  const mintOpenTs = Number(r.i64())
  const tradingOpenTs = Number(r.i64())
  r.skip(32) // ticker_day
  const yesMint = r.pubkey()
  const noMint = r.pubkey()
  const vault = r.pubkey()
  const book = r.pubkey()
  r.skip(16) // collateral, pairs_outstanding
  const settled = r.u8() === 1
  const hasOutcome = r.bool()
  const outcomeTag = hasOutcome ? r.u8() : null
  const settlePrice = r.i64()
  const settleSource = SETTLE_SOURCES[r.u8()] ?? null
  const demo = r.bool()
  let outcome: OutcomeSide | null = null
  if (outcomeTag !== null) outcome = outcomeTag === 0 ? 'Yes' : 'No'
  return {
    ticker,
    tradingDay,
    strike,
    strikeExpo,
    closeTs,
    mintOpenTs,
    tradingOpenTs,
    yesMint,
    noMint,
    vault,
    book,
    settled,
    outcome,
    settlePrice,
    settleSource,
    demo,
  }
}

export function decodeConfigUsdcMint(data: Uint8Array): PublicKey {
  if (!startsWith(data, DISCRIMINATORS.Config)) throw new Error('not a Config account')
  return new Reader(data, 8 + 32 + 32).pubkey()
}

/** `OracleSlot`: kind (1), relay signer (32), 7 feed IDs (32 each), verifier (32), level (1). */
const ORACLE_SLOT_SIZE = 1 + 32 + 7 * 32 + 32 + 1

/** The `Config` fields the Admin page reads (R70). */
export interface ConfigAdminFields {
  admin: PublicKey
  proposeDelaySecs: number
  finalizeDelaySecs: number
  paused: boolean
}

export function decodeConfigAdmin(data: Uint8Array): ConfigAdminFields {
  if (!startsWith(data, DISCRIMINATORS.Config)) throw new Error('not a Config account')
  const r = new Reader(data, 8)
  const admin = r.pubkey()
  // automation_authority, usdc_mint, tickers[7], oracle_slots[2], max_staleness, max_conf_bps
  r.skip(32 + 32 + 7 * TICKER_LEN + 2 * ORACLE_SLOT_SIZE + 4 + 2)
  const proposeDelaySecs = r.u32()
  const finalizeDelaySecs = r.u32()
  const paused = r.bool()
  return { admin, proposeDelaySecs, finalizeDelaySecs, paused }
}

export interface TickerDayAccount {
  ticker: string
  /** `YYYYMMDD`. */
  tradingDay: number
  closeTs: number
  final: boolean
  /** Whole cents (expo −2), or `null` when none is pending. */
  pendingAdminPriceCents: bigint | null
}

export function decodeTickerDay(data: Uint8Array): TickerDayAccount {
  if (!startsWith(data, DISCRIMINATORS.TickerDay)) throw new Error('not a TickerDay account')
  const r = new Reader(data, 8)
  const ticker = r.ticker()
  const tradingDay = r.u32()
  const closeTs = Number(r.i64())
  const final = r.u8() === 1
  r.skip(8 + 4 + 1) // settle_price, settle_expo, settle_source
  const pendingAdminPrice = r.i64()
  const pendingAdminAt = r.i64()
  return {
    ticker,
    tradingDay,
    closeTs,
    final,
    pendingAdminPriceCents: pendingAdminAt === 0n ? null : pendingAdminPrice,
  }
}

export interface LatestPriceAccount {
  ticker: string
  price: number
  publishTs: number
}

export function decodeLatestPrice(data: Uint8Array): LatestPriceAccount {
  if (!startsWith(data, DISCRIMINATORS.LatestPrice)) throw new Error('not a LatestPrice account')
  const r = new Reader(data, 8).skip(32)
  const ticker = r.ticker()
  const price = r.i64()
  r.skip(8) // conf
  const expo = r.i32()
  const publishTs = Number(r.i64())
  return { ticker, price: scaled(price, expo), publishTs }
}

/** Zero-copy `OrderBook` layout (`state.rs`, `state/orderbook.rs`). */
const BOOK_SIDE_CAPACITY = 32
const SEAT_CAPACITY = 32
const ORDER_SIZE = 24
const SEAT_SIZE = 48
const BOOK_HEADER = 8 + 32 * 3 + 8 + 8
const BIDS_OFFSET = BOOK_HEADER
const ASKS_OFFSET = BIDS_OFFSET + BOOK_SIDE_CAPACITY * ORDER_SIZE
const SEATS_OFFSET = ASKS_OFFSET + BOOK_SIDE_CAPACITY * ORDER_SIZE
export const ORDER_BOOK_SIZE = SEATS_OFFSET + SEAT_CAPACITY * SEAT_SIZE

export interface RestingOrder {
  orderId: bigint
  qty: number
  priceCents: number
  seat: number
}

export interface Seat {
  owner: PublicKey
  freeYes: bigint
  freeUsdc: bigint
}

export interface OrderBookAccount {
  market: PublicKey
  yesEscrow: PublicKey
  usdcEscrow: PublicKey
  bids: RestingOrder[]
  asks: RestingOrder[]
  seats: Seat[]
}

function readOrders(data: Uint8Array, offset: number): RestingOrder[] {
  return Array.from({ length: BOOK_SIDE_CAPACITY }, (_, i) => {
    const r = new Reader(data, offset + i * ORDER_SIZE)
    const orderId = r.u64()
    const qty = Number(r.u64())
    const priceCents = r.u8()
    const seat = r.u8()
    return { orderId, qty, priceCents, seat }
  }).filter((order) => order.qty > 0)
}

export function decodeOrderBook(data: Uint8Array): OrderBookAccount {
  if (!startsWith(data, DISCRIMINATORS.OrderBook)) throw new Error('not an OrderBook account')
  const r = new Reader(data, 8)
  const market = r.pubkey()
  const yesEscrow = r.pubkey()
  const usdcEscrow = r.pubkey()
  const seats = Array.from({ length: SEAT_CAPACITY }, (_, i) => {
    const s = new Reader(data, SEATS_OFFSET + i * SEAT_SIZE)
    return { owner: s.pubkey(), freeYes: s.u64(), freeUsdc: s.u64() }
  })
  return {
    market,
    yesEscrow,
    usdcEscrow,
    bids: readOrders(data, BIDS_OFFSET),
    asks: readOrders(data, ASKS_OFFSET),
    seats,
  }
}

function levels(orders: readonly RestingOrder[]): BookLevel[] {
  const byPrice = new Map<number, number>()
  orders.forEach((o) => byPrice.set(o.priceCents, (byPrice.get(o.priceCents) ?? 0) + o.qty))
  return [...byPrice].map(([priceCents, qty]) => ({ priceCents, qty }))
}

/** Resting orders aggregated per price, best first. */
export function toYesBook(book: OrderBookAccount): YesBook {
  return {
    bids: levels(book.bids).sort((a, b) => b.priceCents - a.priceCents),
    asks: levels(book.asks).sort((a, b) => a.priceCents - b.priceCents),
  }
}

type EventMeta = { signature: string; ts: number }

/** Decodes one event body (discriminator first). Unknown events give `null`. */
export function decodeEvent(data: Uint8Array, meta: EventMeta): ProgramEvent | null {
  const r = new Reader(data, 8)
  const base = { signature: meta.signature, ts: meta.ts }
  if (startsWith(data, EVENT_DISCRIMINATORS.OrderFilled)) {
    const market = r.pubkey().toBase58()
    const maker = r.pubkey().toBase58()
    const taker = r.pubkey().toBase58()
    const makerOrderId = r.u64().toString()
    const takerSide = r.u8() === 0 ? 'Bid' : 'Ask'
    const priceCents = r.u8()
    const qty = Number(r.u64())
    const ts = Number(r.i64())
    return {
      kind: 'OrderFilled',
      ...base,
      ts,
      market,
      maker,
      taker,
      makerOrderId,
      takerSide,
      priceCents,
      qty,
    }
  }
  if (startsWith(data, EVENT_DISCRIMINATORS.PairMinted)) {
    const market = r.pubkey().toBase58()
    const owner = r.pubkey().toBase58()
    return { kind: 'PairMinted', ...base, market, owner, qty: Number(r.u64()) }
  }
  if (startsWith(data, EVENT_DISCRIMINATORS.PairMerged)) {
    const market = r.pubkey().toBase58()
    const owner = r.pubkey().toBase58()
    return { kind: 'PairMerged', ...base, market, owner, qty: Number(r.u64()) }
  }
  if (startsWith(data, EVENT_DISCRIMINATORS.Redeemed)) {
    const market = r.pubkey().toBase58()
    const owner = r.pubkey().toBase58()
    const yesQty = Number(r.u64()) / UNIT
    const noQty = Number(r.u64()) / UNIT
    return { kind: 'Redeemed', ...base, market, owner, yesQty, noQty }
  }
  if (startsWith(data, EVENT_DISCRIMINATORS.MarketSettled)) {
    const market = r.pubkey().toBase58()
    r.skip(TICKER_LEN + 4 + 8)
    const outcome = r.u8() === 0 ? 'Yes' : 'No'
    return { kind: 'MarketSettled', ...base, market, outcome }
  }
  return null
}

/** Events in a transaction's `Program data:` logs (`emit!`). */
export function eventsFromLogs(logs: readonly string[], meta: EventMeta): ProgramEvent[] {
  return logs
    .filter((line) => line.startsWith('Program data: '))
    .map((line) => decodeEvent(base64ToBytes(line.slice('Program data: '.length)), meta))
    .filter((event): event is ProgramEvent => event !== null)
}

/** An `emit_cpi!` event from a self-CPI's instruction data, or `null`. */
export function eventFromCpiData(data: Uint8Array, meta: EventMeta): ProgramEvent | null {
  if (!startsWith(data, EVENT_IX_TAG)) return null
  return decodeEvent(data.subarray(EVENT_IX_TAG.length), meta)
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Base58 decode, for compiled instruction data in JSON transaction responses. */
export function base58ToBytes(text: string): Uint8Array {
  const bytes: number[] = []
  ;[...text].forEach((char) => {
    let carry = BASE58.indexOf(char)
    if (carry < 0) throw new Error('invalid base58')
    bytes.forEach((byte, i) => {
      carry += byte * 58
      bytes[i] = carry & 0xff
      carry >>= 8
    })
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  })
  const zeros = text.length - text.replace(/^1+/, '').length
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes.reverse()])
}
