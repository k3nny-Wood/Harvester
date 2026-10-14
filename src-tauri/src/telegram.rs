//! Harvester's Telegram bot (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID in the .env file): a summary of the account every 30 minutes, and
//! commands to ask for it, the positions, the orders, the scanner and chart pictures.
//!
//! Safety: the bot only READS. It cannot place, change or cancel an order.
//!  * only messages from TELEGRAM_CHAT_ID are answered; everything else is ignored without a reply;
//!  * messages that were waiting when Harvester started, and messages older than 2 minutes, are never acted on;
//!  * the token is only used in requests to api.telegram.org and never written to a log.

use crate::chartimg::{self, ChartData, Line};
use crate::market::Market;
use crate::scanner::SignalReader;
use crate::trading::{Account, OpenOrder, Trading};
use harvester_core::report::{self, Command, OrderRow, PositionRow, Summary};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

const MAX_AGE_SECS: i64 = 120;
const REPORT_EVERY: Duration = Duration::from_secs(30 * 60);
const FIRST_REPORT_AFTER: Duration = Duration::from_secs(60);
const DEFAULT_TIMEFRAME: &str = "15m";

struct Bot {
    http: reqwest::Client,
    token: String,
    chat: String,
    trading: Arc<Trading>,
    market: Arc<Market>,
    signals: SignalReader,
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
                eprintln!("[telegram] sending failed: {e}");
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

    async fn summary_text(&self, session_start: Option<f64>, previous: Option<f64>) -> Result<(String, f64), String> {
        let (acc, orders) = self.snapshot().await?;
        let rows = position_rows(&acc, &orders);
        let equity = acc.wallet_balance + acc.unrealized_pnl;
        let signals = self.top_signals();
        let time = chrono_free_time();
        let text = report::format_summary(&Summary {
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
        });
        Ok((text, equity))
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

    async fn handle(&self, text: &str) {
        match report::parse_command(text) {
            Command::NotACommand => {}
            Command::Help => self.say(report::HELP).await,
            Command::Usage(u) => self.say(u).await,
            Command::Unknown(name) => self.say(&format!("Unknown command /{}. Send /help for the list.", report::esc(&name))).await,
            Command::Status => match self.summary_text(None, None).await {
                Ok((t, _)) => self.say(&t).await,
                Err(e) => self.say(&report::esc(&e)).await,
            },
            Command::Positions => match self.snapshot().await {
                Ok((acc, orders)) => self.say(&report::format_positions(&position_rows(&acc, &orders))).await,
                Err(e) => self.say(&report::esc(&e)).await,
            },
            Command::Orders => match self.snapshot().await {
                Ok((_, orders)) => self.say(&report::format_orders(&orders)).await,
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
pub fn start(trading: Arc<Trading>, market: Arc<Market>, signals: SignalReader) {
    let token = std::env::var("TELEGRAM_BOT_TOKEN").unwrap_or_default().trim().to_string();
    let chat = std::env::var("TELEGRAM_CHAT_ID").unwrap_or_default().trim().to_string();
    if token.is_empty() || chat.is_empty() {
        println!("[telegram] disabled: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the .env file");
        return;
    }
    let bot = Arc::new(Bot { http: reqwest::Client::builder().timeout(Duration::from_secs(45)).build().unwrap_or_default(), token, chat, trading, market, signals });

    // the summary: one a minute after start, then every 30 minutes
    let reporter = bot.clone();
    tauri::async_runtime::spawn(async move {
        reporter.say(&format!("<b>Harvester started</b> · {}\nSummary every 30 minutes. /help for the commands.", env_label(&reporter.trading))).await;
        tokio::time::sleep(FIRST_REPORT_AFTER).await;
        let (mut session_start, mut previous) = (None, None);
        loop {
            match reporter.summary_text(session_start, previous).await {
                Ok((text, equity)) => {
                    reporter.say(&text).await;
                    session_start.get_or_insert(equity);
                    previous = Some(equity);
                }
                Err(e) => eprintln!("[telegram] summary skipped: {e}"),
            }
            tokio::time::sleep(REPORT_EVERY).await;
        }
    });

    // the commands
    tauri::async_runtime::spawn(async move {
        // whatever was waiting before this start is NOT acted on: skip to the newest update
        let mut offset: i64 = 0;
        if let Ok(v) = bot.call("getUpdates", json!({"offset": -1, "timeout": 0})).await {
            if let Some(last) = v.as_array().and_then(|a| a.last()).and_then(|u| u["update_id"].as_i64()) {
                offset = last + 1;
            }
        }
        println!("[telegram] enabled (summary every 30 min, /help for the commands)");
        loop {
            let updates = match bot.call("getUpdates", json!({"offset": offset, "timeout": 25, "allowed_updates": ["message"]})).await {
                Ok(v) => v.as_array().cloned().unwrap_or_default(),
                Err(e) => {
                    eprintln!("[telegram] polling failed: {e}");
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
