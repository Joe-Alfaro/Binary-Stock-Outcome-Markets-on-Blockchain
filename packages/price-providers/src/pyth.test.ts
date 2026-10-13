import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PYTH_FEED_IDS, PriceSourceError, normalizePythUpdates } from './index.js'
import {
  FIXTURE_CLOSE_TS as CLOSE_TS,
  assertClose,
  assertNormalizedShape,
  confOf,
  readFixtureText,
  valueOf,
} from './test-support.js'

interface HermesFixture {
  parsed: { id: string; price: { publish_time: number } }[]
}

function hermes(): HermesFixture {
  return JSON.parse(readFixtureText('pyth/hermes-2026-10-09-before-close.json')) as HermesFixture
}

function withPublishTime(publishTime: number): HermesFixture {
  const response = hermes()
  response.parsed.forEach((entry) => {
    entry.price.publish_time = publishTime
  })
  return response
}

function aapl(response: unknown) {
  const update = normalizePythUpdates(response, { closeTs: CLOSE_TS }).find(
    (price) => price.ticker === 'AAPL',
  )
  assert.ok(update, 'normalized an AAPL update')
  return update
}

describe('pyth adapter against a recorded Hermes payload (R32)', () => {
  it('maps price, conf, exponent and publish time into the normalized shape', () => {
    const update = aapl(hermes())

    assertNormalizedShape(update)
    assertClose(valueOf(update), 245.25)
    assertClose(confOf(update), 0.12)
    assert.equal(update.publishTime, 1791575970)
    assert.equal(update.session, 'regular')
    assert.equal(update.officialClose, false)
  })

  it('maps every known feed ID to its ticker', () => {
    const updates = normalizePythUpdates(hermes(), { closeTs: CLOSE_TS })

    assert.deepEqual(updates.map((update) => update.ticker).sort(), ['AAPL', 'MSFT'])
    const msft = updates.find((update) => update.ticker === 'MSFT')
    assert.ok(msft)
    assertClose(valueOf(msft), 521.62)
  })

  it('accepts 0x-prefixed feed IDs', () => {
    const response = hermes()
    response.parsed.forEach((entry) => {
      entry.id = `0x${entry.id}`
    })

    assertClose(valueOf(aapl(response)), 245.25)
  })

  it('skips feeds that are not one of the tickers', () => {
    const response = hermes()
    const first = response.parsed[0]
    assert.ok(first)
    first.id = 'ff'.repeat(32)

    const tickers = normalizePythUpdates(response, { closeTs: CLOSE_TS }).map((u) => u.ticker)

    assert.deepEqual(tickers, ['MSFT'])
  })

  it('labels the session from the publish time', () => {
    assert.equal(aapl(withPublishTime(CLOSE_TS)).session, 'regular')
    assert.equal(aapl(withPublishTime(CLOSE_TS + 120)).session, 'outside-regular')
    // 09:00 ET, before the open.
    assert.equal(aapl(withPublishTime(CLOSE_TS - 7 * 60 * 60)).session, 'outside-regular')
    // 09:30 ET, the open.
    assert.equal(aapl(withPublishTime(CLOSE_TS - 6.5 * 60 * 60)).session, 'regular')
  })

  it('knows the feed ID of every ticker', () => {
    assert.deepEqual(Object.keys(PYTH_FEED_IDS).sort(), [
      'AAPL',
      'AMZN',
      'GOOGL',
      'META',
      'MSFT',
      'NVDA',
      'TSLA',
    ])
  })

  it('rejects a payload without parsed updates as malformed', () => {
    assert.throws(
      () => normalizePythUpdates({ binary: { data: [] } }, { closeTs: CLOSE_TS }),
      (error: unknown) => error instanceof PriceSourceError && error.code === 'malformed',
    )
  })
})
