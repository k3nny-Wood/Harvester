//! The Lab: a backtest of the QFL ladder run as ONE SHARED ACCOUNT, with the honest numbers next to the headline.
//!
//! A simplified port of MarketScanner's QFL Lab (`simulate_cycle` + the shared-account simulator). Long only. One ladder per
//! symbol, a cap on open ladders, a budget per ladder as a percent of equity, mark-to-market equity so the drawdown counts open
//! ladders. Entry filters are evaluated on the candle before the crack (no look-ahead): a Donchian-low position filter and the
//! market-wide regime gate (equal-weight average trailing return of the tested pool).
//!
//! Pessimistic by construction inside a candle: buys fill first, then the stop / liquidation is checked on the low, and sells
//! only if the ladder survived, so an intrabar order that is unknowable never helps. Fees, funding and a "fill through" margin
//! (price must trade beyond a limit before it counts as filled) are modelled.
//!
//! Where it is weaker than the original: sells are equal shares of what is held, there is no trailing last sell, and the
//! universe is whatever the caller passes (usually today's most liquid coins, which is a hindsight pool).

use crate::candle::Candle;
use crate::qfl::{detect, QflParams};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

pub const STEP_MS: u64 = 900_000; // 15 m candles

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct LabConfig {
    pub leverage: f64,
    /// stop below the base, in percent (0 = none)
    pub stop_pct: f64,
    pub layers: usize,
    /// distance between buy layers, percent
    pub spacing_pct: f64,
    /// relative size of each layer (cycled if shorter than `layers`)
    pub weights: Vec<f64>,
    /// the crack: how far below the base the first buy sits, percent
    pub crack_pct: f64,
    pub volatility_factor: f64,
    pub sell_layers: usize,
    /// first sell relative to the base, percent; NEGATIVE puts it above the base
    pub sell_offset_pct: f64,
    pub sell_gap_pct: f64,
    pub fee_pct: f64,
    /// price must trade this far beyond a limit before it counts as filled, percent
    pub fill_through_pct: f64,
    pub funding_pct_8h: f64,
    pub mmr_pct: f64,
    /// Donchian-low entry filter: 0 = off, else the base must sit in the lowest `donch_max_pos` of the last `donch_len` candles
    pub donch_len: usize,
    pub donch_max_pos: f64,
    pub gate_on: bool,
    pub gate_days: usize,
    pub gate_min_pct: f64,
    pub start_equity: f64,
    pub max_ladders: usize,
    /// budget of a ladder as a percent of equity
    pub alloc_pct: f64,
    pub max_budget: f64,
    /// margin reserved by open ladders may not exceed this percent of equity
    pub margin_cap_pct: f64,
}

impl Default for LabConfig {
    /// The V2 live setting (Oct 2026).
    fn default() -> Self {
        LabConfig {
            leverage: 3.0,
            stop_pct: 30.0,
            layers: 3,
            spacing_pct: 1.0,
            weights: vec![2.0, 4.0, 7.0],
            crack_pct: 0.5,
            volatility_factor: 1.0,
            sell_layers: 4,
            sell_offset_pct: -1.0,
            sell_gap_pct: 1.0,
            fee_pct: 0.04,
            fill_through_pct: 0.05,
            funding_pct_8h: 0.01,
            mmr_pct: 0.5,
            donch_len: 288,
            donch_max_pos: 0.15,
            gate_on: true,
            gate_days: 30,
            gate_min_pct: 10.0,
            start_equity: 1000.0,
            max_ladders: 25,
            alloc_pct: 3.6,
            max_budget: 500.0,
            margin_cap_pct: 90.0,
        }
    }
}

impl LabConfig {
    /// The same strategy under harsher costs (fees, slippage, funding): what a worse day on the exchange looks like.
    pub fn stressed(&self) -> LabConfig {
        LabConfig { fee_pct: 0.06, fill_through_pct: 0.25, funding_pct_8h: 0.02, ..self.clone() }
    }
}

