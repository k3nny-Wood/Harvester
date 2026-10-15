//! Harvester's Telegram bot (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID in the .env file): a summary of the account every 30 minutes, and
//! commands to ask for it, the positions, the orders, the scanner and chart pictures, and a few commands that trade, plus alerts.
//!
//! Commands that trade: `/close SYMBOL` (reduce-only: it can never open or flip a position), `/stop` and `/tp` (a reduce-only exit for the whole
//! position, refused on the wrong side of the price), and `/long` / `/short`, which only PREPARE an order: it is sent by `/confirm` within a minute,
//! and never for a symbol that already has a position.
//!  * only messages from TELEGRAM_CHAT_ID are answered; everything else is ignored without a reply;
//!  * messages that were waiting when Harvester started, and messages older than 2 minutes, are never acted on;
//!  * the token is only used in requests to api.telegram.org and never written to a log.

use crate::cardimg::{self, Block};
use crate::chartimg::{self, ChartData, Line};
use crate::market::Market;
use crate::scanner::SignalReader;
use crate::news::NewsHub;
use crate::trading::{Account, OpenOrder, OrderRequest, OrderType, Side, Trading};
use crate::health::Health;
use harvester_core::alerts::{self, AlertState, ExitKind, Level, Trouble};
use harvester_core::report::{self, Command, OrderRow, PositionRow, Summary};
use rust_decimal::prelude::ToPrimitive;
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Instant;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

const MAX_AGE_SECS: i64 = 120;
const REPORT_EVERY: Duration = Duration::from_secs(30 * 60);
const FIRST_REPORT_AFTER: Duration = Duration::from_secs(60);
const DEFAULT_TIMEFRAME: &str = "15m";
const CONFIRM_WITHIN: Duration = Duration::from_secs(60);
const WATCH_EVERY: Duration = Duration::from_secs(20);
/// a scanner entry must score this much (or more) to be sent as an alert; TELEGRAM_SIGNAL_MIN_SCORE changes it, 0 turns these alerts off
const DEFAULT_SIGNAL_SCORE: u8 = 85;

/// A /long or /short waiting for its /confirm.
struct Pending {
    symbol: String,
    long: bool,
    qty: f64,
    expires: Instant,
}

struct Bot {
    http: reqwest::Client,
    token: String,
    chat: String,
    trading: Arc<Trading>,
    market: Arc<Market>,
    signals: SignalReader,
    pending: Mutex<Option<Pending>>,
    health: Arc<Health>,
}

fn env_label(t: &Trading) -> &'static str {
    match t.env() {
        crate::market::Env::Live => "LIVE",
        crate::market::Env::Testnet => "testnet",
    }
}

fn position_rows(acc: &Account, orders: &[OrderRow]) -> Vec<PositionRow> {
    acc.positions
        .iter()
        .filter(|p| p.amount != 0.0)
        .map(|p| {
            let (stop, take) = report::exits_of(orders, &p.symbol, p.amount > 0.0);
            PositionRow {
                symbol: p.symbol.clone(),
                amount: p.amount,
                entry: p.entry_price,
                mark: p.mark_price,
                upnl: p.unrealized_pnl,
                leverage: if p.leverage > 0.0 { p.leverage } else { acc.leverages.get(&p.symbol).copied().unwrap_or(1.0) },
                isolated: p.isolated,
                liquidation: p.liquidation_price,
                stop,
                take,
            }
        })
        .collect()
}

fn order_rows(orders: &[OpenOrder]) -> Vec<OrderRow> {
    orders
        .iter()
        .map(|o| OrderRow { symbol: o.symbol.clone(), side: o.side.clone(), kind: o.order_type.clone(), price: o.price, stop_price: o.stop_price, qty: o.orig_qty, reduce_only: o.reduce_only })
        .collect()
}

