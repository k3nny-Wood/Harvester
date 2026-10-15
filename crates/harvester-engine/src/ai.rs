//! The AI analyst. Sends the chart context (and a screenshot) to the Claude API and keeps every analysis in a log, so its calls can be scored
//! against what price did afterwards. The API key (ANTHROPIC_API_KEY in `.env`) stays in this process: the interface never sees it.
//! The request, the answer and the scoring are in `harvester-core::ai`.

use harvester_core::ai::{build_request, parse_response, score, summarize, Analysis, Bias, Outcome, TrackRecord, Usage, MODELS};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

const MAX_LOG: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: String,
    pub created_ms: u64,
    pub symbol: String,
    pub timeframe: String,
    pub model: String,
    /// the price when the analysis was made
    pub price: f64,
    pub analysis: Analysis,
    pub usage: Usage,
    /// whether a screenshot was sent
    #[serde(default)]
    pub with_image: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeRequest {
    pub model: String,
    pub symbol: String,
    pub timeframe: String,
    pub price: f64,
    /// the chart context, as text
    pub context: String,
    /// a JPEG of the chart, base64 (no data: prefix)
    pub image: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoredEntry {
    pub entry: LogEntry,
    pub outcomes: Vec<Outcome>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub record: TrackRecord,
    pub entries: Vec<ScoredEntry>,
}

pub struct AiHub {
    http: reqwest::Client,
    path: PathBuf,
    log: Mutex<Vec<LogEntry>>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn default_path() -> PathBuf {
    let base = std::env::var("APPDATA").ok().filter(|v| !v.is_empty()).map(PathBuf::from).or_else(|| std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf()))).unwrap_or_else(|| PathBuf::from("."));
    base.join("Harvester").join("ai_log.json")
}

pub fn models() -> Vec<ModelInfo> {
    MODELS.iter().map(|(id, label)| ModelInfo { id: id.to_string(), label: label.to_string() }).collect()
}

