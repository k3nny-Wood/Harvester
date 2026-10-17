//! Public Binance USDⓈ-M market data over REST: symbols, filters, tickers and klines.
//! No credentials are needed for any of it; the signed trading endpoints live elsewhere.

use harvester_core::filters::{extract_filters, SymbolFilters};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::RwLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Env {
    Testnet,
    Live,
}

impl Env {
    pub fn from_name(s: &str) -> Env {
        if s.eq_ignore_ascii_case("live") {
            Env::Live
        } else {
            Env::Testnet
        }
    }
    pub fn rest_base(self) -> &'static str {
        match self {
            // Binance's Demo Trading host (the same demo account and keys as testnet.binancefuture.com). The old testnet host sits behind CloudFront, where the
            // rate limit is counted for the shared CloudFront address: other users' traffic got this server banned for hours while it sent ~12 requests a minute.
            Env::Testnet => "https://demo-fapi.binance.com",
            Env::Live => "https://fapi.binance.com",
        }
    }
    /// The market-data streams (prices, klines, mark prices). Binance moved them to a `/market` path: on the real futures exchange the old
    /// `/ws/...` URLs still connect but never deliver a message (the pump / dump watcher sat "silent" because of it); the testnet takes both.
    pub fn ws_market(self) -> String {
        format!("{}/market", self.ws_base())
    }

    pub fn ws_base(self) -> &'static str {
        match self {
            Env::Testnet => "wss://demo-fstream.binance.com",
            Env::Live => "wss://fstream.binance.com",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Kline {
    /// open time, epoch ms
    pub time: u64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolQuote {
    pub symbol: String,
    pub last_price: f64,
    pub change_percent_24h: f64,
    pub volume_24h_quote: f64,
}

pub struct Market {
    http: reqwest::Client,
    env: RwLock<Env>,
    filters: RwLock<HashMap<String, SymbolFilters>>,
    /// while Binance is limiting this IP ("Way too many requests", HTTP 418 / 429): when it lets requests through again (epoch ms; 0 = no limit)
    /// one for each exchange: a ban on the testnet host says nothing about the real one
    blocked_until: [std::sync::atomic::AtomicU64; 2],
    /// the weight of the requests made in the last minute, per exchange (see `spend`)
    spent: [std::sync::Mutex<std::collections::VecDeque<(u64, u32)>>; 2],
    /// the symbol list (24 h tickers, weight 40) for a few seconds, so several screens share one read
    symbols_cache: std::sync::Mutex<Option<(std::time::Instant, Vec<SymbolQuote>)>>,
}

/// What Harvester allows itself to use of Binance's weight limit per minute and exchange: under half of it (the testnet allows 6000, the real
/// exchange 2400), so that the phone, the web page, the desktop app and the Telegram bot together cannot bring a ban on the IP.
pub const BUDGET_PER_MINUTE: [u32; 2] = [2400, 1000];

/// The weight Binance charges for a request (its documented values; a request that is not listed counts 1).
pub fn request_weight(path: &str, params: &[(&str, &str)]) -> u32 {
    let has = |k: &str| params.iter().any(|(n, _)| *n == k);
    let value = |k: &str| params.iter().find(|(n, _)| *n == k).map(|(_, v)| *v);
    match path {
        "/fapi/v1/openOrders" => {
            if has("symbol") {
                1
            } else {
                40
            }
        }
        "/fapi/v1/ticker/24hr" => {
            if has("symbol") {
                1
            } else {
                40
            }
        }
        "/fapi/v1/klines" => match value("limit").and_then(|l| l.parse::<u32>().ok()).unwrap_or(500) {
            0..=99 => 1,
            100..=499 => 2,
            500..=1000 => 5,
            _ => 10,
        },
        "/fapi/v2/account" | "/fapi/v2/positionRisk" | "/fapi/v1/userTrades" | "/fapi/v1/allOrders" => 5,
        "/fapi/v1/income" => 30,
        _ => 1,
    }
}

/// The time (epoch ms) a "banned until 1792212599246" message names, if it has one.
pub fn banned_until(msg: &str) -> Option<u64> {
    let rest = msg.split("banned until ").nth(1)?;
    rest.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok()
}

fn f(v: &Value) -> f64 {
    match v {
        Value::String(s) => s.parse().unwrap_or(0.0),
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// Binance kline rows are `[openTime, o, h, l, c, v, ...]`.
pub fn parse_klines(rows: &Value) -> Vec<Kline> {
    rows.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|r| {
                    let r = r.as_array()?;
                    Some(Kline { time: r.first()?.as_u64()?, open: f(r.get(1)?), high: f(r.get(2)?), low: f(r.get(3)?), close: f(r.get(4)?), volume: f(r.get(5)?) })
                })
                .collect()
        })
        .unwrap_or_default()
}

impl Market {
    pub fn new(env: Env) -> Market {
        let http = reqwest::Client::builder().user_agent("harvester").timeout(std::time::Duration::from_secs(20)).build().expect("http client");
        Market { http, env: RwLock::new(env), filters: RwLock::new(HashMap::new()), blocked_until: [std::sync::atomic::AtomicU64::new(0), std::sync::atomic::AtomicU64::new(0)], spent: [std::sync::Mutex::new(std::collections::VecDeque::new()), std::sync::Mutex::new(std::collections::VecDeque::new())], symbols_cache: std::sync::Mutex::new(None) }
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
    }

    /// Err while Binance is limiting this IP: nothing is sent, because every request during a ban makes it longer.
    pub fn check_limit(&self) -> Result<(), String> {
        self.check_limit_for(self.env())
    }

    /// Account for a request of `weight` on an exchange. Over the budget a request is refused (nothing is sent) with a message saying so; a request
    /// that changes something (placing, moving or cancelling an order: `essential`) is always let through, it only counts.
    pub fn spend(&self, env: Env, weight: u32, essential: bool) -> Result<(), String> {
        let slot = Self::slot(env);
        let now = Self::now_ms();
        let mut q = self.spent[slot].lock().unwrap();
        while q.front().map_or(false, |(t, _)| now.saturating_sub(*t) >= 60_000) {
            q.pop_front();
        }
        let used: u32 = q.iter().map(|(_, w)| *w).sum();
        let cap = BUDGET_PER_MINUTE[slot];
        if !essential && used + weight > cap {
            let wait = q.front().map_or(5, |(t, _)| (60_000u64.saturating_sub(now.saturating_sub(*t))).div_ceil(1000));
            return Err(format!("Harvester is holding requests back to stay inside Binance's limit ({used} of {cap} used this minute); try again in about {wait} s"));
        }
        q.push_back((now, weight));
        Ok(())
    }

    fn slot(env: Env) -> usize {
        if env == Env::Live {
            1
        } else {
            0
        }
    }

    pub fn check_limit_for(&self, env: Env) -> Result<(), String> {
        let until = self.blocked_until[Self::slot(env)].load(std::sync::atomic::Ordering::Relaxed);
        let now = Self::now_ms();
        if until > now {
            let secs = (until - now).div_ceil(1000);
            let wait = if secs >= 120 { format!("{} min", secs.div_ceil(60)) } else { format!("{secs} s") };
            return Err(format!("Binance is limiting this server's requests (too many); paused for another {wait}"));
        }
        Ok(())
    }

    /// Look at a failed answer: a rate-limit answer starts a pause (until the time Binance names, else the Retry-After header, else a minute).
    pub fn note_failure(&self, http_status: u16, code: i64, msg: &str, retry_after_secs: Option<u64>) {
        self.note_failure_for(self.env(), http_status, code, msg, retry_after_secs)
    }

    pub fn note_failure_for(&self, env: Env, http_status: u16, code: i64, msg: &str, retry_after_secs: Option<u64>) {
        if !(code == -1003 || http_status == 418 || http_status == 429) {
            return;
        }
        let now = Self::now_ms();
        let until = banned_until(msg).or_else(|| retry_after_secs.map(|s| now + s * 1000)).unwrap_or(now + 60_000).clamp(now + 5_000, now + 3 * 86_400_000);
        self.blocked_until[Self::slot(env)].fetch_max(until, std::sync::atomic::Ordering::Relaxed);
        crate::health::log(&format!("[binance] rate limit on the {} exchange: pausing requests until {until} ({msg})", if env == Env::Live { "real" } else { "test" }));
    }

    pub fn env(&self) -> Env {
        *self.env.read().unwrap()
    }

    pub fn set_env(&self, env: Env) {
        *self.env.write().unwrap() = env;
        self.filters.write().unwrap().clear();
        *self.symbols_cache.lock().unwrap() = None;
    }

    async fn get(&self, path: &str, query: &[(&str, String)]) -> Result<Value, String> {
        self.check_limit()?;
        let pairs: Vec<(&str, &str)> = query.iter().map(|(k, v)| (*k, v.as_str())).collect();
        self.spend(self.env(), request_weight(path, &pairs), false)?;
        crate::health::count_request(if self.env() == Env::Live { "real" } else { "test" }, path);
        let url = format!("{}{}", self.env().rest_base(), path);
        let resp = self.http.get(&url).query(query).send().await.map_err(|e| format!("{path}: {e}"))?;
        let status = resp.status();
        let retry_after = resp.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
        let body: Value = resp.json().await.map_err(|e| format!("{path}: bad response: {e}"))?;
        if !status.is_success() {
            self.note_failure(status.as_u16(), body["code"].as_i64().unwrap_or(0), body.get("msg").and_then(|m| m.as_str()).unwrap_or(""), retry_after);
            return Err(format!("{path}: HTTP {status}: {}", body.get("msg").and_then(|m| m.as_str()).unwrap_or("error")));
        }
        Ok(body)
    }

    /// Load (and cache) the trading filters of every perpetual USDT symbol.
    async fn ensure_filters(&self) -> Result<(), String> {
        if !self.filters.read().unwrap().is_empty() {
            return Ok(());
        }
        let info = self.get("/fapi/v1/exchangeInfo", &[]).await?;
        let mut map = HashMap::new();
        for s in info["symbols"].as_array().cloned().unwrap_or_default() {
            let trading = s["status"] == "TRADING" && s["contractType"] == "PERPETUAL" && s["quoteAsset"] == "USDT";
            if trading {
                let fl = extract_filters(&s);
                map.insert(fl.symbol.clone(), fl);
            }
        }
        *self.filters.write().unwrap() = map;
        Ok(())
    }

    pub async fn symbol_filters(&self, symbol: &str) -> Result<SymbolFilters, String> {
        self.ensure_filters().await?;
        self.filters.read().unwrap().get(symbol).cloned().ok_or_else(|| format!("unknown symbol {symbol}"))
    }

    /// Every tradable perpetual with last price, 24h change and quote volume, busiest first.
    pub async fn symbols(&self) -> Result<Vec<SymbolQuote>, String> {
        if let Some((at, v)) = &*self.symbols_cache.lock().unwrap() {
            if at.elapsed() < std::time::Duration::from_secs(20) {
                return Ok(v.clone());
            }
        }
        let fresh = self.symbols_uncached().await?;
        *self.symbols_cache.lock().unwrap() = Some((std::time::Instant::now(), fresh.clone()));
        Ok(fresh)
    }

    async fn symbols_uncached(&self) -> Result<Vec<SymbolQuote>, String> {
        self.ensure_filters().await?;
        let tickers = self.get("/fapi/v1/ticker/24hr", &[]).await?;
        let known = self.filters.read().unwrap();
        let mut out: Vec<SymbolQuote> = tickers
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter(|t| t["symbol"].as_str().map_or(false, |s| known.contains_key(s)))
            .map(|t| SymbolQuote {
                symbol: t["symbol"].as_str().unwrap_or("").to_string(),
                last_price: f(&t["lastPrice"]),
                change_percent_24h: f(&t["priceChangePercent"]),
                volume_24h_quote: f(&t["quoteVolume"]),
            })
            .collect();
        out.sort_by(|a, b| b.volume_24h_quote.partial_cmp(&a.volume_24h_quote).unwrap_or(std::cmp::Ordering::Equal));
        Ok(out)
    }

    /// Current mark price of a perpetual.
    pub async fn mark_price(&self, symbol: &str) -> Result<f64, String> {
        let v = self.get("/fapi/v1/premiumIndex", &[("symbol", symbol.to_string())]).await?;
        let p = f(&v["markPrice"]);
        if p > 0.0 { Ok(p) } else { Err(format!("no mark price for {symbol}")) }
    }

    /// Public market data from the REAL exchange, whatever environment trading is on. Research (the Lab) needs real prices:
    /// the testnet's candles differ from the live market and its server is slow.
    async fn mainnet_get(&self, path: &str, query: &[(&str, String)]) -> Result<Value, String> {
        self.check_limit_for(Env::Live)?;
        let pairs: Vec<(&str, &str)> = query.iter().map(|(k, v)| (*k, v.as_str())).collect();
        self.spend(Env::Live, request_weight(path, &pairs), false)?;
        crate::health::count_request("real", path);
        let url = format!("{}{}", Env::Live.rest_base(), path);
        let resp = self.http.get(&url).query(query).send().await.map_err(|e| format!("{path}: {e}"))?;
        let status = resp.status();
        let retry_after = resp.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
        let body: Value = resp.json().await.map_err(|e| format!("{path}: bad response: {e}"))?;
        if !status.is_success() {
            self.note_failure_for(Env::Live, status.as_u16(), body["code"].as_i64().unwrap_or(0), body.get("msg").and_then(|m| m.as_str()).unwrap_or(""), retry_after);
            return Err(format!("{path}: HTTP {status}: {}", body.get("msg").and_then(|m| m.as_str()).unwrap_or("error")));
        }
        Ok(body)
    }

    pub async fn mainnet_klines(&self, symbol: &str, interval: &str, limit: u32, start: Option<u64>) -> Result<Vec<Kline>, String> {
        let mut q = vec![("symbol", symbol.to_string()), ("interval", interval.to_string()), ("limit", limit.clamp(1, 1500).to_string())];
        if let Some(s) = start {
            q.push(("startTime", s.to_string()));
        }
        Ok(parse_klines(&self.mainnet_get("/fapi/v1/klines", &q).await?))
    }

    /// The `n` USDT perpetuals with the most 24 h volume on the real exchange.
    pub async fn mainnet_top_symbols(&self, n: usize) -> Result<Vec<String>, String> {
        let t = self.mainnet_get("/fapi/v1/ticker/24hr", &[]).await?;
        let mut rows: Vec<(String, f64)> = t
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|x| {
                let s = x["symbol"].as_str()?;
                (s.ends_with("USDT") && s.is_ascii() && !s.contains('_')).then(|| (s.to_string(), f(&x["quoteVolume"])))
            })
            .collect();
        rows.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        Ok(rows.into_iter().take(n).map(|r| r.0).collect())
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    pub async fn klines(&self, symbol: &str, interval: &str, limit: u32, start: Option<u64>, end: Option<u64>) -> Result<Vec<Kline>, String> {
        let mut q = vec![("symbol", symbol.to_string()), ("interval", interval.to_string()), ("limit", limit.clamp(1, 1500).to_string())];
        if let Some(s) = start {
            q.push(("startTime", s.to_string()));
        }
        if let Some(e) = end {
            q.push(("endTime", e.to_string()));
        }
        Ok(parse_klines(&self.get("/fapi/v1/klines", &q).await?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_binance_kline_rows() {
        let rows = serde_json::json!([[1700000000000u64, "100.5", "101", "99.5", "100.8", "1234.5", 1700000899999u64, "0", 10, "0", "0", "0"]]);
        let k = parse_klines(&rows);
        assert_eq!(k.len(), 1);
        assert_eq!(k[0], Kline { time: 1700000000000, open: 100.5, high: 101.0, low: 99.5, close: 100.8, volume: 1234.5 });
    }

    #[test]
    fn env_names() {
        assert_eq!(Env::from_name("LIVE"), Env::Live);
        assert_eq!(Env::from_name("anything else"), Env::Testnet);
        assert!(Env::Testnet.rest_base().contains("testnet"));
    }
}

#[cfg(test)]
mod rate_limit_tests {
    use super::*;

    #[test]
    fn reads_the_ban_time_out_of_binances_message() {
        let msg = "Way too many requests; IP(15.158.242.112) banned until 1792212599246. Please use the websocket for live updates to avoid bans.";
        assert_eq!(banned_until(msg), Some(1_792_212_599_246));
        assert_eq!(banned_until("Too many requests"), None);
    }

    #[test]
    fn a_rate_limit_answer_pauses_every_request_until_the_ban_ends() {
        let m = Market::new(Env::Testnet);
        assert!(m.check_limit().is_ok());
        m.note_failure(400, -1021, "timestamp", None); // some other error: no pause
        assert!(m.check_limit().is_ok());
        let in_a_minute = Market::now_ms() + 60_000;
        m.note_failure(418, -1003, &format!("banned until {in_a_minute}"), None);
        let e = m.check_limit().unwrap_err();
        assert!(e.contains("limiting"), "{e}");
        // a Retry-After alone starts a pause too, and a pause is never shortened by a later, shorter one
        let m2 = Market::new(Env::Testnet);
        m2.note_failure(429, 0, "", Some(30));
        assert!(m2.check_limit().is_err());
        let first = m2.blocked_until[0].load(std::sync::atomic::Ordering::Relaxed);
        m2.note_failure(429, 0, "", Some(10));
        assert_eq!(m2.blocked_until[0].load(std::sync::atomic::Ordering::Relaxed), first);
        // the other exchange is not paused by it
        assert!(m2.check_limit_for(Env::Live).is_ok());
    }
}

#[cfg(test)]
mod budget_tests {
    use super::*;

    #[test]
    fn knows_the_weight_of_the_heavy_requests() {
        assert_eq!(request_weight("/fapi/v1/openOrders", &[]), 40);
        assert_eq!(request_weight("/fapi/v1/openOrders", &[("symbol", "BTCUSDT")]), 1);
        assert_eq!(request_weight("/fapi/v1/ticker/24hr", &[]), 40);
        assert_eq!(request_weight("/fapi/v1/klines", &[("limit", "99")]), 1);
        assert_eq!(request_weight("/fapi/v1/klines", &[("limit", "500")]), 5);
        assert_eq!(request_weight("/fapi/v1/klines", &[("limit", "1500")]), 10);
        assert_eq!(request_weight("/fapi/v2/account", &[]), 5);
        assert_eq!(request_weight("/fapi/v1/whatever", &[]), 1);
    }

    #[test]
    fn requests_over_the_budget_are_held_back_but_orders_always_go_through() {
        let m = Market::new(Env::Testnet);
        let cap = BUDGET_PER_MINUTE[0];
        assert!(m.spend(Env::Testnet, cap - 10, false).is_ok());
        assert!(m.spend(Env::Testnet, 10, false).is_ok()); // exactly the cap
        let e = m.spend(Env::Testnet, 1, false).unwrap_err();
        assert!(e.contains("holding requests back"), "{e}");
        assert!(m.spend(Env::Testnet, 1, true).is_ok(), "an order is never held back");
        // the other exchange has its own budget
        assert!(m.spend(Env::Live, 1, false).is_ok());
    }
}
