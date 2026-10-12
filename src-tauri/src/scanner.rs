//! The signal scanner. Seeds a candle buffer for the busiest perpetuals over REST, then follows ONE combined kline
//! websocket for all of them, runs the signal engine whenever a symbol updates, and pushes results to the UI as Tauri events:
//!   `signals`        the full current list (throttled)
//!   `signal-new`     a newly triggered crack
//!   `scanner-status` progress / health
//! All numbers come from `harvester-core::signals`; this file only does I/O and bookkeeping.

use crate::market::{Env, Market};
use crate::stream::parse_kline_value;
use futures_util::StreamExt;
use harvester_core::candle::Candle;
use harvester_core::ladder::Side;
use harvester_core::ml::plan::{evaluate, MlParams};
use harvester_core::signals::{analyse, ml_signal, Signal, SignalKind, SignalParams};
use harvester_ml::Engine;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter};
use tokio_tungstenite::tungstenite::Message;

const MAX_CANDLES: usize = 700;
const SEED_CANDLES: u32 = 500;
/// A triggered crack or drop stays in the list this long after it was last seen.
const KEEP_MS: u64 = 6 * 3600 * 1000;

/// Which signal sources are on. Each can be switched off independently.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sources {
    pub qfl: bool,
    pub ml: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannerConfig {
    pub timeframe: String,
    /// how many of the busiest symbols to follow
    pub universe: usize,
    pub params: SignalParams,
    #[serde(default = "default_sources")]
    pub sources: Sources,
    #[serde(default)]
    pub ml: MlParams,
}

fn default_sources() -> Sources {
    Sources { qfl: true, ml: true }
}

impl Default for ScannerConfig {
    fn default() -> Self {
        ScannerConfig { timeframe: "15m".into(), universe: 40, params: SignalParams { fresh_bars: 8, ..Default::default() }, sources: default_sources(), ml: MlParams::default() }
    }
}

/// Where the ONNX models live: next to the app, or in the repository during development.
fn find_models_dir() -> Option<std::path::PathBuf> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("HARVESTER_MODELS") {
        candidates.push(p.into());
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            candidates.push(d.join("models/15m"));
            for up in ["..", "../..", "../../.."] {
                candidates.push(d.join(up).join("models/15m"));
            }
        }
    }
    candidates.push("models/15m".into());
    candidates.push("../models/15m".into());
    candidates.into_iter().find(|p| p.join("model_config_long.json").exists() || p.join("model_config_short.json").exists())
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScannerStatus {
    pub running: bool,
    pub phase: String,
    pub timeframe: String,
    pub symbols: usize,
    pub seeded: usize,
    pub updates: u64,
    pub last_update_ms: u64,
    pub crack_count: usize,
    pub near_count: usize,
    pub drop_count: usize,
    pub ml_count: usize,
    /// the ML models: loaded, or why not
    pub ml_status: String,
    pub error: Option<String>,
}

#[derive(Default)]
struct Inner {
    config: ScannerConfig,
    buffers: HashMap<String, Vec<Candle>>,
    last_run: HashMap<String, Instant>,
    signals: HashMap<String, Signal>,
    announced: HashSet<String>,
    status: ScannerStatus,
    last_emit: Option<Instant>,
    /// open time of the last closed candle each symbol was evaluated by the ML models on
    ml_done: HashMap<String, u64>,
}

