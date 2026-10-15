//! Armed brackets: the take-profit and stop-loss of an entry order that has not filled yet. Binance refuses (or instantly fires) a
//! protective order that sits on the wrong side of the CURRENT price, which is exactly where the exit of a breakout entry is until the
//! entry has triggered. So those exits wait here, saved to disk, and are sent the moment the entry has become a position.
//!
//! Only while Harvester is running. Tied to the environment they were made in.

use crate::held::{HeldEvent, HeldStatus};
use crate::market::Env;
use crate::trading::{OrderRequest, OrderType, Side, Trading};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use crate::events::Events;

const MAX_AGE_MS: u64 = 7 * 24 * 3600 * 1000;
/// Consecutive checks (about 2 s apart) with the entry neither open nor a position before the bracket is given up.
const GONE_CHECKS: u32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bracket {
    pub id: String,
    pub env: Env,
    pub symbol: String,
    /// the entry is a buy (the exits sell) or a sell (the exits buy)
    pub long: bool,
    pub take_profit: f64,
    pub stop_loss: f64,
    /// the entry order on the exchange (0 when it is held on this computer and cannot be looked up)
    pub entry_order_id: i64,
    pub entry_conditional: bool,
    /// the planned size of the whole entry (a ladder fills in pieces); the exits cover it. 0 = use the position when it appears
    #[serde(default)]
    pub quantity: f64,
    pub created_ms: u64,
}

pub struct BracketStore {
    path: PathBuf,
    items: Mutex<Vec<Bracket>>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn default_path() -> PathBuf {
    let base = std::env::var("APPDATA").ok().filter(|v| !v.is_empty()).map(PathBuf::from).or_else(|| std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf()))).unwrap_or_else(|| PathBuf::from("."));
    base.join("Harvester").join("armed_brackets.json")
}