impl AiHub {
    pub fn open(path: PathBuf) -> AiHub {
        let log = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Vec<LogEntry>>(&b).ok()).unwrap_or_default();
        let http = reqwest::Client::builder().timeout(Duration::from_secs(240)).build().expect("an HTTP client");
        AiHub { http, path, log: Mutex::new(log) }
    }

    fn save(&self, log: &[LogEntry]) {
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = self.path.with_extension("json.tmp");
        if let Ok(bytes) = serde_json::to_vec(log) {
            if std::fs::write(&tmp, bytes).is_ok() {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
    }

    /// Record an analysis (the newest 500 are kept).
    pub fn record(&self, entry: LogEntry) {
        let mut g = self.log.lock().unwrap();
        g.push(entry);
        let extra = g.len().saturating_sub(MAX_LOG);
        if extra > 0 {
            g.drain(..extra);
        }
        self.save(&g);
    }

    /// The logged analyses of a symbol (or of every symbol), newest first.
    pub fn history(&self, symbol: Option<&str>, limit: usize) -> Vec<LogEntry> {
        let g = self.log.lock().unwrap();
        g.iter().rev().filter(|e| symbol.map_or(true, |s| e.symbol == s)).take(limit).cloned().collect()
    }

    /// Ask the model. The answer is logged; a failure is returned as a message and logs nothing.
    pub async fn analyze(&self, req: AnalyzeRequest) -> Result<LogEntry, String> {
        if !MODELS.iter().any(|(id, _)| *id == req.model) {
            return Err(format!("Unknown model {}.", req.model));
        }
        let key = std::env::var("ANTHROPIC_API_KEY").ok().map(|k| k.trim().to_string()).filter(|k| !k.is_empty()).ok_or("No Anthropic API key: put ANTHROPIC_API_KEY=... in the .env file next to Harvester and restart.")?;
        let body = build_request(&req.model, &req.context, req.image.as_deref());
        let resp = self
            .http
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Could not reach the Anthropic API: {e}"))?;
        let status = resp.status();
        // an error answer is JSON too, with the reason in it
        let v: Value = resp.json().await.map_err(|e| format!("The Anthropic API answered with something unreadable (HTTP {}): {e}", status.as_u16()))?;
        let (analysis, usage) = parse_response(&v)?;
        let entry = LogEntry { id: format!("ai-{}", now_ms()), created_ms: now_ms(), symbol: req.symbol, timeframe: req.timeframe, model: req.model, price: req.price, analysis, usage, with_image: req.image.as_deref().map_or(false, |i| !i.is_empty()) };
        self.record(entry.clone());
        Ok(entry)
    }

    /// Funding, open interest, positioning, taker flow, 24 hour numbers and book balance of a symbol, from Binance's public futures endpoints.
    /// A feed that fails is left as a gap.
    pub async fn market(&self, symbol: &str) -> Result<harvester_core::marketdata::Derivatives, String> {
        if symbol.is_empty() || !symbol.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err("Bad symbol.".into());
        }
        let get = |path: String| async move {
            let url = format!("https://fapi.binance.com{path}");
            match self.http.get(&url).send().await {
                Ok(r) if r.status().is_success() => r.json::<Value>().await.unwrap_or(Value::Null),
                _ => Value::Null,
            }
        };
        let s = symbol.to_uppercase();
        let (premium, funding, oi_now, oi_hist, ls, taker, ticker, depth) = tokio::join!(
            get(format!("/fapi/v1/premiumIndex?symbol={s}")),
            get(format!("/fapi/v1/fundingRate?symbol={s}&limit=9")),
            get(format!("/fapi/v1/openInterest?symbol={s}")),
            get(format!("/futures/data/openInterestHist?symbol={s}&period=1h&limit=24")),
            get(format!("/futures/data/globalLongShortAccountRatio?symbol={s}&period=1h&limit=24")),
            get(format!("/futures/data/takerlongshortRatio?symbol={s}&period=1h&limit=24")),
            get(format!("/fapi/v1/ticker/24hr?symbol={s}")),
            get(format!("/fapi/v1/depth?symbol={s}&limit=500")),
        );
        Ok(harvester_core::marketdata::assemble(&premium, &funding, &oi_now, &oi_hist, &ls, &taker, &ticker, &depth))
    }

    /// Score the logged analyses against what price did afterwards (real 1-hour candles from Binance) and summarise.
    pub async fn track(&self) -> Result<Track, String> {
        let entries = self.history(None, 200);
        let now = now_ms();
        // the symbols that have an analysis old enough to score
        let mut earliest: HashMap<String, u64> = HashMap::new();
        for e in &entries {
            if now.saturating_sub(e.created_ms) >= 4 * 3_600_000 {
                let t = earliest.entry(e.symbol.clone()).or_insert(e.created_ms);
                *t = (*t).min(e.created_ms);
            }
        }
        let mut paths: HashMap<String, Vec<(u64, f64)>> = HashMap::new();
        for (symbol, from) in earliest {
            let url = format!("https://fapi.binance.com/fapi/v1/klines?symbol={symbol}&interval=1h&startTime={from}&limit=1000");
            let Ok(resp) = self.http.get(&url).send().await else { continue };
            let Ok(v) = resp.json::<Value>().await else { continue };
            let path: Vec<(u64, f64)> = v
                .as_array()
                .into_iter()
                .flatten()
                // a 1h candle opened at t is known at its close, t + 1h
                .filter_map(|k| Some((k.get(0)?.as_u64()? + 3_600_000, k.get(4)?.as_str()?.parse::<f64>().ok()?)))
                .collect();
            paths.insert(symbol, path);
        }
        let scored: Vec<ScoredEntry> = entries
            .iter()
            .map(|e| {
                let path = paths.get(&e.symbol).map(|p| p.as_slice()).unwrap_or(&[]);
                ScoredEntry { entry: e.clone(), outcomes: score(e.analysis.bias, e.price, e.created_ms, path, now) }
            })
            .collect();
        let rows: Vec<(Bias, Vec<Outcome>)> = scored.iter().map(|s| (s.entry.analysis.bias, s.outcomes.clone())).collect();
        Ok(Track { record: summarize(&rows), entries: scored.into_iter().take(60).collect() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use harvester_core::ai::{Level, LevelKind};

    fn entry(symbol: &str, t: u64) -> LogEntry {
        LogEntry {
            id: format!("ai-{t}"),
            created_ms: t,
            symbol: symbol.into(),
            timeframe: "15m".into(),
            model: "claude-haiku-5-5".into(),
            price: 100.0,
            analysis: Analysis { bias: Bias::Bullish, confidence: 55, horizon_hours: 12, summary: "s".into(), key_levels: vec![Level { price: 99.0, kind: LevelKind::Support, note: String::new() }], scenarios: vec![], reasons: vec![], risks: vec![], position_note: String::new(), what_changed: String::new() },
            usage: Usage { input_tokens: 10, output_tokens: 5 },
            with_image: false,
        }
    }

    #[test]
    fn the_log_survives_a_restart_and_filters_by_symbol_newest_first() {
        let path = std::env::temp_dir().join(format!("harvester_ai_test_{}.json", now_ms()));
        let hub = AiHub::open(path.clone());
        hub.record(entry("ETHUSDT", 1));
        hub.record(entry("BTCUSDT", 2));
        hub.record(entry("ETHUSDT", 3));
        let again = AiHub::open(path.clone());
        let eth = again.history(Some("ETHUSDT"), 10);
        assert_eq!(eth.iter().map(|e| e.created_ms).collect::<Vec<_>>(), vec![3, 1]);
        assert_eq!(again.history(None, 2).len(), 2);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn only_the_newest_entries_are_kept() {
        let path = std::env::temp_dir().join(format!("harvester_ai_test_cap_{}.json", now_ms()));
        let hub = AiHub::open(path.clone());
        for t in 0..(MAX_LOG as u64 + 20) {
            hub.record(entry("ETHUSDT", t));
        }
        let all = hub.history(None, 10_000);
        assert_eq!(all.len(), MAX_LOG);
        assert_eq!(all[0].created_ms, MAX_LOG as u64 + 19);
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn without_a_key_or_with_an_unknown_model_it_says_so_and_sends_nothing() {
        let hub = AiHub::open(std::env::temp_dir().join("harvester_ai_nokey.json"));
        let bad_model = hub.analyze(AnalyzeRequest { model: "gpt-4".into(), symbol: "X".into(), timeframe: "15m".into(), price: 1.0, context: String::new(), image: None }).await;
        assert!(bad_model.unwrap_err().contains("Unknown model"));
    }

    #[test]
    fn the_models_offered_are_the_two_chosen() {
        let m = models();
        assert_eq!(m.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), vec!["claude-haiku-5-5", "claude-sonnet-5-5"]);
    }
}

#[cfg(test)]
mod live {
    use super::*;

    /// Calls the real API with the key from `.env` (a few cents): `cargo test live_analysis -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_analysis() {
        dotenvy::from_path(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.env")).ok();
        let hub = AiHub::open(std::env::temp_dir().join(format!("harvester_ai_live_{}.json", now_ms())));
        let context = "Analyse TESTUSDT (Binance USDT perpetual). The trader's chart is on the 15m timeframe. Last price: 100.\n\
== INDICATORS BY TIMEFRAME ==\n[15m] last close 100; change over 10 candles +0.4%, over 50 candles +1.1%\n  EMA20 99.6 (price +0.40%); EMA50 99.0 (price +1.01%); EMA200 97.5 (price +2.56%)\n  RSI14 57; MACD histogram 0.12 (rising)\n  ATR14 0.6 (0.60% of price)\n  recent swing highs: 101.2\n  recent swing lows: 98.4\n\n\
== THE TRADER'S POSITION ==\nNo open position in this symbol.\n\nGive your analysis now in the required JSON format.";
        for model in ["claude-haiku-5-5", "claude-sonnet-5-5"] {
            let r = hub.analyze(AnalyzeRequest { model: model.into(), symbol: "TESTUSDT".into(), timeframe: "15m".into(), price: 100.0, context: context.into(), image: None }).await;
            match r {
                Ok(e) => println!("{model}: bias {:?} conf {} horizon {}h | tokens in {} out {}\n  summary: {}\n  levels: {:?}\n  risks: {:?}", e.analysis.bias, e.analysis.confidence, e.analysis.horizon_hours, e.usage.input_tokens, e.usage.output_tokens, e.analysis.summary, e.analysis.key_levels, e.analysis.risks),
                Err(e) => println!("{model}: ERROR {e}"),
            }
        }
    }
}
