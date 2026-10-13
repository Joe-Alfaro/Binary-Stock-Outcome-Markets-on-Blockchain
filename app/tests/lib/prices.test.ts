import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatPublishTime, isStale } from '../../src/lib/prices'
import { REGULAR_NOW } from '../support/fixtures'

describe('R47 stale latest prices', () => {
  it('is fresh up to 5 minutes old and stale after', () => {
    assert.equal(isStale(REGULAR_NOW - 300, REGULAR_NOW), false)
    assert.equal(isStale(REGULAR_NOW - 301, REGULAR_NOW), true)
  })

  it('shows the publish time in ET whatever the machine time zone', () => {
    // 14:19:30 UTC on 2026-10-12 is 10:19:30 AM EDT.
    assert.match(formatPublishTime(REGULAR_NOW - 30), /^10:19:30\sAM ET$/)
  })
})
