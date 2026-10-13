'use client'

import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import type { ChainClient, WalletPort } from './chain'

/** Everything the components reach outside React for, so tests can inject fakes. */
export interface Services {
  chain: ChainClient
  wallet: WalletPort
  /** Current time, Unix seconds. */
  now: () => number
}

const ServicesContext = createContext<Services | null>(null)

export function ServicesProvider({
  services,
  children,
}: {
  services: Services
  children: ReactNode
}) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>
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
