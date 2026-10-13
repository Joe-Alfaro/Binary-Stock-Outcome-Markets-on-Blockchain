import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  oracleKind,
  programSlot,
  scaleStrike,
  settleSource,
  strikeDollars,
  tickerBytes,
  tickerFromBytes,
  toAdminPrice,
  tradingDayNumber,
  tradingDayString,
} from './codec.js'

describe('chain codec', () => {
  it('round-trips tickers through the zero-padded [u8; 8]', () => {
    const bytes = tickerBytes('AAPL')
    assert.deepEqual([...bytes], [65, 65, 80, 76, 0, 0, 0, 0])
    assert.equal(tickerFromBytes(bytes), 'AAPL')
    assert.equal(tickerFromBytes(tickerBytes('GOOGLEXX')), 'GOOGLEXX')
    assert.throws(() => tickerBytes('aapl'), RangeError)
  })

  it('converts trading days between YYYY-MM-DD and YYYYMMDD', () => {
    assert.equal(tradingDayNumber('2026-11-02'), 20261102)
    assert.equal(tradingDayString(20261102), '2026-11-02')
    assert.throws(() => tradingDayNumber('20261102'), RangeError)
  })

  it('scales whole-dollar strikes to cents and back', () => {
    assert.equal(scaleStrike(245n), 24_500n)
    assert.equal(strikeDollars(24_500n, -2), 245n)
    assert.equal(strikeDollars(24_527n, -2), 245n)
    assert.equal(strikeDollars(245n, 0), 245n)
  })

  it('expresses admin prices in whole cents and rejects finer ones', () => {
    assert.equal(toAdminPrice({ price: 52_500n, expo: -2 }), 52_500n)
    assert.equal(toAdminPrice({ price: 525_000_000n, expo: -6 }), 52_500n)
    assert.equal(toAdminPrice({ price: 525n, expo: 0 }), 52_500n)
    assert.throws(() => toAdminPrice({ price: 525_001n, expo: -3 }), RangeError)
  })

  it('maps slots and enum values between the automation and the program', () => {
    assert.equal(programSlot(1), 0)
    assert.equal(programSlot(2), 1)
    assert.equal(oracleKind({ meridianRelay: {} }), 'MeridianRelay')
    assert.equal(oracleKind({ disabled: {} }), 'Disabled')
    assert.equal(settleSource({ oracleSlot0: {} }), 1)
    assert.equal(settleSource({ oracleSlot1: {} }), 2)
    assert.equal(settleSource({ admin: {} }), 'admin')
    assert.throws(() => settleSource({ none: {} }))
  })
})
