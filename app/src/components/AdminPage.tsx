'use client'

import { useCallback, useId, useState } from 'react'
import type { FormEvent } from 'react'
import { adminErrorMessage } from '../lib/chain'
import type { AdminConfig, TickerDaySummary } from '../lib/chain'
import { formatEtMinute, formatSessionDate, formatUsd, shortAddress } from '../lib/format'
import { useAsync, useNow, useTransaction, useWalletKey } from '../lib/hooks'
import type { TxState } from '../lib/hooks'
import { useServices } from '../lib/services'

interface AdminData {
  config: AdminConfig
  days: TickerDaySummary[]
}

type Run = ReturnType<typeof useTransaction>['run']

/** `4:15 PM ET`. */
function etTime(unixSeconds: number): string {
  return `${formatEtMinute(unixSeconds)} ET`
}

/** `231.07` → 23107. Null unless the text is a positive dollar amount with at most two decimals. */
function parsePriceCents(text: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim())
  if (!match) return null
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null
}

function txText(tx: TxState): string {
  switch (tx.phase) {
    case 'signing':
      return `${tx.label}: approve the transaction in your wallet…`
    case 'confirming':
      return `${tx.label}: waiting for confirmation…`
    case 'confirmed':
      return `${tx.label} confirmed. Signature ${shortAddress(tx.signature)}.`
    default:
      return ''
  }
}

function AdminOnly() {
  return (
    <div className="card">
      <h1>Admin only</h1>
      <p className="muted">This page is for the program admin wallet.</p>
    </div>
  )
}

/** Pause and unpause (R41): one signature each. */
function TradingControls({
  admin,
  paused,
  busy,
  run,
  onDone,
}: {
  admin: string
  paused: boolean
  busy: boolean
  run: Run
  onDone: () => void
}) {
  const { chain } = useServices()
  const titleId = useId()
  const label = paused ? 'Unpause trading' : 'Pause trading'

  async function toggle() {
    const ok = await run(
      label,
      () => chain.buildSetPaused({ admin, paused: !paused }),
      adminErrorMessage,
    )
    if (ok) onDone()
  }

  return (
    <section className="card" aria-labelledby={titleId}>
      <h2 id={titleId}>Trading</h2>
      <p>{paused ? 'Trading is paused.' : 'Trading is active.'}</p>
      <button type="button" className="button button--secondary" disabled={busy} onClick={toggle}>
        {label}
      </button>
    </section>
  )
}

/**
 * One ticker and trading day (R36): propose a price from `close_ts + 900` and finalize a pending
 * one from `close_ts + 3600`. Each button is enabled only when the program would accept it.
 */
