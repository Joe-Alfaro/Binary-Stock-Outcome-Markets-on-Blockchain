'use client'

import { useEffect, useId, useState } from 'react'
import { toChainError } from '../lib/chain'
import { formatUsdc, shortAddress } from '../lib/format'
import { useWalletKey } from '../lib/hooks'
import { useServices } from '../lib/services'

/** Connect, show the address and USDC balance, and disconnect (R48). */
export function WalletButton() {
  const { chain, wallet } = useServices()
  const owner = useWalletKey()
  const [open, setOpen] = useState(false)
  const [balance, setBalance] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pickerId = useId()

  useEffect(() => {
    setBalance(null)
    if (!owner) return
    let active = true
    chain
      .getUsdcBalance(owner)
      .then((value) => {
        if (active) setBalance(value)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [chain, owner])

  async function connect(name: string) {
    setError(null)
    try {
      await wallet.connect(name)
      setOpen(false)
    } catch (e) {
      setError(`Could not connect ${name}: ${toChainError(e).message}`)
    }
  }

  if (owner) {
    return (
      <div className="wallet wallet--connected">
        <span className="wallet__address" title={owner}>
          {shortAddress(owner)}
        </span>
        <span className="wallet__balance">
          {balance === null ? 'Loading balance…' : formatUsdc(balance)}
        </span>
        <button type="button" className="button button--ghost" onClick={() => wallet.disconnect()}>
          Disconnect
        </button>
      </div>
    )
  }

  return (
    <div className="wallet">
      <button
        type="button"
        className="button button--primary"
        aria-expanded={open}
        aria-controls={open ? pickerId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        Connect wallet
      </button>
      {open && (
        <div id={pickerId} className="wallet__picker" role="group" aria-label="Choose a wallet">
          {wallet.wallets.map((option) => (
            <button
              key={option.name}
              type="button"
              className="wallet__option"
              onClick={() => connect(option.name)}
            >
              {option.name}
            </button>
          ))}
          {error && <p className="wallet__error">{error}</p>}
        </div>
      )}
    </div>
  )
}
