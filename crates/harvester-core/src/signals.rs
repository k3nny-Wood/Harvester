//! Signals: turn a symbol's candles into scored, explainable setups for the trader.
//!
//! Three kinds:
//!  * `Crack`  - price has just broken a confirmed QFL base (within `fresh_bars` candles);
//!  * `Near`   - an intact base whose crack level is within `near_pct` below the price (a watch, so the list is never
//!               empty in a calm market and the trader can see the scanner working);
//!  * `Drop`   - a sharp fall from the rolling high that is large relative to the symbol's own volatility.
//!
//! Every signal gets a 0-100 score: structure 30, volume 25, magnitude 20, pivot position 15, stabilising 10.
//! The "pivot position" part rewards setups at the low of the recent range (the Donchian-low idea that tested best in
//! the MarketScanner research; treat it as a hypothesis, not a guarantee).

use crate::candle::{atr_pct, Candle};
use crate::movers::{window_label, Spike};
use crate::qfl::{detect_filtered, BaseRangeFilter, QflParams};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SignalKind {
    Crack,
    Near,
    Drop,
    /// a sudden rise of price (see `movers`)
    Pump,
    /// a sudden fall of price
    Dump,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalParams {
    pub qfl: QflParams,
    /// a crack counts as a signal for this many candles after it happens
    pub fresh_bars: usize,
    /// an intact base is "near" when the price is within this % above its crack level
    pub near_pct: f64,
    /// window (candles) for the rolling high used by the drop signal
    pub drop_window: usize,
    /// minimum drop (%) from the rolling high
    pub drop_min_pct: f64,
    /// minimum multiple of the symbol's normal move for a drop signal
    pub drop_min_multiple: f64,
    /// channel length (candles) for the pivot-position score
    pub donch_len: usize,
    /// candles kept in the thumbnail
    pub thumb_bars: usize,
}

impl Default for SignalParams {
    fn default() -> Self {
        SignalParams { qfl: QflParams::default(), fresh_bars: 3, near_pct: 1.0, drop_window: 24, drop_min_pct: 3.0, drop_min_multiple: 2.0, donch_len: 288, thumb_bars: 72 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreParts {
    pub structure: f64,
    pub volume: f64,
    pub magnitude: f64,
    pub pivot: f64,
    pub stabilising: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Signal {
    pub id: String,
    pub symbol: String,
    pub timeframe: String,
    pub kind: SignalKind,
    /// when it triggered (crack / drop candle) or was last evaluated (near), epoch ms
    pub time_ms: u64,
    pub price: f64,
    pub base: Option<f64>,
    pub crack_level: Option<f64>,
    /// price relative to the crack level in % (positive = still above it)
    pub distance_pct: Option<f64>,
    pub drop_pct: f64,
    pub vol_ratio: f64,
    /// 0 = at the low of the channel, 1 = at the high
    pub donch_pos: Option<f64>,
    pub score: u8,
    pub parts: ScoreParts,
    pub reasons: Vec<String>,
    /// last candles for the thumbnail: [time, open, high, low, close]
    pub thumb: Vec<[f64; 5]>,
}

fn clamp01(x: f64) -> f64 {
    x.clamp(0.0, 1.0)
}

/// Last candle's volume relative to the average of the 20 candles before it.
fn volume_ratio(candles: &[Candle], at: usize) -> f64 {
    if at < 20 {
        return 1.0;
    }
    let avg = candles[at - 20..at].iter().map(|c| c.volume).sum::<f64>() / 20.0;
    if avg > 0.0 {
        candles[at].volume / avg
    } else {
        1.0
    }
}

/// Position of `price` inside the high-low channel of the last `len` candles (0 = low, 1 = high).
fn channel_position(candles: &[Candle], len: usize, price: f64) -> Option<f64> {
    if candles.len() < len.min(60) {
        return None;
    }
    let from = candles.len().saturating_sub(len);
    let w = &candles[from..];
    let lo = w.iter().map(|c| c.low).fold(f64::INFINITY, f64::min);
    let hi = w.iter().map(|c| c.high).fold(f64::NEG_INFINITY, f64::max);
    if hi <= lo {
        None
    } else {
        Some(((price - lo) / (hi - lo)).clamp(0.0, 1.0))
    }
}

/// Drop from the highest high of the last `window` candles to the last close, in %, and that drop as a multiple of the
/// symbol's normal move over the same window (ATR% x sqrt(window)).
fn drop_stats(candles: &[Candle], window: usize) -> (f64, f64) {
    let n = candles.len();
    if n < window + 15 {
        return (0.0, 0.0);
    }
    let hi = candles[n - window..].iter().map(|c| c.high).fold(f64::NEG_INFINITY, f64::max);
    let close = candles[n - 1].close;
    if hi <= 0.0 {
        return (0.0, 0.0);
    }
    let drop = (hi - close) / hi * 100.0;
    // "normal" volatility is measured on the candles BEFORE the window, so the drop itself cannot inflate it
    let before = &candles[..n - window];
    let expected = atr_pct(before, (before.len() - 1).min(50)) * (window as f64).sqrt();
    (drop, if expected > 0.0 { drop / expected } else { 0.0 })
}

fn stabilising(candles: &[Candle]) -> (f64, Option<&'static str>) {
    let n = candles.len();
    if n < 2 {
        return (0.0, None);
    }
    let (last, prev) = (&candles[n - 1], &candles[n - 2]);
    if last.close >= last.open {
        (10.0, Some("Last candle is green: the fall is pausing"))
    } else if (last.open - last.close) < (prev.open - prev.close).max(0.0) {
        (6.0, Some("The latest fall is smaller than the one before"))
    } else {
        (0.0, None)
    }
}

fn fmt_money(v: f64) -> String {
    if v >= 1e9 {
        format!("{:.2}B", v / 1e9)
    } else if v >= 1e6 {
        format!("{:.1}M", v / 1e6)
    } else {
        format!("{:.0}K", v / 1e3)
    }
}

/// The signal for a sudden move. `candles` are recent 1-minute candles of the symbol, for the thumbnail (may be empty).
pub fn spike_signal(spike: &Spike, candles: &[Candle], thumb_bars: usize) -> Signal {
    let pump = spike.is_pump();
    let reasons = vec![
        format!("{:+.1}% in {} ({:.1}x its typical move for that long)", spike.change_pct, window_label(spike.window_secs), spike.multiple),
        format!("From {:.6} to {:.6}", spike.from_price, spike.price),
        format!("24h volume {} USDT", fmt_money(spike.quote_volume)),
    ];
    Signal {
        id: format!("{}:spike:{}", spike.symbol, spike.time_ms),
        symbol: spike.symbol.clone(),
        timeframe: "1m".to_string(),
        kind: if pump { SignalKind::Pump } else { SignalKind::Dump },
        time_ms: spike.time_ms,
        price: spike.price,
        base: None,
        crack_level: None,
        distance_pct: Some(spike.change_pct),
        drop_pct: if pump { 0.0 } else { -spike.change_pct },
        vol_ratio: 1.0,
        donch_pos: None,
        score: (40.0 + spike.multiple * 6.0).round().clamp(0.0, 100.0) as u8,
        parts: ScoreParts { structure: 0.0, volume: 0.0, magnitude: 0.0, pivot: 0.0, stabilising: 0.0 },
        reasons,
        thumb: thumb(candles, thumb_bars),
    }
}

fn thumb(candles: &[Candle], bars: usize) -> Vec<[f64; 5]> {
    let from = candles.len().saturating_sub(bars);
    candles[from..].iter().map(|c| [c.open_time as f64, c.open, c.high, c.low, c.close]).collect()
}

struct Common {
    vol_ratio: f64,
    drop_pct: f64,
    drop_multiple: f64,
    donch_pos: Option<f64>,
    stab: f64,
    stab_reason: Option<&'static str>,
}

fn common(candles: &[Candle], vol_at: usize, p: &SignalParams) -> Common {
    let price = candles[candles.len() - 1].close;
    let (drop_pct, drop_multiple) = drop_stats(candles, p.drop_window);
    let (stab, stab_reason) = stabilising(candles);
    Common { vol_ratio: volume_ratio(candles, vol_at), drop_pct, drop_multiple, donch_pos: channel_position(candles, p.donch_len, price), stab, stab_reason }
}

fn parts(structure: f64, c: &Common) -> ScoreParts {
    ScoreParts {
        structure,
        volume: clamp01((c.vol_ratio - 1.0) / 2.0) * 25.0,
        magnitude: clamp01(c.drop_multiple / 3.0) * 20.0,
        pivot: c.donch_pos.map_or(0.0, |p| clamp01(1.0 - p / 0.5) * 15.0),
        stabilising: c.stab,
    }
}

fn total(p: &ScoreParts) -> u8 {
    (p.structure + p.volume + p.magnitude + p.pivot + p.stabilising).round().clamp(0.0, 100.0) as u8
}

fn explain(c: &Common, drop_window: usize, bars_name: &str) -> Vec<String> {
    let mut r = Vec::new();
    if c.vol_ratio >= 1.5 {
        r.push(format!("Volume {:.1}x the 20-bar average", c.vol_ratio));
    }
    if c.drop_pct >= 1.0 {
        r.push(format!("Down {:.1}% from the {drop_window}-bar high ({:.1}x a normal move)", c.drop_pct, c.drop_multiple));
    }
    if let Some(p) = c.donch_pos {
        if p <= 0.25 {
            r.push(format!("Near the low of the recent range (position {:.2}) on {bars_name}", p));
        }
    }
    if let Some(s) = c.stab_reason {
        r.push(s.to_string());
    }
    r
}

/// Analyse one symbol's candles. Needs about 200 candles for the QFL part (the volatility average) and fewer for drops.
pub fn analyse(symbol: &str, timeframe: &str, candles: &[Candle], p: &SignalParams) -> Vec<Signal> {
    let n = candles.len();
    if n < 40 {
        return vec![];
    }
    let last = candles[n - 1];
    let mut out = Vec::new();
    let range_filter: Option<BaseRangeFilter> = None;

    // QFL: the newest confirmed base and whether it has cracked
    let r = detect_filtered(candles, &p.qfl, range_filter);
    if let Some(base) = r.bases.last() {
        let crack = r.cracks.iter().rev().find(|k| (k.base_price - base.price).abs() < f64::EPSILON && k.bar_index > base.confirm_index);
        let level = base.price * (1.0 - p.qfl.crack_pct);
        match crack {
            Some(k) if n - 1 - k.bar_index < p.fresh_bars => {
                let c = common(candles, k.bar_index, p);
                let sp = parts(30.0, &c);
                let mut reasons = vec![format!("Base {:.6} cracked by {:.2}% (level {:.6})", base.price, p.qfl.crack_pct * 100.0, level)];
                reasons.extend(explain(&c, p.drop_window, timeframe));
                out.push(Signal {
                    id: format!("{symbol}:{timeframe}:crack:{}", k.time),
                    symbol: symbol.to_string(),
                    timeframe: timeframe.to_string(),
                    kind: SignalKind::Crack,
                    time_ms: k.time,
                    price: last.close,
                    base: Some(base.price),
                    crack_level: Some(level),
                    distance_pct: Some((last.close - level) / level * 100.0),
                    drop_pct: c.drop_pct,
                    vol_ratio: c.vol_ratio,
                    donch_pos: c.donch_pos,
                    score: total(&sp),
                    parts: sp,
                    reasons,
                    thumb: thumb(candles, p.thumb_bars),
                });
            }
            None => {
                let dist = (last.close - level) / level * 100.0;
                if dist >= 0.0 && dist <= p.near_pct {
                    let c = common(candles, n - 1, p);
                    let sp = parts(30.0 * 0.8 * (1.0 - dist / p.near_pct.max(1e-9)), &c);
                    let mut reasons = vec![format!("{:.2}% above the crack level {:.6} of base {:.6}", dist, level, base.price)];
                    reasons.extend(explain(&c, p.drop_window, timeframe));
                    out.push(Signal {
                        id: format!("{symbol}:{timeframe}:near:{}", base.time),
                        symbol: symbol.to_string(),
                        timeframe: timeframe.to_string(),
                        kind: SignalKind::Near,
                        time_ms: last.open_time,
                        price: last.close,
                        base: Some(base.price),
                        crack_level: Some(level),
                        distance_pct: Some(dist),
                        drop_pct: c.drop_pct,
                        vol_ratio: c.vol_ratio,
                        donch_pos: c.donch_pos,
                        score: total(&sp),
                        parts: sp,
                        reasons,
                        thumb: thumb(candles, p.thumb_bars),
                    });
                }
            }
            _ => {}
        }
    }

    out.extend(analyse_drop(symbol, timeframe, candles, p));
    out
}

/// The drop signal alone: a fall from the recent high that is large relative to the symbol's own volatility. It only looks at the last
/// `drop_window` candles and the ~50 before them (plus the Donchian window for the score), so it is cheap enough to run on every live update,
/// and a handful of recent candles (about 100) is enough to produce it.
pub fn analyse_drop(symbol: &str, timeframe: &str, candles: &[Candle], p: &SignalParams) -> Option<Signal> {
    let n = candles.len();
    if n < 40 {
        return None;
    }
    let last = candles[n - 1];
    let c = common(candles, n - 1, p);
    if !(c.drop_pct >= p.drop_min_pct && c.drop_multiple >= p.drop_min_multiple) {
        return None;
    }
    let sp = parts(0.0, &c);
    let mut reasons = vec![format!("Dropped {:.1}% from the {}-bar high", c.drop_pct, p.drop_window)];
    reasons.extend(explain(&c, p.drop_window, timeframe).into_iter().skip(1));
    Some(Signal {
        id: format!("{symbol}:{timeframe}:drop"),
        symbol: symbol.to_string(),
        timeframe: timeframe.to_string(),
        kind: SignalKind::Drop,
        time_ms: last.open_time,
        price: last.close,
        base: None,
        crack_level: None,
        distance_pct: None,
        drop_pct: c.drop_pct,
        vol_ratio: c.vol_ratio,
        donch_pos: c.donch_pos,
        score: total(&sp),
        parts: sp,
        reasons,
        thumb: thumb(candles, p.thumb_bars),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::qfl::tests::series;

    #[test]
    fn a_fresh_crack_is_reported_with_its_base_and_level() {
        let c = series();
        let sigs = analyse("TESTUSDT", "15m", &c, &SignalParams { fresh_bars: 60, ..Default::default() });
        let crack = sigs.iter().find(|s| s.kind == SignalKind::Crack).expect("a crack signal");
        assert!(crack.base.unwrap() > crack.crack_level.unwrap());
        assert!(crack.distance_pct.unwrap() < 0.0 || crack.price <= crack.base.unwrap());
        assert!(crack.thumb.len() == 72 && crack.score <= 100);
        assert!(crack.reasons[0].contains("cracked"));
    }

    #[test]
    fn a_stale_crack_is_not_a_signal() {
        let mut c = series();
        // 40 more quiet candles after the crack
        let last = *c.last().unwrap();
        for i in 0..40 {
            c.push(Candle::new(last.open_time + 900_000 * (i + 1), last.close, last.close + 0.1, last.close - 0.1, last.close, 1000.0));
        }
        let sigs = analyse("TESTUSDT", "15m", &c, &SignalParams::default());
        assert!(sigs.iter().all(|s| s.kind != SignalKind::Crack));
    }

    #[test]
    fn a_watch_appears_when_price_sits_just_above_the_crack_level() {
        let c = series();
        // walk back until the base exists but has not cracked yet and price is within 1% of the level
        let mut found = false;
        for end in 230..c.len() {
            let sigs = analyse("TESTUSDT", "15m", &c[..end], &SignalParams { near_pct: 15.0, ..Default::default() });
            if sigs.iter().any(|s| s.kind == SignalKind::Near) {
                found = true;
                break;
            }
        }
        assert!(found, "never saw an approaching-base watch");
    }

    #[test]
    fn a_sharp_fall_is_a_drop_signal() {
        let mut c: Vec<Candle> = (0..120)
            .map(|i| Candle::new(i * 900_000, 100.0, 100.3, 99.7, 100.0 + ((i as f64) * 0.9).sin() * 0.1, 1000.0))
            .collect();
        for i in 0..8u64 {
            let p = 100.0 - 1.5 * (i as f64 + 1.0);
            c.push(Candle::new((120 + i) * 900_000, p + 1.5, p + 1.6, p - 0.1, p, 4000.0));
        }
        let sigs = analyse("DROPUSDT", "15m", &c, &SignalParams::default());
        let d = sigs.iter().find(|s| s.kind == SignalKind::Drop).expect("a drop signal");
        assert!(d.drop_pct > 10.0 && d.vol_ratio > 1.5);
    }

    #[test]
    fn the_drop_alone_needs_only_about_a_hundred_recent_candles_and_agrees_with_the_full_analysis() {
        let mut c: Vec<Candle> = (0..120)
            .map(|i| Candle::new(i * 900_000, 100.0, 100.3, 99.7, 100.0 + ((i as f64) * 0.9).sin() * 0.1, 1000.0))
            .collect();
        for i in 0..8u64 {
            let p = 100.0 - 1.5 * (i as f64 + 1.0);
            c.push(Candle::new((120 + i) * 900_000, p + 1.5, p + 1.6, p - 0.1, p, 4000.0));
        }
        let params = SignalParams::default();
        let tail = &c[c.len() - 99..];
        let fast = analyse_drop("DROPUSDT", "15m", tail, &params).expect("a drop from 99 candles");
        let full = analyse("DROPUSDT", "15m", &c, &params).into_iter().find(|s| s.kind == SignalKind::Drop).expect("a drop from the full history");
        assert_eq!(fast.id, full.id);
        assert!((fast.drop_pct - full.drop_pct).abs() < 1e-9);
        // a calm market gives nothing, and so does too little data
        let calm: Vec<Candle> = c[..100].to_vec();
        assert!(analyse_drop("DROPUSDT", "15m", &calm, &params).is_none());
        assert!(analyse_drop("DROPUSDT", "15m", &c[c.len() - 20..], &params).is_none());
    }

    #[test]
    fn too_little_data_gives_nothing() {
        assert!(analyse("X", "15m", &[], &SignalParams::default()).is_empty());
    }

    #[test]
    fn scores_stay_within_0_to_100() {
        let c = series();
        for end in (100..c.len()).step_by(7) {
            for s in analyse("T", "15m", &c[..end], &SignalParams { near_pct: 50.0, fresh_bars: 500, ..Default::default() }) {
                assert!(s.score <= 100);
            }
        }
    }

    #[test]
    fn a_spike_becomes_a_pump_or_dump_signal_with_a_score_from_how_unusual_it_is() {
        let up = Spike { symbol: "ABCUSDT".into(), time_ms: 1_700_000_000_000, window_secs: 300, change_pct: 4.2, from_price: 1.0, price: 1.042, multiple: 6.0, quote_volume: 82e6 };
        let s = spike_signal(&up, &[], 60);
        assert_eq!(s.kind, SignalKind::Pump);
        assert_eq!(s.timeframe, "1m");
        assert_eq!(s.score, 76);
        assert!(s.reasons[0].contains("+4.2% in 5m") && s.reasons[0].contains("6.0x"));
        assert!(s.reasons[2].contains("82.0M"));
        assert!(s.id.starts_with("ABCUSDT:spike:"));
        let down = Spike { change_pct: -3.1, multiple: 30.0, ..up.clone() };
        let d = spike_signal(&down, &[], 60);
        assert_eq!(d.kind, SignalKind::Dump);
        assert_eq!(d.score, 100, "the score stays within 0..100");
        assert!((d.drop_pct - 3.1).abs() < 1e-9);
    }
}
