# Harvester

A manual trading terminal with signals for Binance USDⓈ-M futures. Rust core, Tauri window, Vela charts,
draggable and re-arrangeable panels. Open source (AGPL-3.0-or-later). Windows. Testnet by default.

> Status: early but usable on the testnet. Working: tabbed charts, draggable panels, live QFL / drop **signals with thumbnails**,
> manual order entry, right-click orders on the chart, and the **ladder tool** (draw a range, set the number of orders, place them).
> **Pine Script** works per chart tab (146 indicators, `/` quick picker, editor). The **ML trade finder** (experimental) turns a signal into a trade plan you can place with its stop-loss and take-profit. The Lab is on the roadmap (`docs/DESIGN.md`).

## Run

Prerequisites: Rust (stable), Node 20+, pnpm 9, WebView2 (included with Windows 11).

```bash
pnpm install
pnpm dev          # opens the Harvester window
pnpm test         # cargo tests + UI tests
```

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

## ML trade finder (experimental)

The Signals panel has **QFL** and **ML** switches. With ML on, each closed 15 m candle of the scanned symbols is scored by the 38-feature
XGBoost models (`models/15m/`, run with ONNX Runtime), then filtered by the RSI reversal rule (long only when RSI <= 40, short when RSI >= 60)
and a minimum confidence. Click an ML card and the chart shows a **trade plan**: entry, stop-loss, take-profit, an arrow from the entry to the
target and a dashed one to the stop. In the plan card you choose a market or limit entry and adjust the stop distance, reward:risk and the
risk in USDT; the size follows. **Place** sends the entry and, once it has filled, a reduce-only stop-loss and take-profit for the position that
exists. A resting limit entry is watched only while Harvester is open. The model's earlier research showed little directional edge once fees
are paid: treat it as a way to find candidates to look at, not a system to follow.

Binance's percent-price band applies to **limit prices only**; stop and take-profit triggers can sit further away.

## Layout

```
crates/harvester-core   pure trading logic (decimals, filters, ladders, QFL, signals, ML features and trade plans)
crates/harvester-ml     ONNX inference (ort) for the 15 m models
models                  the ONNX models and their scalers
src-tauri               Tauri app: market data feeds, commands
ui                      React + dockview + Vela
```

## Licences

Harvester is AGPL-3.0-or-later. It uses Vela (Apache-2.0, requires the "Charting by Vela" attribution),
PineTS and the Vela PineTS addon (AGPL-3.0), dockview (MIT), Tauri (MIT / Apache-2.0).
Not financial advice: you trade at your own risk.
