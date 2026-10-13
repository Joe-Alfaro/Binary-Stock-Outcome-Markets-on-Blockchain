export interface WorkerConfig {
  cluster: string
  demoMode: boolean
}

/** Reads the worker settings it needs from the environment. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    cluster: env.SOLANA_CLUSTER ?? 'devnet',
    demoMode: env.DEMO_MODE === 'true',
  }
}
