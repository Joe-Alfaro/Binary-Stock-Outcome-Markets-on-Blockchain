import type { Metadata } from 'next'
import { MarketsPage } from '../../src/components'

export const metadata: Metadata = { title: 'Markets · Meridian' }

export default function Markets() {
  return <MarketsPage />
}
