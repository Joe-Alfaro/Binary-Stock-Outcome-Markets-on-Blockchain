// R11 against the shared fixture `fixtures/strikes.json`, which the Rust crate `meridian-math`
// also runs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { computeStrikes } from './index.js'

interface StrikesFixture {
  cases: { name: string; prevClose: { price: number; expo: number }; strikes: number[] }[]
}

const fixture = JSON.parse(
  readFileSync(new URL('../../../../fixtures/strikes.json', import.meta.url), 'utf8'),
) as StrikesFixture

describe('strike ladder (R11)', () => {
  it('has every case', () => {
    assert.ok(fixture.cases.length >= 10)
  })

  fixture.cases.forEach(({ name, prevClose, strikes }) => {
    it(name, () => {
      const actual = computeStrikes({ price: BigInt(prevClose.price), expo: prevClose.expo })
      assert.deepEqual(actual, strikes.map(BigInt))
    })
  })
})
