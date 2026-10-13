'use client'

import { atStrikeNote, checkPositionConstraint, executableQuotes, payoffLine } from '@meridian/sdk'
import type { ExecutableQuotes, Holdings, YesBook } from '@meridian/sdk'
import { useCallback, useId, useState } from 'react'
import type { FormEvent } from 'react'
import type { ContractSummary, OrderType, TradeIntent, TradePath } from '../lib/chain'
import { formatCentsAsDollars, shortAddress } from '../lib/format'
import { useAsync, useTransaction, useWalletKey } from '../lib/hooks'
import type { TxState } from '../lib/hooks'
import { useServices } from '../lib/services'
import { UnwindPanel } from './UnwindPanel'

const ACTIONS: { path: TradePath; label: string }[] = [
  { path: 'BuyYes', label: 'Buy Yes' },
  { path: 'SellYes', label: 'Sell Yes' },
  { path: 'BuyNo', label: 'Buy No' },
  { path: 'SellNo', label: 'Sell No' },
]
const ORDER_TYPES: OrderType[] = ['Market', 'Limit']

const QUOTE_FOR: Record<TradePath, keyof ExecutableQuotes> = {
  BuyYes: 'buyYes',
  SellYes: 'sellYes',
  BuyNo: 'buyNo',
  SellNo: 'sellNo',
}

function labelOf(path: TradePath): string {
  return ACTIONS.find((a) => a.path === path)?.label ?? path
}

function parseWhole(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null
  return Number(text)
}

function statusText(tx: TxState): string {
  switch (tx.phase) {
    case 'signing':
      return 'Approve the transaction in your wallet…'
    case 'confirming':
      return 'Sent. Waiting for confirmation…'
    case 'confirmed':
      return `Order confirmed. Signature ${shortAddress(tx.signature)}.`
    default:
      return ''
  }
}

