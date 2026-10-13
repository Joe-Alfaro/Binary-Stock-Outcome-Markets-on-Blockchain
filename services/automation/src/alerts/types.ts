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
 * A destination for alerts. Email, SMS or chat sinks are added by implementing this and
 * registering the sink in `sinksFromEnv`.
 * `send` may reject; callers go through `createAlerter`, which contains failures.
 */
export interface AlertSink {
  readonly name: string
  send(alert: Alert): Promise<void>
}

/** Writes one line of output, `console.log` by default. */
export type LineWriter = (line: string) => void
