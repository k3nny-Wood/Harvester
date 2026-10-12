//! The pump / dump watcher: ONE websocket with the last price of every perpetual (`!ticker@arr`, about one message a second), fed to the
//! detector in `harvester-core::movers`. A sudden move becomes a `pump` / `dump` signal in the scanner's list (with a 1-minute thumbnail
//! fetched for it), which gives it the Signals panel, the sound alerts and the click-to-open-chart for free.
//!
//! It always watches the REAL market (the testnet's prices are not a market), whatever environment trading is set to.

use crate::market::{Env, Market};
use crate::scanner::Injector;
use futures_util::StreamExt;
use harvester_core::candle::Candle;
use harvester_core::movers::{MoverDetector, Spike};
use harvester_core::signals::spike_signal;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tokio_tungstenite::tungstenite::Message;

pub type SharedDetector = Arc<Mutex<MoverDetector>>;

/// (symbol, event time ms, last price, 24 h quote volume) of every USDT perpetual in one `!ticker@arr` message.
pub fn parse_tickers(text: &str) -> Vec<(String, u64, f64, f64)> {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return vec![] };
    let rows = v.get("data").and_then(|d| d.as_array()).or_else(|| v.as_array());
    let num = |x: &Value| x.as_str().and_then(|s| s.parse::<f64>().ok()).or_else(|| x.as_f64()).unwrap_or(0.0);
    rows.map(|rows| {
        rows.iter()
            .filter_map(|t| {
                let s = t.get("s")?.as_str()?;
                // perpetual USDT contracts only (delivery contracts have an underscore, e.g. BTCUSDT_241227)
                if !s.ends_with("USDT") || !s.is_ascii() || s.contains('_') {
                    return None;
                }
                Some((s.to_string(), t.get("E").and_then(|e| e.as_u64()).unwrap_or(0), num(&t["c"]), num(&t["q"])))
            })
            .collect()
    })
    .unwrap_or_default()
}

pub fn start(app: AppHandle, market: Arc<Market>, injector: Injector, detector: SharedDetector) {
    // a worker fetches the 1-minute candles for the thumbnails one at a time, so a market-wide move cannot hammer the API
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Spike>(64);
    let (worker_app, worker_inj, worker_market) = (app.clone(), injector.clone(), market.clone());
    tauri::async_runtime::spawn(async move {
        while let Some(spike) = rx.recv().await {
            let candles: Vec<Candle> = worker_market.mainnet_klines(&spike.symbol, "1m", 70, None).await.map(|k| k.iter().map(|k| Candle::new(k.time, k.open, k.high, k.low, k.close, k.volume)).collect()).unwrap_or_default();
            worker_inj.add(&worker_app, spike_signal(&spike, &candles, 60));
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    });

    tauri::async_runtime::spawn(async move {
        let url = format!("{}/ws/!ticker@arr", Env::Live.ws_base());
        let mut backoff = 2u64;
        loop {
            match tokio_tungstenite::connect_async(&url).await {
                Ok((mut ws, _)) => {
                    backoff = 2;
                    let mut last_state = Instant::now() - Duration::from_secs(10);
                    while let Some(msg) = ws.next().await {
                        let text = match msg {
                            Ok(Message::Text(t)) => t,
                            Ok(Message::Close(_)) | Err(_) => break,
                            _ => continue,
                        };
                        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
                        let tickers = parse_tickers(&text);
                        let (spikes, state) = {
                            let mut d = detector.lock().unwrap();
                            let spikes: Vec<Spike> = tickers.iter().filter_map(|(s, t, p, q)| d.push(s, if *t > 0 { *t } else { now }, *p, *q)).collect();
                            let (n, ready) = d.watching(now);
                            (spikes, if ready == 0 { format!("warming up ({n} coins)") } else { format!("watching {ready} of {n} coins") })
                        };
                        if last_state.elapsed() >= Duration::from_secs(5) {
                            injector.set_state(&app, state);
                            last_state = Instant::now();
                        }
                        if injector.enabled() {
                            for s in spikes {
                                let _ = tx.try_send(s); // a full queue drops the spike: the market is melting down and the list already shows plenty
                            }
                        }
                    }
                    injector.set_state(&app, "reconnecting".to_string());
                }
                Err(e) => injector.set_state(&app, format!("no connection ({e})")),
            }
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(60);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_all_symbol_ticker_array_and_keeps_only_usdt_perpetuals() {
        let msg = r#"[{"e":"24hrTicker","E":1700000000123,"s":"BTCUSDT","c":"84000.50","q":"9876543210.5"},
                      {"e":"24hrTicker","E":1700000000123,"s":"ETHUSDT_241227","c":"2500","q":"1000"},
                      {"e":"24hrTicker","E":1700000000123,"s":"BTCUSD_PERP","c":"84000","q":"5"},
                      {"e":"24hrTicker","E":1700000000124,"s":"DOGEUSDT","c":"0.0871","q":"123456"}]"#;
        let t = parse_tickers(msg);
        assert_eq!(t.len(), 2);
        assert_eq!(t[0], ("BTCUSDT".to_string(), 1_700_000_000_123, 84000.5, 9_876_543_210.5));
        assert_eq!(t[1].0, "DOGEUSDT");
    }

    #[test]
    fn a_combined_stream_wrapper_and_garbage_are_handled() {
        let wrapped = r#"{"stream":"!ticker@arr","data":[{"E":5,"s":"XRPUSDT","c":"1.4","q":"10"}]}"#;
        assert_eq!(parse_tickers(wrapped).len(), 1);
        assert!(parse_tickers("not json").is_empty());
        assert!(parse_tickers("{}").is_empty());
    }
}
