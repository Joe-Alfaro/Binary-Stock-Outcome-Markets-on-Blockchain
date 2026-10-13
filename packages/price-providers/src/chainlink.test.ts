import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PriceSourceError, normalizeChainlinkV11Report } from './index.js'
import {
  assertClose,
  assertNormalizedShape,
  confOf,
  readFixtureText,
  valueOf,
} from './test-support.js'

type Report = Record<string, unknown>

function report(changes: Report = {}): Report {
  const recorded = JSON.parse(
    readFixtureText('chainlink/v11-AAPL-2026-10-09-before-close.json'),
  ) as Report
  return { ...recorded, ...changes }
}

function normalize(input: Report) {
  return normalizeChainlinkV11Report(input, { ticker: 'AAPL' })
}

describe('chainlink data streams v11 adapter against a recorded report (R32)', () => {
  it('maps the last traded price, half the spread and the observation time', () => {
    const update = normalize(report())

    assertNormalizedShape(update)
    assert.equal(update.ticker, 'AAPL')
    assertClose(valueOf(update), 245.25)
    assertClose(confOf(update), 0.065)
    assert.equal(update.publishTime, 1791575970)
    assert.equal(update.session, 'regular')
    assert.equal(update.officialClose, false)
  })

  it('falls back to mid when there is no last traded price', () => {
    const withoutLast = report()
    delete withoutLast.lastTradedPrice

    assertClose(valueOf(normalize(withoutLast)), 245.265)
    assertClose(valueOf(normalize(report({ lastTradedPrice: '0' }))), 245.265)
  })

  it('labels the session regular only during regular hours', () => {
    assert.equal(normalize(report({ marketStatus: 1 })).session, 'outside-regular')
    assert.equal(normalize(report({ marketStatus: 3 })).session, 'outside-regular')
    assert.equal(normalize(report({ marketStatus: 5 })).session, 'outside-regular')
  })

  it('rejects a report without a usable price as malformed', () => {
    const noPrice = report()
    delete noPrice.lastTradedPrice
    delete noPrice.mid

    assert.throws(
      () => normalize(noPrice),
      (error: unknown) => error instanceof PriceSourceError && error.code === 'malformed',
    )
    assert.throws(
      () => normalize(report({ lastTradedPrice: 'abc' })),
      (error: unknown) => error instanceof PriceSourceError && error.code === 'malformed',
    )
  })
})
