//! Signed trading on Binance USDⓈ-M futures: account, positions, open orders, place / cancel / close.
//!
//! Safety defaults:
//!  * keys come from the environment / a `.env` file and are never sent to the UI; testnet and live use DIFFERENT variables
//!    (`BINANCE_TESTNET_API_KEY/SECRET`, `BINANCE_LIVE_API_KEY/SECRET`; the legacy `BINANCE_API_KEY/SECRET` is accepted for
//!    the testnet only), so switching to live without live keys simply refuses to trade;
//!  * every order is rounded to the symbol's tick / step and validated by `harvester-core` before it is sent;
//!  * a server-side cap on the notional of one order (`MAX_ORDER_NOTIONAL`, default 5000 USDT).
//! Positions are reduced with an exact-size reduce-only market order (the testnet rejects `closePosition` on MARKET orders).

use crate::market::{Env, Market};
use harvester_core::decimal::{from_f64, to_f64};
use harvester_core::filters::{validate_order, OrderCheck, SymbolFilters};
use hmac::{Hmac, Mac};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    fn as_str(self) -> &'static str {
        match self {
            Side::Buy => "BUY",
            Side::Sell => "SELL",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum OrderType {
    Limit,
    Market,
}

/// An order as the UI asks for it. Prices and quantities are plain numbers; the Rust side rounds and validates them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderRequest {
    pub symbol: String,
    pub side: Side,
    #[serde(rename = "type")]
    pub order_type: OrderType,
    pub quantity: f64,
    #[serde(default)]
    pub price: Option<f64>,
    /// post-only (GTX) instead of GTC
    #[serde(default)]
    pub post_only: bool,
    #[serde(default)]
    pub reduce_only: bool,
    #[serde(default)]
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderAck {
    pub order_id: i64,
    pub symbol: String,
    pub status: String,
    pub client_id: String,
    /// the rounded quantity and price that were sent (what is now on the exchange)
    pub quantity: f64,
    pub price: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenOrder {
    pub order_id: i64,
    pub symbol: String,
    pub side: String,
    #[serde(rename = "type")]
    pub order_type: String,
    pub price: f64,
    pub stop_price: f64,
    pub orig_qty: f64,
    pub executed_qty: f64,
    pub status: String,
    pub reduce_only: bool,
    pub client_id: String,
    pub time: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub symbol: String,
    /// signed: positive = long, negative = short
    pub amount: f64,
    pub entry_price: f64,
    pub mark_price: f64,
    pub unrealized_pnl: f64,
    pub liquidation_price: f64,
    pub leverage: f64,
    pub isolated: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub wallet_balance: f64,
    pub available_balance: f64,
    pub unrealized_pnl: f64,
    pub positions: Vec<Position>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TradingStatus {
    pub env: Env,
    pub has_credentials: bool,
    pub max_order_notional: f64,
    pub message: String,
}

pub struct Trading {
    market: Arc<Market>,
    offset_ms: AtomicI64,
    synced: AtomicBool,
    max_notional: f64,
}

fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// (key, secret) for an environment, from the variables described in the module docs.
pub fn credentials(env: Env) -> Option<(String, String)> {
    let (k, s) = match env {
        Env::Testnet => (env_var("BINANCE_TESTNET_API_KEY").or_else(|| env_var("BINANCE_API_KEY")), env_var("BINANCE_TESTNET_API_SECRET").or_else(|| env_var("BINANCE_API_SECRET"))),
        Env::Live => (env_var("BINANCE_LIVE_API_KEY"), env_var("BINANCE_LIVE_API_SECRET")),
    };
    Some((k?, s?))
}

pub fn sign(secret: &str, payload: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("hmac accepts any key length");
    mac.update(payload.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// Percent-encode everything except unreserved characters (needed for the JSON of a batch order).
pub fn encode(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    for b in v.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn num(v: &Value) -> f64 {
    match v {
        Value::String(s) => s.parse().unwrap_or(0.0),
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn text(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

pub fn parse_open_orders(v: &Value) -> Vec<OpenOrder> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|o| OpenOrder {
                    order_id: o["orderId"].as_i64().unwrap_or(0),
                    symbol: text(&o["symbol"]),
                    side: text(&o["side"]),
                    order_type: text(&o["type"]),
                    price: num(&o["price"]),
                    stop_price: num(&o["stopPrice"]),
                    orig_qty: num(&o["origQty"]),
                    executed_qty: num(&o["executedQty"]),
                    status: text(&o["status"]),
                    reduce_only: o["reduceOnly"].as_bool().unwrap_or(false),
                    client_id: text(&o["clientOrderId"]),
                    time: o["time"].as_u64().unwrap_or(0),
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_positions(v: &Value) -> Vec<Position> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter(|p| num(&p["positionAmt"]) != 0.0)
                .map(|p| Position {
                    symbol: text(&p["symbol"]),
                    amount: num(&p["positionAmt"]),
                    entry_price: num(&p["entryPrice"]),
                    mark_price: num(&p["markPrice"]),
                    unrealized_pnl: num(if p.get("unRealizedProfit").is_some() { &p["unRealizedProfit"] } else { &p["unrealizedProfit"] }),
                    liquidation_price: num(&p["liquidationPrice"]),
                    leverage: num(&p["leverage"]),
                    isolated: p["marginType"].as_str().map_or(false, |m| m.eq_ignore_ascii_case("isolated")),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Round and validate an order request; returns the exact decimals that will be sent.
pub fn prepare(req: &OrderRequest, filters: &SymbolFilters, reference_price: f64, max_notional: f64) -> Result<(Decimal, Option<Decimal>), String> {
    let qty = filters.round_quantity(req.quantity);
    let price = match req.order_type {
        OrderType::Limit => Some(filters.round_price(req.price.ok_or("a limit order needs a price")?)),
        OrderType::Market => None,
    };
    let check = OrderCheck { price, quantity: Some(qty), is_market: req.order_type == OrderType::Market, ..Default::default() };
    let v = validate_order(&check, filters, reference_price);
    if !v.ok {
        return Err(v.errors.join(" "));
    }
    let notional = to_f64(qty) * price.map(to_f64).unwrap_or(reference_price);
    if notional > max_notional {
        return Err(format!("Order notional {notional:.2} USDT is above the safety cap of {max_notional:.0} USDT (MAX_ORDER_NOTIONAL)."));
    }
    Ok((qty, price))
}

/// The query parameters of one new-order request.
pub fn order_params(req: &OrderRequest, qty: Decimal, price: Option<Decimal>) -> Vec<(String, String)> {
    let mut p = vec![
        ("symbol".to_string(), req.symbol.clone()),
        ("side".to_string(), req.side.as_str().to_string()),
        ("type".to_string(), if req.order_type == OrderType::Limit { "LIMIT" } else { "MARKET" }.to_string()),
        ("quantity".to_string(), qty.to_string()),
        ("newOrderRespType".to_string(), "ACK".to_string()),
    ];
    if let Some(px) = price {
        p.push(("price".to_string(), px.to_string()));
        p.push(("timeInForce".to_string(), if req.post_only { "GTX" } else { "GTC" }.to_string()));
    }
    if req.reduce_only {
        p.push(("reduceOnly".to_string(), "true".to_string()));
    }
    if let Some(id) = &req.client_id {
        p.push(("newClientOrderId".to_string(), id.clone()));
    }
    p
}

impl Trading {
    pub fn new(market: Arc<Market>) -> Trading {
        let max_notional = env_var("MAX_ORDER_NOTIONAL").and_then(|v| v.parse().ok()).unwrap_or(5000.0);
        Trading { market, offset_ms: AtomicI64::new(0), synced: AtomicBool::new(false), max_notional }
    }

    pub fn status(&self) -> TradingStatus {
        let env = self.market.env();
        let has = credentials(env).is_some();
        let message = if has {
            String::new()
        } else {
            match env {
                Env::Testnet => "No testnet API key found. Put BINANCE_TESTNET_API_KEY and BINANCE_TESTNET_API_SECRET in the .env file next to Harvester, then restart.".to_string(),
                Env::Live => "No live API keys: set BINANCE_LIVE_API_KEY and BINANCE_LIVE_API_SECRET (withdrawals disabled, IP-restricted) to trade live.".to_string(),
            }
        };
        TradingStatus { env, has_credentials: has, max_order_notional: self.max_notional, message }
    }

    fn now_ms(&self) -> i64 {
        let local = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        local + self.offset_ms.load(Ordering::Relaxed)
    }

    /// Measure the clock difference to Binance (a skewed PC clock makes every signed request fail with -1021).
    pub async fn sync_time(&self) -> Result<(), String> {
        let url = format!("{}/fapi/v1/time", self.market.env().rest_base());
        let v: Value = self.market.http().get(&url).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
        let server = v["serverTime"].as_i64().ok_or("no serverTime")?;
        let local = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        self.offset_ms.store(server - local, Ordering::Relaxed);
        Ok(())
    }

    /// One signed request. Retries once after a time re-sync when Binance answers -1021.
    async fn signed(&self, method: reqwest::Method, path: &str, params: Vec<(String, String)>) -> Result<Value, String> {
        let (key, secret) = credentials(self.market.env()).ok_or_else(|| self.status().message)?;
        if !self.synced.swap(true, Ordering::Relaxed) {
            let _ = self.sync_time().await; // first signed call: align with the exchange clock
        }
        for attempt in 0..2 {
            let mut q: Vec<String> = params.iter().map(|(k, v)| format!("{k}={}", encode(v))).collect();
            q.push(format!("timestamp={}", self.now_ms()));
            q.push("recvWindow=10000".to_string());
            let payload = q.join("&");
            let url = format!("{}{}?{}&signature={}", self.market.env().rest_base(), path, payload, sign(&secret, &payload));
            let resp = self.market.http().request(method.clone(), &url).header("X-MBX-APIKEY", &key).send().await.map_err(|e| format!("{path}: {e}"))?;
            let status = resp.status();
            let body: Value = resp.json().await.map_err(|e| format!("{path}: bad response: {e}"))?;
            if status.is_success() {
                return Ok(body);
            }
            let code = body["code"].as_i64().unwrap_or(0);
            if code == -1021 && attempt == 0 {
                self.sync_time().await?;
                continue;
            }
            return Err(format!("{}", body["msg"].as_str().map(|m| format!("{m} ({code})")).unwrap_or_else(|| format!("{path}: HTTP {status}"))));
        }
        Err("request failed".into())
    }

    pub async fn account(&self) -> Result<Account, String> {
        let acc = self.signed(reqwest::Method::GET, "/fapi/v2/account", vec![]).await?;
        let risk = self.signed(reqwest::Method::GET, "/fapi/v2/positionRisk", vec![]).await?;
        Ok(Account {
            wallet_balance: num(&acc["totalWalletBalance"]),
            available_balance: num(&acc["availableBalance"]),
            unrealized_pnl: num(&acc["totalUnrealizedProfit"]),
            positions: parse_positions(&risk),
        })
    }

    pub async fn open_orders(&self, symbol: Option<&str>) -> Result<Vec<OpenOrder>, String> {
        let params = symbol.map(|s| vec![("symbol".to_string(), s.to_string())]).unwrap_or_default();
        Ok(parse_open_orders(&self.signed(reqwest::Method::GET, "/fapi/v1/openOrders", params).await?))
    }

    async fn reference_price(&self, symbol: &str) -> Result<f64, String> {
        self.market.mark_price(symbol).await
    }

    /// Place one order.
    pub async fn place(&self, req: OrderRequest) -> Result<OrderAck, String> {
        let filters = self.market.symbol_filters(&req.symbol).await?;
        let reference = self.reference_price(&req.symbol).await?;
        let (qty, price) = prepare(&req, &filters, reference, self.max_notional)?;
        let v = self.signed(reqwest::Method::POST, "/fapi/v1/order", order_params(&req, qty, price)).await?;
        Ok(OrderAck { order_id: v["orderId"].as_i64().unwrap_or(0), symbol: req.symbol, status: text(&v["status"]), client_id: text(&v["clientOrderId"]), quantity: to_f64(qty), price: price.map(to_f64) })
    }

    /// Place many orders for one symbol (a ladder): validated up front, sent in batches of five.
    /// Every order gets its own result so one rejected rung does not hide the others.
    pub async fn place_many(&self, reqs: Vec<OrderRequest>) -> Result<Vec<Result<OrderAck, String>>, String> {
        let Some(first) = reqs.first() else { return Ok(vec![]) };
        let symbol = first.symbol.clone();
        let filters = self.market.symbol_filters(&symbol).await?;
        let reference = self.reference_price(&symbol).await?;
        let mut results: Vec<Result<OrderAck, String>> = Vec::with_capacity(reqs.len());
        let mut prepared: Vec<(usize, Vec<(String, String)>)> = Vec::new();
        for (i, r) in reqs.iter().enumerate() {
            results.push(Err("not sent".into()));
            match prepare(r, &filters, reference, self.max_notional) {
                Ok((qty, price)) => prepared.push((i, order_params(r, qty, price))),
                Err(e) => results[i] = Err(e),
            }
        }
        for chunk in prepared.chunks(5) {
            let batch: Vec<Value> = chunk.iter().map(|(_, p)| Value::Object(p.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect())).collect();
            let body = self.signed(reqwest::Method::POST, "/fapi/v1/batchOrders", vec![("batchOrders".to_string(), serde_json::to_string(&batch).unwrap_or_default())]).await;
            match body {
                Ok(Value::Array(items)) => {
                    for ((idx, _), item) in chunk.iter().zip(items) {
                        results[*idx] = if item.get("orderId").is_some() {
                            Ok(OrderAck { order_id: item["orderId"].as_i64().unwrap_or(0), symbol: symbol.clone(), status: text(&item["status"]), client_id: text(&item["clientOrderId"]), quantity: num(&item["origQty"]), price: Some(num(&item["price"])) })
                        } else {
                            Err(format!("{} ({})", item["msg"].as_str().unwrap_or("rejected"), item["code"].as_i64().unwrap_or(0)))
                        };
                    }
                }
                Ok(_) => {
                    for (idx, _) in chunk {
                        results[*idx] = Err("unexpected response from the exchange".into());
                    }
                }
                Err(e) => {
                    for (idx, _) in chunk {
                        results[*idx] = Err(e.clone());
                    }
                }
            }
        }
        Ok(results)
    }

    pub async fn cancel(&self, symbol: &str, order_id: i64) -> Result<(), String> {
        self.signed(reqwest::Method::DELETE, "/fapi/v1/order", vec![("symbol".into(), symbol.into()), ("orderId".into(), order_id.to_string())]).await.map(|_| ())
    }

    pub async fn cancel_all(&self, symbol: &str) -> Result<(), String> {
        self.signed(reqwest::Method::DELETE, "/fapi/v1/allOpenOrders", vec![("symbol".into(), symbol.into())]).await.map(|_| ())
    }

    /// Close (or reduce) a position with an exact-size reduce-only market order. `fraction` is 0..1 (1 = all).
    pub async fn close_position(&self, symbol: &str, fraction: f64) -> Result<OrderAck, String> {
        let acc = self.account().await?;
        let pos = acc.positions.iter().find(|p| p.symbol == symbol).ok_or_else(|| format!("no open position in {symbol}"))?;
        let filters = self.market.symbol_filters(symbol).await?;
        let qty = to_f64(filters.round_quantity(pos.amount.abs() * fraction.clamp(0.0, 1.0)));
        if qty <= 0.0 {
            return Err("the size to close rounds to zero".into());
        }
        let req = OrderRequest {
            symbol: symbol.to_string(),
            side: if pos.amount > 0.0 { Side::Sell } else { Side::Buy },
            order_type: OrderType::Market,
            quantity: qty,
            price: None,
            post_only: false,
            reduce_only: true,
            client_id: None,
        };
        let v = self.signed(reqwest::Method::POST, "/fapi/v1/order", order_params(&req, from_f64(qty), None)).await?;
        Ok(OrderAck { order_id: v["orderId"].as_i64().unwrap_or(0), symbol: symbol.to_string(), status: text(&v["status"]), client_id: text(&v["clientOrderId"]), quantity: qty, price: None })
    }

    pub async fn set_leverage(&self, symbol: &str, leverage: u32) -> Result<(), String> {
        let cap = env_var("MAX_LEVERAGE").and_then(|v| v.parse::<u32>().ok()).unwrap_or(20);
        if leverage == 0 || leverage > cap {
            return Err(format!("leverage must be between 1 and {cap} (MAX_LEVERAGE)"));
        }
        self.signed(reqwest::Method::POST, "/fapi/v1/leverage", vec![("symbol".into(), symbol.into()), ("leverage".into(), leverage.to_string())]).await.map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use harvester_core::filters::extract_filters;
    use serde_json::json;

    fn eth() -> SymbolFilters {
        extract_filters(&json!({
            "symbol": "ETHUSDT", "pricePrecision": 2, "quantityPrecision": 3,
            "filters": [
                {"filterType": "PRICE_FILTER", "minPrice": "0.10", "tickSize": "0.01", "maxPrice": "100000"},
                {"filterType": "LOT_SIZE", "maxQty": "10000", "minQty": "0.001", "stepSize": "0.001"},
                {"filterType": "MIN_NOTIONAL", "notional": "5"},
                {"filterType": "PERCENT_PRICE", "multiplierUp": "1.05", "multiplierDown": "0.95"}
            ]
        }))
    }

    fn limit(price: f64, qty: f64) -> OrderRequest {
        OrderRequest { symbol: "ETHUSDT".into(), side: Side::Buy, order_type: OrderType::Limit, quantity: qty, price: Some(price), post_only: false, reduce_only: false, client_id: None }
    }

    #[test]
    fn signing_matches_the_binance_documentation_example() {
        // the example from Binance's API docs
        let secret = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";
        let payload = "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559";
        assert_eq!(sign(secret, payload), "c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71");
    }

    #[test]
    fn percent_encoding_keeps_unreserved_characters() {
        assert_eq!(encode("a-b_c.d~e"), "a-b_c.d~e");
        assert_eq!(encode("[{\"a\":1}]"), "%5B%7B%22a%22%3A1%7D%5D");
    }

    #[test]
    fn an_order_is_rounded_to_the_exchange_filters() {
        let (qty, price) = prepare(&limit(3000.567, 0.12345), &eth(), 3000.0, 5000.0).unwrap();
        assert_eq!(qty.to_string(), "0.123");
        assert_eq!(price.unwrap().to_string(), "3000.57");
    }

    #[test]
    fn orders_that_break_a_limit_are_refused_before_sending() {
        assert!(prepare(&limit(3000.0, 0.0004), &eth(), 3000.0, 5000.0).is_err()); // below minimum quantity
        assert!(prepare(&limit(3600.0, 1.0), &eth(), 3000.0, 5000.0).is_err()); // 20% above the market
        let e = prepare(&limit(3000.0, 3.0), &eth(), 3000.0, 5000.0).unwrap_err();
        assert!(e.contains("safety cap"), "{e}"); // 9000 USDT > 5000
    }

    #[test]
    fn a_limit_order_needs_a_price() {
        let mut r = limit(1.0, 1.0);
        r.price = None;
        assert!(prepare(&r, &eth(), 3000.0, 5000.0).is_err());
    }

    #[test]
    fn order_params_carry_time_in_force_and_flags() {
        let mut r = limit(3000.0, 0.5);
        r.post_only = true;
        r.reduce_only = true;
        let p = order_params(&r, from_f64(0.5), Some(from_f64(3000.0)));
        let get = |k: &str| p.iter().find(|(a, _)| a == k).map(|(_, v)| v.as_str());
        assert_eq!(get("timeInForce"), Some("GTX"));
        assert_eq!(get("reduceOnly"), Some("true"));
        assert_eq!(get("type"), Some("LIMIT"));
        let m = OrderRequest { order_type: OrderType::Market, price: None, ..r };
        let p = order_params(&m, from_f64(0.5), None);
        assert!(p.iter().all(|(k, _)| k != "timeInForce" && k != "price"));
    }

    #[test]
    fn parses_open_orders_and_positions() {
        let o = parse_open_orders(&json!([{"orderId": 7, "symbol": "ETHUSDT", "side": "BUY", "type": "LIMIT", "price": "3000.00", "origQty": "0.5", "executedQty": "0", "status": "NEW", "reduceOnly": false, "clientOrderId": "abc", "time": 1700000000000u64, "stopPrice": "0"}]));
        assert_eq!(o.len(), 1);
        assert_eq!((o[0].order_id, o[0].price, o[0].orig_qty), (7, 3000.0, 0.5));
        let p = parse_positions(&json!([
            {"symbol": "ETHUSDT", "positionAmt": "-0.5", "entryPrice": "3000", "markPrice": "2990", "unRealizedProfit": "5.0", "liquidationPrice": "3500", "leverage": "10", "marginType": "isolated"},
            {"symbol": "BTCUSDT", "positionAmt": "0.000", "entryPrice": "0", "markPrice": "1", "unRealizedProfit": "0", "liquidationPrice": "0", "leverage": "10", "marginType": "cross"}
        ]));
        assert_eq!(p.len(), 1);
        assert!(p[0].amount < 0.0 && p[0].isolated && p[0].unrealized_pnl == 5.0);
    }

    #[test]
    fn credentials_follow_the_environment() {
        // live never falls back to the legacy testnet variables
        std::env::remove_var("BINANCE_LIVE_API_KEY");
        std::env::remove_var("BINANCE_LIVE_API_SECRET");
        assert!(credentials(Env::Live).is_none());
    }
}
