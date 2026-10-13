export interface RetryPolicy {
  /** Total tries, the first included. */
  attempts: number
  /** Wait before the second try; it doubles for each later one. */
  baseDelayMs: number
  sleep(ms: number): Promise<void>
}

/**
 * Program and runtime rejections that a retry can't change. Anchor errors carry `Error Code:`,
 * other programs `custom program error`, and an `init` on a live account `already in use`.
 */
const PERMANENT = /Error Code:|custom program error|already in use|InstructionError/

/** The error text with any transaction logs attached to it. */
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const logs = (error as { logs?: unknown } | null)?.logs
  return Array.isArray(logs) ? `${message}\n${logs.join('\n')}` : message
}

/** True for transport failures (timeouts, rate limits, expired blockhashes) worth retrying. */
export function isTransient(error: unknown): boolean {
  return !PERMANENT.test(errorText(error))
}

/** Runs `fn`, retrying transient failures with exponential backoff up to `policy.attempts`. */
export async function withRetry<T>(policy: RetryPolicy, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= policy.attempts || !isTransient(error)) throw error
      await policy.sleep(policy.baseDelayMs * 2 ** (attempt - 1))
    }
  }
}
