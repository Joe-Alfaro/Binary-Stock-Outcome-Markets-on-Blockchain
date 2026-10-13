/** Structured job log. Details may hold bigints; sinks format them. */
export interface JobLogger {
  info(message: string, details?: Record<string, unknown>): void
  error(message: string, details?: Record<string, unknown>): void
}
