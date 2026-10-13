import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { relayConfidence } from './index.js'
import { assertClose } from './test-support.js'

function confidence(...args: Parameters<typeof relayConfidence>): number {
  const value = relayConfidence(...args)
  assert.ok(value !== null, 'expected a confidence value')
  return value
}

describe('relay confidence (R40)', () => {
  it('is half the bid-ask spread when bid and ask are known', () => {
    assertClose(confidence({ bid: 245.2, ask: 245.3 }), 0.05)
  })

  it('prefers the spread over the bar range', () => {
    assertClose(confidence({ bid: 245.2, ask: 245.3, barHigh: 246, barLow: 244 }), 0.05)
  })

  it('falls back to half the 1-minute bar high-low range without a quote', () => {
    assertClose(confidence({ barHigh: 245.31, barLow: 245.13 }), 0.09)
  })

  it('falls back to the bar range when only one side of the quote is known', () => {
    assertClose(confidence({ bid: 245.2, barHigh: 245.4, barLow: 245.2 }), 0.1)
    assertClose(confidence({ ask: 245.3, barHigh: 245.4, barLow: 245.2 }), 0.1)
  })

  it('falls back to the bar range when the quote is crossed', () => {
    assertClose(confidence({ bid: 245.4, ask: 245.3, barHigh: 245.4, barLow: 245.2 }), 0.1)
  })

  it('is zero for a flat bar', () => {
    assert.equal(relayConfidence({ barHigh: 245.27, barLow: 245.27 }), 0)
  })

  it('is null when neither a quote nor a bar is available', () => {
    assert.equal(relayConfidence({}), null)
  })
})
