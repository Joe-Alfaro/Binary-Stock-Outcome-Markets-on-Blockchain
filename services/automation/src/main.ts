import { loadConfig } from './config.js'
import { createHealthServer, createHealthState, resolveHealthPort } from './health.js'

const config = loadConfig()
const health = createHealthState()
const port = resolveHealthPort(process.env)
createHealthServer(health).listen(port, () => {
  console.log(`health check on :${port}/healthz`)
})
// TODO: start the scheduler, relay publishers and price endpoint, recording into `health`.
console.log(`automation worker starting on ${config.cluster} (demo mode: ${config.demoMode})`)