#[derive(Default)]
pub struct Scanner {
    inner: Arc<Mutex<Inner>>,
    task: Mutex<Option<JoinHandle<()>>>,
    engine: Arc<Mutex<Option<Engine>>>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn rank(k: SignalKind) -> u8 {
    match k {
        SignalKind::Ml => 0,
        SignalKind::Crack => 1,
        SignalKind::Drop => 2,
        SignalKind::Near => 3,
    }
}

/// The list the UI shows: cracks first, then drops, then watches; best score first inside each group.
fn sorted(inner: &Inner) -> Vec<Signal> {
    let mut v: Vec<Signal> = inner.signals.values().cloned().collect();
    v.sort_by(|a, b| rank(a.kind).cmp(&rank(b.kind)).then(b.score.cmp(&a.score)).then(b.time_ms.cmp(&a.time_ms)));
    v
}

fn refresh_counts(inner: &mut Inner) {
    let count = |k: SignalKind| inner.signals.values().filter(|s| s.kind == k).count();
    let (c, n, d) = (count(SignalKind::Crack), count(SignalKind::Near), count(SignalKind::Drop));
    inner.status.ml_count = count(SignalKind::Ml);
    inner.status.crack_count = c;
    inner.status.near_count = n;
    inner.status.drop_count = d;
}

fn emit_status(app: &AppHandle, inner: &Inner) {
    let _ = app.emit("scanner-status", inner.status.clone());
}

fn emit_signals(app: &AppHandle, inner: &mut Inner, force: bool) {
    if !force && inner.last_emit.map_or(false, |t| t.elapsed() < Duration::from_millis(800)) {
        return;
    }
    inner.last_emit = Some(Instant::now());
    refresh_counts(inner);
    let _ = app.emit("signals", sorted(inner));
    emit_status(app, inner);
}

/// Run the engine for one symbol and fold the result into the signal map.
fn analyse_symbol(app: &AppHandle, engine: &Mutex<Option<Engine>>, inner: &mut Inner, symbol: &str) {
    let Some(candles) = inner.buffers.get(symbol) else { return };
    let cfg = inner.config.clone();
    let now = now_ms();
    let candles = candles.clone();

    // QFL / drop / watch signals
    if cfg.sources.qfl {
        let fresh = analyse(symbol, &cfg.timeframe, &candles, &cfg.params);
        // watches always reflect the present: drop this symbol's old ones first
        inner.signals.retain(|_, s| !(s.symbol == symbol && s.kind == SignalKind::Near));
        // a drop that is no longer a drop disappears; cracks are kept for KEEP_MS even after they stop being "fresh"
        let fresh_ids: HashSet<&str> = fresh.iter().map(|s| s.id.as_str()).collect();
        inner.signals.retain(|id, s| !(s.symbol == symbol && s.kind == SignalKind::Drop && !fresh_ids.contains(id.as_str())));
        for s in fresh {
            if s.kind == SignalKind::Crack && inner.announced.insert(s.id.clone()) {
                let _ = app.emit("signal-new", s.clone());
            }
            inner.signals.insert(s.id.clone(), s);
        }
    }
    inner.signals.retain(|_, s| !(matches!(s.kind, SignalKind::Crack | SignalKind::Ml) && now.saturating_sub(s.time_ms) > KEEP_MS));

    // ML entries: the models were trained on 15-minute candles, and a call is made once per CLOSED candle so it is stable
    if cfg.sources.ml && cfg.timeframe == "15m" {
        let tf_ms = 15 * 60 * 1000u64;
        let closed: &[Candle] = match candles.last() {
            Some(l) if l.open_time + tf_ms > now => &candles[..candles.len() - 1],
            _ => &candles[..],
        };
        if let Some(last) = closed.last() {
            if inner.ml_done.get(symbol) != Some(&last.open_time) {
                inner.ml_done.insert(symbol.to_string(), last.open_time);
                let calls = match engine.lock().unwrap().as_mut() {
                    Some(e) => evaluate(closed, &cfg.ml, |f, side| e.predict(f, side)),
                    None => vec![],
                };
                for call in calls {
                    let sig = ml_signal(symbol, &cfg.timeframe, closed, &call, cfg.params.thumb_bars);
                    if inner.announced.insert(sig.id.clone()) {
                        let _ = app.emit("signal-new", sig.clone());
                    }
                    inner.signals.insert(sig.id.clone(), sig);
                }
            }
        }
    }
}

fn apply_bar(buf: &mut Vec<Candle>, c: Candle) {
    match buf.last() {
        Some(l) if l.open_time == c.open_time => *buf.last_mut().unwrap() = c,
        Some(l) if c.open_time > l.open_time => {
            buf.push(c);
            if buf.len() > MAX_CANDLES {
                let drop = buf.len() - MAX_CANDLES;
                buf.drain(..drop);
            }
        }
        None => buf.push(c),
        _ => {}
    }
}

impl Scanner {
    pub fn status(&self) -> ScannerStatus {
        self.inner.lock().unwrap().status.clone()
    }

