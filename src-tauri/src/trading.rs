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
    pub fn as_str(self) -> &'static str {
        match self {
            Side::Buy => "BUY",
            Side::Sell => "SELL",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OrderType {
    Limit,
    Market,
    /// stop-loss that sells / buys at market once the trigger is hit
    StopMarket,
    /// stop-loss that places a limit order once the trigger is hit
    Stop,
    TakeProfitMarket,
    TakeProfit,
}

impl OrderType {
    pub fn as_str(self) -> &'static str {
        match self {
            OrderType::Limit => "LIMIT",
            OrderType::Market => "MARKET",
            OrderType::StopMarket => "STOP_MARKET",
            OrderType::Stop => "STOP",
            OrderType::TakeProfitMarket => "TAKE_PROFIT_MARKET",
            OrderType::TakeProfit => "TAKE_PROFIT",
        }
    }
    /// Stops and take-profits are conditional orders, placed through Binance's algo-order service.
    pub fn is_conditional(self) -> bool {
        !matches!(self, OrderType::Limit | OrderType::Market)
    }
    /// Needs a limit price (plain limit, and the limit variants of stop / take-profit).
    pub fn has_price(self) -> bool {
        matches!(self, OrderType::Limit | OrderType::Stop | OrderType::TakeProfit)
    }
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
    /// trigger price of a stop / take-profit
    #[serde(default)]
    pub stop_price: Option<f64>,
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
    /// a stop / take-profit (cancelled through the algo-order service)
    pub conditional: bool,
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
    /// true for a stop / take-profit; `order_id` is then the algo id
    pub conditional: bool,
}

/// One order from the account's history (any final or partial state).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderRecord {
    pub order_id: i64,
    pub symbol: String,
    pub side: String,
    #[serde(rename = "type")]
    pub order_type: String,
    pub status: String,
    pub price: f64,
    pub stop_price: f64,
    pub avg_price: f64,
    pub orig_qty: f64,
    pub executed_qty: f64,
    pub reduce_only: bool,
    pub time: u64,
    pub update_time: u64,
    pub conditional: bool,
}

