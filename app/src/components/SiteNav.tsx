'use client'

import { useCallback } from 'react'
import { useAsync, useWalletKey } from '../lib/hooks'
import { useServices } from '../lib/services'

const NAV = [
  { href: '/markets', label: 'Markets' },
  { href: '/portfolio', label: 'Portfolio' },
  { href: '/history', label: 'History' },
]

/** The main navigation. The Admin link appears only when the wallet is `Config.admin` (R70). */
export function SiteNav() {
  const { chain } = useServices()
  const wallet = useWalletKey()
  const load = useCallback(() => chain.getAdminConfig(), [chain])
  const { state } = useAsync(load, 'admin-config')
  const isAdmin = wallet !== null && state.status === 'ready' && state.value.admin === wallet

  return (
    <nav aria-label="Main" className="site-nav">
      {NAV.map((item) => (
        <a key={item.href} href={item.href}>
          {item.label}
        </a>
      ))}
      {isAdmin && <a href="/admin">Admin</a>}
    </nav>
  )
}
