import { createServer, type Server, type ServerResponse } from 'node:http'
import type { IntradayService } from './intraday/index.js'

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

export interface HealthServerOptions {
  /** Serves `GET /prices/intraday/<ticker>`, the Markets chart's series (R66). */
  intraday?: IntradayService
}

const INTRADAY_PATH = /^\/prices\/intraday\/([^/]+)$/

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers })
  response.end(JSON.stringify(body))
}

/** Answers `GET /prices/intraday/<ticker>` from the cached service; any origin may read it. */
async function serveIntraday(intraday: IntradayService, ticker: string, response: ServerResponse) {
  const cors = { 'access-control-allow-origin': '*' }
  const result = await intraday.get(ticker).catch(() => null)
  if (result === null) return sendJson(response, 503, { error: 'unavailable' }, cors)
  if (!result.ok) return sendJson(response, result.status, { error: result.error }, cors)
  sendJson(response, 200, result.series, cors)
}

/**
 * HTTP server for the Railway health check: `GET /healthz` returns the snapshot as JSON. With an
 * intraday service it also serves the Markets chart's read-only price route.
 */
export function createHealthServer(state: HealthState, options: HealthServerOptions = {}): Server {
  return createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    if (request.method === 'GET' && path === '/healthz') {
      sendJson(response, 200, state.snapshot())
      return
    }
    const intradayMatch = INTRADAY_PATH.exec(path)
    if (request.method === 'GET' && options.intraday && intradayMatch) {
      void serveIntraday(options.intraday, intradayMatch[1] ?? '', response)
      return
    }
    sendJson(response, 404, { error: 'not found' })
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
