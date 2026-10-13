import { assertNotMainnet } from '@meridian/sdk'

/** Refuses to continue when SOLANA_CLUSTER or SOLANA_RPC_URL points at mainnet. */
export function guardCluster(env: NodeJS.ProcessEnv = process.env) {
  assertNotMainnet(env.SOLANA_CLUSTER ?? '')
  assertNotMainnet(env.SOLANA_RPC_URL ?? '')
}

/** Genesis hash of mainnet-beta. */
export const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'

/** RPC port of the local validator when LOCAL_VALIDATOR_RPC_PORT is unset, clear of 8899-8900. */
export const DEFAULT_LOCAL_RPC_PORT = 8913

export type ClusterName = 'localnet' | 'devnet' | 'testnet' | 'mainnet-beta'

export interface ClusterTarget {
  cluster: ClusterName
  rpcUrl: string
}

/** The one RPC call the guard needs. Scripts pass their chain client. */
export interface GenesisRpc {
  getGenesisHash(): Promise<string>
}

const PUBLIC_RPC_URLS: Record<Exclude<ClusterName, 'localnet'>, string> = {
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
}

function isClusterName(name: string): name is ClusterName {
  return name === 'localnet' || name in PUBLIC_RPC_URLS
}

/** The local validator's RPC URL, from LOCAL_VALIDATOR_RPC_PORT. */
export function localRpcUrl(env: NodeJS.ProcessEnv) {
  return `http://127.0.0.1:${env.LOCAL_VALIDATOR_RPC_PORT || DEFAULT_LOCAL_RPC_PORT}`
}

/** Reads SOLANA_CLUSTER (default devnet) and SOLANA_RPC_URL (default: the cluster's public URL). */
export function resolveCluster(env: NodeJS.ProcessEnv): ClusterTarget {
  const cluster = env.SOLANA_CLUSTER || 'devnet'
  if (!isClusterName(cluster)) throw new Error(`Unknown SOLANA_CLUSTER: ${cluster}`)
  const defaultUrl = cluster === 'localnet' ? localRpcUrl(env) : PUBLIC_RPC_URLS[cluster]
  return { cluster, rpcUrl: env.SOLANA_RPC_URL || defaultUrl }
}

/**
 * Refuses mainnet-beta by cluster name or RPC URL before any network call, then asks the RPC for
 * its genesis hash and refuses a mainnet match. Every deploy, bootstrap and demo entry point
 * calls this first.
 */
export async function assertSafeTarget(
  env: NodeJS.ProcessEnv,
  rpc: GenesisRpc,
): Promise<ClusterTarget> {
  guardCluster(env)
  const target = resolveCluster(env)
  assertNotMainnet(target.cluster)
  assertNotMainnet(target.rpcUrl)
  if ((await rpc.getGenesisHash()) === MAINNET_GENESIS_HASH) {
    throw new Error(
      `Refusing to run against mainnet: ${target.rpcUrl} has the mainnet genesis hash`,
    )
  }
  return target
}

/** Demo mode is allowed only on localnet and devnet. */
export function assertDemoCluster(cluster: string): void {
  if (cluster !== 'localnet' && cluster !== 'devnet') {
    throw new Error(`Demo mode runs only on localnet or devnet, not ${cluster}`)
  }
}
