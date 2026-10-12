//! From a model prediction to something a trader can act on: a TRADE PLAN (entry, stop, target) and the rules that decide
//! whether a prediction becomes a call at all (confidence threshold and the RSI reversal filter).
//!
//! The plan is a starting point for a manual trade, not advice: the trader can move the stop and the target.
//! Stop: beyond the recent swing (the lowest low of the last `lookback` candles for a long) or `stop_atr_mult` x ATR from the entry,
//! whichever is farther, plus a small ATR buffer, clamped to [`min_stop_pct`, `max_stop_pct`]. Target: `reward_r` x the risk.

use crate::candle::{atr_pct, Candle};
use crate::ladder::Side;
use crate::ml::batch_features::BatchIndicators;
use crate::ml::features::FeatureVector;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanParams {
    pub atr_len: usize,
    /// minimum distance of the stop from the entry, in ATRs
    pub stop_atr_mult: f64,
    /// candles scanned for the swing low / high
    pub lookback: usize,
    /// extra room beyond the swing, in ATRs
    pub buffer_atr: f64,
    pub min_stop_pct: f64,
    pub max_stop_pct: f64,
    /// target distance as a multiple of the risk
    pub reward_r: f64,
}

impl Default for PlanParams {
    fn default() -> Self {
        PlanParams { atr_len: 14, stop_atr_mult: 1.5, lookback: 20, buffer_atr: 0.25, min_stop_pct: 0.5, max_stop_pct: 8.0, reward_r: 2.0 }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TradePlan {
    pub side: Side,
    pub entry: f64,
    pub stop: f64,
    pub target: f64,
    /// distance entry -> stop in % of the entry
    pub risk_pct: f64,
    /// distance entry -> target in % of the entry
    pub reward_pct: f64,
    /// reward / risk
    pub rr: f64,
    /// open time of the candle the plan was made on
    pub entry_time: u64,
}

impl TradePlan {
    /// Recompute the percentages and R:R after the stop or target was moved.
    pub fn with_levels(mut self, stop: f64, target: f64) -> TradePlan {
        self.stop = stop;
        self.target = target;
        self.risk_pct = (self.entry - stop).abs() / self.entry * 100.0;
        self.reward_pct = (target - self.entry).abs() / self.entry * 100.0;
        self.rr = if self.risk_pct > 0.0 { self.reward_pct / self.risk_pct } else { 0.0 };
        self
    }
}

/// Build the plan for a trade on the last candle's close.
pub fn build_plan(candles: &[Candle], side: Side, p: &PlanParams) -> Option<TradePlan> {
    let n = candles.len();
    if n < p.atr_len + 2 {
        return None;
    }
    let last = &candles[n - 1];
    let entry = last.close;
    if entry <= 0.0 {
        return None;
    }
    let atr = atr_pct(candles, p.atr_len) / 100.0 * entry;
    let from = n.saturating_sub(p.lookback);
    let (swing, atr_stop) = match side {
        Side::Buy => (candles[from..].iter().map(|c| c.low).fold(f64::INFINITY, f64::min), entry - p.stop_atr_mult * atr),
        Side::Sell => (candles[from..].iter().map(|c| c.high).fold(f64::NEG_INFINITY, f64::max), entry + p.stop_atr_mult * atr),
    };
    let mut stop = match side {
        Side::Buy => swing.min(atr_stop) - p.buffer_atr * atr,
        Side::Sell => swing.max(atr_stop) + p.buffer_atr * atr,
    };
    let (lo, hi) = (p.min_stop_pct / 100.0, p.max_stop_pct / 100.0);
    let dist = ((entry - stop).abs() / entry).clamp(lo, hi);
    stop = match side {
        Side::Buy => entry * (1.0 - dist),
        Side::Sell => entry * (1.0 + dist),
    };
    let risk = (entry - stop).abs();
    let target = match side {
        Side::Buy => entry + p.reward_r * risk,
        Side::Sell => entry - p.reward_r * risk,
    };
    if target <= 0.0 || stop <= 0.0 {
        return None;
    }
    Some(TradePlan { side, entry, stop, target, risk_pct: 0.0, reward_pct: 0.0, rr: 0.0, entry_time: last.open_time }.with_levels(stop, target))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MlParams {
    /// the model's probability that the entry is good must reach this
    pub min_confidence: f64,
    /// only longs when RSI is low, only shorts when RSI is high (the filter that made the model usable at all)
    pub reversal_filter: bool,
    pub rsi_long_max: f64,
    pub rsi_short_min: f64,
    pub plan: PlanParams,
}

impl Default for MlParams {
    fn default() -> Self {
        MlParams { min_confidence: 0.75, reversal_filter: true, rsi_long_max: 40.0, rsi_short_min: 60.0, plan: PlanParams::default() }
    }
}

/// One accepted call: a direction, the model's confidence, and the trade plan.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MlCall {
    pub side: Side,
    pub probability: f64,
    pub rsi: f64,
    pub plan: TradePlan,
}

/// The model's answer for one direction: (label, probability of a good entry).
pub type Prediction = (i64, f64);

/// Evaluate the LAST candle of `candles` (pass closed candles only, so the call is stable for the whole candle).
/// `predict(features, side)` runs the model for that direction.
pub fn evaluate(candles: &[Candle], p: &MlParams, mut predict: impl FnMut(&FeatureVector, Side) -> Option<Prediction>) -> Vec<MlCall> {
    let n = candles.len();
    if n < 120 {
        return vec![]; // BatchIndicators needs history (the 200-candle average is padded below that, the model was trained with it)
    }
    let batch = BatchIndicators::compute(candles);
    let features = batch.extract_at(candles, n - 1);
    let rsi = features.rsi_14.unwrap_or(50.0);
    let mut out = Vec::new();
    for side in [Side::Buy, Side::Sell] {
        let Some((label, prob)) = predict(&features, side) else { continue };
        if label != 1 || prob < p.min_confidence {
            continue;
        }
        if p.reversal_filter {
            let skip = match side {
                Side::Buy => rsi > p.rsi_long_max,
                Side::Sell => rsi < p.rsi_short_min,
            };
            if skip {
                continue;
            }
        }
        if let Some(plan) = build_plan(candles, side, &p.plan) {
            out.push(MlCall { side, probability: prob, rsi, plan });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candles(n: usize, drift: f64) -> Vec<Candle> {
        let mut price = 100.0;
        (0..n)
            .map(|i| {
                let open = price;
                let close = open + drift + ((i as f64) * 0.9).sin() * 0.3;
                price = close;
                Candle::new(i as u64 * 900_000, open, open.max(close) + 0.3, open.min(close) - 0.3, close, 1000.0 + (i % 7) as f64 * 40.0)
            })
            .collect()
    }

    #[test]
    fn a_long_plan_has_the_stop_below_and_the_target_above() {
        let c = candles(200, 0.05);
        let plan = build_plan(&c, Side::Buy, &PlanParams::default()).unwrap();
        assert!(plan.stop < plan.entry && plan.target > plan.entry);
        assert!((plan.rr - 2.0).abs() < 1e-9, "rr {}", plan.rr);
        assert!(plan.risk_pct >= 0.5 - 1e-9 && plan.risk_pct <= 8.0 + 1e-9);
        assert_eq!(plan.entry, c.last().unwrap().close);
    }

    #[test]
    fn a_short_plan_is_the_mirror_image() {
        let c = candles(200, -0.05);
        let plan = build_plan(&c, Side::Sell, &PlanParams::default()).unwrap();
        assert!(plan.stop > plan.entry && plan.target < plan.entry);
        assert!((plan.rr - 2.0).abs() < 1e-9);
    }

    #[test]
    fn the_stop_distance_is_clamped() {
        let c = candles(200, 0.0);
        let tight = build_plan(&c, Side::Buy, &PlanParams { stop_atr_mult: 0.0, buffer_atr: 0.0, lookback: 1, min_stop_pct: 3.0, ..Default::default() }).unwrap();
        assert!((tight.risk_pct - 3.0).abs() < 1e-6, "{}", tight.risk_pct);
        let wide = build_plan(&c, Side::Buy, &PlanParams { stop_atr_mult: 500.0, max_stop_pct: 5.0, ..Default::default() }).unwrap();
        assert!((wide.risk_pct - 5.0).abs() < 1e-6, "{}", wide.risk_pct);
    }

    #[test]
    fn moving_the_levels_recomputes_the_percentages() {
        let c = candles(200, 0.05);
        let plan = build_plan(&c, Side::Buy, &PlanParams::default()).unwrap();
        let moved = plan.with_levels(plan.entry * 0.99, plan.entry * 1.03);
        assert!((moved.risk_pct - 1.0).abs() < 1e-9 && (moved.reward_pct - 3.0).abs() < 1e-9 && (moved.rr - 3.0).abs() < 1e-9);
    }

    #[test]
    fn the_reversal_filter_and_the_threshold_decide_what_becomes_a_call() {
        let c = candles(200, -0.08); // falling: RSI is low
        let always = |_: &FeatureVector, _: Side| Some((1i64, 0.9f64));
        let calls = evaluate(&c, &MlParams::default(), always);
        // a falling market has a low RSI: the long passes the filter, the short does not
        assert!(calls.iter().any(|k| k.side == Side::Buy), "{calls:?}");
        assert!(calls.iter().all(|k| k.side != Side::Sell));
        // no filter: both directions pass
        let both = evaluate(&c, &MlParams { reversal_filter: false, ..Default::default() }, always);
        assert_eq!(both.len(), 2);
        // a confident threshold above the model's answer: nothing
        assert!(evaluate(&c, &MlParams { min_confidence: 0.95, ..Default::default() }, always).is_empty());
        // label 0 is never a call
        assert!(evaluate(&c, &MlParams { reversal_filter: false, ..Default::default() }, |_, _| Some((0, 0.99))).is_empty());
    }

    #[test]
    fn too_little_history_gives_nothing() {
        assert!(evaluate(&candles(50, 0.0), &MlParams::default(), |_, _| Some((1, 0.99))).is_empty());
    }
}
