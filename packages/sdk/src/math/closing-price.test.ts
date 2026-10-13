// R1, R33 and R34 against the shared fixture `fixtures/closing-price.json`, which the Rust crate
// `meridian-math` also runs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  ClosingPriceError,
  PAYOUT_UNIT,
  closingPrice,
  payoutPerToken,
  settleOutcome,
  type ClosingPrice,
  type ClosingPriceErrorCode,
  type ClosingShape,
  type NormalizedPrice,
  type Outcome,
  type Session,
  type SettlementParams,
} from './index.js'

interface FixtureUpdate {
  offset: number
  price: number
  conf?: number
  expo?: number
  ticker?: string
  session?: Session
  officialClose?: boolean
}

interface FixtureCase {
  name: string
  requirements: string[]
  closeTs?: number
  settleOffset?: number
  maxStalenessSecs?: number
  maxConfBps?: number
  updates: FixtureUpdate[]
  expect:
    | { error: ClosingPriceErrorCode }
    | {
        shape: ClosingShape
        settlePrice?: number
        strikes: { strike: number; outcome: Outcome }[]
      }
}

interface ClosingFixture {
  defaults: {
    ticker: string
    closeTs: number
    settleOffset: number
    maxStalenessSecs: number
    maxConfBps: number
    expo: number
  }
  cases: FixtureCase[]
}

const fixture = JSON.parse(
  readFileSync(new URL('../../../../fixtures/closing-price.json', import.meta.url), 'utf8'),
) as ClosingFixture
const { defaults } = fixture

function paramsFor(fixtureCase: FixtureCase): SettlementParams {
  const closeTs = fixtureCase.closeTs ?? defaults.closeTs
  return {
    ticker: defaults.ticker,
    closeTs,
    settleTs: closeTs + (fixtureCase.settleOffset ?? defaults.settleOffset),
    maxStalenessSecs: fixtureCase.maxStalenessSecs ?? defaults.maxStalenessSecs,
    maxConfBps: fixtureCase.maxConfBps ?? defaults.maxConfBps,
  }
}

function updatesFor(fixtureCase: FixtureCase, closeTs: number): NormalizedPrice[] {
  return fixtureCase.updates.map((update) => ({
    ticker: update.ticker ?? defaults.ticker,
    price: BigInt(update.price),
    conf: BigInt(update.conf ?? 0),
    expo: update.expo ?? defaults.expo,
    publishTime: closeTs + update.offset,
    session: update.session ?? 'Regular',
    officialClose: update.officialClose ?? false,
  }))
}

function isClosingPriceError(code: ClosingPriceErrorCode) {
  return (error: unknown) => {
    assert.ok(error instanceof ClosingPriceError, `expected ClosingPriceError, got ${error}`)
    assert.equal(error.code, code)
    return true
  }
}

/** The rule's result as a comparable value: the closing price or the error code. */
function outcomeOf(updates: NormalizedPrice[], params: SettlementParams) {
  try {
    return closingPrice(updates, params)
  } catch (error) {
    if (error instanceof ClosingPriceError) return error.code
    throw error
  }
}

describe('closing-price fixture', () => {
  it('has every case', () => {
    assert.ok(fixture.cases.length >= 30)
  })

  fixture.cases.forEach((fixtureCase) => {
    it(`${fixtureCase.name} (${fixtureCase.requirements.join(', ')})`, () => {
      const params = paramsFor(fixtureCase)
      const updates = updatesFor(fixtureCase, params.closeTs)
      const { expect } = fixtureCase

      if ('error' in expect) {
        assert.throws(() => closingPrice(updates, params), isClosingPriceError(expect.error))
        return
      }

      const closing = closingPrice(updates, params)
      assert.equal(closing.shape, expect.shape)
      assert.equal(closing.expo, defaults.expo)
      assert.ok(closing.denominator > 0n, 'denominator is positive')
      if (expect.settlePrice !== undefined) {
        const settlePrice = BigInt(expect.settlePrice)
        assert.equal(closing.settlePrice, settlePrice)
        assert.equal(closing.numerator, settlePrice * closing.denominator)
      }

      expect.strikes.forEach(({ strike, outcome }) => {
        const actual = settleOutcome(closing, { value: BigInt(strike), expo: defaults.expo })
        assert.equal(actual, outcome, `strike ${strike}`)
        const winner = outcome === 'Yes' ? 'Yes' : 'No'
        const loser = outcome === 'Yes' ? 'No' : 'Yes'
        assert.equal(payoutPerToken(outcome, winner), PAYOUT_UNIT)
        assert.equal(payoutPerToken(outcome, loser), 0n)
      })
    })
  })

  // R34: staleness is measured against closeTs, so when the settle transaction lands never
  // changes the result.
  fixture.cases.forEach((fixtureCase) => {
    it(`${fixtureCase.name}: same result whenever settle lands (R34)`, () => {
      const params = paramsFor(fixtureCase)
      const updates = updatesFor(fixtureCase, params.closeTs)
      const baseline = outcomeOf(updates, params)
      ;[1, 720, 3_600, 86_400 * 365].forEach((offset) => {
        const later = { ...params, settleTs: params.closeTs + offset }
        assert.deepEqual(outcomeOf(updates, later), baseline, `settle at close + ${offset}`)
      })
    })
  })

  it('covers at, above and below the strike for every shape (R1)', () => {
    const shapes: ClosingShape[] = ['OfficialClose', 'ExactTimestamp', 'Interpolated']
    shapes.forEach((shape) => {
      const covered = fixture.cases.some(
        ({ expect }) => 'shape' in expect && expect.shape === shape && expect.strikes.length >= 3,
      )
      assert.ok(covered, shape)
    })
  })
})

describe('payout rule (R1)', () => {
  it('pays Yes holders only when Yes wins', () => {
    assert.equal(payoutPerToken('Yes', 'Yes'), 1_000_000n)
    assert.equal(payoutPerToken('Yes', 'No'), 0n)
  })

  it('pays No holders only when No wins', () => {
    assert.equal(payoutPerToken('No', 'Yes'), 0n)
    assert.equal(payoutPerToken('No', 'No'), 1_000_000n)
  })

  it('rejects a strike on another scale', () => {
    const closing: ClosingPrice = {
      shape: 'ExactTimestamp',
      expo: -2,
      numerator: 23_000n,
      denominator: 1n,
      settlePrice: 23_000n,
    }
    assert.throws(
      () => settleOutcome(closing, { value: 2_300_000n, expo: -4 }),
      isClosingPriceError('ExpoMismatch'),
    )
  })
})
