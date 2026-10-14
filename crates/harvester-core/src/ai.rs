//! The AI analyst: the request sent to Claude, the reading of its answer, and the track record that scores its calls afterwards.
//! Pure: no network and no clock. The HTTP call and the log file live in the app (`src-tauri/src/ai.rs`).
//!
//! The model is asked for a strict JSON document (`output_config.format` with a JSON schema), so the answer is data, not prose to be picked apart.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The models the analyst can use.
pub const MODELS: &[(&str, &str)] = &[("claude-haiku-5-5", "Haiku 5.5 (fast, cheap)"), ("claude-sonnet-5-5", "Sonnet 5.5 (deeper)")];

/// Room for the answer and for the model's own thinking, which counts against the same limit.
pub const MAX_TOKENS: u32 = 12_000;

pub const SYSTEM_PROMPT: &str = "You are a careful analyst of Binance USDT perpetual futures charts, helping a discretionary trader. \
You are given computed indicator data, recent candles on several timeframes, detected zones, news and the trader's position, and sometimes a screenshot of the chart. \
Use only that data: never invent prices, indicators or news. Every price you give must be one the data supports (a swing, a zone edge, a moving average, the point of control...). \
Be honest about uncertainty. Nobody can reliably predict the next move of a crypto price; your direction call is an opinion, so keep `confidence` calibrated: 50 means no real edge, \
most analyses belong between 45 and 65, and a number above 75 needs several timeframes and indicators clearly agreeing. Prefer `neutral` when the evidence is mixed. \
Say what would make the idea wrong (an invalidation level) and what the trader should watch. \
If the trader has a position, comment on it (its stop and take-profit, its distance to liquidation, a scheduled delisting). \
Funding, open interest, the long/short ratio, taker flow and order-book balance describe positioning: use them as context (crowded longs, a squeeze setup, thin books), not as certainties. \nIf a PREVIOUS ANALYSIS is given, say in `what_changed` what is different now (bias, levels, what played out) in under 40 words, and leave it empty when there is none. \nKeep the summary under 120 words and give at most 6 key levels, 4 scenarios, 6 reasons and 5 risks. This is analysis, not financial advice.";

/// The JSON schema of the answer.
pub fn analysis_schema() -> Value {
    let strings = json!({ "type": "array", "items": { "type": "string" } });
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["bias", "confidence", "horizon_hours", "summary", "key_levels", "scenarios", "reasons", "risks", "position_note", "what_changed"],
        "properties": {
            "bias": { "type": "string", "enum": ["bullish", "bearish", "neutral"] },
            "confidence": { "type": "integer" },
            "horizon_hours": { "type": "integer" },
            "summary": { "type": "string" },
            "key_levels": { "type": "array", "items": {
                "type": "object", "additionalProperties": false, "required": ["price", "kind", "note"],
                "properties": { "price": { "type": "number" }, "kind": { "type": "string", "enum": ["support", "resistance", "target", "invalidation"] }, "note": { "type": "string" } } } },
            "scenarios": { "type": "array", "items": {
                "type": "object", "additionalProperties": false, "required": ["name", "condition", "outcome"],
                "properties": { "name": { "type": "string" }, "condition": { "type": "string" }, "outcome": { "type": "string" } } } },
            "reasons": strings,
            "risks": strings,
            "position_note": { "type": "string" },
            "what_changed": { "type": "string" }
        }
    })
}

