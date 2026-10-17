//! Tracking of cracked bases: after the scanner sees a QFL base crack, follow the price until it is back at the base (or the tracking runs out) and
//! say how far below the base it is, how deep it went, and how much of that fall it has won back.
//!
//! recovery % = (price - lowest) / (base - lowest) x 100: 0 at the low, 100 when the price is back at the base.

use crate::candle::Candle;
use serde::{Deserialize, Serialize};

/// The recovery levels (percent) that make a "progress" report; the last is "back at the base".
pub const LEVELS: [u8; 3] = [50, 80, 100];

/// A crack that fell less than this far below the base does not report progress (noise around the base is not a story).
pub const MIN_DEPTH_FOR_REPORT_PCT: f64 = 1.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CrackStatus {
    /// below the base, still being followed
    Active,
    /// back at the base
    Recovered,
    /// not back after the tracking time
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackedCrack {
    pub id: String,
    pub symbol: String,
    pub timeframe: String,
    pub base: f64,
    pub crack_level: f64,
    /// the open time of the candle that cracked the base, epoch ms
    pub cracked_at: u64,
    /// the lowest price since the crack, and when
    pub low: f64,
    pub low_at: u64,
    pub price: f64,
    pub updated_at: u64,
    pub status: CrackStatus,
    pub ended_at: Option<u64>,
    pub score: u8,
    /// the highest recovery level already reported (0 = none)
    #[serde(default)]
    pub reported: u8,
}

/// A tracked crack with the numbers worked out, as the app shows it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CrackView {
    #[serde(flatten)]
    pub crack: TrackedCrack,
    /// where the price is relative to the base, in % (negative = below)
    pub below_base_pct: f64,
    /// the deepest point relative to the base, in % (negative = below)
    pub depth_pct: f64,
    /// how much of the fall has been won back, 0..100
    pub recovery_pct: f64,
}

impl TrackedCrack {
    pub fn below_base_pct(&self) -> f64 {
        if self.base > 0.0 {
            (self.price / self.base - 1.0) * 100.0
        } else {
            0.0
        }
    }

    pub fn depth_pct(&self) -> f64 {
        if self.base > 0.0 {
            (self.low / self.base - 1.0) * 100.0
        } else {
            0.0
        }
    }

    pub fn recovery_pct(&self) -> f64 {
        if self.status == CrackStatus::Recovered || self.price >= self.base {
            return 100.0;
        }
        if self.base <= self.low {
            return 100.0;
        }
        ((self.price - self.low) / (self.base - self.low) * 100.0).clamp(0.0, 100.0)
    }

    pub fn view(&self) -> CrackView {
        CrackView { crack: self.clone(), below_base_pct: self.below_base_pct(), depth_pct: self.depth_pct(), recovery_pct: self.recovery_pct() }
    }
}

/// Something worth telling the trader.
#[derive(Debug, Clone, PartialEq)]
pub struct Progress {
    pub id: String,
    pub symbol: String,
    /// one of `LEVELS`
    pub level: u8,
    pub recovery_pct: f64,
    pub depth_pct: f64,
}

#[derive(Debug, Clone)]
pub struct CrackTracker {
    items: Vec<TrackedCrack>,
    /// an active crack that is not back after this long expires
    pub max_age_ms: u64,
    /// a recovered or expired crack stays in the list this long
    pub keep_done_ms: u64,
}

impl Default for CrackTracker {
    fn default() -> Self {
        CrackTracker { items: Vec::new(), max_age_ms: 7 * 86_400_000, keep_done_ms: 24 * 3_600_000 }
    }
}

impl CrackTracker {
    pub fn from_items(items: Vec<TrackedCrack>) -> CrackTracker {
        CrackTracker { items, ..Default::default() }
    }

