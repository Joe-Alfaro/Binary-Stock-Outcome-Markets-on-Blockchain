/** What an alert is about. Every source listed in the alerting requirement has a kind. */
export type AlertKind =
  | 'morning_job_failure'
  | 'settlement_first_alert'
  | 'settlement_second_alert'
  | 'admin_price_mismatch'
  | 'invariant_failure'

export interface Alert {
  kind: AlertKind
  message: string
  /** Structured context such as ticker, market address or prices. Must be JSON-serializable. */
  details?: Record<string, unknown>
}

/**
 * A destination for alerts. Email, SMS or chat sinks are added by implementing this.
 * `send` may reject; callers go through `createAlerter`, which contains failures.
 */
export interface AlertSink {
  readonly name: string
  send(alert: Alert): Promise<void>
}

/** Writes one line of output, `console.log` by default. */
export type LineWriter = (line: string) => void

/**
 * Structured-log sink: writes each alert as one JSON line containing
 * `level: 'alert'`, `kind`, `message` and `details`.
 */
export function createLogSink(write: LineWriter = console.log): AlertSink {
  throw new Error(`not implemented: createLogSink(${typeof write})`)
}

export interface WebhookSinkOptions {
  url: string
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch
}

/**
 * Generic webhook sink: POSTs the alert as a JSON body (`kind`, `message`, `details`) with
 * `content-type: application/json`. Rejects on a network error or a non-2xx response.
 */
export function createWebhookSink(options: WebhookSinkOptions): AlertSink {
  throw new Error(`not implemented: createWebhookSink(${options.url})`)
}

/**
 * Sinks selected by environment: the log sink always (named `log`), plus the webhook sink (named
 * `webhook`) when `ALERT_WEBHOOK_URL` is non-empty.
 */
export function sinksFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  write: LineWriter = console.log,
): AlertSink[] {
  throw new Error(`not implemented: sinksFromEnv(${Object.keys(env).length}, ${typeof write})`)
}

export interface Alerter {
  /** Delivers to every sink. Never rejects and never throws, even when every sink fails. */
  alert(alert: Alert): Promise<void>
}

export interface AlerterOptions {
  sinks: AlertSink[]
  /** Called once per failing sink, with the sink's name. Defaults to `console.error`. */
  logError?: (sinkName: string, error: unknown, alert: Alert) => void
}

/** Fans an alert out to all sinks. A failing sink is logged and doesn't stop the others. */
export function createAlerter(options: AlerterOptions): Alerter {
  throw new Error(`not implemented: createAlerter(${options.sinks.length})`)
}
