//! Smart Money Concepts zones: fair value gaps, order blocks and breaker blocks.
//!
//! A port of MarketScanner's `smc` module (detection rules and defaults unchanged), reshaped into one `SmcZone` type that the chart can
//! draw. A zone is a price band that some part of the market is expected to react to:
//!  - **Fair value gap (FVG)**: three candles where the first candle's high and the third candle's low leave a gap (bullish) or the
//!    first low and the third high leave one (bearish). Price tends to come back to fill it.
//!  - **Order block (OB)**: the last opposite candle before an impulse that broke a swing high / low (bullish: the last down candle
//!    before price closed above the swing high). The move must be large for the coin (ATR based) and, unless it is very large, carry volume.
//!  - **Breaker block**: an order block price closed through, which then works the other way round (a broken bullish OB becomes resistance).
//! A zone shrinks as price taps into it (`low`/`high` are what is left) and disappears once it is fully mitigated.
//!
//! These are patterns, not edges: nothing here says they pay. The Lab is where that gets tested.

use crate::candle::Candle;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SmcKind {
    Fvg,
    OrderBlock,
    Breaker,
}

/// A zone as the chart draws it.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmcZone {
    pub kind: SmcKind,
    /// true = expected to act as support (buyers), false = resistance (sellers)
    pub bullish: bool,
    /// open time of the candle that defines the zone (the FVG's middle candle, the order block candle)
    pub time: u64,
    /// open time of the candle that confirmed it (the FVG's third candle, the candle that broke the swing / the order block)
    pub confirm_time: u64,
    /// what is LEFT of the zone after price tapped into it
    pub low: f64,
    pub high: f64,
    /// the zone as it was formed
    pub full_low: f64,
    pub full_high: f64,
    /// price has already tapped into it (but not through it)
    pub partially_mitigated: bool,
    /// FVG: gap size in % of price; order block: the impulse move in %
    pub size_pct: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SmcParams {
    /// smallest fair value gap worth keeping, % of price
    pub min_fvg_size_pct: f64,
    pub max_ob_lookback: usize,
    /// fallback minimum order-block move, %, when ATR cannot be computed
    pub min_ob_move_pct: f64,
    pub swing_lookback: usize,
    pub swing_confirm_forward: usize,
    pub min_ob_volume_ratio: f64,
    pub ob_volume_lookback: usize,
    pub atr_period: usize,
    /// an order block's impulse must be at least this many ATRs
    pub atr_multiplier: f64,
}

impl Default for SmcParams {
    fn default() -> Self {
        SmcParams { min_fvg_size_pct: 0.5, max_ob_lookback: 20, min_ob_move_pct: 3.0, swing_lookback: 10, swing_confirm_forward: 3, min_ob_volume_ratio: 1.2, ob_volume_lookback: 20, atr_period: 14, atr_multiplier: 1.2 }
    }
}

fn nearly_equal(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-9
}

fn confirmed_swing_low(c: &[Candle], i: usize, back: usize, fwd: usize) -> bool {
    let start = i.saturating_sub(back);
    let min_low = c[start..=i].iter().fold(f64::INFINITY, |a, x| a.min(x.low));
    if !nearly_equal(c[i].low, min_low) {
        return false;
    }
    let end = (i + fwd).min(c.len() - 1);
    c[i + 1..=end].iter().all(|x| x.low >= c[i].low)
}

fn confirmed_swing_high(c: &[Candle], i: usize, back: usize, fwd: usize) -> bool {
    let start = i.saturating_sub(back);
    let max_high = c[start..=i].iter().fold(f64::NEG_INFINITY, |a, x| a.max(x.high));
    if !nearly_equal(c[i].high, max_high) {
        return false;
    }
    let end = (i + fwd).min(c.len() - 1);
    c[i + 1..=end].iter().all(|x| x.high <= c[i].high)
}