    pub fn items(&self) -> &[TrackedCrack] {
        &self.items
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// The numbers of every tracked crack: active ones first (the closest to the base first), then the finished ones, newest first.
    pub fn views(&self) -> Vec<CrackView> {
        let mut v: Vec<CrackView> = self.items.iter().map(|c| c.view()).collect();
        v.sort_by(|a, b| {
            let rank = |c: &CrackView| if c.crack.status == CrackStatus::Active { 0 } else { 1 };
            rank(a).cmp(&rank(b)).then_with(|| {
                if rank(a) == 0 {
                    b.recovery_pct.partial_cmp(&a.recovery_pct).unwrap_or(std::cmp::Ordering::Equal)
                } else {
                    b.crack.ended_at.cmp(&a.crack.ended_at)
                }
            })
        });
        v
    }

    /// Start following a crack (a crack already followed is left alone). Returns true when it is new.
    #[allow(clippy::too_many_arguments)]
    pub fn track(&mut self, id: &str, symbol: &str, timeframe: &str, base: f64, crack_level: f64, cracked_at: u64, price: f64, score: u8, now: u64) -> bool {
        if base <= 0.0 || self.items.iter().any(|c| c.id == id) {
            return false;
        }
        self.items.push(TrackedCrack { id: id.to_string(), symbol: symbol.to_string(), timeframe: timeframe.to_string(), base, crack_level, cracked_at, low: price.min(crack_level), low_at: cracked_at, price, updated_at: now, status: CrackStatus::Active, ended_at: None, score, reported: 0 });
        true
    }

    /// Feed the candles of a symbol (oldest first): the lowest price since each of its active cracks, the latest price, and whether it is back at the base.
    /// Returns the progress reports this update caused.
    pub fn update(&mut self, symbol: &str, timeframe: &str, candles: &[Candle], now: u64) -> Vec<Progress> {
        let mut out = Vec::new();
        let Some(last) = candles.last() else { return out };
        for c in self.items.iter_mut().filter(|c| c.status == CrackStatus::Active && c.symbol == symbol && c.timeframe == timeframe) {
            for k in candles.iter().filter(|k| k.open_time >= c.cracked_at) {
                if k.low < c.low {
                    c.low = k.low;
                    c.low_at = k.open_time;
                }
            }
            c.price = last.close;
            c.updated_at = now;
            if c.price >= c.base {
                c.status = CrackStatus::Recovered;
                c.ended_at = Some(now);
            }
            if c.depth_pct() > -MIN_DEPTH_FOR_REPORT_PCT {
                continue;
            }
            let rec = c.recovery_pct();
            for level in LEVELS {
                if level > c.reported && (rec >= level as f64 || (level == 100 && c.status == CrackStatus::Recovered)) {
                    c.reported = level;
                    out.push(Progress { id: c.id.clone(), symbol: c.symbol.clone(), level, recovery_pct: rec, depth_pct: c.depth_pct() });
                }
            }
        }
        out
    }

    /// Expire what ran out of time and drop what has been finished for long enough. Returns true when the list changed.
    pub fn housekeeping(&mut self, now: u64) -> bool {
        let before = self.items.len();
        let mut changed = false;
        for c in self.items.iter_mut().filter(|c| c.status == CrackStatus::Active) {
            if now.saturating_sub(c.cracked_at) > self.max_age_ms {
                c.status = CrackStatus::Expired;
                c.ended_at = Some(now);
                changed = true;
            }
        }
        let keep = self.keep_done_ms;
        self.items.retain(|c| c.status == CrackStatus::Active || c.ended_at.map_or(false, |e| now.saturating_sub(e) <= keep));
        changed || self.items.len() != before
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k(t: u64, low: f64, close: f64) -> Candle {
        Candle::new(t, close, close.max(low), low, close, 10.0)
    }

    fn tracker_with(base: f64, price: f64) -> CrackTracker {
        let mut t = CrackTracker::default();
        assert!(t.track("X:15m:crack:1000", "XUSDT", "15m", base, base * 0.995, 1000, price, 60, 1000));
        t
    }

    #[test]
    fn a_crack_is_followed_once_and_numbers_come_from_the_lowest_price() {
        let mut t = tracker_with(100.0, 98.0);
        assert!(!t.track("X:15m:crack:1000", "XUSDT", "15m", 100.0, 99.5, 1000, 98.0, 60, 1000)); // the same crack again
        // falls to 90, comes back to 95: 5% below base, 10% deep, half the way back
        t.update("XUSDT", "15m", &[k(1000, 98.0, 98.0), k(2000, 90.0, 92.0), k(3000, 92.0, 95.0)], 5000);
        let v = &t.views()[0];
        assert_eq!(v.crack.low, 90.0);
        assert!((v.below_base_pct + 5.0).abs() < 1e-9);
        assert!((v.depth_pct + 10.0).abs() < 1e-9);
        assert!((v.recovery_pct - 50.0).abs() < 1e-9);
    }

    #[test]
    fn the_low_only_ever_goes_down_and_recovery_never_leaves_0_to_100() {
        let mut t = tracker_with(100.0, 98.0);
        t.update("XUSDT", "15m", &[k(2000, 90.0, 91.0)], 5000);
        t.update("XUSDT", "15m", &[k(3000, 95.0, 96.0)], 6000); // the 90 candle is no longer in the buffer: the low stays
        assert_eq!(t.items()[0].low, 90.0);
        t.update("XUSDT", "15m", &[k(4000, 80.0, 85.0)], 7000);
        assert_eq!(t.items()[0].low, 80.0);
        assert!(t.items()[0].recovery_pct() >= 0.0 && t.items()[0].recovery_pct() <= 100.0);
    }

    #[test]
    fn reaching_the_base_ends_the_tracking_and_reports_each_level_once() {
        let mut t = tracker_with(100.0, 98.0);
        let mut told = Vec::new();
        for (i, close) in [92.0, 95.0, 96.0, 99.0, 99.5, 100.2].into_iter().enumerate() {
            let low = if i == 0 { 90.0 } else { 90.0 };
            for p in t.update("XUSDT", "15m", &[k(1000, 90.0, 91.0), k(2000 + i as u64, low, close)], 5000 + i as u64) {
                told.push(p.level);
            }
        }
        assert_eq!(told, vec![50, 80, 100]);
        assert_eq!(t.items()[0].status, CrackStatus::Recovered);
        assert!(t.items()[0].ended_at.is_some());
        // a finished crack is not updated any more
        let before = t.items()[0].clone();
        t.update("XUSDT", "15m", &[k(9000, 50.0, 60.0)], 9000);
        assert_eq!(t.items()[0], before);
    }

    #[test]
    fn small_dips_report_no_progress() {
        let mut t = tracker_with(100.0, 99.4);
        // 0.7% deep: below the 1% needed for a report
        let p = t.update("XUSDT", "15m", &[k(1000, 99.3, 99.9)], 5000);
        assert!(p.is_empty());
        assert!(t.items()[0].reported == 0);
    }

    #[test]
    fn other_symbols_and_timeframes_are_left_alone() {
        let mut t = tracker_with(100.0, 98.0);
        t.update("YUSDT", "15m", &[k(2000, 50.0, 60.0)], 5000);
        t.update("XUSDT", "1h", &[k(2000, 50.0, 60.0)], 5000);
        assert_eq!(t.items()[0].price, 98.0);
    }

    #[test]
    fn old_cracks_expire_and_finished_ones_leave_after_a_day() {
        let mut t = tracker_with(100.0, 98.0);
        let week = 7 * 86_400_000u64;
        assert!(!t.housekeeping(1000 + week - 1));
        assert!(t.housekeeping(1000 + week + 1));
        assert_eq!(t.items()[0].status, CrackStatus::Expired);
        assert!(t.housekeeping(1000 + week + 1 + 24 * 3_600_000 + 1));
        assert!(t.is_empty());
    }

    #[test]
    fn views_list_active_cracks_closest_to_the_base_first() {
        let mut t = CrackTracker::default();
        t.track("a", "AUSDT", "15m", 100.0, 99.5, 1000, 90.0, 50, 1000);
        t.track("b", "BUSDT", "15m", 100.0, 99.5, 1000, 90.0, 50, 1000);
        t.update("AUSDT", "15m", &[k(1000, 85.0, 86.0)], 2000);
        t.update("BUSDT", "15m", &[k(1000, 85.0, 97.0)], 2000);
        let ids: Vec<_> = t.views().into_iter().map(|v| v.crack.id).collect();
        assert_eq!(ids, vec!["b", "a"]);
    }
}
