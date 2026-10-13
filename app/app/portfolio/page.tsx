import type { Metadata } from 'next'
import { PortfolioPage } from '../../src/components'

export const metadata: Metadata = { title: 'Portfolio · Meridian' }

export default function Portfolio() {
  return <PortfolioPage />
}
