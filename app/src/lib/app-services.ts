import { createSolanaChainClient } from './chain'
import type { Services } from './services'
import { createWalletAdapters } from './wallet/adapters'
import { AdapterWalletPort } from './wallet/port'

const DEVNET_RPC = 'https://api.devnet.solana.com'
const PROGRAM_ID = '9o9a9HpN6Aq4UBeozWshAKBugjtToxWdsVzSMPkVHEMX'
const ORACLE_PROGRAM_ID = '3HDbiFX8iSf7zXfaYmFRPNnKsjUiLvF55rHperUvjjVY'
/** Placeholder until `NEXT_PUBLIC_RELAY_SIGNER_1` is set: no latest-price accounts will exist. */
const NO_RELAY_SIGNER = '11111111111111111111111111111111'

export interface AppServices extends Services {
  wallet: AdapterWalletPort
}

let instance: AppServices | null = null

/**
 * The app's services, created once per page load from the `NEXT_PUBLIC_*` variables. Next.js
 * inlines each variable only when it is referenced by its full name, so they're spelled out.
 */
export function getAppServices(): AppServices {
  if (instance) return instance
  instance = {
    chain: createSolanaChainClient({
      rpcUrl: process.env.NEXT_PUBLIC_SOLANA_RPC_URL || DEVNET_RPC,
      wsUrl: process.env.NEXT_PUBLIC_SOLANA_WS_URL || undefined,
      programId: process.env.NEXT_PUBLIC_MERIDIAN_PROGRAM_ID || PROGRAM_ID,
      oracleProgramId: process.env.NEXT_PUBLIC_MERIDIAN_ORACLE_PROGRAM_ID || ORACLE_PROGRAM_ID,
      relaySigner: process.env.NEXT_PUBLIC_RELAY_SIGNER_1 || NO_RELAY_SIGNER,
    }),
    wallet: new AdapterWalletPort(createWalletAdapters()),
    now: () => Math.floor(Date.now() / 1000),
  }
  return instance
}