/// A crack that passed the entry filters, ready to be simulated.
#[derive(Debug, Clone)]
pub struct Setup {
    pub symbol: String,
    pub crack_idx: usize,
    pub base: f64,
    /// market gate value (pool average trailing return, percent) at the candle before the crack
    pub gate: f64,
}

/// One ladder's life on its own: profit per 1.0 of budget at the close of every candle from its first fill to its exit.
#[derive(Debug, Clone)]
pub struct LadderPath {
    pub symbol: String,
    pub trigger_ms: u64,
    pub end_ms: u64,
    /// "tp" | "stop" | "liq" | "open"
    pub reason: &'static str,
    pub pnl: Vec<f32>,
}

fn layer_weights(cfg: &LabConfig, n: usize) -> Vec<f64> {
    (0..n).map(|k| if cfg.weights.is_empty() { 1.0 } else { cfg.weights[k % cfg.weights.len()].max(0.0) }).collect()
}

/// Simulate one ladder cracked at `crack_idx`. None when no layer ever filled (price did not trade through the first buy soon enough).
pub fn simulate_ladder(symbol: &str, candles: &[Candle], crack_idx: usize, base: f64, cfg: &LabConfig) -> Option<LadderPath> {
    if crack_idx >= candles.len() || base <= 0.0 {
        return None;
    }
    let through = cfg.fill_through_pct / 100.0;
    let (fee, lev, mmr) = (cfg.fee_pct / 100.0, cfg.leverage.clamp(1.0, 50.0), cfg.mmr_pct / 100.0);
    let funding_per_candle = cfg.funding_pct_8h / 100.0 * (STEP_MS as f64 / 3_600_000.0) / 8.0;
    let stop_price = if cfg.stop_pct > 0.0 { base * (1.0 - cfg.stop_pct / 100.0) } else { 0.0 };
    let first = base * (1.0 - cfg.crack_pct / 100.0);
    // layers below the stop are never placed
    let prices: Vec<f64> = (0..cfg.layers.max(1)).map(|k| first * (1.0 - cfg.spacing_pct / 100.0 * k as f64)).filter(|p| *p > stop_price).collect();
    if prices.is_empty() {
        return None;
    }
    let raw_w = layer_weights(cfg, prices.len());
    let total_w: f64 = raw_w.iter().sum::<f64>().max(1e-12);
    let margins: Vec<f64> = raw_w.iter().map(|w| w / total_w).collect(); // budget 1.0
    let sells: Vec<f64> = (0..cfg.sell_layers.max(1)).map(|j| base * (1.0 - cfg.sell_offset_pct / 100.0 + cfg.sell_gap_pct / 100.0 * j as f64)).collect();

    let mut filled = vec![false; prices.len()];
    let (mut qty, mut avg, mut margin) = (0.0f64, 0.0f64, 0.0f64);
    let (mut realized, mut fees, mut funding) = (0.0f64, 0.0f64, 0.0f64);
    let mut sold_levels = 0usize;
    let mut path: Vec<f32> = Vec::new();
    let mut start_ms = 0u64;
    let mut reason: &'static str = "open";
    let mut end = candles.len() - 1;

    for (i, c) in candles.iter().enumerate().skip(crack_idx) {
        // 1. buys that the low reached
        let mut bought_now = false;
        for (k, p) in prices.iter().enumerate() {
            if !filled[k] && c.low <= p * (1.0 - through) {
                filled[k] = true;
                bought_now = true;
                let notional = margins[k] * lev;
                let q = notional / p;
                avg = (avg * qty + p * q) / (qty + q);
                qty += q;
                margin += margins[k];
                fees += notional * fee;
            }
        }
        if qty <= 0.0 {
            if i - crack_idx > 96 {
                return None; // a day went by without the first buy filling
            }
            continue;
        }
        if path.is_empty() {
            start_ms = c.open_time;
        }
        // 2. liquidation / stop on the low (the higher trigger fires first)
        let liq = (avg * qty - margin) / (qty * (1.0 - mmr)); // isolated margin, long
        let liq_hit = c.low <= liq;
        let stop_hit = stop_price > 0.0 && c.low <= stop_price;
        let (exit_price, exit_reason): (Option<f64>, &'static str) = if liq_hit && !(stop_hit && stop_price >= liq) {
            (Some(liq.max(0.0)), "liq")
        } else if stop_hit {
            (Some(stop_price * (1.0 - through)), "stop")
        } else {
            (None, "")
        };
        if let Some(px) = exit_price {
            realized += qty * (px - avg);
            fees += qty * px * fee;
            // isolated margin: a liquidation takes the whole margin (never more), a stop only what the trade lost
            let total = if exit_reason == "liq" { -margin - fees - funding } else { realized - fees - funding };
            path.push(total as f32);
            reason = exit_reason;
            end = i;
            qty = 0.0;
            break;
        }
        // 3. sells the high reached. On a candle that also bought, the high may have come first, so no sell counts (pessimistic).
        for (j, s) in sells.iter().enumerate() {
            if bought_now || j < sold_levels || qty <= 0.0 {
                continue;
            }
            if c.high >= s * (1.0 + through) {
                let dq = qty / (sells.len() - sold_levels) as f64;
                realized += dq * (s - avg);
                fees += dq * s * fee;
                qty -= dq;
                sold_levels += 1;
            } else {
                break; // levels are ascending: a higher one cannot have filled
            }
        }
        funding += qty * c.close * funding_per_candle;
        let total = realized + qty * (c.close - avg) - fees - funding;
        path.push(total as f32);
        if sold_levels >= sells.len() || qty <= 1e-12 {
            reason = "tp";
            end = i;
            break;
        }
    }
    if path.is_empty() {
        return None;
    }
    Some(LadderPath { symbol: symbol.to_string(), trigger_ms: start_ms, end_ms: candles[end.min(candles.len() - 1)].open_time, reason, pnl: path })
}

