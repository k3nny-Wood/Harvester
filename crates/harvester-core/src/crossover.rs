//! Moving-average crossover strategy, expressed as ladder-style "paths" so the Lab's shared-account simulator, luck test,
//! start-date test and stressed-cost test judge it exactly as they judge the QFL ladder.
//!
//! Signals are computed on bars of `tf_mult` x 15 m (1 = 15 m, 4 = 1 h, 16 = 4 h) from CLOSED bars only; a cross seen at the close of
//! bar i is traded at the OPEN of bar i+1 (plus slippage). The position is held until the opposite cross (or a stop / liquidation,
//! checked on every 15 m candle, so the order inside a bar never helps). Fees and slippage are charged on both sides, funding while
//! the position is open.

use crate::candle::Candle;
use crate::lab::{LadderPath, STEP_MS};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CrossSide {
    Long,
    Short,
    /// always in the market: the opposite cross reverses the position
    Both,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CrossParams {
    /// signal bar = this many 15 m candles
    pub tf_mult: usize,
    pub fast: usize,
    pub slow: usize,
    /// EMA when true, SMA when false
    pub ema: bool,
    pub side: CrossSide,
    pub leverage: f64,
    /// stop distance from the entry in percent (0 = none)
    pub stop_pct: f64,
    pub fee_pct: f64,
    pub slippage_pct: f64,
    pub funding_pct_8h: f64,
    pub mmr_pct: f64,
    /// long entries only while the pool-wide trailing return is at least this (percent); None = no gate
    pub gate_min_pct: Option<f64>,
}

impl Default for CrossParams {
    fn default() -> Self {
        CrossParams {
            tf_mult: 4,
            fast: 9,
            slow: 21,
            ema: true,
            side: CrossSide::Long,
            leverage: 3.0,
            stop_pct: 0.0,
            fee_pct: 0.05,
            slippage_pct: 0.02,
            funding_pct_8h: 0.01,
            mmr_pct: 0.5,
            gate_min_pct: None,
        }
    }
}

impl CrossParams {
    pub fn stressed(&self) -> CrossParams {
        CrossParams { fee_pct: 0.06, slippage_pct: 0.25, funding_pct_8h: 0.02, ..self.clone() }
    }
}

/// Exponential or simple moving average; `None` until `period` closes exist.
pub fn average(values: &[f64], period: usize, ema: bool) -> Vec<Option<f64>> {
    let mut out = vec![None; values.len()];
    if period == 0 || values.len() < period {
        return out;
    }
    let seed: f64 = values[..period].iter().sum::<f64>() / period as f64;
    out[period - 1] = Some(seed);
    if ema {
        let k = 2.0 / (period as f64 + 1.0);
        let mut prev = seed;
        for i in period..values.len() {
            prev = values[i] * k + prev * (1.0 - k);
            out[i] = Some(prev);
        }
    } else {
        let mut sum = seed * period as f64;
        for i in period..values.len() {
            sum += values[i] - values[i - period];
            out[i] = Some(sum / period as f64);
        }
    }
    out
}

/// A signal bar: its close and the 15 m index range it covers.
struct Bar {
    close: f64,
    first: usize,
    last: usize,
}

fn bars(candles: &[Candle], mult: usize) -> Vec<Bar> {
    if mult <= 1 {
        return candles.iter().enumerate().map(|(i, c)| Bar { close: c.close, first: i, last: i }).collect();
    }
    let span = STEP_MS * mult as u64;
    let mut out: Vec<Bar> = Vec::new();
    let mut i = 0;
    while i < candles.len() {
        let slot = candles[i].open_time / span;
        let mut j = i;
        while j + 1 < candles.len() && candles[j + 1].open_time / span == slot {
            j += 1;
        }
        if j - i + 1 == mult && candles[i].open_time % span == 0 {
            out.push(Bar { close: candles[j].close, first: i, last: j });
        }
        i = j + 1;
    }
    out
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Dir {
    Long,
    Short,
}

/// Every trade the crossover would have taken on one symbol, as paths from `from_ms` on.
pub fn crossover_paths(symbol: &str, candles: &[Candle], p: &CrossParams, gate: Option<&BTreeMap<u64, f64>>, from_ms: u64) -> Vec<LadderPath> {
    let bs = bars(candles, p.tf_mult.max(1));
    if bs.len() < p.slow + 3 {
        return vec![];
    }
    let closes: Vec<f64> = bs.iter().map(|b| b.close).collect();
    let fast = average(&closes, p.fast, p.ema);
    let slow = average(&closes, p.slow, p.ema);
    let (lev, mmr) = (p.leverage.clamp(1.0, 50.0), p.mmr_pct / 100.0);
    let cost = (p.fee_pct + p.slippage_pct) / 100.0;
    let funding = p.funding_pct_8h / 100.0 * (STEP_MS as f64 / 3_600_000.0) / 8.0;
    let mut out: Vec<LadderPath> = Vec::new();
    let mut open: Option<(Dir, usize, f64)> = None; // direction, 15 m index of the entry, entry price

    // closes a trade at 15 m index `exit_idx` for `reason` at `exit_price`
    let finish = |out: &mut Vec<LadderPath>, dir: Dir, entry_idx: usize, entry: f64, exit_idx: usize, exit_price: f64, reason: &'static str| {
        let sign = if dir == Dir::Long { 1.0 } else { -1.0 };
        let mut pnl: Vec<f32> = Vec::new();
        let mut paid_funding = 0.0;
        for i in entry_idx..=exit_idx {
            paid_funding += lev * funding;
            let mark = if i == exit_idx { exit_price } else { candles[i].close };
            let v = lev * sign * (mark / entry - 1.0) - lev * cost - paid_funding - if i == exit_idx { lev * cost } else { 0.0 };
            pnl.push(if reason == "liq" && i == exit_idx { (-1.0 - lev * cost - paid_funding) as f32 } else { v.max(-1.0) as f32 });
        }
        out.push(LadderPath { symbol: symbol.to_string(), trigger_ms: candles[entry_idx].open_time, end_ms: candles[exit_idx].open_time, reason, pnl });
    };

    for b in 1..bs.len() - 1 {
        // a stop / liquidation inside the bars since the last decision (15 m candles of the bar that just closed)
        if let Some((dir, ei, entry)) = open {
            let sign = if dir == Dir::Long { 1.0 } else { -1.0 };
            let liq_move = 1.0 / lev - mmr;
            let mut hit: Option<(usize, f64, &'static str)> = None;
            for i in ei.max(bs[b - 1].first)..=bs[b].last {
                if i < ei {
                    continue;
                }
                let adverse = if dir == Dir::Long { 1.0 - candles[i].low / entry } else { candles[i].high / entry - 1.0 };
                let stop_level = p.stop_pct / 100.0;
                if p.stop_pct > 0.0 && adverse >= stop_level && stop_level < liq_move {
                    hit = Some((i, entry * (1.0 - sign * stop_level), "stop"));
                    break;
                }
                if adverse >= liq_move {
                    hit = Some((i, entry * (1.0 - sign * liq_move), "liq"));
                    break;
                }
            }
            if let Some((i, price, why)) = hit {
                finish(&mut out, dir, ei, entry, i, price, why);
                open = None;
            }
        }
        // the cross on the bar that just closed
        let (Some(f1), Some(s1), Some(f0), Some(s0)) = (fast[b], slow[b], fast[b - 1], slow[b - 1]) else { continue };
        let up = f0 <= s0 && f1 > s1;
        let down = f0 >= s0 && f1 < s1;
        if !up && !down {
            continue;
        }
        let entry_idx = bs[b + 1].first;
        let next_open = candles[entry_idx].open;
        if candles[entry_idx].open_time < from_ms {
            continue; // still warming up: nothing is traded before the window starts
        }
        // exit / reverse
        if let Some((dir, ei, entry)) = open {
            let against = (dir == Dir::Long && down) || (dir == Dir::Short && up);
            if against {
                let slip = p.slippage_pct / 100.0;
                let px = if dir == Dir::Long { next_open * (1.0 - slip) } else { next_open * (1.0 + slip) };
                finish(&mut out, dir, ei, entry, entry_idx, px, "tp");
                open = None;
            }
        }
        if open.is_none() {
            let want = match (p.side, up, down) {
                (CrossSide::Long, true, _) | (CrossSide::Both, true, _) => Some(Dir::Long),
                (CrossSide::Short, _, true) | (CrossSide::Both, _, true) => Some(Dir::Short),
                _ => None,
            };
            if let Some(dir) = want {
                let gate_ok = match (dir, p.gate_min_pct, gate) {
                    (Dir::Long, Some(min), Some(g)) => g.get(&candles[bs[b].last].open_time).map_or(false, |v| *v >= min),
                    _ => true,
                };
                if gate_ok {
                    open = Some((dir, entry_idx, next_open));
                }
            }
        }
    }
    // a trade still open at the end of the data
    if let Some((dir, ei, entry)) = open {
        let last = candles.len() - 1;
        if last > ei {
            finish(&mut out, dir, ei, entry, last, candles[last].close, "open");
        }
    }
    out.retain(|t| t.trigger_ms >= from_ms);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(i: u64, price: f64) -> Candle {
        Candle::new(i * STEP_MS, price, price * 1.001, price * 0.999, price, 1000.0)
    }

    fn free(p: CrossParams) -> CrossParams {
        CrossParams { fee_pct: 0.0, slippage_pct: 0.0, funding_pct_8h: 0.0, tf_mult: 1, fast: 3, slow: 8, ..p }
    }

    /// flat, then a rise (golden cross), then a fall (death cross)
    fn wave() -> Vec<Candle> {
        let mut v = Vec::new();
        for i in 0..40 {
            v.push(c(i, 100.0));
        }
        for i in 40..70 {
            v.push(c(i, 100.0 + (i - 40) as f64));
        }
        for i in 70..110 {
            v.push(c(i, 130.0 - (i - 70) as f64 * 1.5));
        }
        v
    }

    #[test]
    fn averages_start_after_the_period_and_follow_a_constant() {
        let v = vec![5.0; 30];
        let e = average(&v, 10, true);
        assert!(e[8].is_none() && (e[9].unwrap() - 5.0).abs() < 1e-12 && (e[29].unwrap() - 5.0).abs() < 1e-12);
        let s = average(&(1..=10).map(|x| x as f64).collect::<Vec<_>>(), 4, false);
        assert!((s[3].unwrap() - 2.5).abs() < 1e-12 && (s[9].unwrap() - 8.5).abs() < 1e-12);
    }

    #[test]
    fn a_long_enters_after_the_golden_cross_and_exits_on_the_death_cross() {
        let paths = crossover_paths("X", &wave(), &free(CrossParams::default()), None, 0);
        assert_eq!(paths.len(), 1, "{paths:?}");
        let t = &paths[0];
        assert_eq!(t.reason, "tp");
        assert!(t.trigger_ms >= 40 * STEP_MS, "entered only after the rise began");
        // entered during the rise (above 100), exited after the fall began from 130: a gain
        assert!(*t.pnl.last().unwrap() > 0.0, "{}", t.pnl.last().unwrap());
    }

    #[test]
    fn the_both_side_also_shorts_the_fall() {
        let both = crossover_paths("X", &wave(), &free(CrossParams { side: CrossSide::Both, ..CrossParams::default() }), None, 0);
        assert!(both.len() >= 2);
        assert!(both.iter().any(|t| *t.pnl.last().unwrap() > 0.0));
    }

    #[test]
    fn costs_reduce_the_result() {
        let free_p = free(CrossParams::default());
        let paid = CrossParams { fee_pct: 0.1, slippage_pct: 0.1, ..free_p.clone() };
        let a = crossover_paths("X", &wave(), &free_p, None, 0)[0].pnl.last().copied().unwrap();
        let b = crossover_paths("X", &wave(), &paid, None, 0)[0].pnl.last().copied().unwrap();
        assert!(a - b > 0.003, "{a} vs {b}");
    }

    #[test]
    fn a_crash_liquidates_a_leveraged_long() {
        let mut v = wave();
        // after the entry the price collapses 60%
        for i in 55..110 {
            v[i] = c(i as u64, 60.0);
        }
        let p = free(CrossParams { leverage: 3.0, ..CrossParams::default() });
        let paths = crossover_paths("X", &v, &p, None, 0);
        assert!(paths.iter().any(|t| t.reason == "liq" && (*t.pnl.last().unwrap() + 1.0).abs() < 1e-6), "{:?}", paths.iter().map(|t| t.reason).collect::<Vec<_>>());
    }

    #[test]
    fn a_stop_limits_the_loss_before_a_liquidation() {
        let mut v = wave();
        for i in 55..110 {
            v[i] = c(i as u64, 60.0);
        }
        let p = free(CrossParams { leverage: 2.0, stop_pct: 10.0, ..CrossParams::default() });
        let paths = crossover_paths("X", &v, &p, None, 0);
        let t = paths.iter().find(|t| t.reason == "stop").expect("stopped");
        // 2x with a 10% stop: about -20% of the budget
        assert!((*t.pnl.last().unwrap() + 0.2).abs() < 0.03, "{}", t.pnl.last().unwrap());
    }

    #[test]
    fn signals_use_closed_bars_of_the_chosen_size() {
        let b = bars(&wave(), 4);
        assert!(b.iter().all(|x| x.last - x.first == 3));
        assert_eq!(b[0].first % 4, 0);
    }

    #[test]
    fn the_gate_blocks_long_entries_when_the_market_is_falling() {
        let mut gate = BTreeMap::new();
        for i in 0..110u64 {
            gate.insert(i * STEP_MS, -5.0);
        }
        let p = free(CrossParams { gate_min_pct: Some(0.0), ..CrossParams::default() });
        assert!(crossover_paths("X", &wave(), &p, Some(&gate), 0).is_empty());
    }
}
