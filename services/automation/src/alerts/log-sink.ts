import type { AlertSink, LineWriter } from './types.js'

/**
 * Structured-log sink: writes each alert as one JSON line containing
 * `level: 'alert'`, `kind`, `message` and `details`.
 */
export function createLogSink(write: LineWriter = console.log): AlertSink {
  return {
    name: 'log',
    send(alert) {
      write(
        JSON.stringify({
          level: 'alert',
          kind: alert.kind,
          message: alert.message,
          details: alert.details,
        }),
      )
      return Promise.resolve()
    },
  }
}
