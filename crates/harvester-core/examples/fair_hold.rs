//! A fairer yardstick for the QFL ladder: the coins are chosen AS OF THE START DATE (most traded in the 6 weeks before it), not
//! by today's volume, and the holder is shown with its drawdown, next to BTC alone, ETH alone and BTC+ETH.
//!
//! Why it matters: ranking coins by volume at the END of a window favours coins that just pumped (a pump is high volume), so a basket
//! built that way and "held" from the start is flattered. Ranking at the START uses only what was knowable.
//!
//!   cargo run --release -p harvester-core --example fair_hold -- <db> 2026-08-01

use harvester_core::candle::Candle;
use harvester_core::lab::{build_paths, find_setups, simulate_account, LabConfig, STEP_MS};
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

/// The `n` most traded coins in [rank_from, rank_to) that have the whole history from `from_ms` on.
fn universe(conn: &Connection, from_ms: u64, rank_from: u64, rank_to: u64, n: usize) -> Vec<String> {
    let mut st = conn.prepare("SELECT symbol, COUNT(*), MAX(open_time) FROM candles WHERE interval='15m' AND open_time >= ?1 GROUP BY symbol").unwrap();
    let rows: Vec<(String, i64, i64)> = st.query_map([from_ms as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap().filter_map(Result::ok).collect();
    let end = rows.iter().map(|r| r.2).max().unwrap_or(0);
    let want = ((end as u64 - from_ms) / STEP_MS) as f64;
    let alive: Vec<&(String, i64, i64)> = rows.iter().filter(|r| r.1 as f64 >= want * 0.97 && r.2 >= end - 2 * DAY as i64 && r.0.ends_with("USDT") && r.0.is_ascii()).collect();
    let mut ranked: Vec<(String, f64)> = alive
        .iter()
        .map(|r| {
            let v: f64 = conn.query_row("SELECT COALESCE(SUM(volume*close),0) FROM candles WHERE symbol=?1 AND interval='15m' AND open_time>=?2 AND open_time<?3", rusqlite::params![r.0, rank_from as i64, rank_to as i64], |x| x.get(0)).unwrap_or(0.0);
            (r.0.clone(), v)
        })
        .collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    ranked.into_iter().take(n).map(|r| r.0).collect()
}

fn candles(conn: &Connection, sym: &str, from_ms: u64) -> Vec<Candle> {
    let mut q = conn.prepare_cached("SELECT open_time, open, high, low, close, volume FROM candles WHERE symbol=?1 AND interval='15m' AND open_time>=?2 ORDER BY open_time").unwrap();
    q.query_map(rusqlite::params![sym, from_ms as i64], |x| Ok(Candle::new(x.get::<_, i64>(0)? as u64, x.get(1)?, x.get(2)?, x.get(3)?, x.get(4)?, x.get(5)?))).unwrap().filter_map(Result::ok).collect()
}

/// Return and worst drawdown (percent) of holding an equal-weight basket bought at `start` and never touched.
fn hold(all: &HashMap<String, Vec<Candle>>, syms: &[&str], start: u64) -> (f64, f64) {
    let series: Vec<(&Vec<Candle>, f64)> = syms.iter().filter_map(|s| all.get(*s)).filter_map(|c| c.iter().find(|x| x.open_time >= start).map(|x| (c, x.open))).collect();
    if series.is_empty() {
        return (0.0, 0.0);
    }
    let first = series.iter().map(|(c, _)| c.partition_point(|x| x.open_time < start)).collect::<Vec<_>>();
    let n = series.iter().zip(&first).map(|((c, _), f)| c.len() - f).min().unwrap();
    let (mut peak, mut dd, mut last) = (1.0f64, 0.0f64, 1.0f64);
    for i in 0..n {
        let v = series.iter().zip(&first).map(|((c, o), f)| c[f + i].close / o).sum::<f64>() / series.len() as f64;
        peak = peak.max(v);
        dd = dd.max((peak - v) / peak * 100.0);
        last = v;
    }
    ((last - 1.0) * 100.0, dd)
}

fn main() {
    let db = std::env::args().nth(1).unwrap_or_else(|| "E:/CRYPTO/MarketScanner/ml_training/candle_cache_merged.db".to_string());
    let arg = std::env::args().nth(2).unwrap_or_else(|| "2026-08-01".to_string());
    let p: Vec<u32> = arg.split('-').map(|x| x.parse().unwrap()).collect();
    let start = ms(p[0] as i32, p[1], p[2]);
    let conn = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY).expect("open db");
    let history = ms(2025, 12, 29);

    let pit = universe(&conn, history, start - 42 * DAY, start, 40);
    let end_ranked = {
        // for contrast: the 40 most traded in the LAST 6 weeks of the data, which is how "the top coins today" gets picked
        let last: u64 = conn.query_row("SELECT MAX(open_time) FROM candles WHERE interval='15m'", [], |r| r.get::<_, i64>(0)).unwrap() as u64;
        universe(&conn, history, last - 42 * DAY, last + STEP_MS, 40)
    };
    let mut all: HashMap<String, Vec<Candle>> = HashMap::new();
    for s in pit.iter().chain(end_ranked.iter()).chain(["BTCUSDT".to_string(), "ETHUSDT".to_string()].iter()) {
        all.entry(s.clone()).or_insert_with(|| candles(&conn, s, history));
    }
    let end = all.values().filter_map(|c| c.last()).map(|c| c.open_time + STEP_MS).max().unwrap();
    let overlap = pit.iter().filter(|s| end_ranked.contains(s)).count();
    println!("window: day {} -> day {} ({} days). Universe chosen at the START by volume in the 6 weeks before; chosen at the END by volume in the last 6 weeks. {} of the 40 are in both.", start / DAY, end / DAY, (end - start) / DAY, overlap);

    fn refs(v: &[String]) -> Vec<&str> {
        v.iter().map(|s| s.as_str()).collect()
    }
    println!("\nBUY AND HOLD (equal weight, 1x, never rebalanced)       return    max drawdown");
    let (r, d) = hold(&all, &refs(&end_ranked), start);
    println!("  40 coins picked by volume at the END (hindsight)     {r:>+8.1}%   {d:>6.1}%");
    let (r, d) = hold(&all, &refs(&pit), start);
    println!("  40 coins picked by volume at the START (fair)        {r:>+8.1}%   {d:>6.1}%");
    let (r, d) = hold(&all, &["BTCUSDT"], start);
    println!("  BTC alone                                            {r:>+8.1}%   {d:>6.1}%");
    let (r, d) = hold(&all, &["ETHUSDT"], start);
    println!("  ETH alone                                            {r:>+8.1}%   {d:>6.1}%");
    let (r, d) = hold(&all, &["BTCUSDT", "ETHUSDT"], start);
    println!("  BTC + ETH                                            {r:>+8.1}%   {d:>6.1}%");

    println!("\nQFL LADDER (V2 live setting, 3x, 3.6% per ladder, 25 at once)      return    max drawdown   ladders");
    for (label, uni) in [("coins picked at the END (hindsight)", &end_ranked), ("coins picked at the START (fair)", &pit)] {
        let sub: HashMap<String, Vec<Candle>> = uni.iter().map(|s| (s.clone(), all[s].clone())).collect();
        for factor in [1.0, 3.5] {
            let cfg = LabConfig { volatility_factor: factor, ..LabConfig::default() };
            let setups = find_setups(&sub, &cfg, start);
            let paths = build_paths(&sub, &setups, &cfg);
            let r = simulate_account(&paths, &cfg, start, end, false);
            println!("  {label:<38} factor {factor:<3}  {:>+8.1}%   {:>6.1}%   {:>5}", r.return_pct, r.max_drawdown_pct, r.ladders);
        }
    }
}
