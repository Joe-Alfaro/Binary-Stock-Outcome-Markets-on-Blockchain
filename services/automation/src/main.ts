import { createRelaySource } from '@meridian/price-providers'
import { loadConfig } from './config.js'
import { createHealthServer, createHealthState, resolveHealthPort } from './health.js'
import { createIntradayService } from './intraday/index.js'
import { TICKERS } from './jobs/index.js'
import { startWorker } from './worker.js'

const config = loadConfig()
const health = createHealthState()
const port = resolveHealthPort(process.env)
// The chart route gets its own relay source, so a chart-driven 429 backoff never delays the relay.
const intraday = createIntradayService({
  source: createRelaySource(process.env),
  tickers: TICKERS,
  now: () => Math.floor(Date.now() / 1000),
})
const server = createHealthServer(health, { intraday }).listen(port, () => {
  console.log(`health check on :${port}/healthz and :${port}/prices/intraday/<ticker>`)
})
console.log(`automation worker starting on ${config.cluster} (demo mode: ${config.demoMode})`)
const worker = startWorker(health)

function shutdown() {
  worker.stop()
  void worker.done.finally(() => server.close())
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
