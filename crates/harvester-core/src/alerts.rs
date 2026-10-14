//! What the Telegram bot watches for: stop-loss / take-profit levels typed as a price or a percentage, and the events found by comparing one
//! look at the account with the next (a position opened, grew, closed, or came close to its liquidation price). Pure logic with tests.

use crate::report::{money, price, signed, PositionRow};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitKind {
    Stop,
    Take,
}

/// A level as typed: `95.5` is a price, `2%` is a distance from the current price on the right side for the kind of exit.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Level {
    Price(f64),
    Pct(f64),
}

pub fn parse_level(s: &str) -> Option<Level> {
    let s = s.trim();
    let (num, pct) = match s.strip_suffix('%') {
        Some(n) => (n, true),
        None => (s, false),
    };
    let v: f64 = num.parse().ok()?;
    if !v.is_finite() || v <= 0.0 {
        return None;
    }
    Some(if pct { Level::Pct(v) } else { Level::Price(v) })
}

/// The price of a stop-loss / take-profit, refused when it is on the wrong side of the current price (a stop that would fire at once).
pub fn resolve_exit(kind: ExitKind, long: bool, mark: f64, level: Level) -> Result<f64, String> {
    // is the level on the profit side of the price?
    let above = (kind == ExitKind::Take) == long;
    let name = if kind == ExitKind::Stop { "stop-loss" } else { "take-profit" };
    let side = if above { "above" } else { "below" };
    let target = match level {
        Level::Pct(p) => {
            if p >= 100.0 {
                return Err("A percentage must be below 100.".into());
            }
            if above { mark * (1.0 + p / 100.0) } else { mark * (1.0 - p / 100.0) }
        }
        Level::Price(x) => x,
    };
    if mark <= 0.0 {
        return Err("There is no current price to check the level against.".into());
    }
    if (above && target <= mark) || (!above && target >= mark) {
        return Err(format!("A {name} for a {} must be {side} the current price ({}).", if long { "long" } else { "short" }, price(mark)));
    }
    Ok(target)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseKind {
    StopLoss,
    TakeProfit,
    Other,
}

/// How a position that has disappeared probably ended, judged from the last price seen against its stop and target.
pub fn classify_close(last: &PositionRow) -> CloseKind {
    let long = last.amount > 0.0;
    let near = |level: f64, from_above: bool| if from_above { last.mark <= level * 1.01 } else { last.mark >= level * 0.99 };
    if let Some(s) = last.stop {
        if (long && near(s, true)) || (!long && near(s, false)) {
            return CloseKind::StopLoss;
        }
    }
    if let Some(t) = last.take {
        if (long && near(t, false)) || (!long && near(t, true)) {
            return CloseKind::TakeProfit;
        }
    }
    CloseKind::Other
}

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Opened(PositionRow),
    Closed { pos: PositionRow, kind: CloseKind },
    Resized { symbol: String, from: f64, to: f64 },
    LiquidationNear { pos: PositionRow, distance_pct: f64 },
}

/// Distance from the price to the liquidation price, in percent of the price (None without a liquidation price).
pub fn liquidation_distance_pct(p: &PositionRow) -> Option<f64> {
    if p.liquidation <= 0.0 || p.mark <= 0.0 {
        return None;
    }
    Some(if p.amount > 0.0 { (p.mark - p.liquidation) / p.mark * 100.0 } else { (p.liquidation - p.mark) / p.mark * 100.0 })
}

const WARN_BELOW_PCT: f64 = 10.0;
const CLEAR_ABOVE_PCT: f64 = 15.0;

/// Remembers the last look at the account. The first look only seeds it: nothing that was already open is announced.
#[derive(Default)]
pub struct AlertState {
    prev: Option<HashMap<String, PositionRow>>,
    warned: HashSet<String>,
}

