import { guardCluster } from './guard.js'

const task = process.argv[2] ?? 'script'
guardCluster()
console.log(`TODO: ${task} is not implemented yet`)