    pub fn signals(&self) -> Vec<Signal> {
        sorted(&self.inner.lock().unwrap())
    }

    pub fn config(&self) -> ScannerConfig {
        self.inner.lock().unwrap().config.clone()
    }

    /// Turn the QFL and ML sources on or off without restarting: the entries of a disabled source leave the list at once.
    pub fn set_sources(&self, app: &AppHandle, sources: Sources) {
        let mut g = self.inner.lock().unwrap();
        g.config.sources = sources;
        if !sources.qfl {
            g.signals.retain(|_, s| s.kind == SignalKind::Ml);
        }
        if !sources.ml {
            g.signals.retain(|_, s| s.kind != SignalKind::Ml);
            g.ml_done.clear();
        } else {
            g.ml_done.clear(); // evaluate every symbol again on the next update
        }
        emit_signals(app, &mut g, true);
    }

    pub fn stop(&self) {
        if let Some(t) = self.task.lock().unwrap().take() {
            t.abort();
        }
        let mut g = self.inner.lock().unwrap();
        g.status.running = false;
        g.status.phase = "stopped".into();
    }

    /// (Re)start with a configuration. Existing signals are cleared because they belong to the old timeframe.
    pub fn start(&self, app: AppHandle, market: Arc<Market>, config: ScannerConfig) {
        self.stop();
        {
            let mut g = self.inner.lock().unwrap();
            let ml_status = g.status.ml_status.clone();
            *g = Inner { config: config.clone(), ..Default::default() };
            g.status.ml_status = ml_status;
            g.status = ScannerStatus { running: true, phase: "loading symbols".into(), timeframe: config.timeframe.clone(), ..Default::default() };
            emit_status(&app, &g);
        }
        // load the ML models once; a failure only switches the ML source off, it never stops the scanner
        if self.engine.lock().unwrap().is_none() {
            let status = match find_models_dir().map(|d| Engine::load(&d)) {
                Some(Ok(e)) => {
                    let d = e.describe();
                    *self.engine.lock().unwrap() = Some(e);
                    d
                }
                Some(Err(e)) => format!("could not load: {e}"),
                None => "models not found (models/15m)".to_string(),
            };
            self.inner.lock().unwrap().status.ml_status = status;
        } else {
            let d = self.engine.lock().unwrap().as_ref().map(|e| e.describe()).unwrap_or_default();
            self.inner.lock().unwrap().status.ml_status = d;
        }
        let (inner, engine) = (self.inner.clone(), self.engine.clone());
        let task = tauri::async_runtime::spawn(async move { run(app, market, inner, engine, config).await });
        *self.task.lock().unwrap() = Some(task);
    }
}

fn set_phase(app: &AppHandle, inner: &Arc<Mutex<Inner>>, phase: &str, error: Option<String>) {
    let mut g = inner.lock().unwrap();
    g.status.phase = phase.to_string();
    g.status.error = error;
    emit_status(app, &g);
}

async fn run(app: AppHandle, market: Arc<Market>, inner: Arc<Mutex<Inner>>, engine: Arc<Mutex<Option<Engine>>>, cfg: ScannerConfig) {
    let mut backoff = 2u64;
    loop {
        // 1. the universe
        let symbols: Vec<String> = match market.symbols().await {
            Ok(q) => q.into_iter().map(|s| s.symbol).filter(|s| s.is_ascii()).take(cfg.universe).collect(),
            Err(e) => {
                set_phase(&app, &inner, "waiting to retry", Some(e));
                tokio::time::sleep(Duration::from_secs(backoff)).await;
                backoff = (backoff * 2).min(60);
                continue;
            }
        };
        {
            let mut g = inner.lock().unwrap();
            g.status.symbols = symbols.len();
            g.status.seeded = 0;
            g.status.phase = "loading history".into();
            emit_status(&app, &g);
        }

        // 2. seed every buffer (one polite request at a time)
        for (i, sym) in symbols.iter().enumerate() {
            match market.klines(sym, &cfg.timeframe, SEED_CANDLES, None, None).await {
                Ok(rows) => {
                    let candles: Vec<Candle> = rows.iter().map(|k| Candle::new(k.time, k.open, k.high, k.low, k.close, k.volume)).collect();
                    let mut g = inner.lock().unwrap();
                    g.buffers.insert(sym.clone(), candles);
                    analyse_symbol(&app, &engine, &mut g, sym);
                    g.status.seeded = i + 1;
                    if i % 5 == 4 || i + 1 == symbols.len() {
                        emit_signals(&app, &mut g, true);
                    }
                }
                Err(e) => {
                    let mut g = inner.lock().unwrap();
                    g.status.error = Some(format!("{sym}: {e}"));
                }
            }
            tokio::time::sleep(Duration::from_millis(220)).await;
        }
        {
            let mut g = inner.lock().unwrap();
            g.status.phase = "scanning live".into();
            emit_signals(&app, &mut g, true);
        }

        // 3. one combined websocket for all symbols
        let streams: Vec<String> = symbols.iter().map(|s| format!("{}@kline_{}", s.to_lowercase(), cfg.timeframe)).collect();
        let env: Env = market.env();
        let url = format!("{}/stream?streams={}", env.ws_base(), streams.join("/"));
        match tokio_tungstenite::connect_async(&url).await {
            Ok((mut ws, _)) => {
                backoff = 2;
                while let Some(msg) = ws.next().await {
                    let text = match msg {
                        Ok(Message::Text(t)) => t,
                        Ok(Message::Close(_)) | Err(_) => break,
                        _ => continue,
                    };
                    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                    let Some(ev) = parse_kline_value(v.get("data").unwrap_or(&v)) else { continue };
                    let c = Candle::new(ev.bar.time, ev.bar.open, ev.bar.high, ev.bar.low, ev.bar.close, ev.bar.volume);
                    let mut g = inner.lock().unwrap();
                    apply_bar(g.buffers.entry(ev.symbol.clone()).or_default(), c);
                    g.status.updates += 1;
                    g.status.last_update_ms = now_ms();
                    let due = g.last_run.get(&ev.symbol).map_or(true, |t| t.elapsed() >= Duration::from_secs(4));
                    if due {
                        g.last_run.insert(ev.symbol.clone(), Instant::now());
                        analyse_symbol(&app, &engine, &mut g, &ev.symbol);
                    }
                    emit_signals(&app, &mut g, false);
                }
                set_phase(&app, &inner, "reconnecting", None);
            }
            Err(e) => set_phase(&app, &inner, "waiting to retry", Some(format!("websocket: {e}"))),
        }
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(60);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(t: u64, close: f64) -> Candle {
        Candle::new(t, close, close + 1.0, close - 1.0, close, 10.0)
    }

    #[test]
    fn a_live_bar_replaces_the_forming_candle_and_a_new_one_appends() {
        let mut buf = vec![c(0, 1.0), c(900, 2.0)];
        apply_bar(&mut buf, c(900, 3.0));
        assert_eq!(buf.len(), 2);
        assert_eq!(buf[1].close, 3.0);
        apply_bar(&mut buf, c(1800, 4.0));
        assert_eq!(buf.len(), 3);
        apply_bar(&mut buf, c(100, 9.0)); // an old bar is ignored
        assert_eq!(buf.len(), 3);
    }

    #[test]
    fn the_buffer_is_capped() {
        let mut buf: Vec<Candle> = Vec::new();
        for i in 0..(MAX_CANDLES as u64 + 50) {
            apply_bar(&mut buf, c(i * 900, 1.0));
        }
        assert_eq!(buf.len(), MAX_CANDLES);
        assert_eq!(buf.last().unwrap().open_time, (MAX_CANDLES as u64 + 49) * 900);
    }

    #[test]
    fn cracks_sort_before_watches() {
        assert!(rank(SignalKind::Crack) < rank(SignalKind::Near));
        assert!(rank(SignalKind::Drop) < rank(SignalKind::Near));
    }
}
