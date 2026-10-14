// The chart window must not depend on the host's time zone, so run these tests in Tokyo (UTC+9),
// where the ET trading day and the local day often differ.
process.env.TZ = 'Asia/Tokyo'

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { chartSession } from './chart-session.js'

/** Unix seconds for a UTC instant, so expectations don't depend on the code under test. */
function utc(iso: string): number {
  return Date.parse(iso) / 1000
}

// R66: the Markets chart shows today's session while open, else the last complete session.
describe('chartSession (R66)', () => {
  it('runs in a host time zone other than New York', () => {
    assert.equal(new Date(utc('2026-10-13T15:00:00Z') * 1000).getTimezoneOffset(), -540)
  })

  it('shows today from the open to now on a weekday mid-session', () => {
    // Tuesday 2026-10-13, 11:00 AM EDT.
    const now = utc('2026-10-13T15:00:00Z')
    assert.deepEqual(chartSession(now), {
      date: '2026-10-13',
      live: true,
      openTs: utc('2026-10-13T13:30:00Z'),
      endTs: now,
      earlyClose: false,
    })
  })

  it('counts the open itself as live', () => {
    const open = utc('2026-10-13T13:30:00Z')
    assert.deepEqual(chartSession(open), {
      date: '2026-10-13',
      live: true,
      openTs: open,
      endTs: open,
      earlyClose: false,
    })
  })

  it("shows the previous trading day's full session before the open", () => {
    // Wednesday 2026-10-14, 8:00 AM EDT: Tuesday's session.
    assert.deepEqual(chartSession(utc('2026-10-14T12:00:00Z')), {
      date: '2026-10-13',
      live: false,
      openTs: utc('2026-10-13T13:30:00Z'),
      endTs: utc('2026-10-13T20:00:00Z'),
      earlyClose: false,
    })
  })

  it("shows today's full session after the close", () => {
    // Tuesday 2026-10-13, 5:00 PM EDT (Wednesday morning in Tokyo).
    assert.deepEqual(chartSession(utc('2026-10-13T21:00:00Z')), {
      date: '2026-10-13',
      live: false,
      openTs: utc('2026-10-13T13:30:00Z'),
      endTs: utc('2026-10-13T20:00:00Z'),
      earlyClose: false,
    })
  })

  it("treats the close itself as closed and shows today's full session", () => {
    const close = utc('2026-10-13T20:00:00Z')
    assert.deepEqual(chartSession(close), {
      date: '2026-10-13',
      live: false,
      openTs: utc('2026-10-13T13:30:00Z'),
      endTs: close,
      earlyClose: false,
    })
  })

  it("shows Friday's session on a weekend", () => {
    const friday = {
      date: '2026-10-16',
      live: false,
      openTs: utc('2026-10-16T13:30:00Z'),
      endTs: utc('2026-10-16T20:00:00Z'),
      earlyClose: false,
    }
    // Saturday noon, Sunday evening and Monday 8:00 AM EDT.
    assert.deepEqual(chartSession(utc('2026-10-17T16:00:00Z')), friday)
    assert.deepEqual(chartSession(utc('2026-10-18T23:00:00Z')), friday)
    assert.deepEqual(chartSession(utc('2026-10-19T12:00:00Z')), friday)
  })

  it("shows the previous trading day's session on a holiday", () => {
    // Thanksgiving, Thursday 2026-11-26, noon EST: Wednesday's full session.
    assert.deepEqual(chartSession(utc('2026-11-26T17:00:00Z')), {
      date: '2026-11-25',
      live: false,
      openTs: utc('2026-11-25T14:30:00Z'),
      endTs: utc('2026-11-25T21:00:00Z'),
      earlyClose: false,
    })
  })

  it('is live until 1:00 PM ET on an early-close day', () => {
    // Friday 2026-11-27, 12:00 PM EST.
    const now = utc('2026-11-27T17:00:00Z')
    assert.deepEqual(chartSession(now), {
      date: '2026-11-27',
      live: true,
      openTs: utc('2026-11-27T14:30:00Z'),
      endTs: now,
      earlyClose: true,
    })
  })

  it('ends the early-close session at 1:00 PM ET once it has closed', () => {
    const session = {
      date: '2026-11-27',
      live: false,
      openTs: utc('2026-11-27T14:30:00Z'),
      endTs: utc('2026-11-27T18:00:00Z'),
      earlyClose: true,
    }
    // 2:00 PM EST the same day, and the Saturday after.
    assert.deepEqual(chartSession(utc('2026-11-27T19:00:00Z')), session)
    assert.deepEqual(chartSession(utc('2026-11-28T16:00:00Z')), session)
  })

  it('returns null when the session falls outside the calendar data', () => {
    // Friday 2026-01-02, 7:00 AM EST: the previous trading day is in 2025.
    assert.equal(chartSession(utc('2026-01-02T12:00:00Z')), null)
  })
})
