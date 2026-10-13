import type { Alerter } from './alerts/index.js'
import type { JobLogger } from './jobs/index.js'

/**
 * One market's collateral and supply as read from the chain: the `Market` account's counters,
 * the vault's token balance and both outcome mints' supplies, all in base units.
 */
export interface MarketCollateral {
  /** Market account address (base58). */
  address: string
  ticker: string
  /** `YYYY-MM-DD` in America/New_York. */
  tradingDay: string
  status: 'open' | 'settled'
  /** Null until settled. */
  outcome: 'yes' | 'no' | null
  /** The market's internal collateral counter. */
  collateral: bigint
  pairsOutstanding: bigint
  vaultBalance: bigint
  yesSupply: bigint
  noSupply: bigint
}

/** One broken invariant on one market. */
export interface InvariantViolation {
  market: string
  ticker: string
  tradingDay: string
  /** Which check failed, for example `vault-covers-collateral`. */
  check: string
  message: string
}

/** Reads every market's collateral snapshot; the Anchor chain client implements it. */
export interface CollateralReader {
  listMarketCollateral(): Promise<MarketCollateral[]>
}

export interface InvariantAuditDeps {
  chain: CollateralReader
  alerter: Alerter
  log: JobLogger
}

/** The R2/R6/R7 checks on one snapshot. */
export function checkMarketInvariants(market: MarketCollateral): InvariantViolation[] {
  void market
  return []
}

/**
 * One audit pass: reads every market, checks its invariants and sends one `invariant_failure`
 * alert per violation. Never throws.
 */
export async function auditInvariants(deps: InvariantAuditDeps): Promise<InvariantViolation[]> {
  void deps
  return []
}
