import type { NormalizedPrice } from '@meridian/price-providers'
import { errorMessage, valueFields } from './log.js'
import type { RelayLogEntry } from './log.js'
import type { CloseOutcome, CloseShape, RelayPublisherOptions } from './types.js'

/** How long after `close_ts` the relay waits for an official close before other shapes (§5.4). */
export const OFFICIAL_CLOSE_WAIT_SECS = 180
/** Poll interval of the close sequence. */
export const CLOSE_POLL_SECS = 30

export interface CloseContext extends Pick<
  RelayPublisherOptions,
  'oracle' | 'source' | 'tickers' | 'clock'
> {
  log: (entry: RelayLogEntry) => void
}

/** `YYYY-MM-DD` to the `YYYYMMDD` number used as the close record's `trading_day` seed. */
export function tradingDayNumber(tradingDay: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tradingDay)
  if (!match) throw new RangeError(`malformed trading day ${JSON.stringify(tradingDay)}`)
  return Number(`${match[1]}${match[2]}${match[3]}`)
}

/** The shape `publish_close` would infer from these updates, or null if it would reject them. */
function shapeOf(updates: NormalizedPrice[], closeTs: number): CloseShape | null {
  const [first, second, ...rest] = updates
  if (first === undefined || rest.length > 0) return null
  if (second !== undefined) {
    return first.publishTime < closeTs && closeTs < second.publishTime ? 'interpolation' : null
  }
  if (first.officialClose) return 'official'
  return first.publishTime === closeTs ? 'exact' : null
}

/** One attempt at a ticker's close record. Never throws: failures come back as `error`. */
export async function publishClose(
  context: CloseContext,
  ticker: string,
  tradingDay: string,
  closeTs: number,
): Promise<CloseOutcome> {
  const { oracle, source, clock, log } = context
  const day = tradingDayNumber(tradingDay)
  if (clock.now() < closeTs) return { ticker, status: 'too-early' }
  try {
    if (await oracle.closeRecordExists(ticker, day)) return { ticker, status: 'already-published' }
    const inputs = await source.prepareClose(ticker, closeTs)
    const shape = inputs && shapeOf(inputs.updates, closeTs)
    if (!inputs || !shape) return { ticker, status: 'pending' }
    // The record is write-once, so a fallback shape waits for the official close first.
    if (shape !== 'official' && clock.now() < closeTs + OFFICIAL_CLOSE_WAIT_SECS) {
      return { ticker, status: 'pending' }
    }
    const common = { source: source.name, signer: oracle.signer }
    await inputs.updates.reduce(async (previous, update) => {
      await previous
      // A crash between publish_price and publish_close leaves the update on-chain already.
      if (await oracle.priceUpdateExists(ticker, update.publishTime)) return
      const signature = await oracle.publishPrice(update)
      log({ event: 'price-published', ...valueFields(update), ...common, signature })
    }, Promise.resolve())
    const signature = await oracle.publishClose({
      ticker,
      tradingDay: day,
      closeTs,
      updates: inputs.updates,
    })
    log({ event: 'close-published', ticker, tradingDay: day, closeTs, shape, ...common, signature })
    return { ticker, status: 'published', shape }
  } catch (error) {
    log({ event: 'close-error', ticker, tradingDay: day, closeTs, error: errorMessage(error) })
    return { ticker, status: 'error' }
  }
}

function isDone(outcome: CloseOutcome): boolean {
  return outcome.status === 'published' || outcome.status === 'already-published'
}

/**
 * Polls every unfinished ticker every 30 s from `closeTs` until each has a close record or the
 * next poll would fall after `deadlineTs`. Tickers are attempted concurrently, so one slow or
 * failing ticker delays no other.
 */
export async function runCloses(
  context: CloseContext,
  tradingDay: string,
  closeTs: number,
  deadlineTs: number,
): Promise<CloseOutcome[]> {
  const { clock, tickers } = context
  if (clock.now() < closeTs) await clock.sleep(closeTs - clock.now())
  const latest = new Map<string, CloseOutcome>()

  async function poll(pending: readonly string[]): Promise<void> {
    const outcomes = await Promise.all(
      pending.map((ticker) => publishClose(context, ticker, tradingDay, closeTs)),
    )
    outcomes.forEach((outcome) => latest.set(outcome.ticker, outcome))
    const remaining = outcomes.filter((outcome) => !isDone(outcome)).map(({ ticker }) => ticker)
    if (remaining.length === 0 || clock.now() + CLOSE_POLL_SECS > deadlineTs) return
    await clock.sleep(CLOSE_POLL_SECS)
    await poll(remaining)
  }

  await poll(tickers)
  return tickers.map((ticker) => latest.get(ticker) ?? { ticker, status: 'pending' })
}
