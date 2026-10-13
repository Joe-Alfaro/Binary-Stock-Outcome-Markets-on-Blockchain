'use client'

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { LatestPrice, Ticker, UnsignedTx } from './chain'
import { toChainError, tradeErrorMessage } from './chain'
import { useServices, useTxConfirmations } from './services'

/** The connected wallet's public key, or `null`. Re-renders on connect and disconnect. */
export function useWalletKey(): string | null {
  const { wallet } = useServices()
  return useSyncExternalStore(
    (listener) => wallet.subscribe(listener),
    () => wallet.getPublicKey(),
    () => null,
  )
}

/** How often the USDC balance is re-read in case the account subscription misses a change. */
export const BALANCE_POLL_MS = 15_000

/**
 * The wallet's USDC balance in base units, or `null` while loading. Re-read at `confirmed` after
 * every confirmed transaction from `useTransaction`, whenever the token-account subscription
 * reports a change, and every `BALANCE_POLL_MS` as a fallback.
 */
export function useUsdcBalance(owner: string | null): number | null {
  const { chain } = useServices()
  const confirmations = useTxConfirmations()
  const [balance, setBalance] = useState<number | null>(null)
  useEffect(() => {
    setBalance(null)
    if (!owner) return
    let active = true
    let latest = 0
    const refresh = () => {
      const request = ++latest
      chain
        .getUsdcBalance(owner)
        .then((value) => {
          if (active && request === latest) setBalance(value)
        })
        .catch(() => {})
    }
    refresh()
    const unsubscribeAccount = chain.subscribeUsdcBalance?.(owner, refresh)
    const unsubscribeConfirmations = confirmations.subscribe(refresh)
    const poll = setInterval(refresh, BALANCE_POLL_MS)
    return () => {
      active = false
      clearInterval(poll)
      unsubscribeConfirmations()
      unsubscribeAccount?.()
    }
  }, [chain, confirmations, owner])
  return balance
}

/** `services.now()`, refreshed every `intervalMs`. */
export function useNow(intervalMs = 1000): number {
  const { now } = useServices()
  const [value, setValue] = useState(now)
  useEffect(() => {
    const id = setInterval(() => setValue(now()), intervalMs)
    return () => clearInterval(id)
  }, [now, intervalMs])
  return value
}

/** Latest on-chain display prices by ticker, kept live through the account subscription (R47). */
export function useLatestPrices(): ReadonlyMap<Ticker, LatestPrice> {
  const { chain } = useServices()
  const [prices, setPrices] = useState<ReadonlyMap<Ticker, LatestPrice>>(new Map())
  useEffect(() => {
    let active = true
    const merge = (incoming: readonly LatestPrice[]) =>
      setPrices((current) => {
        const next = new Map(current)
        incoming.forEach((price) => {
          const known = next.get(price.ticker)
          if (!known || known.publishTs <= price.publishTs) next.set(price.ticker, price)
        })
        return next
      })
    const unsubscribe = chain.subscribeLatestPrices((price) => {
      if (active) merge([price])
    })
    chain
      .getLatestPrices()
      .then((all) => {
        if (active) merge(all)
      })
      .catch(() => {})
    return () => {
      active = false
      unsubscribe()
    }
  }, [chain])
  return prices
}

export type AsyncState<T> =
  { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; message: string }

/**
 * Runs `load` whenever `key` changes and on `reload()`. `load` should be stable for a given key;
 * results from a superseded run are dropped.
 */
export function useAsync<T>(
  load: () => Promise<T>,
  key: string,
): { state: AsyncState<T>; reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' })
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    let active = true
    load()
      .then((value) => {
        if (active) setState({ status: 'ready', value })
      })
      .catch((error: unknown) => {
        if (active) setState({ status: 'error', message: toChainError(error).message })
      })
    return () => {
      active = false
    }
    // `load` is keyed by `key`; re-running on its identity would refetch every render.
  }, [key, generation])
  const reload = useCallback(() => setGeneration((g) => g + 1), [])
  return { state, reload }
}

export type TxState =
  | { phase: 'idle' }
  | { phase: 'signing' | 'confirming'; label: string }
  | { phase: 'confirmed'; label: string; signature: string }
  | { phase: 'failed'; message: string }

/**
 * Builds, signs once and confirms one transaction at `confirmed` (R54, R55). The wallet prompt is
 * the only signature; failures become the plain-language messages from `tradeErrorMessage`. When
 * `build` returns several transactions (a split close-out), each is signed and confirmed in order,
 * and the first failure stops the rest.
 */
export function useTransaction() {
  const { chain, wallet } = useServices()
  const confirmations = useTxConfirmations()
  const [tx, setTx] = useState<TxState>({ phase: 'idle' })

  const run = useCallback(
    async (label: string, build: () => Promise<UnsignedTx | UnsignedTx[]>) => {
      setTx({ phase: 'signing', label })
      try {
        const built = await build()
        const all = Array.isArray(built) ? built : [built]
        let signature = ''
        for (const [i, unsigned] of all.entries()) {
          const step = all.length > 1 ? `${label} (${i + 1} of ${all.length})` : label
          setTx({ phase: 'signing', label: step })
          const signed = await wallet.signTransaction(unsigned)
          setTx({ phase: 'confirming', label: step })
          signature = (await chain.sendAndConfirm(signed, 'confirmed')).signature
          confirmations.notify()
        }
        setTx({ phase: 'confirmed', label, signature })
        return true
      } catch (error) {
        setTx({ phase: 'failed', message: tradeErrorMessage(error) })
        return false
      }
    },
    [chain, confirmations, wallet],
  )

  const reset = useCallback(() => setTx({ phase: 'idle' }), [])
  return { tx, run, reset }
}
