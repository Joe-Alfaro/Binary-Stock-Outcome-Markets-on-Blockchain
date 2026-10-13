import type { ChainPrice } from '../chain/index.js'

/** `{ price: 19000n, expo: -2 }` → `'190.00'`. Alert details stay JSON-serializable this way. */
export function formatPrice({ price, expo }: ChainPrice): string {
  if (expo >= 0) return (price * 10n ** BigInt(expo)).toString()
  const digits = (price < 0n ? -price : price).toString().padStart(-expo + 1, '0')
  const sign = price < 0n ? '-' : ''
  return `${sign}${digits.slice(0, expo)}.${digits.slice(expo)}`
}

/** True when two prices are the same value, whatever their exponents. */
export function samePrice(a: ChainPrice, b: ChainPrice): boolean {
  const expo = Math.min(a.expo, b.expo)
  return a.price * 10n ** BigInt(a.expo - expo) === b.price * 10n ** BigInt(b.expo - expo)
}

/** A USD amount from a price source as an exact decimal, to six places. */
export function usdToChainPrice(usd: number): ChainPrice {
  const [whole = '0', fraction = ''] = usd.toFixed(6).split('.')
  return { price: BigInt(whole + fraction), expo: -fraction.length }
}
