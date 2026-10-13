import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, beforeEach, describe, it } from 'node:test'
import {
  createAlerter,
  createLogSink,
  createWebhookSink,
  sinksFromEnv,
  type Alert,
  type AlertSink,
} from './index.js'

const ALERT: Alert = {
  kind: 'admin_price_mismatch',
  message: 'oracle price differs from the pending admin price',
  details: { ticker: 'AAPL', oraclePrice: 23_145, adminPrice: 23_150 },
}

interface ReceivedRequest {
  method: string | undefined
  url: string | undefined
  contentType: string | undefined
  body: string
}

/** Local HTTP server standing in for a webhook endpoint. No external network is used. */
class FakeWebhook {
  readonly received: ReceivedRequest[] = []
  status = 200
  private readonly server: Server = createServer((req, res) => {
    void readBody(req).then((body) => {
      this.received.push({
        method: req.method,
        url: req.url,
        contentType: req.headers['content-type'],
        body,
      })
      res.writeHead(this.status).end()
    })
  })

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  url(path = '/hook'): string {
    const { port } = this.server.address() as AddressInfo
    return `http://127.0.0.1:${port}${path}`
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** In-memory sink that records alerts, or fails the way it is told to. */
function fakeSink(name: string, behavior: 'ok' | 'reject' | 'throw' = 'ok') {
  const sent: Alert[] = []
  const sink: AlertSink = {
    name,
    send(alert) {
      if (behavior === 'throw') throw new Error(`${name} threw`)
      if (behavior === 'reject') return Promise.reject(new Error(`${name} rejected`))
      sent.push(alert)
      return Promise.resolve()
    },
  }
  return { sink, sent }
}

describe('log sink', () => {
  it('writes each alert as one structured JSON line', async () => {
    const lines: string[] = []
    const sink = createLogSink((line) => lines.push(line))

    await sink.send(ALERT)

    assert.equal(sink.name, 'log')
    assert.equal(lines.length, 1)
    const line = lines[0] ?? ''
    assert.ok(!line.includes('\n'), 'one line per alert')
    const parsed = JSON.parse(line) as Record<string, unknown>
    assert.equal(parsed.level, 'alert')
    assert.equal(parsed.kind, ALERT.kind)
    assert.equal(parsed.message, ALERT.message)
    assert.deepEqual(parsed.details, ALERT.details)
  })
})

describe('webhook sink', () => {
  const webhook = new FakeWebhook()
  before(() => webhook.start())
  after(() => webhook.stop())
  beforeEach(() => {
    webhook.received.length = 0
    webhook.status = 200
  })

  it('POSTs the alert as JSON to the configured URL', async () => {
    const sink = createWebhookSink({ url: webhook.url('/alerts') })

    await sink.send(ALERT)

    assert.equal(sink.name, 'webhook')
    assert.equal(webhook.received.length, 1)
    const request = webhook.received[0]
    assert.equal(request?.method, 'POST')
    assert.equal(request?.url, '/alerts')
    assert.match(request?.contentType ?? '', /^application\/json/)
    assert.deepEqual(JSON.parse(request?.body ?? ''), {
      kind: ALERT.kind,
      message: ALERT.message,
      details: ALERT.details,
    })
  })

  it('rejects when the endpoint answers with a non-2xx status', async () => {
    webhook.status = 500
    const sink = createWebhookSink({ url: webhook.url() })

    await assert.rejects(sink.send(ALERT))
  })

  it('rejects when the endpoint is unreachable', async () => {
    const closed = new FakeWebhook()
    await closed.start()
    const url = closed.url()
    await closed.stop()

    await assert.rejects(createWebhookSink({ url }).send(ALERT))
  })

  it('uses an injected fetch when one is given', async () => {
    const calls: [string, RequestInit | undefined][] = []
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push([String(input), init])
      return new Response(null, { status: 204 })
    }) as typeof fetch

    await createWebhookSink({ url: 'http://example.invalid/hook', fetch: fakeFetch }).send(ALERT)

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.[0], 'http://example.invalid/hook')
    assert.equal(calls[0]?.[1]?.method, 'POST')
  })
})

describe('sink selection from the environment', () => {
  const webhook = new FakeWebhook()
  before(() => webhook.start())
  after(() => webhook.stop())

  it('uses only the log sink when no webhook URL is set', () => {
    assert.deepEqual(
      sinksFromEnv({}, () => {}).map((sink) => sink.name),
      ['log'],
    )
    assert.deepEqual(
      sinksFromEnv({ ALERT_WEBHOOK_URL: '' }, () => {}).map((sink) => sink.name),
      ['log'],
    )
  })

  it('adds the webhook sink, pointed at ALERT_WEBHOOK_URL, when it is set', async () => {
    const lines: string[] = []
    const sinks = sinksFromEnv({ ALERT_WEBHOOK_URL: webhook.url('/from-env') }, (line) =>
      lines.push(line),
    )

    assert.deepEqual(
      sinks.map((sink) => sink.name),
      ['log', 'webhook'],
    )
    await Promise.all(sinks.map((sink) => sink.send(ALERT)))
    assert.equal(lines.length, 1)
    assert.equal(webhook.received.length, 1)
    assert.equal(webhook.received[0]?.url, '/from-env')
  })
})

describe('alerter', () => {
  it('delivers each alert to every sink', async () => {
    const first = fakeSink('first')
    const second = fakeSink('second')
    const alerter = createAlerter({ sinks: [first.sink, second.sink], logError: () => {} })

    await alerter.alert(ALERT)

    assert.deepEqual(first.sent, [ALERT])
    assert.deepEqual(second.sent, [ALERT])
  })

  it('logs failing sinks, keeps delivering to the rest and never throws', async () => {
    const rejecting = fakeSink('rejecting', 'reject')
    const throwing = fakeSink('throwing', 'throw')
    const healthy = fakeSink('healthy')
    const logged: [string, unknown, Alert][] = []
    const alerter = createAlerter({
      sinks: [rejecting.sink, throwing.sink, healthy.sink],
      logError: (sinkName, error, alert) => logged.push([sinkName, error, alert]),
    })

    await assert.doesNotReject(alerter.alert(ALERT))

    assert.deepEqual(healthy.sent, [ALERT])
    assert.deepEqual(logged.map(([name]) => name).sort(), ['rejecting', 'throwing'])
    logged.forEach(([, error, alert]) => {
      assert.ok(error instanceof Error)
      assert.equal(alert, ALERT)
    })
  })

  it('does not throw even when the error logger itself throws', async () => {
    const alerter = createAlerter({
      sinks: [fakeSink('broken', 'reject').sink],
      logError: () => {
        throw new Error('logger down')
      },
    })

    await assert.doesNotReject(alerter.alert(ALERT))
  })

  it('contains a failing webhook sink', async () => {
    const webhook = new FakeWebhook()
    webhook.status = 503
    await webhook.start()
    try {
      const logged: string[] = []
      const alerter = createAlerter({
        sinks: [createWebhookSink({ url: webhook.url() })],
        logError: (sinkName) => logged.push(sinkName),
      })

      await assert.doesNotReject(alerter.alert(ALERT))
      assert.deepEqual(logged, ['webhook'])
    } finally {
      await webhook.stop()
    }
  })
})
