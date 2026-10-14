# Price fixtures

Small chart API payloads for the price-provider tests and the offline `mock` relay source. Most are
hand-written; see below. Tests never hit the network.

`provenance.json` records where each `yahoo/` file came from: `recorded` files carry the request,
capture time and SHA-256 of the bytes the live endpoint returned; `hand-written` files carry the
request to record them from (`recordFrom`) and the SHA-256 of the committed file;
`recorded-transcribed` files carry the request, capture time and SHA-256 of the committed file, and a
note that their values were copied from a live response whose bytes were not kept.

- `yahoo/rate-limited.txt` is a recorded HTTP 429 body from the Yahoo Finance chart API, byte for
  byte (it ends in CRLF).
- `yahoo/AAPL-2026-10-12-close.json` is the recorded AAPL close of 2026-10-12 ($340.97, stamped
  16:00:01 ET) that the demo replays (`createDemoReplaySource`, and the `mock` source with
  `DEMO_MODE=true`). Its values were transcribed from one live chart API response read on that
  evening; the response bytes were not saved, so there is no checksum of them. It holds only the
  transcribed fields: the official close, the previous close, the regular session and the last three
  one-minute closes. Its name is outside the plain `mock` source's `-1m.json` pattern, so that source
  keeps replaying the 2026-10-09 files.
- The other `yahoo/` files are hand-written in the chart API's v8 response schema, trimmed to the
  minutes around the 4:00 PM ET close (`1m`) or to five daily bars (`1d`), because the live
  endpoint answered HTTP 429 to every capture attempt (most recently on 2026-10-13: three requests
  from a browser User-Agent to query2). To replace them with real captures, run
  `npm run record-fixtures` in `packages/price-providers` (add `--dry-run` to see the requests
  first). It sends at most six requests, at least 60 s apart, tries query1 then query2, stops at
  the first fixture both refuse, and rewrites each captured file byte for byte with a `recorded`
  provenance entry. Record `MSFT-2026-10-12-1d-intraday.json` during the regular session. Several
  tests hard-code values from the hand-written files (the $245.27 AAPL close, for example), so
  update them after a capture.
- `pyth/` is a Hermes `GET /v2/updates/price/{publish_time}` response, and `chainlink/` a decoded
  Data Streams RWA Advanced (v11) report, written from the documented formats because neither
  account is entitled to US equities.

`1791576000` is 2026-10-09 16:00 ET, the close the fixtures are built around.

## Alpaca

`alpaca/` holds small Alpaca market-data responses (`data.alpaca.markets`, `/v2/stocks`) and two
short websocket transcripts (`stream.data.alpaca.markets/v2/iex`), recorded on 2026-10-14 with a
few requests. `provenance.json` records each request (never the credentials), capture time and
SHA-256. Feeds:

- SIP (consolidated): the daily bars (`bars-1day-…-sip.json`), the full 2026-10-13 session of
  1-minute bars for AAPL and MSFT, the 1-minute bars around the 2026-10-13 4:00 PM ET close, and
  the AAPL trades at that close. The free plan serves SIP only for data older than about 15
  minutes; newer requests answer HTTP 403 (`sip-recent-refused.json`, recorded).
- IEX (the free plan's real-time feed): the snapshots, the websocket transcripts and one
  1-minute window around the close, which has no bars after 15:59 ET.
- `unauthorized.html` is the recorded HTTP 401 body for a bad key (an nginx page, not JSON).
- `rate-limited.json` is hand-written in the documented error schema: provoking a real 429 would
  mean exceeding the rate limit on purpose.
- In the websocket transcripts, the client's auth message holds `<ALPACA_API_KEY>` and
  `<ALPACA_API_SECRET>` placeholders. Server messages are as received.

`1791921600` is 2026-10-13 16:00 ET, the close the Alpaca fixtures are built around.
