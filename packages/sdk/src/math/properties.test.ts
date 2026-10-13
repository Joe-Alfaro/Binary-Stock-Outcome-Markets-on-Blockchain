// Seeded randomized checks mirroring the Rust proptest suite: Yes + No always pays $1.00 (R2),
// interpolation matches an exact rational reference (R33), and outcomes are monotone in strike
// (R31).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MAX_EXPO,
  MIN_EXPO,
  PAYOUT_UNIT,
  closingPrice,
  payoutPerToken,
  settleOutcome,
  type NormalizedPrice,
  type SettlementParams,
} from './index.js'

const CASES = 2_000
const CLOSE_TS = 1_793_390_400
const I64_MAX = 2n ** 63n - 1n
const params: SettlementParams = {
  ticker: 'AAPL',
  closeTs: CLOSE_TS,
  settleTs: CLOSE_TS + 60,
  maxStalenessSecs: 300,
  maxConfBps: 50,
}

/** Deterministic xorshift64 so failures reproduce. */
function rng(seed: bigint) {
  const mask = 2n ** 64n - 1n
  const state = { value: seed }
  function next() {
    const x0 = state.value
    const x1 = (x0 ^ (x0 << 13n)) & mask
    const x2 = x1 ^ (x1 >> 7n)
    state.value = (x2 ^ (x2 << 17n)) & mask
    return state.value
  }
  return {
    /** Uniform in [lo, hi]. */
    bigint: (lo: bigint, hi: bigint) => lo + (next() % (hi - lo + 1n)),
    int: (lo: number, hi: number) => lo + Number(next() % BigInt(hi - lo + 1)),
  }
}

function update(price: bigint, expo: number, offset: number, officialClose = false) {
  const result: NormalizedPrice = {
    ticker: 'AAPL',
    price,
    conf: 0n,
    expo,
    publishTime: CLOSE_TS + offset,
    session: 'Regular',
    officialClose,
  }
  return result
}

function randomInputs(random: ReturnType<typeof rng>) {
  const expo = random.int(MIN_EXPO, MAX_EXPO)
  const shape = random.int(0, 2)
  if (shape === 0) return [update(random.bigint(1n, I64_MAX), expo, random.int(0, 300), true)]
  if (shape === 1) return [update(random.bigint(1n, I64_MAX), expo, 0)]
  return [
    update(random.bigint(1n, I64_MAX), expo, -random.int(1, 300)),
    update(random.bigint(1n, I64_MAX), expo, random.int(1, 300)),
  ]
}

describe('settlement properties', () => {
  it('Yes payout + No payout is exactly 1_000_000 (R2)', () => {
    const random = rng(0x5eed_0001n)
    Array.from({ length: CASES }).forEach(() => {
      const updates = randomInputs(random)
      const closing = closingPrice(updates, params)
      const strike = { value: random.bigint(1n, I64_MAX), expo: closing.expo }
      const outcome = settleOutcome(closing, strike)
      assert.equal(payoutPerToken(outcome, 'Yes') + payoutPerToken(outcome, 'No'), PAYOUT_UNIT)
    })
  })

  it('interpolated comparison matches an exact rational reference (R33)', () => {
    const random = rng(0x5eed_0002n)
    Array.from({ length: CASES }).forEach(() => {
      const [p1, p2] = [random.bigint(1n, I64_MAX), random.bigint(1n, I64_MAX)]
      const [d1, d2] = [random.int(1, 300), random.int(1, 300)]
      const expo = random.int(MIN_EXPO, MAX_EXPO)
      const closing = closingPrice([update(p1, expo, -d1), update(p2, expo, d2)], params)

      // value = p1 + (p2 − p1) × d1 / (d1 + d2), kept as an unreduced fraction.
      const den = BigInt(d1 + d2)
      const num = p1 * den + (p2 - p1) * BigInt(d1)
      assert.equal(closing.numerator * den, num * closing.denominator, 'same rational value')

      const floor = num / den
      const near = floor + random.bigint(0n, 4n) - 2n
      const strike = random.int(0, 1) === 0 ? random.bigint(1n, I64_MAX) : near
      const expected = num >= strike * den ? 'Yes' : 'No'
      assert.equal(settleOutcome(closing, { value: strike, expo }), expected)
    })
  })

  it('Yes wins for every strike at or below the price and loses above it (R31)', () => {
    const random = rng(0x5eed_0003n)
    Array.from({ length: CASES }).forEach(() => {
      const closing = closingPrice(randomInputs(random), params)
      const [a, b] = [random.bigint(1n, I64_MAX), random.bigint(1n, I64_MAX)]
      const [low, high] = a < b ? [a, b] : [b, a]
      const lowOutcome = settleOutcome(closing, { value: low, expo: closing.expo })
      const highOutcome = settleOutcome(closing, { value: high, expo: closing.expo })
      if (highOutcome === 'Yes') assert.equal(lowOutcome, 'Yes')
      if (lowOutcome === 'No') assert.equal(highOutcome, 'No')
    })
  })
})
