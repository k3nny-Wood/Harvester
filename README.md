# Harvester

A manual trading terminal with signals for Binance USDⓈ-M futures. Rust core, Tauri window, Vela charts,
draggable and re-arrangeable panels. Open source (AGPL-3.0-or-later). Windows. Testnet by default.

> Status: early but usable on the testnet. Working: tabbed charts, draggable panels, live QFL / drop **signals with thumbnails**,
> manual order entry, right-click orders on the chart, and the **ladder tool** (draw a range, set the number of orders, place them).
> **Pine Script** works per chart tab (146 indicators, `/` quick picker, editor). The **Lab** backtests the QFL ladder as one shared account with the luck test, start dates and stressed costs. Sound alerts, a live user-data stream and the price-band shading are in too.

## Run

Prerequisites: Rust (stable), Node 20+, pnpm 9, WebView2 (included with Windows 11).

```bash
pnpm install
pnpm dev          # opens the Harvester window
pnpm test         # cargo tests + UI tests
pnpm bundle       # release build + Windows installer (NSIS, per-user): target/release/bundle/nsis/Harvester_*_x64-setup.exe
```

API keys are read from a `.env` file in the folder
Harvester is started from (or any parent); an installed copy needs its own `.env` next to `harvester.exe`.

## Removed: the ML trade finder

Harvester briefly had an ML entry finder (38-feature XGBoost models, trade-plan overlay, bracket orders). It was removed on Oct 12 2026 because it lost money on
unseen data: 1,235 plans in the last 30 days averaged -0.52% per trade after fees, and in a shared account with the QFL ladder's sizing it lost 40-54% while the
ladder made money. Using fewer indicators did not help either. The measurements are in `docs/qfl_vs_ml_2026-10-12.txt`; the code is in git history (commit `db3cc7e`).

`HARVESTER_ENV=live` selects the live exchange (default: testnet). Market data needs no API key. To trade, copy `.env.example` to `.env`
and fill in the testnet keys (`BINANCE_TESTNET_API_KEY` / `BINANCE_TESTNET_API_SECRET`). Live trading needs separate `BINANCE_LIVE_*` keys.
A server-side cap (`MAX_ORDER_NOTIONAL`, default 5000 USDT) limits any single order.

## The ladder tool

Press **L**, click where the ladder starts, click where it ends, then set the number of orders with the slider.
Drag either end of the vertical line to adjust. Every order is rounded and validated against the symbol's
exchange limits before anything is sent.

## Pine Script

Every chart tab has a **Pine** button (top left of the chart) and a `/` quick picker (hover the chart and press `/`). The library holds
8 built-in indicators and 138 community scripts from everget's public TradingView collection, ported to Pine v6; each one is run by
`pnpm --dir ui test` so nothing in the list is a placeholder. Write or paste your own in the editor. Scripts are remembered per chart tab.

## QFL bases on the chart

The **Bases** button (top left of every chart, next to Pine) draws the QFL bases of the symbol and timeframe: a bright line running right from
the candle where a base formed, with its crack level dotted below it. The gear opens the settings: **volatility factor** (how big a pump must be
to make a base; higher = fewer, bigger bases), crack %, only bases within N% of the price, at most N nearest bases, how many candles a line runs to the
right (0 = a ray to the edge), **merging** (bases within N% of each other become one thicker line starting at the oldest), and whether broken bases stay on the chart (they do by default: dim, ending at the crack; the distance and count limits only thin out bases that still hold). The settings are shared by every chart. Resting the pointer on a **signal thumbnail** opens a larger chart with the bases
(merged, nearest first) and the signal's own base highlighted. The defaults (factor 3.5,
15% of price, 8 nearest, 30 candles) keep the chart readable; V2 itself trades with factor 1.

## Lab (backtest)

View > Lab. It downloads recent public 15 m candles for the busiest perpetuals (rate limited, cached for 6 hours in the temp folder),
finds every QFL crack that passes the entry filters (market gate, Donchian-low) and runs ONE shared account: a cap on open ladders, a
budget per ladder, mark-to-market drawdown. Next to the headline it prints the numbers that keep it honest: a **luck test** (30 runs with a
random 20% of the setups removed), **eight start dates**, and **stressed costs**. The default settings are the V2 live setting from
MarketScanner. It places no orders. The tested coins are today's most liquid, a hindsight pool, so the result is an upper bound.

## Alerts, price band, live updates

- **Sound alerts** (Signals panel): a two-note chime for new signals, rising for a long, falling for a short; choose the kinds, a minimum score and the volume.
- **Price band**: Binance refuses LIMIT orders more than a few percent from the market. The chart shades that zone and a dragged limit order stops at its edge. Stop and take-profit triggers are not limited.
- **Live updates**: orders, fills and balances arrive through Binance's user-data websocket (header shows "live"); if it drops the app polls every 3 s and shows "polling".

## Layout

```
crates/harvester-core   pure trading logic (decimals, filters, ladders, QFL, signals, Lab simulator, crossover study)
src-tauri               Tauri app: market data feeds, commands
ui                      React + dockview + Vela
```

## Licences

Harvester is AGPL-3.0-or-later. It uses Vela (Apache-2.0, requires the "Charting by Vela" attribution),
PineTS and the Vela PineTS addon (AGPL-3.0), dockview (MIT), Tauri (MIT / Apache-2.0).
Not financial advice: you trade at your own risk.
