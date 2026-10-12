//! Ladder builder: N limit orders spread over a price range, sized by a chosen weighting, rounded and
//! validated against the symbol's exchange filters. The chart's "draw a ladder" tool turns two clicks
//! (start price, end price) plus a slider (rung count) into a `LadderSpec` and shows the result of
//! `build_ladder` live as a preview.

use crate::decimal::{from_f64, round_to_step, to_f64};
use crate::filters::{validate_order, OrderCheck, SymbolFilters};
use serde::{Deserialize, Serialize};

pub const MIN_RUNGS: usize = 2;
pub const MAX_RUNGS: usize = 50;
/// Binance accepts at most 5 orders per batch call.
pub const BATCH_CHUNK: usize = 5;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum Side {
    Buy,
    Sell,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Distribution {
    #[default]
    Equal,
    Geometric,
    Custom,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum SizeMode {
    #[default]
    Equal,
    LinearUp,
    LinearDown,
    Exponential,
}

/// How the ladder's total size is expressed.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(tag = "mode", content = "value", rename_all = "camelCase")]
pub enum LadderTotal {
    /// Total base-asset quantity.
    Qty(f64),
    /// Total USDT notional, split by weight; quantity is derived from the average rung price.
    Notional(f64),
    /// Percent of `LadderSpec::balance` used as margin; notional = margin x `leverage`.
    BalancePct(f64),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LadderSpec {
    pub symbol: String,
    pub side: Side,
    pub count: usize,
    pub start_price: f64,
    pub end_price: f64,
    #[serde(default)]
    pub distribution: Distribution,
    #[serde(default)]
    pub custom_prices: Vec<f64>,
    #[serde(default)]
    pub size_mode: SizeMode,
    /// Growth factor for `SizeMode::Exponential` (default 2).
    #[serde(default)]
    pub multiplier: Option<f64>,
    pub total: LadderTotal,
    /// Available balance, needed for `LadderTotal::BalancePct`.
    #[serde(default)]
    pub balance: Option<f64>,
    #[serde(default)]
    pub leverage: Option<f64>,
    #[serde(default)]
    pub reduce_only: bool,
    #[serde(default)]
    pub group_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LadderRung {
    pub index: usize,
    pub price: f64,
    pub quantity: f64,
    pub notional: f64,
    pub valid: bool,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LadderPreview {
    pub rungs: Vec<LadderRung>,
    /// Totals over the valid rungs only.
    pub total_quantity: f64,
    pub total_notional: f64,
    pub average_entry: f64,
}

fn clamp_count(n: usize) -> usize {
    n.clamp(MIN_RUNGS, MAX_RUNGS)
}

fn equal_spacing(start: f64, end: f64, n: usize) -> Vec<f64> {
    let step = (end - start) / (n as f64 - 1.0);
    (0..n).map(|i| start + step * i as f64).collect()
}

/// Price of each rung, before rounding.
pub fn ladder_prices(spec: &LadderSpec) -> Vec<f64> {
    let n = clamp_count(spec.count);
    let (start, end) = (spec.start_price, spec.end_price);
    match spec.distribution {
        Distribution::Custom => {
            let mut custom: Vec<f64> = spec.custom_prices.iter().copied().take(n).collect();
            while custom.len() < n {
                custom.push(end); // pad the tail so the ladder still has n rungs
            }
            custom
        }
        Distribution::Geometric if start > 0.0 && end > 0.0 => {
            let ratio = (end / start).powf(1.0 / (n as f64 - 1.0));
            (0..n).map(|i| start * ratio.powi(i as i32)).collect()
        }
        // equal spacing, and the fallback for geometric on non-positive prices
        _ => equal_spacing(start, end, n),
    }
}

/// Share of the total size each rung gets; always sums to 1.
pub fn size_weights(spec: &LadderSpec) -> Vec<f64> {
    let n = clamp_count(spec.count);
    let raw: Vec<f64> = match spec.size_mode {
        SizeMode::LinearUp => (1..=n).map(|i| i as f64).collect(),
        SizeMode::LinearDown => (1..=n).rev().map(|i| i as f64).collect(),
        SizeMode::Exponential => {
            let m = spec.multiplier.filter(|m| *m > 0.0).unwrap_or(2.0);
            (0..n).map(|i| m.powi(i as i32)).collect()
        }
        SizeMode::Equal => vec![1.0; n],
    };
    let total: f64 = raw.iter().sum();
    raw.into_iter().map(|w| w / total).collect()
}

/// Build the full ladder: rounded prices and quantities, each rung validated against the exchange
/// filters, plus the average entry if every valid rung fills.
pub fn build_ladder(spec: &LadderSpec, filters: &SymbolFilters, reference_price: f64) -> LadderPreview {
    let prices = ladder_prices(spec);
    let weights = size_weights(spec);
    let avg_price = prices.iter().sum::<f64>() / prices.len() as f64;

    let total_quantity = match spec.total {
        LadderTotal::Qty(q) => q,
        LadderTotal::Notional(v) => {
            if avg_price > 0.0 {
                v / avg_price
            } else {
                0.0
            }
        }
        LadderTotal::BalancePct(pct) => {
            let notional = spec.balance.unwrap_or(0.0) * pct / 100.0 * spec.leverage.filter(|l| *l > 0.0).unwrap_or(1.0);
            if avg_price > 0.0 {
                notional / avg_price
            } else {
                0.0
            }
        }
    };

    let (mut sum_qty, mut sum_notional, mut weighted) = (0.0, 0.0, 0.0);
    let mut rungs = Vec::with_capacity(prices.len());
    for (i, raw_price) in prices.iter().enumerate() {
        let price = filters.round_price(*raw_price);
        let quantity = filters.round_quantity(total_quantity * weights[i]);
        let (p, q) = (to_f64(price), to_f64(quantity));
        let notional = p * q;
        let check = OrderCheck { price: Some(price), quantity: Some(quantity), ..Default::default() };
        let v = validate_order(&check, filters, reference_price);
        if v.ok {
            sum_qty += q;
            sum_notional += notional;
            weighted += p * q;
        }
        rungs.push(LadderRung { index: i, price: p, quantity: q, notional, valid: v.ok, errors: v.errors });
    }
    LadderPreview { rungs, total_quantity: sum_qty, total_notional: sum_notional, average_entry: if sum_qty > 0.0 { weighted / sum_qty } else { 0.0 } }
}

/// Split orders into the chunks the batch endpoint accepts.
pub fn chunk_orders<T: Clone>(items: &[T], size: usize) -> Vec<Vec<T>> {
    items.chunks(size.max(1)).map(|c| c.to_vec()).collect()
}

/// Shift the whole ladder by a price delta, snapping to the tick size.
pub fn shift_ladder(spec: &LadderSpec, delta: f64, tick: &SymbolFilters) -> LadderSpec {
    let snap = |p: f64| to_f64(round_to_step(from_f64(p + delta), tick.tick_size));
    LadderSpec { start_price: snap(spec.start_price), end_price: snap(spec.end_price), ..spec.clone() }
}

/// Keep the start price, move the end price.
pub fn stretch_ladder(spec: &LadderSpec, new_end: f64, tick: &SymbolFilters) -> LadderSpec {
    LadderSpec { end_price: to_f64(round_to_step(from_f64(new_end), tick.tick_size)), ..spec.clone() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filters::test_support::eth;

    fn spec() -> LadderSpec {
        LadderSpec {
            symbol: "ETHUSDT".into(),
            side: Side::Buy,
            count: 5,
            start_price: 3000.0,
            end_price: 2900.0,
            distribution: Distribution::Equal,
            custom_prices: vec![],
            size_mode: SizeMode::Equal,
            multiplier: None,
            total: LadderTotal::Qty(10.0),
            balance: None,
            leverage: None,
            reduce_only: false,
            group_id: "g1".into(),
        }
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    #[test]
    fn equal_spacing_between_start_and_end() {
        let p = ladder_prices(&spec());
        assert_eq!(p.len(), 5);
        assert_eq!(p[0], 3000.0);
        assert_eq!(p[4], 2900.0);
        assert!(close(p[1], 2975.0));
    }

    #[test]
    fn geometric_spacing() {
        let p = ladder_prices(&LadderSpec { count: 3, distribution: Distribution::Geometric, start_price: 100.0, end_price: 400.0, ..spec() });
        assert_eq!(p[0], 100.0);
        assert!(close(p[1], 200.0) && close(p[2], 400.0));
    }

    #[test]
    fn custom_prices_are_used_and_padded() {
        let p = ladder_prices(&LadderSpec { count: 3, distribution: Distribution::Custom, custom_prices: vec![10.0, 12.0, 15.0], ..spec() });
        assert_eq!(p, vec![10.0, 12.0, 15.0]);
        let padded = ladder_prices(&LadderSpec { count: 4, distribution: Distribution::Custom, custom_prices: vec![10.0], end_price: 99.0, ..spec() });
        assert_eq!(padded, vec![10.0, 99.0, 99.0, 99.0]);
    }

    #[test]
    fn rung_count_is_clamped() {
        assert_eq!(ladder_prices(&LadderSpec { count: 1000, ..spec() }).len(), MAX_RUNGS);
        assert_eq!(ladder_prices(&LadderSpec { count: 1, ..spec() }).len(), 2);
    }

    #[test]
    fn weights_sum_to_one_for_every_mode() {
        for mode in [SizeMode::Equal, SizeMode::LinearUp, SizeMode::LinearDown, SizeMode::Exponential] {
            let w = size_weights(&LadderSpec { count: 6, size_mode: mode, multiplier: Some(2.0), ..spec() });
            assert!(close(w.iter().sum::<f64>(), 1.0));
        }
    }

    #[test]
    fn exponential_doubles_each_rung_and_linear_up_grows() {
        let w = size_weights(&LadderSpec { count: 4, size_mode: SizeMode::Exponential, multiplier: Some(2.0), ..spec() });
        assert!(close(w[1] / w[0], 2.0) && close(w[3] / w[0], 8.0));
        let l = size_weights(&LadderSpec { count: 4, size_mode: SizeMode::LinearUp, ..spec() });
        assert!(l[0] < l[1] && l[1] < l[2] && l[2] < l[3]);
        let d = size_weights(&LadderSpec { count: 4, size_mode: SizeMode::LinearDown, ..spec() });
        assert!(d[0] > d[3]);
    }

    #[test]
    fn rungs_are_rounded_to_the_exchange_filters() {
        let f = eth();
        let pv = build_ladder(&LadderSpec { count: 4, start_price: 3000.567, end_price: 2999.123, total: LadderTotal::Qty(1.0), ..spec() }, &f, 3000.0);
        let places = |x: f64| format!("{x}").split('.').nth(1).map_or(0, |s| s.len());
        for r in &pv.rungs {
            assert!(places(r.price) <= 2, "price {}", r.price);
            assert!(places(r.quantity) <= 3, "qty {}", r.quantity);
        }
    }

    #[test]
    fn average_entry_of_all_rungs() {
        let f = eth();
        let pv = build_ladder(&LadderSpec { count: 2, start_price: 100.0, end_price: 104.0, total: LadderTotal::Qty(2.0), ..spec() }, &f, 100.0);
        assert!(close(pv.total_quantity, 2.0));
        assert!(close(pv.average_entry, 102.0));
    }

    #[test]
    fn rungs_below_the_minimum_notional_are_flagged() {
        let f = eth();
        let pv = build_ladder(&LadderSpec { count: 5, start_price: 100.0, end_price: 100.0, total: LadderTotal::Qty(0.005), ..spec() }, &f, 100.0);
        assert!(pv.rungs.iter().all(|r| !r.valid));
        assert!(pv.rungs[0].errors[0].contains("minimum"));
    }

    #[test]
    fn notional_total_derives_the_quantity() {
        let f = eth();
        let pv = build_ladder(&LadderSpec { count: 2, start_price: 100.0, end_price: 100.0, total: LadderTotal::Notional(200.0), ..spec() }, &f, 100.0);
        assert!((pv.total_notional - 200.0).abs() < 0.01);
    }

    #[test]
    fn balance_percent_uses_margin_times_leverage() {
        let f = eth();
        // 10% of 1000 USDT = 100 margin, x5 = 500 notional
        let pv = build_ladder(
            &LadderSpec { count: 2, start_price: 100.0, end_price: 100.0, total: LadderTotal::BalancePct(10.0), balance: Some(1000.0), leverage: Some(5.0), ..spec() },
            &f,
            100.0,
        );
        assert!((pv.total_notional - 500.0).abs() < 0.01, "{}", pv.total_notional);
    }

    #[test]
    fn splits_into_batches_of_five() {
        let items: Vec<usize> = (0..12).collect();
        let sizes: Vec<usize> = chunk_orders(&items, BATCH_CHUNK).iter().map(Vec::len).collect();
        assert_eq!(sizes, vec![5, 5, 2]);
    }

    #[test]
    fn shift_and_stretch_snap_to_the_tick() {
        let f = eth();
        let s = shift_ladder(&LadderSpec { start_price: 100.0, end_price: 90.0, ..spec() }, 5.0, &f);
        assert_eq!((s.start_price, s.end_price), (105.0, 95.0));
        let t = stretch_ladder(&LadderSpec { start_price: 100.0, end_price: 90.0, ..spec() }, 80.555, &f);
        assert_eq!(t.end_price, 80.56);
    }

    #[test]
    fn the_ui_payload_deserialises() {
        let json = r#"{"symbol":"ETHUSDT","side":"BUY","count":6,"startPrice":3000,"endPrice":2900,
            "distribution":"geometric","sizeMode":"linearUp","total":{"mode":"notional","value":1000},"groupId":"g"}"#;
        let s: LadderSpec = serde_json::from_str(json).unwrap();
        assert_eq!(s.count, 6);
        assert_eq!(s.total, LadderTotal::Notional(1000.0));
        assert_eq!(s.distribution, Distribution::Geometric);
    }
}
