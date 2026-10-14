/** Whether a price was observed inside the regular trading session (09:30 to close_ts ET). */
export type Session = 'regular' | 'outside-regular'

/**
 * One price update in the shape every source is normalized to, mirroring the on-chain
 * `NormalizedPrice`. The value is `price × 10^expo`; `conf` uses the same scale.
 */
export interface NormalizedPrice {
  ticker: string
  price: bigint
  conf: bigint
  expo: number
  /** Unix timestamp in seconds. */
  publishTime: number
  session: Session
  /** True only for a source's official daily close. */
  officialClose: boolean
}

/** The updates a provider would publish for one ticker's close. */
export interface SettlementInputs {
  ticker: string
  closeTs: number
  updates: NormalizedPrice[]
}

/** A daily close used to compute strikes. */
export interface PreviousClose {
  ticker: string
  /** Price in USD. */
  price: number
  /** Trading day the close belongs to, `YYYY-MM-DD` in America/New_York. */
  tradingDay: string
}

/** A source of stock prices that an oracle slot can settle from. */
export interface PriceProvider {
  readonly name: string
  /**
   * The updates for this ticker's close, or null when no valid closing-price shape exists yet
   * (for example before the regular session has ended).
   */
  prepareClose(ticker: string, closeTs: number): Promise<SettlementInputs | null>
  /**
   * The close of `previousTradingDay`. Rejects with a `stale` PriceSourceError when the source's
   * latest close is dated before that day.
   */
  previousClose(ticker: string, previousTradingDay: string): Promise<PreviousClose>
}

/** A source of the current regular-session price, for the display-only latest-price accounts. */
export interface LivePriceProvider {
  readonly name: string
  /** The latest regular-session price, or null when the source has none for today's session. */
  latest(ticker: string): Promise<NormalizedPrice | null>
}

/** One point of an intraday price series: a 1-minute bar's close. */
export interface IntradayPoint {
  /** Bar start, Unix seconds. */
  t: number
  /** Price in USD. */
  price: number
}

/** A source of 1-minute regular-session bars, for the display-only Markets chart (R66). */
export interface IntradayPriceProvider {
  readonly name: string
  /**
   * The regular-session 1-minute closes with `fromTs <= t <= toTs`, oldest first, skipping
   * minutes without a close. Rejects with a PriceSourceError, `rate-limited` on HTTP 429.
   */
  intraday(ticker: string, fromTs: number, toTs: number): Promise<IntradayPoint[]>
}
