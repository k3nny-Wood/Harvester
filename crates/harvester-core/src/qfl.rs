//! QFL (Quickfingers Luc) base detector: a bar-for-bar port of the "Quickfingers Luc base scanner - Marvin"
//! Pine script (v2.2), carried over from MarketScanner's Rust implementation.
//!
//! A *base* is a swing low that price pumped away from by a volatility-derived move (a rolling 200-bar SMA of
//! `TR / hl2`, times `volatility_factor`). A *crack* is a later candle whose low breaks the base by `crack_pct`.
//! Nothing is reported before bar 199 (the SMA is `na` in Pine until then) or before the first confirmed base.

use crate::candle::Candle;
use serde::{Deserialize, Serialize};

const SMA_LEN: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QflBase {
    pub price: f64,
    /// open time of the base low candle
    pub time: u64,
    /// index of the base low
    pub bar_index: usize,
    /// index of the candle that confirmed it (the pump away)
    pub confirm_index: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QflTop {
    pub price: f64,
    pub time: u64,
    pub bar_index: usize,
}

/// The first candle that cracked a base.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QflCrack {
    /// the level that was broken: `base x (1 - crack_pct)`
    pub level: f64,
    pub time: u64,
    pub bar_index: usize,
    pub base_price: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QflResult {
    pub bases: Vec<QflBase>,
    pub tops: Vec<QflTop>,
    pub cracks: Vec<QflCrack>,
    pub current_base: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QflParams {
    /// multiplier on the rolling average of TR / hl2 that defines a "big move"
    pub volatility_factor: f64,
    /// fraction below the base that counts as a crack (0.005 = 0.5%)
    pub crack_pct: f64,
    /// use `manual_move_pct` (a fraction) instead of the volatility-derived threshold
    pub use_manual: bool,
    pub manual_move_pct: f64,
}

impl Default for QflParams {
    fn default() -> Self {
        QflParams { volatility_factor: 1.0, crack_pct: 0.005, use_manual: false, manual_move_pct: 0.03 }
    }
}

/// Reject bases formed by a pause in the middle of a rally: the base low must sit in the lower `max_pos`
/// fraction of the last `lookback` bars up to and including the low.
#[derive(Debug, Clone, Copy)]
pub struct BaseRangeFilter {
    pub lookback: usize,
    pub max_pos: f64,
}

#[derive(Clone, Copy)]
enum State {
    First,
    Base,
    Top,
}

pub fn detect(candles: &[Candle], params: &QflParams) -> QflResult {
    detect_filtered(candles, params, None)
}

pub fn detect_filtered(candles: &[Candle], params: &QflParams, filter: Option<BaseRangeFilter>) -> QflResult {
    // True if a base at `price`, whose low is candle `low_idx`, passes the range filter.
    let passes = |low_idx: usize, price: f64| -> bool {
        let Some(f) = filter else { return true };
        if f.max_pos >= 1.0 {
            return true;
        }
        let from = low_idx.saturating_sub(f.lookback);
        let w = &candles[from..=low_idx.min(candles.len() - 1)];
        let lo = w.iter().map(|c| c.low).fold(f64::INFINITY, f64::min);
        let hi = w.iter().map(|c| c.high).fold(f64::NEG_INFINITY, f64::max);
        if hi <= lo {
            return true;
        }
        (price - lo) / (hi - lo) <= f.max_pos
    };

    let mut bases = Vec::new();
    let mut tops = Vec::new();
    let mut cracks = Vec::new();
    if candles.is_empty() {
        return QflResult { bases, tops, cracks, current_base: None };
    }

    let mut state = State::First;
    let mut highest_high = candles[0].high;
    let mut lowest_low = candles[0].low;
    let mut base = candles[0].low;
    let mut base_confirmed = false;
    let mut buy_flag = false;
    let mut count: usize = 0;
    let mut lowest_idx: usize = 0;

    // previous bar's end-of-bar values (Pine's `x[1]`)
    let mut prev_hh = highest_high;
    let mut prev_ll = lowest_low;
    let mut prev_count: usize = 0;

    let mut atrp: Vec<f64> = Vec::with_capacity(candles.len());

    for (i, c) in candles.iter().enumerate() {
        count += 1;

        let tr = if i == 0 {
            c.high - c.low
        } else {
            let pc = candles[i - 1].close;
            (c.high - c.low).max((c.high - pc).abs()).max((c.low - pc).abs())
        };
        let hl2 = (c.high + c.low) / 2.0;
        atrp.push(if hl2 > 0.0 { tr / hl2 } else { 0.0 });

        let move_threshold = if params.use_manual {
            Some(params.manual_move_pct)
        } else if i + 1 >= SMA_LEN {
            let sma = atrp[i + 1 - SMA_LEN..=i].iter().sum::<f64>() / SMA_LEN as f64;
            Some(sma * params.volatility_factor)
        } else {
            None
        };

        // Pine seeds the extremes from bar 0: track the real extremes (and where the low happened) while in the seed state.
        if matches!(state, State::First) {
            if c.high > highest_high {
                highest_high = c.high;
            }
            if c.low < lowest_low {
                lowest_low = c.low;
                lowest_idx = i;
            }
        }

        if let Some(mv) = move_threshold {
            match state {
                State::First => {
                    if (highest_high - c.low) / highest_high > mv {
                        state = State::Top;
                        tops.push(QflTop { price: highest_high, time: c.open_time, bar_index: i });
                        highest_high = c.high;
                        lowest_low = c.low;
                        count = 0;
                    } else if (c.high - lowest_low) / lowest_low > mv && passes(lowest_idx, lowest_low) {
                        state = State::Base;
                        base = lowest_low;
                        base_confirmed = true;
                        bases.push(QflBase { price: base, time: candles[lowest_idx].open_time, bar_index: lowest_idx, confirm_index: i });
                        lowest_low = c.low;
                        count = 0;
                    }
                }
                State::Base => {
                    if c.low < lowest_low {
                        lowest_low = c.low;
                    }
                    if c.high > highest_high {
                        highest_high = c.high;
                        lowest_low = c.low;
                        count = 0;
                    }
                    if (prev_hh - c.low) / prev_hh > mv {
                        state = State::Top;
                        let idx = i.saturating_sub(prev_count + 1);
                        tops.push(QflTop { price: prev_hh, time: candles[idx].open_time, bar_index: idx });
                        highest_high = c.high;
                        lowest_low = c.low;
                        count = 0;
                    }
                }
                State::Top => {
                    if c.high > highest_high {
                        highest_high = c.high;
                    }
                    if c.low < lowest_low {
                        highest_high = c.high;
                        lowest_low = c.low;
                        count = 0;
                    }
                    let low_idx = i.saturating_sub(prev_count + 1);
                    if (c.high - prev_ll) / prev_ll > mv && passes(low_idx, prev_ll) {
                        state = State::Base;
                        base = prev_ll;
                        base_confirmed = true;
                        bases.push(QflBase { price: base, time: candles[low_idx].open_time, bar_index: low_idx, confirm_index: i });
                        highest_high = c.high;
                        lowest_low = c.low;
                        count = 0;
                        buy_flag = false;
                    }
                }
            }
        }

        // The crack check runs in every state (as in Pine); the first crack per base only.
        if base_confirmed && move_threshold.is_some() && !buy_flag && (base - c.low) / base > params.crack_pct {
            cracks.push(QflCrack { level: base * (1.0 - params.crack_pct), time: c.open_time, bar_index: i, base_price: base });
            buy_flag = true;
        }

        prev_hh = highest_high;
        prev_ll = lowest_low;
        prev_count = count;
    }

    let current_base = if base_confirmed { Some(base) } else { None };
    QflResult { bases, tops, cracks, current_base }
}

/// A base as the chart draws it: where it formed, where price first broke through it (if it did) and the level that counts as a crack.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseView {
    pub price: f64,
    /// open time of the base low candle
    pub time: u64,
    /// open time of the candle that confirmed it (the pump away)
    pub confirm_time: u64,
    /// open time of the first candle that cracked it; None while it still holds
    pub crack_time: Option<u64>,
    /// `price x (1 - crack_pct)`
    pub crack_level: f64,
}

/// The newest `max` confirmed bases of `candles`, oldest first, each with the candle that first cracked it.
pub fn base_views(candles: &[Candle], params: &QflParams, max: usize) -> Vec<BaseView> {
    let r = detect(candles, params);
    let mut out: Vec<BaseView> = r
        .bases
        .iter()
        .map(|b| {
            // The detector only follows the newest base, so a base that was replaced before price fell through it has no crack record.
            // Look at the candles themselves: the first one after the confirmation whose low is below the crack level.
            let level = b.price * (1.0 - params.crack_pct);
            let crack_time = candles.iter().skip(b.confirm_index + 1).find(|c| c.low <= level).map(|c| c.open_time);
            BaseView { price: b.price, time: b.time, confirm_time: candles.get(b.confirm_index).map_or(b.time, |c| c.open_time), crack_time, crack_level: level }
        })
        .collect();
    if out.len() > max {
        out.drain(..out.len() - max);
    }
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A quiet, slowly wandering series so the volatility SMA is meaningful, then a clear
    /// base -> pump -> fall-through-the-base sequence.
    pub(crate) fn series() -> Vec<Candle> {
        let mut out = Vec::new();
        let mut t = 0u64;
        let mut price = 100.0f64;
        let mut push = |o: &mut Vec<Candle>, open: f64, close: f64, wick: f64| {
            let hi = open.max(close) + wick;
            let lo = open.min(close) - wick;
            o.push(Candle::new(t, open, hi, lo, close, 1000.0));
            t += 900_000;
        };
        // 220 quiet bars (the volatility average needs 200)
        for i in 0..220 {
            let drift = ((i as f64) * 0.7).sin() * 0.15;
            let next = price + drift;
            push(&mut out, price, next, 0.12);
            price = next;
        }
        // sell-off to a low, then a strong pump away from it (confirms the base)
        for _ in 0..8 {
            let next = price - 1.2;
            push(&mut out, price, next, 0.2);
            price = next;
        }
        let base_low = price - 0.2;
        for _ in 0..8 {
            let next = price + 1.6;
            push(&mut out, price, next, 0.2);
            price = next;
        }
        // drift back down through the base level
        while price > base_low - 1.5 {
            let next = price - 1.0;
            push(&mut out, price, next, 0.2);
            price = next;
        }
        out
    }

    #[test]
    fn finds_a_base_after_the_pump_and_its_crack() {
        let c = series();
        let r = detect(&c, &QflParams::default());
        assert!(!r.bases.is_empty(), "no base found");
        let b = r.bases.last().unwrap();
        assert!(b.confirm_index > b.bar_index);
        // the base is the sell-off low, well below the quiet range
        assert!(b.price < 95.0, "base {}", b.price);
        let crack = r.cracks.iter().find(|k| (k.base_price - b.price).abs() < 1e-9).expect("base was cracked");
        assert!(crack.level < b.price);
        assert!(crack.bar_index > b.confirm_index);
    }

    #[test]
    fn nothing_before_the_volatility_average_exists() {
        let c = series();
        let r = detect(&c[..150], &QflParams::default());
        assert!(r.bases.is_empty() && r.cracks.is_empty());
    }

    #[test]
    fn the_range_filter_can_reject_a_base() {
        let c = series();
        // require the base to sit in the lowest 0.01% of the last 5 bars: practically impossible
        let strict = detect_filtered(&c, &QflParams::default(), Some(BaseRangeFilter { lookback: 5, max_pos: 0.0 }));
        let loose = detect(&c, &QflParams::default());
        assert!(strict.bases.len() <= loose.bases.len());
    }

    #[test]
    fn base_views_carry_the_crack_and_the_level() {
        let c = series();
        let params = QflParams::default();
        let v = base_views(&c, &params, 10);
        assert!(!v.is_empty());
        let last = v.last().unwrap();
        assert!((last.crack_level - last.price * (1.0 - params.crack_pct)).abs() < 1e-12);
        assert!(last.crack_time.is_some(), "the series ends below the base, so it was cracked");
        assert!(last.confirm_time > last.time);
        // the cap keeps the newest bases
        assert!(base_views(&c, &params, 1).len() <= 1);
    }

    #[test]
    fn a_base_that_was_replaced_before_price_fell_through_it_is_still_marked_cracked() {
        let c = series();
        let params = QflParams::default();
        let v = base_views(&c, &params, 10);
        // every base whose crack level the candles later traded below must carry a crack time, and none that held may
        for b in &v {
            let confirm = c.iter().position(|x| x.open_time == b.confirm_time).unwrap();
            let broke = c.iter().skip(confirm + 1).any(|x| x.low <= b.crack_level);
            assert_eq!(b.crack_time.is_some(), broke, "base {}", b.price);
        }
    }

    #[test]
    fn empty_input_is_fine() {
        let r = detect(&[], &QflParams::default());
        assert!(r.bases.is_empty() && r.current_base.is_none());
    }
}