/// ATR of the `period` candles ending at `end`, in % of the close at `end`.
fn atr_pct_at(c: &[Candle], period: usize, end: usize) -> f64 {
    if c.len() < period || end < period || period == 0 {
        return 0.0;
    }
    let sum: f64 = (end - period + 1..=end)
        .map(|i| {
            let (h, l, pc) = (c[i].high, c[i].low, c[i - 1].close);
            (h - l).max((h - pc).abs()).max((l - pc).abs())
        })
        .sum();
    if c[end].close <= 0.0 {
        return 0.0;
    }
    sum / period as f64 / c[end].close * 100.0
}

fn min_move_threshold(c: &[Candle], ob_idx: usize, p: &SmcParams) -> f64 {
    let atr = atr_pct_at(c, p.atr_period, ob_idx);
    if atr <= 0.0 {
        return p.min_ob_move_pct;
    }
    (atr * p.atr_multiplier).clamp(0.5, 20.0)
}

fn impulse_has_volume(c: &[Candle], ob_idx: usize, trigger: usize, p: &SmcParams, move_pct: f64, threshold: f64) -> bool {
    if p.min_ob_volume_ratio <= 0.0 {
        return true;
    }
    let from = ob_idx.saturating_sub(p.ob_volume_lookback);
    if from >= ob_idx {
        return true;
    }
    let avg = c[from..ob_idx].iter().map(|x| x.volume).sum::<f64>() / (ob_idx - from) as f64;
    if avg <= 0.0 {
        return true;
    }
    // a big enough move counts without the volume: price matters more than volume
    c[ob_idx + 1..=trigger].iter().any(|x| x.volume >= avg * p.min_ob_volume_ratio) || move_pct >= threshold * 2.0
}

fn fair_value_gaps(c: &[Candle], p: &SmcParams) -> Vec<SmcZone> {
    let mut out = Vec::new();
    for i in 2..c.len() {
        let (a, m, z) = (&c[i - 2], &c[i - 1], &c[i]);
        // bullish: the third candle's low is above the first candle's high
        let (bullish, low, high) = if z.low > a.high {
            (true, a.high, z.low)
        } else if z.high < a.low {
            (false, z.high, a.low)
        } else {
            continue;
        };
        let size_pct = (high - low) / a.close * 100.0;
        if size_pct < p.min_fvg_size_pct {
            continue;
        }
        // later candles eat into the gap from the side price comes from; a wick through it fills it
        let (mut cur_low, mut cur_high, mut filled, mut partial) = (low, high, false, false);
        for x in &c[i + 1..] {
            if bullish {
                if x.low < high {
                    if x.low <= low {
                        filled = true;
                        break;
                    }
                    cur_high = cur_high.min(x.low);
                    partial = true;
                }
            } else if x.high > low {
                if x.high >= high {
                    filled = true;
                    break;
                }
                cur_low = cur_low.max(x.high);
                partial = true;
            }
        }
        if !filled {
            out.push(SmcZone { kind: SmcKind::Fvg, bullish, time: m.open_time, confirm_time: z.open_time, low: cur_low, high: cur_high, full_low: low, full_high: high, partially_mitigated: partial, size_pct });
        }
    }
    out
}

struct Ob {
    bullish: bool,
    idx: usize,
    trigger: usize,
    move_pct: f64,
}

fn build_order_block(c: &[Candle], p: &SmcParams, bullish: bool, swing_idx: usize, last_opposite_swing: Option<usize>, trigger: usize) -> Option<Ob> {
    let mut start = last_opposite_swing.unwrap_or(swing_idx);
    if start > trigger {
        start = swing_idx;
    }
    start = start.max(trigger.saturating_sub(p.max_ob_lookback.max(1)));
    // the last candle against the move: a down candle before a bullish break, an up candle before a bearish one
    let idx = (start..=trigger).rev().find(|&j| if bullish { c[j].close < c[j].open } else { c[j].close > c[j].open }).unwrap_or(swing_idx);
    let ob = &c[idx];
    let move_pct = if bullish {
        if ob.low <= 0.0 {
            return None;
        }
        ((c[trigger].close - ob.low) / ob.low).abs() * 100.0
    } else {
        if ob.high <= 0.0 {
            return None;
        }
        ((ob.high - c[trigger].close) / ob.high).abs() * 100.0
    };
    let threshold = min_move_threshold(c, idx, p);
    if move_pct < threshold || !impulse_has_volume(c, idx, trigger, p, move_pct, threshold) {
        return None;
    }
    Some(Ob { bullish, idx, trigger, move_pct })
}

