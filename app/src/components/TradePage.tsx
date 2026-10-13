'use client'

import { countdownToClose, impliedNoPrice } from '@meridian/sdk'
import { useCallback, useMemo, useState } from 'react'
import type { ContractSummary, Ticker } from '../lib/chain'
import { contractLabel, formatCents, formatUsd } from '../lib/format'
import { useAsync, useLatestPrices, useNow } from '../lib/hooks'
import { formatPublishTime, isStale } from '../lib/prices'
import { useServices } from '../lib/services'
import { OrderBookViews, useLiveBook } from './OrderBook'
import { TradePanel } from './TradePanel'

/** Contracts of the latest trading day, by strike. Older days stay on the Portfolio page. */
function currentContracts(all: readonly ContractSummary[]): ContractSummary[] {
  const latestClose = Math.max(...all.map((c) => c.closeTs))
  return all.filter((c) => c.closeTs === latestClose).sort((a, b) => a.strike - b.strike)
}

function SettledDetails({ contract }: { contract: ContractSummary }) {
  const settlement = contract.settlement
  if (!settlement) return <p className="muted">Waiting for the settlement price.</p>
  const yesWins = settlement.outcome === 'Yes'
  return (
    <div className="settled">
      <p>Settled at {formatUsd(settlement.price)}</p>
      <p className="muted">Source: {settlement.source}</p>
      <p className="settled__winner">{settlement.outcome} wins</p>
      <ul className="settled__payouts">
        <li>Yes pays {yesWins ? '$1.00' : '$0.00'}</li>
        <li>No pays {yesWins ? '$0.00' : '$1.00'}</li>
      </ul>
    </div>
  )
}

function ContractCard({
  contract,
  selected,
  onSelect,
}: {
  contract: ContractSummary
  selected: boolean
  onSelect: () => void
}) {
  const label = contractLabel(contract)
  const titleId = `contract-${contract.market}`
  const yes = contract.yesPriceCents
  return (
    <article
      className={`card contract-card${selected ? ' contract-card--selected' : ''}`}
      aria-labelledby={titleId}
    >
      <header className="contract-card__head">
        <h3 id={titleId}>{label}</h3>
        {contract.demo && <span className="badge badge--demo">Demo market</span>}
      </header>
      {contract.status === 'Settled' ? (
        <SettledDetails contract={contract} />
      ) : (
        <>
          <dl className="quotes">
            <div className="quotes__item quotes__item--yes">
              <dt>Yes</dt>
              <dd>{yes === null ? '—' : formatCents(yes)}</dd>
            </div>
            <div className="quotes__item quotes__item--no">
              <dt>No</dt>
              <dd>{yes === null ? '—' : formatCents(impliedNoPrice(yes))}</dd>
            </div>
          </dl>
          <p className="muted">{yes === null ? 'No price yet' : `Implied probability ${yes}%`}</p>
          {contract.status === 'Closed' ? (
            <p className="muted">Closed, waiting for settlement</p>
          ) : (
            <button
              type="button"
              className="button button--secondary"
              aria-pressed={selected}
              onClick={onSelect}
            >
              Trade<span className="visually-hidden"> {label}</span>
            </button>
          )}
        </>
      )}
    </article>
  )
}

function Countdown({ closeTs }: { closeTs: number }) {
  const nowTs = useNow(1000)
  const countdown = countdownToClose(closeTs, nowTs)
  return (
    <div className="countdown">
      <p className="countdown__label">Closes at {countdown.closesAt}</p>
      <p className="countdown__value">
        <span className="visually-hidden">Time left: </span>
        {countdown.text}
      </p>
    </div>
  )
}

function SelectedMarket({ contract }: { contract: ContractSummary }) {
  const book = useLiveBook(contract.market)
  return (
    <section className="trade-layout" aria-labelledby="selected-title">
      <h2 id="selected-title" className="trade-layout__title">
        {contractLabel(contract)}
      </h2>
      <OrderBookViews book={book} />
      <TradePanel contract={contract} book={book} />
    </section>
  )
}

/** Contract cards, the Yes and No books, the trade panel and the ET countdown (R22, R44, R51). */
export function TradePage({ ticker }: { ticker: Ticker }) {
  const { chain, now } = useServices()
  const prices = useLatestPrices()
  const load = useCallback(() => chain.listMarkets(ticker), [chain, ticker])
  const { state } = useAsync(load, ticker)
  const [selected, setSelected] = useState<string | null>(null)

  const contracts = useMemo(
    () => (state.status === 'ready' ? currentContracts(state.value) : []),
    [state],
  )
  const selectedContract = contracts.find((c) => c.market === selected) ?? null
  const price = prices.get(ticker)
  const closeTs = contracts[0]?.closeTs

  return (
    <div className="page">
      <header className="page__header trade-header">
        <div>
          <h1>{ticker}</h1>
          {price && (
            <p className="muted">
              Last {formatUsd(price.price)} as of {formatPublishTime(price.publishTs)}
              {isStale(price.publishTs, now()) && <span className="badge badge--warn">Stale</span>}
            </p>
          )}
        </div>
        {closeTs !== undefined && <Countdown closeTs={closeTs} />}
      </header>

      {state.status === 'loading' && <p className="muted">Loading contracts…</p>}
      {state.status === 'error' && <p className="notice notice--error">{state.message}</p>}
      {state.status === 'ready' && contracts.length === 0 && (
        <p className="notice">No {ticker} contracts are listed today.</p>
      )}

      {contracts.length > 0 && (
        <section aria-labelledby="strikes-title">
          <h2 id="strikes-title">Strikes</h2>
          <div className="grid grid--contracts">
            {contracts.map((contract) => (
              <ContractCard
                key={contract.market}
                contract={contract}
                selected={contract.market === selected}
                onSelect={() => setSelected(contract.market)}
              />
            ))}
          </div>
        </section>
      )}

      {selectedContract ? (
        <SelectedMarket key={selectedContract.market} contract={selectedContract} />
      ) : (
        contracts.length > 0 && (
          <p className="muted">Pick a strike to see its order book and trade.</p>
        )
      )}
    </div>
  )
}
