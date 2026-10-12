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

## Right-click menu

Right-click on a chart for: buy / sell limit at that price, start a ladder from there, or put the price in the order form. The menu also has a **size slider**: the share of
the account (wallet balance) used as margin, with the margin and the position value in USDT beside it (position = margin x the form's leverage), and a box where you can type the
position value instead. The slider and the Orders panel share one size, so what you set in one shows in the other; it stops at the safety cap on one order (`MAX_ORDER_NOTIONAL`).

## Held orders: limit orders outside Binance's price band

Binance refuses a LIMIT order whose price is too far from the market (the percent-price filter, about 5% either way for most coins). Harvester no longer
refuses it either: the order is **held on this computer** and sent to Binance automatically once the allowed range has moved to its price. It works from the
Orders panel, a right-click on the chart and ladders (rungs inside the range go to Binance at once, the others are held).

- On the chart a held order is a grey dashed line, "HELD BUY LIMIT ... sent when Binance allows it", with a x to cancel it. **Drag it like any other order**; the new
  price is kept on this computer (drag it inside the range and it is sent within a few seconds). The Open orders table lists it as "LIMIT (held here)".
- Held orders are saved in `%APPDATA%\Harvester\held_orders.json`, so they survive a restart, but **they are only sent while Harvester is running**: nothing is resting on
  the exchange. They belong to the environment (testnet / live) they were made in and are never sent to the other one. The size, tick and notional cap are checked
  when the order is held, and an order is only sent when it is comfortably (0.2%) inside the range. At most 60 orders wait at a time.
- Stops, take-profits and market orders are not subject to the band and are never held.

## QFL support zones on the chart

The **Bases** button (top left of every chart, next to Pine) draws the QFL bases of the symbol and timeframe as **zones**. A base is a swing low that
price pumped away from; several bases at nearly the same price are one level that has held more than once, so they are combined into ONE box that
runs from the lowest to the highest of them and starts at the oldest. The box is darker the more bases and **retests** (a candle that dipped into the
zone without cracking it and closed back above it) it has, is labelled like "x3 · 2 retests", and has its crack level dotted just below it. A level
price already cracked starts over: a later base at the same price is a new zone. Zones price already broke stay on the chart as dim boxes that end at
the crack.

The gear opens the settings, shared by every chart: **volatility factor** (how big a pump must be to make a base; higher = fewer, bigger bases),
crack %, **merge bases within N%**, only holding zones within N% of the price, at most N nearest, how many candles a box runs to the right (0 = to the
edge) and whether broken zones stay. The defaults (factor 3.5, merge 0.5%, 15% of price, 8 nearest, 30 candles) keep the chart readable; V2 itself
trades with factor 1. Resting the pointer on a **signal thumbnail** opens a larger chart with the zones and the signal's own base highlighted.

## Smart Money zones on the chart

The **SMC** button (next to Bases) draws fair value gaps, order blocks and breaker blocks, ported from MarketScanner's `smc` module with its rules
unchanged. Green boxes are expected support, red ones expected resistance; a zone shrinks as price taps into it and disappears once it is used up.
The gear chooses the kinds, the smallest gap, how many of each (newest) and how far the boxes run to the right. They are patterns, not signals: whether
they add anything to the QFL ladder is a question for the Lab (see `docs/`).

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
