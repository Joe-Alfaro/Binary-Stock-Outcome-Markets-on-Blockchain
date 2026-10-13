import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_RELAY_SOURCE, isRelaySourceName } from './index.js'

describe('relay source names', () => {
  it('defaults to a known source', () => {
    assert.equal(isRelaySourceName(DEFAULT_RELAY_SOURCE), true)
  })

  it('accepts mock and rejects unknown names', () => {
    assert.equal(isRelaySourceName('mock'), true)
    assert.equal(isRelaySourceName('unknown'), false)
  })
})
