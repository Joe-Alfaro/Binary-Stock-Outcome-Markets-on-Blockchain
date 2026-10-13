import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isEarlyClose, isTradingDay, previousTradingDay, tradingDayTimes } from './index.js'

/** Unix seconds for a UTC wall-clock time, so expectations don't depend on the code under test. */
function utc(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00Z`) / 1000
}

const NYSE_HOLIDAYS = [
  // 2026
  '2026-01-01', // New Year's Day
  '2026-01-19', // Martin Luther King, Jr. Day
  '2026-02-16', // Washington's Birthday
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed, July 4 is a Saturday)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
  // 2027
  '2027-01-01', // New Year's Day
  '2027-01-18', // Martin Luther King, Jr. Day
  '2027-02-15', // Washington's Birthday
  '2027-03-26', // Good Friday
  '2027-05-31', // Memorial Day
  '2027-06-18', // Juneteenth (observed, June 19 is a Saturday)
  '2027-07-05', // Independence Day (observed, July 4 is a Sunday)
  '2027-09-06', // Labor Day
  '2027-11-25', // Thanksgiving
  '2027-12-24', // Christmas (observed, December 25 is a Saturday)
]

const EARLY_CLOSES = ['2026-11-27', '2026-12-24', '2027-11-26']

describe('trading calendar: holidays and weekends', () => {
  NYSE_HOLIDAYS.forEach((date) => {
    it(`has no session on the holiday ${date}`, () => {
      assert.equal(isTradingDay(date), false)
    })
  })

  it('has no session on weekends', () => {
    ;['2026-10-10', '2026-10-11', '2026-07-04', '2027-12-25'].forEach((date) => {
      assert.equal(isTradingDay(date), false, date)
    })
  })

  it('has sessions on ordinary weekdays, including days next to holidays', () => {
    ;[
      '2026-10-12',
      '2026-07-02',
      '2026-11-25',
      '2026-12-31',
      '2027-06-17',
      '2027-07-02',
      '2027-12-23',
      // New Year's Day 2028 is a Saturday and the exchange doesn't observe it on Friday.
      '2027-12-31',
    ].forEach((date) => {
      assert.equal(isTradingDay(date), true, date)
    })
  })

  it('refuses to compute times for a non-trading day', () => {
    ;['2026-11-26', '2026-12-25', '2026-10-10'].forEach((date) => {
      assert.throws(() => tradingDayTimes(date), RangeError, date)
    })
  })
})

describe('trading calendar: early closes', () => {
  EARLY_CLOSES.forEach((date) => {
    it(`${date} is an early-close trading day`, () => {
      assert.equal(isTradingDay(date), true)
      assert.equal(isEarlyClose(date), true)
    })
  })

  it('does not mark other days next to holidays as early closes', () => {
    ;['2026-07-02', '2026-12-31', '2027-07-02', '2027-12-23', '2026-10-12'].forEach((date) => {
      assert.equal(isEarlyClose(date), false, date)
    })
  })

  it('closes at 1:00 PM ET on 2026-11-27', () => {
    assert.deepEqual(tradingDayTimes('2026-11-27'), {
      mintOpenTs: utc('2026-11-27', '14:00'),
      tradingOpenTs: utc('2026-11-27', '14:30'),
      closeTs: utc('2026-11-27', '18:00'),
      earlyClose: true,
    })
  })

  it('closes at 1:00 PM ET on the other early-close days', () => {
    assert.equal(tradingDayTimes('2026-12-24').closeTs, utc('2026-12-24', '18:00'))
    assert.equal(tradingDayTimes('2027-11-26').closeTs, utc('2027-11-26', '18:00'))
  })
})

describe('trading calendar: session times and DST', () => {
  it('uses EDT (UTC-4) on 2026-10-30, the last trading day before DST ends', () => {
    assert.deepEqual(tradingDayTimes('2026-10-30'), {
      mintOpenTs: utc('2026-10-30', '13:00'),
      tradingOpenTs: utc('2026-10-30', '13:30'),
      closeTs: utc('2026-10-30', '20:00'),
      earlyClose: false,
    })
  })

  it('uses EST (UTC-5) on 2026-11-02, the first trading day after DST ends', () => {
    assert.deepEqual(tradingDayTimes('2026-11-02'), {
      mintOpenTs: utc('2026-11-02', '14:00'),
      tradingOpenTs: utc('2026-11-02', '14:30'),
      closeTs: utc('2026-11-02', '21:00'),
      earlyClose: false,
    })
  })

  it('switches offsets around the 2026 spring change (March 8)', () => {
    assert.equal(tradingDayTimes('2026-03-06').closeTs, utc('2026-03-06', '21:00'))
    assert.equal(tradingDayTimes('2026-03-09').closeTs, utc('2026-03-09', '20:00'))
    assert.equal(tradingDayTimes('2026-03-09').mintOpenTs, utc('2026-03-09', '13:00'))
  })

  it('switches offsets around the 2027 changes (March 14 and November 7)', () => {
    assert.equal(tradingDayTimes('2027-03-12').closeTs, utc('2027-03-12', '21:00'))
    assert.equal(tradingDayTimes('2027-03-15').closeTs, utc('2027-03-15', '20:00'))
    assert.equal(tradingDayTimes('2027-11-05').closeTs, utc('2027-11-05', '20:00'))
    assert.equal(tradingDayTimes('2027-11-08').closeTs, utc('2027-11-08', '21:00'))
  })

  it('opens minting 30 minutes before trading and returns whole seconds', () => {
    const times = tradingDayTimes('2027-06-17')
    assert.equal(times.tradingOpenTs - times.mintOpenTs, 30 * 60)
    assert.equal(times.closeTs - times.tradingOpenTs, 390 * 60)
    ;[times.mintOpenTs, times.tradingOpenTs, times.closeTs].forEach((ts) => {
      assert.ok(Number.isInteger(ts), String(ts))
    })
  })
})

describe('trading calendar: previous trading day', () => {
  const cases: [string, string, string][] = [
    ['2026-10-12', '2026-10-09', "Monday's previous close is Friday's"],
    ['2026-10-13', '2026-10-12', 'an ordinary Tuesday'],
    ['2026-11-27', '2026-11-25', 'the day after Thanksgiving'],
    ['2026-01-20', '2026-01-16', 'the day after a Monday holiday'],
    ['2026-04-06', '2026-04-02', 'the Monday after Good Friday'],
    ['2026-07-06', '2026-07-02', 'the Monday after a Friday holiday'],
    ['2026-12-28', '2026-12-24', 'the Monday after Christmas, back to an early close'],
    ['2027-01-04', '2026-12-31', 'across the year boundary'],
    ['2027-06-21', '2027-06-17', 'the Monday after observed Juneteenth'],
    ['2027-07-06', '2027-07-02', 'the Tuesday after observed Independence Day'],
    ['2027-12-27', '2027-12-23', 'the Monday after observed Christmas'],
    ['2026-10-10', '2026-10-09', 'a Saturday'],
  ]

  cases.forEach(([date, expected, label]) => {
    it(`${date} -> ${expected} (${label})`, () => {
      assert.equal(previousTradingDay(date), expected)
    })
  })
})

describe('trading calendar: input validation and coverage', () => {
  it('rejects dates outside the checked-in years', () => {
    assert.throws(() => isTradingDay('2025-12-31'), RangeError)
    assert.throws(() => isTradingDay('2028-01-03'), RangeError)
    assert.throws(() => tradingDayTimes('2028-01-03'), RangeError)
  })

  it('rejects a previous trading day that falls before the checked-in years', () => {
    assert.throws(() => previousTradingDay('2026-01-02'), RangeError)
  })

  it('rejects malformed dates', () => {
    ;['2026-13-01', '2026-02-30', '10/30/2026', '2026-1-5', ''].forEach((date) => {
      assert.throws(() => isTradingDay(date), RangeError, date)
    })
  })
})
