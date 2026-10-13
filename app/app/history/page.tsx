import type { Metadata } from 'next'
import { HistoryPage } from '../../src/components'

export const metadata: Metadata = { title: 'History · Meridian' }

export default function History() {
  return <HistoryPage />
}
