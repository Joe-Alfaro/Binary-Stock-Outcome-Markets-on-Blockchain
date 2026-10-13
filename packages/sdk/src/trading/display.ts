/* eslint-disable @typescript-eslint/no-unused-vars -- stubs until the implementation lands */
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

export function payoffLine(_input: PayoffInput): string {
  throw new Error('not implemented')
}

export function atStrikeNote(_ticker: string, _strike: number): string {
  throw new Error('not implemented')
}

/** Countdown to `closeTs` (Unix seconds) from `nowTs` (Unix seconds). */
export function countdownToClose(_closeTs: number, _nowTs: number): Countdown {
  throw new Error('not implemented')
}
