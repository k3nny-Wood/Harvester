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
crates/harvester-core   pure logic, no I/O: decimals, symbol filters, ladder builder (+ QFL, scanner, risk next)
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

## Roadmap

| # | Milestone | Status |
|---|---|---|
| 1 | Core: decimals, filters, ladder builder (ported from CryptoTrader with parity tests) | done |
| 2 | Tauri shell, dockview layout, Vela chart on Rust-fed data, symbol list, ladder tool preview | done |
| 3 | Pine Script workspace (PineTS + the 146-script library), indicator panel | next |
| 4 | Signed trading (Rust): place / cancel / amend, positions, balances, user-data stream, safety limits; ladder placement; order lines on the chart | |
| 5 | Scanner and signals: QFL base detector (port of the MarketScanner Rust detector), drop scanner with structure scoring, signal panel, alerts | |
| 6 | Lab panel: the backtest workbench (shared-account simulator, luck test, start-date test, stressed costs) | |
| 7 | ML trade finder (ONNX via `ort`), clearly marked experimental | |
| 8 | Installer (NSIS), settings, documentation, CI | |

## Principles

- **Honest numbers.** Backtests report the luck test, start-date spread, stressed costs and regime split, never one flattering number.
- **Safety defaults.** Testnet by default; switching to live asks for confirmation; server-side order / leverage / position caps.
- **Exact arithmetic.** Prices and quantities are decimals rounded to the exchange's tick and step, never floats.
- **Parity tests.** Every function ported from TypeScript keeps its original tests.
