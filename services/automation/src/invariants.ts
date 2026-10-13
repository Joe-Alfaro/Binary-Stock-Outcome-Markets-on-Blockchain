import type { Alerter } from './alerts/index.js'
import type { Clock, JobLogger } from './jobs/index.js'

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

/** USDC base units behind one pair, and the base units of one outcome token (6 decimals). */
const UNIT = 1_000_000n

interface Check {
  check: string
  holds: boolean
  message: string
}

const units = (amount: bigint) => `${amount} base units`

function checksOf(market: MarketCollateral): Check[] {
  const { collateral, vaultBalance, pairsOutstanding, yesSupply, noSupply } = market
  // Donated USDC only adds backing, so the vault is checked as a lower bound everywhere.
  const vault: Check = {
    check: 'vault-covers-collateral',
    holds: vaultBalance >= collateral,
    message: `vault holds ${units(vaultBalance)}, below the collateral counter ${units(collateral)}`,
  }
  if (market.status === 'open') {
    const backing = pairsOutstanding * UNIT
    return [
      vault,
      {
        check: 'collateral-matches-pairs',
        holds: collateral === backing,
        message: `collateral ${units(collateral)} is not ${pairsOutstanding} pairs × $1`,
      },
      {
        check: 'yes-supply-matches-pairs',
        holds: yesSupply === backing,
        message: `Yes supply ${units(yesSupply)} is not ${pairsOutstanding} pairs`,
      },
      {
        check: 'no-supply-matches-pairs',
        holds: noSupply === backing,
        message: `No supply ${units(noSupply)} is not ${pairsOutstanding} pairs`,
      },
    ]
  }
  if (market.outcome === null) return [vault]
  // After settlement each winning token redeems for $1 and losing tokens for nothing.
  const winning = market.outcome === 'yes' ? yesSupply : noSupply
  return [
    vault,
    {
      check: 'collateral-covers-winners',
      holds: collateral >= winning,
      message: `collateral ${units(collateral)} is below the ${market.outcome} supply ${units(winning)}`,
    },
    {
      check: 'vault-covers-winners',
      holds: vaultBalance >= winning,
      message: `vault holds ${units(vaultBalance)}, below the ${market.outcome} supply ${units(winning)}`,
    },
  ]
}

/** The R2/R6/R7 checks on one snapshot. */
export function checkMarketInvariants(market: MarketCollateral): InvariantViolation[] {
  return checksOf(market)
    .filter(({ holds }) => !holds)
    .map(({ check, message }) => ({
      market: market.address,
      ticker: market.ticker,
      tradingDay: market.tradingDay,
      check,
      message,
    }))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One audit pass: reads every market, checks its invariants and sends one `invariant_failure`
 * alert per violation. Never throws.
 */
export async function auditInvariants(deps: InvariantAuditDeps): Promise<InvariantViolation[]> {
  const { chain, alerter, log } = deps
  let markets: MarketCollateral[]
  try {
    markets = await chain.listMarketCollateral()
  } catch (error) {
    log.error('invariant audit failed to read markets', { error: errorMessage(error) })
    return []
  }
  const violations = markets.flatMap(checkMarketInvariants)
  log.info('invariant audit', { markets: markets.length, violations: violations.length })
  await Promise.all(
    violations.map((violation) => {
      log.error('invariant violated', { ...violation })
      return alerter.alert({
        kind: 'invariant_failure',
        message: `${violation.ticker} ${violation.tradingDay} market ${violation.market}: ${violation.message}`,
        details: { ...violation },
      })
    }),
  )
  return violations
}

/** How often the worker audits every market. */
export const AUDIT_INTERVAL_MS = 60_000

/** Audits every market now and then every minute until `signal` aborts (R46). */
export async function runInvariantAudits(
  deps: InvariantAuditDeps & { clock: Clock; signal: AbortSignal },
): Promise<void> {
  while (!deps.signal.aborted) {
    await auditInvariants(deps)
    await deps.clock.sleep(AUDIT_INTERVAL_MS, deps.signal)
  }
}
