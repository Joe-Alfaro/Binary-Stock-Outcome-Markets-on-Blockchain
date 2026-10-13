# Price fixtures

Small recorded payloads for the price-provider tests and the offline `mock` relay source. Tests
never hit the network.

- `yahoo/rate-limited.txt` is a real HTTP 429 body from the Yahoo Finance chart API.
- The other `yahoo/` files follow the chart API's v8 response schema, trimmed to the minutes
  around the 4:00 PM ET close (`1m`) or to five daily bars (`1d`). The live endpoint was
  rate-limited when they were made, so their values were written by hand in that schema. Replace
  them with real captures of the same days and shape when convenient; the tests read expected
  values from the files.
- `pyth/` is a Hermes `GET /v2/updates/price/{publish_time}` response, and `chainlink/` a decoded
  Data Streams RWA Advanced (v11) report, written from the documented formats because neither
  account is entitled to US equities.

`1791576000` is 2026-10-09 16:00 ET, the close the fixtures are built around.