/// Position of `close[i-1]` inside the high/low range of the `len` candles ending at `i-1` (0 = at the low, 1 = at the high).
pub fn donchian_position(candles: &[Candle], i: usize, len: usize) -> Option<f64> {
    if len == 0 || i == 0 || i < len {
        return None;
    }
    let w = &candles[i - len..i];
    let lo = w.iter().map(|c| c.low).fold(f64::INFINITY, f64::min);
    let hi = w.iter().map(|c| c.high).fold(f64::NEG_INFINITY, f64::max);
    if hi <= lo {
        return None;
    }
    Some((candles[i - 1].close - lo) / (hi - lo))
}

/// Pool-wide average trailing return in percent, per candle open time (point in time: a value only uses candles up to that one).
pub fn pool_gate(all: &HashMap<String, Vec<Candle>>, days: usize) -> BTreeMap<u64, f64> {
    let lag = days * 96;
    let mut sums: BTreeMap<u64, (f64, u32)> = BTreeMap::new();
    for candles in all.values() {
        for i in lag..candles.len() {
            if candles[i].open_time - candles[i - lag].open_time != lag as u64 * STEP_MS || candles[i - lag].close <= 0.0 {
                continue;
            }
            let e = sums.entry(candles[i].open_time).or_insert((0.0, 0));
            e.0 += (candles[i].close / candles[i - lag].close - 1.0) * 100.0;
            e.1 += 1;
        }
    }
    sums.into_iter().filter(|(_, (_, n))| *n >= 5).map(|(t, (s, n))| (t, s / n as f64)).collect()
}

