import { readFileSync } from 'node:fs'
import anchor from '@anchor-lang/core'
import type { Idl } from '@anchor-lang/core'
import { PublicKey, Transaction } from '@solana/web3.js'
import type { Connection, Keypair } from '@solana/web3.js'
import type { NormalizedPrice } from '@meridian/price-providers'
import { oracleIdlPath } from '../chain/anchor.js'
import type { CloseRequest, OracleClient } from './types.js'

/** Sub-second finality: `confirmed` is enough for every relay write (R55). */
// The package is CommonJS and Node can't detect all of its named exports.
const { AnchorProvider, BN, Program, Wallet } = anchor

const COMMITMENT = 'confirmed'
const TICKER_BYTES = 8

const encoder = new TextEncoder()

/** The `meridian_oracle` IDL, read at runtime so the worker needn't compile against `target/`. */
export function loadOracleIdl(path = oracleIdlPath()): Idl {
  return JSON.parse(readFileSync(path, 'utf8')) as Idl
}

/** A ticker as the program's `[u8; 8]` seed: ASCII, right-padded with zero bytes. */
export function tickerSeed(ticker: string): Uint8Array {
  if (!/^[A-Z0-9.]{1,8}$/.test(ticker)) throw new RangeError(`ticker ${ticker} is not 1-8 ASCII`)
  const seed = new Uint8Array(TICKER_BYTES)
  seed.set(encoder.encode(ticker))
  return seed
}

function i64Le(value: number): Uint8Array {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigInt64(0, BigInt(value), true)
  return bytes
}

function u32Le(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, true)
  return bytes
}

function pda(programId: PublicKey, seeds: Uint8Array[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0]
}

/** The program's PDAs for one relay signer. */
export function oraclePdas(programId: PublicKey, signer: PublicKey) {
  const key = signer.toBytes()
  return {
    registry: pda(programId, [encoder.encode('signers')]),
    priceUpdate: (ticker: string, publishTime: number) =>
      pda(programId, [encoder.encode('price'), key, tickerSeed(ticker), i64Le(publishTime)]),
    closeRecord: (ticker: string, tradingDay: number) =>
      pda(programId, [encoder.encode('close'), key, tickerSeed(ticker), u32Le(tradingDay)]),
    latestPrice: (ticker: string) =>
      pda(programId, [encoder.encode('latest'), key, tickerSeed(ticker)]),
  }
}

/** A `NormalizedPrice` as the program's `PriceInput` argument. */
export function priceInput(update: NormalizedPrice) {
  return {
    price: new BN(update.price.toString()),
    conf: new BN(update.conf.toString()),
    expo: update.expo,
    publishTime: new BN(update.publishTime),
    session: update.session === 'regular' ? { regular: {} } : { outsideRegular: {} },
    officialClose: update.officialClose,
  }
}

export interface AnchorOracleClientOptions {
  connection: Connection
  /** The relay's own signer key; it also pays for the accounts it creates. */
  signer: Keypair
  /** The `meridian_oracle` IDL; its `address` is the program ID. */
  idl: Idl
}

/** `OracleClient` backed by the deployed `meridian_oracle` program. */
export function createAnchorOracleClient(options: AnchorOracleClientOptions): OracleClient {
  const { connection, signer } = options
  const provider = new AnchorProvider(connection, new Wallet(signer), {
    commitment: COMMITMENT,
    preflightCommitment: COMMITMENT,
  })
  const program = new Program(options.idl, provider)
  const pdas = oraclePdas(program.programId, signer.publicKey)
  const common = { signer: signer.publicKey, registry: pdas.registry }

  /** The generic `Idl` type can't prove an instruction exists, so check it once at runtime. */
  function method(name: 'publishPrice' | 'publishClose' | 'publishLatest') {
    const build = program.methods[name]
    if (!build) throw new Error(`the meridian_oracle IDL has no ${name} instruction`)
    return build
  }

  async function exists(address: PublicKey): Promise<boolean> {
    return (await connection.getAccountInfo(address, COMMITMENT)) !== null
  }

  return {
    signer: signer.publicKey.toBase58(),

    priceUpdateExists: (ticker, publishTime) => exists(pdas.priceUpdate(ticker, publishTime)),

    closeRecordExists: (ticker, tradingDay) => exists(pdas.closeRecord(ticker, tradingDay)),

    publishPrice(update) {
      return method('publishPrice')([...tickerSeed(update.ticker)], priceInput(update))
        .accountsPartial({
          ...common,
          priceUpdate: pdas.priceUpdate(update.ticker, update.publishTime),
        })
        .rpc()
    },

    async publishClose(request: CloseRequest) {
      const [first, second] = request.updates
      if (first === undefined) throw new Error(`close record for ${request.ticker} has no updates`)
      return method('publishClose')(
        [...tickerSeed(request.ticker)],
        request.tradingDay,
        new BN(request.closeTs),
      )
        .accountsPartial({
          ...common,
          closeRecord: pdas.closeRecord(request.ticker, request.tradingDay),
          firstUpdate: pdas.priceUpdate(request.ticker, first.publishTime),
          // Anchor encodes an absent optional account as the program ID: a one-update shape.
          secondUpdate: second
            ? pdas.priceUpdate(request.ticker, second.publishTime)
            : program.programId,
        })
        .rpc()
    },

    async publishLatest(updates) {
      const instructions = await Promise.all(
        updates.map((update) =>
          method('publishLatest')([...tickerSeed(update.ticker)], priceInput(update))
            .accountsPartial({ ...common, latestPrice: pdas.latestPrice(update.ticker) })
            .instruction(),
        ),
      )
      return provider.sendAndConfirm(new Transaction().add(...instructions))
    },
  }
}
