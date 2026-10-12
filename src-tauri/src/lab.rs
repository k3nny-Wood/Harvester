//! The Lab commands: download public 15 m candles for the most liquid perpetuals of the REAL exchange (cached on disk, rate limited
//! so the exchange never bans the IP), then either run the QFL ladder backtest (`harvester_core::lab`) or replay the ML trade finder
//! over the same candles (`harvester_core::ml::forward`). Public data only, no API key.

use crate::market::{Kline, Market};
use harvester_core::candle::Candle;
use harvester_core::lab::{run_lab, LabConfig, LabReport, STEP_MS};
use harvester_core::ml::forward::{judge, report as forward_report, ForwardParams, ForwardReport, ForwardTrade};
use harvester_core::ml::plan::{evaluate, MlParams};
use harvester_ml::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabRequest {
    pub config: LabConfig,
    /// days of trading to test (the warm-up for the indicators and the gate comes on top)
    pub days: u32,
    /// how many of the busiest perpetuals
    pub universe: usize,
    pub luck_runs: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MlForwardRequest {
    pub days: u32,
    pub universe: usize,
    pub min_confidence: f64,
    pub reversal_filter: bool,
    pub forward: ForwardParams,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabProgress {
    pub phase: String,
    pub done: usize,
    pub total: usize,
}

#[derive(Default)]
pub struct Lab {
    running: AtomicBool,
    cancel: AtomicBool,
}

/// Days of candles needed before the first trade: the gate lookback, the Donchian window and the base detector's own warm-up.
pub fn warmup_days(cfg: &LabConfig) -> u32 {
    (cfg.gate_days.max(1) as u32) + 4
}

/// The ML features look at the last 333 candles (3.5 days of 15 m); a little more is loaded.
const ML_WARMUP_DAYS: u32 = 5;
const ML_WINDOW: usize = 333;

fn cache_dir() -> PathBuf {
    std::env::temp_dir().join("harvester_lab")
}

fn cache_path(symbol: &str, from_ms: u64) -> PathBuf {
    // the day the window starts on is part of the name, so a longer / shorter test never reads a mismatched file
    cache_dir().join(format!("{symbol}_15m_{}.json", from_ms / 86_400_000))
}

fn read_cache(path: &PathBuf) -> Option<Vec<Kline>> {
    let age = std::fs::metadata(path).ok()?.modified().ok()?.elapsed().ok()?;
    if age > Duration::from_secs(6 * 3600) {
        return None;
    }
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn to_candles(k: &[Kline]) -> Vec<Candle> {
    k.iter().map(|k| Candle::new(k.time, k.open, k.high, k.low, k.close, k.volume)).collect()
}

/// Keep at most `n` points of a curve (the first, the last and evenly spaced ones between).
pub fn thin(v: &[f64], n: usize) -> Vec<f64> {
    if v.len() <= n || n < 2 {
        return v.to_vec();
    }
    (0..n).map(|i| v[i * (v.len() - 1) / (n - 1)]).collect()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn emit_progress(app: &AppHandle, phase: &str, done: usize, total: usize) {
    let _ = app.emit("lab-progress", LabProgress { phase: phase.to_string(), done, total });
}

impl Lab {
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    fn begin(&self) -> Result<(), String> {
        if self.running.swap(true, Ordering::SeqCst) {
            return Err("A Lab run is already in progress.".into());
        }
        self.cancel.store(false, Ordering::Relaxed);
        Ok(())
    }

    pub async fn run(&self, app: AppHandle, market: Arc<Market>, req: LabRequest) -> Result<LabReport, String> {
        self.begin()?;
        let out = self.run_inner(&app, &market, req).await;
        self.running.store(false, Ordering::SeqCst);
        out
    }

    pub async fn run_ml_forward(&self, app: AppHandle, market: Arc<Market>, req: MlForwardRequest) -> Result<ForwardReport, String> {
        self.begin()?;
        let out = self.ml_forward_inner(&app, &market, req).await;
        self.running.store(false, Ordering::SeqCst);
        out
    }

    /// Download (or read from the cache) the 15 m candles of the busiest perpetuals from `from_ms` to now.
    async fn load_candles(&self, app: &AppHandle, market: &Arc<Market>, universe: usize, from_ms: u64) -> Result<HashMap<String, Vec<Candle>>, String> {
        emit_progress(app, "listing symbols", 0, 0);
        let symbols: Vec<String> = market.mainnet_top_symbols(universe).await?;
        let _ = std::fs::create_dir_all(cache_dir());
        let now = now_ms();
        let mut all: HashMap<String, Vec<Candle>> = HashMap::new();
        for (n, symbol) in symbols.iter().enumerate() {
            if self.cancel.load(Ordering::Relaxed) {
                return Err("Cancelled.".into());
            }
            emit_progress(app, "downloading candles", n, symbols.len());
            let path = cache_path(symbol, from_ms);
            let klines = match read_cache(&path) {
                Some(k) => k,
                None => {
                    let k = self.download(market, symbol, from_ms, now).await?;
                    if let Ok(bytes) = serde_json::to_vec(&k) {
                        let _ = std::fs::write(&path, bytes);
                    }
                    k
                }
            };
            if klines.len() > 500 {
                all.insert(symbol.clone(), to_candles(&klines));
            }
        }
        if all.len() < 5 {
            return Err("Fewer than 5 symbols had enough history.".into());
        }
        Ok(all)
    }

    async fn run_inner(&self, app: &AppHandle, market: &Arc<Market>, req: LabRequest) -> Result<LabReport, String> {
        let universe = req.universe.clamp(5, 120);
        let warm = warmup_days(&req.config);
        let total_days = req.days.clamp(14, 400) + warm;
        let from_ms = (now_ms() - total_days as u64 * 86_400_000) / STEP_MS * STEP_MS;
        let trade_from = from_ms + warm as u64 * 86_400_000;
        let all = self.load_candles(app, market, universe, from_ms).await?;
        emit_progress(app, "simulating", 0, 0);
        let cfg = req.config.clone();
        let runs = req.luck_runs.clamp(0, 200);
        let mut report = tauri::async_runtime::spawn_blocking(move || run_lab(&all, &cfg, trade_from, runs)).await.map_err(|e| e.to_string())?;
        report.base.equity = thin(&report.base.equity, 400);
        emit_progress(app, "done", 1, 1);
        Ok(report)
    }

    async fn ml_forward_inner(&self, app: &AppHandle, market: &Arc<Market>, req: MlForwardRequest) -> Result<ForwardReport, String> {
        let dir = crate::scanner::find_models_dir().ok_or("The ML models were not found (models/15m).")?;
        let engine = Engine::load(&dir)?;
        let universe = req.universe.clamp(5, 120);
        let total_days = req.days.clamp(7, 90) + ML_WARMUP_DAYS;
        let from_ms = (now_ms() - total_days as u64 * 86_400_000) / STEP_MS * STEP_MS;
        let scan_from = from_ms + ML_WARMUP_DAYS as u64 * 86_400_000;
        let all = self.load_candles(app, market, universe, from_ms).await?;
        let mut ml = MlParams::default();
        ml.min_confidence = req.min_confidence.clamp(0.5, 0.99);
        ml.reversal_filter = req.reversal_filter;
        let fwd = req.forward.clone();
        let handle = app.clone();
        let mut symbols: Vec<(String, Vec<Candle>)> = all.into_iter().collect();
        symbols.sort_by(|a, b| a.0.cmp(&b.0));
        let report = tauri::async_runtime::spawn_blocking(move || {
            let mut engine = engine;
            let total = symbols.len();
            let (mut trades, mut scanned): (Vec<ForwardTrade>, usize) = (Vec::new(), 0);
            for (n, (symbol, candles)) in symbols.iter().enumerate() {
                emit_progress(&handle, "scoring with the model", n, total);
                let first = candles.partition_point(|c| c.open_time < scan_from).max(ML_WINDOW);
                let mut quiet_until = 0usize;
                for i in first..candles.len().saturating_sub(1) {
                    scanned += 1;
                    if i < quiet_until {
                        continue;
                    }
                    let window = &candles[i + 1 - ML_WINDOW..=i];
                    let calls = evaluate(window, &ml, |f, side| engine.predict(f, side));
                    // one call per candle: the more confident side
                    if let Some(call) = calls.into_iter().max_by(|a, b| a.probability.partial_cmp(&b.probability).unwrap_or(std::cmp::Ordering::Equal)) {
                        if let Some(t) = judge(symbol, candles, i, call.side, &call.plan, &fwd) {
                            trades.push(t);
                            quiet_until = i + fwd.cooldown.max(1);
                        }
                    }
                }
            }
            let to_ms = symbols.iter().filter_map(|(_, c)| c.last()).map(|c| c.open_time + STEP_MS).max().unwrap_or(0);
            forward_report(&trades, total, scanned, scan_from, to_ms)
        })
        .await
        .map_err(|e| e.to_string())?;
        emit_progress(app, "done", 1, 1);
        Ok(report)
    }

    /// Page through the klines of one symbol, politely: one request per 250 ms, a pause and retry on a refusal.
    async fn download(&self, market: &Arc<Market>, symbol: &str, from_ms: u64, to_ms: u64) -> Result<Vec<Kline>, String> {
        let mut out: Vec<Kline> = Vec::new();
        let mut start = from_ms;
        while start < to_ms {
            if self.cancel.load(Ordering::Relaxed) {
                return Err("Cancelled.".into());
            }
            let mut page = None;
            for attempt in 0..3u64 {
                match market.mainnet_klines(symbol, "15m", 1000, Some(start)).await {
                    Ok(p) => {
                        page = Some(p);
                        break;
                    }
                    Err(_) if attempt < 2 => tokio::time::sleep(Duration::from_secs(10 * (attempt + 1))).await,
                    Err(e) => return Err(format!("{symbol}: {e}")),
                }
            }
            let page = page.unwrap_or_default();
            let Some(last) = page.last().map(|k| k.time) else { break };
            out.extend(page);
            start = last + STEP_MS;
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        out.dedup_by_key(|k| k.time);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thinning_keeps_the_ends_and_the_size() {
        let v: Vec<f64> = (0..1000).map(|i| i as f64).collect();
        let t = thin(&v, 400);
        assert_eq!(t.len(), 400);
        assert_eq!((t[0], t[399]), (0.0, 999.0));
        assert_eq!(thin(&v[..10], 400).len(), 10);
    }

    #[test]
    fn the_warm_up_covers_the_gate_lookback() {
        assert_eq!(warmup_days(&LabConfig::default()), 34);
    }

    #[test]
    fn the_cache_name_depends_on_the_window_start() {
        assert_ne!(cache_path("BTCUSDT", 0), cache_path("BTCUSDT", 86_400_000));
    }
}
