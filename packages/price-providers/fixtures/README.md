# Price fixtures

Small recorded payloads for the price-provider tests and the offline `mock` relay source. Tests
never hit the network.

`provenance.json` records where each `yahoo/` file came from: `recorded` files carry the request,
capture time and SHA-256 of the bytes the live endpoint returned; `hand-written` files carry the
request to record them from (`recordFrom`) and the SHA-256 of the committed file.

- `yahoo/rate-limited.txt` is a recorded HTTP 429 body from the Yahoo Finance chart API, byte for
  byte (it ends in CRLF).
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
