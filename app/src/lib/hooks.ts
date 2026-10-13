'use client'

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { LatestPrice, Ticker } from './chain'
import { toChainError, tradeErrorMessage } from './chain'
import { useServices } from './services'

/** The connected wallet's public key, or `null`. Re-renders on connect and disconnect. */
export function useWalletKey(): string | null {
  const { wallet } = useServices()
  return useSyncExternalStore(
    (listener) => wallet.subscribe(listener),
    () => wallet.getPublicKey(),
    () => null,
  )
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
 * the only signature; failures become the plain-language messages from `tradeErrorMessage`.
 */
export function useTransaction() {
  const { chain, wallet } = useServices()
  const [tx, setTx] = useState<TxState>({ phase: 'idle' })

  const run = useCallback(
    async (label: string, build: () => ReturnType<typeof chain.buildTrade>) => {
      setTx({ phase: 'signing', label })
      try {
        const unsigned = await build()
        const signed = await wallet.signTransaction(unsigned)
        setTx({ phase: 'confirming', label })
        const { signature } = await chain.sendAndConfirm(signed, 'confirmed')
        setTx({ phase: 'confirmed', label, signature })
        return true
      } catch (error) {
        setTx({ phase: 'failed', message: tradeErrorMessage(error) })
        return false
      }
    },
    [chain, wallet],
  )

  const reset = useCallback(() => setTx({ phase: 'idle' }), [])
  return { tx, run, reset }
}
