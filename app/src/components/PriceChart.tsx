'use client'

import { useState } from 'react'
import type { PointerEvent } from 'react'
import { formatEtMinute, formatPercentChange, formatSessionDate, formatUsd } from '../lib/format'
import type { IntradayState } from '../lib/hooks'
import { changeSinceOpen } from '../lib/intraday'
import type { IntradayPoint, IntradaySeries } from '../lib/intraday'

const WIDTH = 300
const HEIGHT = 72
/** Room above and below the line so the 2px stroke and end dot are never clipped. */
const PAD_Y = 6
const FULL_SESSION_SECS = 6.5 * 60 * 60
const EARLY_CLOSE_SESSION_SECS = 3.5 * 60 * 60

interface Scaled {
  x: number
  y: number
  point: IntradayPoint
}

/**
 * Scales the series into the viewBox. The x axis always spans the whole session, so a live line
 * grows across the card through the day; the y axis spans the series' range.
 */
function scale(series: IntradaySeries): Scaled[] {
  const span = series.earlyClose ? EARLY_CLOSE_SESSION_SECS : FULL_SESSION_SECS
  const prices = series.points.map((p) => p.price)
  const low = Math.min(...prices)
  const high = Math.max(...prices)
  const range = high - low || 1
  const center = high === low ? low - 0.5 : low
  return series.points.map((point) => ({
    x: (Math.min(point.t - series.openTs, span) / span) * WIDTH,
    y: PAD_Y + (1 - (point.price - center) / range) * (HEIGHT - 2 * PAD_Y),
    point,
  }))
}

function nearest(scaled: Scaled[], x: number): Scaled | undefined {
  return scaled.reduce<Scaled | undefined>(
    (best, s) => (best === undefined || Math.abs(s.x - x) < Math.abs(best.x - x) ? s : best),
    undefined,
  )
}

function direction(change: number): 'up' | 'down' | 'flat' {
  if (change > 0) return 'up'
  if (change < 0) return 'down'
  return 'flat'
}

/** The chart's label: which session it is, and the change since its open. */
function sessionLabel(series: IntradaySeries): string {
  return series.live ? 'Live · today' : `Closed · ${formatSessionDate(series.sessionDate)}`
}

/** The chart's text alternative: the open, the last or closing price, and the change. */
function textAlternative(series: IntradaySeries, change: number): string {
  const first = series.points[0]?.price ?? 0
  const last = series.points.at(-1)?.price ?? 0
  const when = series.live ? 'today' : formatSessionDate(series.sessionDate)
  const end = series.live ? 'last' : 'close'
  return `${series.ticker} ${when}: open ${formatUsd(first)}, ${end} ${formatUsd(last)}, ${formatPercentChange(change)}`
}

function Chart({ series, change }: { series: IntradaySeries; change: number }) {
  const [hover, setHover] = useState<Scaled | null>(null)
  const scaled = scale(series)
  const open = scaled[0]
  const last = scaled.at(-1)
  if (open === undefined || last === undefined) return null

  function onPointerMove(event: PointerEvent<SVGSVGElement>) {
    const box = event.currentTarget.getBoundingClientRect()
    if (box.width === 0) return
    setHover(nearest(scaled, ((event.clientX - box.left) / box.width) * WIDTH) ?? null)
  }

  const marker = hover ?? last
  return (
    <div className="price-chart__plot">
      <svg
        role="img"
        aria-label={textAlternative(series, change)}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
      >
        <line
          className="price-chart__baseline"
          x1={0}
          x2={WIDTH}
          y1={open.y}
          y2={open.y}
          vectorEffect="non-scaling-stroke"
        />
        {hover && (
          <line
            className="price-chart__crosshair"
            x1={hover.x}
            x2={hover.x}
            y1={0}
            y2={HEIGHT}
            vectorEffect="non-scaling-stroke"
          />
        )}
        <polyline
          className="price-chart__line"
          points={scaled.map((s) => `${s.x.toFixed(2)},${s.y.toFixed(2)}`).join(' ')}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {/* An HTML dot, so it stays round while the SVG stretches to the card's width. */}
      <span
        className="price-chart__dot"
        aria-hidden="true"
        style={{ left: `${(marker.x / WIDTH) * 100}%`, top: `${(marker.y / HEIGHT) * 100}%` }}
      />
      {hover && (
        <span className="price-chart__tooltip" aria-hidden="true">
          {formatEtMinute(hover.point.t)} · {formatUsd(hover.point.price)}
        </span>
      )}
    </div>
  )
}

/**
 * The Markets card's price chart (R66): today's session while it's open, else the last complete
 * session, with a dashed line at the open. "Chart unavailable" with no data or an error. The card
 * owns the series state (`useIntraday`) so it can also show the session close.
 */
export function PriceChart({ state }: { state: IntradayState }) {
  if (state.status === 'loading') {
    return <p className="price-chart price-chart--empty muted">Loading chart…</p>
  }
  const change = state.status === 'ready' ? changeSinceOpen(state.series) : null
  if (state.status === 'error' || change === null) {
    return <p className="price-chart price-chart--empty muted">Chart unavailable</p>
  }
  const { series } = state
  return (
    <figure className="price-chart">
      <figcaption className="price-chart__label">
        <span className="muted">{sessionLabel(series)}</span>
        <span className={`price-chart__change price-chart__change--${direction(change)}`}>
          {formatPercentChange(change)}
        </span>
      </figcaption>
      <Chart series={series} change={change} />
    </figure>
  )
}
