'use client'

import type { ProgramEvent } from '@meridian/sdk'
import { useCallback } from 'react'
import type { ContractSummary } from '../lib/chain'
import { contractLabel, formatCents, formatEt, shortAddress } from '../lib/format'
import { useAsync, useWalletKey } from '../lib/hooks'
import { useServices } from '../lib/services'
import { ConnectPrompt } from './ConnectPrompt'

interface HistoryRow {
  key: string
  type: 'Fill' | 'Mint' | 'Merge' | 'Redeem'
  market: string
  role: 'Maker' | 'Taker' | null
  action: string
  priceCents: number | null
  qty: number
  ts: number
  signature: string
}

/** The wallet's own activity. Fills between two other wallets are left out (R53). */
function toRows(events: readonly ProgramEvent[], owner: string): HistoryRow[] {
  return events.flatMap((event, i): HistoryRow[] => {
    const base = {
      key: `${event.signature}-${i}`,
      market: event.market,
      ts: event.ts,
      signature: event.signature,
    }
    switch (event.kind) {
      case 'OrderFilled': {
        const rows: HistoryRow[] = []
        const fill = {
          ...base,
          type: 'Fill' as const,
          priceCents: event.priceCents,
          qty: event.qty,
        }
        const takerBuys = event.takerSide === 'Bid'
        if (event.taker === owner) {
          rows.push({ ...fill, role: 'Taker', action: takerBuys ? 'Buy Yes' : 'Sell Yes' })
        }
        if (event.maker === owner) {
          rows.push({
            ...fill,
            key: `${base.key}-m`,
            role: 'Maker',
            action: takerBuys ? 'Sell Yes' : 'Buy Yes',
          })
        }
        return rows
      }
      case 'PairMinted':
        if (event.owner !== owner) return []
        return [
          {
            ...base,
            type: 'Mint',
            role: null,
            action: 'Mint pairs',
            priceCents: null,
            qty: event.qty,
          },
        ]
      case 'PairMerged':
        if (event.owner !== owner) return []
        return [
          {
            ...base,
            type: 'Merge',
            role: null,
            action: 'Merge pairs',
            priceCents: null,
            qty: event.qty,
          },
        ]
      case 'Redeemed':
        if (event.owner !== owner) return []
        return [
          {
            ...base,
            type: 'Redeem',
            role: null,
            action: 'Redeem',
            priceCents: null,
            qty: event.yesQty + event.noQty,
          },
        ]
      case 'MarketSettled':
        return []
    }
  })
}

function History({ owner }: { owner: string }) {
  const { chain } = useServices()
  const load = useCallback(async () => {
    const [markets, events] = await Promise.all([chain.listMarkets(), chain.getEvents(owner)])
    return { markets: new Map(markets.map((m) => [m.market, m])), events }
  }, [chain, owner])
  const { state } = useAsync(load, owner)

  if (state.status === 'loading') return <p className="muted">Loading your history…</p>
  if (state.status === 'error') return <p className="notice notice--error">{state.message}</p>

  const { markets, events } = state.value
  const label = (market: string) => {
    const contract: ContractSummary | undefined = markets.get(market)
    return contract ? contractLabel(contract) : shortAddress(market)
  }
  const rows = toRows(events, owner).reverse()

  return (
    <div className="table-scroll">
      <table className="data">
        <caption className="visually-hidden">History</caption>
        <thead>
          <tr>
            <th scope="col">Type</th>
            <th scope="col">Contract</th>
            <th scope="col">Role</th>
            <th scope="col">Action</th>
            <th scope="col" className="num">
              Yes price
            </th>
            <th scope="col" className="num">
              Quantity
            </th>
            <th scope="col">Time</th>
            <th scope="col">Transaction</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>{row.type}</td>
              <td>{label(row.market)}</td>
              <td>{row.role ?? '—'}</td>
              <td>{row.action}</td>
              <td className="num">{row.priceCents === null ? '—' : formatCents(row.priceCents)}</td>
              <td className="num">{row.qty}</td>
              <td>{row.ts ? formatEt(row.ts, { date: true }) : '—'}</td>
              <td>
                <a
                  href={`https://explorer.solana.com/tx/${row.signature}?cluster=devnet`}
                  target="_blank"
                  rel="noreferrer"
                  className="mono"
                >
                  {shortAddress(row.signature)}
                </a>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={8} className="muted">
                Nothing yet. Your fills, mints, merges and redemptions show here.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

/** Fills (as maker or taker), mints, merges and redemptions from program events (R53). */
export function HistoryPage() {
  const owner = useWalletKey()
  return (
    <div className="page">
      <header className="page__header">
        <h1>History</h1>
        <p className="muted">
          Decoded from on-chain program events. Maker fills include orders of yours filled in other
          wallets&apos; transactions. Times are Eastern.
        </p>
      </header>
      {owner ? <History owner={owner} /> : <ConnectPrompt what="your history" />}
    </div>
  )
}