impl BracketStore {
    pub fn open(path: PathBuf) -> BracketStore {
        let items = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Vec<Bracket>>(&b).ok()).unwrap_or_default();
        BracketStore { path, items: Mutex::new(items) }
    }

    fn save(&self, items: &[Bracket]) {
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = self.path.with_extension("json.tmp");
        if let Ok(bytes) = serde_json::to_vec_pretty(items) {
            if std::fs::write(&tmp, bytes).is_ok() {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
    }

    pub fn list(&self, env: Env) -> Vec<Bracket> {
        self.items.lock().unwrap().iter().filter(|b| b.env == env).cloned().collect()
    }

    pub fn add(&self, env: Env, symbol: String, long: bool, take_profit: f64, stop_loss: f64, entry_order_id: i64, entry_conditional: bool, quantity: f64) -> Result<Bracket, String> {
        // 0 means "none": a take-profit or a stop-loss alone is allowed, both missing is not
        if !(take_profit >= 0.0 && stop_loss >= 0.0 && (take_profit > 0.0 || stop_loss > 0.0)) {
            return Err("At least one of the take-profit and the stop-loss is needed, and neither may be negative.".into());
        }
        let mut g = self.items.lock().unwrap();
        let b = Bracket { id: format!("brk-{}-{}", now_ms(), g.len()), env, symbol, long, take_profit, stop_loss, entry_order_id, entry_conditional, quantity: quantity.max(0.0), created_ms: now_ms() };
        g.push(b.clone());
        self.save(&g);
        Ok(b)
    }

    pub fn cancel(&self, id: &str) -> bool {
        let mut g = self.items.lock().unwrap();
        let before = g.len();
        g.retain(|b| b.id != id);
        let changed = g.len() != before;
        if changed {
            self.save(&g);
        }
        changed
    }
}

#[derive(Debug, PartialEq)]
pub enum Action {
    Wait,
    /// the entry is a position: send the exits for this many units
    Place(f64),
    Drop(&'static str),
}

/// What to do with a bracket, given the position the account holds in the symbol (signed), whether the entry order is still listed as
/// open (None = not known), how many checks in a row it was missing, and the time.
pub fn decide(b: &Bracket, position: f64, entry_listed: Option<bool>, missing_checks: u32, now: u64) -> Action {
    if (b.long && position > 0.0) || (!b.long && position < 0.0) {
        return Action::Place(position.abs());
    }
    if now.saturating_sub(b.created_ms) > MAX_AGE_MS {
        return Action::Drop("it waited more than 7 days");
    }
    if b.entry_order_id != 0 && entry_listed == Some(false) && missing_checks >= GONE_CHECKS {
        return Action::Drop("the entry order is no longer open (cancelled or expired) and there is no position");
    }
    Action::Wait
}

fn exit_request(b: &Bracket, qty: f64, kind: OrderType, trigger: f64) -> OrderRequest {
    OrderRequest { symbol: b.symbol.clone(), side: if b.long { Side::Sell } else { Side::Buy }, order_type: kind, quantity: qty, price: None, stop_price: Some(trigger), post_only: false, reduce_only: true, client_id: None }
}

pub fn start(app: Events, trading: Arc<Trading>, store: Arc<BracketStore>) {
    crate::rt::spawn(async move {
        let mut missing: HashMap<String, u32> = HashMap::new();
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let pending = store.list(trading.env());
            if pending.is_empty() || !trading.status().has_credentials {
                continue;
            }
            let Ok(account) = trading.account().await else { continue };
            for b in pending {
                let position = account.positions.iter().find(|p| p.symbol == b.symbol).map(|p| p.amount).unwrap_or(0.0);
                let listed = match trading.open_orders(Some(&b.symbol)).await {
                    Ok(orders) => Some(orders.iter().any(|o| o.order_id == b.entry_order_id && o.conditional == b.entry_conditional)),
                    Err(_) => None,
                };
                let n = missing.entry(b.id.clone()).or_insert(0);
                match listed {
                    Some(false) => *n += 1,
                    Some(true) => *n = 0,
                    None => {}
                }
                let say = |status: HeldStatus, message: String| {
                    let _ = app.emit("held-changed", HeldEvent { id: b.id.clone(), symbol: b.symbol.clone(), status, message });
                };
                match decide(&b, position, listed, *n, now_ms()) {
                    Action::Wait => {}
                    Action::Drop(why) => {
                        store.cancel(&b.id);
                        missing.remove(&b.id);
                        say(HeldStatus::Failed, format!("The armed take-profit / stop-loss for {} was dropped: {why}.", b.symbol));
                    }
                    Action::Place(position_qty) => {
                        // a ladder fills in pieces: the exits cover the planned total, not just what has filled so far (reduce-only caps them at the position)
                        let qty = if b.quantity > 0.0 { b.quantity.max(position_qty) } else { position_qty };
                        store.cancel(&b.id);
                        missing.remove(&b.id);
                        let mut failed = Vec::new();
                        let mut wanted = Vec::new();
                        if b.take_profit > 0.0 {
                            wanted.push(("take-profit", exit_request(&b, qty, OrderType::TakeProfitMarket, b.take_profit)));
                        }
                        if b.stop_loss > 0.0 {
                            wanted.push(("stop-loss", exit_request(&b, qty, OrderType::StopMarket, b.stop_loss)));
                        }
                        for (label, req) in wanted {
                            if let Err(e) = trading.place(req).await {
                                failed.push(format!("{label}: {e}"));
                            }
                        }
                        if failed.is_empty() {
                            let placed: Vec<String> = [("take-profit", b.take_profit), ("stop-loss", b.stop_loss)].iter().filter(|(_, v)| *v > 0.0).map(|(l, v)| format!("{l} {v}")).collect();
                            say(HeldStatus::Placed, format!("{} entry filled: {} now on Binance", b.symbol, placed.join(" and ")));
                        } else {
                            say(HeldStatus::Failed, format!("{} entry filled but NOT fully protected - {}. Check the position now.", b.symbol, failed.join("; ")));
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

    fn bracket(long: bool, entry_id: i64) -> Bracket {
        Bracket { id: "b".into(), env: Env::Testnet, symbol: "ETHUSDT".into(), long, take_profit: 110.0, stop_loss: 95.0, entry_order_id: entry_id, entry_conditional: true, quantity: 0.0, created_ms: 1_000 }
    }

    #[test]
    fn a_position_in_the_entry_direction_arms_the_exits_for_its_size() {
        assert_eq!(decide(&bracket(true, 7), 0.5, Some(true), 0, 2_000), Action::Place(0.5));
        assert_eq!(decide(&bracket(false, 7), -2.0, Some(false), 0, 2_000), Action::Place(2.0));
    }

    #[test]
    fn a_position_the_other_way_is_not_the_entry() {
        assert_eq!(decide(&bracket(true, 7), -1.0, Some(true), 0, 2_000), Action::Wait);
    }

    #[test]
    fn the_bracket_waits_while_the_entry_is_open_and_is_dropped_only_after_it_was_gone_several_checks() {
        assert_eq!(decide(&bracket(true, 7), 0.0, Some(true), 0, 2_000), Action::Wait);
        assert_eq!(decide(&bracket(true, 7), 0.0, Some(false), 1, 2_000), Action::Wait);
        assert!(matches!(decide(&bracket(true, 7), 0.0, Some(false), GONE_CHECKS, 2_000), Action::Drop(_)));
        // a failed lookup never drops it
        assert_eq!(decide(&bracket(true, 7), 0.0, None, 9, 2_000), Action::Wait);
    }

    #[test]
    fn an_entry_that_cannot_be_looked_up_only_expires_by_age() {
        assert_eq!(decide(&bracket(true, 0), 0.0, Some(false), 9, 2_000), Action::Wait);
        assert!(matches!(decide(&bracket(true, 0), 0.0, None, 0, 1_000 + MAX_AGE_MS + 1), Action::Drop(_)));
    }

    #[test]
    fn the_exits_are_reduce_only_and_on_the_opposite_side() {
        let long = exit_request(&bracket(true, 7), 1.5, OrderType::StopMarket, 95.0);
        assert_eq!(long.side, Side::Sell);
        assert!(long.reduce_only && long.stop_price == Some(95.0) && long.quantity == 1.5);
        assert_eq!(exit_request(&bracket(false, 7), 1.5, OrderType::TakeProfitMarket, 90.0).side, Side::Buy);
    }

    #[test]
    fn the_store_keeps_brackets_per_environment_and_survives_a_restart() {
        let path = std::env::temp_dir().join(format!("harvester_brackets_test_{}.json", now_ms()));
        let s = BracketStore::open(path.clone());
        let b = s.add(Env::Testnet, "ETHUSDT".into(), true, 110.0, 95.0, 7, true, 2.5).unwrap();
        assert_eq!(b.quantity, 2.5);
        // one exit alone is fine, none (or a negative one) is not
        assert!(s.add(Env::Testnet, "ETHUSDT".into(), true, 0.0, 95.0, 8, true, 0.0).is_ok());
        assert!(s.add(Env::Testnet, "ETHUSDT".into(), true, 0.0, 0.0, 9, true, 0.0).is_err());
        assert!(s.add(Env::Testnet, "ETHUSDT".into(), true, -1.0, 95.0, 9, true, 0.0).is_err());
        s.cancel(&s.list(Env::Testnet)[1].id);
        assert_eq!(BracketStore::open(path.clone()).list(Env::Testnet).len(), 1);
        assert!(s.list(Env::Live).is_empty());
        assert!(s.cancel(&b.id) && !s.cancel(&b.id));
        let _ = std::fs::remove_file(&path);
    }
}
