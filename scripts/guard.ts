/* eslint-disable @typescript-eslint/no-unused-vars -- stubs until the implementation lands */
import { assertNotMainnet } from '@meridian/sdk'

/** Refuses to continue when SOLANA_CLUSTER or SOLANA_RPC_URL points at mainnet. */
export function guardCluster(env: NodeJS.ProcessEnv = process.env) {
  assertNotMainnet(env.SOLANA_CLUSTER ?? '')
  assertNotMainnet(env.SOLANA_RPC_URL ?? '')
}

/** Genesis hash of mainnet-beta. */
export const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'

export type ClusterName = 'localnet' | 'devnet' | 'testnet' | 'mainnet-beta'

export interface ClusterTarget {
  cluster: ClusterName
  rpcUrl: string
}

/** The one RPC call the guard needs. Scripts pass their chain client. */
export interface GenesisRpc {
  getGenesisHash(): Promise<string>
}

/** Reads SOLANA_CLUSTER (default devnet) and SOLANA_RPC_URL (default: the cluster's public URL). */
export function resolveCluster(_env: NodeJS.ProcessEnv): ClusterTarget {
  throw new Error('not implemented')
}

/**
 * Refuses mainnet-beta by cluster name or RPC URL before any network call, then asks the RPC for
 * its genesis hash and refuses a mainnet match. Every deploy, bootstrap and demo entry point
 * calls this first.
 */
export async function assertSafeTarget(
  _env: NodeJS.ProcessEnv,
  _rpc: GenesisRpc,
): Promise<ClusterTarget> {
  throw new Error('not implemented')
}

/** Demo mode is allowed only on localnet and devnet. */
export function assertDemoCluster(_cluster: string): void {
  throw new Error('not implemented')
}
