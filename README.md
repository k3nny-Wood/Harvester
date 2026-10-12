# Harvester

A manual trading terminal with signals for Binance USDⓈ-M futures. Rust core, Tauri window, Vela charts,
draggable and re-arrangeable panels. Open source (AGPL-3.0-or-later). Windows. Testnet by default.

> Status: early but usable on the testnet. Working: tabbed charts, draggable panels, live QFL / drop **signals with thumbnails**,
> manual order entry, right-click orders on the chart, and the **ladder tool** (draw a range, set the number of orders, place them).
> Pine Script, the Lab and the ML finder are on the roadmap (`docs/DESIGN.md`).

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

## Layout

```
crates/harvester-core   pure trading logic (decimals, filters, ladders)
src-tauri               Tauri app: market data feeds, commands
ui                      React + dockview + Vela
```

## Licences

Harvester is AGPL-3.0-or-later. It uses Vela (Apache-2.0, requires the "Charting by Vela" attribution),
PineTS and the Vela PineTS addon (AGPL-3.0), dockview (MIT), Tauri (MIT / Apache-2.0).
Not financial advice: you trade at your own risk.