impl Bot {
    async fn call(&self, method: &str, body: Value) -> Result<Value, String> {
        let r = self.http.post(format!("https://api.telegram.org/bot{}/{method}", self.token)).json(&body).send().await.map_err(|e| scrub(&e.to_string(), &self.token))?;
        let v: Value = r.json().await.map_err(|e| scrub(&e.to_string(), &self.token))?;
        if v["ok"].as_bool().unwrap_or(false) {
            Ok(v["result"].clone())
        } else {
            Err(v["description"].as_str().unwrap_or("telegram error").to_string())
        }
    }

    async fn say(&self, text: &str) {
        if text.is_empty() {
            return;
        }
        // Telegram allows 4096 characters: split on line breaks below that
        let mut chunk = String::new();
        let mut chunks = Vec::new();
        for line in text.lines() {
            if chunk.len() + line.len() + 1 > 3800 {
                chunks.push(std::mem::take(&mut chunk));
            }
            chunk.push_str(line);
            chunk.push('\n');
        }
        chunks.push(chunk);
        for c in chunks {
            if let Err(e) = self.call("sendMessage", json!({"chat_id": self.chat, "text": c, "parse_mode": "HTML", "disable_web_page_preview": true})).await {
                crate::health::log(&format!("[telegram] sending failed: {e}"));
            }
        }
    }

    /// Send a PNG as a photo (the multipart body is built by hand so no extra reqwest feature is needed).
    async fn photo(&self, png: Vec<u8>, caption: &str) -> Result<(), String> {
        let b = "----harvesterchartboundary7MA4YWxkTrZu0gW";
        let mut body: Vec<u8> = Vec::new();
        let caption: String = caption.chars().take(1000).collect();
        for (name, val) in [("chat_id", self.chat.as_str()), ("caption", caption.as_str()), ("parse_mode", "HTML")] {
            body.extend(format!("--{b}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{val}\r\n").as_bytes());
        }
        body.extend(format!("--{b}\r\nContent-Disposition: form-data; name=\"photo\"; filename=\"chart.png\"\r\nContent-Type: image/png\r\n\r\n").as_bytes());
        body.extend(png);
        body.extend(format!("\r\n--{b}--\r\n").as_bytes());
        let r = self
            .http
            .post(format!("https://api.telegram.org/bot{}/sendPhoto", self.token))
            .header("Content-Type", format!("multipart/form-data; boundary={b}"))
            .body(body)
            .send()
            .await
            .map_err(|e| scrub(&e.to_string(), &self.token))?;
        let v: Value = r.json().await.map_err(|e| e.to_string())?;
        if v["ok"].as_bool().unwrap_or(false) {
            Ok(())
        } else {
            Err(v["description"].as_str().unwrap_or("telegram error").to_string())
        }
    }

    /// The account and its open orders, or why they could not be read.
    async fn snapshot(&self) -> Result<(Account, Vec<OrderRow>), String> {
        if !self.trading.status().has_credentials {
            return Err("No Binance API keys are set for this environment, so there is no account to report.".into());
        }
        let acc = self.trading.account().await?;
        let orders = order_rows(&self.trading.open_orders(None).await?);
        Ok((acc, orders))
    }

    fn top_signals(&self) -> Vec<(String, String, u8)> {
        self.signals.signals().into_iter().filter(|s| matches!(s.kind, harvester_core::signals::SignalKind::Crack | harvester_core::signals::SignalKind::Near | harvester_core::signals::SignalKind::Drop)).take(5).map(|s| (s.symbol, format!("{:?}", s.kind).to_lowercase(), s.score)).collect()
    }

    /// The summary as a picture's blocks, the same as text for when a picture cannot be sent, and the equity.
    async fn summary(&self, session_start: Option<f64>, previous: Option<f64>, all: bool) -> Result<(Vec<Block>, String, f64), String> {
        let (acc, orders) = self.snapshot().await?;
        let rows = position_rows(&acc, &orders);
        let equity = acc.wallet_balance + acc.unrealized_pnl;
        let signals = self.top_signals();
        let time = chrono_free_time();
        let summary = Summary {
            env: env_label(&self.trading),
            time: &time,
            wallet: acc.wallet_balance,
            available: acc.available_balance,
            upnl: acc.unrealized_pnl,
            session_start,
            previous,
            positions: &rows,
            open_orders: orders.len(),
            signals: &signals,
        };
        Ok((cardimg::summary_card(&summary, all), report::format_summary(&summary), equity))
    }

