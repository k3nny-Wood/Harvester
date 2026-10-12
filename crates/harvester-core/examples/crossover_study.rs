//! Moving-average crossover study on 13 months of 15 m candles (MarketScanner's candle database), judged like the QFL ladder:
//! one shared account, luck test, eight start dates, stressed costs, and the result by quarter so the market regime shows.
//!
//!   cargo run --release -p harvester-core --example crossover_study -- E:/CRYPTO/MarketScanner/ml_training/candle_cache_merged.db
//!
//! The coins are the most liquid ones that have the whole history: a hindsight pool, so every number is an upper bound.

use harvester_core::candle::Candle;
use harvester_core::crossover::{crossover_paths, CrossParams, CrossSide};
use harvester_core::lab::{build_paths, find_setups, luck_test, pool_gate, simulate_account, start_dates, LabConfig, LadderPath, STEP_MS};
use rusqlite::{Connection, OpenFlags};
use std::collections::HashMap;

const DAY: u64 = 86_400_000;

fn ms(y: i32, m: u32, d: u32) -> u64 {
    // days since 1970-01-01 from a civil date
    let y = y as i64 - if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    ((era * 146_097 + doe - 719_468) as u64) * DAY
}

fn load(db: &str, from_ms: u64) -> HashMap<String, Vec<Candle>> {
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).expect("open db");
    let mut st = conn
        .prepare("SELECT symbol, COUNT(*), MAX(open_time), SUM(volume * close) FROM candles WHERE interval='15m' AND open_time >= ?1 GROUP BY symbol")
        .unwrap();
    let rows: Vec<(String, i64, i64, f64)> = st.query_map([from_ms as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap().filter_map(Result::ok).collect();
    let end = rows.iter().map(|r| r.2).max().unwrap_or(0);
    let want = ((end as u64 - from_ms) / STEP_MS) as i64;
    // whole history (>= 97% of the candles), alive at the end, USDT, ASCII, ranked by traded value
    let mut ok: Vec<&(String, i64, i64, f64)> = rows.iter().filter(|r| r.1 as f64 >= want as f64 * 0.97 && r.2 >= end - 2 * DAY as i64 && r.0.ends_with("USDT") && r.0.is_ascii()).collect();
    ok.sort_by(|a, b| b.3.partial_cmp(&a.3).unwrap());
    let mut out = HashMap::new();
    for r in ok.into_iter().take(60) {
        let mut q = conn.prepare_cached("SELECT open_time, open, high, low, close, volume FROM candles WHERE symbol=?1 AND interval='15m' AND open_time>=?2 ORDER BY open_time").unwrap();
        let candles: Vec<Candle> = q.query_map(rusqlite::params![r.0, from_ms as i64], |x| Ok(Candle::new(x.get::<_, i64>(0)? as u64, x.get(1)?, x.get(2)?, x.get(3)?, x.get(4)?, x.get(5)?))).unwrap().filter_map(Result::ok).collect();
        out.insert(r.0.clone(), candles);
    }
    out
}

struct Row {
    name: String,
    trades: usize,
    ret: f64,
    dd: f64,
    pf: f64,
    win: f64,
    luck_med: f64,
    luck_p10: f64,
    worst_start: f64,
    stressed: f64,
    quarters: Vec<f64>,
}

fn main() {
    let db = std::env::args().nth(1).unwrap_or_else(|| "E:/CRYPTO/MarketScanner/ml_training/candle_cache_merged.db".to_string());
    let from = ms(2025, 12, 29);
    let trade_from = ms(2026, 2, 10);
    let all = load(&db, from);
    let end = all.values().filter_map(|c| c.last()).map(|c| c.open_time + STEP_MS).max().unwrap();
    println!("{} coins, candles from {} days, trading {} -> {} days since epoch", all.len(), from / DAY, trade_from / DAY, end / DAY);

    let gate = pool_gate(&all, 30);
    let acct = LabConfig { stop_pct: 0.0, ..LabConfig::default() };
    let quarters: Vec<(u64, u64)> = {
        let span = (end - trade_from) / 4;
        (0..4).map(|i| (trade_from + span * i, trade_from + span * (i + 1))).collect()
    };

    // buy and hold, equal weight, as the yardstick for each quarter
    let hold = |a: u64, b: u64| -> f64 {
        let mut rets = Vec::new();
        for c in all.values() {
            let s = c.iter().find(|x| x.open_time >= a).map(|x| x.open);
            let e = c.iter().rev().find(|x| x.open_time < b).map(|x| x.close);
            if let (Some(s), Some(e)) = (s, e) {
                rets.push(e / s - 1.0);
            }
        }
        rets.iter().sum::<f64>() / rets.len() as f64 * 100.0
    };
    let hold_q: Vec<f64> = quarters.iter().map(|q| hold(q.0, q.1)).collect();
    println!("equal-weight buy & hold, whole window: {:+.1}%, by quarter: {}", hold(trade_from, end), hold_q.iter().map(|v| format!("{v:+.1}%")).collect::<Vec<_>>().join("  "));
    println!("quarters start: {}", quarters.iter().map(|q| format!("day {}", q.0 / DAY)).collect::<Vec<_>>().join(", "));

    let mut rows: Vec<Row> = Vec::new();
    for &mult in &[1usize, 4, 16] {
        for &(fast, slow) in &[(9usize, 21usize), (20, 50), (50, 200)] {
            for &side in &[CrossSide::Long, CrossSide::Both] {
                for &gated in &[false, true] {
                    let p = CrossParams { tf_mult: mult, fast, slow, side, gate_min_pct: if gated { Some(10.0) } else { None }, ..CrossParams::default() };
                    let build = |cp: &CrossParams| -> Vec<LadderPath> {
                        let mut v: Vec<LadderPath> = all.iter().flat_map(|(s, c)| crossover_paths(s, c, cp, if cp.gate_min_pct.is_some() { Some(&gate) } else { None }, trade_from)).collect();
                        v.sort_by(|a, b| (a.trigger_ms, &a.symbol).cmp(&(b.trigger_ms, &b.symbol)));
                        v
                    };
                    let paths = build(&p);
                    let base = simulate_account(&paths, &acct, trade_from, end, false);
                    let luck = luck_test(&paths, &acct, trade_from, end, 20, 0.8);
                    let starts = start_dates(&paths, &acct, trade_from, end, 8);
                    let stressed = simulate_account(&build(&p.stressed()), &acct, trade_from, end, false);
                    let qs = quarters.iter().map(|q| simulate_account(&paths, &acct, q.0, q.1, false).return_pct).collect();
                    let name = format!("{:>4} {:>2}/{:<3} {} {}", match mult { 1 => "15m", 4 => "1h", _ => "4h" }, fast, slow, if side == CrossSide::Long { "long" } else { "both" }, if gated { "gate" } else { "none" });
                    let wins = paths.iter().filter(|t| *t.pnl.last().unwrap_or(&0.0) > 0.0).count();
                    rows.push(Row {
                        name,
                        trades: paths.len(),
                        ret: base.return_pct,
                        dd: base.max_drawdown_pct,
                        pf: base.profit_factor,
                        win: if paths.is_empty() { 0.0 } else { wins as f64 / paths.len() as f64 * 100.0 },
                        luck_med: luck.median_return_pct,
                        luck_p10: luck.p10_return_pct,
                        worst_start: starts.iter().map(|s| s.return_pct).fold(f64::INFINITY, f64::min),
                        stressed: stressed.return_pct,
                        quarters: qs,
                    });
                    let r = rows.last().unwrap();
                    println!("{:<22} trades {:>6}  ret {:>+8.1}%  dd {:>5.1}%  pf {:>5.2}  win {:>4.0}%  luck {:>+8.1}% (p10 {:>+8.1}%)  worst-start {:>+8.1}%  stressed {:>+8.1}%  Q: {}", r.name, r.trades, r.ret, r.dd, r.pf, r.win, r.luck_med, r.luck_p10, r.worst_start, r.stressed, r.quarters.iter().map(|v| format!("{v:+.0}%")).collect::<Vec<_>>().join(" "));
                }
            }
        }
    }
    // the QFL ladder (V2 live setting) on exactly the same coins and window, for comparison
    let qfl = LabConfig::default();
    let setups = find_setups(&all, &qfl, trade_from);
    let paths = build_paths(&all, &setups, &qfl);
    let base = simulate_account(&paths, &qfl, trade_from, end, false);
    let luck = luck_test(&paths, &qfl, trade_from, end, 20, 0.8);
    let starts = start_dates(&paths, &qfl, trade_from, end, 8);
    let sq = qfl.stressed();
    let stressed = simulate_account(&build_paths(&all, &setups, &sq), &sq, trade_from, end, false);
    let qs: Vec<f64> = quarters.iter().map(|q| simulate_account(&paths, &qfl, q.0, q.1, false).return_pct).collect();
    println!("
QFL ladder (V2 live, market gate on), same coins and window: ladders {}  ret {:+.1}%  dd {:.1}%  pf {:.2}  luck {:+.1}% (p10 {:+.1}%)  worst-start {:+.1}%  stressed {:+.1}%  Q: {}", paths.len(), base.return_pct, base.max_drawdown_pct, base.profit_factor, luck.median_return_pct, luck.p10_return_pct, starts.iter().map(|s| s.return_pct).fold(f64::INFINITY, f64::min), stressed.return_pct, qs.iter().map(|v| format!("{v:+.0}%")).collect::<Vec<_>>().join(" "));
    let positive = rows.iter().filter(|r| r.ret > 0.0 && r.stressed > 0.0 && r.worst_start > 0.0).count();
    println!("\n{} of {} configurations are positive in the full window, under stressed costs AND from every start date", positive, rows.len());
}
