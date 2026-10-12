//! The user-data stream: Binance pushes a message whenever an order, a fill or the account changes, so the UI
//! refreshes at once instead of waiting for the next poll. The stream only says *that* something changed; the
//! state itself is still read from the REST endpoints, which stay the source of truth. If the stream is down the
//! UI falls back to polling.

use crate::market::Env;
use crate::trading::{credentials, Trading};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UserStreamStatus {
    pub connected: bool,
}

/// What a user-data message means for the UI: Some(kind) when the orders / positions / balances changed.
pub fn classify(text: &str) -> Option<&'static str> {
    let v: Value = serde_json::from_str(text).ok()?;
    match v.get("e")?.as_str()? {
        "ORDER_TRADE_UPDATE" => Some("order"),
        "ALGO_UPDATE" => Some("order"),
        "ACCOUNT_UPDATE" => Some("account"),
        "TRADE_LITE" => Some("order"),
        "listenKeyExpired" => Some("expired"),
        _ => None,
    }
}

fn emit_status(app: &AppHandle, connected: bool) {
    let _ = app.emit("userstream", UserStreamStatus { connected });
}

/// Run the stream for the lifetime of the app; it follows the selected environment and reconnects with backoff.
pub fn start(app: AppHandle, trading: Arc<Trading>) {
    tauri::async_runtime::spawn(async move {
        let mut backoff = 2u64;
        loop {
            let env = trading.env();
            if credentials(env).is_none() {
                emit_status(&app, false);
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
            match run_once(&app, &trading, env).await {
                Ok(()) => backoff = 2,
                Err(_) => backoff = (backoff * 2).min(60),
            }
            emit_status(&app, false);
            tokio::time::sleep(Duration::from_secs(backoff)).await;
        }
    });
}

/// One connection. Returns when the stream drops, the key expires or the environment changes.
async fn run_once(app: &AppHandle, trading: &Arc<Trading>, env: Env) -> Result<(), String> {
    let key = trading.listen_key_start().await?;
    let url = format!("{}/ws/{}", env.ws_base(), key);
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.map_err(|e| e.to_string())?;
    emit_status(app, true);
    let _ = app.emit("account-changed", "connected");
    let mut keepalive = tokio::time::interval(Duration::from_secs(25 * 60));
    keepalive.tick().await; // the first tick fires at once
    let mut env_check = tokio::time::interval(Duration::from_secs(5));
    loop {
        tokio::select! {
            msg = ws.next() => match msg {
                Some(Ok(Message::Text(t))) => match classify(&t) {
                    Some("expired") => return Ok(()),
                    Some(kind) => { let _ = app.emit("account-changed", kind); }
                    None => {}
                },
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return Ok(()),
                _ => {}
            },
            _ = keepalive.tick() => { trading.listen_key_keepalive().await?; }
            _ = env_check.tick() => { if trading.env() != env { return Ok(()); } }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn order_and_account_events_mean_something_changed() {
        assert_eq!(classify(r#"{"e":"ORDER_TRADE_UPDATE","o":{"s":"BTCUSDT"}}"#), Some("order"));
        assert_eq!(classify(r#"{"e":"ALGO_UPDATE","o":{}}"#), Some("order"));
        assert_eq!(classify(r#"{"e":"ACCOUNT_UPDATE","a":{}}"#), Some("account"));
        assert_eq!(classify(r#"{"e":"listenKeyExpired"}"#), Some("expired"));
    }

    #[test]
    fn other_messages_are_ignored() {
        assert_eq!(classify(r#"{"e":"MARGIN_CALL"}"#), None);
        assert_eq!(classify("not json"), None);
        assert_eq!(classify(r#"{"x":1}"#), None);
    }
}