impl AlertState {
    pub fn update(&mut self, now: &[PositionRow]) -> Vec<Event> {
        let current: HashMap<String, PositionRow> = now.iter().filter(|p| p.amount != 0.0).map(|p| (p.symbol.clone(), p.clone())).collect();
        let mut events = Vec::new();
        if let Some(prev) = &self.prev {
            for (sym, old) in prev {
                match current.get(sym) {
                    None => {
                        events.push(Event::Closed { pos: old.clone(), kind: classify_close(old) });
                        self.warned.remove(sym);
                    }
                    Some(new) if (old.amount > 0.0) != (new.amount > 0.0) => {
                        events.push(Event::Closed { pos: old.clone(), kind: classify_close(old) });
                        events.push(Event::Opened(new.clone()));
                    }
                    Some(new) if (new.amount.abs() - old.amount.abs()).abs() > old.amount.abs() * 0.01 => {
                        events.push(Event::Resized { symbol: sym.clone(), from: old.amount.abs(), to: new.amount.abs() });
                    }
                    _ => {}
                }
            }
            for (sym, new) in &current {
                if !prev.contains_key(sym) {
                    events.push(Event::Opened(new.clone()));
                }
            }
        }
        // also on the first look: a position that is already close to its liquidation price is worth a warning at once
        for (sym, p) in &current {
            if let Some(d) = liquidation_distance_pct(p) {
                if d < WARN_BELOW_PCT && self.warned.insert(sym.clone()) {
                    events.push(Event::LiquidationNear { pos: p.clone(), distance_pct: d });
                } else if d > CLEAR_ABOVE_PCT {
                    self.warned.remove(sym);
                }
            }
        }
        self.prev = Some(current);
        // a stable order: the oldest news first matters less than not shuffling between runs
        events.sort_by_key(|e| match e {
            Event::LiquidationNear { .. } => 0,
            Event::Closed { .. } => 1,
            Event::Opened(_) => 2,
            Event::Resized { .. } => 3,
        });
        events
    }
}

fn coin(s: &str) -> String {
    crate::report::esc(s.strip_suffix("USDT").unwrap_or(s))
}

pub fn format_event(e: &Event) -> String {
    match e {
        Event::Opened(p) => format!("<b>Opened {}</b> {} {} at {} ({}x)", coin(&p.symbol), if p.amount > 0.0 { "LONG" } else { "SHORT" }, p.amount.abs(), price(p.entry), p.leverage),
        Event::Resized { symbol, from, to } => format!("<b>{}</b> position {} {} -> {}", coin(symbol), if to > from { "grew" } else { "shrank" }, from, to),
        Event::Closed { pos, kind } => {
            let what = match kind {
                CloseKind::StopLoss => "stop-loss hit (probably)",
                CloseKind::TakeProfit => "take-profit hit (probably)",
                CloseKind::Other => "closed",
            };
            format!("<b>{} {}</b> {}. Last seen: {} ({:+.1}% on margin), price {}", coin(&pos.symbol), if pos.amount > 0.0 { "LONG" } else { "SHORT" }, what, signed(pos.upnl), pos.roe_pct(), price(pos.mark))
        }
        Event::LiquidationNear { pos, distance_pct } => format!(
            "🚨 <b>{} close to liquidation</b>: price {} is only {:.1}% from {} ({} {}x). Unrealised {}",
            coin(&pos.symbol), price(pos.mark), distance_pct, price(pos.liquidation), if pos.amount > 0.0 { "long" } else { "short" }, pos.leverage, money(pos.upnl)
        ),
    }
}

