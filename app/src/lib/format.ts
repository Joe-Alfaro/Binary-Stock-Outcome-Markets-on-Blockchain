import type { ContractSummary } from './chain'

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const amount = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const MINUS = '−'

/** `231.42` → `$231.42`. */
export function formatUsd(dollars: number): string {
  return usd.format(dollars)
}

/** `40` → `$0.40`. */
export function formatCentsAsDollars(cents: number): string {
  return usd.format(cents / 100)
}

/** `62` → `62¢`. */
export function formatCents(cents: number): string {
  return `${cents}¢`
}

/** Signed P&L in cents: `+$0.50`, `−$1.20` or `$0.00`. */
export function formatPnl(cents: number): string {
  if (cents === 0) return usd.format(0)
  const sign = cents > 0 ? '+' : MINUS
  return `${sign}${usd.format(Math.abs(cents) / 100)}`
}

/** A signed whole number with a real minus sign: `7`, `−10`. */
export function formatSigned(value: number): string {
  if (value < 0) return `${MINUS}${Math.abs(value)}`
  return String(value)
}

/** USDC base units (6 decimals) → `1,234.56 USDC`. */
export function formatUsdc(baseUnits: number): string {
  return `${amount.format(baseUnits / 1_000_000)} USDC`
}

/** `AAPL $230.00`: how every page names one contract. */
export function contractLabel(contract: Pick<ContractSummary, 'ticker' | 'strike'>): string {
  return `${contract.ticker} ${formatUsd(contract.strike)}`
}

/** `Fq8m…Mt2N`. */
export function shortAddress(address: string): string {
  if (address.length <= 10) return address
  return `${address.slice(0, 4)}…${address.slice(-4)}`
}

const etParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
})

/**
 * Time of day in America/New_York, whatever the machine time zone: `10:19:30 AM ET`, or with the
 * date, `Oct 12, 10:19:30 AM ET`. Built from parts because ICU may put a narrow no-break space
 * before the day period.
 */
export function formatEt(unixSeconds: number, options: { date?: boolean } = {}): string {
  const parts = etParts.formatToParts(new Date(unixSeconds * 1000))
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? ''
  const time = `${part('hour')}:${part('minute')}:${part('second')} ${part('dayPeriod').toUpperCase()} ET`
  if (!options.date) return time
  return `${part('month')} ${part('day')}, ${time}`
}