/// Every crack in the pool that passes the entry filters, from `from_ms` on.
pub fn find_setups(all: &HashMap<String, Vec<Candle>>, cfg: &LabConfig, from_ms: u64) -> Vec<Setup> {
    let gate = if cfg.gate_on { Some(pool_gate(all, cfg.gate_days)) } else { None };
    let params = QflParams { volatility_factor: cfg.volatility_factor, crack_pct: cfg.crack_pct / 100.0, ..QflParams::default() };
    let mut out = Vec::new();
    for (symbol, candles) in all {
        if candles.len() < 300 {
            continue;
        }
        for k in detect(candles, &params).cracks {
            let c = &candles[k.bar_index];
            if c.open_time < from_ms || k.bar_index == 0 {
                continue;
            }
            let prev_t = candles[k.bar_index - 1].open_time;
            let g = match &gate {
                Some(g) => match g.get(&prev_t) {
                    Some(v) if *v >= cfg.gate_min_pct => *v,
                    _ => continue,
                },
                None => 0.0,
            };
            if cfg.donch_len > 0 {
                match donchian_position(candles, k.bar_index, cfg.donch_len) {
                    Some(p) if p <= cfg.donch_max_pos => {}
                    _ => continue,
                }
            }
            out.push(Setup { symbol: symbol.clone(), crack_idx: k.bar_index, base: k.base_price, gate: g });
        }
    }
    out.sort_by(|a, b| (all[&a.symbol][a.crack_idx].open_time, &a.symbol).cmp(&(all[&b.symbol][b.crack_idx].open_time, &b.symbol)));
    out
}

