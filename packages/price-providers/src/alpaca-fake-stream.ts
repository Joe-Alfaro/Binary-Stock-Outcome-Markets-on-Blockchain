// A local stand-in for Alpaca's market-data websocket, for tests. It speaks just enough of
// RFC 6455 (text frames, close, ping) and of Alpaca's protocol (connect, auth, subscribe) to
// replay recorded sessions, so no test reaches the network.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** One server message batch: Alpaca sends every websocket message as a JSON array. */
export type AlpacaBatch = Record<string, unknown>[]

export interface FakeAlpacaStreamOptions {
  keyId: string
  secretKey: string
  /** Batches sent to a client right after it subscribes, such as a recorded session's data. */
  afterSubscribe?: AlpacaBatch[]
}

export interface ReceivedMessage {
  /** 1 for the first connection accepted, 2 for the next, and so on. */
  connection: number
  message: Record<string, unknown>
}

export interface FakeAlpacaStream {
  readonly url: string
  /** Every client message, parsed, across all connections. */
  readonly received: ReceivedMessage[]
  /** Connections accepted so far. */
  readonly connections: number
  /** Connections open now. */
  readonly open: number
  /** Sends a batch to every authenticated client. */
  send(batch: AlpacaBatch): void
  /** Destroys every open connection without a close frame, like a network drop. */
  dropAll(): void
  /** Stops accepting connections and drops the open ones. */
  stop(): Promise<void>
  /** Listens again on the same port. */
  restart(): Promise<void>
  close(): Promise<void>
}

interface Client {
  id: number
  socket: Duplex
  authenticated: boolean
  buffer: Buffer
}

function frame(opcode: number, payload: Buffer): Buffer {
  const { length } = payload
  if (length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload])
  if (length < 65536) {
    const header = Buffer.alloc(4)
    header.writeUInt8(0x80 | opcode, 0)
    header.writeUInt8(126, 1)
    header.writeUInt16BE(length, 2)
    return Buffer.concat([header, payload])
  }
  const header = Buffer.alloc(10)
  header.writeUInt8(0x80 | opcode, 0)
  header.writeUInt8(127, 1)
  header.writeBigUInt64BE(BigInt(length), 2)
  return Buffer.concat([header, payload])
}

interface Frame {
  opcode: number
  payload: Buffer
  size: number
}

/** The first complete client frame in `buffer`, or null when more bytes are needed. */
function readFrame(buffer: Buffer): Frame | null {
  if (buffer.length < 2) return null
  const opcode = (buffer[0] as number) & 0x0f
  const masked = ((buffer[1] as number) & 0x80) !== 0
  const short = (buffer[1] as number) & 0x7f
  const extended = { 126: 2, 127: 8 }[short] ?? 0
  const maskStart = 2 + extended
  if (buffer.length < maskStart) return null
  const length =
    extended === 0
      ? short
      : Number(extended === 2 ? buffer.readUInt16BE(2) : buffer.readBigUInt64BE(2))
  const dataStart = maskStart + (masked ? 4 : 0)
  if (buffer.length < dataStart + length) return null
  const data = Buffer.from(buffer.subarray(dataStart, dataStart + length))
  if (masked) {
    const mask = buffer.subarray(maskStart, dataStart)
    data.forEach((byte, i) => {
      data[i] = byte ^ (mask[i % 4] as number)
    })
  }
  return { opcode, payload: data, size: dataStart + length }
}

