import type { Alert, AlertSink } from './types.js'

export interface Alerter {
  /** Delivers to every sink. Never rejects and never throws, even when every sink fails. */
  alert(alert: Alert): Promise<void>
}

export interface AlerterOptions {
  sinks: AlertSink[]
  /** Called once per failing sink, with the sink's name. Defaults to `console.error`. */
  logError?: (sinkName: string, error: unknown, alert: Alert) => void
}

function logToConsole(sinkName: string, error: unknown, alert: Alert): void {
  console.error(`alert sink "${sinkName}" failed to deliver ${alert.kind}:`, error)
}

/** Fans an alert out to all sinks. A failing sink is logged and doesn't stop the others. */
export function createAlerter(options: AlerterOptions): Alerter {
  const { sinks, logError = logToConsole } = options
  return {
    async alert(alert) {
      await Promise.all(
        sinks.map((sink) =>
          // Wrapping in `then` turns a synchronous throw from `send` into a rejection.
          Promise.resolve()
            .then(() => sink.send(alert))
            .catch((error: unknown) => {
              try {
                logError(sink.name, error, alert)
              } catch {
                // Alerting must never take down the caller, even when logging is broken.
              }
            }),
        ),
      )
    },
  }
}
