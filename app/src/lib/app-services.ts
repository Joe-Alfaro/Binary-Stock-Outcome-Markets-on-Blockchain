import {
  buildBuyNoTransaction,
  buildBuyYesTransaction,
  buildCancelOrder,
  buildCloseOutAndRedeem,
  buildCloseOutPosition,
  buildRedeem,
  buildSellNoTransaction,
  buildSellYesTransaction,
} from '@meridian/sdk'
import { createSolanaChainClient } from './chain'
import type { TradeBuilders } from './chain/builders'
import type { SolanaChainConfig } from './chain/solana'
import type { Services } from './services'
import { createWalletAdapters } from './wallet/adapters'
import { AdapterWalletPort } from './wallet/port'

const DEVNET_RPC = 'https://api.devnet.solana.com'
/** Placeholder until `NEXT_PUBLIC_RELAY_SIGNER_1` is set: no latest-price accounts will exist. */
const NO_RELAY_SIGNER = '11111111111111111111111111111111'

export interface AppServices extends Services {
  wallet: AdapterWalletPort
}

/** The SDK trade-path, unwind and redeem builders. */
export const sdkTradeBuilders: TradeBuilders = {
  buildBuyYesTransaction,
  buildSellYesTransaction,
  buildBuyNoTransaction,
  buildSellNoTransaction,
  buildRedeem,
  buildCloseOutAndRedeem,
  buildCancelOrder,
  buildCloseOutPosition,
}

let instance: AppServices | null = null

/** Program IDs have no default: a stale literal points at the wrong program after a key sync. */
function programId(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not set: set it in .env or run anchor build`)
  return value
}

/**
 * The chain client's configuration from the `NEXT_PUBLIC_*` variables. Next.js inlines each
 * variable only when it is referenced by its full name, so they're spelled out. `next.config.ts`
 * fills unset program IDs from the built IDLs.
 */
export function appChainConfig(): SolanaChainConfig {
  return {
    rpcUrl: process.env.NEXT_PUBLIC_SOLANA_RPC_URL || DEVNET_RPC,
    wsUrl: process.env.NEXT_PUBLIC_SOLANA_WS_URL || undefined,
    programId: programId(
      process.env.NEXT_PUBLIC_MERIDIAN_PROGRAM_ID,
      'NEXT_PUBLIC_MERIDIAN_PROGRAM_ID',
    ),
    oracleProgramId: programId(
      process.env.NEXT_PUBLIC_MERIDIAN_ORACLE_PROGRAM_ID,
      'NEXT_PUBLIC_MERIDIAN_ORACLE_PROGRAM_ID',
    ),
    relaySigner: process.env.NEXT_PUBLIC_RELAY_SIGNER_1 || NO_RELAY_SIGNER,
    builders: sdkTradeBuilders,
  }
}

/** The app's services, created once per page load. */
export function getAppServices(): AppServices {
  if (instance) return instance
  instance = {
    chain: createSolanaChainClient(appChainConfig()),
    wallet: new AdapterWalletPort(createWalletAdapters()),
    now: () => Math.floor(Date.now() / 1000),
  }
  return instance
}
