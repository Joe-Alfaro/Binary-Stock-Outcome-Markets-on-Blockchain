import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { AppProviders, WalletButton } from '../src/components'
import './globals.css'

export const metadata: Metadata = {
  title: 'Meridian',
  description: 'Same-day binary outcome markets on stock closing prices',
}

interface RootLayoutProps {
  children: ReactNode
}

const NAV = [
  { href: '/markets', label: 'Markets' },
  { href: '/portfolio', label: 'Portfolio' },
  { href: '/history', label: 'History' },
]

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en">
      <body>
        <AppProviders>
          <a className="skip-link" href="#content">
            Skip to content
          </a>
          <header className="site-header">
            <div className="site-header__inner">
              <Link href="/" className="brand">
                Meridian
              </Link>
              <nav aria-label="Main" className="site-nav">
                {NAV.map((item) => (
                  <Link key={item.href} href={item.href}>
                    {item.label}
                  </Link>
                ))}
              </nav>
              <WalletButton />
            </div>
          </header>
          <main id="content" className="site-main">
            {children}
          </main>
          <footer className="site-footer">
            Devnet only. Prices and times are shown in Eastern Time (ET).
          </footer>
        </AppProviders>
      </body>
    </html>
  )
}
