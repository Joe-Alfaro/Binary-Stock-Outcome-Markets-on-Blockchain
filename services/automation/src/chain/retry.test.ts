import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isTransient, withRetry } from './retry.js'

function policy() {
  const waits: number[] = []
  return {
    waits,
    attempts: 3,
    baseDelayMs: 500,
    async sleep(ms: number) {
      waits.push(ms)
    },
  }
}

describe('withRetry', () => {
  it('retries transport failures with doubling backoff, then succeeds', async () => {
    const p = policy()
    let calls = 0
    const result = await withRetry(p, async () => {
      calls += 1
      if (calls < 3) throw new Error('fetch failed: ECONNRESET')
      return 'ok'
    })
    assert.equal(result, 'ok')
    assert.deepEqual(p.waits, [500, 1000])
  })

  it('gives up after the bounded number of tries', async () => {
    const p = policy()
    let calls = 0
    await assert.rejects(
      withRetry(p, async () => {
        calls += 1
        throw new Error('429 Too Many Requests')
      }),
      /429/,
    )
    assert.equal(calls, 3)
  })

  it('never retries a program error', async () => {
    const p = policy()
    let calls = 0
    await assert.rejects(
      withRetry(p, async () => {
        calls += 1
        throw new Error('AnchorError occurred. Error Code: MarketSettled.')
      }),
    )
    assert.equal(calls, 1)
    assert.deepEqual(p.waits, [])
  })
})

describe('isTransient', () => {
  it('reads attached transaction logs', () => {
    const error = Object.assign(new Error('Simulation failed'), {
      logs: ['Allocate: account Address { .. } already in use'],
    })
    assert.equal(isTransient(error), false)
    assert.equal(isTransient(new Error('Blockhash not found')), true)
    assert.equal(isTransient(new Error('custom program error: 0x0')), false)
  })
})