    /// Send a card as a picture (a phone scrambles aligned text); if that fails the plain text goes instead.
    async fn card(&self, blocks: Vec<Block>, fallback: &str, caption: &str) {
        match tokio::task::spawn_blocking(move || cardimg::render(&blocks)).await {
            Ok(Ok(png)) => match self.photo(png, caption).await {
                Ok(()) => return,
                Err(e) => eprintln!("[telegram] sending the picture failed: {e}"),
            },
            Ok(Err(e)) => eprintln!("[telegram] drawing the picture failed: {e}"),
            Err(e) => eprintln!("[telegram] drawing the picture failed: {e}"),
        }
        self.say(fallback).await;
    }

    async fn chart(&self, symbol: &str, timeframe: &str) {
        // the position and orders are optional context: a chart is still drawn without keys
        let (rows, orders) = match self.snapshot().await {
            Ok((acc, orders)) => (position_rows(&acc, &orders), orders),
            Err(_) => (vec![], vec![]),
        };
        let candles = match self.market.klines(symbol, timeframe, 200, None, None).await {
            Ok(k) if k.len() >= 3 => k,
            Ok(_) => {
                self.say(&format!("Not enough candles for {}.", report::esc(symbol))).await;
                return;
            }
            Err(e) => {
                self.say(&format!("Could not load {} {}: {}", report::esc(symbol), timeframe, report::esc(&e))).await;
                return;
            }
        };
        let pos = rows.iter().find(|p| p.symbol == symbol);
        let mut lines: Vec<Line> = Vec::new();
        if let Some(p) = pos {
            lines.push(Line { price: p.entry, label: "entry".into(), color: (230, 233, 239), dashed: false });
            if let Some(s) = p.stop {
                lines.push(Line { price: s, label: "stop-loss".into(), color: (239, 83, 80), dashed: true });
            }
            if let Some(t) = p.take {
                lines.push(Line { price: t, label: "take-profit".into(), color: (74, 222, 128), dashed: true });
            }
            if p.liquidation > 0.0 {
                lines.push(Line { price: p.liquidation, label: "liquidation".into(), color: (240, 160, 40), dashed: true });
            }
        }
        let is_exit = |o: &OrderRow| pos.map_or(false, |p| o.reduce_only && o.side == if p.amount > 0.0 { "SELL" } else { "BUY" });
        for o in orders.iter().filter(|o| o.symbol == symbol && !is_exit(o)) {
            let level = if o.stop_price > 0.0 && o.price == 0.0 { o.stop_price } else { o.price };
            lines.push(Line { price: level, label: format!("{} {}", o.side.to_lowercase(), o.kind.replace('_', " ").to_lowercase()), color: (91, 141, 239), dashed: true });
        }
        let title = match pos {
            Some(p) => format!("{symbol} {timeframe}  {} {}  {}", if p.amount > 0.0 { "LONG" } else { "SHORT" }, p.leverage, report::signed(p.upnl)),
            None => format!("{symbol} {timeframe}"),
        };
        let data = ChartData { title, candles: candles.iter().map(|k| [k.time as f64, k.open, k.high, k.low, k.close]).collect(), lines };
        let png = match tokio::task::spawn_blocking(move || chartimg::render(&data, 1000, 560)).await {
            Ok(Ok(png)) => png,
            Ok(Err(e)) => {
                self.say(&format!("Could not draw {}: {}", report::esc(symbol), report::esc(&e))).await;
                return;
            }
            Err(e) => {
                self.say(&format!("Could not draw {}: {e}", report::esc(symbol))).await;
                return;
            }
        };
        let caption = match pos {
            Some(p) => format!("<b>{}</b> {timeframe} · {} {}x · {} ({:+.1}%)\nentry {} · now {}", report::esc(symbol), if p.amount > 0.0 { "LONG" } else { "SHORT" }, p.leverage, report::signed(p.upnl), p.roe_pct(), report::price(p.entry), report::price(p.mark)),
            None => format!("<b>{}</b> {timeframe}", report::esc(symbol)),
        };
        if let Err(e) = self.photo(png, &caption).await {
            self.say(&format!("Could not send the chart: {}", report::esc(&e))).await;
        }
    }

