//! ML forward test: replay the ML trade finder over recent candles and score every plan it would have shown, with fees.
//!
//! The model was trained on older data, so the days after its training date are genuinely unseen. Each call is judged exactly as a
//! trader would see it: entered at the NEXT candle's open, stop and target fixed from the plan, whichever is touched first decides
//! (both in one candle counts as the stop: pessimistic), a time limit closes the rest at the close. Costs: a taker fee per side.
//!
//! The honest reading of the result is the NET average per trade and how it moves from week to week; one flattering week proves nothing.

use crate::candle::Candle;
use crate::lab::LadderPath;
use crate::ladder::Side;
use crate::ml::plan::TradePlan;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ForwardParams {
    /// candles a trade may stay open before it is closed at the market (96 = 24 h of 15 m candles)
    pub max_hold: usize,
    /// candles a symbol is ignored after a call (so one move is not counted many times)
    pub cooldown: usize,
    /// taker fee per side, percent
    pub fee_pct: f64,
    /// extra slippage per side, percent
    pub slippage_pct: f64,
}

impl Default for ForwardParams {
    fn default() -> Self {
        ForwardParams { max_hold: 96, cooldown: 16, fee_pct: 0.05, slippage_pct: 0.02 }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Target,
    Stop,
    Timeout,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ForwardTrade {
    pub symbol: String,
    pub time_ms: u64,
    pub long: bool,
    pub outcome: Outcome,
    pub gross_pct: f64,
    pub net_pct: f64,
    /// result in units of the planned risk (+2 = the target of a 2R plan)
    pub r: f64,
}

/// Judge one plan. `signal_idx` is the candle the call was made on (its close is the plan's entry price).
pub fn judge(symbol: &str, candles: &[Candle], signal_idx: usize, side: Side, plan: &TradePlan, p: &ForwardParams) -> Option<ForwardTrade> {
    let entry_idx = signal_idx + 1;
    if entry_idx >= candles.len() {
        return None;
    }
    let long = side == Side::Buy;
    let entry = candles[entry_idx].open;
    // a gap that already went through the stop or the target leaves no trade
    if (long && (entry <= plan.stop || entry >= plan.target)) || (!long && (entry >= plan.stop || entry <= plan.target)) {
        return None;
    }
    let risk = (entry - plan.stop).abs();
    if risk <= 0.0 {
        return None;
    }
    let last = (entry_idx + p.max_hold).min(candles.len() - 1);
    let (mut exit, mut outcome) = (candles[last].close, Outcome::Timeout);
    for c in &candles[entry_idx..=last] {
        let stop_hit = if long { c.low <= plan.stop } else { c.high >= plan.stop };
        let target_hit = if long { c.high >= plan.target } else { c.low <= plan.target };
        if stop_hit {
            // both in one candle: the stop is assumed first
            exit = plan.stop;
            outcome = Outcome::Stop;
            break;
        }
        if target_hit {
            exit = plan.target;
            outcome = Outcome::Target;
            break;
        }
    }
    let gross = if long { exit / entry - 1.0 } else { 1.0 - exit / entry } * 100.0;
    let cost = 2.0 * (p.fee_pct + p.slippage_pct);
    let r = if long { exit - entry } else { entry - exit } / risk;
    Some(ForwardTrade { symbol: symbol.to_string(), time_ms: candles[entry_idx].open_time, long, outcome, gross_pct: gross, net_pct: gross - cost, r })
}

/// The same judgement as `judge`, but as a per-candle path for the shared-account simulator: profit per 1.0 of margin at the close of
/// every candle from the entry to the exit, at `leverage`, fees and slippage charged on both sides.
pub fn judge_path(symbol: &str, candles: &[Candle], signal_idx: usize, side: Side, plan: &TradePlan, p: &ForwardParams, leverage: f64) -> Option<LadderPath> {
    let entry_idx = signal_idx + 1;
    if entry_idx >= candles.len() {
        return None;
    }
    let long = side == Side::Buy;
    let entry = candles[entry_idx].open;
    if (long && (entry <= plan.stop || entry >= plan.target)) || (!long && (entry >= plan.stop || entry <= plan.target)) {
        return None;
    }
    let sign = if long { 1.0 } else { -1.0 };
    let cost = (p.fee_pct + p.slippage_pct) / 100.0;
    let last = (entry_idx + p.max_hold).min(candles.len() - 1);
    let mut pnl: Vec<f32> = Vec::new();
    let (mut end, mut reason) = (last, "tp");
    let mut exit_px = candles[last].close;
    for (i, c) in candles.iter().enumerate().take(last + 1).skip(entry_idx) {
        let stop_hit = if long { c.low <= plan.stop } else { c.high >= plan.stop };
        let target_hit = if long { c.high >= plan.target } else { c.low <= plan.target };
        if stop_hit || target_hit {
            exit_px = if stop_hit { plan.stop } else { plan.target };
            reason = if stop_hit { "stop" } else { "tp" };
            end = i;
            break;
        }
        pnl.push((leverage * sign * (c.close / entry - 1.0) - leverage * cost).max(-1.0) as f32);
    }
    pnl.push(((leverage * sign * (exit_px / entry - 1.0) - 2.0 * leverage * cost).max(-1.0)) as f32);
    Some(LadderPath { symbol: symbol.to_string(), trigger_ms: candles[entry_idx].open_time, end_ms: candles[end].open_time, reason, pnl })
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SideStats {
    pub trades: usize,
    pub win_rate_pct: f64,
    pub avg_gross_pct: f64,
    pub avg_net_pct: f64,
    pub avg_r: f64,
    pub profit_factor: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WeekStats {
    pub week_start_ms: u64,
    pub trades: usize,
    pub avg_net_pct: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ForwardReport {
    pub symbols: usize,
    pub candles_scanned: usize,
    pub window_start_ms: u64,
    pub window_end_ms: u64,
    pub all: SideStats,
    pub longs: SideStats,
    pub shorts: SideStats,
    pub targets: usize,
    pub stops: usize,
    pub timeouts: usize,
    pub weeks: Vec<WeekStats>,
    pub notes: Vec<String>,
}

pub fn stats(trades: &[&ForwardTrade]) -> SideStats {
    if trades.is_empty() {
        return SideStats::default();
    }
    let n = trades.len() as f64;
    let (gains, losses) = trades.iter().fold((0.0, 0.0), |(g, l), t| if t.net_pct > 0.0 { (g + t.net_pct, l) } else { (g, l - t.net_pct) });
    SideStats {
        trades: trades.len(),
        win_rate_pct: trades.iter().filter(|t| t.net_pct > 0.0).count() as f64 / n * 100.0,
        avg_gross_pct: trades.iter().map(|t| t.gross_pct).sum::<f64>() / n,
        avg_net_pct: trades.iter().map(|t| t.net_pct).sum::<f64>() / n,
        avg_r: trades.iter().map(|t| t.r).sum::<f64>() / n,
        profit_factor: if losses > 0.0 { Some(gains / losses) } else { None },
    }
}

pub fn report(trades: &[ForwardTrade], symbols: usize, candles_scanned: usize, from_ms: u64, to_ms: u64) -> ForwardReport {
    let all: Vec<&ForwardTrade> = trades.iter().collect();
    let longs: Vec<&ForwardTrade> = trades.iter().filter(|t| t.long).collect();
    let shorts: Vec<&ForwardTrade> = trades.iter().filter(|t| !t.long).collect();
    let week_ms = 7 * 86_400_000u64;
    let mut weeks: Vec<WeekStats> = Vec::new();
    let mut w = from_ms;
    while w < to_ms {
        let in_week: Vec<&ForwardTrade> = trades.iter().filter(|t| t.time_ms >= w && t.time_ms < w + week_ms).collect();
        weeks.push(WeekStats { week_start_ms: w, trades: in_week.len(), avg_net_pct: if in_week.is_empty() { 0.0 } else { in_week.iter().map(|t| t.net_pct).sum::<f64>() / in_week.len() as f64 } });
        w += week_ms;
    }
    let mut notes = vec![
        "The model was trained on older data, so these days are unseen by it. A plan is entered at the next candle's open; if the stop and the target are both inside one candle the stop counts (pessimistic).".to_string(),
        "Earlier research (MarketScanner, Oct 2026) found no net edge after fees at 15 m: expect an average net near or below zero here too. A single good week is not evidence.".to_string(),
    ];
    if trades.len() < 100 {
        notes.push(format!("Only {} trades: too few to say anything.", trades.len()));
    }
    ForwardReport {
        symbols,
        candles_scanned,
        window_start_ms: from_ms,
        window_end_ms: to_ms,
        all: stats(&all),
        longs: stats(&longs),
        shorts: stats(&shorts),
        targets: trades.iter().filter(|t| t.outcome == Outcome::Target).count(),
        stops: trades.iter().filter(|t| t.outcome == Outcome::Stop).count(),
        timeouts: trades.iter().filter(|t| t.outcome == Outcome::Timeout).count(),
        weeks,
        notes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(i: u64, o: f64, h: f64, l: f64, cl: f64) -> Candle {
        Candle::new(i * 900_000, o, h, l, cl, 1000.0)
    }

    fn plan(entry: f64, stop: f64, target: f64) -> TradePlan {
        TradePlan { side: if stop < entry { Side::Buy } else { Side::Sell }, entry, stop, target, risk_pct: 0.0, reward_pct: 0.0, rr: 0.0, entry_time: 0 }
    }

    fn free() -> ForwardParams {
        ForwardParams { fee_pct: 0.0, slippage_pct: 0.0, ..ForwardParams::default() }
    }

    #[test]
    fn a_long_that_reaches_its_target_wins_two_r() {
        let cs = vec![c(0, 100.0, 100.0, 100.0, 100.0), c(1, 100.0, 101.0, 99.5, 100.5), c(2, 100.5, 104.5, 100.2, 104.0)];
        let t = judge("X", &cs, 0, Side::Buy, &plan(100.0, 98.0, 104.0), &free()).unwrap();
        assert_eq!(t.outcome, Outcome::Target);
        assert!((t.gross_pct - 4.0).abs() < 1e-9 && (t.r - 2.0).abs() < 1e-9);
    }

    #[test]
    fn stop_and_target_in_one_candle_counts_as_the_stop() {
        let cs = vec![c(0, 100.0, 100.0, 100.0, 100.0), c(1, 100.0, 105.0, 97.0, 100.0)];
        let t = judge("X", &cs, 0, Side::Buy, &plan(100.0, 98.0, 104.0), &free()).unwrap();
        assert_eq!(t.outcome, Outcome::Stop);
        assert!(t.net_pct < 0.0 && (t.r + 1.0).abs() < 1e-9);
    }

    #[test]
    fn a_short_profits_when_price_falls_to_the_target() {
        let cs = vec![c(0, 100.0, 100.0, 100.0, 100.0), c(1, 100.0, 100.5, 95.0, 96.0)];
        let t = judge("X", &cs, 0, Side::Sell, &plan(100.0, 102.0, 96.0), &free()).unwrap();
        assert_eq!(t.outcome, Outcome::Target);
        assert!(t.gross_pct > 3.9);
    }

    #[test]
    fn a_trade_that_goes_nowhere_closes_at_the_time_limit() {
        let mut cs = vec![c(0, 100.0, 100.0, 100.0, 100.0)];
        cs.extend((1..10).map(|i| c(i, 100.0, 100.5, 99.5, 100.2)));
        let p = ForwardParams { max_hold: 3, ..free() };
        let t = judge("X", &cs, 0, Side::Buy, &plan(100.0, 98.0, 104.0), &p).unwrap();
        assert_eq!(t.outcome, Outcome::Timeout);
        assert!((t.gross_pct - 0.2).abs() < 1e-9);
    }

    #[test]
    fn a_gap_through_the_stop_leaves_no_trade() {
        let cs = vec![c(0, 100.0, 100.0, 100.0, 100.0), c(1, 97.0, 98.0, 96.0, 97.0)];
        assert!(judge("X", &cs, 0, Side::Buy, &plan(100.0, 98.0, 104.0), &free()).is_none());
    }

    #[test]
    fn fees_and_slippage_are_charged_on_both_sides() {
        let cs = vec![c(0, 100.0, 100.0, 100.0, 100.0), c(1, 100.0, 105.0, 99.9, 104.0)];
        let t = judge("X", &cs, 0, Side::Buy, &plan(100.0, 98.0, 104.0), &ForwardParams::default()).unwrap();
        assert!((t.gross_pct - t.net_pct - 0.14).abs() < 1e-9, "{} {}", t.gross_pct, t.net_pct);
    }

    #[test]
    fn a_path_ends_with_the_trades_net_result_scaled_by_leverage() {
        let cs = vec![c(0, 100.0, 100.0, 100.0, 100.0), c(1, 100.0, 101.0, 99.5, 100.5), c(2, 100.5, 104.5, 100.2, 104.0)];
        let p = ForwardParams { fee_pct: 0.0, slippage_pct: 0.0, ..ForwardParams::default() };
        let path = judge_path("X", &cs, 0, Side::Buy, &plan(100.0, 98.0, 104.0), &p, 3.0).unwrap();
        assert_eq!(path.reason, "tp");
        assert_eq!(path.pnl.len(), 2);
        assert!((*path.pnl.last().unwrap() as f64 - 0.12).abs() < 1e-6, "{:?}", path.pnl);
        // the same trade with costs ends lower by 2 x leverage x (fee + slippage)
        let paid = ForwardParams { fee_pct: 0.05, slippage_pct: 0.02, ..ForwardParams::default() };
        let b = judge_path("X", &cs, 0, Side::Buy, &plan(100.0, 98.0, 104.0), &paid, 3.0).unwrap();
        assert!((0.12 - *b.pnl.last().unwrap() as f64 - 3.0 * 0.0014).abs() < 1e-6);
    }

    #[test]
    fn the_report_splits_sides_and_weeks() {
        let mk = |long: bool, t: u64, net: f64| ForwardTrade { symbol: "X".into(), time_ms: t, long, outcome: Outcome::Target, gross_pct: net, net_pct: net, r: 1.0 };
        let trades = vec![mk(true, 0, 1.0), mk(false, 1000, -2.0), mk(true, 8 * 86_400_000, 3.0)];
        let r = report(&trades, 2, 100, 0, 14 * 86_400_000);
        assert_eq!((r.longs.trades, r.shorts.trades, r.all.trades), (2, 1, 3));
        assert_eq!(r.weeks.len(), 2);
        assert_eq!(r.weeks[0].trades, 2);
        assert!((r.weeks[1].avg_net_pct - 3.0).abs() < 1e-9);
        assert!((r.all.win_rate_pct - 200.0 / 3.0).abs() < 1e-9);
    }
}
