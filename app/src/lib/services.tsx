'use client'

import { createContext, useContext, useState } from 'react'
import type { ReactNode } from 'react'
import type { ChainClient, Unsubscribe, WalletPort } from './chain'

/** Everything the components reach outside React for, so tests can inject fakes. */
export interface Services {
  chain: ChainClient
  wallet: WalletPort
  /** Current time, Unix seconds. */
  now: () => number
}

/** Tells listeners that one of the wallet's transactions confirmed, so balances can refresh. */
export interface TxConfirmations {
  notify(): void
  subscribe(listener: () => void): Unsubscribe
}

function createTxConfirmations(): TxConfirmations {
  const listeners = new Set<() => void>()
  return {
    notify: () => listeners.forEach((listener) => listener()),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const ServicesContext = createContext<Services | null>(null)
const TxConfirmationsContext = createContext<TxConfirmations | null>(null)

export function ServicesProvider({
  services,
  children,
}: {
  services: Services
  children: ReactNode
}) {
  const [confirmations] = useState(createTxConfirmations)
  return (
    <ServicesContext.Provider value={services}>
      <TxConfirmationsContext.Provider value={confirmations}>
        {children}
      </TxConfirmationsContext.Provider>
    </ServicesContext.Provider>
  )
}

export function useServices(): Services {
  const services = useContext(ServicesContext)
  if (!services) throw new Error('useServices must be used inside ServicesProvider')
  return services
}

/** The services if a provider is mounted, else `null`. */
export function useOptionalServices(): Services | null {
  return useContext(ServicesContext)
}

export function useTxConfirmations(): TxConfirmations {
  const confirmations = useContext(TxConfirmationsContext)
  if (!confirmations) throw new Error('useTxConfirmations must be used inside ServicesProvider')
  return confirmations
}
