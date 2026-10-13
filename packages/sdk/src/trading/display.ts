import type { OutcomeSide } from './types.js'

export interface PayoffInput {
  side: OutcomeSide
  ticker: string
  /** Strike in dollars. */
  strike: number
  /** Price per token in cents of the side being bought. */
  priceCents: number
}

export interface Countdown {
  secondsLeft: number
  closed: boolean
  /** Remaining time, for example `2h 05m 09s`, or `Closed`. */
  text: string
  /** Close time in America/New_York, for example `4:00 PM ET`. */
  closesAt: string
}

const etTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
})

function centsToDollars(cents: number): string {
  const whole = Math.trunc(cents / 100)
  const rest = String(cents % 100).padStart(2, '0')
  return `$${whole}.${rest}`
}

function strikeToDollars(strike: number): string {
  return centsToDollars(Math.round(strike * 100))
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function payoffLine(input: PayoffInput): string {
  const direction = input.side === 'Yes' ? 'above' : 'below'
  return (
    `You pay ${centsToDollars(input.priceCents)}. ` +
    `You win $1.00 if ${input.ticker} closes ${direction} ${strikeToDollars(input.strike)}.`
  )
}

export function atStrikeNote(ticker: string, strike: number): string {
  return `If ${ticker} closes exactly at ${strikeToDollars(strike)}, the contract pays Yes.`
}

/** Countdown to `closeTs` (Unix seconds) from `nowTs` (Unix seconds). */
export function countdownToClose(closeTs: number, nowTs: number): Countdown {
  const secondsLeft = Math.max(0, Math.floor(closeTs - nowTs))
  const closed = secondsLeft === 0
  // Built from parts because ICU may separate the day period with a narrow no-break space.
  const parts = etTime.formatToParts(new Date(closeTs * 1000))
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? ''
  const closesAt = `${part('hour')}:${part('minute')} ${part('dayPeriod').toUpperCase()} ET`
  const hours = Math.floor(secondsLeft / 3600)
  const minutes = Math.floor((secondsLeft % 3600) / 60)
  const seconds = secondsLeft % 60
  const text = closed ? 'Closed' : `${hours}h ${pad2(minutes)}m ${pad2(seconds)}s`
  return { secondsLeft, closed, text, closesAt }
}