function TickerDayCard({
  day,
  config,
  now,
  busy,
  run,
  onInvalid,
  onDone,
}: {
  day: TickerDaySummary
  config: AdminConfig
  now: number
  busy: boolean
  run: Run
  onInvalid: (message: string) => void
  onDone: () => void
}) {
  const { chain } = useServices()
  const id = useId()
  const [priceText, setPriceText] = useState('')
  const proposeAt = day.closeTs + config.proposeDelaySecs
  const finalizeAt = day.closeTs + config.finalizeDelaySecs
  const times = { proposeOpensAt: etTime(proposeAt), finalizeOpensAt: etTime(finalizeAt) }
  const open = day.status === 'Open'
  const canPropose = open && now >= proposeAt
  const canFinalize = open && day.pendingAdminPrice !== null && now >= finalizeAt
  const request = { admin: config.admin, ticker: day.ticker, tradingDay: day.tradingDay }
  const name = `${day.ticker} ${formatSessionDate(day.tradingDay)}`

  async function propose(event: FormEvent) {
    event.preventDefault()
    const priceCents = parsePriceCents(priceText)
    if (priceCents === null) {
      onInvalid('Enter the price as a positive dollar amount with at most two decimals: 231.07.')
      return
    }
    const ok = await run(
      `Propose ${name}`,
      () => chain.buildProposeAdminPrice({ ...request, priceCents }),
      (error) => adminErrorMessage(error, times),
    )
    if (!ok) return
    setPriceText('')
    onDone()
  }

  async function finalize() {
    const ok = await run(
      `Finalize ${name}`,
      () => chain.buildFinalizeAdminSettle(request),
      (error) => adminErrorMessage(error, times),
    )
    if (ok) onDone()
  }

  return (
    <section className="card" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{name}</h3>
      <p className="muted">
        {now < day.closeTs ? 'Closes' : 'Closed'} at {etTime(day.closeTs)}
      </p>
      {!open && <p>Finalized</p>}
      {open && (
        <p>
          {day.pendingAdminPrice === null
            ? 'No admin price pending'
            : `Pending admin price: ${formatUsd(day.pendingAdminPrice)}`}
        </p>
      )}

      <form onSubmit={propose} noValidate>
        <div className="field">
          <label htmlFor={`${id}-price`}>Admin price (USD)</label>
          <input
            id={`${id}-price`}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={priceText}
            onChange={(event) => setPriceText(event.target.value)}
            disabled={!open}
          />
        </div>
        <p className="muted">Proposals open at {times.proposeOpensAt}</p>
        <button type="submit" className="button button--secondary" disabled={busy || !canPropose}>
          Propose price
        </button>
      </form>

      <p className="muted">Finalizing opens at {times.finalizeOpensAt}</p>
      <button
        type="button"
        className="button button--primary"
        disabled={busy || !canFinalize}
        onClick={finalize}
      >
        Finalize price
      </button>
    </section>
  )
}

/**
 * The admin's page (R70): propose and finalize settlement prices, pause and unpause. Shows
 * "Admin only" with no controls to any wallet other than `Config.admin`. The program rejects
 * non-admin calls regardless (R10, R36, R41).
 */
export function AdminPage() {
  const { chain } = useServices()
  const wallet = useWalletKey()
  const now = useNow()
  const load = useCallback(async (): Promise<AdminData> => {
    const config = await chain.getAdminConfig()
    // Only the admin's page lists ticker-days.
    if (config.admin !== wallet) return { config, days: [] }
    return { config, days: await chain.listTickerDays() }
  }, [chain, wallet])
  const { state, reload } = useAsync(load, `admin:${wallet ?? ''}`)
  const { tx, run } = useTransaction()
  const [invalid, setInvalid] = useState<string | null>(null)
  const busy = tx.phase === 'signing' || tx.phase === 'confirming'

  const runAction: Run = useCallback(
    (label, build, errorMessage) => {
      setInvalid(null)
      return run(label, build, errorMessage)
    },
    [run],
  )

  if (!wallet) return <AdminOnly />
  if (state.status === 'loading') return <p className="muted">Loading…</p>
  if (state.status === 'error') {
    return (
      <div role="alert" className="notice notice--error">
        <p>Couldn&apos;t load the program config: {state.message}</p>
      </div>
    )
  }
  const { config, days } = state.value
  if (config.admin !== wallet) return <AdminOnly />

  const error = invalid ?? (tx.phase === 'failed' ? tx.message : null)
  return (
    <div className="admin-page">
      <h1>Admin</h1>
      <TradingControls
        admin={config.admin}
        paused={config.paused}
        busy={busy}
        run={runAction}
        onDone={reload}
      />

      {error && (
        <div role="alert" className="notice notice--error">
          <p>{error}</p>
        </div>
      )}
      <p role="status" aria-live="polite" className="tx-status">
        {txText(tx)}
      </p>

      <h2>Settlement</h2>
      <p className="muted">
        An admin price applies to every strike of its ticker and day. Proposals open 15 minutes
        after close and finalizing 60 minutes after, when a price is pending. Times are ET.
      </p>
      {days.length === 0 && <p>No ticker-days to settle.</p>}
      {days.map((day) => (
        <TickerDayCard
          key={`${day.ticker}:${day.tradingDay}`}
          day={day}
          config={config}
          now={now}
          busy={busy}
          run={runAction}
          onInvalid={setInvalid}
          onDone={reload}
        />
      ))}
    </div>
  )
}
