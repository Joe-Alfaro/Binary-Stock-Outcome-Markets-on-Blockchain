import type { ChainPrice, OracleKind, OracleSlot } from './types.js'

const TICKER_BYTES = 8
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Strikes are whole cents on-chain (`strike × 10^-2`), the same exponent as admin prices. */
export const STRIKE_EXPO = -2
/** `ADMIN_PRICE_EXPO` in the program: admin prices are whole cents. */
export const ADMIN_PRICE_EXPO = -2

/**
 * `Market` account layout after the 8-byte discriminator (programs/meridian/src/state.rs):
 * ticker `[u8; 8]`, trading_day u32, strike i64, strike_expo i32, three i64 times, five pubkeys,
 * collateral u64 and pairs_outstanding u64, then the `status` enum byte.
 */
export const MARKET_TICKER_OFFSET = 8
export const MARKET_TRADING_DAY_OFFSET = 16
export const MARKET_STATUS_OFFSET = 232
export const MARKET_STATUS_OPEN = 0

/** A ticker as the program's `[u8; 8]`: ASCII, right-padded with zero bytes. */
export function tickerBytes(ticker: string): Uint8Array {
  if (!/^[A-Z0-9.]{1,8}$/.test(ticker)) throw new RangeError(`ticker ${ticker} is not 1-8 ASCII`)
  const bytes = new Uint8Array(TICKER_BYTES)
  bytes.set(encoder.encode(ticker))
  return bytes
}

export function tickerFromBytes(bytes: ArrayLike<number>): string {
  const all = Uint8Array.from(bytes)
  const end = all.indexOf(0)
  return decoder.decode(end === -1 ? all : all.subarray(0, end))
}

/** `2026-11-02` → `20261102`, the program's `trading_day`. */
export function tradingDayNumber(tradingDay: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradingDay)) {
    throw new RangeError(`trading day ${tradingDay} is not YYYY-MM-DD`)
  }
  return Number(tradingDay.replaceAll('-', ''))
}

/** `20261102` → `2026-11-02`. */
export function tradingDayString(day: number): string {
  const digits = String(day).padStart(8, '0')
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
}

export function u32Le(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, true)
  return bytes
}

export function i64Le(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigInt64(0, value, true)
  return bytes
}

/** Whole dollars as the on-chain strike at `STRIKE_EXPO`. */
export function scaleStrike(dollars: bigint): bigint {
  return dollars * 10n ** BigInt(-STRIKE_EXPO)
}

/** An on-chain strike as whole dollars; cents from an `add_strike` market are truncated. */
export function strikeDollars(strike: bigint, expo: number): bigint {
  if (expo >= 0) return strike * 10n ** BigInt(expo)
  return strike / 10n ** BigInt(-expo)
}

/** A price at the admin exponent, or a `RangeError` when it has finer precision. */
export function toAdminPrice({ price, expo }: ChainPrice): bigint {
  if (expo >= ADMIN_PRICE_EXPO) return price * 10n ** BigInt(expo - ADMIN_PRICE_EXPO)
  const divisor = 10n ** BigInt(ADMIN_PRICE_EXPO - expo)
  if (price % divisor !== 0n) throw new RangeError('an admin price must be whole cents')
  return price / divisor
}

/** The automation's slots are 1 and 2; the program indexes `Config.oracle_slots` from 0. */
export function programSlot(slot: OracleSlot): number {
  return slot - 1
}

const ORACLE_KINDS: Record<string, OracleKind> = {
  disabled: 'Disabled',
  meridianRelay: 'MeridianRelay',
  pyth: 'Pyth',
  chainlinkDataStreams: 'ChainlinkDataStreams',
}

/** The single key of an Anchor-decoded enum, such as `{ meridianRelay: {} }`. */
function variant(value: object): string {
  const [key] = Object.keys(value)
  if (key === undefined) throw new Error('empty enum value')
  return key
}

export function oracleKind(value: object): OracleKind {
  const kind = ORACLE_KINDS[variant(value)]
  if (!kind) throw new Error(`unknown oracle kind ${variant(value)}`)
  return kind
}

/** A `SettleSource` as the automation's source: slot 1 or 2, or the admin price. */
export function settleSource(value: object): OracleSlot | 'admin' {
  const name = variant(value)
  if (name === 'oracleSlot0') return 1
  if (name === 'oracleSlot1') return 2
  if (name === 'admin') return 'admin'
  throw new Error(`no settle source (${name})`)
}

export function isVariant(value: object, name: string): boolean {
  return variant(value) === name
}
