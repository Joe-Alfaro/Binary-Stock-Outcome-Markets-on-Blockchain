# Price fixtures

Small recorded payloads for the price-provider tests and the offline `mock` relay source. Tests
never hit the network.

`provenance.json` records where each `yahoo/` file came from: `recorded` files carry the request,
capture time and SHA-256 of the bytes the live endpoint returned; `hand-written` files carry the
request to record them from.

- `yahoo/rate-limited.txt` is a recorded HTTP 429 body from the Yahoo Finance chart API, byte for
  byte (it ends in CRLF).
- The other `yahoo/` files follow the chart API's v8 response schema, trimmed to the minutes
  around the 4:00 PM ET close (`1m`) or to five daily bars (`1d`). The live endpoint was
  rate-limited when they were made (again on 2026-10-13: three requests from a browser User-Agent
  to query2, all 429), so their values were written by hand in that schema. Replace them with real
  captures of the same days and shape when the endpoint answers, and update `provenance.json`;
  the tests read expected values from the files.
- `pyth/` is a Hermes `GET /v2/updates/price/{publish_time}` response, and `chainlink/` a decoded
  Data Streams RWA Advanced (v11) report, written from the documented formats because neither
  account is entitled to US equities.

`1791576000` is 2026-10-09 16:00 ET, the close the fixtures are built around.
