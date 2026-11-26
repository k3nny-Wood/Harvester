# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Harvester is a manual trading terminal with signals for Binance USDⓈ-M futures (Windows, testnet by default, AGPL-3.0). It is not an automated trading engine. `README.md` documents user-facing features in detail; `docs/DESIGN.md` holds design decisions; `docs/*.txt` are backtest/study results (e.g. why the ML trade finder was removed).

## Commands

```bash
pnpm install
pnpm dev                       # tauri dev: opens the desktop window (Vite + Rust)
pnpm test                      # cargo test --workspace && pnpm --dir ui test
pnpm typecheck                 # tsc --noEmit in ui/
pnpm bundle                    # release build + NSIS installer (target/release/bundle/nsis/)

cargo test -p harvester-core                 # one crate
cargo test -p harvester-engine some_name     # one Rust test by name filter
pnpm --dir ui test                           # vitest run (all UI tests, ui/test/*.test.ts)
pnpm --dir ui exec vitest run test/priceBand.test.ts   # one UI test file
pnpm --dir ui build                          # tsc + vite build -> ui/dist (needed for web mode)

cargo run --release -p harvester-server      # headless server (Telegram bot, scanner, optional web UI)
bash deploy/update.sh                        # build Linux binary in Docker and push to the AWS server (see deploy/README.md)
```

Config comes from a `.env` (see `.env.example`), searched upward from the working directory. `HARVESTER_ENV=live` selects the live exchange; otherwise testnet (which uses Binance Demo Trading hosts `demo-fapi` / `demo-fstream`). `MAX_ORDER_NOTIONAL` is an optional per-order cap (unset or 0 = no cap, the default). Never run a built deploy binary locally: it would read `.env` and start for real.

## Architecture

Cargo workspace + pnpm workspace (`ui`). Dependency direction: `ui -> (rpc/events) -> engine -> core`.

- `crates/harvester-core`: pure logic, no I/O. Decimals (`rust_decimal`, never floats for prices/quantities), symbol filters, ladder builder, QFL detector, signals, held-order rules, Lab backtest simulator, SMC, movers, news/delist parsing. Ported from TypeScript/MarketScanner with parity tests, so keep the original tests when touching ports.
- `crates/harvester-engine`: everything with I/O and no GUI dependency: Binance REST/websocket (`market.rs`, `stream.rs`, `userstream.rs`), signed trading (`trading.rs`), scanner, held/armed orders and brackets, Telegram bot (`telegram.rs`), AI analyst, news, health. `core::Core` is the single command surface: `Core::dispatch(name, args)` answers every command; events go out through the `events::Sink` trait.
- `src-tauri`: thin desktop shell. One Tauri command `rpc(name, args)` forwards to `Core::dispatch`; engine events are forwarded to the window by a `TauriSink`. Engine background tasks run on Tauri's tokio runtime (`rt::init`).
- `crates/harvester-server`: headless binary running the same `Core`; optionally serves the built UI (`ui/dist`) plus `POST /api/<command>` and a `/ws` event socket for browsers/phones (`web.rs`), guarded by `HARVESTER_WEB_TOKEN` bearer auth.
- `ui`: React 18 + Vite + Zustand + dockview panels + Vela charts + PineTS. `ui/src/transport.ts` hides whether it is talking to Tauri or to the HTTP/WS server, so the UI must go through it (and `api.ts`) rather than calling Tauri directly. `ui/src/mobile` is the phone layout of the same page.

Adding a command means adding it to `Core::dispatch` once; it is then available to both the desktop window and the web server.

### Things to keep in mind

- Only one program may poll a Telegram bot, and only one should process held/armed orders (the desktop app by default; the server only with `HARVESTER_SERVER_ORDERS=1`). Don't run app and server together without `HARVESTER_TELEGRAM=off`.
- Binance request budgets are tracked per exchange with weights, with shared caches (trade history, symbol list) and no polling from hidden screens; recent history is about avoiding rate-limit bans. Add new REST calls through the existing guarded/budgeted paths.
- Limit orders outside Binance's percent-price band are held locally (`held.rs`, persisted to `%APPDATA%\Harvester\held_orders.json`) and sent when the band reaches them; they exist only while Harvester runs.
- The scanner (`scanner.rs`) follows several timeframes at once (default 1m, 5m, 15m): one kline socket and one candle buffer per (symbol, timeframe), drops checked on every update, QFL history only for 5m and up. Every signal carries its timeframe, and signal ids include it.
- A stop-market / take-profit-market is limited by the coin's MARKET_LOT_SIZE (`market_max_qty`), often smaller than the limit-order maximum. Bigger stops are split into pieces (`split_quantity`); orders at the same trigger level count as one exit and are moved and resized together (`modify_stop_group`, `exits_to_resize`).
- Deploying is `bash deploy/update.sh` with Docker Desktop running. The server's SSH firewall rule only allows the home IP, so a changed IP must be updated in the Lightsail console first.
- Every Pine indicator in the library is executed by the UI test suite, so adding one means it must run cleanly there.
- Backtests must report honest numbers (luck test, start-date spread, stressed costs), not one flattering figure.
