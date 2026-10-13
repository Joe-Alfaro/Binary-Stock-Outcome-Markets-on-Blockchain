# meridian program

Config, strike markets, Yes/No mints, the collateral vault, and mint and merge. The order book,
settlement and redeem are added by later packages. See `ARCHITECTURE.md` for the full design.

## Modules

| Module                       | Contents                                                                  |
| ---------------------------- | ------------------------------------------------------------------------- |
| `state.rs`                   | `Config`, `TickerDay`, `Market`, the `OrderBook` header, seeds and `UNIT` |
| `errors.rs`                  | `MeridianError`. Codes start at 6000; append new variants at the end.     |
| `events.rs`                  | `PairMinted`, `PairMerged`                                                |
| `instructions/config.rs`     | `initialize_config`, `update_config`, `pause`, `unpause`                  |
| `instructions/market.rs`     | `create_strike_market`, `add_strike`                                      |
| `instructions/collateral.rs` | `mint_pair`, `merge_pair`                                                 |

## Rules

- `initialize_config` can only be signed by the program's upgrade authority, read from this
  program's own program-data account.
- `update_config`, `pause` and `unpause` are admin-only and take only `[admin, config]`, so they
  can't touch markets. `update_config` can't change `admin` or `usdc_mint`.
- `create_strike_market` (admin or automation authority) and `add_strike` (admin only) create one
  strike per call, before `close_ts`. All strikes of a ticker and day share one `TickerDay` and its
  `close_ts`.
- **No instruction changes an existing strike.** A market's terms are written once at creation;
  only `collateral`, `pairs_outstanding` and, later, the settlement fields change.
- `mint_pair(n)` takes exactly `n × 1_000_000` USDC base units and mints `n` Yes and `n` No. It is
  blocked when paused, before `mint_open_ts`, at or after `close_ts`, and after settlement.
- `merge_pair(n)` burns `n` of each and pays `n × 1_000_000`. It works while paused and after
  close, until settlement.
- `Market.collateral` is the backing counter and always equals `pairs_outstanding × 1_000_000`.
  Payouts never read the vault balance, so donations stay in the vault and are never paid out.
- No fees: only the network fee is paid.

## Layout notes for later packages

- `OrderBook` is zero-copy with `market` first; the order-book package appends its arrays after
  the existing fields.
- `Market` ends with a zeroed `_reserved: [u8; 64]` for settlement fields, so they fit in markets
  created before that upgrade. Take fields from the front and shrink the array.

## Tests

`anchor build`, then `cargo test -p meridian`. The LiteSVM tests in `tests/` load
`target/deploy/meridian.so`.
