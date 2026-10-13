/* eslint-disable @typescript-eslint/no-unused-vars -- stubs until the implementation lands */
import type { Server } from 'node:http'

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

export function createHealthState(): HealthState {
  throw new Error('not implemented')
}

/** HTTP server for the Railway health check: `GET /healthz` returns the snapshot as JSON. */
export function createHealthServer(_state: HealthState): Server {
  throw new Error('not implemented')
}

/** Port from PORT (Railway sets it), default 8080. */
export function resolveHealthPort(_env: NodeJS.ProcessEnv): number {
  throw new Error('not implemented')
}
