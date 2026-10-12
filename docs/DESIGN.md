# Harvester — design

Harvester is a **manual trading terminal with signals** for Binance USDⓈ-M futures. It is not an automated
trading engine: it finds setups, draws them on the chart, and the trader decides and places the orders.
Open source (AGPL-3.0-or-later), Windows first, testnet by default.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Shell | **Tauri 2** (Rust core + system WebView2) | Vela and PineTS are JavaScript; a native window cannot run them without embedding a browser anyway. Tauri gives a small installer and a Rust core. |
| Logic | **Rust** (`crates/harvester-core`, `src-tauri`) | One source of truth, fast scanning / QFL / ML, testable without a window. |
| UI | React 18 + Vite + Zustand, **dockview** panels | Drag, re-arrange, float, tab and persist panels (Qt-style docking) without a C++ toolchain. |
| Chart | **Vela** (LuxAlgo, Apache-2.0, attribution required) | Charting + drawing tools. |
| Indicators | **PineTS** via `@luxalgo/vela-pinets` (AGPL-3.0) | Runs real Pine scripts in a web worker. This is why the app is AGPL. |
| Automation | **None** | Manual trading. The V2 auto-trading engine stays a separate app (MarketScanner). |
| Platform | Windows only for now | |

## Layout

```
crates/harvester-core   pure logic, no I/O: decimals, symbol filters, ladder builder, QFL detector, signals, ML features + trade plans
crates/harvester-ml     ONNX inference (`ort`): scaler, model config, long / short predictors
models                  models/15m/*.onnx and model_config_*.json (found next to the exe or in the project)
src-tauri               the app: Binance REST + websocket feeds, Tauri commands/events
ui                      React + dockview + Vela
docs                    this file
```

Dependency direction: `ui -> (Tauri commands/events) -> src-tauri -> harvester-core`.
The Rust side owns every feed and every calculation; the UI renders and listens.

## The ladder tool (first feature)

1. Press **L** (or the Ladder button), click on the chart where the ladder **starts**.
2. Click again where it **ends**: a vertical range line is drawn between the two prices.
3. A card appears with a slider for the **number of orders** (2-50), spacing (equal / geometric),
   size weighting (equal / growing / shrinking / exponential), and the total (USDT or quantity).
   Both ends and the line itself can be dragged afterwards.
4. Every rung is rounded to the symbol's tick / step and validated against the exchange limits
   (min notional, lot size, percent-price band) in `harvester-core::ladder`; rungs that break a limit
   are flagged with a warning and excluded from the totals.

Buy ladder when the range runs down from its start, sell ladder when it runs up (switchable).
Placing the orders needs the signed trading API and comes with the trading milestone.

## ML signals and trade plans

`harvester-core::ml` holds the 38-feature calculation (`BatchIndicators`, ported from MarketScanner) and `plan.rs`:
`evaluate(candles, params, predict)` asks the model for a long and a short probability, applies the RSI reversal filter and the minimum
confidence, and builds a `TradePlan` (stop from the recent swing / ATR clamped to 0.5-8 %, target at 2R). `harvester-ml` loads the ONNX models.
The scanner evaluates ML on the last closed 15 m candle of each scanned symbol and emits `Signal { kind: Ml, side, probability, plan }`.

Placing a plan (`trading::place_bracket`): the stop and the target are checked to be on the right sides of the entry, the entry order goes out,
and a watcher waits until the entry is no longer open, reads the position and places a reduce-only STOP_MARKET and TAKE_PROFIT_MARKET for its
size. Exits cannot be sent first because the exchange refuses reduce-only orders without a position. The outcome is reported as a `bracket`
event. `harvester-core::filters::validate_order` applies the percent-price band to limit prices only, as Binance does.

## Live account updates

`userstream.rs` opens Binance's user-data stream (listen key, kept alive every 25 minutes) and emits `account-changed` for every order,
algo-order or account event. The UI re-reads orders, positions and balances at once (coalesced 150 ms). The REST endpoints stay the
source of truth: the stream only says that something changed. The UI polls every 20 s as a safety net while the stream is connected and
every 3 s while it is not; the header shows "live" or "polling".

## Lab

`harvester-core::lab` (pure, tested): `find_setups` (Pine-exact QFL cracks + Donchian-low + pool gate, evaluated on the candle before the
crack), `simulate_ladder` (buys, stop, isolated-margin liquidation, layered sells, fees, funding, "fill through" margin; a candle that buys never
sells, because the order inside a candle is unknowable), `simulate_account` (cap, per-ladder budget, one ladder per symbol, mark-to-market
drawdown), `luck_test`, `start_dates`, `run_lab`. `src-tauri/src/lab.rs` downloads 1000-candle pages at 4 requests a second, retries a refusal after a
pause, caches per symbol for 6 hours and emits `lab-progress`. Differences from MarketScanner's Lab: long only, equal-share sells, no trailing last sell.

## Roadmap

| # | Milestone | Status |
|---|---|---|
| 1 | Core: decimals, filters, ladder builder (ported from CryptoTrader with parity tests) | done |
| 2 | Tauri shell, dockview layout (drag / re-arrange / float / tab / persist), Vela chart on Rust-fed data, symbol list | done |
| 3 | Tabbed multi-chart: every chart tab has its own symbol, timeframe, ladder draft | done |
| 4 | Signals: Pine-exact QFL detector (port), signal engine (crack / watch / drop, 0-100 score with reasons), live scanner over one combined websocket, Signals section with thumbnails that open charts | done (QFL + drop); alerts, sound, saved history next |
| 5 | Signed trading (Rust): account, positions, open orders, place / cancel / close, batch ladder placement, safety cap; Orders panel (manual entry), Portfolio panel, order lines on the chart, right-click ordering | done (limit / market); stop & take-profit, drag-to-edit orders, user-data stream next |
| 6 | The ladder tool places real orders (draw start/end, slider, preview, place) | done |
| 7 | Pine Script: per-chart workspace (PineTS in a web worker), 8 built-in + 138 community scripts (everget, MIT/GPL-3.0), `/` quick picker, editor, live plot values; every script is run by the test suite | done |
| 8 | Lab panel: shared-account QFL ladder backtest (`harvester-core::lab`), luck test, eight start dates, stressed costs; candles downloaded politely and cached (`src-tauri/src/lab.rs`) | done (QFL ladder; no short side, no trailing sell) |
| 9 | ML trade finder (ONNX via `ort`), clearly marked experimental: ML signals, trade-plan overlay (entry -> target arrow, stop), plan card, bracket placement (entry, then reduce-only stop-loss and take-profit) | done |
| 10 | Installer (NSIS), settings, documentation, CI | |
| 11 | Sound alerts, percent-price band on the chart, user-data websocket (`userstream.rs`) instead of 3 s polling | done |

## Principles

- **Honest numbers.** Backtests report the luck test, start-date spread, stressed costs and regime split, never one flattering number.
- **Safety defaults.** Testnet by default; switching to live asks for confirmation; server-side order / leverage / position caps.
- **Exact arithmetic.** Prices and quantities are decimals rounded to the exchange's tick and step, never floats.
- **Parity tests.** Every function ported from TypeScript keeps its original tests.
