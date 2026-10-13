import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { TradePage } from '../../../src/components'
import { TICKERS } from '../../../src/lib/chain'
import type { Ticker } from '../../../src/lib/chain'

interface TradeRouteProps {
  params: Promise<{ ticker: string }>
}

function toTicker(value: string): Ticker | null {
  return TICKERS.find((t) => t === value.toUpperCase()) ?? null
}

export function generateStaticParams() {
  return TICKERS.map((ticker) => ({ ticker }))
}

export async function generateMetadata({ params }: TradeRouteProps): Promise<Metadata> {
  const ticker = toTicker((await params).ticker)
  return { title: ticker ? `Trade ${ticker} · Meridian` : 'Meridian' }
}

export default async function Trade({ params }: TradeRouteProps) {
  const ticker = toTicker((await params).ticker)
  if (!ticker) notFound()
  return <TradePage ticker={ticker} />
}
