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

/// A support ZONE as the chart draws it: one or more bases at nearly the same price that reinforce each other.
///
/// A base is a swing low price pumped away from. Several of them at the same price area are one level that has held more than
/// once, so they are combined: the zone spans the lowest to the highest base price, starts at the oldest, and counts how many bases
/// and how many *touches* (a candle that dipped into the zone without cracking it and closed back above it) it has.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseZone {
    /// the lowest base price in the zone
    pub low: f64,
    /// the highest base price in the zone (equal to `low` for a single base)
    pub high: f64,
    /// open time of the oldest base low candle
    pub time: u64,
    /// open time of the candle that confirmed the oldest base
    pub confirm_time: u64,
    /// open time of the first candle that cracked the zone; None while it still holds
    pub crack_time: Option<u64>,
    /// `low x (1 - crack_pct)`: trading below this breaks the zone
    pub crack_level: f64,
    /// how many bases were combined (1 = a lone base)
    pub bases: usize,
    /// how many times price came back to the zone and held it
    pub touches: usize,
}

fn first_crack(candles: &[Candle], after: usize, level: f64) -> Option<u64> {
    candles.iter().skip(after + 1).find(|c| c.low <= level).map(|c| c.open_time)
}

/// Retests of a zone: separate episodes of a candle reaching down into it (low <= `high`) without cracking it and closing back above it.
fn count_touches(candles: &[Candle], after: usize, high: f64, crack_level: f64, until: Option<u64>) -> usize {
    let (mut n, mut inside) = (0usize, false);
    for c in candles.iter().skip(after) {
        if until.map_or(false, |t| c.open_time >= t) {
            break;
        }
        let touching = c.low <= high && c.low > crack_level && c.close > high;
        if touching && !inside {
            n += 1;
        }
        inside = touching;
    }
    n
}

