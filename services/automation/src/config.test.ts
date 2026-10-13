import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { loadConfig, loadOracleSlotSettings } from './config.js'

describe('loadConfig', () => {
  it('defaults to devnet with demo mode off', () => {
    assert.deepEqual(loadConfig({}), { cluster: 'devnet', demoMode: false })
  })

  it('reads cluster and demo mode from the environment', () => {
    assert.deepEqual(loadConfig({ SOLANA_CLUSTER: 'localnet', DEMO_MODE: 'true' }), {
      cluster: 'localnet',
      demoMode: true,
    })
  })
})

const AAPL_FEED = '49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688'
const MSFT_FEED = 'd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1'
const AAPL_STREAM = '000b6a1e3c5f7d9b2a4c6e8f0a1b3c5d7e9f2a4b6c8d0e1f3a5b7c9d1e2f4a6b'
const RECEIVER = 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ'
const VERIFIER = 'Gt9S41PtjR58CbG9JhJ3J6vxesqrNAswbWYbLNTMZA3c'

const PYTH_ENV = {
  PYTH_RECEIVER_PROGRAM_ID: RECEIVER,
  // Mixed case, a 0x prefix and spaces are accepted and normalized.
  PYTH_FEED_IDS: `AAPL=0x${AAPL_FEED.toUpperCase()}, msft=${MSFT_FEED}`,
  PYTH_ACCESS_TOKEN: 'pyth-token',
}

const CHAINLINK_ENV = {
  CHAINLINK_VERIFIER_PROGRAM_ID: VERIFIER,
  CHAINLINK_STREAM_IDS: `AAPL=0x${AAPL_STREAM}`,
  CHAINLINK_DATA_STREAMS_USERNAME: 'streams-user',
  CHAINLINK_HMAC_SECRET: 'streams-secret',
}

// R32: switching slot 1 to another kind takes update_config plus env vars.
describe('loadOracleSlotSettings (R32)', () => {
  it('defaults to the relay on slot 1 and slot 2 disabled', () => {
    assert.deepEqual(loadOracleSlotSettings({}), {
      slot1: { kind: 'relay' },
      slot2: { kind: 'disabled' },
    })
  })

  it('reads each kind from ORACLE_SLOT_1 and ORACLE_SLOT_2', () => {
    assert.deepEqual(
      loadOracleSlotSettings({ ORACLE_SLOT_1: 'disabled', ORACLE_SLOT_2: 'relay' }),
      { slot1: { kind: 'disabled' }, slot2: { kind: 'relay' } },
    )
    assert.equal(loadOracleSlotSettings({ ...PYTH_ENV, ORACLE_SLOT_1: 'pyth' }).slot1.kind, 'pyth')
    assert.equal(
      loadOracleSlotSettings({ ...CHAINLINK_ENV, ORACLE_SLOT_2: 'chainlink' }).slot2.kind,
      'chainlink',
    )
  })

  it('rejects an unknown kind, naming the variable and the accepted kinds', () => {
    assert.throws(
      () => loadOracleSlotSettings({ ORACLE_SLOT_1: 'switchboard' }),
      (error: unknown) =>
        error instanceof Error &&
        /ORACLE_SLOT_1/.test(error.message) &&
        ['relay', 'pyth', 'chainlink', 'disabled'].every((kind) => error.message.includes(kind)),
    )
    assert.throws(() => loadOracleSlotSettings({ ORACLE_SLOT_2: 'yes' }), /ORACLE_SLOT_2/)
  })

  it('reads the Pyth receiver program, feed IDs, access token and Hermes URL', () => {
    const { slot1 } = loadOracleSlotSettings({ ...PYTH_ENV, ORACLE_SLOT_1: 'pyth' })
    assert.deepEqual(slot1, {
      kind: 'pyth',
      receiverProgram: RECEIVER,
      feedIds: { AAPL: AAPL_FEED, MSFT: MSFT_FEED },
      accessToken: 'pyth-token',
      hermesUrl: 'https://hermes.pyth.network',
    })
    const custom = loadOracleSlotSettings({
      ...PYTH_ENV,
      ORACLE_SLOT_1: 'pyth',
      PYTH_HERMES_URL: 'http://127.0.0.1:4000/',
    })
    assert.equal(custom.slot1.kind === 'pyth' && custom.slot1.hermesUrl, 'http://127.0.0.1:4000')
  })

  it('reads the Data Streams verifier program, stream IDs, HMAC credentials and API URL', () => {
    const { slot1 } = loadOracleSlotSettings({ ...CHAINLINK_ENV, ORACLE_SLOT_1: 'chainlink' })
    assert.deepEqual(slot1, {
      kind: 'chainlink',
      verifierProgram: VERIFIER,
      streamIds: { AAPL: AAPL_STREAM },
      username: 'streams-user',
      secret: 'streams-secret',
      apiUrl: 'https://api.dataengine.chain.link',
    })
  })

  it('names each missing Pyth setting', () => {
    for (const name of Object.keys(PYTH_ENV)) {
      const env: NodeJS.ProcessEnv = { ...PYTH_ENV, ORACLE_SLOT_1: 'pyth', [name]: '' }
      assert.throws(
        () => loadOracleSlotSettings(env),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes(name) &&
          /ORACLE_SLOT_1/.test(error.message),
        `a missing ${name}`,
      )
    }
  })

  it('names each missing Data Streams setting', () => {
    for (const name of Object.keys(CHAINLINK_ENV)) {
      const env: NodeJS.ProcessEnv = { ...CHAINLINK_ENV, ORACLE_SLOT_2: 'chainlink', [name]: '' }
      assert.throws(
        () => loadOracleSlotSettings(env),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes(name) &&
          /ORACLE_SLOT_2/.test(error.message),
        `a missing ${name}`,
      )
    }
  })

  it('rejects malformed program and feed IDs, naming the variable', () => {
    const pyth = { ...PYTH_ENV, ORACLE_SLOT_1: 'pyth' }
    assert.throws(
      () => loadOracleSlotSettings({ ...pyth, PYTH_RECEIVER_PROGRAM_ID: 'not-a-key' }),
      /PYTH_RECEIVER_PROGRAM_ID/,
    )
    assert.throws(
      () => loadOracleSlotSettings({ ...pyth, PYTH_FEED_IDS: 'AAPL=1234' }),
      /PYTH_FEED_IDS/,
    )
    assert.throws(
      () => loadOracleSlotSettings({ ...pyth, PYTH_FEED_IDS: AAPL_FEED }),
      /PYTH_FEED_IDS/,
    )
    const chainlink = { ...CHAINLINK_ENV, ORACLE_SLOT_1: 'chainlink' }
    assert.throws(
      () => loadOracleSlotSettings({ ...chainlink, CHAINLINK_VERIFIER_PROGRAM_ID: '0xabc' }),
      /CHAINLINK_VERIFIER_PROGRAM_ID/,
    )
    assert.throws(
      () => loadOracleSlotSettings({ ...chainlink, CHAINLINK_STREAM_IDS: 'AAPL=zz' }),
      /CHAINLINK_STREAM_IDS/,
    )
  })

  it('needs no third-party settings for relay or disabled slots', () => {
    assert.doesNotThrow(() =>
      loadOracleSlotSettings({ ORACLE_SLOT_1: 'relay', ORACLE_SLOT_2: 'disabled' }),
    )
  })
})
