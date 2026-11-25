//! Live kline streams. One task per (symbol, interval) reconnects with backoff and emits a Tauri
//! `kline` event for every update, so the Rust side owns the feed and the UI only listens.

use crate::market::{Env, Kline};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use futures_util::SinkExt;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use crate::events::Events;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KlineEvent {
    pub symbol: String,
    pub interval: String,
    pub bar: Kline,
    pub closed: bool,
}

fn num(v: &Value) -> f64 {
    v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_f64()).unwrap_or(0.0)
}

/// Parse one `kline` event (the object Binance sends, or the `data` of a combined-stream message).
pub fn parse_kline_value(v: &Value) -> Option<KlineEvent> {
    let k = v.get("k")?;
    Some(KlineEvent {
        symbol: v.get("s").or_else(|| k.get("s"))?.as_str()?.to_string(),
        interval: k.get("i")?.as_str()?.to_string(),
        bar: Kline { time: k.get("t")?.as_u64()?, open: num(&k["o"]), high: num(&k["h"]), low: num(&k["l"]), close: num(&k["c"]), volume: num(&k["v"]) },
        closed: k.get("x").and_then(|x| x.as_bool()).unwrap_or(false),
    })
}

/// Parse one `kline` websocket message.
pub fn parse_kline_event(text: &str) -> Option<KlineEvent> {
    parse_kline_value(&serde_json::from_str::<Value>(text).ok()?)
}

/// How long a subscription lives without being renewed. Every screen that shows a chart renews its subscription every 30 s, so a stream that
/// nobody looks at any more (a closed browser tab, a phone that went to sleep) ends by itself, while one that ANY screen still shows keeps running.
const LEASE_MS: u64 = 120_000;
/// A stream that has said nothing, not even a pong, for this long is dead (a stalled socket never reports it): it is reconnected.
const SILENCE_LIMIT: Duration = Duration::from_secs(40);
const PING_EVERY: Duration = Duration::from_secs(15);

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

struct Entry {
    env: Env,
    lease: Arc<AtomicU64>,
    task: JoinHandle<()>,
}

/// What `subscribe` must do for a stream that may already exist: nothing but renew it, or (re)start it.
fn must_start(existing: Option<(Env, bool)>, env: Env) -> bool {
    match existing {
        Some((e, finished)) => e != env || finished,
        None => true,
    }
}

#[derive(Default)]
pub struct Streams {
    tasks: Mutex<HashMap<String, Entry>>,
}

impl Streams {
    fn key(symbol: &str, interval: &str) -> String {
        format!("{}@{}", symbol.to_lowercase(), interval)
    }

    /// Start the stream for a symbol / interval, or renew the one that already runs. Several screens (the desktop window, a browser, the phone,
    /// two chart tabs of the same coin) share ONE stream: it is kept alive by renewals, not by who subscribed first or last.
    pub fn subscribe(&self, app: Events, env: Env, symbol: &str, interval: &str) {
        let key = Self::key(symbol, interval);
        let mut tasks = self.tasks.lock().unwrap();
        let existing = tasks.get(&key).map(|e| (e.env, e.task.is_finished()));
        if !must_start(existing, env) {
            if let Some(e) = tasks.get(&key) {
                e.lease.store(now_ms() + LEASE_MS, Ordering::Relaxed);
            }
            return;
        }
        if let Some(old) = tasks.remove(&key) {
            old.task.abort();
        }
        tasks.retain(|_, e| !e.task.is_finished());
        let lease = Arc::new(AtomicU64::new(now_ms() + LEASE_MS));
        let task_lease = lease.clone();
        let url = format!("{}/ws/{}@kline_{}", env.ws_market(), symbol.to_lowercase(), interval);
        let task = crate::rt::spawn(async move {
            let mut backoff = 1u64;
            while now_ms() < task_lease.load(Ordering::Relaxed) {
                if let Ok((mut ws, _)) = tokio_tungstenite::connect_async(&url).await {
                    backoff = 1;
                    let mut last_heard = Instant::now();
                    let mut ping = tokio::time::interval(PING_EVERY);
                    loop {
                        tokio::select! {
                            msg = ws.next() => {
                                last_heard = Instant::now();
                                match msg {
                                    Some(Ok(Message::Text(t))) => {
                                        if let Some(ev) = parse_kline_event(&t) {
                                            let _ = app.emit("kline", ev);
                                        }
                                    }
                                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                                    _ => {}
                                }
                            }
                            _ = ping.tick() => {
                                if now_ms() >= task_lease.load(Ordering::Relaxed) {
                                    return; // nobody has asked for it lately
                                }
                                if last_heard.elapsed() > SILENCE_LIMIT {
                                    break; // dead without having said so: reconnect
                                }
                                let _ = ws.send(Message::Ping(Vec::<u8>::new().into())).await;
                            }
                        }
                    }
                }
                tokio::time::sleep(Duration::from_secs(backoff)).await;
                backoff = (backoff * 2).min(30);
            }
        });
        tasks.insert(key, Entry { env, lease, task });
    }

    /// Kept for the callers that say they are done. It does nothing by itself: another screen may still show the same chart, so the stream
    /// simply ends when nobody renews it any more.
    pub fn unsubscribe(&self, _symbol: &str, _interval: &str) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_kline_message() {
        let msg = r#"{"e":"kline","E":1700000000500,"s":"BTCUSDT","k":{"t":1700000000000,"T":1700000059999,"s":"BTCUSDT","i":"1m","o":"100","c":"101","h":"102","l":"99","v":"12.5","x":false}}"#;
        let ev = parse_kline_event(msg).unwrap();
        assert_eq!(ev.symbol, "BTCUSDT");
        assert_eq!(ev.interval, "1m");
        assert_eq!(ev.bar.close, 101.0);
        assert!(!ev.closed);
    }

    #[test]
    fn a_running_stream_is_only_renewed_not_restarted() {
        assert!(must_start(None, Env::Live));
        assert!(!must_start(Some((Env::Live, false)), Env::Live));
        assert!(must_start(Some((Env::Live, true)), Env::Live), "a finished stream is started again");
        assert!(must_start(Some((Env::Testnet, false)), Env::Live), "another environment needs its own connection");
    }

    #[test]
    fn ignores_other_messages() {
        assert!(parse_kline_event(r#"{"result":null,"id":1}"#).is_none());
        assert!(parse_kline_event("not json").is_none());
    }
}
