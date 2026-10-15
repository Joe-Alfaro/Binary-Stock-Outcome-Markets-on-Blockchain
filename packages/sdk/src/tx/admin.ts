import { PublicKey } from '@solana/web3.js'
import type { VersionedTransaction } from '@solana/web3.js'
import { compile, programInstruction, readonly, writable } from './instructions.js'
import type { AdminContext, AdminTickerDay } from './types.js'

/*
 * R36, R41, R70: the admin's settlement and pause transactions. Each is one instruction, signed
 * and paid for by the admin, so the web app and the admin CLI need one signature per action.
 */

const encoder = new TextEncoder()
const TICKER_LEN = 8

/** Ticker padded with zero bytes to 8, as stored in accounts and seeds. */
function tickerBytes(ticker: string): Buffer {
  if (!/^[A-Z]{1,8}$/.test(ticker)) throw new RangeError(`invalid ticker: ${ticker}`)
  const bytes = Buffer.alloc(TICKER_LEN)
  bytes.write(ticker, 'ascii')
  return bytes
}

/** `2026-10-12` → `20261012`, the `trading_day` the program stores and seeds with. */
export function tradingDayNumber(tradingDay: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tradingDay)
  if (!match) throw new RangeError(`invalid trading day: ${tradingDay}`)
  return Number(`${match[1]}${match[2]}${match[3]}`)
}

function u32(value: number): Buffer {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(value)
  return buf
}

function i64(value: bigint): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeBigInt64LE(value)
  return buf
}

export function configAddress(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([encoder.encode('config')], programId)[0]
}

export function tickerDayAddress(programId: PublicKey, ticker: string, tradingDay: string) {
  return PublicKey.findProgramAddressSync(
    [encoder.encode('day'), tickerBytes(ticker), u32(tradingDayNumber(tradingDay))],
    programId,
  )[0]
}

function tickerDayArgs(day: AdminTickerDay): Buffer[] {
  return [tickerBytes(day.ticker), u32(tradingDayNumber(day.tradingDay))]
}

/** `propose_admin_price`: `priceCents` is the program's admin price scale (expo −2). */
export function buildProposeAdminPrice(
  ctx: AdminContext,
  day: AdminTickerDay & { priceCents: number },
): VersionedTransaction {
  if (!Number.isSafeInteger(day.priceCents) || day.priceCents <= 0) {
    throw new RangeError('the admin price must be a positive whole number of cents')
  }
  const ix = programInstruction(
    ctx.programId,
    'propose_admin_price',
    [
      readonly(ctx.owner, true),
      readonly(configAddress(ctx.programId)),
      writable(tickerDayAddress(ctx.programId, day.ticker, day.tradingDay)),
    ],
    [...tickerDayArgs(day), i64(BigInt(day.priceCents))],
  )
  return compile(ctx, [ix])
}

/** `finalize_admin_settle`: admin-only (D93), from `close_ts + admin_finalize_delay_secs`. */
export function buildFinalizeAdminSettle(
  ctx: AdminContext,
  day: AdminTickerDay,
): VersionedTransaction {
  const ix = programInstruction(
    ctx.programId,
    'finalize_admin_settle',
    [
      readonly(ctx.owner, true),
      readonly(configAddress(ctx.programId)),
      writable(tickerDayAddress(ctx.programId, day.ticker, day.tradingDay)),
    ],
    tickerDayArgs(day),
  )
  return compile(ctx, [ix])
}

/** `pause` when `paused` is true, else `unpause`. */
export function buildSetPaused(ctx: AdminContext, paused: boolean): VersionedTransaction {
  const ix = programInstruction(
    ctx.programId,
    paused ? 'pause' : 'unpause',
    [readonly(ctx.owner, true), writable(configAddress(ctx.programId))],
    [],
  )
  return compile(ctx, [ix])
}