/** The four trade paths with Market or Limit, the payoff line and one signature per order (R51, R54). */
export function TradePanel({
  contract,
  book,
}: {
  contract: ContractSummary
  book: YesBook | null
}) {
  const { chain } = useServices()
  const owner = useWalletKey()
  const formId = useId()
  const [action, setAction] = useState<TradePath>('BuyYes')
  const [orderType, setOrderType] = useState<OrderType>('Market')
  const [qtyText, setQtyText] = useState('1')
  const [limitText, setLimitText] = useState('')
  const { tx, run, reset } = useTransaction()

  const loadHoldings = useCallback(
    (): Promise<Holdings | null> =>
      owner ? chain.getHoldings(owner, contract.market) : Promise.resolve(null),
    [chain, owner, contract.market],
  )
  const holdings = useAsync(loadHoldings, `${owner ?? ''}:${contract.market}`)
  const held = holdings.state.status === 'ready' ? holdings.state.value : null

  const quote = book ? executableQuotes(book)[QUOTE_FOR[action]] : null
  const qty = parseWhole(qtyText)
  const limit = parseWhole(limitText)
  const priceCents = orderType === 'Market' ? quote : limit
  const side = action.endsWith('Yes') ? 'Yes' : 'No'
  const buying = action.startsWith('Buy')
  const constraint = held ? checkPositionConstraint(action, held) : null
  const blocked = constraint !== null && !constraint.allowed ? constraint.error : null
  const busy = tx.phase === 'signing' || tx.phase === 'confirming'

  let problem: string | null = null
  if (qty === null || qty < 1) problem = 'Enter a whole number of tokens, at least 1.'
  else if (orderType === 'Limit' && (limit === null || limit < 1 || limit > 99)) {
    problem = 'Enter a limit price from 1¢ to 99¢.'
  } else if (orderType === 'Market' && book && quote === null) {
    problem = 'Nothing on the book to fill a market order. Place a limit order instead.'
  }

  const canPlace =
    owner !== null && held !== null && blocked === null && problem === null && priceCents !== null

  function change(update: () => void) {
    update()
    if (tx.phase !== 'idle' && !busy) reset()
  }

  function chooseOrderType(next: OrderType) {
    change(() => {
      setOrderType(next)
      if (next === 'Limit' && limitText === '' && quote !== null) setLimitText(String(quote))
    })
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!canPlace || owner === null || qty === null || priceCents === null) return
    const intent: TradeIntent = {
      market: contract.market,
      owner,
      action,
      orderType,
      qty,
      priceCents,
    }
    const ok = await run(`${labelOf(action)} ${qty}`, () => chain.buildTrade(intent))
    if (ok) holdings.reload()
  }

  return (
    <div className="trade-column">
      <form className="card trade-panel" aria-labelledby={`${formId}-title`} onSubmit={submit}>
        <h3 id={`${formId}-title`}>Place an order</h3>

        <fieldset className="segmented">
          <legend>Action</legend>
          {ACTIONS.map((a) => (
            <label key={a.path} className="segmented__option">
              <input
                type="radio"
                name={`${formId}-action`}
                value={a.path}
                checked={action === a.path}
                onChange={() => change(() => setAction(a.path))}
              />
              <span>{a.label}</span>
            </label>
          ))}
        </fieldset>

        <fieldset className="segmented">
          <legend>Order type</legend>
          {ORDER_TYPES.map((type) => (
            <label key={type} className="segmented__option">
              <input
                type="radio"
                name={`${formId}-type`}
                value={type}
                checked={orderType === type}
                onChange={() => chooseOrderType(type)}
              />
              <span>{type}</span>
            </label>
          ))}
        </fieldset>

        <div className="field-row">
          <div className="field">
            <label htmlFor={`${formId}-qty`}>Quantity</label>
            <input
              id={`${formId}-qty`}
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={qtyText}
              onChange={(e) => change(() => setQtyText(e.target.value))}
            />
          </div>
          {orderType === 'Limit' && (
            <div className="field">
              <label htmlFor={`${formId}-limit`}>Limit price (¢, {side})</label>
              <input
                id={`${formId}-limit`}
                type="number"
                inputMode="numeric"
                min={1}
                max={99}
                step={1}
                value={limitText}
                onChange={(e) => change(() => setLimitText(e.target.value))}
              />
            </div>
          )}
        </div>

        <div className="payoff">
          {priceCents !== null && priceCents >= 1 && priceCents <= 99 && (
            <p className="payoff__line">
              {buying
                ? payoffLine({ side, ticker: contract.ticker, strike: contract.strike, priceCents })
                : `You receive ${formatCentsAsDollars(priceCents)} per ${side} token you sell.`}
            </p>
          )}
          {orderType === 'Market' && quote !== null && (
            <p className="muted">
              Market orders fill now at {quote}¢ or better and never rest on the book.
            </p>
          )}
          <p className="payoff__note">{atStrikeNote(contract.ticker, contract.strike)}</p>
        </div>

        {held && (
          <p className="muted">
            You hold {held.yes} Yes and {held.no} No for this strike.
          </p>
        )}
        {problem && <p className="field-error">{problem}</p>}
        {!owner && <p className="muted">Connect a wallet to place orders.</p>}

        {blocked ? (
          <div role="alert" className="notice notice--warn">
            <p>{blocked.message}</p>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => change(() => setAction(blocked.exitAction))}
            >
              {labelOf(blocked.exitAction)}
            </button>
          </div>
        ) : (
          tx.phase === 'failed' && (
            <div role="alert" className="notice notice--error">
              <p>{tx.message}</p>
            </div>
          )
        )}

        <button
          type="submit"
          className="button button--primary button--wide"
          disabled={!canPlace || busy}
        >
          {busy ? 'Waiting for wallet…' : 'Place order'}
        </button>
        <p role="status" aria-live="polite" className="tx-status">
          {statusText(tx)}
        </p>
      </form>
      {owner && held && (
        <UnwindPanel market={contract.market} owner={owner} held={held} onDone={holdings.reload} />
      )}
    </div>
  )
}
