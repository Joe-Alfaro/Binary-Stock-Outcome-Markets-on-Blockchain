'use client'

import { noView } from '@meridian/sdk'
import type { BookLevel, YesBook } from '@meridian/sdk'
import { useEffect, useState } from 'react'
import { formatCents } from '../lib/format'
import { useServices } from '../lib/services'

/** How often the book is re-read once the account subscription has failed (R22: within 2 s). */
export const BOOK_POLL_MS = 1000

/**
 * The market's Yes book, live: an account subscription, and polling every second if the
 * subscription fails. `null` until the first read.
 */
export function useLiveBook(market: string): YesBook | null {
  const { chain } = useServices()
  const [book, setBook] = useState<YesBook | null>(null)

  useEffect(() => {
    let active = true
    let poll: ReturnType<typeof setInterval> | null = null
    const accept = (next: YesBook) => {
      if (active) setBook(next)
    }
    const read = () => {
      chain
        .getBook(market)
        .then(accept)
        .catch(() => {})
    }
    read()
    const unsubscribe = chain.subscribeBook(market, accept, () => {
      if (!active || poll !== null) return
      poll = setInterval(read, BOOK_POLL_MS)
    })
    return () => {
      active = false
      unsubscribe()
      if (poll !== null) clearInterval(poll)
    }
  }, [chain, market])

  return book
}

function BookTable({
  caption,
  bids,
  asks,
}: {
  caption: string
  bids: readonly BookLevel[]
  asks: readonly BookLevel[]
}) {
  const empty = bids.length === 0 && asks.length === 0
  return (
    <table className="book">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Side</th>
          <th scope="col">Price</th>
          <th scope="col">Quantity</th>
        </tr>
      </thead>
      <tbody>
        {asks.map((level, i) => (
          <tr key={`ask-${i}`} className="book__row book__row--ask">
            <td>Ask</td>
            <td>{formatCents(level.priceCents)}</td>
            <td>{level.qty}</td>
          </tr>
        ))}
        {bids.map((level, i) => (
          <tr key={`bid-${i}`} className="book__row book__row--bid">
            <td>Bid</td>
            <td>{formatCents(level.priceCents)}</td>
            <td>{level.qty}</td>
          </tr>
        ))}
        {empty && (
          <tr>
            <td colSpan={3} className="muted">
              No resting orders
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

/** The Yes book and its No view, both best-first (R29, R51). */
export function OrderBookViews({ book }: { book: YesBook | null }) {
  if (!book) return <p className="muted">Loading order book…</p>
  const yesBids = [...book.bids].sort((a, b) => b.priceCents - a.priceCents)
  const yesAsks = [...book.asks].sort((a, b) => a.priceCents - b.priceCents)
  const no = noView(book)
  return (
    <div className="books">
      <BookTable caption="Yes order book" bids={yesBids} asks={yesAsks} />
      <BookTable caption="No order book" bids={no.bids} asks={no.asks} />
      <p className="muted books__note">
        The No book is the Yes book seen from the other side: a No price is $1.00 minus the Yes
        price, with the same quantity.
      </p>
    </div>
  )
}
