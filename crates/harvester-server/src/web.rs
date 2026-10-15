//! The web face of Harvester: serves the same page as the desktop window, answers its commands (`POST /api/<command>`) and pushes the
//! engine's events over a WebSocket (`/ws`). Every call needs the access token from `HARVESTER_WEB_TOKEN`: the page asks for it once.
//!
//! The token travels in an `Authorization: Bearer` header (and in the address of the WebSocket). A page on some other website cannot send that
//! header without the browser asking this server first, which it never allows, so no other site can place orders through it.

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use harvester_engine::core::Core;
use harvester_engine::events::Sink;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::services::{ServeDir, ServeFile};

pub type Bus = broadcast::Sender<(String, Value)>;

/// Hands the engine's events to every connected browser.
pub struct BusSink(pub Bus);

impl Sink for BusSink {
    fn emit(&self, event: &str, payload: Value) {
        let _ = self.0.send((event.to_string(), payload)); // nobody connected is not a problem
    }
}

#[derive(Clone)]
struct Shared {
    core: Arc<Core>,
    bus: Bus,
    token: Arc<String>,
}

/// Equal strings, in time that does not depend on where they first differ.
pub fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        diff |= (a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0)) as usize;
    }
    diff == 0
}

fn bearer(headers: &HeaderMap) -> &str {
    headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).unwrap_or("")
}

fn denied() -> Response {
    (StatusCode::UNAUTHORIZED, Json(json!({"error": "unauthorized"}))).into_response()
}

async fn api(State(s): State<Shared>, Path(cmd): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    if s.token.is_empty() || !same(bearer(&headers), &s.token) {
        return denied();
    }
    let args: Value = if body.is_empty() { Value::Null } else { serde_json::from_slice(&body).unwrap_or(Value::Null) };
    match s.core.dispatch(&cmd, &args).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response(),
    }
}

async fn ws(State(s): State<Shared>, Query(q): Query<HashMap<String, String>>, upgrade: WebSocketUpgrade) -> Response {
    if s.token.is_empty() || !same(q.get("token").map(String::as_str).unwrap_or(""), &s.token) {
        return denied();
    }
    let rx = s.bus.subscribe();
    upgrade.on_upgrade(move |socket| client(socket, rx))
}

async fn client(mut socket: WebSocket, mut rx: broadcast::Receiver<(String, Value)>) {
    loop {
        tokio::select! {
            event = rx.recv() => match event {
                Ok((name, payload)) => {
                    if socket.send(Message::Text(json!({"event": name, "payload": payload}).to_string())).await.is_err() {
                        break;
                    }
                }
                // a slow browser misses some events (candles are replaced by the next one anyway)
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
        }
    }
}

pub fn router(core: Arc<Core>, bus: Bus, token: String, dir: PathBuf) -> Router {
    let shared = Shared { core, bus, token: Arc::new(token) };
    let pages = ServeDir::new(&dir).fallback(ServeFile::new(dir.join("index.html")));
    Router::new()
        .route("/api/:cmd", post(api))
        .route("/ws", get(ws))
        .fallback_service(pages)
        // an AI analysis carries a picture of the chart
        .layer(DefaultBodyLimit::max(25 * 1024 * 1024))
        .with_state(shared)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use harvester_engine::events::Events;
    use tower::ServiceExt;

    fn app() -> Router {
        let (bus, _) = broadcast::channel(16);
        router(Core::new(Events::none(), false), bus, "secret-token".into(), PathBuf::from("does-not-exist"))
    }

    async fn call(app: Router, auth: Option<&str>, uri: &str, body: &str) -> (StatusCode, Value) {
        let mut req = Request::post(uri).header("content-type", "application/json");
        if let Some(a) = auth {
            req = req.header("authorization", a);
        }
        let res = app.oneshot(req.body(Body::from(body.to_string())).unwrap()).await.unwrap();
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    #[test]
    fn tokens_are_compared_in_full() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd") && !same("abc", "ab") && !same("", "a"));
        assert!(same("", ""));
    }

    #[tokio::test]
    async fn a_call_needs_the_token() {
        for auth in [None, Some("Bearer wrong"), Some("secret-token"), Some("Bearer ")] {
            let (status, _) = call(app(), auth, "/api/scanner_config", "{}").await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{auth:?}");
        }
    }

    #[tokio::test]
    async fn a_call_with_the_token_is_answered() {
        let (status, v) = call(app(), Some("Bearer secret-token"), "/api/scanner_config", "{}").await;
        assert_eq!(status, StatusCode::OK);
        assert!(v.is_object(), "{v}");
        let (status, v) = call(app(), Some("Bearer secret-token"), "/api/ai_models", "").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v.as_array().map(|a| a.len()), Some(2));
    }

    #[tokio::test]
    async fn an_error_is_a_400_with_the_message() {
        let (status, v) = call(app(), Some("Bearer secret-token"), "/api/nonsense", "{}").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(v["error"].as_str().unwrap().contains("unknown command"), "{v}");
        let (status, v) = call(app(), Some("Bearer secret-token"), "/api/symbol_filters", "{}").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(v["error"].as_str().unwrap().contains("symbol"), "{v}");
    }

    #[tokio::test]
    async fn an_empty_token_setting_locks_everything() {
        let (bus, _) = broadcast::channel(16);
        let app = router(Core::new(Events::none(), false), bus, String::new(), PathBuf::from("x"));
        let (status, _) = call(app, Some("Bearer "), "/api/scanner_config", "{}").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
}
