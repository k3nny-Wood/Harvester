//! The candle type shared by the detector, the scanner and the Binance feed.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candle {
    /// open time, epoch ms
    pub open_time: u64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

impl Candle {
    pub fn new(open_time: u64, open: f64, high: f64, low: f64, close: f64, volume: f64) -> Candle {
        Candle { open_time, open, high, low, close, volume }
    }
}

/// True range of `c` given the previous close.
pub fn true_range(c: &Candle, prev_close: Option<f64>) -> f64 {
    match prev_close {
        None => c.high - c.low,
        Some(pc) => (c.high - c.low).max((c.high - pc).abs()).max((c.low - pc).abs()),
    }
}

/// Average true range over the last `n` candles as a percentage of price (0 when there is not enough data).
pub fn atr_pct(candles: &[Candle], n: usize) -> f64 {
    if candles.len() < n + 1 || n == 0 {
        return 0.0;
    }
    let start = candles.len() - n;
    let sum: f64 = (start..candles.len())
        .map(|i| {
            let c = &candles[i];
            let mid = (c.high + c.low) / 2.0;
            if mid > 0.0 {
                true_range(c, Some(candles[i - 1].close)) / mid
            } else {
                0.0
            }
        })
        .sum();
    sum / n as f64 * 100.0
}
