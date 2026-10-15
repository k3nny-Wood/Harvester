//! Live kline streams. One task per (symbol, interval) reconnects with backoff and emits a Tauri
//! `kline` event for every update, so the Rust side owns the feed and the UI only listens.

use crate::market::{Env, Kline};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
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

#[derive(Default)]
pub struct Streams {
    tasks: Mutex<HashMap<String, JoinHandle<()>>>,
}

impl Streams {
    fn key(symbol: &str, interval: &str) -> String {
        format!("{}@{}", symbol.to_lowercase(), interval)
    }

    /// Start (or restart) the stream for a symbol / interval.
    pub fn subscribe(&self, app: Events, env: Env, symbol: &str, interval: &str) {
        let key = Self::key(symbol, interval);
        let url = format!("{}/ws/{}@kline_{}", env.ws_base(), symbol.to_lowercase(), interval);
        let task = crate::rt::spawn(async move {
            let mut backoff = 1u64;
            loop {
                match tokio_tungstenite::connect_async(&url).await {
                    Ok((mut ws, _)) => {
                        backoff = 1;
                        while let Some(msg) = ws.next().await {
                            match msg {
                                Ok(Message::Text(t)) => {
                                    if let Some(ev) = parse_kline_event(&t) {
                                        let _ = app.emit("kline", ev);
                                    }
                                }
                                Ok(Message::Close(_)) | Err(_) => break,
                                _ => {}
                            }
                        }
                    }
                    Err(_) => {}
                }
                tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
                backoff = (backoff * 2).min(30);
            }
        });
        if let Some(old) = self.tasks.lock().unwrap().insert(key, task) {
            old.abort();
        }
    }

    pub fn unsubscribe(&self, symbol: &str, interval: &str) {
        if let Some(t) = self.tasks.lock().unwrap().remove(&Self::key(symbol, interval)) {
            t.abort();
        }
    }
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
    fn ignores_other_messages() {
        assert!(parse_kline_event(r#"{"result":null,"id":1}"#).is_none());
        assert!(parse_kline_event("not json").is_none());
    }
}
