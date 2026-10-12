//! Out-of-sample check of ONE pre-chosen crossover idea (1h 20/50 EMA, long only, market gate: pool 30-day return >= +10%) on
//! 2025, a year the choice never saw (it came from a study of Feb-Sep 2026), including the Oct 10 2025 crash and the bear market after it.
//!
//! The variants were fixed BEFORE looking at 2025: the study setting (3x, no stop), a de-risked one (2x, 10% stop), a spot-like
//! one (1x), and the 4h 20/50 runner-up. QFL (V2 live setting) and equal-weight buy & hold are printed for context.
//!
//!   cargo run --release -p harvester-core --example crossover_oos -- E:/CRYPTO/MarketScanner/candle_cache_2025.db

use harvester_core::candle::Candle;
use harvester_core::crossover::{crossover_paths, CrossParams, CrossSide};
use harvester_core::lab::{build_paths, find_setups, luck_test, pool_gate, simulate_account, start_dates, LabConfig, LadderPath, STEP_MS};
use rusqlite::{Connection, OpenFlags};
use std::collections::HashMap;

const DAY: u64 = 86_400_000;

fn ms(y: i32, m: u32, d: u32) -> u64 {
    let y = y as i64 - if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    ((era * 146_097 + doe - 719_468) as u64) * DAY
}

fn load(db: &str, from_ms: u64, n: usize) -> HashMap<String, Vec<Candle>> {
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).expect("open db");
    let mut st = conn
        .prepare("SELECT symbol, COUNT(*), MAX(open_time), SUM(volume * close) FROM candles WHERE interval='15m' AND open_time >= ?1 GROUP BY symbol")
        .unwrap();
    let rows: Vec<(String, i64, i64, f64)> = st.query_map([from_ms as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap().filter_map(Result::ok).collect();
    let end = rows.iter().map(|r| r.2).max().unwrap_or(0);
    let want = ((end as u64 - from_ms) / STEP_MS) as i64;
    let mut ok: Vec<&(String, i64, i64, f64)> = rows.iter().filter(|r| r.1 as f64 >= want as f64 * 0.97 && r.2 >= end - 2 * DAY as i64 && r.0.ends_with("USDT") && r.0.is_ascii()).collect();
    ok.sort_by(|a, b| b.3.partial_cmp(&a.3).unwrap());
    let mut out = HashMap::new();
    for r in ok.into_iter().take(n) {
        let mut q = conn.prepare_cached("SELECT open_time, open, high, low, close, volume FROM candles WHERE symbol=?1 AND interval='15m' AND open_time>=?2 ORDER BY open_time").unwrap();
        let candles: Vec<Candle> = q.query_map(rusqlite::params![r.0, from_ms as i64], |x| Ok(Candle::new(x.get::<_, i64>(0)? as u64, x.get(1)?, x.get(2)?, x.get(3)?, x.get(4)?, x.get(5)?))).unwrap().filter_map(Result::ok).collect();
        out.insert(r.0.clone(), candles);
    }
    out
}

fn main() {
    let db = std::env::args().nth(1).unwrap_or_else(|| "E:/CRYPTO/MarketScanner/candle_cache_2025.db".to_string());
    let from = ms(2025, 1, 1);
    let trade_from = ms(2025, 3, 1);
    let all = load(&db, from, 60);
    let end = all.values().filter_map(|c| c.last()).map(|c| c.open_time + STEP_MS).max().unwrap();
    println!("{} coins, trading {} days (2025-03-01 -> {} days since epoch)", all.len(), (end - trade_from) / DAY, end / DAY);

    let gate = pool_gate(&all, 30);
    let acct = LabConfig { stop_pct: 0.0, ..LabConfig::default() };
    let thirds: Vec<(u64, u64)> = {
        let span = (end - trade_from) / 3;
        (0..3).map(|i| (trade_from + span * i, trade_from + span * (i + 1))).collect()
    };
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
    println!("equal-weight buy & hold: whole {:+.1}%, thirds {}", hold(trade_from, end), thirds.iter().map(|q| format!("{:+.1}%", hold(q.0, q.1))).collect::<Vec<_>>().join("  "));

    let base = CrossParams { tf_mult: 4, fast: 20, slow: 50, side: CrossSide::Long, gate_min_pct: Some(10.0), ..CrossParams::default() };
    let variants: Vec<(&str, CrossParams)> = vec![
        ("1h 20/50 long gate, 3x no stop (study)", base.clone()),
        ("1h 20/50 long gate, 2x stop 10%", CrossParams { leverage: 2.0, stop_pct: 10.0, ..base.clone() }),
        ("1h 20/50 long gate, 1x", CrossParams { leverage: 1.0, ..base.clone() }),
        ("4h 20/50 long gate, 3x no stop", CrossParams { tf_mult: 16, ..base.clone() }),
        ("1h 20/50 long NO gate, 3x (control)", CrossParams { gate_min_pct: None, ..base.clone() }),
    ];
    for (name, p) in variants {
        let build = |cp: &CrossParams| -> Vec<LadderPath> {
            let mut v: Vec<LadderPath> = all.iter().flat_map(|(s, c)| crossover_paths(s, c, cp, if cp.gate_min_pct.is_some() { Some(&gate) } else { None }, trade_from)).collect();
            v.sort_by(|a, b| (a.trigger_ms, &a.symbol).cmp(&(b.trigger_ms, &b.symbol)));
            v
        };
        let paths = build(&p);
        // at lower leverage the account may put more margin to work for the same risk: keep the study's 3.6% per position
        let r = simulate_account(&paths, &acct, trade_from, end, false);
        let luck = luck_test(&paths, &acct, trade_from, end, 20, 0.8);
        let starts = start_dates(&paths, &acct, trade_from, end, 8);
        let stressed = simulate_account(&build(&p.stressed()), &acct, trade_from, end, false);
        let qs: Vec<f64> = thirds.iter().map(|q| simulate_account(&paths, &acct, q.0, q.1, false).return_pct).collect();
        println!(
            "{:<42} trades {:>5}  ret {:>+7.1}%  dd {:>5.1}%  pf {:>4.2}  luck {:>+7.1}% (p10 {:>+7.1}%)  worst-start {:>+7.1}%  stressed {:>+7.1}%  thirds: {}",
            name,
            paths.len(),
            r.return_pct,
            r.max_drawdown_pct,
            r.profit_factor,
            luck.median_return_pct,
            luck.p10_return_pct,
            starts.iter().map(|s| s.return_pct).fold(f64::INFINITY, f64::min),
            stressed.return_pct,
            qs.iter().map(|v| format!("{v:+.0}%")).collect::<Vec<_>>().join(" ")
        );
    }

    let qfl = LabConfig::default();
    let setups = find_setups(&all, &qfl, trade_from);
    let paths = build_paths(&all, &setups, &qfl);
    let r = simulate_account(&paths, &qfl, trade_from, end, false);
    let sq = qfl.stressed();
    let stressed = simulate_account(&build_paths(&all, &setups, &sq), &sq, trade_from, end, false);
    let qs: Vec<f64> = thirds.iter().map(|q| simulate_account(&paths, &qfl, q.0, q.1, false).return_pct).collect();
    println!("{:<42} ladders {:>4}  ret {:>+7.1}%  dd {:>5.1}%  pf {:>4.2}  stressed {:>+7.1}%  thirds: {}", "QFL ladder (V2 live), same data", paths.len(), r.return_pct, r.max_drawdown_pct, r.profit_factor, stressed.return_pct, qs.iter().map(|v| format!("{v:+.0}%")).collect::<Vec<_>>().join(" "));
}
