'use client'

import { computePortfolio, marketMakerSummary } from '@meridian/sdk'
import type { MarketExposure, Position, ProgramEvent } from '@meridian/sdk'
import { useCallback } from 'react'
import type { ContractSummary } from '../lib/chain'
import {
  contractLabel,
  formatCentsAsDollars,
  formatPnl,
  formatSigned,
  formatUsd,
  shortAddress,
} from '../lib/format'
import { useAsync, useTransaction, useWalletKey } from '../lib/hooks'
import type { TxState } from '../lib/hooks'
import { useServices } from '../lib/services'
import { ConnectPrompt } from './ConnectPrompt'

interface PortfolioData {
  markets: ReadonlyMap<string, ContractSummary>
  events: ProgramEvent[]
}

function labelFor(markets: ReadonlyMap<string, ContractSummary>, market: string): string {
  const contract = markets.get(market)
  return contract ? contractLabel(contract) : shortAddress(market)
}

function yesMarks(markets: ReadonlyMap<string, ContractSummary>): Map<string, number> {
  const marks = new Map<string, number>()
  markets.forEach((c) => {
    if (c.yesPriceCents !== null) marks.set(c.market, c.yesPriceCents)
  })
  return marks
}

function StatusCell({ contract }: { contract: ContractSummary | undefined }) {
  if (!contract) return <td>—</td>
  if (contract.status !== 'Settled' || !contract.settlement) return <td>{contract.status}</td>
  const s = contract.settlement
  return (
    <td>
      Settled at {formatUsd(s.price)}
      <span className="muted"> · {s.source}</span>
    </td>
  )
}

function PositionRow({
  position,
  contract,
  label,
  busy,
  onRedeem,
  onCloseOut,
}: {
  position: Position
  contract: ContractSummary | undefined
  label: string
  busy: boolean
  onRedeem: () => void
  onCloseOut: () => void
}) {
  const settled = contract?.status === 'Settled'
  const pnl = position.realizedPnlCents + position.unrealizedPnlCents
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{position.side}</td>
      <td className="num">{position.qty}</td>
      <td className="num">{formatCentsAsDollars(position.avgEntryCents)}</td>
      <td className="num">{formatCentsAsDollars(position.markCents)}</td>
      <td className={`num ${pnl < 0 ? 'loss' : 'gain'}`}>{formatPnl(pnl)}</td>
      <StatusCell contract={contract} />
      <td>
        {settled && position.qty > 0 && (
          <div className="actions">
            <button
              type="button"
              className="button button--primary"
              disabled={busy}
              onClick={onRedeem}
            >
              Redeem
            </button>
            <button
              type="button"
              className="button button--ghost"
              disabled={busy}
              onClick={onCloseOut}
            >
              Close out orders and redeem
            </button>
          </div>
        )}
      </td>
    </tr>
  )
}

function ExposureRow({ exposure, label }: { exposure: MarketExposure; label: string }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td className="num">{exposure.yes}</td>
      <td className="num">{exposure.no}</td>
      <td className="num">{formatSigned(exposure.netYes)}</td>
      <td className="num">{exposure.fills}</td>
      <td className="num">{exposure.makerFills}</td>
      <td className="num">{formatPnl(exposure.realizedPnlCents + exposure.unrealizedPnlCents)}</td>
    </tr>
  )
}

function txText(tx: TxState): string {
  switch (tx.phase) {
    case 'signing':
      return `${tx.label}: approve the transaction in your wallet…`
    case 'confirming':
      return `${tx.label}: waiting for confirmation…`
    case 'confirmed':
      return `${tx.label} confirmed. Signature ${shortAddress(tx.signature)}.`
    default:
      return ''
  }
}

function Portfolio({ owner }: { owner: string }) {
  const { chain } = useServices()
  const load = useCallback(async (): Promise<PortfolioData> => {
    const [markets, events] = await Promise.all([chain.listMarkets(), chain.getEvents(owner)])
    return { markets: new Map(markets.map((m) => [m.market, m])), events }
  }, [chain, owner])
  const { state, reload } = useAsync(load, owner)
  const { tx, run } = useTransaction()
  const busy = tx.phase === 'signing' || tx.phase === 'confirming'

  async function redeem(market: string, closeOut: boolean) {
    const request = { market, owner }
    const ok = closeOut
      ? await run('Close out and redeem', () => chain.buildCloseOutAndRedeem(request))
      : await run('Redeem', () => chain.buildRedeem(request))
    if (ok) reload()
  }

  if (state.status === 'loading') return <p className="muted">Loading your positions…</p>
  if (state.status === 'error') return <p className="notice notice--error">{state.message}</p>

  const { markets, events } = state.value
  const options = { wallet: owner, yesMarks: yesMarks(markets) }
  const { positions } = computePortfolio(events, options)
  const exposures = marketMakerSummary(events, options)

  return (
    <>
      <p role="status" aria-live="polite" className="tx-status">
        {txText(tx)}
      </p>
      {tx.phase === 'failed' && (
        <div role="alert" className="notice notice--error">
          <p>{tx.message}</p>
        </div>
      )}

      <section aria-labelledby="positions-title">
        <h2 id="positions-title">Positions</h2>
        <div className="table-scroll">
          <table className="data">
            <caption className="visually-hidden">Positions</caption>
            <thead>
              <tr>
                <th scope="col">Contract</th>
                <th scope="col">Side</th>
                <th scope="col" className="num">
                  Quantity
                </th>
                <th scope="col" className="num">
                  Entry
                </th>
                <th scope="col" className="num">
                  Current
                </th>
                <th scope="col" className="num">
                  P&amp;L
                </th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {positions.map((position) => (
                <PositionRow
                  key={`${position.market}-${position.side}`}
                  position={position}
                  contract={markets.get(position.market)}
                  label={labelFor(markets, position.market)}
                  busy={busy}
                  onRedeem={() => redeem(position.market, false)}
                  onCloseOut={() => redeem(position.market, true)}
                />
              ))}
              {positions.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    No positions yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="muted">
          Entry is your average price per token. A No bought by minting a pair and selling the Yes
          costs $1.00 minus the Yes sale price. Settled positions are valued at $1.00 or $0.00.
        </p>
      </section>

      <section aria-labelledby="mm-title">
        <h2 id="mm-title">Market maker view</h2>
        <div className="table-scroll">
          <table className="data">
            <caption className="visually-hidden">Market maker view</caption>
            <thead>
              <tr>
                <th scope="col">Contract</th>
                <th scope="col" className="num">
                  Yes
                </th>
                <th scope="col" className="num">
                  No
                </th>
                <th scope="col" className="num">
                  Net Yes
                </th>
                <th scope="col" className="num">
                  Fills
                </th>
                <th scope="col" className="num">
                  Maker fills
                </th>
                <th scope="col" className="num">
                  P&amp;L
                </th>
              </tr>
            </thead>
            <tbody>
              {exposures.map((exposure) => (
                <ExposureRow
                  key={exposure.market}
                  exposure={exposure}
                  label={labelFor(markets, exposure.market)}
                />
              ))}
              {exposures.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    No fills yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}

/** Positions, P&L, settled outcomes, redeem and the market-maker view (R52). */
export function PortfolioPage() {
  const owner = useWalletKey()
  return (
    <div className="page">
      <header className="page__header">
        <h1>Portfolio</h1>
      </header>
      {owner ? <Portfolio owner={owner} /> : <ConnectPrompt what="your positions" />}
    </div>
  )
}
