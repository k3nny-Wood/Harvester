//! Held orders: limit orders the exchange would refuse because their price is too far from the market (the percent-price band). They
//! are kept here, saved to disk so they survive a restart, and sent to Binance automatically once the band has reached their price.
//!
//! Only while Harvester is running: nothing is sitting on the exchange. Orders are tied to the environment (testnet / live) they were
//! made in and are never sent to the other one.

use crate::market::Env;
use crate::trading::{OrderAck, OrderRequest, OrderType, Trading};
use harvester_core::held::{outside_band, ready_to_place};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const MAX_HELD: usize = 60;
/// An order is only sent when its price is this far (percent of the market price) inside the band's edge.
const MARGIN_PCT: f64 = 0.2;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HeldStatus {
    /// waiting for the market to come within range
    Held,
    /// sent to Binance
    Placed,
    /// the exchange refused it for a reason that waiting will not fix
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldOrder {
    pub id: String,
    pub env: Env,
    pub request: OrderRequest,
    pub created_ms: u64,
    pub status: HeldStatus,
    /// the last thing worth telling the trader (why it failed, or when it was sent)
    pub note: String,
    pub placed_order_id: Option<i64>,
}

/// What the watcher tells the UI when something changed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldEvent {
    pub id: String,
    pub symbol: String,
    pub status: HeldStatus,
    pub message: String,
}

pub struct HeldStore {
    path: PathBuf,
    items: Mutex<Vec<HeldOrder>>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Where the held orders are kept: next to the other Harvester data (%APPDATA%\Harvester), else beside the executable.
pub fn default_path() -> PathBuf {
    let base = std::env::var("APPDATA").ok().filter(|v| !v.is_empty()).map(PathBuf::from).or_else(|| std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf()))).unwrap_or_else(|| PathBuf::from("."));
    base.join("Harvester").join("held_orders.json")
}

