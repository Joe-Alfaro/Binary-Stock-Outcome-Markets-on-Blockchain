'use client'

import type { Holdings } from '@meridian/sdk'
import { useCallback, useId } from 'react'
import type { OpenOrder } from '../lib/chain'
import { formatUsdc, shortAddress } from '../lib/format'
import { useAsync, useTransaction } from '../lib/hooks'
import type { TxState } from '../lib/hooks'
import { useServices } from '../lib/services'

interface UnwindData {
  orders: OpenOrder[]
  usdc: number
}

function describe(order: OpenOrder): string {
  const verb = order.side === 'Ask' ? 'Sell' : 'Buy'
  return `${verb} ${order.qty} Yes at ${order.priceCents}¢`
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

/**
 * R28 [G]: lets a wallet that holds both sides of a strike, usually through a resting Buy No
 * limit, cancel its orders and merge its Yes+No pairs back to USDC before settlement. Renders
 * nothing when there is no order to cancel and no pair to merge.
 */
export function UnwindPanel({
  market,
  owner,
  held,
  onDone,
}: {
  market: string
  owner: string
  held: Holdings
  onDone: () => void
}) {
  const { chain } = useServices()
  const titleId = useId()
  const load = useCallback(async (): Promise<UnwindData> => {
    const [orders, usdc] = await Promise.all([
      chain.getOpenOrders(owner, market),
      chain.getUsdcBalance(owner),
    ])
    return { orders, usdc }
  }, [chain, owner, market])
  const { state, reload } = useAsync(load, `${owner}:${market}`)
  const { tx, run } = useTransaction()
  const busy = tx.phase === 'signing' || tx.phase === 'confirming'

  if (state.status !== 'ready') return null
  const { orders, usdc } = state.value
  const pairs = Math.min(held.yes, held.no)
  if (orders.length === 0 && pairs < 1 && tx.phase === 'idle') return null

  async function unwind(label: string, build: Parameters<typeof run>[1]) {
    const ok = await run(label, build)
    if (!ok) return
    reload()
    onDone()
  }

  return (
    <section className="card unwind-panel" aria-labelledby={titleId}>
      <h3 id={titleId}>Unwind your position</h3>
      <p className="muted">Wallet balance: {formatUsdc(usdc)}</p>

      {orders.length > 0 && (
        <ul className="unwind-panel__orders">
          {orders.map((order) => (
            <li key={order.orderId}>
              <span>{describe(order)}, resting on the book</span>
              <button
                type="button"
                className="button button--secondary"
                disabled={busy}
                onClick={() =>
                  unwind('Cancel order', () =>
                    chain.buildCancelOrder({ market, owner, orderId: order.orderId }),
                  )
                }
              >
                Cancel order<span className="visually-hidden">: {describe(order)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {(orders.length > 0 || pairs >= 1) && (
        <>
          <p className="muted">
            Close out cancels your orders, returns what they hold and turns each Yes and No pair
            back into $1.00 USDC.
          </p>
          <button
            type="button"
            className="button button--secondary button--wide"
            disabled={busy}
            onClick={() =>
              unwind('Close out position', () => chain.buildCloseOutPosition({ market, owner }))
            }
          >
            Close out position
          </button>
        </>
      )}

      {tx.phase === 'failed' && (
        <div role="alert" className="notice notice--error">
          <p>{tx.message}</p>
        </div>
      )}
      <p role="status" aria-live="polite" className="tx-status">
        {txText(tx)}
      </p>
    </section>
  )
}