/// The request body for the Messages API. `image_b64` is a JPEG of the chart (optional). No sampling parameters and no `thinking` field are sent:
/// the 5.5 models run adaptive thinking by themselves and reject some of those settings.
pub fn build_request(model: &str, context: &str, image_b64: Option<&str>) -> Value {
    let mut content = Vec::new();
    if let Some(img) = image_b64.filter(|i| !i.is_empty()) {
        content.push(json!({ "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": img } }));
    }
    content.push(json!({ "type": "text", "text": context }));
    json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": SYSTEM_PROMPT,
        "output_config": { "effort": "medium", "format": { "type": "json_schema", "schema": analysis_schema() } },
        "messages": [ { "role": "user", "content": content } ]
    })
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Bias {
    Bullish,
    Bearish,
    Neutral,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LevelKind {
    Support,
    Resistance,
    Target,
    Invalidation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Level {
    pub price: f64,
    pub kind: LevelKind,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Scenario {
    pub name: String,
    #[serde(default)]
    pub condition: String,
    #[serde(default)]
    pub outcome: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub bias: Bias,
    /// 0..100; 50 = no edge
    pub confidence: u8,
    #[serde(alias = "horizon_hours")]
    pub horizon_hours: u32,
    pub summary: String,
    #[serde(alias = "key_levels", default)]
    pub key_levels: Vec<Level>,
    #[serde(default)]
    pub scenarios: Vec<Scenario>,
    #[serde(default)]
    pub reasons: Vec<String>,
    #[serde(default)]
    pub risks: Vec<String>,
    #[serde(alias = "position_note", default)]
    pub position_note: String,
    /// how this differs from the previous analysis of the symbol, empty when there was none
    #[serde(alias = "what_changed", default)]
    pub what_changed: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// Clean an answer: confidence into 0..100, a sensible horizon, levels with a real price, lists kept short.
pub fn sanitize(mut a: Analysis) -> Analysis {
    a.confidence = a.confidence.min(100);
    a.horizon_hours = a.horizon_hours.clamp(1, 24 * 14);
    a.key_levels.retain(|l| l.price.is_finite() && l.price > 0.0);
    a.key_levels.truncate(8);
    a.scenarios.truncate(5);
    a.reasons.truncate(8);
    a.risks.truncate(8);
    a.summary = a.summary.trim().to_string();
    a
}

/// What came back from the Messages API: the analysis and the tokens it cost, or a message saying what went wrong.
pub fn parse_response(v: &Value) -> Result<(Analysis, Usage), String> {
    if v["type"] == "error" {
        let msg = v["error"]["message"].as_str().unwrap_or("the API returned an error");
        let kind = v["error"]["type"].as_str().unwrap_or("error");
        return Err(format!("{msg} ({kind})"));
    }
    match v["stop_reason"].as_str() {
        Some("refusal") => return Err("The model declined to answer this request.".to_string()),
        Some("max_tokens") => return Err("The answer was cut off before it was finished (the model used up its token limit). Try again, or use the other model.".to_string()),
        _ => {}
    }
    let text = v["content"].as_array().into_iter().flatten().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("");
    if text.trim().is_empty() {
        return Err("The model returned no text.".to_string());
    }
    let analysis: Analysis = serde_json::from_str(text.trim()).map_err(|e| format!("The answer was not in the expected format ({e})."))?;
    let usage = Usage { input_tokens: v["usage"]["input_tokens"].as_u64().unwrap_or(0), output_tokens: v["usage"]["output_tokens"].as_u64().unwrap_or(0) };
    Ok((sanitize(analysis), usage))
}

// ------------------------------------------------------------------------------------------------------------ the track record

/// The hours after an analysis at which its call is scored.
pub const SCORE_HOURS: &[u64] = &[4, 12, 24];

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub hours: u64,
    /// price change from the analysis to this horizon, in percent; None while the horizon has not been reached
    pub change_pct: Option<f64>,
    /// the call went the right way (None for a neutral call, or while it is too early)
    pub correct: Option<bool>,
}

/// How an analysis did: `price` was the price when it was made, `created_ms` the time, `path` the later (time ms, close) candles, oldest first.
pub fn score(bias: Bias, price: f64, created_ms: u64, path: &[(u64, f64)], now_ms: u64) -> Vec<Outcome> {
    SCORE_HOURS
        .iter()
        .map(|&h| {
            let due = created_ms + h * 3_600_000;
            if now_ms < due || price <= 0.0 {
                return Outcome { hours: h, change_pct: None, correct: None };
            }
            // the last candle that had closed by the horizon
            let close = path.iter().filter(|(t, _)| *t <= due).last().map(|(_, c)| *c);
            let Some(c) = close else { return Outcome { hours: h, change_pct: None, correct: None } };
            let change = (c / price - 1.0) * 100.0;
            let correct = match bias {
                Bias::Bullish => Some(change > 0.0),
                Bias::Bearish => Some(change < 0.0),
                Bias::Neutral => None,
            };
            Outcome { hours: h, change_pct: Some(change), correct }
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HorizonSummary {
    pub hours: u64,
    /// directional calls (bullish / bearish) that have reached this horizon
    pub scored: usize,
    pub hits: usize,
    pub hit_rate_pct: Option<f64>,
    /// the average move in the direction of the call, in percent (negative = the calls lost on average)
    pub avg_directional_change_pct: Option<f64>,
    /// how often price simply went UP over this horizon across the same analyses (the hit rate a permanent "bullish" would have had)
    pub up_rate_pct: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackRecord {
    pub analyses: usize,
    pub directional: usize,
    pub neutral: usize,
    pub horizons: Vec<HorizonSummary>,
}

/// The track record of many analyses: for each horizon, the hit rate of the directional calls next to the rate of an always-bullish call.
pub fn summarize(entries: &[(Bias, Vec<Outcome>)]) -> TrackRecord {
    let directional = entries.iter().filter(|(b, _)| *b != Bias::Neutral).count();
    let horizons = SCORE_HOURS
        .iter()
        .map(|&h| {
            let rows: Vec<(Bias, f64)> = entries.iter().filter_map(|(b, o)| o.iter().find(|x| x.hours == h).and_then(|x| x.change_pct).map(|c| (*b, c))).collect();
            let dir: Vec<(Bias, f64)> = rows.iter().copied().filter(|(b, _)| *b != Bias::Neutral).collect();
            let hits = dir.iter().filter(|(b, c)| (*b == Bias::Bullish && *c > 0.0) || (*b == Bias::Bearish && *c < 0.0)).count();
            let pct = |n: usize, d: usize| if d == 0 { None } else { Some(n as f64 / d as f64 * 100.0) };
            let avg = if dir.is_empty() { None } else { Some(dir.iter().map(|(b, c)| if *b == Bias::Bearish { -c } else { *c }).sum::<f64>() / dir.len() as f64) };
            HorizonSummary { hours: h, scored: dir.len(), hits, hit_rate_pct: pct(hits, dir.len()), avg_directional_change_pct: avg, up_rate_pct: pct(rows.iter().filter(|(_, c)| *c > 0.0).count(), rows.len()) }
        })
        .collect();
    TrackRecord { analyses: entries.len(), directional, neutral: entries.len() - directional, horizons }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn good_answer() -> Value {
        json!({
            "id": "msg_1", "type": "message", "role": "assistant", "stop_reason": "end_turn",
            "content": [
                {"type": "thinking", "thinking": ""},
                {"type": "text", "text": serde_json::to_string(&json!({
                    "bias": "bullish", "confidence": 58, "horizon_hours": 12, "summary": " Holding above the 50 EMA. ",
                    "key_levels": [{"price": 0.381, "kind": "support", "note": "swing low"}, {"price": -1.0, "kind": "target", "note": "bad"}, {"price": 0.42, "kind": "invalidation", "note": ""}],
                    "scenarios": [{"name": "Continuation", "condition": "closes above 0.40", "outcome": "targets 0.43"}],
                    "reasons": ["RSI 55"], "risks": ["delisting 20 Oct"], "position_note": "Stop is tight", "what_changed": "Bias flipped"})).unwrap()}
            ],
            "usage": {"input_tokens": 4200, "output_tokens": 900}
        })
    }

    #[test]
    fn a_good_answer_is_read_cleaned_and_its_tokens_counted() {
        let (a, u) = parse_response(&good_answer()).unwrap();
        assert_eq!(a.bias, Bias::Bullish);
        assert_eq!(a.confidence, 58);
        assert_eq!(a.summary, "Holding above the 50 EMA.");
        assert_eq!(a.key_levels.len(), 2, "the level with a negative price is dropped");
        assert_eq!(a.key_levels[0].kind, LevelKind::Support);
        assert_eq!(a.position_note, "Stop is tight");
        assert_eq!(a.what_changed, "Bias flipped");
        assert_eq!(u, Usage { input_tokens: 4200, output_tokens: 900 });
    }

    #[test]
    fn problems_come_back_as_messages_not_crashes() {
        assert!(parse_response(&json!({"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}})).unwrap_err().contains("invalid x-api-key"));
        assert!(parse_response(&json!({"stop_reason": "refusal", "content": []})).unwrap_err().contains("declined"));
        assert!(parse_response(&json!({"stop_reason": "max_tokens", "content": []})).unwrap_err().contains("cut off"));
        assert!(parse_response(&json!({"stop_reason": "end_turn", "content": [{"type": "text", "text": "   "}]})).unwrap_err().contains("no text"));
        assert!(parse_response(&json!({"stop_reason": "end_turn", "content": [{"type": "text", "text": "not json"}]})).unwrap_err().contains("expected format"));
    }

    #[test]
    fn out_of_range_values_are_pulled_in() {
        let a = Analysis { bias: Bias::Neutral, confidence: 250, horizon_hours: 0, summary: String::new(), key_levels: vec![Level { price: f64::NAN, kind: LevelKind::Support, note: String::new() }], scenarios: vec![], reasons: vec!["x".into(); 20], risks: vec![], position_note: String::new(), what_changed: String::new() };
        let s = sanitize(a);
        assert_eq!(s.confidence, 100);
        assert_eq!(s.horizon_hours, 1);
        assert!(s.key_levels.is_empty());
        assert_eq!(s.reasons.len(), 8);
    }

    #[test]
    fn the_request_has_the_schema_the_image_and_none_of_the_rejected_settings() {
        let r = build_request("claude-sonnet-5-5", "context text", Some("QUJD"));
        assert_eq!(r["model"], "claude-sonnet-5-5");
        assert_eq!(r["output_config"]["format"]["type"], "json_schema");
        assert_eq!(r["output_config"]["effort"], "medium");
        assert!(r.get("temperature").is_none() && r.get("thinking").is_none() && r.get("tool_choice").is_none());
        let content = r["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "image");
        assert_eq!(content[0]["source"]["media_type"], "image/jpeg");
        assert_eq!(content[1]["text"], "context text");
        // without a picture there is only the text
        let r2 = build_request("claude-haiku-5-5", "t", None);
        assert_eq!(r2["messages"][0]["content"].as_array().unwrap().len(), 1);
        assert_eq!(build_request("m", "t", Some("")).get("messages").unwrap()[0]["content"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn the_schema_requires_every_field_and_forbids_extras() {
        let s = analysis_schema();
        assert_eq!(s["additionalProperties"], false);
        let required = s["required"].as_array().unwrap();
        for k in s["properties"].as_object().unwrap().keys() {
            assert!(required.iter().any(|r| r == k), "{k} is not required");
        }
    }

    const H: u64 = 3_600_000;

    #[test]
    fn a_call_is_scored_at_each_horizon_once_it_has_been_reached() {
        let path = vec![(1 * H, 101.0), (4 * H, 103.0), (12 * H, 99.0), (24 * H, 105.0)];
        let o = score(Bias::Bullish, 100.0, 0, &path, 13 * H);
        assert!((o[0].change_pct.unwrap() - 3.0).abs() < 1e-9);
        assert_eq!(o[0].correct, Some(true));
        assert!((o[1].change_pct.unwrap() + 1.0).abs() < 1e-9);
        assert_eq!(o[1].correct, Some(false));
        assert_eq!(o[2].change_pct, None, "24 hours have not passed");
        let bear = score(Bias::Bearish, 100.0, 0, &path, 30 * H);
        assert_eq!(bear[0].correct, Some(false));
        assert_eq!(bear[1].correct, Some(true));
        assert_eq!(bear[2].correct, Some(false));
    }

    #[test]
    fn a_neutral_call_is_never_right_or_wrong() {
        let o = score(Bias::Neutral, 100.0, 0, &[(4 * H, 110.0)], 5 * H);
        assert!((o[0].change_pct.unwrap() - 10.0).abs() < 1e-9);
        assert_eq!(o[0].correct, None);
    }

    #[test]
    fn the_summary_compares_the_hit_rate_with_an_always_up_call() {
        let up = vec![Outcome { hours: 4, change_pct: Some(2.0), correct: Some(true) }, Outcome { hours: 12, change_pct: None, correct: None }, Outcome { hours: 24, change_pct: None, correct: None }];
        let down = vec![Outcome { hours: 4, change_pct: Some(-1.0), correct: Some(false) }, Outcome { hours: 12, change_pct: None, correct: None }, Outcome { hours: 24, change_pct: None, correct: None }];
        let bear_ok = vec![Outcome { hours: 4, change_pct: Some(-3.0), correct: Some(true) }, Outcome { hours: 12, change_pct: None, correct: None }, Outcome { hours: 24, change_pct: None, correct: None }];
        let neutral = vec![Outcome { hours: 4, change_pct: Some(1.0), correct: None }, Outcome { hours: 12, change_pct: None, correct: None }, Outcome { hours: 24, change_pct: None, correct: None }];
        let t = summarize(&[(Bias::Bullish, up), (Bias::Bullish, down), (Bias::Bearish, bear_ok), (Bias::Neutral, neutral)]);
        assert_eq!((t.analyses, t.directional, t.neutral), (4, 3, 1));
        let h4 = &t.horizons[0];
        assert_eq!((h4.scored, h4.hits), (3, 2));
        assert!((h4.hit_rate_pct.unwrap() - 66.666).abs() < 0.01);
        // the average move in the direction called: +2, -1, +3
        assert!((h4.avg_directional_change_pct.unwrap() - 4.0 / 3.0).abs() < 1e-9);
        // price went up in 2 of the 4 analyses
        assert_eq!(h4.up_rate_pct, Some(50.0));
        assert_eq!(t.horizons[1].scored, 0);
        assert_eq!(t.horizons[1].hit_rate_pct, None);
    }
}
