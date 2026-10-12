//! Sudden pump / dump detection from a stream of last prices (one tick per symbol per second is plenty).
//!
//! A move is reported when, over one of the configured windows (1 minute, 5 minutes, 15 minutes by default), the price changed by at least
//! the window's minimum percent AND by at least `normal_multiple` times what that coin normally moves in such a window. The second
//! condition is what keeps a jumpy micro-cap from firing all day while a calm major that moves 1.5% in a minute does stand out. "Normal"
//! is measured from the coin's own last quarter hour: the (median-based, so bursts do not count) typical 10-second return, scaled to the
//! window with the square root of time (the move of a random walk). A move needs enough liquidity too (24 h quote volume) and a symbol that has just
//! fired stays quiet for a cooldown, one report per direction, taken from the window where it stands out most.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WindowRule {
    /// length of the window in seconds
    pub secs: u64,
    /// the smallest move, in percent, that counts in this window
    pub min_pct: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MoverParams {
    pub rules: Vec<WindowRule>,
    /// a move must be this many times the coin's normal move for the window
    pub normal_multiple: f64,
    /// ignore coins with less 24 h quote volume (USDT) than this
    pub min_quote_volume: f64,
    /// a symbol that has fired stays quiet in the same direction for this long
    pub cooldown_secs: u64,
    /// no reports until a symbol has been watched this long (its normal move is not known before)
    pub warmup_secs: u64,
}

