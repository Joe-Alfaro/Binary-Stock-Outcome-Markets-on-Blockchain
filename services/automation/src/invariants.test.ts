import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createAlerter, type Alert, type AlertSink } from './alerts/index.js'
import { FakeClock } from './jobs/fake-clock.js'
import { recordingLogger } from './jobs/test-support.js'
import { auditInvariants, checkMarketInvariants, type MarketCollateral } from './invariants.js'

/** One outcome token, and the $1.00 of USDC collateral behind each pair (6 decimals). */
const UNIT = 1_000_000n

/** An open market with `pairs` minted and nothing redeemed: every counter agrees. */
function healthyOpen(pairs: bigint, overrides: Partial<MarketCollateral> = {}): MarketCollateral {
  return {
    address: 'Market1111111111111111111111111111111111111',
    ticker: 'AAPL',
    tradingDay: '2026-11-02',
    status: 'open',
    outcome: null,
    collateral: pairs * UNIT,
    pairsOutstanding: pairs,
    vaultBalance: pairs * UNIT,
    yesSupply: pairs * UNIT,
    noSupply: pairs * UNIT,
    ...overrides,
  }
}

/** A Yes-settled market after some redemptions: 4 winning Yes left, 6 losing No never redeemed. */
function healthySettled(overrides: Partial<MarketCollateral> = {}): MarketCollateral {
  return healthyOpen(10n, {
    status: 'settled',
    outcome: 'yes',
    collateral: 4n * UNIT,
    vaultBalance: 4n * UNIT,
    yesSupply: 4n * UNIT,
    noSupply: 6n * UNIT,
    ...overrides,
  })
}

function recordingSink(): AlertSink & { sent: Alert[] } {
  const sent: Alert[] = []
  return {
    name: 'recording',
    sent,
    async send(alert) {
      sent.push(alert)
    },
  }
}

describe('R46 invariant checks on a collateral snapshot', () => {
  it('passes a healthy open market and a healthy settled market', () => {
    assert.deepEqual(checkMarketInvariants(healthyOpen(10n)), [])
    assert.deepEqual(checkMarketInvariants(healthyOpen(0n)), [])
    assert.deepEqual(checkMarketInvariants(healthySettled()), [])
  })

  it('ignores USDC donated to the vault: extra backing breaks no invariant', () => {
    assert.deepEqual(checkMarketInvariants(healthyOpen(10n, { vaultBalance: 11n * UNIT })), [])
    assert.deepEqual(checkMarketInvariants(healthySettled({ vaultBalance: 5n * UNIT })), [])
  })

  const broken: [string, MarketCollateral][] = [
    [
      'the vault holds less than the collateral counter',
      healthyOpen(10n, { vaultBalance: 9n * UNIT }),
    ],
    [
      'an open market whose counter is not pairs × $1',
      healthyOpen(10n, { collateral: 9n * UNIT, vaultBalance: 9n * UNIT }),
    ],
    ['an open market with more Yes than pairs', healthyOpen(10n, { yesSupply: 11n * UNIT })],
    ['an open market with fewer No than pairs', healthyOpen(10n, { noSupply: 9n * UNIT })],
    [
      'a settled market whose counter no longer covers the winning supply',
      healthySettled({ yesSupply: 5n * UNIT }),
    ],
    [
      'a No-settled market whose vault no longer covers the winners',
      healthySettled({
        outcome: 'no',
        yesSupply: 0n,
        noSupply: 4n * UNIT,
        vaultBalance: 3n * UNIT,
      }),
    ],
  ]
  broken.forEach(([title, market]) => {
    it(`flags ${title}`, () => {
      const violations = checkMarketInvariants(market)
      assert.ok(violations.length > 0, 'no violation reported')
      violations.forEach((violation) => {
        assert.equal(violation.market, market.address)
        assert.equal(violation.ticker, market.ticker)
        assert.equal(violation.tradingDay, market.tradingDay)
        assert.ok(violation.check.length > 0)
        assert.ok(violation.message.length > 0)
      })
    })
  })
})

describe('R46 invariant audit alerts through the AlertSink', () => {
  const clock = new FakeClock(0)

  it('sends one invariant_failure alert per broken market and none for healthy ones', async () => {
    const sink = recordingSink()
    const bad = healthyOpen(10n, {
      address: 'Broken111111111111111111111111111111111111',
      ticker: 'MSFT',
      tradingDay: '2026-11-03',
      vaultBalance: 7n * UNIT,
    })
    const violations = await auditInvariants({
      chain: { listMarketCollateral: async () => [healthyOpen(3n), bad, healthySettled()] },
      alerter: createAlerter({ sinks: [sink] }),
      log: recordingLogger(clock),
    })

    assert.ok(violations.length > 0)
    violations.forEach((violation) => assert.equal(violation.market, bad.address))
    assert.ok(sink.sent.length > 0, 'no alert reached the sink')
    sink.sent.forEach((alert) => {
      assert.equal(alert.kind, 'invariant_failure')
      assert.equal(alert.details?.market, bad.address)
      assert.equal(alert.details?.ticker, 'MSFT')
      assert.equal(alert.details?.tradingDay, '2026-11-03')
      assert.match(alert.message, /MSFT/)
    })
    // Alert details must survive the webhook sink's JSON POST.
    assert.doesNotThrow(() => JSON.stringify(sink.sent))
  })

  it('logs every violation as an error', async () => {
    const log = recordingLogger(clock)
    await auditInvariants({
      chain: { listMarketCollateral: async () => [healthyOpen(10n, { noSupply: 0n })] },
      alerter: createAlerter({ sinks: [recordingSink()] }),
      log,
    })
    assert.ok(log.entries.some((entry) => entry.level === 'error'))
  })

  it('sends nothing on a healthy chain', async () => {
    const sink = recordingSink()
    const violations = await auditInvariants({
      chain: { listMarketCollateral: async () => [healthyOpen(10n), healthySettled()] },
      alerter: createAlerter({ sinks: [sink] }),
      log: recordingLogger(clock),
    })
    assert.deepEqual(violations, [])
    assert.deepEqual(sink.sent, [])
  })

  it('logs a failed chain read without alerting an invariant failure or throwing', async () => {
    const sink = recordingSink()
    const log = recordingLogger(clock)
    const violations = await auditInvariants({
      chain: {
        listMarketCollateral: async () => {
          throw new Error('rpc down')
        },
      },
      alerter: createAlerter({ sinks: [sink] }),
      log,
    })
    assert.deepEqual(violations, [])
    assert.deepEqual(sink.sent, [])
    assert.ok(
      log.entries.some(
        (entry) => entry.level === 'error' && JSON.stringify(entry).includes('rpc down'),
      ),
      'the read failure is logged',
    )
  })
})