/// The newest `max` support zones of `candles`, oldest first. Bases whose prices are within `merge_pct` percent of a zone are folded
/// into it while that zone is still intact; once price has cracked a zone, a later base at the same price starts a new one. A zone
/// never grows wider than twice the tolerance, so a slow staircase of bases cannot melt into one huge box.
pub fn base_zones(candles: &[Candle], params: &QflParams, merge_pct: f64, max: usize) -> Vec<BaseZone> {
    let r = detect(candles, params);
    let tol = merge_pct.max(0.0) / 100.0;
    let crack_pct = params.crack_pct;
    let confirm_idx: Vec<usize> = r.bases.iter().map(|b| b.confirm_index).collect();
    // bases in the order they became known
    let mut order: Vec<usize> = (0..r.bases.len()).collect();
    order.sort_by_key(|&i| confirm_idx[i]);

    struct Z {
        low: f64,
        high: f64,
        time: u64,
        first_confirm: usize,
        bases: usize,
    }
    let mut zones: Vec<Z> = Vec::new();
    for i in order {
        let b = &r.bases[i];
        let joined = zones.iter_mut().find(|z| {
            let alive = first_crack(candles, z.first_confirm, z.low * (1.0 - crack_pct)).map_or(true, |t| candles.get(b.confirm_index).map_or(true, |c| t > c.open_time));
            let (lo, hi) = (z.low.min(b.price), z.high.max(b.price));
            alive && tol > 0.0 && hi <= lo * (1.0 + 2.0 * tol) && b.price >= z.low * (1.0 - tol) && b.price <= z.high * (1.0 + tol)
        });
        match joined {
            Some(z) => {
                z.low = z.low.min(b.price);
                z.high = z.high.max(b.price);
                z.time = z.time.min(b.time);
                z.first_confirm = z.first_confirm.min(b.confirm_index);
                z.bases += 1;
            }
            None => zones.push(Z { low: b.price, high: b.price, time: b.time, first_confirm: b.confirm_index, bases: 1 }),
        }
    }
    let mut out: Vec<BaseZone> = zones
        .into_iter()
        .map(|z| {
            let crack_level = z.low * (1.0 - crack_pct);
            let crack_time = first_crack(candles, z.first_confirm, crack_level);
            BaseZone {
                low: z.low,
                high: z.high,
                time: z.time,
                confirm_time: candles.get(z.first_confirm).map_or(z.time, |c| c.open_time),
                crack_time,
                crack_level,
                bases: z.bases,
                touches: count_touches(candles, z.first_confirm, z.high, crack_level, crack_time),
            }
        })
        .collect();
    out.sort_by_key(|z| z.time);
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
    fn a_zone_carries_its_crack_level_and_a_lone_base_has_equal_edges() {
        let c = series();
        let params = QflParams::default();
        let z = base_zones(&c, &params, 0.5, 10);
        assert!(!z.is_empty());
        let last = z.last().unwrap();
        assert!((last.crack_level - last.low * (1.0 - params.crack_pct)).abs() < 1e-12);
        assert!(last.crack_time.is_some(), "the series ends below the base, so it was cracked");
        assert!(last.confirm_time > last.time);
        assert_eq!(last.bases, 1);
        assert!((last.low - last.high).abs() < 1e-12);
        assert!(base_zones(&c, &params, 0.5, 1).len() <= 1);
    }

    #[test]
    fn every_zone_marks_a_crack_exactly_when_the_candles_traded_below_it() {
        let c = series();
        for z in base_zones(&c, &QflParams::default(), 0.5, 20) {
            let confirm = c.iter().position(|x| x.open_time == z.confirm_time).unwrap();
            let broke = c.iter().skip(confirm + 1).any(|x| x.low <= z.crack_level);
            assert_eq!(z.crack_time.is_some(), broke, "zone {}", z.low);
        }
    }

    #[test]
    fn touches_count_separate_retests_that_held_and_ignore_crack_candles() {
        // zone high 100, crack level 99.5: candle 1 dips to 99.8 and closes above (a touch), 2 stays inside (same episode, not counted
        // twice) -> here only one candle per episode, candle 4 is a second touch, candle 6 cracks (stops the count)
        let mk = |t: u64, low: f64, close: f64| Candle::new(t * 900_000, close, close.max(100.5), low, close, 1.0);
        let c = vec![mk(0, 101.0, 101.5), mk(1, 99.8, 100.4), mk(2, 99.9, 100.3), mk(3, 101.0, 101.2), mk(4, 99.7, 100.6), mk(5, 101.0, 101.0), mk(6, 99.0, 99.4), mk(7, 99.8, 100.5)];
        let crack = Some(6 * 900_000);
        assert_eq!(count_touches(&c, 0, 100.0, 99.5, crack), 2);
        // a candle that closes inside the zone is not a bounce
        let inside = vec![mk(0, 99.8, 99.9)];
        assert_eq!(count_touches(&inside, 0, 100.0, 99.5, None), 0);
    }

    /// A quiet stretch, then `reps` times: sell off 9.6, pump away 12.8, drift back to the start. Every sell-off ends at the same low.
    fn waves(reps: usize) -> Vec<Candle> {
        let mut out = Vec::new();
        let mut t = 0u64;
        let mut price = 100.0f64;
        let mut push = |o: &mut Vec<Candle>, open: f64, close: f64| {
            o.push(Candle::new(t, open, open.max(close) + 0.15, open.min(close) - 0.15, close, 1000.0));
            t += 900_000;
        };
        for i in 0..220 {
            let next = price + ((i as f64) * 0.7).sin() * 0.15;
            push(&mut out, price, next);
            price = next;
        }
        let start = price;
        for _ in 0..reps {
            for _ in 0..8 {
                push(&mut out, price, price - 1.2);
                price -= 1.2;
            }
            for _ in 0..8 {
                push(&mut out, price, price + 1.6);
                price += 1.6;
            }
            while price > start + 0.05 {
                push(&mut out, price, price - 0.1);
                price -= 0.1;
            }
            for _ in 0..30 {
                push(&mut out, price, price); // calm before the next
            }
        }
        out
    }

    #[test]
    fn bases_at_the_same_level_merge_into_one_zone_while_it_holds() {
        let c = waves(2);
        let params = QflParams::default();
        let off = base_zones(&c, &params, 0.0, 20);
        let on = base_zones(&c, &params, 0.5, 20);
        assert!(off.len() >= 2, "two sell-offs to the same low make two bases: {}", off.len());
        assert!(off.iter().all(|z| z.bases == 1));
        assert!(on.len() < off.len(), "merging must combine them: {} vs {}", on.len(), off.len());
        let merged = on.iter().max_by_key(|z| z.bases).unwrap();
        assert!(merged.bases >= 2);
        assert!(merged.high >= merged.low);
        // the zone starts where the oldest base formed
        assert_eq!(merged.time, off.iter().map(|z| z.time).min().unwrap());
        assert_eq!(on.iter().map(|z| z.bases).sum::<usize>(), off.len());
    }

    #[test]
    fn a_zone_that_price_cracked_is_not_extended_by_a_later_base() {
        // two sell-offs to the same low (about 90.7), with a candle that trades far below the level right after the first one
        let mut c = waves(2);
        let params = QflParams::default();
        let waves_only = |z: &Vec<BaseZone>| z.iter().filter(|x| x.low < 95.0).cloned().collect::<Vec<_>>();
        let off = waves_only(&base_zones(&c, &params, 0.0, 30));
        assert!(off.len() >= 2, "{off:?}");
        let (w1, w2) = (off[0], off[1]);
        assert!(w2.time > w1.confirm_time);
        let idx = c.iter().position(|x| x.open_time == w1.confirm_time).unwrap() + 2;
        c[idx] = Candle::new(c[idx].open_time, c[idx].open, c[idx].high, w1.low - 3.0, c[idx].close, 1000.0);
        let merged = waves_only(&base_zones(&c, &params, 5.0, 30));
        // the level was broken before the second base formed: the first zone stays a lone, cracked base even with a 5% tolerance
        // (the crash candle itself became a new base further down, and that new zone may take the later base - that is fine)
        let first = merged.iter().find(|z| z.time == w1.time).expect("the first zone");
        assert_eq!(first.bases, 1, "{merged:?}");
        assert!(first.crack_time.is_some(), "{merged:?}");
        // and with no crack in between they do merge (the scenario above without the crash)
        let clean = waves_only(&base_zones(&waves(2), &params, 5.0, 30));
        assert!(clean.iter().any(|z| z.bases >= 2), "{clean:?}");
    }

    #[test]
    fn empty_input_is_fine() {
        let r = detect(&[], &QflParams::default());
        assert!(r.bases.is_empty() && r.current_base.is_none());
    }
}
