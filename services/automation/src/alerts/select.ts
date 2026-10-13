import { createLogSink } from './log-sink.js'
import type { AlertSink, LineWriter } from './types.js'
import { createWebhookSink } from './webhook-sink.js'

/**
 * Sinks selected by environment: the log sink always (named `log`), plus the webhook sink (named
 * `webhook`) when `ALERT_WEBHOOK_URL` is non-empty. New sinks (email, SMS, chat) are added here,
 * each enabled by its own variable.
 */
export function sinksFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  write: LineWriter = console.log,
): AlertSink[] {
  const sinks: AlertSink[] = [createLogSink(write)]
  if (env.ALERT_WEBHOOK_URL) sinks.push(createWebhookSink({ url: env.ALERT_WEBHOOK_URL }))
  return sinks
}
