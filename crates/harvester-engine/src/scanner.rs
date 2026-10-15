//! The signal scanner. Seeds a candle buffer for the busiest perpetuals over REST, then follows ONE combined kline
//! websocket for all of them, runs the signal engine whenever a symbol updates, and pushes results to the UI as Tauri events:
//!   `signals`        the full current list (throttled)
//!   `signal-new`     a newly triggered crack
//!   `scanner-status` progress / health
//! All numbers come from `harvester-core::signals`; this file only does I/O and bookkeeping.

use crate::market::{Env, Market};
use crate::stream::parse_kline_value;
use futures_util::{stream, StreamExt};
use harvester_core::candle::Candle;
use harvester_core::signals::{analyse, analyse_drop, Signal, SignalKind, SignalParams};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::task::JoinHandle;
use crate::events::Events;
use tokio_tungstenite::tungstenite::Message;

const MAX_CANDLES: usize = 700;
const SEED_CANDLES: u32 = 500;
/// The first, quick pass: just enough recent candles to find drops (weight 1 per request on Binance, so it can run wide and fast).
const FAST_CANDLES: u32 = 99;
const FAST_PARALLEL: usize = 10;
/// The slower pass with the long history the QFL bases need (weight 5 per request: kept polite).
const FULL_PARALLEL: usize = 3;
const FULL_PACE_MS: u64 = 450;
/// The heavy QFL analysis of a symbol runs when one of its candles closes, or at most this often while it moves.
const FULL_REFRESH_SECS: u64 = 10;
/// How many of the latest candles the drop check looks at (it needs the drop window, ~50 for the volatility and the Donchian window).
const DROP_TAIL: usize = 300;
/// No kline message for this long means the connection is dead.
const SILENCE_LIMIT_SECS: u64 = 45;
/// A triggered crack or drop stays in the list this long after it was last seen.
const KEEP_MS: u64 = 6 * 3600 * 1000;
/// A sudden pump or dump stays this long.
const SPIKE_KEEP_MS: u64 = 2 * 3600 * 1000;

/// Which signal sources are on. Each can be switched off independently.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sources {
    pub qfl: bool,
    /// sudden pumps and dumps from the all-symbol price stream (`movers.rs`)
    #[serde(default = "yes")]
    pub movers: bool,
}

fn yes() -> bool {
    true
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
}

fn default_sources() -> Sources {
    Sources { qfl: true, movers: true }
}

impl Default for ScannerConfig {
    fn default() -> Self {
        ScannerConfig { timeframe: "15m".into(), universe: 40, params: SignalParams { fresh_bars: 8, ..Default::default() }, sources: default_sources() }
    }
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
    pub pump_count: usize,
    pub dump_count: usize,
    /// the pump / dump watcher: warming up, or how many coins it watches
    pub mover_state: String,
    pub error: Option<String>,
}

#[derive(Default)]
struct Inner {
    config: ScannerConfig,
    buffers: HashMap<String, Vec<Candle>>,
    /// symbols whose long history has arrived (the QFL analysis needs it)
    full: HashSet<String>,
    last_run: HashMap<String, Instant>,
    signals: HashMap<String, Signal>,
    announced: HashSet<String>,
    status: ScannerStatus,
    last_emit: Option<Instant>,
}

/// See [`Scanner::reader`].
#[derive(Clone)]
pub struct SignalReader {
    inner: Arc<Mutex<Inner>>,
}

impl SignalReader {
    pub fn signals(&self) -> Vec<Signal> {
        sorted(&self.inner.lock().unwrap())
    }

    pub fn status(&self) -> ScannerStatus {
        self.inner.lock().unwrap().status.clone()
    }
}

