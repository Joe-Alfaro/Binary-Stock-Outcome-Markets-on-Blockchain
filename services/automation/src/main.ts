import { loadConfig } from './config.js'
import { createHealthServer, createHealthState, resolveHealthPort } from './health.js'
import { startWorker } from './worker.js'

const config = loadConfig()
const health = createHealthState()
const port = resolveHealthPort(process.env)
const server = createHealthServer(health).listen(port, () => {
  console.log(`health check on :${port}/healthz`)
})
console.log(`automation worker starting on ${config.cluster} (demo mode: ${config.demoMode})`)
// TODO: start the relay publishers and price endpoint, recording into `health`.
const worker = startWorker(health)

function shutdown() {
  worker.stop()
  void worker.done.finally(() => server.close())
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