    /// Set the stop-loss or take-profit of a position: moved when there is one, placed (for the whole position) when there is not.
    async fn set_exit(&self, kind: ExitKind, symbol: &str, level: Level) {
        let name = if kind == ExitKind::Stop { "Stop-loss" } else { "Take-profit" };
        let acc = match self.trading.account().await {
            Ok(a) => a,
            Err(e) => return self.say(&report::esc(&e)).await,
        };
        let Some(p) = acc.positions.iter().find(|p| p.symbol == symbol && p.amount != 0.0) else {
            return self.say(&format!("No open position in {}.", report::esc(symbol))).await;
        };
        let long = p.amount > 0.0;
        let target = match alerts::resolve_exit(kind, long, p.mark_price, level) {
            Ok(t) => t,
            Err(e) => return self.say(&report::esc(&e)).await,
        };
        let open = match self.trading.open_orders(Some(symbol)).await {
            Ok(o) => o,
            Err(e) => return self.say(&report::esc(&e)).await,
        };
        let exit_side = if long { "SELL" } else { "BUY" };
        let wanted = if kind == ExitKind::Stop { "STOP" } else { "TAKE_PROFIT" };
        let existing = open.iter().find(|o| o.reduce_only && o.side == exit_side && (o.order_type.starts_with(wanted) || (kind == ExitKind::Take && o.order_type == "LIMIT")));
        let result = match existing {
            Some(o) if o.order_type == "LIMIT" => self.trading.modify(symbol, o.order_id, false, Some(target), None, None).await.map(|_| format!("moved from {}", report::price(o.price))),
            Some(o) => self.trading.modify(symbol, o.order_id, o.conditional, None, Some(target), None).await.map(|_| format!("moved from {}", report::price(o.stop_price))),
            None => {
                let req = OrderRequest {
                    symbol: symbol.to_string(),
                    side: if long { Side::Sell } else { Side::Buy },
                    order_type: if kind == ExitKind::Stop { OrderType::StopMarket } else { OrderType::TakeProfitMarket },
                    quantity: p.amount.abs(),
                    price: None,
                    stop_price: Some(target),
                    post_only: false,
                    reduce_only: true,
                    client_id: None,
                };
                self.trading.place(req).await.map(|_| "placed for the whole position".to_string())
            }
        };
        match result {
            Ok(how) => self.say(&format!("<b>{name}</b> for {} {}: {how}, now {} (price {})", report::esc(symbol), if long { "LONG" } else { "SHORT" }, report::price(target), report::price(p.mark_price))).await,
            Err(e) => self.say(&format!("Could not set the {} for {}: {}", name.to_lowercase(), report::esc(symbol), report::esc(&e))).await,
        }
    }

