import type { RelayPublisher, RelayPublisherOptions } from './types.js'

/** `YYYY-MM-DD` to the `YYYYMMDD` number used as the close record's `trading_day` seed. */
export function tradingDayNumber(tradingDay: string): number {
  throw new Error(`not implemented: tradingDayNumber(${tradingDay})`)
}

/** The relay publisher for one signer: close records after `close_ts` and live prices. */
export function createRelayPublisher(options: RelayPublisherOptions): RelayPublisher {
  void options
  throw new Error('not implemented: createRelayPublisher')
}
