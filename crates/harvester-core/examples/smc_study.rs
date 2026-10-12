//! Does Smart Money confluence improve the QFL ladder? The same ladder (V2 live setting) with and without the requirement that an
//! unmitigated bullish zone (order block / fair value gap) sits around the base, on Feb-Sep 2026 and (out of sample) Mar-Dec 2025.
//!
//!   cargo run --release -p harvester-core --example smc_study -- <2026 db> <2025 db>

use harvester_core::candle::Candle;
use harvester_core::lab::{build_paths, find_setups, luck_test, simulate_account, start_dates, LabConfig, LadderPath, SmcFilter, STEP_MS};
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
    let mut st = conn.prepare("SELECT symbol, COUNT(*), MAX(open_time), SUM(volume * close) FROM candles WHERE interval='15m' AND open_time >= ?1 GROUP BY symbol").unwrap();
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

/// Returns of the shared account on `runs` random subsets of `paths`, each with `n` ladders: what picking that many ladders blindly gives.
fn random_subsets(paths: &[LadderPath], n: usize, cfg: &LabConfig, from: u64, to: u64, runs: usize) -> Vec<f64> {
    let mut state = 0x9E37_79B9_7F4A_7C15u64 ^ (n as u64).wrapping_mul(0xD6E8_FEB8_6659_FD93);
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state >> 11) as f64 / (1u64 << 53) as f64
    };
    let mut out = Vec::new();
    for _ in 0..runs {
        // keep each path with probability n / len, which gives subsets of about the right size
        let p = (n as f64 / paths.len().max(1) as f64).min(1.0);
        let subset: Vec<LadderPath> = paths.iter().filter(|_| next() < p).cloned().collect();
        out.push(simulate_account(&subset, cfg, from, to, false).return_pct);
    }
    out.sort_by(|a, b| a.partial_cmp(b).unwrap());
    out
}

fn study(title: &str, db: &str, from: u64, trade_from: u64) {
    let all = load(db, from, 60);
    let end = all.values().filter_map(|c| c.last()).map(|c| c.open_time + STEP_MS).max().unwrap();
    let quarters: Vec<(u64, u64)> = {
        let span = (end - trade_from) / 4;
        (0..4).map(|i| (trade_from + span * i, trade_from + span * (i + 1))).collect()
    };
    println!("\n=== {title}: {} coins, {} days of trading ===", all.len(), (end - trade_from) / DAY);
    println!("{:<26} {:>6} {:>7} {:>9} {:>7} {:>6} {:>6}  {:>20}  {:>11} {:>9}  quarters", "setting", "setups", "ladders", "return", "dd", "pf", "calmar", "luck median (p10)", "worst start", "stressed");
    let mut rows: Vec<(String, LabConfig)> = Vec::new();
    for factor in [1.0, 3.5] {
        rows.push((format!("factor {factor}  no SMC"), LabConfig { volatility_factor: factor, ..LabConfig::default() }));
        for (name, f) in [("any zone", SmcFilter::Any), ("order block", SmcFilter::OrderBlock), ("fair value gap", SmcFilter::Fvg)] {
            for band in [1.0, 3.0] {
                rows.push((format!("factor {factor}  {name} {band}%"), LabConfig { volatility_factor: factor, smc_filter: f, smc_band_pct: band, ..LabConfig::default() }));
            }
        }
    }
    // the no-SMC ladders of each factor: the pool a blind pick would draw from
    let mut pools: HashMap<u64, Vec<LadderPath>> = HashMap::new();
    for factor in [1.0f64, 3.5] {
        let cfg = LabConfig { volatility_factor: factor, ..LabConfig::default() };
        let setups = find_setups(&all, &cfg, trade_from);
        pools.insert(factor.to_bits(), build_paths(&all, &setups, &cfg));
    }
    for (name, cfg) in rows {
        let setups = find_setups(&all, &cfg, trade_from);
        let paths = build_paths(&all, &setups, &cfg);
        let r = simulate_account(&paths, &cfg, trade_from, end, false);
        let luck = luck_test(&paths, &cfg, trade_from, end, 20, 0.8);
        let worst = start_dates(&paths, &cfg, trade_from, end, 8).iter().map(|s| s.return_pct).fold(f64::INFINITY, f64::min);
        let sc = cfg.stressed();
        let stressed = simulate_account(&build_paths(&all, &setups, &sc), &sc, trade_from, end, false);
        let qs: Vec<String> = quarters.iter().map(|q| format!("{:+.0}%", simulate_account(&paths, &cfg, q.0, q.1, false).return_pct)).collect();
        let calmar = if r.max_drawdown_pct > 0.0 { r.return_pct / r.max_drawdown_pct } else { 0.0 };
        let control = if cfg.smc_filter == SmcFilter::Off {
            String::new()
        } else {
            let pool = &pools[&cfg.volatility_factor.to_bits()];
            let rand = random_subsets(pool, paths.len(), &cfg, trade_from, end, 60);
            let beaten = rand.iter().filter(|x| **x < r.return_pct).count() as f64 / rand.len() as f64 * 100.0;
            format!("  | vs {} random picks of the same size: median {:+.1}%, this beats {:.0}% of them", rand.len(), rand[rand.len() / 2], beaten)
        };
        println!("{:<26} {:>6} {:>7} {:>+8.1}% {:>6.1}% {:>6.2} {:>6.2}  {:>+9.1}% ({:>+7.1}%)  {:>+10.1}% {:>+8.1}%  {}{}", name, setups.len(), r.ladders, r.return_pct, r.max_drawdown_pct, r.profit_factor, calmar, luck.median_return_pct, luck.p10_return_pct, worst, stressed.return_pct, qs.join(" "), control);
    }
}

fn main() {
    let a = std::env::args().nth(1).unwrap_or_else(|| "E:/CRYPTO/MarketScanner/ml_training/candle_cache_merged.db".to_string());
    let b = std::env::args().nth(2).unwrap_or_else(|| "E:/CRYPTO/MarketScanner/candle_cache_2025.db".to_string());
    study("Feb 10 - Sep 30 2026", &a, ms(2025, 12, 29), ms(2026, 2, 10));
    study("Mar 1 - Dec 28 2025 (out of sample)", &b, ms(2025, 1, 1), ms(2025, 3, 1));
}
