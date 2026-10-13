import { assertNotMainnet } from '@meridian/sdk'

/** Refuses to continue when SOLANA_CLUSTER or SOLANA_RPC_URL points at mainnet. */
export function guardCluster(env: NodeJS.ProcessEnv = process.env) {
  assertNotMainnet(env.SOLANA_CLUSTER ?? '')
  assertNotMainnet(env.SOLANA_RPC_URL ?? '')
}
