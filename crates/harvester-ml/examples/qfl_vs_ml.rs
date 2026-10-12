//! QFL ladder vs the ML trade finder, in the SAME shared account (3.6% of equity per position, 25 open at once, 3x, fees,
//! slippage, funding) on the SAME coins and candles, over the same windows.
//!
//! Candles come from the Lab's download cache (%TEMP%/harvester_lab, 15 m, real exchange). Windows: the last 30 days, and the days
//! since the ML model's training ended (Aug 22), which it has never seen.
//!
//!   cargo run --release -p harvester-ml --example qfl_vs_ml -- <models dir>

use harvester_core::candle::Candle;
use harvester_core::lab::{build_paths, find_setups, luck_test, simulate_account, start_dates, AccountResult, LabConfig, LadderPath, STEP_MS};
use harvester_core::ladder::Side;
use harvester_core::ml::forward::{judge_path, ForwardParams};
use harvester_core::ml::plan::{evaluate, MlParams, TradePlan};
use harvester_ml::Engine;
use serde::Deserialize;
use std::collections::HashMap;

const DAY: u64 = 86_400_000;
const WINDOW: usize = 333;

#[derive(Deserialize)]
struct Kline {
    time: u64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: f64,
}

struct Call {
    symbol: String,
    idx: usize,
    side: Side,
    plan: TradePlan,
    probability: f64,
}

fn load() -> HashMap<String, Vec<Candle>> {
    let dir = std::env::temp_dir().join("harvester_lab");
    // the largest cached window (the longest history) per symbol
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

fn line(name: &str, n: usize, r: &AccountResult, luck: Option<(f64, f64)>, worst: Option<f64>, stressed: f64) {
    println!(
        "  {:<34} trades {:>5}  ret {:>+8.1}%  dd {:>5.1}%  pf {:>5.2}  win {:>3.0}%  luck {}  worst-start {}  stressed {:>+8.1}%",
        name,
        n,
        r.return_pct,
        r.max_drawdown_pct,
        r.profit_factor,
        if r.closed > 0 { r.wins as f64 / r.closed as f64 * 100.0 } else { 0.0 },
        luck.map_or("      -".to_string(), |l| format!("{:+.1}% (p10 {:+.1}%)", l.0, l.1)),
        worst.map_or("     -".to_string(), |w| format!("{w:+.1}%")),
        stressed
    );
}

fn main() {
    let models = std::env::args().nth(1).unwrap_or_else(|| "models/15m".to_string());
    let all = load();
    let end = all.values().filter_map(|c| c.last()).map(|c| c.open_time + STEP_MS).max().unwrap();
    let aug22: u64 = 1_787_356_800_000; // 2026-08-22 00:00 UTC
    let last30 = end - 30 * DAY;
    println!("{} coins, candles to day {}; windows: last 30 days (from day {}), unseen by the model since Aug 22 (day {})", all.len(), end / DAY, last30 / DAY, aug22 / DAY);

    let acct = LabConfig::default();
    let stressed_acct = acct.stressed();

    // ---- ML calls over the longer window (Aug 22 on); the last-30-day window is a subset
    let mut engine = Engine::load(std::path::Path::new(&models)).expect("models");
    let ml = MlParams::default();
    let mut calls: Vec<Call> = Vec::new();
    let mut syms: Vec<&String> = all.keys().collect();
    syms.sort();
    for sym in syms {
        let c = &all[sym];
        let first = c.partition_point(|x| x.open_time < aug22).max(WINDOW);
        let mut quiet = 0usize;
        for i in first..c.len().saturating_sub(1) {
            if i < quiet {
                continue;
            }
            let calls_here = evaluate(&c[i + 1 - WINDOW..=i], &ml, |f, side| engine.predict(f, side));
            if let Some(call) = calls_here.into_iter().max_by(|a, b| a.probability.partial_cmp(&b.probability).unwrap()) {
                let fwd = ForwardParams::default();
                if judge_path(sym, c, i, call.side, &call.plan, &fwd, acct.leverage).is_some() {
                    calls.push(Call { symbol: sym.clone(), idx: i, side: call.side, plan: call.plan, probability: call.probability });
                    quiet = i + fwd.cooldown;
                }
            }
        }
    }
    println!("ML made {} calls (one per coin per 4 hours at most)", calls.len());

    let build_ml = |keep: &dyn Fn(&Call) -> bool, fwd: &ForwardParams| -> Vec<LadderPath> {
        let mut v: Vec<LadderPath> = calls.iter().filter(|c| keep(c)).filter_map(|c| judge_path(&c.symbol, &all[&c.symbol], c.idx, c.side, &c.plan, fwd, acct.leverage)).collect();
        v.sort_by(|a, b| (a.trigger_ms, &a.symbol).cmp(&(b.trigger_ms, &b.symbol)));
        v
    };
    let fwd = ForwardParams::default();
    let fwd_stress = ForwardParams { fee_pct: 0.06, slippage_pct: 0.25, ..fwd.clone() };

    for (label, from) in [("LAST 30 DAYS", last30), ("UNSEEN BY THE MODEL (since Aug 22)", aug22)] {
        println!("\n=== {label}: {} -> day {} ===", from / DAY, end / DAY);
        // QFL needs the long warm-up (gate, Donchian) which the cache provides
        let setups = find_setups(&all, &acct, from);
        let qpaths = build_paths(&all, &setups, &acct);
        let qs = acct.stressed();
        let qstress = simulate_account(&build_paths(&all, &setups, &qs), &qs, from, end, false);
        let r = simulate_account(&qpaths, &acct, from, end, false);
        let luck = luck_test(&qpaths, &acct, from, end, 20, 0.8);
        let worst = start_dates(&qpaths, &acct, from, end, 8).iter().map(|s| s.return_pct).fold(f64::INFINITY, f64::min);
        line("QFL ladder (V2 live setting)", qpaths.len(), &r, Some((luck.median_return_pct, luck.p10_return_pct)), Some(worst), qstress.return_pct);

        let variants: Vec<(&str, Box<dyn Fn(&Call) -> bool>)> = vec![
            ("ML all picks", Box::new(|_| true)),
            ("ML longs only", Box::new(|c| c.side == Side::Buy)),
            ("ML shorts only", Box::new(|c| c.side == Side::Sell)),
            ("ML confidence >= 0.85", Box::new(|c| c.probability >= 0.85)),
        ];
        for (name, keep) in &variants {
            let paths = build_ml(&**keep, &fwd);
            let r = simulate_account(&paths, &acct, from, end, false);
            let luck = luck_test(&paths, &acct, from, end, 20, 0.8);
            let worst = start_dates(&paths, &acct, from, end, 8).iter().map(|s| s.return_pct).fold(f64::INFINITY, f64::min);
            let st = simulate_account(&build_ml(&**keep, &fwd_stress), &stressed_acct, from, end, false);
            line(name, paths.len(), &r, Some((luck.median_return_pct, luck.p10_return_pct)), Some(worst), st.return_pct);
        }
        // yardstick: equal-weight buy and hold of the same coins
        let mut rets = Vec::new();
        for c in all.values() {
            let s = c.iter().find(|x| x.open_time >= from).map(|x| x.open);
            let e = c.last().map(|x| x.close);
            if let (Some(s), Some(e)) = (s, e) {
                rets.push(e / s - 1.0);
            }
        }
        println!("  {:<34} {:+.1}%", "equal-weight buy & hold (1x)", rets.iter().sum::<f64>() / rets.len() as f64 * 100.0);
    }
}
