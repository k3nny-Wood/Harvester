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
position value instead, and a **leverage slider** (1x up to the symbol's maximum; it is applied to the symbol on the exchange when you release it, like the Orders panel's). The sliders and the Orders panel share one size and one leverage, so what you set in one shows in the other; it stops at the safety cap on one order (`MAX_ORDER_NOTIONAL`).

## Selling (or buying back) a share of your holdings

When you hold a position in a symbol, two places let you close a percentage of it with a **reduce-only limit order** on the closing side (sell a long, buy back a short):

- the **right-click menu** has a "Close N% of your long / short" slider (5-100%) showing the quantity and its value, and a "Sell N% of holdings here" / "Buy back N% of holdings here"
  button that places the order at the price you clicked;
- the **Orders panel** has a "% position" size mode (enabled when you hold the symbol): the slider is the share of the position, the side and reduce-only are set for you.

The quantity is rounded DOWN to the exchange's step and 100% is exactly the position, so the exchange never sees more than you hold. A closing order beyond Binance's price band is held on
this computer like any other limit order.

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

## Pump / dump scanner

The Signals panel has a **Movers** source (on by default) that watches every USDT perpetual on one live price stream (mainnet) and reports sudden moves as `PUMP` / `DUMP` entries, with a 1-minute thumbnail, sound alert and click-to-open-chart like any other signal. A move counts when it reaches the window's minimum % (1.5% in 1 min, 3% in 5 min, 5% in 15 min) AND is several times (default 5x) what that coin normally moves in that long; thin coins (< $3M 24h volume) are ignored, and a coin stays quiet for 10 min after a report. All of it is adjustable with the cog next to Movers. It needs about 3 minutes after start to learn each coin's normal movement.

## News panel

The **News** tab (next to Signals; or View > News) follows the coin of the focused chart. It reads Binance's own announcements (listings, delistings, exchange notices) and the Cointelegraph, CoinDesk, Decrypt and The Block feeds, keeps them for 5 minutes, and shows what is about that coin, newest first. Click an item to open it in the browser. A headline counts as being about a coin when it has the cashtag, the ticker in brackets, the pair, the coin's full name (from CoinGecko's top 1000, cached for a week) or, for a ticker of four letters or more, the ticker in capitals; a short ticker such as `ON` or `S` is also an ordinary word, so it needs one of the stronger forms. Binance's general notices (futures changes, delistings of other coins) are listed underneath. **X ↗** opens the coin's cashtag search on X in the browser: reading tweets through their API is a paid service, so Harvester links to them instead. A free CryptoPanic key (`CRYPTOPANIC_API_KEY` in `.env`) adds their per-coin feed; that part could not be tested without a key.

### Delisting warnings

Harvester reads Binance's futures `exchangeInfo` every 10 minutes: a perpetual with a real settlement date (instead of the 2100 placeholder) has been scheduled for delisting, and the date is the exchange's own. The spot "Binance Will Delist ..." announcements add an earlier, milder warning for coins that have a futures contract. A scheduled contract gets a red banner on its chart, a note in the order form, the F/D setup and the News panel, and a ⚠ beside its name in the Symbols list and the position and order tables; a message appears once when you hold a position or open orders in it. Quarterly futures (which always have a delivery date) are ignored.

## AI Analyst (branch AI_Analyst)

The **AI Analyst** tab (View > AI Analyst) asks Claude for an analysis of the chart in focus. It sends one request with: the candles and computed indicators (EMA 20/50/200, RSI, MACD, ATR, Bollinger, swing highs and lows, volume profile) on the chart's timeframe and on 1h, 4h and 1d, the QFL base zones and SMC zones, the latest news and any delisting warning for the coin, your position, stop-loss, take-profit and open orders, and (optionally) a picture of the chart. The answer is a strict JSON document: a bias with a confidence (50 = no edge), key levels, scenarios with their invalidation, reasons, risks and a comment on your position. Pick Haiku 5.5 (cheaper, faster) or Sonnet 5.5; the token counts of each call are shown. The key is `ANTHROPIC_API_KEY` in `.env`; it stays in the Rust side and is never sent to the page. Everything sent is what the request shows: candles, indicators, news, your position and the picture, nothing else.

"On chart" draws its key levels as dotted lines and a small arrow for its bias, labelled "AI opinion". Every analysis is saved (`%APPDATA%\Harvester\ai_log.json`), and the **Track record** tab scores each directional call against the real price 4, 12 and 24 hours later and sets the hit rate next to how often price simply rose in the same periods. Language models cannot reliably predict price: treat the call as an opinion until the track record, over dozens of analyses, says otherwise.

## Telegram bot

Put `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in the `.env` file (a bot from @BotFather; the chat id is your own chat with it) and restart. Harvester then sends a **summary every 30 minutes** (equity and change, positions with entry / stop / target / liquidation, a warning for any position without a stop-loss, open orders, the scanner's best entries) and answers commands:

| Command | Does |
|---|---|
| `/status` | the summary now |
| `/positions`, `/orders` | open positions and orders |
| `/signals` | the scanner's best entries |
| `/chart SYMBOL [timeframe]` | a chart picture, e.g. `/chart BTC 1h`, with your position's entry, stop, target, liquidation and open orders drawn on it |
| `/charts` | a picture of every open position (up to 6, worst first) |

The bot only reads: it cannot place, change or cancel an order. Only your chat is answered, commands older than two minutes are ignored, and the bot token is never logged. Use a bot of its own: two programs polling one bot (for example the MarketScanner V2 bot) would fight over its messages.
