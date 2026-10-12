//! Live mark prices of every perpetual from ONE websocket (`!markPrice@arr@1s`, free of request weight), so the positions table
//! can show the mark price and unrealised P&L that Binance shows, second by second, instead of the value of the last REST read.
//! It follows the selected trading environment (testnet and mainnet prices differ).

use crate::market::Env;
use crate::trading::Trading;
use futures_util::StreamExt;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

pub type Marks = Arc<RwLock<HashMap<String, f64>>>;

/// (symbol, mark price) of each row of a `markPrice` array message.
pub fn parse_marks(text: &str) -> Vec<(String, f64)> {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return vec![] };
    let rows = v.get("data").and_then(|d| d.as_array()).or_else(|| v.as_array());
    rows.map(|rows| {
        rows.iter()
            .filter_map(|r| {
                let p = r.get("p")?.as_str()?.parse::<f64>().ok()?;
                let s = r.get("s")?.as_str()?.to_string();
                (p > 0.0).then_some((s, p))
            })
            .collect()
    })
    .unwrap_or_default()
}

pub fn start(trading: Arc<Trading>, marks: Marks) {
    tauri::async_runtime::spawn(async move {
        let mut backoff = 2u64;
        loop {
            let env = trading.env();
            let url = format!("{}/ws/!markPrice@arr@1s", env.ws_base());
            if let Ok((mut ws, _)) = tokio_tungstenite::connect_async(&url).await {
                backoff = 2;
                marks.write().unwrap().clear(); // the other environment's prices must not linger
                let mut env_check = tokio::time::interval(Duration::from_secs(3));
                loop {
                    tokio::select! {
                        msg = ws.next() => match msg {
                            Some(Ok(Message::Text(t))) => {
                                let rows = parse_marks(&t);
                                if !rows.is_empty() {
                                    let mut m = marks.write().unwrap();
                                    for (s, p) in rows {
                                        m.insert(s, p);
                                    }
                                }
                            }
                            Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                            _ => {}
                        },
                        _ = env_check.tick() => {
                            if trading.env() != env as Env { break; }
                        }
                    }
                }
            } else {
                backoff = (backoff * 2).min(60);
            }
            tokio::time::sleep(Duration::from_secs(backoff)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_mark_price_array() {
        let msg = r#"[{"e":"markPriceUpdate","E":1,"s":"BTCUSDT","p":"84001.20","i":"84000","r":"0.0001"},{"s":"X","p":"0"},{"s":"ETHUSDT","p":"2500.5"}]"#;
        let r = parse_marks(msg);
        assert_eq!(r, vec![("BTCUSDT".to_string(), 84001.2), ("ETHUSDT".to_string(), 2500.5)]);
        assert!(parse_marks("junk").is_empty());
    }
}