fn order_blocks(c: &[Candle], p: &SmcParams) -> Vec<Ob> {
    let (back, fwd) = (p.swing_lookback.max(2), p.swing_confirm_forward.max(1));
    if c.len() < 10 || c.len() <= back + fwd {
        return vec![];
    }
    let (mut last_high, mut last_low): (Option<usize>, Option<usize>) = (None, None);
    let (mut done_highs, mut done_lows) = (HashSet::new(), HashSet::new());
    let mut out = Vec::new();
    for i in back..c.len() - fwd {
        if confirmed_swing_high(c, i, back, fwd) {
            last_high = Some(i);
        }
        if confirmed_swing_low(c, i, back, fwd) {
            last_low = Some(i);
        }
        if let Some(h) = last_high {
            if !done_highs.contains(&h) && c[i].close > c[h].high {
                if let Some(ob) = build_order_block(c, p, true, h, last_low, i) {
                    out.push(ob);
                }
                done_highs.insert(h);
            }
        }
        if let Some(l) = last_low {
            if !done_lows.contains(&l) && c[i].close < c[l].low {
                if let Some(ob) = build_order_block(c, p, false, l, last_high, i) {
                    out.push(ob);
                }
                done_lows.insert(l);
            }
        }
    }
    out
}

/// Trim a zone by the candles after `from`; Some((low, high, tapped)) while it survives, None once fully mitigated.
fn mitigate(c: &[Candle], from: usize, bullish: bool, low: f64, high: f64) -> Option<(f64, f64, bool)> {
    let (mut lo, mut hi, mut tapped) = (low, high, false);
    for x in c.iter().skip(from) {
        if bullish {
            // support: price comes down from above and eats the top
            if x.low <= hi {
                tapped = true;
                hi = hi.min(x.low);
                if hi <= lo || x.close < lo {
                    return None;
                }
            }
        } else if x.high >= lo {
            // resistance: price comes up from below and eats the bottom
            tapped = true;
            lo = lo.max(x.high);
            if lo >= hi || x.close > hi {
                return None;
            }
        }
    }
    Some((lo, hi, tapped))
}