    /// Prepare a market order for /long or /short and ask for /confirm. Nothing is sent yet.
    async fn prepare_open(&self, long: bool, symbol: &str, margin: f64) {
        let acc = match self.trading.account().await {
            Ok(a) => a,
            Err(e) => return self.say(&report::esc(&e)).await,
        };
        if acc.positions.iter().any(|p| p.symbol == symbol && p.amount != 0.0) {
            return self.say(&format!("{} already has a position. /long and /short only open a new one: use the app to add to it, or /close it.", report::esc(symbol))).await;
        }
        if margin > acc.available_balance {
            return self.say(&format!("Not enough available balance: {} wanted, {} available.", report::money(margin), report::money(acc.available_balance))).await;
        }
        let prepared = async {
            let lev = self.trading.leverage(symbol).await?.leverage.max(1) as f64;
            let mark = self.market.mark_price(symbol).await?;
            let filters = self.market.symbol_filters(symbol).await?;
            let qty = filters.round_quantity(margin * lev / mark).to_f64().unwrap_or(0.0);
            if qty <= 0.0 {
                return Err("That margin is too small for one contract of this symbol.".to_string());
            }
            Ok((lev, mark, qty))
        }
        .await;
        let (lev, mark, qty) = match prepared {
            Ok(x) => x,
            Err(e) => return self.say(&format!("Could not prepare {}: {}", report::esc(symbol), report::esc(&e))).await,
        };
        *self.pending.lock().unwrap() = Some(Pending { symbol: symbol.to_string(), long, qty, expires: Instant::now() + CONFIRM_WITHIN });
        self.say(&format!(
            "<b>{} {}</b>: {} {} at market (about {}), {}x, margin {} for a position of about {}.\nNo stop-loss is set by this: add one with /stop {} 2%.\nSend <b>/confirm</b> within 60 seconds, or /cancel.",
            if long { "LONG" } else { "SHORT" }, report::esc(symbol), qty, report::esc(symbol.strip_suffix("USDT").unwrap_or(symbol)), report::price(mark), lev, report::money(margin), report::money(qty * mark), report::esc(symbol.strip_suffix("USDT").unwrap_or(symbol)),
        ))
        .await;
    }

    async fn confirm_open(&self) {
        let pending = self.pending.lock().unwrap().take();
        let Some(p) = pending.filter(|p| p.expires > Instant::now()) else {
            return self.say("Nothing is waiting for confirmation (or it timed out). Send /long or /short again.").await;
        };
        let req = OrderRequest { symbol: p.symbol.clone(), side: if p.long { Side::Buy } else { Side::Sell }, order_type: OrderType::Market, quantity: p.qty, price: None, stop_price: None, post_only: false, reduce_only: false, client_id: None };
        match self.trading.place(req).await {
            Ok(ack) => self.say(&format!("<b>Sent</b>: {} {} {} at market ({}). Set a stop with /stop {} 2%.", if p.long { "LONG" } else { "SHORT" }, ack.quantity, report::esc(&p.symbol), report::esc(&ack.status.to_lowercase()), report::esc(p.symbol.strip_suffix("USDT").unwrap_or(&p.symbol)))).await,
            Err(e) => self.say(&format!("Could not open {}: {}", report::esc(&p.symbol), report::esc(&e))).await,
        }
    }

    async fn health_text(&self) -> String {
        let st = self.signals.status();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let log_file = crate::health::log_path().display().to_string();
        let scanner = report::ScannerView {
            phase: &st.phase,
            symbols: st.symbols,
            seeded: st.seeded,
            signals: st.crack_count + st.near_count + st.drop_count + st.pump_count + st.dump_count,
            updated_ago: (st.last_update_ms > 0).then(|| now.saturating_sub(st.last_update_ms) / 1000),
            error: st.error.as_deref(),
        };
        report::format_health(&report::HealthView {
            program: self.health.program,
            env: env_label(&self.trading),
            uptime_secs: self.health.uptime_secs(),
            has_keys: self.trading.status().has_credentials,
            account_ok_ago: self.health.account_ok_ago(),
            last_error: self.health.last_error(),
            scanner: Some(scanner),
            log_file: &log_file,
        })
    }

