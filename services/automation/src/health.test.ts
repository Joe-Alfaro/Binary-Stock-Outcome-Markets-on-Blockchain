import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import {
  createHealthServer,
  createHealthState,
  resolveHealthPort,
  type HealthState,
} from './health.js'

describe('health state (R65)', () => {
  it('reports nulls before the first scan and publish', () => {
    assert.deepEqual(createHealthState().snapshot(), {
      status: 'ok',
      lastScanAt: null,
      lastRelayPublishAt: null,
    })
  })

  it('reports the last scan and relay publish times', () => {
    const state = createHealthState()
    state.recordScan(new Date('2026-10-12T13:00:00Z'))
    state.recordScan(new Date('2026-10-12T13:00:30Z'))
    state.recordRelayPublish(new Date('2026-10-12T13:01:00Z'))
    assert.deepEqual(state.snapshot(), {
      status: 'ok',
      lastScanAt: '2026-10-12T13:00:30.000Z',
      lastRelayPublishAt: '2026-10-12T13:01:00.000Z',
    })
  })
})

describe('resolveHealthPort (R65)', () => {
  it('uses PORT when set and 8080 otherwise', () => {
    assert.equal(resolveHealthPort({ PORT: '3001' }), 3001)
    assert.equal(resolveHealthPort({}), 8080)
  })

  it('rejects a PORT that is not a number', () => {
    assert.throws(() => resolveHealthPort({ PORT: 'abc' }), /PORT/)
  })
})

// R65: the automation worker serves GET /healthz for the Railway health check.
describe('health server (R65)', () => {
  let state: HealthState
  let server: Server | undefined
  let baseUrl = ''

  before(async () => {
    state = createHealthState()
    server = createHealthServer(state)
    const listening = server
    await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`
  })

  after(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  })

  it('answers GET /healthz with the snapshot as JSON', async () => {
    state.recordScan(new Date('2026-10-12T13:00:00Z'))
    const response = await fetch(`${baseUrl}/healthz`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/)
    assert.deepEqual(await response.json(), state.snapshot())
  })

  it('answers 404 for other paths', async () => {
    const response = await fetch(`${baseUrl}/nope`)
    assert.equal(response.status, 404)
    await response.body?.cancel()
  })
})
