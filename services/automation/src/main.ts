import { loadConfig } from './config.js'

const config = loadConfig()
// TODO: start the scheduler, relay publishers and price endpoint.
console.log(`automation worker starting on ${config.cluster} (demo mode: ${config.demoMode})`)
