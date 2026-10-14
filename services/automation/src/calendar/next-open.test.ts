import './non-et-timezone.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { nextOpen, reopenLabel } from './next-open.js'

/** Unix seconds for a UTC instant, so expectations don't depend on the code under test. */
function utc(iso: string): number {
  return Date.parse(iso) / 1000
}

/** Asserts both the next open and the label at `now`. */
function assertReopens(now: string, open: string, label: string) {
  assert.equal(nextOpen(utc(now)), utc(open), `next open after ${now}`)
  assert.equal(reopenLabel(utc(now)), label, `label at ${now}`)
}

function assertOpen(now: string) {
  assert.equal(nextOpen(utc(now)), null, `${now} is mid-session`)
  assert.equal(reopenLabel(utc(now)), null, `no tag at ${now}`)
}

// R68: the Closed tag's next open comes from the NYSE calendar, in ET whatever the host's zone.
describe('R68 next open and reopen label', () => {
  it('runs in a host time zone other than ET', () => {
    assert.equal(new Intl.DateTimeFormat().resolvedOptions().timeZone, 'Asia/Tokyo')
    assert.equal(new Date(utc('2026-10-16T20:00:00Z') * 1000).getTimezoneOffset(), -540)
  })

  it("Friday after the close reopens 'Mon'", () => {
    // Fri 2026-10-16 4:00 PM EDT (already Saturday in Tokyo) and 11:59 PM EDT.
    assertReopens('2026-10-16T20:00:00Z', '2026-10-19T13:30:00Z', 'Reopens Mon 9:30 AM ET')
    assertReopens('2026-10-17T03:59:00Z', '2026-10-19T13:30:00Z', 'Reopens Mon 9:30 AM ET')
  })

  it("Saturday and Sunday reopen 'Mon'", () => {
    assertReopens('2026-10-17T16:00:00Z', '2026-10-19T13:30:00Z', 'Reopens Mon 9:30 AM ET')
    // Sun 2026-10-18 8:00 PM EDT, already Monday in UTC.
    assertReopens('2026-10-19T00:00:00Z', '2026-10-19T13:30:00Z', 'Reopens Mon 9:30 AM ET')
  })

  it("a weekday before the open reopens 'today'", () => {
    // Wed 2026-10-14 7:00 AM EDT.
    assertReopens('2026-10-14T11:00:00Z', '2026-10-14T13:30:00Z', 'Reopens today 9:30 AM ET')
    // Tue 2026-10-13 12:30 AM EDT, just after midnight ET.
    assertReopens('2026-10-13T04:30:00Z', '2026-10-13T13:30:00Z', 'Reopens today 9:30 AM ET')
    // Mon 2026-10-19 9:29:59 AM EDT.
    assertReopens('2026-10-19T13:29:59Z', '2026-10-19T13:30:00Z', 'Reopens today 9:30 AM ET')
  })

  it("Monday to Thursday after the close reopen 'tomorrow'", () => {
    const cases: [string, string][] = [
      ['2026-10-12T20:00:00Z', '2026-10-13T13:30:00Z'], // Mon 4:00 PM EDT, the close itself
      ['2026-10-13T22:00:00Z', '2026-10-14T13:30:00Z'], // Tue 6:00 PM EDT
      ['2026-10-15T00:00:00Z', '2026-10-15T13:30:00Z'], // Wed 8:00 PM EDT
      ['2026-10-16T03:59:00Z', '2026-10-16T13:30:00Z'], // Thu 11:59 PM EDT
    ]
    cases.forEach(([now, open]) => assertReopens(now, open, 'Reopens tomorrow 9:30 AM ET'))
  })

  it('skips a holiday: 2026-11-25 after the close reopens Fri 2026-11-27', () => {
    // Wed 4:00 PM EST; Thursday is Thanksgiving.
    assertReopens('2026-11-25T21:00:00Z', '2026-11-27T14:30:00Z', 'Reopens Fri 9:30 AM ET')
    // Thanksgiving itself, noon EST.
    assertReopens('2026-11-26T17:00:00Z', '2026-11-27T14:30:00Z', 'Reopens tomorrow 9:30 AM ET')
  })

  it('an early close ends the session at 1:00 PM ET: 2026-11-27 afterwards reopens Mon', () => {
    assertOpen('2026-11-27T17:59:59Z') // 12:59:59 PM EST
    assertReopens('2026-11-27T18:00:00Z', '2026-11-30T14:30:00Z', 'Reopens Mon 9:30 AM ET')
    assertReopens('2026-11-27T19:00:00Z', '2026-11-30T14:30:00Z', 'Reopens Mon 9:30 AM ET')
  })

  it("an early close doesn't move the open", () => {
    // 2026-11-27 7:00 AM EST.
    assertReopens('2026-11-27T12:00:00Z', '2026-11-27T14:30:00Z', 'Reopens today 9:30 AM ET')
  })

  it('skips an early close then a holiday: Christmas Eve afternoon reopens Mon', () => {
    // Thu 2026-12-24 2:00 PM EST; Friday is Christmas.
    assertReopens('2026-12-24T19:00:00Z', '2026-12-28T14:30:00Z', 'Reopens Mon 9:30 AM ET')
  })

  it('crosses the end of DST: Fri 2026-10-30 after the close reopens Mon at 9:30 AM EST', () => {
    assertReopens('2026-10-30T20:00:00Z', '2026-11-02T14:30:00Z', 'Reopens Mon 9:30 AM ET')
  })

  it('shows no tag mid-session, from the open up to but excluding the close', () => {
    assertOpen('2026-10-12T13:30:00Z') // Mon 9:30 AM EDT
    assertOpen('2026-10-12T14:20:00Z') // 10:20 AM EDT
    assertOpen('2026-10-12T19:59:59Z') // 3:59:59 PM EDT
  })
})