impl Default for MoverParams {
    fn default() -> Self {
        MoverParams {
            rules: vec![WindowRule { secs: 60, min_pct: 1.5 }, WindowRule { secs: 300, min_pct: 3.0 }, WindowRule { secs: 900, min_pct: 5.0 }],
            normal_multiple: 5.0,
            min_quote_volume: 3_000_000.0,
            cooldown_secs: 600,
            warmup_secs: 180,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spike {
    pub symbol: String,
    pub time_ms: u64,
    pub window_secs: u64,
    /// signed: positive = a pump, negative = a dump
    pub change_pct: f64,
    pub from_price: f64,
    pub price: f64,
    /// the move divided by the coin's normal move for this window
    pub multiple: f64,
    pub quote_volume: f64,
}

impl Spike {
    pub fn is_pump(&self) -> bool {
        self.change_pct > 0.0
    }
}

#[derive(Default)]
struct Book {
    /// (time ms, price), oldest first, at least `SAMPLE_GAP_MS` apart
    samples: VecDeque<(u64, f64)>,
    first_seen: u64,
    last_fire_up: u64,
    last_fire_down: u64,
}

const SAMPLE_GAP_MS: u64 = 1000;
const GRID_SECS: u64 = 10;
/// fewer 10-second returns than this and the coin's normal move is not known yet
const MIN_RETURNS: usize = 12;

pub struct MoverDetector {
    params: MoverParams,
    books: HashMap<String, Book>,
}

fn price_at(samples: &VecDeque<(u64, f64)>, t: u64) -> Option<f64> {
    let i = samples.partition_point(|s| s.0 <= t);
    if i == 0 {
        None
    } else {
        Some(samples[i - 1].1)
    }
}

/// A robust measure of the typical 10-second return of the samples up to `until`, over at most `max_secs` before it: 1.4826 x the median
/// absolute return (the median ignores the burst we are trying to detect, so a pump does not make the next move look normal); None when
/// there is too little history.
fn typical_return(samples: &VecDeque<(u64, f64)>, until: u64, max_secs: u64) -> Option<f64> {
    let oldest = samples.front()?.0;
    let mut t = until;
    let mut prev = price_at(samples, t)?;
    let mut returns: Vec<f64> = Vec::new();
    while t >= oldest + GRID_SECS * 1000 && (until - t) / 1000 < max_secs {
        t -= GRID_SECS * 1000;
        let Some(p) = price_at(samples, t) else { break };
        if p > 0.0 && prev > 0.0 {
            returns.push((prev / p).ln().abs());
        }
        prev = p;
    }
    if returns.len() < MIN_RETURNS {
        return None;
    }
    returns.sort_by(|a, b| a.partial_cmp(b).unwrap());
    Some(1.4826 * returns[returns.len() / 2])
}

impl MoverDetector {
    pub fn new(params: MoverParams) -> MoverDetector {
        MoverDetector { params, books: HashMap::new() }
    }

    pub fn params(&self) -> &MoverParams {
        &self.params
    }

    pub fn set_params(&mut self, params: MoverParams) {
        self.params = params;
    }

    /// How many symbols are being watched, and how many of them have been for long enough to report.
    pub fn watching(&self, now_ms: u64) -> (usize, usize) {
        let ready = self.books.values().filter(|b| now_ms.saturating_sub(b.first_seen) >= self.params.warmup_secs * 1000).count();
        (self.books.len(), ready)
    }

    /// Feed one price. Returns the spike this tick caused, if any (at most one per call).
    pub fn push(&mut self, symbol: &str, t_ms: u64, price: f64, quote_volume: f64) -> Option<Spike> {
        if !(price > 0.0) {
            return None;
        }
        let history_ms = self.params.rules.iter().map(|r| r.secs).max().unwrap_or(900) * 1000 + 90_000;
        let book = self.books.entry(symbol.to_string()).or_insert_with(|| Book { first_seen: t_ms, ..Default::default() });
        if book.samples.back().map_or(true, |s| t_ms >= s.0 + SAMPLE_GAP_MS) {
            book.samples.push_back((t_ms, price));
        } else if let Some(last) = book.samples.back_mut() {
            last.1 = price; // a tick inside the same second just refreshes it
        }
        while book.samples.front().map_or(false, |s| s.0 + history_ms < t_ms) {
            book.samples.pop_front();
        }
        if quote_volume < self.params.min_quote_volume || t_ms.saturating_sub(book.first_seen) < self.params.warmup_secs * 1000 {
            return None;
        }
        let mut best: Option<Spike> = None;
        for rule in &self.params.rules {
            let start = t_ms.saturating_sub(rule.secs * 1000);
            // the history must reach back over the whole window (a few seconds of slack for a quiet coin)
            if book.samples.front().map_or(true, |s| s.0 > start + 5000) {
                continue;
            }
            let Some(from) = price_at(&book.samples, start) else { continue };
            let change = (price / from - 1.0) * 100.0;
            if change.abs() < rule.min_pct {
                continue;
            }
            let up = change > 0.0;
            let last_fire = if up { book.last_fire_up } else { book.last_fire_down };
            if last_fire > 0 && t_ms.saturating_sub(last_fire) < self.params.cooldown_secs * 1000 {
                continue;
            }
            // normal move: from the quarter hour BEFORE the window when there is enough of it, else from everything there is
            let sigma = typical_return(&book.samples, start, 900).or_else(|| typical_return(&book.samples, t_ms, 900));
            let Some(sigma) = sigma else { continue };
            let normal = (sigma * ((rule.secs as f64) / GRID_SECS as f64).sqrt() * 100.0).max(0.02);
            let multiple = change.abs() / normal;
            if multiple < self.params.normal_multiple {
                continue;
            }
            let spike = Spike { symbol: symbol.to_string(), time_ms: t_ms, window_secs: rule.secs, change_pct: change, from_price: from, price, multiple, quote_volume };
            if best.as_ref().map_or(true, |b| spike.multiple > b.multiple) {
                best = Some(spike);
            }
        }
        if let Some(s) = &best {
            if s.is_pump() {
                book.last_fire_up = t_ms;
            } else {
                book.last_fire_down = t_ms;
            }
        }
        best
    }
}

/// "1m", "5m", "15m", "90s" for a window length.
pub fn window_label(secs: u64) -> String {
    if secs % 60 == 0 {
        format!("{}m", secs / 60)
    } else {
        format!("{secs}s")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A calm coin around 100 for `secs` seconds (price wobbles +-0.02%), one tick a second, starting at t0.
    fn calm(d: &mut MoverDetector, sym: &str, t0: u64, secs: u64, vol: f64) -> u64 {
        let mut t = t0;
        for i in 0..secs {
            let wobble = if i % 2 == 0 { 0.02 } else { -0.02 };
            d.push(sym, t, 100.0 * (1.0 + wobble / 100.0), vol);
            t += 1000;
        }
        t
    }

    #[test]
    fn a_sudden_rise_in_a_calm_coin_is_a_pump_in_the_window_where_it_stands_out() {
        let mut d = MoverDetector::new(MoverParams::default());
        let mut t = calm(&mut d, "AAAUSDT", 1_000_000, 600, 50e6);
        // +3% in about ten seconds
        let mut found = None;
        for k in 1..=10u64 {
            t += 1000;
            if let Some(s) = d.push("AAAUSDT", t, 100.0 * (1.0 + 0.003 * k as f64), 50e6) {
                found = Some(s);
            }
        }
        let s = found.expect("a pump");
        assert!(s.is_pump() && s.change_pct >= 1.5 && s.multiple >= 5.0, "{s:?}");
        assert_eq!(s.symbol, "AAAUSDT");
        assert!(s.price > s.from_price);
    }

    #[test]
    fn a_sudden_fall_is_a_dump() {
        let mut d = MoverDetector::new(MoverParams::default());
        let mut t = calm(&mut d, "BBBUSDT", 0, 600, 50e6);
        let mut found = None;
        for k in 1..=10u64 {
            t += 1000;
            if let Some(s) = d.push("BBBUSDT", t, 100.0 * (1.0 - 0.003 * k as f64), 50e6) {
                found = Some(s);
            }
        }
        let s = found.expect("a dump");
        assert!(!s.is_pump() && s.change_pct <= -1.5);
    }

    #[test]
    fn a_coin_that_always_jumps_that_much_does_not_stand_out() {
        // a wild coin: +-1% every second. A 3% move over ten seconds is within what it does all the time
        let mut d = MoverDetector::new(MoverParams::default());
        let mut t = 0u64;
        let mut price = 100.0;
        let mut fired = 0;
        for i in 0..900u64 {
            price *= if i % 2 == 0 { 1.01 } else { 1.0 / 1.01 };
            t += 1000;
            if d.push("WILDUSDT", t, price, 50e6).is_some() {
                fired += 1;
            }
        }
        assert_eq!(fired, 0);
    }

    #[test]
    fn nothing_is_reported_while_warming_up_or_for_an_illiquid_coin() {
        let mut d = MoverDetector::new(MoverParams::default());
        // a jump after only 60 seconds of watching: the coin's normal move is unknown
        let t = calm(&mut d, "NEWUSDT", 0, 60, 50e6);
        assert!(d.push("NEWUSDT", t + 1000, 110.0, 50e6).is_none());
        // plenty of history, but thin volume
        let mut d2 = MoverDetector::new(MoverParams::default());
        let t2 = calm(&mut d2, "THINUSDT", 0, 600, 100_000.0);
        assert!(d2.push("THINUSDT", t2 + 1000, 110.0, 100_000.0).is_none());
    }

    #[test]
    fn a_symbol_stays_quiet_after_firing_but_the_other_direction_is_independent() {
        let mut d = MoverDetector::new(MoverParams::default());
        let mut t = calm(&mut d, "CCCUSDT", 0, 600, 50e6);
        let mut pumps = 0;
        let mut p = 100.0;
        for _ in 0..40 {
            t += 1000;
            p *= 1.002;
            if d.push("CCCUSDT", t, p, 50e6).map_or(false, |s| s.is_pump()) {
                pumps += 1;
            }
        }
        assert_eq!(pumps, 1, "one report for the whole run, not one per tick");
        // a crash right after, deep enough to end below where the price was a minute ago, is a different direction
        let mut dumped = false;
        for k in 1..=15u64 {
            t += 1000;
            if d.push("CCCUSDT", t, p * (1.0 - 0.01 * k as f64), 50e6).map_or(false, |s| !s.is_pump()) {
                dumped = true;
            }
        }
        assert!(dumped);
    }

    #[test]
    fn symbols_do_not_mix_and_the_watch_counts_are_right() {
        let mut d = MoverDetector::new(MoverParams::default());
        calm(&mut d, "AUSDT", 0, 200, 50e6);
        calm(&mut d, "BUSDT", 150_000, 100, 50e6);
        let (n, ready) = d.watching(250_000);
        assert_eq!(n, 2);
        assert_eq!(ready, 1, "only A has been watched for 180 s");
    }

    #[test]
    fn window_labels() {
        assert_eq!(window_label(60), "1m");
        assert_eq!(window_label(900), "15m");
        assert_eq!(window_label(90), "90s");
    }
}
