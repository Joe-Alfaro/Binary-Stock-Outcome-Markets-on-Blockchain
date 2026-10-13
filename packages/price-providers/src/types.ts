/** A price observation for one ticker at one point in time. */
export interface PricePoint {
  ticker: string
  /** Price in USD. */
  price: number
  /** Unix timestamp in seconds. */
  timestamp: number
}

/** A source of stock prices that a relay slot can publish from. */
export interface PriceProvider {
  readonly name: string
  getLatestPrice(ticker: string): Promise<PricePoint>
}