impl HeldStore {
    pub fn open(path: PathBuf) -> HeldStore {
        let items = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Vec<HeldOrder>>(&b).ok()).unwrap_or_default();
        HeldStore { path, items: Mutex::new(items) }
    }

    fn save(&self, items: &[HeldOrder]) {
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // written to a temporary file first so a crash cannot leave half a file behind
        let tmp = self.path.with_extension("json.tmp");
        if let Ok(bytes) = serde_json::to_vec_pretty(items) {
            if std::fs::write(&tmp, bytes).is_ok() {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
    }

    pub fn list(&self, env: Env) -> Vec<HeldOrder> {
        self.items.lock().unwrap().iter().filter(|h| h.env == env).cloned().collect()
    }

    /// Orders still waiting, for the current environment.
    pub fn waiting(&self, env: Env) -> Vec<HeldOrder> {
        self.items.lock().unwrap().iter().filter(|h| h.env == env && h.status == HeldStatus::Held).cloned().collect()
    }

    pub fn add(&self, env: Env, request: OrderRequest) -> Result<HeldOrder, String> {
        let mut g = self.items.lock().unwrap();
        if g.iter().filter(|h| h.status == HeldStatus::Held).count() >= MAX_HELD {
            return Err(format!("There are already {MAX_HELD} held orders; cancel some first."));
        }
        let id = format!("hold-{}-{}", now_ms(), g.len());
        let order = HeldOrder { id, env, request, created_ms: now_ms(), status: HeldStatus::Held, note: String::new(), placed_order_id: None };
        g.push(order.clone());
        self.save(&g);
        Ok(order)
    }

    /// Remove an order from the list (a held one is simply never sent). True if it existed.
    pub fn cancel(&self, id: &str) -> bool {
        let mut g = self.items.lock().unwrap();
        let before = g.len();
        g.retain(|h| h.id != id);
        let changed = g.len() != before;
        if changed {
            self.save(&g);
        }
        changed
    }

    /// Change the price of an order that is still waiting.
    pub fn set_price(&self, id: &str, price: f64) -> Result<(), String> {
        if !(price > 0.0) || !price.is_finite() {
            return Err("The price must be greater than zero.".into());
        }
        let mut g = self.items.lock().unwrap();
        let h = g.iter_mut().find(|h| h.id == id && h.status == HeldStatus::Held).ok_or("That held order is no longer waiting.")?;
        h.request.price = Some(price);
        self.save(&g);
        Ok(())
    }

    fn update(&self, id: &str, status: HeldStatus, note: &str, placed: Option<i64>) {
        let mut g = self.items.lock().unwrap();
        if let Some(h) = g.iter_mut().find(|h| h.id == id) {
            h.status = status;
            h.note = note.to_string();
            h.placed_order_id = placed;
        }
        // finished orders are history: keep the latest few so the trader can see what happened
        let mut finished = 0;
        let mut i = g.len();
        while i > 0 {
            i -= 1;
            if g[i].status != HeldStatus::Held {
                finished += 1;
                if finished > 20 {
                    g.remove(i);
                }
            }
        }
        self.save(&g);
    }
}

fn is_plain_limit(req: &OrderRequest) -> bool {
    req.order_type == OrderType::Limit && req.stop_price.is_none()
}

fn held_ack(h: &HeldOrder, price: Option<f64>) -> OrderAck {
    OrderAck { order_id: 0, symbol: h.request.symbol.clone(), status: "HELD".to_string(), client_id: h.id.clone(), quantity: h.request.quantity, price, conditional: false }
}

/// Place a limit order, or hold it when its price is beyond what Binance accepts right now. Anything that is not a plain limit
/// (market, stop, take-profit) is placed as usual.
pub async fn place_or_hold(trading: &Arc<Trading>, store: &HeldStore, req: OrderRequest) -> Result<OrderAck, String> {
    if is_plain_limit(&req) {
        if let Some(price) = req.price {
            let filters = trading.market().symbol_filters(&req.symbol).await?;
            let mark = trading.market().mark_price(&req.symbol).await?;
            let rounded = harvester_core::decimal::to_f64(filters.round_price(price));
            if outside_band(rounded, mark, &filters) {
                // everything but the band must be right NOW (tick, step, minimum and maximum size): a held order should not fail later
                let (qty, _, _) = crate::trading::prepare(&req, &filters, rounded, trading.max_notional())?;
                // what is kept is what would be sent: rounded to the exchange's price tick and quantity step
                let h = store.add(trading.env(), OrderRequest { price: Some(rounded), quantity: harvester_core::decimal::to_f64(qty), ..req })?;
                return Ok(held_ack(&h, Some(rounded)));
            }
        }
    }
    trading.place(req).await
}

/// Place a ladder: every rung inside the band goes to Binance in one batch, the others are held. Results keep the order of `reqs`.
pub async fn place_many_or_hold(trading: &Arc<Trading>, store: &HeldStore, reqs: Vec<OrderRequest>) -> Result<Vec<Result<OrderAck, String>>, String> {
    let Some(first) = reqs.first() else { return Ok(vec![]) };
    let symbol = first.symbol.clone();
    let filters = trading.market().symbol_filters(&symbol).await?;
    let mark = trading.market().mark_price(&symbol).await?;
    let mut results: Vec<Option<Result<OrderAck, String>>> = (0..reqs.len()).map(|_| None).collect();
    let mut now: Vec<(usize, OrderRequest)> = Vec::new();
    for (i, r) in reqs.into_iter().enumerate() {
        let outside = is_plain_limit(&r) && r.price.map_or(false, |p| outside_band(harvester_core::decimal::to_f64(filters.round_price(p)), mark, &filters));
        if outside {
            let rounded = harvester_core::decimal::to_f64(filters.round_price(r.price.unwrap_or(0.0)));
            results[i] = Some(
                crate::trading::prepare(&r, &filters, rounded, trading.max_notional())
                    .and_then(|(qty, _, _)| store.add(trading.env(), OrderRequest { price: Some(rounded), quantity: harvester_core::decimal::to_f64(qty), ..r }))
                    .map(|h| held_ack(&h, Some(rounded))),
            );
        } else {
            now.push((i, r));
        }
    }
    if !now.is_empty() {
        let (idx, batch): (Vec<usize>, Vec<OrderRequest>) = now.into_iter().unzip();
        let placed = trading.place_many(batch).await?;
        for (i, r) in idx.into_iter().zip(placed) {
            results[i] = Some(r);
        }
    }
    Ok(results.into_iter().map(|r| r.unwrap_or_else(|| Err("not sent".into()))).collect())
}

/// The watcher: every few seconds, send every waiting order whose price the band has reached.
pub fn start(app: AppHandle, trading: Arc<Trading>, store: Arc<HeldStore>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;
            let waiting = store.waiting(trading.env());
            if waiting.is_empty() || !trading.status().has_credentials {
                continue;
            }
            let mut symbols: Vec<String> = waiting.iter().map(|h| h.request.symbol.clone()).collect();
            symbols.sort();
            symbols.dedup();
            for symbol in symbols {
                let (Ok(filters), Ok(mark)) = (trading.market().symbol_filters(&symbol).await, trading.market().mark_price(&symbol).await) else { continue };
                for h in waiting.iter().filter(|h| h.request.symbol == symbol) {
                    let Some(price) = h.request.price else { continue };
                    if !ready_to_place(price, mark, &filters, MARGIN_PCT) {
                        continue;
                    }
                    match trading.place(h.request.clone()).await {
                        Ok(ack) => {
                            let message = format!("{} {} {} @ {} was sent to Binance (the price came within its range)", h.request.side.as_str(), symbol, ack.quantity, price);
                            store.update(&h.id, HeldStatus::Placed, &message, Some(ack.order_id));
                            let _ = app.emit("held-changed", HeldEvent { id: h.id.clone(), symbol: symbol.clone(), status: HeldStatus::Placed, message });
                        }
                        Err(e) => {
                            // a refusal because the band moved a tick between the check and the request is just "not yet"
                            let band_race = e.contains("limit (") || e.contains("PERCENT_PRICE") || e.contains("-4016") || e.contains("-4024");
                            if !band_race {
                                let message = format!("Binance refused the held {} {} order: {e}", h.request.side.as_str(), symbol);
                                store.update(&h.id, HeldStatus::Failed, &message, None);
                                let _ = app.emit("held-changed", HeldEvent { id: h.id.clone(), symbol: symbol.clone(), status: HeldStatus::Failed, message });
                            }
                        }
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trading::Side;

    fn req(price: f64) -> OrderRequest {
        OrderRequest { symbol: "ETHUSDT".into(), side: Side::Buy, order_type: OrderType::Limit, quantity: 1.0, price: Some(price), stop_price: None, post_only: false, reduce_only: false, client_id: None }
    }

    fn temp_store(name: &str) -> HeldStore {
        let path = std::env::temp_dir().join(format!("harvester_held_test_{name}_{}.json", now_ms()));
        HeldStore::open(path)
    }

    #[test]
    fn added_orders_wait_and_survive_a_restart() {
        let s = temp_store("persist");
        let h = s.add(Env::Testnet, req(2700.0)).unwrap();
        assert_eq!(s.waiting(Env::Testnet).len(), 1);
        let reopened = HeldStore::open(s.path.clone());
        assert_eq!(reopened.waiting(Env::Testnet).len(), 1);
        assert_eq!(reopened.waiting(Env::Testnet)[0].id, h.id);
        let _ = std::fs::remove_file(&s.path);
    }

    #[test]
    fn an_order_is_only_ever_seen_in_its_own_environment() {
        let s = temp_store("env");
        s.add(Env::Testnet, req(2700.0)).unwrap();
        assert!(s.waiting(Env::Live).is_empty());
        assert_eq!(s.list(Env::Testnet).len(), 1);
        let _ = std::fs::remove_file(&s.path);
    }

    #[test]
    fn cancel_removes_and_the_price_of_a_waiting_order_can_change() {
        let s = temp_store("cancel");
        let h = s.add(Env::Testnet, req(2700.0)).unwrap();
        s.set_price(&h.id, 2650.0).unwrap();
        assert_eq!(s.waiting(Env::Testnet)[0].request.price, Some(2650.0));
        assert!(s.cancel(&h.id));
        assert!(!s.cancel(&h.id));
        assert!(s.set_price(&h.id, 1.0).is_err());
        let again = s.add(Env::Testnet, req(2500.0)).unwrap();
        assert!(s.set_price(&again.id, 0.0).is_err() && s.set_price(&again.id, f64::NAN).is_err());
        let _ = std::fs::remove_file(&s.path);
    }

    #[test]
    fn finished_orders_stop_waiting_and_only_the_latest_are_kept() {
        let s = temp_store("finished");
        let first = s.add(Env::Testnet, req(2700.0)).unwrap();
        s.update(&first.id, HeldStatus::Placed, "sent", Some(7));
        assert!(s.waiting(Env::Testnet).is_empty());
        assert_eq!(s.list(Env::Testnet)[0].placed_order_id, Some(7));
        for i in 0..30 {
            let h = s.add(Env::Testnet, req(2600.0 - i as f64)).unwrap();
            s.update(&h.id, HeldStatus::Failed, "refused", None);
        }
        assert!(s.list(Env::Testnet).len() <= 21);
        let _ = std::fs::remove_file(&s.path);
    }

    #[test]
    fn only_plain_limit_orders_can_be_held() {
        assert!(is_plain_limit(&req(1.0)));
        let stop = OrderRequest { order_type: OrderType::StopMarket, stop_price: Some(1.0), ..req(1.0) };
        assert!(!is_plain_limit(&stop));
        let market = OrderRequest { order_type: OrderType::Market, price: None, ..req(1.0) };
        assert!(!is_plain_limit(&market));
    }

    #[test]
    fn the_hold_limit_is_enforced() {
        let s = temp_store("cap");
        for i in 0..MAX_HELD {
            s.add(Env::Testnet, req(2000.0 + i as f64)).unwrap();
        }
        assert!(s.add(Env::Testnet, req(1.0)).is_err());
        let _ = std::fs::remove_file(&s.path);
    }
}