#[derive(Default)]
pub struct Scanner {
    inner: Arc<Mutex<Inner>>,
    task: Mutex<Option<JoinHandle<()>>>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn rank(k: SignalKind) -> u8 {
    match k {
        SignalKind::Pump | SignalKind::Dump => 0,
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
    inner.status.crack_count = c;
    inner.status.near_count = n;
    inner.status.drop_count = d;
    inner.status.pump_count = count(SignalKind::Pump);
    inner.status.dump_count = count(SignalKind::Dump);
}

fn emit_status(app: &Events, inner: &Inner) {
    let _ = app.emit("scanner-status", inner.status.clone());
}

fn emit_signals(app: &Events, inner: &mut Inner, force: bool) {
    if !force && inner.last_emit.map_or(false, |t| t.elapsed() < Duration::from_millis(800)) {
        return;
    }
    inner.last_emit = Some(Instant::now());
    refresh_counts(inner);
    let _ = app.emit("signals", sorted(inner));
    emit_status(app, inner);
}

/// Run the engine for one symbol and fold the result into the signal map.
fn analyse_symbol(app: &Events, inner: &mut Inner, symbol: &str) {
    let Some(candles) = inner.buffers.get(symbol) else { return };
    let cfg = inner.config.clone();
    let now = now_ms();
    let candles = candles.clone();

    // QFL / drop / watch signals
    if cfg.sources.qfl {
        let fresh = analyse(symbol, &cfg.timeframe, &candles, &cfg.params);
        // watches always reflect the present: drop this symbol's old ones first (cracks are kept for KEEP_MS even after they stop being "fresh")
        inner.signals.retain(|_, s| !(s.symbol == symbol && s.kind == SignalKind::Near));
        // drops are checked on every live update by `analyse_drops`, not here
        for s in fresh.into_iter().filter(|s| s.kind != SignalKind::Drop) {
            if s.kind == SignalKind::Crack && inner.announced.insert(s.id.clone()) {
                let _ = app.emit("signal-new", s.clone());
            }
            inner.signals.insert(s.id.clone(), s);
        }
    }
    let tf = timeframe_ms(&inner.config.timeframe);
    prune_signals(&mut inner.signals, now, tf);
}

/// Length of a candle of a timeframe such as "5m", "1h", "1d" in milliseconds.
fn timeframe_ms(tf: &str) -> u64 {
    let (n, unit) = tf.split_at(tf.len().saturating_sub(1));
    let n: u64 = n.parse().unwrap_or(15);
    n * match unit {
        "m" => 60_000,
        "h" => 3_600_000,
        "d" => 86_400_000,
        "w" => 604_800_000,
        _ => 60_000,
    }
}

/// Remove what has expired: a crack after `KEEP_MS`, a pump / dump after `SPIKE_KEEP_MS`, and a drop or watch that has not been refreshed for a few
/// candles (they are re-made on every live update, so one that is old means the feed behind it stopped).
fn prune_signals(signals: &mut HashMap<String, Signal>, now: u64, candle_ms: u64) {
    let stale = (candle_ms * 3).max(20 * 60_000);
    signals.retain(|_, s| {
        let age = now.saturating_sub(s.time_ms);
        match s.kind {
            SignalKind::Crack => age <= KEEP_MS,
            SignalKind::Pump | SignalKind::Dump => age <= SPIKE_KEEP_MS,
            SignalKind::Drop | SignalKind::Near => age <= stale,
        }
    });
}

/// The drop check of one symbol: cheap (only the latest candles), so it runs on every live update. A drop that is no longer a drop disappears.
fn analyse_drops(inner: &mut Inner, symbol: &str) {
    if !inner.config.sources.qfl {
        return;
    }
    let fresh = {
        let Some(buf) = inner.buffers.get(symbol) else { return };
        analyse_drop(symbol, &inner.config.timeframe, &buf[buf.len().saturating_sub(DROP_TAIL)..], &inner.config.params)
    };
    match fresh {
        Some(s) => {
            inner.signals.insert(s.id.clone(), s);
        }
        None => inner.signals.retain(|_, s| !(s.symbol == symbol && s.kind == SignalKind::Drop)),
    }
}

/// The long history that just arrived, plus the live candles that came in while it was loading (a live candle replaces the seed's last one when it is the same candle).
fn merge_seed(mut seed: Vec<Candle>, live: &[Candle]) -> Vec<Candle> {
    for c in live {
        match seed.last() {
            Some(l) if l.open_time == c.open_time => *seed.last_mut().unwrap() = *c,
            Some(l) if c.open_time > l.open_time => seed.push(*c),
            None => seed.push(*c),
            _ => {}
        }
    }
    if seed.len() > MAX_CANDLES {
        let extra = seed.len() - MAX_CANDLES;
        seed.drain(..extra);
    }
    seed
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

    /// Turn the QFL source on or off without restarting: its entries leave the list at once.
    pub fn set_sources(&self, app: &Events, sources: Sources) {
        let mut g = self.inner.lock().unwrap();
        g.config.sources = sources;
        if !sources.qfl {
            g.signals.retain(|_, s| matches!(s.kind, SignalKind::Pump | SignalKind::Dump));
        }
        if !sources.movers {
            g.signals.retain(|_, s| !matches!(s.kind, SignalKind::Pump | SignalKind::Dump));
        }
        emit_signals(app, &mut g, true);
    }

    /// New rules (drop size, crack depth, ...) apply at once: every symbol already loaded is analysed again with them. No restart, no reload.
    pub fn set_params(&self, app: &Events, params: SignalParams) {
        let mut g = self.inner.lock().unwrap();
        g.config.params = params;
        let symbols: Vec<String> = g.buffers.keys().cloned().collect();
        for s in &symbols {
            analyse_drops(&mut g, s);
            if g.full.contains(s) {
                analyse_symbol(app, &mut g, s);
            }
        }
        emit_signals(app, &mut g, true);
    }

    /// A read-only view of the current signals that other tasks can hold on to.
    pub fn reader(&self) -> SignalReader {
        SignalReader { inner: self.inner.clone() }
    }

    pub fn injector(&self) -> Injector {
        Injector { inner: self.inner.clone() }
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
    pub fn start(&self, app: Events, market: Arc<Market>, config: ScannerConfig) {
        self.stop();
        {
            let mut g = self.inner.lock().unwrap();
            // a restart (another timeframe or universe) keeps the sudden moves already seen
            let spikes: Vec<(String, Signal)> = g.signals.iter().filter(|(_, s)| matches!(s.kind, SignalKind::Pump | SignalKind::Dump)).map(|(k, s)| (k.clone(), s.clone())).collect();
            let mover_state = g.status.mover_state.clone();
            *g = Inner { config: config.clone(), ..Default::default() };
            for (k, s) in spikes {
                g.announced.insert(k.clone());
                g.signals.insert(k, s);
            }
            g.status = ScannerStatus { running: true, phase: "loading symbols".into(), timeframe: config.timeframe.clone(), mover_state, ..Default::default() };
            emit_status(&app, &g);
        }
        let inner = self.inner.clone();
        let task = crate::rt::spawn(async move { run(app, market, inner, config).await });
        *self.task.lock().unwrap() = Some(task);
    }
}

/// A handle the pump / dump watcher uses to put its signals into the scanner's list and report its state.
#[derive(Clone)]
pub struct Injector {
    inner: Arc<Mutex<Inner>>,
}

impl Injector {
    /// Add a sudden-move signal (ignored while the Movers source is off) and tell the UI.
    pub fn add(&self, app: &Events, signal: Signal) {
        let mut g = self.inner.lock().unwrap();
        if !g.config.sources.movers {
            return;
        }
        if g.announced.insert(signal.id.clone()) {
            let _ = app.emit("signal-new", signal.clone());
        }
        g.signals.insert(signal.id.clone(), signal);
        emit_signals(app, &mut g, true);
    }

    pub fn set_state(&self, app: &Events, state: String) {
        let mut g = self.inner.lock().unwrap();
        if g.status.mover_state != state {
            g.status.mover_state = state;
            emit_status(app, &g);
        }
    }

    pub fn enabled(&self) -> bool {
        self.inner.lock().unwrap().config.sources.movers
    }
}

fn set_phase(app: &Events, inner: &Arc<Mutex<Inner>>, phase: &str, error: Option<String>) {
    let mut g = inner.lock().unwrap();
    g.status.phase = phase.to_string();
    g.status.error = error;
    emit_status(app, &g);
}

/// First pass: the recent candles of every symbol, many requests at once. Drops are live as soon as this is done.
async fn fast_seed(app: &Events, market: &Arc<Market>, inner: &Arc<Mutex<Inner>>, symbols: &[String], timeframe: &str) {
    let mut results = stream::iter(symbols.iter().cloned())
        .map(|sym| {
            let m = market.clone();
            let tf = timeframe.to_string();
            async move {
                let r = m.klines(&sym, &tf, FAST_CANDLES, None, None).await;
                (sym, r)
            }
        })
        .buffer_unordered(FAST_PARALLEL);
    let mut done = 0usize;
    while let Some((sym, r)) = results.next().await {
        done += 1;
        let mut g = inner.lock().unwrap();
        match r {
            Ok(rows) => {
                let candles: Vec<Candle> = rows.iter().map(|k| Candle::new(k.time, k.open, k.high, k.low, k.close, k.volume)).collect();
                g.buffers.insert(sym.clone(), candles);
                analyse_drops(&mut g, &sym);
            }
            Err(e) => g.status.error = Some(format!("{sym}: {e}")),
        }
        g.status.seeded = done;
        if done % 10 == 0 || done == symbols.len() {
            emit_signals(app, &mut g, true);
        }
    }
}

/// Second pass, in the background while the live feed already runs: the long history of every symbol, for the QFL bases.
async fn full_seed(app: &Events, market: &Arc<Market>, inner: &Arc<Mutex<Inner>>, symbols: &[String], timeframe: &str) {
    let total = symbols.len();
    let mut results = stream::iter(symbols.iter().cloned())
        .map(|sym| {
            let m = market.clone();
            let tf = timeframe.to_string();
            async move {
                let r = m.klines(&sym, &tf, SEED_CANDLES, None, None).await;
                tokio::time::sleep(Duration::from_millis(FULL_PACE_MS)).await;
                (sym, r)
            }
        })
        .buffer_unordered(FULL_PARALLEL);
    let mut done = 0usize;
    while let Some((sym, r)) = results.next().await {
        done += 1;
        let mut g = inner.lock().unwrap();
        match r {
            Ok(rows) => {
                let candles: Vec<Candle> = rows.iter().map(|k| Candle::new(k.time, k.open, k.high, k.low, k.close, k.volume)).collect();
                let live = g.buffers.remove(&sym).unwrap_or_default();
                g.buffers.insert(sym.clone(), merge_seed(candles, &live));
                g.full.insert(sym.clone());
                analyse_symbol(app, &mut g, &sym);
            }
            Err(e) => g.status.error = Some(format!("{sym}: {e}")),
        }
        g.status.phase = if done == total { "scanning live".into() } else { format!("scanning live · QFL history {done}/{total}") };
        if done % 5 == 0 || done == total {
            emit_signals(app, &mut g, true);
        }
    }
}

/// The live feed: ONE combined kline websocket for all symbols. Returns when the connection ends.
async fn live_session(app: &Events, market: &Arc<Market>, inner: &Arc<Mutex<Inner>>, symbols: &[String], timeframe: &str) -> Result<(), String> {
    let streams: Vec<String> = symbols.iter().map(|s| format!("{}@kline_{}", s.to_lowercase(), timeframe)).collect();
    let env: Env = market.env();
    let url = format!("{}/stream?streams={}", env.ws_base(), streams.join("/"));
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.map_err(|e| format!("websocket: {e}"))?;
    // The kline stream of dozens of symbols never goes quiet. If it does, the connection is dead without having said so (sleep, a network change):
    // reconnect, which also reloads the candles.
    let mut last_message = Instant::now();
    let mut housekeeping = tokio::time::interval(Duration::from_secs(15));
    loop {
        let msg = tokio::select! {
            m = ws.next() => m,
            _ = housekeeping.tick() => {
                if last_message.elapsed() > Duration::from_secs(SILENCE_LIMIT_SECS) {
                    break;
                }
                // expired results leave the list even when nothing new arrives
                let mut g = inner.lock().unwrap();
                let tf = timeframe_ms(&g.config.timeframe);
                let before = g.signals.len();
                prune_signals(&mut g.signals, now_ms(), tf);
                if g.signals.len() != before {
                    refresh_counts(&mut g);
                    emit_signals(app, &mut g, true);
                }
                continue;
            }
        };
        let Some(msg) = msg else { break };
        let text = match msg {
            Ok(Message::Text(t)) => t,
            Ok(Message::Close(_)) | Err(_) => break,
            _ => continue,
        };
        last_message = Instant::now();
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let Some(ev) = parse_kline_value(v.get("data").unwrap_or(&v)) else { continue };
        let c = Candle::new(ev.bar.time, ev.bar.open, ev.bar.high, ev.bar.low, ev.bar.close, ev.bar.volume);
        let mut g = inner.lock().unwrap();
        apply_bar(g.buffers.entry(ev.symbol.clone()).or_default(), c);
        g.status.updates += 1;
        g.status.last_update_ms = now_ms();
        // a drop is looked for on EVERY update: it is cheap and is exactly what must not wait
        analyse_drops(&mut g, &ev.symbol);
        // the heavy QFL analysis only once the long history is there, and not on every tick
        let due = g.full.contains(&ev.symbol) && (ev.closed || g.last_run.get(&ev.symbol).map_or(true, |t| t.elapsed() >= Duration::from_secs(FULL_REFRESH_SECS)));
        if due {
            g.last_run.insert(ev.symbol.clone(), Instant::now());
            analyse_symbol(app, &mut g, &ev.symbol);
        }
        emit_signals(app, &mut g, false);
    }
    Ok(())
}

async fn run(app: Events, market: Arc<Market>, inner: Arc<Mutex<Inner>>, cfg: ScannerConfig) {
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
            g.full.clear();
            g.status.phase = "loading recent candles".into();
            emit_status(&app, &g);
        }

        // 2. recent candles of every symbol, in parallel: drops are live after this
        fast_seed(&app, &market, &inner, &symbols, &cfg.timeframe).await;
        {
            let mut g = inner.lock().unwrap();
            g.status.phase = "scanning live".into();
            emit_signals(&app, &mut g, true);
        }

        // 3. the live feed and the long history (for the QFL bases) at the same time
        let (live, _) = tokio::join!(live_session(&app, &market, &inner, &symbols, &cfg.timeframe), full_seed(&app, &market, &inner, &symbols, &cfg.timeframe));
        match live {
            Ok(()) => {
                backoff = 2;
                set_phase(&app, &inner, "reconnecting", None);
            }
            Err(e) => set_phase(&app, &inner, "waiting to retry", Some(e)),
        }
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(60);
    }
}

#[cfg(test)]
mod tests {
    use harvester_core::signals::ScoreParts;
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
    fn live_candles_that_came_in_during_the_long_load_are_kept() {
        let seed: Vec<Candle> = (0..5).map(|i| c(i * 900, 100.0 + i as f64)).collect();
        // the live feed re-sent the seed's last candle with a newer close and added two more
        let live = vec![c(4 * 900, 150.0), c(5 * 900, 151.0), c(6 * 900, 152.0)];
        let m = merge_seed(seed.clone(), &live);
        assert_eq!(m.len(), 7);
        assert_eq!(m[4].close, 150.0);
        assert_eq!(m.last().unwrap().open_time, 6 * 900);
        // older live candles never overwrite the seed
        assert_eq!(merge_seed(seed.clone(), &[c(0, 1.0)]).len(), 5);
        assert_eq!(merge_seed(seed, &[c(0, 1.0)])[0].close, 100.0);
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

    fn signal(id: &str, kind: SignalKind, time_ms: u64) -> Signal {
        Signal {
            id: id.into(),
            symbol: "ETHUSDT".into(),
            timeframe: "5m".into(),
            kind,
            time_ms,
            price: 1.0,
            base: None,
            crack_level: None,
            distance_pct: None,
            drop_pct: 0.0,
            vol_ratio: 1.0,
            donch_pos: None,
            score: 50,
            parts: ScoreParts { structure: 0.0, volume: 0.0, magnitude: 0.0, pivot: 0.0, stabilising: 0.0 },
            reasons: vec![],
            thumb: vec![],
        }
    }

    #[test]
    fn expired_results_are_removed_by_kind() {
        let now = 100 * 3_600_000u64;
        let mut m: HashMap<String, Signal> = HashMap::new();
        for (id, kind, age) in [
            ("crack-fresh", SignalKind::Crack, 5 * 3_600_000),
            ("crack-old", SignalKind::Crack, 7 * 3_600_000),
            ("pump-fresh", SignalKind::Pump, 1 * 3_600_000),
            ("dump-old", SignalKind::Dump, 3 * 3_600_000),
            ("drop-fresh", SignalKind::Drop, 4 * 60_000),
            ("drop-stale", SignalKind::Drop, 6 * 3_600_000),
            ("near-stale", SignalKind::Near, 18 * 3_600_000),
        ] {
            m.insert(id.into(), signal(id, kind, now - age));
        }
        prune_signals(&mut m, now, 300_000); // 5-minute candles: a drop or watch older than 20 minutes is stale
        let mut left: Vec<&str> = m.keys().map(|k| k.as_str()).collect();
        left.sort();
        assert_eq!(left, vec!["crack-fresh", "drop-fresh", "pump-fresh"]);
    }

    #[test]
    fn timeframes_become_milliseconds() {
        assert_eq!(timeframe_ms("5m"), 300_000);
        assert_eq!(timeframe_ms("1h"), 3_600_000);
        assert_eq!(timeframe_ms("15m"), 900_000);
        assert_eq!(timeframe_ms("1d"), 86_400_000);
    }

    #[test]
    fn cracks_sort_before_watches() {
        assert!(rank(SignalKind::Crack) < rank(SignalKind::Near));
        assert!(rank(SignalKind::Drop) < rank(SignalKind::Near));
    }
}