/// One fill from the account's trade history.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeRecord {
    pub id: i64,
    pub order_id: i64,
    pub symbol: String,
    pub side: String,
    pub price: f64,
    pub qty: f64,
    pub quote_qty: f64,
    pub realized_pnl: f64,
    pub commission: f64,
    pub commission_asset: String,
    pub maker: bool,
    pub time: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeverageInfo {
    pub leverage: u32,
    pub max_leverage: u32,
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
    /// the leverage set for each symbol the account lists (also the ones with no position, for their open orders)
    pub leverages: std::collections::HashMap<String, f64>,
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
                    conditional: false,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// symbol -> leverage from the `positions` list of an account answer.
pub fn parse_leverages(acc: &Value) -> std::collections::HashMap<String, f64> {
    acc["positions"].as_array().map(|a| a.iter().filter_map(|p| Some((p["symbol"].as_str()?.to_string(), num(&p["leverage"])))).filter(|(_, l)| *l > 0.0).collect()).unwrap_or_default()
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

/// The order type of an exchange order name, for the orders this app can place (and so move).
pub fn order_type_from(name: &str) -> Option<OrderType> {
    match name {
        "LIMIT" => Some(OrderType::Limit),
        "MARKET" => Some(OrderType::Market),
        "STOP_MARKET" => Some(OrderType::StopMarket),
        "STOP" => Some(OrderType::Stop),
        "TAKE_PROFIT_MARKET" => Some(OrderType::TakeProfitMarket),
        "TAKE_PROFIT" => Some(OrderType::TakeProfit),
        _ => None,
    }
}

/// Open conditional (stop / take-profit) orders from `/fapi/v1/openAlgoOrders`.
pub fn parse_algo_orders(v: &Value) -> Vec<OpenOrder> {
    let arr = if v.is_array() { v.as_array().cloned().unwrap_or_default() } else { v["orders"].as_array().cloned().unwrap_or_default() };
    arr.iter()
        .map(|o| OpenOrder {
            order_id: o["algoId"].as_i64().unwrap_or(0),
            symbol: text(&o["symbol"]),
            side: text(&o["side"]),
            order_type: {
                let t = text(&o["orderType"]);
                if t.is_empty() { text(&o["type"]) } else { t }
            },
            price: num(&o["price"]),
            stop_price: num(&o["triggerPrice"]),
            orig_qty: num(&o["quantity"]),
            executed_qty: 0.0,
            status: {
                let t = text(&o["algoStatus"]);
                if t.is_empty() { "NEW".to_string() } else { t }
            },
            reduce_only: o["reduceOnly"].as_bool().unwrap_or(false) || matches!(&o["reduceOnly"], Value::String(s) if s == "true"),
            client_id: text(&o["clientAlgoId"]),
            time: o["createTime"].as_u64().unwrap_or(0),
            conditional: true,
        })
        .collect()
}

pub fn parse_order_history(v: &Value) -> Vec<OrderRecord> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|o| OrderRecord {
                    order_id: o["orderId"].as_i64().unwrap_or(0),
                    symbol: text(&o["symbol"]),
                    side: text(&o["side"]),
                    order_type: text(&o["type"]),
                    status: text(&o["status"]),
                    price: num(&o["price"]),
                    stop_price: num(&o["stopPrice"]),
                    avg_price: num(&o["avgPrice"]),
                    orig_qty: num(&o["origQty"]),
                    executed_qty: num(&o["executedQty"]),
                    reduce_only: o["reduceOnly"].as_bool().unwrap_or(false),
                    time: o["time"].as_u64().unwrap_or(0),
                    update_time: o["updateTime"].as_u64().unwrap_or(0),
                    conditional: false,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Finished stop / take-profit orders from `/fapi/v1/allAlgoOrders`.
pub fn parse_algo_history(v: &Value) -> Vec<OrderRecord> {
    let arr = if v.is_array() { v.as_array().cloned().unwrap_or_default() } else { v["orders"].as_array().cloned().unwrap_or_default() };
    arr.iter()
        .map(|o| OrderRecord {
            order_id: o["algoId"].as_i64().unwrap_or(0),
            symbol: text(&o["symbol"]),
            side: text(&o["side"]),
            order_type: {
                let t = text(&o["orderType"]);
                if t.is_empty() { text(&o["type"]) } else { t }
            },
            status: text(&o["algoStatus"]),
            price: num(&o["price"]),
            stop_price: num(&o["triggerPrice"]),
            avg_price: num(&o["actualPrice"]),
            orig_qty: num(&o["quantity"]),
            executed_qty: 0.0,
            reduce_only: o["reduceOnly"].as_bool().unwrap_or(false) || matches!(&o["reduceOnly"], Value::String(s) if s == "true"),
            time: o["createTime"].as_u64().unwrap_or(0),
            update_time: o["updateTime"].as_u64().or_else(|| o["createTime"].as_u64()).unwrap_or(0),
            conditional: true,
        })
        .collect()
}

pub fn parse_trade_history(v: &Value) -> Vec<TradeRecord> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|t| TradeRecord {
                    id: t["id"].as_i64().unwrap_or(0),
                    order_id: t["orderId"].as_i64().unwrap_or(0),
                    symbol: text(&t["symbol"]),
                    side: text(&t["side"]),
                    price: num(&t["price"]),
                    qty: num(&t["qty"]),
                    quote_qty: num(&t["quoteQty"]),
                    realized_pnl: num(&t["realizedPnl"]),
                    commission: num(&t["commission"]),
                    commission_asset: text(&t["commissionAsset"]),
                    maker: t["maker"].as_bool().unwrap_or(false),
                    time: t["time"].as_u64().unwrap_or(0),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The highest initial leverage in a `leverageBracket` answer.
pub fn parse_max_leverage(v: &Value) -> Option<u32> {
    let first = if v.is_array() { v.get(0)? } else { v };
    first["brackets"].as_array()?.iter().filter_map(|b| b["initialLeverage"].as_u64()).max().map(|x| x as u32)
}

/// Round and validate an order request; returns the exact decimals that will be sent: (quantity, limit price, trigger price).
pub fn prepare(req: &OrderRequest, filters: &SymbolFilters, reference_price: f64, max_notional: f64) -> Result<(Decimal, Option<Decimal>, Option<Decimal>), String> {
    let qty = filters.round_quantity(req.quantity);
    let t = req.order_type;
    let price = if t.has_price() { Some(filters.round_price(req.price.ok_or("this order type needs a limit price")?)) } else { None };
    let trigger = if t.is_conditional() { Some(filters.round_price(req.stop_price.ok_or("a stop / take-profit needs a trigger price")?)) } else { None };
    if let Some(tp) = trigger {
        // Binance rejects a trigger that would fire immediately: say so clearly instead
        let is_stop = matches!(t, OrderType::StopMarket | OrderType::Stop);
        let is_buy = req.side == Side::Buy;
        let must_be_above = is_stop == is_buy; // a buy-stop and a sell-take-profit trigger above the market
        let tp_f = to_f64(tp);
        if must_be_above && tp_f <= reference_price {
            return Err(format!("The trigger {tp} must be ABOVE the current price {reference_price} for this order."));
        }
        if !must_be_above && tp_f >= reference_price {
            return Err(format!("The trigger {tp} must be BELOW the current price {reference_price} for this order."));
        }
    }
    let check = OrderCheck { price, quantity: Some(qty), stop_price: trigger, is_market: !t.has_price(), ..Default::default() };
    let v = validate_order(&check, filters, reference_price);
    if !v.ok {
        return Err(v.errors.join(" "));
    }
    let notional = to_f64(qty) * price.or(trigger).map(to_f64).unwrap_or(reference_price);
    if notional > max_notional {
        return Err(format!("Order notional {notional:.2} USDT is above the safety cap of {max_notional:.0} USDT (MAX_ORDER_NOTIONAL)."));
    }
    Ok((qty, price, trigger))
}

/// The query parameters of one plain limit / market order (`/fapi/v1/order`).
pub fn order_params(req: &OrderRequest, qty: Decimal, price: Option<Decimal>) -> Vec<(String, String)> {
    let mut p = vec![
        ("symbol".to_string(), req.symbol.clone()),
        ("side".to_string(), req.side.as_str().to_string()),
        ("type".to_string(), req.order_type.as_str().to_string()),
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

/// The parameters of a conditional order (stop / take-profit): `/fapi/v1/algoOrder`.
pub fn algo_params(req: &OrderRequest, qty: Decimal, price: Option<Decimal>, trigger: Decimal) -> Vec<(String, String)> {
    let mut p = vec![
        ("algoType".to_string(), "CONDITIONAL".to_string()),
        ("symbol".to_string(), req.symbol.clone()),
        ("side".to_string(), req.side.as_str().to_string()),
        ("type".to_string(), req.order_type.as_str().to_string()),
        ("quantity".to_string(), qty.to_string()),
        ("triggerPrice".to_string(), trigger.to_string()),
        ("workingType".to_string(), "MARK_PRICE".to_string()),
    ];
    if let Some(px) = price {
        p.push(("price".to_string(), px.to_string()));
        p.push(("timeInForce".to_string(), "GTC".to_string()));
    }
    if req.reduce_only {
        p.push(("reduceOnly".to_string(), "true".to_string()));
    }
    if let Some(id) = &req.client_id {
        p.push(("clientAlgoId".to_string(), id.clone()));
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

    pub fn env(&self) -> Env {
        self.market.env()
    }

    pub fn market(&self) -> &Arc<Market> {
        &self.market
    }

    pub fn max_notional(&self) -> f64 {
        self.max_notional
    }

    /// The listen-key calls need the API key but no signature.
    async fn listen_key_call(&self, method: reqwest::Method) -> Result<Value, String> {
        let (key, _) = credentials(self.market.env()).ok_or_else(|| self.status().message)?;
        let url = format!("{}/fapi/v1/listenKey", self.market.env().rest_base());
        let resp = self.market.http().request(method, &url).header("X-MBX-APIKEY", &key).send().await.map_err(|e| format!("listenKey: {e}"))?;
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            Ok(body)
        } else {
            Err(format!("listenKey: HTTP {status} {}", body["msg"].as_str().unwrap_or("")))
        }
    }

    /// Start a user-data stream and return its listen key (valid for 60 minutes unless kept alive).
    pub async fn listen_key_start(&self) -> Result<String, String> {
        let v = self.listen_key_call(reqwest::Method::POST).await?;
        v["listenKey"].as_str().map(|s| s.to_string()).ok_or_else(|| "no listenKey in the answer".to_string())
    }

    pub async fn listen_key_keepalive(&self) -> Result<(), String> {
        self.listen_key_call(reqwest::Method::PUT).await.map(|_| ())
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
            leverages: parse_leverages(&acc),
        })
    }

    pub async fn open_orders(&self, symbol: Option<&str>) -> Result<Vec<OpenOrder>, String> {
        let params = || symbol.map(|s| vec![("symbol".to_string(), s.to_string())]).unwrap_or_default();
        let mut out = parse_open_orders(&self.signed(reqwest::Method::GET, "/fapi/v1/openOrders", params()).await?);
        // stops and take-profits live in the algo-order service; a failure there must not hide the plain orders
        if let Ok(v) = self.signed(reqwest::Method::GET, "/fapi/v1/openAlgoOrders", params()).await {
            out.extend(parse_algo_orders(&v));
        }
        Ok(out)
    }

    /// Order history of one symbol (newest first), stops and take-profits included. Binance requires the symbol.
    pub async fn order_history(&self, symbol: &str, limit: u32) -> Result<Vec<OrderRecord>, String> {
        let q = |l: u32| vec![("symbol".to_string(), symbol.to_string()), ("limit".to_string(), l.to_string())];
        let mut out = parse_order_history(&self.signed(reqwest::Method::GET, "/fapi/v1/allOrders", q(limit.clamp(1, 500))).await?);
        if let Ok(v) = self.signed(reqwest::Method::GET, "/fapi/v1/allAlgoOrders", q(limit.clamp(1, 100))).await {
            out.extend(parse_algo_history(&v));
        }
        out.sort_by(|a, b| b.time.cmp(&a.time));
        Ok(out)
    }

    /// Fills of one symbol (newest first).
    pub async fn trade_history(&self, symbol: &str, limit: u32) -> Result<Vec<TradeRecord>, String> {
        let v = self.signed(reqwest::Method::GET, "/fapi/v1/userTrades", vec![("symbol".to_string(), symbol.to_string()), ("limit".to_string(), limit.clamp(1, 1000).to_string())]).await?;
        let mut out = parse_trade_history(&v);
        out.sort_by(|a, b| b.time.cmp(&a.time).then(b.id.cmp(&a.id)));
        Ok(out)
    }

    /// Current and maximum leverage of a symbol.
    pub async fn leverage(&self, symbol: &str) -> Result<LeverageInfo, String> {
        let acc = self.signed(reqwest::Method::GET, "/fapi/v2/account", vec![]).await?;
        let current = acc["positions"].as_array().and_then(|a| a.iter().find(|p| p["symbol"] == symbol)).map(|p| num(&p["leverage"])).unwrap_or(0.0);
        let brackets = self.signed(reqwest::Method::GET, "/fapi/v1/leverageBracket", vec![("symbol".to_string(), symbol.to_string())]).await.ok();
        let max = brackets.as_ref().and_then(|b| parse_max_leverage(b)).unwrap_or(20);
        Ok(LeverageInfo { leverage: if current >= 1.0 { current as u32 } else { 1 }, max_leverage: max })
    }

    async fn reference_price(&self, symbol: &str) -> Result<f64, String> {
        self.market.mark_price(symbol).await
    }

    /// Place one order.
    pub async fn place(&self, req: OrderRequest) -> Result<OrderAck, String> {
        let filters = self.market.symbol_filters(&req.symbol).await?;
        let reference = self.reference_price(&req.symbol).await?;
        let (qty, price, trigger) = prepare(&req, &filters, reference, self.max_notional)?;
        if let Some(trigger) = trigger {
            let v = self.signed(reqwest::Method::POST, "/fapi/v1/algoOrder", algo_params(&req, qty, price, trigger)).await?;
            return Ok(OrderAck { order_id: v["algoId"].as_i64().unwrap_or(0), symbol: req.symbol, status: "NEW".to_string(), client_id: text(&v["clientAlgoId"]), quantity: to_f64(qty), price: Some(to_f64(price.unwrap_or(trigger))), conditional: true });
        }
        let v = self.signed(reqwest::Method::POST, "/fapi/v1/order", order_params(&req, qty, price)).await?;
        Ok(OrderAck { order_id: v["orderId"].as_i64().unwrap_or(0), symbol: req.symbol, status: text(&v["status"]), client_id: text(&v["clientOrderId"]), quantity: to_f64(qty), price: price.map(to_f64), conditional: false })
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
                Ok((qty, price, None)) => prepared.push((i, order_params(r, qty, price))),
                Ok(_) => results[i] = Err("stops and take-profits are placed one at a time".into()),
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
                            Ok(OrderAck { order_id: item["orderId"].as_i64().unwrap_or(0), symbol: symbol.clone(), status: text(&item["status"]), client_id: text(&item["clientOrderId"]), quantity: num(&item["origQty"]), price: Some(num(&item["price"])), conditional: false })
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

    /// Move an open order to a new price (a drag on the chart). A limit order is amended in place; a stop or take-profit
    /// cannot be amended, so it is cancelled and re-placed - validated first, and put back if the new one is refused.
    pub async fn modify(&self, symbol: &str, order_id: i64, conditional: bool, new_price: Option<f64>, new_stop: Option<f64>) -> Result<OrderAck, String> {
        let open = self.open_orders(Some(symbol)).await?;
        let o = open.iter().find(|o| o.order_id == order_id && o.conditional == conditional).cloned().ok_or("That order is gone (filled or cancelled already).")?;
        let t = order_type_from(&o.order_type).filter(|t| *t != OrderType::Market).ok_or_else(|| format!("A {} order cannot be moved.", o.order_type))?;
        let side = if o.side == "BUY" { Side::Buy } else { Side::Sell };
        let req = OrderRequest {
            symbol: symbol.to_string(),
            side,
            order_type: t,
            quantity: o.orig_qty,
            price: if t.has_price() { Some(new_price.unwrap_or(o.price)) } else { None },
            stop_price: if t.is_conditional() { Some(new_stop.unwrap_or(o.stop_price)) } else { None },
            post_only: false,
            reduce_only: o.reduce_only,
            client_id: None,
        };
        let filters = self.market.symbol_filters(symbol).await?;
        let reference = self.reference_price(symbol).await?;
        let (qty, price, trigger) = prepare(&req, &filters, reference, self.max_notional)?;
        let ack = |id: i64, status: String, client_id: String, px: Option<Decimal>| OrderAck { order_id: id, symbol: symbol.to_string(), status, client_id, quantity: to_f64(qty), price: px.map(to_f64), conditional };
        if !conditional {
            let p = price.ok_or("a limit order needs a price")?;
            let params = vec![
                ("symbol".to_string(), symbol.to_string()),
                ("orderId".to_string(), order_id.to_string()),
                ("side".to_string(), side.as_str().to_string()),
                ("quantity".to_string(), qty.to_string()),
                ("price".to_string(), p.to_string()),
            ];
            let v = self.signed(reqwest::Method::PUT, "/fapi/v1/order", params).await?;
            return Ok(ack(v["orderId"].as_i64().unwrap_or(order_id), text(&v["status"]), text(&v["clientOrderId"]), Some(p)));
        }
        let trigger = trigger.ok_or("a stop needs a trigger price")?;
        self.cancel(symbol, order_id, true).await?;
        match self.signed(reqwest::Method::POST, "/fapi/v1/algoOrder", algo_params(&req, qty, price, trigger)).await {
            Ok(v) => Ok(ack(v["algoId"].as_i64().unwrap_or(0), "NEW".to_string(), text(&v["clientAlgoId"]), Some(price.unwrap_or(trigger)))),
            Err(e) => {
                // the new order was refused after the old one was cancelled: put the old one back
                let old = OrderRequest { price: if t.has_price() { Some(o.price) } else { None }, stop_price: Some(o.stop_price), ..req.clone() };
                let (oq, op, ot) = (filters.round_quantity(o.orig_qty), if t.has_price() { Some(filters.round_price(o.price)) } else { None }, filters.round_price(o.stop_price));
                let restored = self.signed(reqwest::Method::POST, "/fapi/v1/algoOrder", algo_params(&old, oq, op, ot)).await.is_ok();
                Err(format!("{e} ({})", if restored { "the original order was put back" } else { "the original order was cancelled and could NOT be restored" }))
            }
        }
    }

    /// Cancel one order. A stop / take-profit (`conditional`) is cancelled by its algo id.
    pub async fn cancel(&self, symbol: &str, order_id: i64, conditional: bool) -> Result<(), String> {
        if conditional {
            return self.signed(reqwest::Method::DELETE, "/fapi/v1/algoOrder", vec![("symbol".into(), symbol.into()), ("algoId".into(), order_id.to_string())]).await.map(|_| ());
        }
        self.signed(reqwest::Method::DELETE, "/fapi/v1/order", vec![("symbol".into(), symbol.into()), ("orderId".into(), order_id.to_string())]).await.map(|_| ())
    }

    /// Cancel every open order of a symbol, stops and take-profits included.
    pub async fn cancel_all(&self, symbol: &str) -> Result<(), String> {
        self.signed(reqwest::Method::DELETE, "/fapi/v1/allOpenOrders", vec![("symbol".into(), symbol.into())]).await?;
        if let Ok(v) = self.signed(reqwest::Method::GET, "/fapi/v1/openAlgoOrders", vec![("symbol".to_string(), symbol.to_string())]).await {
            for o in parse_algo_orders(&v) {
                self.cancel(symbol, o.order_id, true).await?;
            }
        }
        Ok(())
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
            stop_price: None,
            post_only: false,
            reduce_only: true,
            client_id: None,
        };
        let v = self.signed(reqwest::Method::POST, "/fapi/v1/order", order_params(&req, from_f64(qty), None)).await?;
        Ok(OrderAck { order_id: v["orderId"].as_i64().unwrap_or(0), symbol: symbol.to_string(), status: text(&v["status"]), client_id: text(&v["clientOrderId"]), quantity: qty, price: None, conditional: false })
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
        OrderRequest { symbol: "ETHUSDT".into(), side: Side::Buy, order_type: OrderType::Limit, quantity: qty, price: Some(price), stop_price: None, post_only: false, reduce_only: false, client_id: None }
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
        let (qty, price, trigger) = prepare(&limit(3000.567, 0.12345), &eth(), 3000.0, 5000.0).unwrap();
        assert!(trigger.is_none());
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

    fn stop(side: Side, t: OrderType, trigger: f64, price: Option<f64>) -> OrderRequest {
        OrderRequest { side, order_type: t, stop_price: Some(trigger), price, ..limit(0.0, 0.1) }
    }

    #[test]
    fn stops_and_take_profits_need_a_trigger_on_the_right_side_of_the_market() {
        let f = eth();
        // sell-stop below the market, buy-stop above, sell take-profit above, buy take-profit below
        assert!(prepare(&stop(Side::Sell, OrderType::StopMarket, 2900.0, None), &f, 3000.0, 5000.0).is_ok());
        assert!(prepare(&stop(Side::Sell, OrderType::StopMarket, 3100.0, None), &f, 3000.0, 5000.0).is_err());
        assert!(prepare(&stop(Side::Buy, OrderType::StopMarket, 3100.0, None), &f, 3000.0, 5000.0).is_ok());
        assert!(prepare(&stop(Side::Sell, OrderType::TakeProfitMarket, 3100.0, None), &f, 3000.0, 5000.0).is_ok());
        assert!(prepare(&stop(Side::Sell, OrderType::TakeProfitMarket, 2900.0, None), &f, 3000.0, 5000.0).is_err());
        assert!(prepare(&stop(Side::Buy, OrderType::TakeProfit, 2900.0, Some(2899.0)), &f, 3000.0, 5000.0).is_ok());
        // a stop-limit needs its limit price; a stop without a trigger is refused
        assert!(prepare(&stop(Side::Sell, OrderType::Stop, 2900.0, None), &f, 3000.0, 5000.0).is_err());
        let mut no_trigger = stop(Side::Sell, OrderType::StopMarket, 2900.0, None);
        no_trigger.stop_price = None;
        assert!(prepare(&no_trigger, &f, 3000.0, 5000.0).is_err());
    }

    #[test]
    fn conditional_orders_use_the_algo_parameters() {
        let r = stop(Side::Sell, OrderType::Stop, 2900.0, Some(2895.0));
        let p = algo_params(&r, from_f64(0.5), Some(from_f64(2895.0)), from_f64(2900.0));
        let get = |k: &str| p.iter().find(|(a, _)| a == k).map(|(_, v)| v.as_str());
        assert_eq!(get("algoType"), Some("CONDITIONAL"));
        assert_eq!(get("type"), Some("STOP"));
        assert_eq!(get("triggerPrice"), Some("2900"));
        assert_eq!(get("price"), Some("2895"));
        assert!(OrderType::StopMarket.is_conditional() && !OrderType::Limit.is_conditional());
        assert!(OrderType::TakeProfit.has_price() && !OrderType::TakeProfitMarket.has_price());
    }

    #[test]
    fn parses_algo_orders_and_the_leverage_bracket() {
        let o = parse_algo_orders(&json!([{"algoId": 99, "symbol": "ETHUSDT", "side": "SELL", "orderType": "STOP_MARKET", "triggerPrice": "2900", "quantity": "0.5", "algoStatus": "NEW", "reduceOnly": true, "clientAlgoId": "x"}]));
        assert_eq!(o.len(), 1);
        assert!(o[0].conditional && o[0].order_id == 99 && o[0].stop_price == 2900.0 && o[0].order_type == "STOP_MARKET");
        let m = parse_max_leverage(&json!([{"symbol": "ETHUSDT", "brackets": [{"bracket": 1, "initialLeverage": 100}, {"bracket": 2, "initialLeverage": 50}]}]));
        assert_eq!(m, Some(100));
    }

    #[test]
    fn order_names_map_to_the_types_that_can_be_moved() {
        assert_eq!(order_type_from("LIMIT"), Some(OrderType::Limit));
        assert_eq!(order_type_from("STOP_MARKET"), Some(OrderType::StopMarket));
        assert_eq!(order_type_from("TAKE_PROFIT"), Some(OrderType::TakeProfit));
        assert_eq!(order_type_from("TRAILING_STOP_MARKET"), None);
    }

    #[test]
    fn parses_order_and_trade_history() {
        let o = parse_order_history(&json!([{"orderId": 5, "symbol": "ETHUSDT", "side": "BUY", "type": "LIMIT", "status": "FILLED", "price": "3000", "avgPrice": "2999.5", "origQty": "0.5", "executedQty": "0.5", "reduceOnly": false, "time": 1700000000000u64, "updateTime": 1700000005000u64, "stopPrice": "0"}]));
        assert_eq!((o[0].status.as_str(), o[0].avg_price, o[0].executed_qty), ("FILLED", 2999.5, 0.5));
        let a = parse_algo_history(&json!([{"algoId": 9, "symbol": "ETHUSDT", "side": "SELL", "orderType": "STOP_MARKET", "algoStatus": "CANCELED", "triggerPrice": "2900", "quantity": "0.5", "createTime": 1700000100000u64}]));
        assert!(a[0].conditional && a[0].status == "CANCELED" && a[0].stop_price == 2900.0);
        let t = parse_trade_history(&json!([{"id": 11, "orderId": 5, "symbol": "ETHUSDT", "side": "BUY", "price": "2999.5", "qty": "0.5", "quoteQty": "1499.75", "realizedPnl": "0", "commission": "0.3", "commissionAsset": "USDT", "maker": true, "time": 1700000005000u64}]));
        assert_eq!((t[0].qty, t[0].commission, t[0].maker), (0.5, 0.3, true));
    }

    #[test]
    fn credentials_follow_the_environment() {
        // live never falls back to the legacy testnet variables
        std::env::remove_var("BINANCE_LIVE_API_KEY");
        std::env::remove_var("BINANCE_LIVE_API_SECRET");
        assert!(credentials(Env::Live).is_none());
    }
}
