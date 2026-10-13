import { createServer, type Server } from 'node:http'

export interface HealthSnapshot {
  status: 'ok'
  /** ISO time of the last successful market scan, or null before the first. */
  lastScanAt: string | null
  /** ISO time of the last successful relay publish, or null before the first. */
  lastRelayPublishAt: string | null
}

export interface HealthState {
  recordScan(at: Date): void
  recordRelayPublish(at: Date): void
  snapshot(): HealthSnapshot
}

const DEFAULT_PORT = 8080

export function createHealthState(): HealthState {
  let lastScanAt: Date | null = null
  let lastRelayPublishAt: Date | null = null
  return {
    recordScan(at) {
      lastScanAt = at
    },
    recordRelayPublish(at) {
      lastRelayPublishAt = at
    },
    snapshot() {
      return {
        status: 'ok',
        lastScanAt: lastScanAt?.toISOString() ?? null,
        lastRelayPublishAt: lastRelayPublishAt?.toISOString() ?? null,
      }
    },
  }
}

/** HTTP server for the Railway health check: `GET /healthz` returns the snapshot as JSON. */
export function createHealthServer(state: HealthState): Server {
  return createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    if (request.method === 'GET' && path === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(state.snapshot()))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'not found' }))
  })
}

/** Port from PORT (Railway sets it), default 8080. */
export function resolveHealthPort(env: NodeJS.ProcessEnv): number {
  if (!env.PORT) return DEFAULT_PORT
  const port = Number(env.PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be a port number, got ${env.PORT}`)
  }
  return port
}
