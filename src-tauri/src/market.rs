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
            Env::Testnet => "https://testnet.binancefuture.com",
            Env::Live => "https://fapi.binance.com",
        }
    }
    pub fn ws_base(self) -> &'static str {
        match self {
            Env::Testnet => "wss://stream.binancefuture.com",
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
        Market { http, env: RwLock::new(env), filters: RwLock::new(HashMap::new()) }
    }

    pub fn env(&self) -> Env {
        *self.env.read().unwrap()
    }

    pub fn set_env(&self, env: Env) {
        *self.env.write().unwrap() = env;
        self.filters.write().unwrap().clear();
    }

    async fn get(&self, path: &str, query: &[(&str, String)]) -> Result<Value, String> {
        let url = format!("{}{}", self.env().rest_base(), path);
        let resp = self.http.get(&url).query(query).send().await.map_err(|e| format!("{path}: {e}"))?;
        let status = resp.status();
        let body: Value = resp.json().await.map_err(|e| format!("{path}: bad response: {e}"))?;
        if !status.is_success() {
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