/// All zones of `candles`, oldest first, at most `max_each` of every kind (the newest).
pub fn smc_zones(candles: &[Candle], p: &SmcParams, max_each: usize) -> Vec<SmcZone> {
    let mut fvgs = fair_value_gaps(candles, p);

    let obs = order_blocks(candles, p);
    let mut blocks: Vec<SmcZone> = Vec::new();
    let mut breakers: Vec<SmcZone> = Vec::new();
    for ob in &obs {
        let c = &candles[ob.idx];
        let confirm_time = candles[ob.trigger].open_time;
        if let Some((lo, hi, tapped)) = mitigate(candles, ob.trigger + 1, ob.bullish, c.low, c.high) {
            blocks.push(SmcZone { kind: SmcKind::OrderBlock, bullish: ob.bullish, time: c.open_time, confirm_time, low: lo, high: hi, full_low: c.low, full_high: c.high, partially_mitigated: tapped, size_pct: ob.move_pct });
        }
        // a close through the block (below a bullish one, above a bearish one) turns it into a breaker with the opposite polarity
        let broke = candles.iter().enumerate().skip(ob.trigger + 1).find(|(_, x)| if ob.bullish { x.close < c.low } else { x.close > c.high });
        if let Some((bi, _)) = broke {
            if let Some((lo, hi, tapped)) = mitigate(candles, bi + 1, !ob.bullish, c.low, c.high) {
                breakers.push(SmcZone { kind: SmcKind::Breaker, bullish: !ob.bullish, time: c.open_time, confirm_time: candles[bi].open_time, low: lo, high: hi, full_low: c.low, full_high: c.high, partially_mitigated: tapped, size_pct: ob.move_pct });
            }
        }
    }
    let newest = |mut v: Vec<SmcZone>| {
        if v.len() > max_each {
            v.drain(..v.len() - max_each);
        }
        v
    };
    let mut out = newest(std::mem::take(&mut fvgs));
    out.extend(newest(blocks));
    out.extend(newest(breakers));
    out.sort_by_key(|z| z.time);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(i: u64, o: f64, h: f64, l: f64, cl: f64, v: f64) -> Candle {
        Candle::new(i * 900_000, o, h, l, cl, v)
    }

    /// quiet candles around 100
    fn quiet(n: usize) -> Vec<Candle> {
        (0..n).map(|i| c(i as u64, 100.0, 100.4, 99.6, 100.0, 1000.0)).collect()
    }

    #[test]
    fn a_bullish_gap_is_found_and_trimmed_by_a_tap_then_removed_by_a_fill() {
        let mut v = quiet(5);
        // candle a (high 100.4), the impulse candle, then c with low 103: the gap is 100.4..103
        v.push(c(5, 100.0, 100.4, 99.6, 100.0, 1000.0));
        v.push(c(6, 100.0, 104.0, 100.0, 103.8, 5000.0));
        v.push(c(7, 103.8, 105.0, 103.0, 104.5, 2000.0));
        let p = SmcParams::default();
        let z = smc_zones(&v, &p, 30);
        let g = z.iter().find(|x| x.kind == SmcKind::Fvg).expect("a gap");
        assert!(g.bullish);
        assert!((g.full_low - 100.4).abs() < 1e-9 && (g.full_high - 103.0).abs() < 1e-9);
        assert!(!g.partially_mitigated);
        // a candle dipping to 101.5 eats the top of the gap; one reaching 100.4 fills it
        let mut tapped = v.clone();
        tapped.push(c(8, 104.5, 104.6, 101.5, 102.0, 1000.0));
        let t = smc_zones(&tapped, &p, 30).into_iter().find(|x| x.kind == SmcKind::Fvg).unwrap();
        assert!(t.partially_mitigated && (t.high - 101.5).abs() < 1e-9 && (t.low - 100.4).abs() < 1e-9);
        let mut filled = tapped;
        filled.push(c(9, 102.0, 102.1, 100.3, 101.0, 1000.0));
        // the original gap is gone (the dip also left a new, bearish one higher up, which is a different gap)
        assert!(smc_zones(&filled, &p, 30).iter().all(|x| !(x.kind == SmcKind::Fvg && (x.full_low - 100.4).abs() < 1e-9)));
    }

    #[test]
    fn a_gap_below_the_minimum_size_is_ignored_and_a_bearish_gap_is_the_mirror() {
        let mut small = quiet(5);
        small.push(c(5, 100.0, 100.4, 99.6, 100.0, 1.0));
        small.push(c(6, 100.0, 100.9, 100.0, 100.8, 1.0));
        small.push(c(7, 100.8, 101.2, 100.6, 101.0, 1.0)); // gap 100.4..100.6 = 0.2%
        assert!(smc_zones(&small, &SmcParams::default(), 30).iter().all(|x| x.kind != SmcKind::Fvg));
        let mut down = quiet(5);
        down.push(c(5, 100.0, 100.4, 99.6, 100.0, 1000.0));
        down.push(c(6, 100.0, 100.0, 96.0, 96.4, 5000.0));
        down.push(c(7, 96.4, 97.0, 95.0, 95.5, 2000.0)); // high 97.0 < first low 99.6: gap 97.0..99.6
        let g = smc_zones(&down, &SmcParams::default(), 30).into_iter().find(|x| x.kind == SmcKind::Fvg).expect("a gap");
        assert!(!g.bullish);
        assert!((g.full_low - 97.0).abs() < 1e-9 && (g.full_high - 99.6).abs() < 1e-9);
    }

    /// a swing high at index 12, a pullback with a down candle, then a strong close above the swing high
    fn breakout() -> Vec<Candle> {
        let mut v = Vec::new();
        for i in 0..30 {
            v.push(c(i, 100.0 + (i as f64) * 0.05, 100.45 + (i as f64) * 0.05, 99.7 + (i as f64) * 0.05, 100.1 + (i as f64) * 0.05, 1000.0));
        }
        v[12] = c(12, 101.0, 103.0, 100.8, 102.0, 1500.0); // the swing high: 103
        // a pullback: the last down candle before the breakout is the order block
        v.push(c(30, 101.2, 101.3, 99.9, 100.0, 1100.0)); // down candle 100.0..101.3
        v.push(c(31, 100.0, 101.0, 99.95, 100.9, 1200.0));
        v.push(c(32, 100.9, 106.5, 100.8, 106.0, 6000.0)); // impulse: closes above 103
        for k in 0..6 {
            v.push(c(33 + k, 106.0, 107.0, 105.5, 106.5, 1000.0));
        }
        v
    }

    #[test]
    fn a_bullish_order_block_is_the_last_down_candle_before_the_break_and_shrinks_when_tapped() {
        let v = breakout();
        let z = smc_zones(&v, &SmcParams::default(), 30);
        let ob = z.iter().find(|x| x.kind == SmcKind::OrderBlock).expect("an order block");
        assert!(ob.bullish);
        assert_eq!(ob.time, 30 * 900_000, "{ob:?}");
        assert!(!ob.partially_mitigated);
        assert!((ob.full_low - 99.9).abs() < 1e-9 && (ob.full_high - 101.3).abs() < 1e-9);
        // price returns into the block from above: the top is eaten
        let mut tapped = v;
        tapped.push(c(39, 106.5, 106.6, 100.7, 101.0, 1500.0));
        let t = smc_zones(&tapped, &SmcParams::default(), 30).into_iter().find(|x| x.kind == SmcKind::OrderBlock).unwrap();
        assert!(t.partially_mitigated && t.high < t.full_high && (t.low - 99.9).abs() < 1e-9, "{t:?}");
    }

    #[test]
    fn closing_through_an_order_block_turns_it_into_a_resistance_breaker() {
        let mut v = breakout();
        // price collapses and closes below the block (99.9), then bounces up into it from below
        v.push(c(39, 106.5, 106.6, 98.0, 98.5, 4000.0));
        v.push(c(40, 98.5, 99.2, 97.8, 99.0, 1500.0));
        let z = smc_zones(&v, &SmcParams::default(), 30);
        assert!(z.iter().all(|x| x.kind != SmcKind::OrderBlock), "a block price closed through is gone");
        let b = z.iter().find(|x| x.kind == SmcKind::Breaker).expect("a breaker");
        assert!(!b.bullish, "a broken support turns into resistance: {b:?}");
    }

    #[test]
    fn at_most_max_each_of_every_kind_and_too_little_data_is_fine() {
        assert!(smc_zones(&[], &SmcParams::default(), 5).is_empty());
        assert!(smc_zones(&quiet(4), &SmcParams::default(), 5).is_empty());
        let mut v = Vec::new();
        for k in 0..10u64 {
            v.push(c(k * 4, 100.0, 100.4, 99.6, 100.0, 1.0));
            v.push(c(k * 4 + 1, 100.0, 104.0, 100.0, 103.8, 1.0));
            v.push(c(k * 4 + 2, 103.8, 105.0, 103.0, 104.5, 1.0));
            v.push(c(k * 4 + 3, 104.5, 104.6, 103.2, 103.4, 1.0));
        }
        let all = smc_zones(&v, &SmcParams::default(), 30);
        let capped = smc_zones(&v, &SmcParams::default(), 3);
        assert!(all.iter().filter(|x| x.kind == SmcKind::Fvg).count() >= capped.iter().filter(|x| x.kind == SmcKind::Fvg).count());
        assert!(capped.iter().filter(|x| x.kind == SmcKind::Fvg).count() <= 3);
    }
}