    async fn handle(&self, text: &str) {
        match report::parse_command(text) {
            Command::NotACommand => {}
            Command::Help => self.say(report::HELP).await,
            Command::Usage(u) => self.say(u).await,
            Command::Unknown(name) => self.say(&format!("Unknown command /{}. Send /help for the list.", report::esc(&name))).await,
            Command::Status => match self.summary(None, None, false).await {
                Ok((blocks, text, _)) => self.card(blocks, &text, "Harvester status").await,
                Err(e) => self.say(&report::esc(&e)).await,
            },
            Command::Positions => match self.summary(None, None, true).await {
                Ok((blocks, _, _)) => {
                    let (acc, orders) = match self.snapshot().await {
                        Ok(x) => x,
                        Err(e) => return self.say(&report::esc(&e)).await,
                    };
                    self.card(blocks, &report::format_positions(&position_rows(&acc, &orders)), "Harvester positions").await
                }
                Err(e) => self.say(&report::esc(&e)).await,
            },
            Command::Orders => match self.snapshot().await {
                Ok((_, orders)) => self.card(cardimg::orders_card(env_label(&self.trading), &chrono_free_time(), &orders), &report::format_orders(&orders), "Open orders").await,
                Err(e) => self.say(&report::esc(&e)).await,
            },
            Command::Signals => {
                let s = self.top_signals();
                if s.is_empty() {
                    self.say("The scanner shows no entries right now.").await;
                } else {
                    let lines: Vec<String> = s.iter().map(|(sym, kind, score)| format!("{} · {} · score {}", report::esc(sym), report::esc(kind), score)).collect();
                    self.say(&format!("<b>Scanner</b>\n{}", lines.join("\n"))).await;
                }
            }
            Command::Chart { symbol, timeframe } => self.chart(&symbol, timeframe.as_deref().unwrap_or(DEFAULT_TIMEFRAME)).await,
            Command::Close(symbol) => {
                let (acc, _) = match self.snapshot().await {
                    Ok(x) => x,
                    Err(e) => return self.say(&report::esc(&e)).await,
                };
                let Some(p) = acc.positions.iter().find(|p| p.symbol == symbol && p.amount != 0.0) else {
                    return self.say(&format!("No open position in {}. Nothing was closed.", report::esc(&symbol))).await;
                };
                let (side, size, upnl) = (if p.amount > 0.0 { "LONG" } else { "SHORT" }, p.amount.abs(), p.unrealized_pnl);
                match self.trading.close_position(&symbol, 1.0).await {
                    Ok(ack) => self.say(&format!("<b>Closing {}</b> {side} {size}: market order {} ({} now {})", report::esc(&symbol), report::esc(&ack.status.to_lowercase()), if upnl < 0.0 { "loss" } else { "profit" }, report::signed(upnl))).await,
                    Err(e) => self.say(&format!("Could not close {}: {}", report::esc(&symbol), report::esc(&e))).await,
                }
            }
            Command::Exit { kind, symbol, level } => self.set_exit(kind, &symbol, level).await,
            Command::Open { long, symbol, margin } => self.prepare_open(long, &symbol, margin).await,
            Command::Confirm => self.confirm_open().await,
            Command::Health => {
                let t = self.health_text().await;
                self.say(&t).await
            }
            Command::Cancel => {
                let had = self.pending.lock().unwrap().take().is_some();
                self.say(if had { "Cancelled: nothing was sent." } else { "Nothing was waiting." }).await
            }
            Command::Charts => match self.snapshot().await {
                Ok((acc, orders)) => {
                    let mut rows = position_rows(&acc, &orders);
                    if rows.is_empty() {
                        self.say("No open positions to chart.").await;
                        return;
                    }
                    rows.sort_by(|a, b| a.upnl.partial_cmp(&b.upnl).unwrap_or(std::cmp::Ordering::Equal));
                    for p in rows.iter().take(6) {
                        self.chart(&p.symbol, DEFAULT_TIMEFRAME).await;
                        tokio::time::sleep(Duration::from_millis(400)).await;
                    }
                }
                Err(e) => self.say(&report::esc(&e)).await,
            },
        }
    }
}

/// Replace the bot token in an error text: reqwest errors can contain the request URL.
fn scrub(text: &str, token: &str) -> String {
    if token.is_empty() {
        text.to_string()
    } else {
        text.replace(token, "<token>")
    }
}

/// "14:30 UTC" without pulling in a date library.
fn chrono_free_time() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("{:02}:{:02} UTC", (secs / 3600) % 24, (secs / 60) % 60)
}