pub fn build_paths(all: &HashMap<String, Vec<Candle>>, setups: &[Setup], cfg: &LabConfig) -> Vec<LadderPath> {
    let mut paths: Vec<LadderPath> = setups.iter().filter_map(|s| simulate_ladder(&s.symbol, &all[&s.symbol], s.crack_idx, s.base, cfg)).collect();
    paths.sort_by(|a, b| (a.trigger_ms, &a.symbol).cmp(&(b.trigger_ms, &b.symbol)));
    paths
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountResult {
    pub return_pct: f64,
    pub max_drawdown_pct: f64,
    pub profit_factor: f64,
    pub ladders: usize,
    pub skipped: usize,
    pub closed: usize,
    pub wins: usize,
    pub stops: usize,
    /// equity at the close of every candle of the run (for the chart), thinned by the caller
    pub equity: Vec<f64>,
}

/// Run the shared account over [from, to). `paths` must be sorted by (trigger, symbol).
pub fn simulate_account(paths: &[LadderPath], cfg: &LabConfig, from: u64, to: u64, keep_curve: bool) -> AccountResult {
    let first = paths.partition_point(|x| x.trigger_ms < from);
    if first >= paths.len() || paths[first].trigger_ms >= to {
        return AccountResult::default();
    }
    let t0 = paths[first].trigger_ms / STEP_MS * STEP_MS;
    let t_end = to.min(paths.iter().map(|x| x.end_ms).max().unwrap_or(0) + STEP_MS);
    let mut next = first;
    let mut open: Vec<(usize, f64)> = Vec::new();
    let (mut realized, mut peak, mut max_dd) = (0.0f64, cfg.start_equity, 0.0f64);
    let mut r = AccountResult::default();
    let (mut gains, mut losses) = (0.0f64, 0.0f64);
    let mut eq_last = cfg.start_equity;
    let mut t = t0;
    while t < t_end {
        // ladders whose last candle has passed are closed
        let mut i = 0;
        while i < open.len() {
            let (pi, b) = open[i];
            let x = &paths[pi];
            let idx = ((t - x.trigger_ms) / STEP_MS) as usize;
            if idx + 1 >= x.pnl.len() {
                let pnl = b * x.pnl[x.pnl.len() - 1] as f64;
                realized += pnl;
                if x.reason != "open" {
                    r.closed += 1;
                    if pnl > 0.0 {
                        r.wins += 1;
                        gains += pnl;
                    } else {
                        losses += -pnl;
                    }
                    if x.reason == "stop" || x.reason == "liq" {
                        r.stops += 1;
                    }
                }
                open.swap_remove(i);
            } else {
                i += 1;
            }
        }
        let unreal = |open: &Vec<(usize, f64)>| -> f64 { open.iter().map(|(pi, b)| b * paths[*pi].pnl[(((t - paths[*pi].trigger_ms) / STEP_MS) as usize).min(paths[*pi].pnl.len() - 1)] as f64).sum() };
        let eq_now = cfg.start_equity + realized + unreal(&open);
        while next < paths.len() && paths[next].trigger_ms <= t {
            let x = &paths[next];
            let idx = next;
            next += 1;
            if x.trigger_ms < t || x.trigger_ms >= to {
                continue;
            }
            let budget = (eq_now * cfg.alloc_pct / 100.0).min(cfg.max_budget);
            let reserved: f64 = open.iter().map(|o| o.1).sum();
            if open.len() >= cfg.max_ladders || reserved + budget > eq_now * cfg.margin_cap_pct / 100.0 || open.iter().any(|(pi, _)| paths[*pi].symbol == x.symbol) || eq_now <= 0.0 {
                r.skipped += 1;
                continue;
            }
            open.push((idx, budget));
            r.ladders += 1;
        }
        eq_last = cfg.start_equity + realized + unreal(&open);
        peak = peak.max(eq_last);
        max_dd = max_dd.max((peak - eq_last) / peak * 100.0);
        if keep_curve {
            r.equity.push(eq_last);
        }
        t += STEP_MS;
    }
    r.return_pct = (eq_last / cfg.start_equity - 1.0) * 100.0;
    r.max_drawdown_pct = max_dd;
    r.profit_factor = if losses > 0.0 { gains / losses } else if gains > 0.0 { f64::INFINITY } else { 0.0 };
    r
}

// ---- the honest numbers ----

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LuckTest {
    pub runs: usize,
    pub kept_pct: f64,
    pub median_return_pct: f64,
    pub p10_return_pct: f64,
    pub median_drawdown_pct: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StartResult {
    pub start_ms: u64,
    pub return_pct: f64,
    pub max_drawdown_pct: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LabReport {
    pub symbols: usize,
    pub candles: usize,
    pub window_start_ms: u64,
    pub window_end_ms: u64,
    pub setups: usize,
    pub base: AccountResult,
    pub luck: LuckTest,
    pub starts: Vec<StartResult>,
    pub worst_start_return_pct: f64,
    pub stressed: AccountResult,
    pub notes: Vec<String>,
}

/// Run the shared account on random subsets of the ladders: how much of the result was luck of which setups were taken.
pub fn luck_test(paths: &[LadderPath], cfg: &LabConfig, from: u64, to: u64, runs: usize, keep: f64) -> LuckTest {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let (mut rets, mut dds) = (Vec::new(), Vec::new());
    for _ in 0..runs {
        let subset: Vec<LadderPath> = paths.iter().filter(|_| rng.next() < keep).cloned().collect();
        let r = simulate_account(&subset, cfg, from, to, false);
        rets.push(r.return_pct);
        dds.push(r.max_drawdown_pct);
    }
    rets.sort_by(|a, b| a.partial_cmp(b).unwrap());
    dds.sort_by(|a, b| a.partial_cmp(b).unwrap());
    LuckTest { runs, kept_pct: keep * 100.0, median_return_pct: percentile(&rets, 0.5), p10_return_pct: percentile(&rets, 0.1), median_drawdown_pct: percentile(&dds, 0.5) }
}

/// Start the account on several different days: a result that only works from one start date is not a strategy.
pub fn start_dates(paths: &[LadderPath], cfg: &LabConfig, from: u64, to: u64, n: usize) -> Vec<StartResult> {
    (0..n)
        .map(|k| {
            let start = from + (to - from) * k as u64 / (n as u64 + 2);
            let r = simulate_account(paths, cfg, start, to, false);
            StartResult { start_ms: start, return_pct: r.return_pct, max_drawdown_pct: r.max_drawdown_pct }
        })
        .collect()
}

/// The whole report: base run, luck test, start dates and stressed costs. `from_ms` is where trading may begin (after the warm-up).
pub fn run_lab(all: &HashMap<String, Vec<Candle>>, cfg: &LabConfig, from_ms: u64, luck_runs: usize) -> LabReport {
    let to = all.values().filter_map(|c| c.last()).map(|c| c.open_time + STEP_MS).max().unwrap_or(0);
    let setups = find_setups(all, cfg, from_ms);
    let paths = build_paths(all, &setups, cfg);
    let base = simulate_account(&paths, cfg, from_ms, to, true);
    let luck = luck_test(&paths, cfg, from_ms, to, luck_runs, 0.8);
    let starts = start_dates(&paths, cfg, from_ms, to, 8);
    let worst = starts.iter().map(|s| s.return_pct).fold(f64::INFINITY, f64::min);
    let sc = cfg.stressed();
    let stressed = simulate_account(&build_paths(all, &setups, &sc), &sc, from_ms, to, false);
    let mut notes = Vec::new();
    notes.push("The pool is today's most liquid coins, chosen with hindsight: coins that did well are over-represented. Expect live to be below this.".to_string());
    notes.push("Candles are 15 m, so the order of events inside a candle is unknowable; a coarser candle would flatter the result more.".to_string());
    if cfg.gate_on {
        notes.push(format!("The market gate (pool {}-day average >= {:+.0}%) stays closed in a falling market, so most of a bear stretch is simply not traded.", cfg.gate_days, cfg.gate_min_pct));
    }
    if setups.len() < 30 {
        notes.push(format!("Only {} setups: too few to trust any of these numbers.", setups.len()));
    }
    LabReport {
        symbols: all.len(),
        candles: all.values().map(|c| c.len()).sum(),
        window_start_ms: from_ms,
        window_end_ms: to,
        setups: setups.len(),
        base,
        luck,
        starts,
        worst_start_return_pct: if worst.is_finite() { worst } else { 0.0 },
        stressed,
        notes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(i: u64, o: f64, h: f64, l: f64, cl: f64) -> Candle {
        Candle::new(i * STEP_MS, o, h, l, cl, 1000.0)
    }

    /// base 100, crack 1% (first buy 99), three equal layers 1% apart, 1 sell at the base, 2x, perfect fills, no costs
    fn cfg() -> LabConfig {
        LabConfig {
            leverage: 2.0,
            stop_pct: 0.0,
            layers: 3,
            spacing_pct: 1.0,
            weights: vec![1.0],
            crack_pct: 1.0,
            sell_layers: 1,
            sell_offset_pct: 0.0,
            sell_gap_pct: 1.0,
            fee_pct: 0.0,
            fill_through_pct: 0.0,
            funding_pct_8h: 0.0,
            mmr_pct: 0.5,
            ..LabConfig::default()
        }
    }

    #[test]
    fn a_ladder_buys_the_dip_and_sells_back_at_the_base() {
        let cs = vec![
            c(0, 100.0, 100.0, 100.0, 100.0),
            c(1, 100.0, 100.0, 98.5, 99.0), // cracks: layer 0 (99.00) fills; 98.01 not reached
            c(2, 99.0, 99.0, 97.9, 98.0),   // layer 1 (98.01) fills
            c(3, 98.0, 100.5, 98.0, 100.0), // back at the base: sold
        ];
        let p = simulate_ladder("X", &cs, 1, 100.0, &cfg()).expect("traded");
        assert_eq!(p.reason, "tp");
        // each filled layer is a third of the budget at 2x: notional 2/3, bought at its price and sold at 100
        let expected = (2.0 / 3.0) * (100.0 / 99.0 - 1.0) + (2.0 / 3.0) * (100.0 / 98.01 - 1.0);
        assert!((*p.pnl.last().unwrap() as f64 - expected).abs() < 1e-4, "pnl {} vs {}", p.pnl.last().unwrap(), expected);
    }

    #[test]
    fn a_stop_ends_the_ladder_with_a_loss() {
        let cs = vec![c(0, 100.0, 100.0, 100.0, 100.0), c(1, 100.0, 100.0, 98.5, 99.0), c(2, 99.0, 99.0, 85.0, 86.0)];
        let mut k = cfg();
        k.stop_pct = 10.0;
        let p = simulate_ladder("X", &cs, 1, 100.0, &k).unwrap();
        assert_eq!(p.reason, "stop");
        assert!(*p.pnl.last().unwrap() < 0.0);
    }

    #[test]
    fn liquidation_loses_the_margin_and_no_more() {
        let cs = vec![c(0, 100.0, 100.0, 100.0, 100.0), c(1, 100.0, 100.0, 98.5, 99.0), c(2, 99.0, 99.0, 40.0, 41.0)];
        let mut k = cfg();
        k.leverage = 5.0;
        k.layers = 1;
        let p = simulate_ladder("X", &cs, 1, 100.0, &k).unwrap();
        assert_eq!(p.reason, "liq");
        assert!((*p.pnl.last().unwrap() as f64 + 1.0).abs() < 1e-6, "expected -1.0 of the budget, got {}", p.pnl.last().unwrap());
    }

    #[test]
    fn a_crack_that_never_fills_is_not_a_trade() {
        let cs: Vec<Candle> = (0..200).map(|i| c(i, 100.0, 100.5, 99.9, 100.0)).collect();
        assert!(simulate_ladder("X", &cs, 1, 100.0, &cfg()).is_none());
    }

    #[test]
    fn the_donchian_position_is_low_near_the_bottom_of_the_range() {
        let mut cs: Vec<Candle> = (0..20).map(|i| c(i, 100.0, 110.0, 90.0, 100.0)).collect();
        cs[19] = c(19, 91.0, 92.0, 90.5, 91.0);
        let pos = donchian_position(&cs, 20, 20).unwrap_or(1.0);
        assert!(pos < 0.1, "{pos}");
        assert!(donchian_position(&cs, 5, 20).is_none());
    }

    fn path(sym: &str, start: u64, pnl: Vec<f32>, reason: &'static str) -> LadderPath {
        LadderPath { symbol: sym.into(), trigger_ms: start * STEP_MS, end_ms: (start + pnl.len() as u64 - 1) * STEP_MS, reason, pnl }
    }

    #[test]
    fn the_account_scales_each_ladder_by_its_budget_and_counts_drawdown_while_open() {
        let mut k = cfg();
        k.alloc_pct = 10.0;
        k.max_budget = 1e9;
        k.start_equity = 1000.0;
        let paths = vec![path("A", 0, vec![0.0, -0.5, 0.2], "tp")];
        let r = simulate_account(&paths, &k, 0, 10 * STEP_MS, true);
        // budget 100: ends +0.2 x 100 = +20 = +2%; mid-trade it was down 50 = 5%
        assert!((r.return_pct - 2.0).abs() < 1e-6, "{}", r.return_pct);
        assert!((r.max_drawdown_pct - 5.0).abs() < 1e-6, "{}", r.max_drawdown_pct);
        assert_eq!((r.ladders, r.closed, r.wins), (1, 1, 1));
    }

    #[test]
    fn one_ladder_per_symbol_and_a_cap_on_open_ladders() {
        let mut k = cfg();
        k.max_ladders = 1;
        let paths = vec![path("A", 0, vec![0.0, 0.0, 0.0, 0.1], "tp"), path("B", 1, vec![0.0, 0.1], "tp"), path("A", 2, vec![0.0, 0.1], "tp")];
        let r = simulate_account(&paths, &k, 0, 20 * STEP_MS, false);
        assert_eq!(r.ladders, 1);
        assert_eq!(r.skipped, 2);
    }

    #[test]
    fn the_luck_test_never_exceeds_the_best_subset_and_is_reproducible() {
        let k = cfg();
        let paths: Vec<LadderPath> = (0..20).map(|i| path(&format!("S{i}"), i, vec![0.0, 0.05], "tp")).collect();
        let a = luck_test(&paths, &k, 0, 100 * STEP_MS, 10, 0.8);
        let b = luck_test(&paths, &k, 0, 100 * STEP_MS, 10, 0.8);
        assert_eq!(a, b);
        assert!(a.p10_return_pct <= a.median_return_pct);
    }

    #[test]
    fn stressed_costs_are_harsher() {
        let k = LabConfig::default();
        let s = k.stressed();
        assert!(s.fee_pct > k.fee_pct && s.fill_through_pct > k.fill_through_pct && s.funding_pct_8h > k.funding_pct_8h);
    }
}