/** Starts a fake stream on a free localhost port. */
export async function startFakeAlpacaStream(
  options: FakeAlpacaStreamOptions,
): Promise<FakeAlpacaStream> {
  const clients = new Set<Client>()
  const received: ReceivedMessage[] = []
  let accepted = 0
  let port = 0
  let server: Server = createServer()

  function sendTo(client: Client, batch: AlpacaBatch) {
    client.socket.write(frame(0x1, Buffer.from(JSON.stringify(batch))))
  }

  function handleMessage(client: Client, message: Record<string, unknown>) {
    received.push({ connection: client.id, message })
    if (message.action === 'auth') {
      if (message.key === options.keyId && message.secret === options.secretKey) {
        client.authenticated = true
        sendTo(client, [{ T: 'success', msg: 'authenticated' }])
        return
      }
      sendTo(client, [{ T: 'error', code: 402, msg: 'auth failed' }])
      client.socket.end(frame(0x8, Buffer.from([0x03, 0xe8])))
      return
    }
    if (message.action === 'subscribe') {
      if (!client.authenticated) {
        sendTo(client, [{ T: 'error', code: 401, msg: 'not authenticated' }])
        return
      }
      const list = (value: unknown) => (Array.isArray(value) ? [...value].sort() : [])
      sendTo(client, [
        { T: 'subscription', trades: list(message.trades), quotes: list(message.quotes), bars: [] },
      ])
      ;(options.afterSubscribe ?? []).forEach((batch) => sendTo(client, batch))
    }
  }

  function handleData(client: Client, chunk: Buffer) {
    client.buffer = Buffer.concat([client.buffer, chunk])
    let next = readFrame(client.buffer)
    while (next) {
      client.buffer = client.buffer.subarray(next.size)
      if (next.opcode === 0x8) {
        client.socket.end(frame(0x8, Buffer.alloc(0)))
        return
      }
      if (next.opcode === 0x9) client.socket.write(frame(0xa, next.payload))
      if (next.opcode === 0x1) {
        const parsed = JSON.parse(next.payload.toString('utf8')) as unknown
        const messages = Array.isArray(parsed) ? parsed : [parsed]
        messages.forEach((message) => handleMessage(client, message as Record<string, unknown>))
      }
      next = readFrame(client.buffer)
    }
  }

  function attach(target: Server) {
    target.on('upgrade', (request, socket) => {
      const key = request.headers['sec-websocket-key']
      const accept = createHash('sha1')
        .update(`${String(key)}${WS_GUID}`)
        .digest('base64')
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      )
      accepted += 1
      const client: Client = { id: accepted, socket, authenticated: false, buffer: Buffer.alloc(0) }
      clients.add(client)
      socket.on('data', (chunk: Buffer) => handleData(client, chunk))
      socket.on('close', () => clients.delete(client))
      socket.on('error', () => clients.delete(client))
      sendTo(client, [{ T: 'success', msg: 'connected' }])
    })
  }

  function listen(target: Server, onPort: number) {
    return new Promise<void>((resolve) => {
      target.listen(onPort, '127.0.0.1', () => {
        port = (target.address() as AddressInfo).port
        resolve()
      })
    })
  }

  function dropAll() {
    clients.forEach((client) => client.socket.destroy())
    clients.clear()
  }

  async function stop() {
    dropAll()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  attach(server)
  await listen(server, 0)

  return {
    get url() {
      return `ws://127.0.0.1:${port}`
    },
    received,
    get connections() {
      return accepted
    },
    get open() {
      return clients.size
    },
    send(batch) {
      clients.forEach((client) => {
        if (client.authenticated) sendTo(client, batch)
      })
    },
    dropAll,
    stop,
    async restart() {
      server = createServer()
      attach(server)
      await listen(server, port)
    },
    async close() {
      if (server.listening) await stop()
      dropAll()
    },
  }
}

/** Resolves once `condition` holds, polling every few milliseconds; rejects after `timeoutMs`. */
export async function waitUntil(
  condition: () => boolean,
  timeoutMs = 2000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export interface StreamTranscript {
  url: string
  startedAt: string
  transcript: { dir: 'server' | 'client'; at: string; message: unknown }[]
}

/** The recorded server batches that carry trades or quotes, in order. */
export function transcriptDataBatches(recording: StreamTranscript): AlpacaBatch[] {
  return recording.transcript
    .filter((entry) => entry.dir === 'server' && Array.isArray(entry.message))
    .map((entry) => entry.message as AlpacaBatch)
    .filter((batch) => batch.some((message) => message.T === 't' || message.T === 'q'))
}
