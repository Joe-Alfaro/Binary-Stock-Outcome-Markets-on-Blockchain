'use client'

import { useCallback } from 'react'
import { reopenLabel } from '@meridian/automation/calendar/next-open'
import { TICKERS } from '../lib/chain'
import type { ContractSummary, LatestPrice, Ticker } from '../lib/chain'
import { formatUsd } from '../lib/format'
import { useAsync, useIntraday, useLatestPrices, useNow } from '../lib/hooks'
import type { IntradayState } from '../lib/hooks'
import { formatPublishTime, isStale } from '../lib/prices'
import { useServices } from '../lib/services'
import { PriceChart } from './PriceChart'

function activeCount(markets: readonly ContractSummary[], ticker: Ticker): number {
  return markets.filter((m) => m.ticker === ticker && m.status === 'Open').length
}

/**
 * The header pill while the regular session is closed (R68, R69). It shows only "Closed"; its
 * accessible name keeps the next open, which the status line under the chart shows.
 */
function ClosedTag({ reopens }: { reopens: string }) {
  return (
    <span className="closed-tag" role="status" aria-label={`Closed. ${reopens}`}>
      Closed
    </span>
  )
}

/** The worker's session close: the last point of a complete (not live) session. */
function sessionClose(state: IntradayState): number | undefined {
  if (state.status !== 'ready' || state.series.live) return undefined
  return state.series.points.at(-1)?.price
}

/** The line under the chart: the next open while closed, else the price's publish time. */
function statusLine(reopens: string | null, price: LatestPrice | undefined) {
  if (reopens !== null) return reopens
  if (price) return <>As of {formatPublishTime(price.publishTs)}</>
  return 'Waiting for the first price'
}

function TickerCard({
  ticker,
  price,
  active,
  nowTs,
}: {
  ticker: Ticker
  price: LatestPrice | undefined
  active: number | null
  nowTs: number
}) {
  const titleId = `ticker-${ticker}`
  const intraday = useIntraday(ticker)
  const reopens = reopenLabel(nowTs)
  const closed = reopens !== null
  // While closed the price is expected to be old, so the Closed tag replaces the stale marker.
  const stale = !closed && price !== undefined && isStale(price.publishTs, nowTs)
  // While closed, the on-chain price if there is one, else the worker's session close (R69).
  const shown = closed ? (price?.price ?? sessionClose(intraday)) : price?.price
  return (
    <article className="card ticker-card" aria-labelledby={titleId}>
      <header className="ticker-card__head">
        <h2 id={titleId}>{ticker}</h2>
        {stale && <span className="badge badge--warn">Stale</span>}
        {closed && <ClosedTag reopens={reopens} />}
      </header>
      <p className="ticker-card__price">
        <span>{shown === undefined ? '—' : formatUsd(shown)}</span>
        {closed && shown !== undefined && (
          <span className="ticker-card__price-label muted">Last close</span>
        )}
      </p>
      <PriceChart state={intraday} />
      <p className="muted">{statusLine(reopens, price)}</p>
      <p>
        {active === null
          ? 'Loading contracts…'
          : `${active} active ${active === 1 ? 'contract' : 'contracts'}`}
      </p>
      <a className="button button--primary ticker-card__link" href={`/trade/${ticker}`}>
        Trade {ticker}
      </a>
    </article>
  )
}

/**
 * The 7 tickers with live price (the last close while closed), an intraday chart, publish time or
 * next open, stale marker or Closed tag, and active contracts (R47, R50, R66, R68, R69).
 */
export function MarketsPage() {
  const { chain } = useServices()
  const prices = useLatestPrices()
  const nowTs = useNow(5000)
  const load = useCallback(() => chain.listMarkets(), [chain])
  const { state } = useAsync(load, 'all')
  const markets = state.status === 'ready' ? state.value : null

  return (
    <div className="page">
      <header className="page__header">
        <h1>Markets</h1>
        <p className="muted">
          Live prices come from the on-chain oracle. A price more than 5 minutes old is marked
          stale. Times are Eastern.
        </p>
      </header>
      {state.status === 'error' && <p className="notice notice--error">{state.message}</p>}
      <div className="grid">
        {TICKERS.map((ticker) => (
          <TickerCard
            key={ticker}
            ticker={ticker}
            price={prices.get(ticker)}
            active={markets ? activeCount(markets, ticker) : null}
            nowTs={nowTs}
          />
        ))}
      </div>
    </div>
  )
}
