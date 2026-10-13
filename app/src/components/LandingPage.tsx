'use client'

import { TICKERS } from '../lib/chain'
import { formatUsd } from '../lib/format'
import { useLatestPrices, useWalletKey } from '../lib/hooks'
import { WalletButton } from './WalletButton'

const STEPS = [
  {
    title: 'Pick a strike',
    body: 'Each morning there are contracts for seven large US stocks at strikes around the previous close.',
  },
  {
    title: 'Buy Yes or No',
    body: 'Yes pays $1.00 if the stock closes at or above the strike. No pays $1.00 if it closes below.',
  },
  {
    title: 'Settle at the close',
    body: 'An on-chain oracle reports the closing price minutes after 4:00 PM ET, and winners redeem for USDC.',
  },
]

/** What Meridian is, live prices and the connect-wallet call to action (R49). */
export function LandingPage() {
  const prices = useLatestPrices()
  const owner = useWalletKey()

  return (
    <div className="landing">
      <section className="hero">
        <p className="eyebrow">Devnet · USDC · Settles daily</p>
        <h1>Meridian</h1>
        <p className="hero__lead">
          Same-day binary markets on stock closing prices. Each contract asks one question: does the
          stock close at or above the strike today? The winning side pays $1.00 per token and the
          losing side pays nothing, so a price of 62¢ means the market sees a 62% chance.
        </p>
        <div className="hero__cta">
          {owner ? (
            <a className="button button--primary" href="/markets">
              Browse markets
            </a>
          ) : (
            <WalletButton />
          )}
          <a className="button button--ghost" href="/markets">
            See today&apos;s markets
          </a>
        </div>
      </section>

      <section aria-labelledby="live-prices-title">
        <h2 id="live-prices-title">Live prices</h2>
        <ul className="ticker-strip">
          {TICKERS.map((ticker) => {
            const price = prices.get(ticker)
            return (
              <li key={ticker} className="ticker-strip__item">
                <span className="ticker-strip__symbol">{ticker}</span>
                <span className="ticker-strip__price">{price ? formatUsd(price.price) : '—'}</span>
              </li>
            )
          })}
        </ul>
      </section>

      <section aria-labelledby="how-title">
        <h2 id="how-title">How it works</h2>
        <ol className="steps">
          {STEPS.map((step) => (
            <li key={step.title} className="steps__item">
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
