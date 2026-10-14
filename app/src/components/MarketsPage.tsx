'use client'

import { useCallback } from 'react'
import { TICKERS } from '../lib/chain'
import type { ContractSummary, LatestPrice, Ticker } from '../lib/chain'
import { formatUsd } from '../lib/format'
import { useAsync, useLatestPrices, useNow } from '../lib/hooks'
import { formatPublishTime, isStale } from '../lib/prices'
import { useServices } from '../lib/services'
import { PriceChart } from './PriceChart'

function activeCount(markets: readonly ContractSummary[], ticker: Ticker): number {
  return markets.filter((m) => m.ticker === ticker && m.status === 'Open').length
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
  const stale = price !== undefined && isStale(price.publishTs, nowTs)
  return (
    <article className="card ticker-card" aria-labelledby={titleId}>
      <header className="ticker-card__head">
        <h2 id={titleId}>{ticker}</h2>
        {stale && <span className="badge badge--warn">Stale</span>}
      </header>
      <p className="ticker-card__price">{price ? formatUsd(price.price) : '—'}</p>
      <PriceChart ticker={ticker} />
      <p className="muted">
        {price ? <>As of {formatPublishTime(price.publishTs)}</> : 'Waiting for the first price'}
      </p>
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
 * The 7 tickers with live price, an intraday chart, publish time, stale marker and active
 * contracts (R47, R50, R66).
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