/// Start the bot if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set.
pub fn start(trading: Arc<Trading>, market: Arc<Market>, signals: SignalReader, news: Arc<NewsHub>, program: &'static str) {
    let token = std::env::var("TELEGRAM_BOT_TOKEN").unwrap_or_default().trim().to_string();
    let chat = std::env::var("TELEGRAM_CHAT_ID").unwrap_or_default().trim().to_string();
    if token.is_empty() || chat.is_empty() {
        crate::health::log(&format!("[telegram] disabled: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the .env file"));
        return;
    }
    // two programs must not poll one bot: HARVESTER_TELEGRAM=off keeps this one out of it (for example while the headless server runs)
    if matches!(std::env::var("HARVESTER_TELEGRAM").unwrap_or_default().trim().to_lowercase().as_str(), "off" | "0" | "false" | "no") {
        crate::health::log(&format!("[telegram] switched off by HARVESTER_TELEGRAM"));
        return;
    }
    let bot = Arc::new(Bot { http: reqwest::Client::builder().timeout(Duration::from_secs(45)).build().unwrap_or_default(), token, chat, trading, market, signals, pending: Mutex::new(None), health: Health::new(program) });

    // the summary: one a minute after start, then every 30 minutes
    let reporter = bot.clone();
    crate::rt::spawn(async move {
        reporter.say(&format!("<b>Harvester started</b> ({}) · {}\nSummary every 30 minutes. /health shows how it is doing, /help lists the commands.", reporter.health.program, env_label(&reporter.trading))).await;
        tokio::time::sleep(FIRST_REPORT_AFTER).await;
        let (mut session_start, mut previous) = (None, None);
        loop {
            match reporter.summary(session_start, previous, false).await {
                Ok((blocks, text, equity)) => {
                    reporter.card(blocks, &text, "Harvester summary").await;
                    session_start.get_or_insert(equity);
                    previous = Some(equity);
                }
                Err(e) => eprintln!("[telegram] summary skipped: {e}"),
            }
            tokio::time::sleep(REPORT_EVERY).await;
        }
    });

    // alerts: the account is looked at every 20 seconds and compared with the last look
    let watcher = bot.clone();
    crate::rt::spawn(async move {
        let min_score: u8 = std::env::var("TELEGRAM_SIGNAL_MIN_SCORE").ok().and_then(|v| v.trim().parse().ok()).unwrap_or(DEFAULT_SIGNAL_SCORE);
        let mut state = AlertState::default();
        let (mut seen_signals, mut told_delistings): (HashSet<String>, HashSet<String>) = (HashSet::new(), HashSet::new());
        let mut seeded = false;
        let mut round: u32 = 0;
        // the account must fail for 2 minutes (6 looks) and the scanner for 5 (15 looks) before they are reported
        let (mut account_trouble, mut scanner_trouble) = (Trouble::new(6), Trouble::new(15));
        tokio::time::sleep(Duration::from_secs(15)).await;
        loop {
            round = round.wrapping_add(1);
            let mut held: Vec<PositionRow> = Vec::new();
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            if watcher.trading.status().has_credentials {
                match watcher.snapshot().await {
                    Ok((acc, orders)) => {
                        watcher.health.record_ok();
                        if let Some(n) = account_trouble.record(Ok(()), now) {
                            crate::health::log("[telegram] the account can be read again");
                            watcher.say(&alerts::format_notice("Binance account", &n)).await;
                        }
                        held = position_rows(&acc, &orders);
                        for e in state.update(&held) {
                            watcher.say(&alerts::format_event(&e)).await;
                        }
                    }
                    Err(e) => {
                        watcher.health.record_error(&e);
                        if let Some(n) = account_trouble.record(Err(&e), now) {
                            crate::health::log(&format!("[telegram] account trouble: {e}"));
                            watcher.say(&alerts::format_notice("Binance account", &n)).await;
                        }
                    }
                }
            }
            // the scanner: an error it reports, or no update for 5 minutes
            let st = watcher.signals.status();
            let scanner_problem = match (&st.error, st.last_update_ms) {
                (Some(e), _) => Some(e.clone()),
                (None, t) if t > 0 && now.saturating_sub(t) > 300_000 => Some(format!("no update for {} min", now.saturating_sub(t) / 60_000)),
                _ => None,
            };
            if let Some(n) = scanner_trouble.record(scanner_problem.as_deref().map_or(Ok(()), Err), now) {
                crate::health::log(&format!("[telegram] scanner notice: {n:?}"));
                watcher.say(&alerts::format_notice("Scanner", &n)).await;
            }
            // a delisting of a coin that is held, told once (checked about every 4 minutes)
            if round % 12 == 1 && !held.is_empty() {
                for d in news.delistings(false).await {
                    let Some(p) = held.iter().find(|p| p.symbol == d.symbol) else { continue };
                    if told_delistings.insert(format!("{}-{}", d.symbol, d.date_ms)) {
                        watcher.say(&format!("⚠️ <b>{} is being delisted</b> on {}. You hold a {} position.\n{}", report::esc(p.symbol.strip_suffix("USDT").unwrap_or(&p.symbol)), alerts::ymd(d.date_ms), if p.amount > 0.0 { "LONG" } else { "SHORT" }, report::esc(&d.title))).await;
                    }
                }
            }
            // a very strong scanner entry, told once; what is there at start-up is not announced
            if min_score > 0 {
                let strong: Vec<_> = watcher.signals.signals().into_iter().filter(|s| matches!(s.kind, harvester_core::signals::SignalKind::Crack | harvester_core::signals::SignalKind::Drop) && s.score >= min_score).collect();
                if seeded {
                    for s in strong.iter().filter(|s| !seen_signals.contains(&s.id)).take(3) {
                        watcher.say(&format!("<b>Scanner</b>: {} {} score {} at {}", report::esc(s.symbol.strip_suffix("USDT").unwrap_or(&s.symbol)), format!("{:?}", s.kind).to_lowercase(), s.score, report::price(s.price))).await;
                    }
                }
                seen_signals.extend(strong.into_iter().map(|s| s.id));
                seeded = true;
            }
            tokio::time::sleep(WATCH_EVERY).await;
        }
    });

    // the commands
    crate::rt::spawn(async move {
        // whatever was waiting before this start is NOT acted on: skip to the newest update
        let mut offset: i64 = 0;
        if let Ok(v) = bot.call("getUpdates", json!({"offset": -1, "timeout": 0})).await {
            if let Some(last) = v.as_array().and_then(|a| a.last()).and_then(|u| u["update_id"].as_i64()) {
                offset = last + 1;
            }
        }
        crate::health::log(&format!("[telegram] enabled (summary every 30 min, /help for the commands)"));
        loop {
            let updates = match bot.call("getUpdates", json!({"offset": offset, "timeout": 25, "allowed_updates": ["message"]})).await {
                Ok(v) => v.as_array().cloned().unwrap_or_default(),
                Err(e) => {
                    crate::health::log(&format!("[telegram] polling failed: {e}"));
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
            };
            for u in updates {
                offset = offset.max(u["update_id"].as_i64().unwrap_or(0) + 1);
                let m = &u["message"];
                let from = m["chat"]["id"].as_i64().map(|i| i.to_string()).unwrap_or_default();
                if from != bot.chat {
                    continue; // not our chat: no reply
                }
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
                if now - m["date"].as_i64().unwrap_or(0) > MAX_AGE_SECS {
                    continue; // too old to act on
                }
                if let Some(text) = m["text"].as_str() {
                    bot.handle(text).await;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_token_never_appears_in_an_error_text() {
        assert_eq!(scrub("error sending request for url (https://api.telegram.org/bot123:ABC/getUpdates)", "123:ABC"), "error sending request for url (https://api.telegram.org/bot<token>/getUpdates)");
        assert_eq!(scrub("x", ""), "x");
    }

    #[test]
    fn the_clock_text_is_hh_mm_utc() {
        let t = chrono_free_time();
        assert_eq!(t.len(), 9, "{t}");
        assert!(t.ends_with(" UTC") && t.as_bytes()[2] == b':', "{t}");
    }
}
