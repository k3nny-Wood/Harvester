//! The volatility-factor comparison from a start date to the latest candle, on the Lab's download cache (%TEMP%/harvester_lab,
//! 15 m candles from the real exchange). Everything but the factor is the V2 live setting.
//!
//!   cargo run --release -p harvester-core --example factor_recent -- 2026-08-01

use harvester_core::candle::Candle;
use harvester_core::lab::{build_paths, find_setups, luck_test, simulate_account, start_dates, LabConfig, STEP_MS};
use serde::Deserialize;
use std::collections::HashMap;

const DAY: u64 = 86_400_000;

#[derive(Deserialize)]
struct Kline {
    time: u64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: f64,
}

fn ms(y: i32, m: u32, d: u32) -> u64 {
    let y = y as i64 - if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    ((era * 146_097 + doe - 719_468) as u64) * DAY
}

fn load() -> HashMap<String, Vec<Candle>> {
    let dir = std::env::temp_dir().join("harvester_lab");
    let mut best: HashMap<String, (u64, std::path::PathBuf)> = HashMap::new();
    for e in std::fs::read_dir(&dir).expect("no Lab cache: run the Lab once") {
        let path = e.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let Some((sym, rest)) = name.split_once("_15m_") else { continue };
        let day: u64 = rest.trim_end_matches(".json").parse().unwrap_or(u64::MAX);
        let entry = best.entry(sym.to_string()).or_insert((day, path.clone()));
        if day < entry.0 {
            *entry = (day, path.clone());
        }
    }
    let mut out = HashMap::new();
    for (sym, (_, path)) in best {
        let k: Vec<Kline> = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        if k.len() > 5000 {
            out.insert(sym, k.iter().map(|k| Candle::new(k.time, k.open, k.high, k.low, k.close, k.volume)).collect());
        }
    }
    out
}

fn main() {
    let arg = std::env::args().nth(1).unwrap_or_else(|| "2026-08-01".to_string());
    let p: Vec<u32> = arg.split('-').map(|x| x.parse().unwrap()).collect();
    let from = ms(p[0] as i32, p[1], p[2]);
    let all = load();
    let end = all.values().filter_map(|c| c.last()).map(|c| c.open_time + STEP_MS).max().unwrap();
    let first = all.values().filter_map(|c| c.first()).map(|c| c.open_time).max().unwrap();
    println!("{} coins; candles from day {} to day {}; trading from day {} ({} days)", all.len(), first / DAY, end / DAY, from / DAY, (end - from) / DAY);
    assert!(from >= first + 33 * DAY, "the cache does not reach back far enough for the 30-day market gate before the start date");

    let thirds: Vec<(u64, u64)> = {
        let span = (end - from) / 3;
        (0..3).map(|i| (from + span * i, from + span * (i + 1))).collect()
    };
    let hold = |a: u64, b: u64| -> f64 {
        let mut r = Vec::new();
        for c in all.values() {
            let s = c.iter().find(|x| x.open_time >= a).map(|x| x.open);
            let e = c.iter().rev().find(|x| x.open_time < b).map(|x| x.close);
            if let (Some(s), Some(e)) = (s, e) {
                r.push(e / s - 1.0);
            }
        }
        r.iter().sum::<f64>() / r.len() as f64 * 100.0
    };
    println!("equal-weight buy & hold (1x): whole {:+.1}%, thirds {}", hold(from, end), thirds.iter().map(|q| format!("{:+.1}%", hold(q.0, q.1))).collect::<Vec<_>>().join("  "));
    println!("\n{:<14} {:>7} {:>9} {:>7} {:>6} {:>6} {:>5}  {:>20}  {:>11} {:>9}  thirds", "volatility", "ladders", "return", "dd", "pf", "calmar", "win", "luck median (p10)", "worst start", "stressed");
    for factor in [1.0, 2.0, 3.0, 3.5, 5.0, 7.0] {
        let cfg = LabConfig { volatility_factor: factor, ..LabConfig::default() };
        let setups = find_setups(&all, &cfg, from);
        let paths = build_paths(&all, &setups, &cfg);
        let r = simulate_account(&paths, &cfg, from, end, false);
        let luck = luck_test(&paths, &cfg, from, end, 20, 0.8);
        let worst = start_dates(&paths, &cfg, from, end, 8).iter().map(|s| s.return_pct).fold(f64::INFINITY, f64::min);
        let sc = cfg.stressed();
        let stressed = simulate_account(&build_paths(&all, &setups, &sc), &sc, from, end, false);
        let ts: Vec<String> = thirds.iter().map(|q| format!("{:+.0}%", simulate_account(&paths, &cfg, q.0, q.1, false).return_pct)).collect();
        let calmar = if r.max_drawdown_pct > 0.0 { r.return_pct / r.max_drawdown_pct } else { 0.0 };
        let win = if r.closed > 0 { r.wins as f64 / r.closed as f64 * 100.0 } else { 0.0 };
        println!(
            "{:<14} {:>7} {:>+8.1}% {:>6.1}% {:>6.2} {:>6.2} {:>4.0}%  {:>+9.1}% ({:>+7.1}%)  {:>+10.1}% {:>+8.1}%  {}",
            if factor == 1.0 { "1.0 (V2 now)".to_string() } else if factor == 3.5 { "3.5 (chart)".to_string() } else { format!("{factor:.1}") },
            r.ladders,
            r.return_pct,
            r.max_drawdown_pct,
            r.profit_factor,
            calmar,
            win,
            luck.median_return_pct,
            luck.p10_return_pct,
            worst,
            stressed.return_pct,
            ts.join(" ")
        );
    }
}
