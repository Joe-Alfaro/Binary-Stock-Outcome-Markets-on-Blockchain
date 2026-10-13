import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { PublicKey } from '@solana/web3.js'
import {
  base58ToBytes,
  decodeLatestPrice,
  decodeMarket,
  decodeOrderBook,
  DISCRIMINATORS,
  EVENT_DISCRIMINATORS,
  EVENT_IX_TAG,
  eventFromCpiData,
  eventsFromLogs,
  ORDER_BOOK_SIZE,
  tickerBytes,
  toYesBook,
} from '../../src/lib/chain/layout'

function discriminator(preimage: string): number[] {
  return [...createHash('sha256').update(preimage).digest().subarray(0, 8)]
}

/** Little-endian byte writer for building account fixtures. */
class Writer {
  private bytes: number[] = []
  raw(values: ArrayLike<number>) {
    this.bytes.push(...Array.from(values))
    return this
  }
  u8(value: number) {
    return this.raw([value])
  }
  u32(value: number) {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, value, true)
    return this.raw(b)
  }
  i32(value: number) {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setInt32(0, value, true)
    return this.raw(b)
  }
  u64(value: bigint | number) {
    const b = new Uint8Array(8)
    new DataView(b.buffer).setBigUint64(0, BigInt(value), true)
    return this.raw(b)
  }
  i64(value: bigint | number) {
    const b = new Uint8Array(8)
    new DataView(b.buffer).setBigInt64(0, BigInt(value), true)
    return this.raw(b)
  }
  key(key: PublicKey) {
    return this.raw(key.toBytes())
  }
  zeros(count: number) {
    return this.raw(new Uint8Array(count))
  }
  done() {
    return Uint8Array.from(this.bytes)
  }
}

const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n))

describe('account and event discriminators', () => {
  it('match the Anchor hashes', () => {
    Object.entries(DISCRIMINATORS).forEach(([name, bytes]) =>
      assert.deepEqual([...bytes], discriminator(`account:${name}`), name),
    )
    Object.entries(EVENT_DISCRIMINATORS).forEach(([name, bytes]) =>
      assert.deepEqual([...bytes], discriminator(`event:${name}`), name),
    )
    assert.deepEqual([...EVENT_IX_TAG], discriminator('anchor:event').reverse())
  })
})

describe('Market', () => {
  function market(outcome: number | null) {
    const w = new Writer()
      .raw(DISCRIMINATORS.Market)
      .raw(tickerBytes('AAPL'))
      .u32(20261012)
      .i64(23000)
      .i32(-2)
      .i64(1_792_000_000)
      .i64(1_791_970_000)
      .i64(1_791_972_000)
      .key(key(1))
      .key(key(2))
      .key(key(3))
      .key(key(4))
      .key(key(5))
      .u64(0)
      .u64(0)
      .u8(outcome === null ? 0 : 1)
    if (outcome === null) w.u8(0)
    else w.u8(1).u8(outcome)
    return w
      .i64(23142)
      .u8(outcome === null ? 0 : 1)
      .u8(1)
      .i64(0)
      .u8(255)
      .zeros(64)
      .done()
  }

  it('decodes an open demo market', () => {
    const m = decodeMarket(market(null))
    assert.equal(m.ticker, 'AAPL')
    assert.equal(Number(m.strike) * 10 ** m.strikeExpo, 230)
    assert.equal(m.closeTs, 1_792_000_000)
    assert.ok(m.book.equals(key(5)))
    assert.equal(m.settled, false)
    assert.equal(m.outcome, null)
    assert.equal(m.demo, true)
  })

  it('decodes a settled market across the variable-length outcome', () => {
    const m = decodeMarket(market(1))
    assert.equal(m.settled, true)
    assert.equal(m.outcome, 'No')
    assert.equal(m.settlePrice, 23142n)
    assert.equal(m.settleSource, 'Oracle')
    assert.equal(m.demo, true)
  })
})

describe('OrderBook', () => {
  it('aggregates resting orders per price, best first, and reads seats', () => {
    const order = (w: Writer, id: number, qty: number, price: number, seat: number) =>
      w.u64(id).u64(qty).u8(price).u8(seat).zeros(6)
    const w = new Writer()
      .raw(DISCRIMINATORS.OrderBook)
      .key(key(9))
      .key(key(7))
      .key(key(8))
      .u64(4)
      .u8(254)
      .zeros(7)
    order(w, 1, 10, 58, 0)
    order(w, 2, 5, 60, 1)
    order(w, 3, 7, 58, 1)
    w.zeros(24 * 29)
    order(w, 4, 30, 70, 0)
    w.zeros(24 * 31)
    w.key(key(11)).u64(2_000_000).u64(0)
    w.zeros(48 * 31)
    const data = w.done()
    assert.equal(data.length, ORDER_BOOK_SIZE)

    const book = decodeOrderBook(data)
    assert.ok(book.yesEscrow.equals(key(7)))
    assert.ok(book.seats[0]?.owner.equals(key(11)))
    assert.equal(book.seats[0]?.freeYes, 2_000_000n)
    assert.deepEqual(toYesBook(book), {
      bids: [
        { priceCents: 60, qty: 5 },
        { priceCents: 58, qty: 17 },
      ],
      asks: [{ priceCents: 70, qty: 30 }],
    })
  })
})

describe('LatestPrice', () => {
  it('scales the price by its exponent', () => {
    const data = new Writer()
      .raw(DISCRIMINATORS.LatestPrice)
      .key(key(3))
      .raw(tickerBytes('TSLA'))
      .i64(25107)
      .u64(5)
      .i32(-2)
      .i64(1_792_000_000)
      .u8(0)
      .u8(0)
      .u8(255)
      .done()
    assert.deepEqual(decodeLatestPrice(data), {
      ticker: 'TSLA',
      price: 251.07,
      publishTs: 1_792_000_000,
    })
  })
})

describe('events', () => {
  const meta = { signature: 'sig', ts: 100 }

  it('decodes an emit_cpi OrderFilled', () => {
    const data = new Writer()
      .raw(EVENT_IX_TAG)
      .raw(EVENT_DISCRIMINATORS.OrderFilled)
      .key(key(1))
      .key(key(2))
      .key(key(3))
      .u64(42)
      .u8(1)
      .u8(64)
      .u64(3)
      .i64(200)
      .done()
    assert.deepEqual(eventFromCpiData(data, meta), {
      kind: 'OrderFilled',
      signature: 'sig',
      ts: 200,
      market: key(1).toBase58(),
      maker: key(2).toBase58(),
      taker: key(3).toBase58(),
      makerOrderId: '42',
      takerSide: 'Ask',
      priceCents: 64,
      qty: 3,
    })
  })

  it('decodes PairMinted from program-data logs', () => {
    const body = new Writer()
      .raw(EVENT_DISCRIMINATORS.PairMinted)
      .key(key(1))
      .key(key(4))
      .u64(10)
      .done()
    const logs = ['Program log: x', `Program data: ${Buffer.from(body).toString('base64')}`]
    assert.deepEqual(eventsFromLogs(logs, meta), [
      {
        kind: 'PairMinted',
        signature: 'sig',
        ts: 100,
        market: key(1).toBase58(),
        owner: key(4).toBase58(),
        qty: 10,
      },
    ])
  })

  it('base58-decodes instruction data', () => {
    const k = key(200)
    assert.deepEqual([...base58ToBytes(k.toBase58())], [...k.toBytes()])
    assert.deepEqual([...base58ToBytes('11')], [0, 0])
  })
})
