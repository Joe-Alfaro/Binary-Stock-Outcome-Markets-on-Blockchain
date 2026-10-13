import type { ChainClient } from './types'

export interface SolanaChainConfig {
  rpcUrl: string
  wsUrl?: string
  programId: string
  oracleProgramId: string
  /** Public key of the relay signer whose latest-price accounts the app reads. */
  relaySigner: string
}

/** The `ChainClient` backed by an RPC connection. */
export function createSolanaChainClient(config: SolanaChainConfig): ChainClient {
  void config
  throw new Error('not implemented')
}
