'use client'

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { getAppServices } from '../lib/app-services'
import { ServicesProvider, useOptionalServices } from '../lib/services'

function Reconnect() {
  useEffect(() => {
    getAppServices()
      .wallet.reconnect()
      .catch(() => {})
  }, [])
  return null
}

/** Mounts the app's chain and wallet services, unless a provider above already did. */
export function AppProviders({ children }: { children: ReactNode }) {
  const existing = useOptionalServices()
  if (existing) return <>{children}</>
  return (
    <ServicesProvider services={getAppServices()}>
      <Reconnect />
      {children}
    </ServicesProvider>
  )
}
