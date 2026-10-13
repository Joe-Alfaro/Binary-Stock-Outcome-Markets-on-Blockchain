import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { atStrikeNote, countdownToClose, payoffLine } from './index.js'

// The countdown must read in ET whatever the process time zone, so run these in a zone far from it.
process.env.TZ = 'Asia/Tokyo'

function utcSeconds(year: number, month: number, day: number, hour: number, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour, minute) / 1000
}

describe('R51 payoff copy', () => {
  it('prints the Yes payoff line exactly', () => {
    assert.equal(
      payoffLine({ side: 'Yes', ticker: 'AAPL', strike: 230, priceCents: 62 }),
      'You pay $0.62. You win $1.00 if AAPL closes above $230.00.',
    )
  })

  it('prints the No payoff line with "closes below"', () => {
    assert.equal(
      payoffLine({ side: 'No', ticker: 'TSLA', strike: 187.5, priceCents: 7 }),
      'You pay $0.07. You win $1.00 if TSLA closes below $187.50.',
    )
  })

  it('notes that a close exactly at the strike pays Yes', () => {
    const note = atStrikeNote('AAPL', 230)
    assert.match(note, /exactly at \$230\.00/)
    assert.match(note, /pays Yes/)
  })
})

describe('R51 countdown to close in ET', () => {
  it('runs in a non-ET process time zone', () => {
    assert.equal(new Date(0).getTimezoneOffset(), -540)
  })

  it('counts down to a normal 4:00 PM ET close during daylight time', () => {
    const closeTs = utcSeconds(2026, 10, 12, 20) // 4:00 PM EDT
    const countdown = countdownToClose(closeTs, closeTs - (2 * 3600 + 5 * 60 + 9))
    assert.deepEqual(countdown, {
      secondsLeft: 7509,
      closed: false,
      text: '2h 05m 09s',
      closesAt: '4:00 PM ET',
    })
  })

  it('shows a 4:00 PM ET close in standard time', () => {
    const closeTs = utcSeconds(2026, 12, 15, 21) // 4:00 PM EST
    assert.equal(countdownToClose(closeTs, closeTs - 59).closesAt, '4:00 PM ET')
    assert.equal(countdownToClose(closeTs, closeTs - 59).text, '0h 00m 59s')
  })

  it('honors an early 1:00 PM ET close', () => {
    const closeTs = utcSeconds(2026, 11, 27, 18) // day after Thanksgiving, 1:00 PM EST
    const countdown = countdownToClose(closeTs, utcSeconds(2026, 11, 27, 17, 30))
    assert.equal(countdown.closesAt, '1:00 PM ET')
    assert.equal(countdown.secondsLeft, 1800)
    assert.equal(countdown.text, '0h 30m 00s')
  })

  it('reports Closed at and after close_ts', () => {
    const closeTs = utcSeconds(2026, 10, 12, 20)
    assert.deepEqual(countdownToClose(closeTs, closeTs), {
      secondsLeft: 0,
      closed: true,
      text: 'Closed',
      closesAt: '4:00 PM ET',
    })
    assert.equal(countdownToClose(closeTs, closeTs + 10).secondsLeft, 0)
  })
})