/// `2026-10-14` from epoch milliseconds (UTC), for the delisting notice.
pub fn ymd(ms: u64) -> String {
    let z = (ms / 86_400_000) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let (y, doy) = (yoe + era * 400, doe - (365 * yoe + yoe / 4 - yoe / 100));
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{:02}-{:02}", if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pos(symbol: &str, amount: f64, mark: f64, liq: f64, stop: Option<f64>, take: Option<f64>) -> PositionRow {
        PositionRow { symbol: symbol.into(), amount, entry: 100.0, mark, upnl: (mark - 100.0) * amount, leverage: 10.0, isolated: true, liquidation: liq, stop, take }
    }

    #[test]
    fn levels_are_prices_or_percentages() {
        assert_eq!(parse_level("95.5"), Some(Level::Price(95.5)));
        assert_eq!(parse_level("2%"), Some(Level::Pct(2.0)));
        for bad in ["", "abc", "-1", "0", "%", "nan", "inf"] {
            assert_eq!(parse_level(bad), None, "{bad}");
        }
    }

    #[test]
    fn an_exit_on_the_wrong_side_is_refused() {
        // long at 100: the stop is below, the target above
        assert_eq!(resolve_exit(ExitKind::Stop, true, 100.0, Level::Price(95.0)), Ok(95.0));
        assert!(resolve_exit(ExitKind::Stop, true, 100.0, Level::Price(105.0)).unwrap_err().contains("below"));
        assert_eq!(resolve_exit(ExitKind::Take, true, 100.0, Level::Price(110.0)), Ok(110.0));
        assert!(resolve_exit(ExitKind::Take, true, 100.0, Level::Price(99.0)).unwrap_err().contains("above"));
        // short: mirrored
        assert_eq!(resolve_exit(ExitKind::Stop, false, 100.0, Level::Price(105.0)), Ok(105.0));
        assert!(resolve_exit(ExitKind::Stop, false, 100.0, Level::Price(95.0)).is_err());
        assert_eq!(resolve_exit(ExitKind::Take, false, 100.0, Level::Price(90.0)), Ok(90.0));
        // percentages go to the right side by themselves
        assert!((resolve_exit(ExitKind::Stop, true, 100.0, Level::Pct(2.0)).unwrap() - 98.0).abs() < 1e-9);
        assert!((resolve_exit(ExitKind::Take, true, 100.0, Level::Pct(5.0)).unwrap() - 105.0).abs() < 1e-9);
        assert!((resolve_exit(ExitKind::Stop, false, 100.0, Level::Pct(2.0)).unwrap() - 102.0).abs() < 1e-9);
        assert!(resolve_exit(ExitKind::Stop, true, 100.0, Level::Pct(100.0)).is_err());
        assert!(resolve_exit(ExitKind::Stop, true, 0.0, Level::Price(1.0)).is_err());
    }

    #[test]
    fn the_first_look_announces_nothing() {
        let mut s = AlertState::default();
        assert!(s.update(&[pos("ETHUSDT", 1.0, 100.0, 50.0, None, None)]).is_empty());
        assert!(s.update(&[pos("ETHUSDT", 1.0, 101.0, 50.0, None, None)]).is_empty(), "nothing changed");
    }

    #[test]
    fn a_position_already_near_liquidation_is_warned_about_at_the_first_look() {
        let mut s = AlertState::default();
        let ev = s.update(&[pos("ETHUSDT", 1.0, 100.0, 95.0, None, None)]);
        assert!(matches!(ev.as_slice(), [Event::LiquidationNear { .. }]), "{ev:?}");
    }

    #[test]
    fn opened_resized_and_closed_are_found() {
        let mut s = AlertState::default();
        s.update(&[pos("ETHUSDT", 1.0, 100.0, 0.0, None, None)]);
        let ev = s.update(&[pos("ETHUSDT", 2.0, 100.0, 0.0, None, None), pos("SOLUSDT", -3.0, 50.0, 0.0, None, None)]);
        assert!(ev.iter().any(|e| matches!(e, Event::Resized { symbol, from, to } if symbol == "ETHUSDT" && *from == 1.0 && *to == 2.0)), "{ev:?}");
        assert!(ev.iter().any(|e| matches!(e, Event::Opened(p) if p.symbol == "SOLUSDT")), "{ev:?}");
        let ev = s.update(&[pos("SOLUSDT", -3.0, 50.0, 0.0, None, None)]);
        assert_eq!(ev.len(), 1);
        assert!(matches!(&ev[0], Event::Closed { pos, kind: CloseKind::Other } if pos.symbol == "ETHUSDT"));
    }

    #[test]
    fn a_flip_is_a_close_and_an_open() {
        let mut s = AlertState::default();
        s.update(&[pos("ETHUSDT", 1.0, 100.0, 0.0, None, None)]);
        let ev = s.update(&[pos("ETHUSDT", -1.0, 100.0, 0.0, None, None)]);
        assert!(matches!(ev[0], Event::Closed { .. }) && matches!(ev[1], Event::Opened(_)), "{ev:?}");
    }

    #[test]
    fn a_stop_or_target_hit_is_recognised_from_the_last_price() {
        assert_eq!(classify_close(&pos("A", 1.0, 95.2, 0.0, Some(95.0), Some(110.0))), CloseKind::StopLoss);
        assert_eq!(classify_close(&pos("A", 1.0, 109.5, 0.0, Some(95.0), Some(110.0))), CloseKind::TakeProfit);
        assert_eq!(classify_close(&pos("A", 1.0, 100.0, 0.0, Some(95.0), Some(110.0))), CloseKind::Other);
        assert_eq!(classify_close(&pos("A", -1.0, 104.9, 0.0, Some(105.0), Some(90.0))), CloseKind::StopLoss);
        assert_eq!(classify_close(&pos("A", -1.0, 90.4, 0.0, Some(105.0), Some(90.0))), CloseKind::TakeProfit);
        assert_eq!(classify_close(&pos("A", 1.0, 95.0, 0.0, None, None)), CloseKind::Other);
    }

    #[test]
    fn the_liquidation_warning_comes_once_and_re_arms_after_recovery() {
        let mut s = AlertState::default();
        s.update(&[pos("ETHUSDT", 1.0, 100.0, 80.0, None, None)]); // 20% away
        let ev = s.update(&[pos("ETHUSDT", 1.0, 85.0, 80.0, None, None)]); // 5.9%
        assert!(matches!(&ev[0], Event::LiquidationNear { distance_pct, .. } if *distance_pct < 10.0), "{ev:?}");
        assert!(s.update(&[pos("ETHUSDT", 1.0, 84.0, 80.0, None, None)]).is_empty(), "already warned");
        assert!(s.update(&[pos("ETHUSDT", 1.0, 100.0, 80.0, None, None)]).is_empty(), "recovered, nothing to say");
        let ev = s.update(&[pos("ETHUSDT", 1.0, 85.0, 80.0, None, None)]);
        assert_eq!(ev.len(), 1, "warns again after recovering");
        // a short: liquidation is above
        let mut s = AlertState::default();
        s.update(&[pos("SOLUSDT", -1.0, 100.0, 120.0, None, None)]);
        assert_eq!(s.update(&[pos("SOLUSDT", -1.0, 112.0, 120.0, None, None)]).len(), 1);
    }

    #[test]
    fn events_read_well() {
        let t = format_event(&Event::Closed { pos: pos("ETHUSDT", 1.0, 95.2, 0.0, Some(95.0), None), kind: CloseKind::StopLoss });
        assert!(t.contains("ETH") && t.contains("stop-loss hit (probably)") && t.contains("-$4.80"), "{t}");
        let t = format_event(&Event::LiquidationNear { pos: pos("ETHUSDT", 1.0, 85.0, 80.0, None, None), distance_pct: 5.9 });
        assert!(t.contains("close to liquidation") && t.contains("5.9%"), "{t}");
    }

    #[test]
    fn dates_are_formatted_in_utc() {
        assert_eq!(ymd(0), "1970-01-01");
        assert_eq!(ymd(1_791_993_600_000), "2026-10-14");
        assert_eq!(ymd(951_782_400_000), "2000-02-29");
    }
}
