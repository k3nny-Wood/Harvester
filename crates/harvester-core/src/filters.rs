//! Per-symbol exchange constraints (tick, step, min notional, percent-price band) and order validation.

use crate::decimal::{from_f64, parse, round_to_step, to_f64};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Flattened, ready-to-use trading constraints for one symbol. Decimals travel as strings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SymbolFilters {
    pub symbol: String,
    pub tick_size: Decimal,
    pub step_size: Decimal,
    pub min_qty: Decimal,
    pub max_qty: Decimal,
    pub min_notional: Decimal,
    pub min_price: Decimal,
    pub max_price: Decimal,
    pub price_precision: u32,
    pub quantity_precision: u32,
    pub multiplier_up: f64,
    pub multiplier_down: f64,
    pub maint_margin_percent: f64,
}

impl SymbolFilters {
    pub fn round_price(&self, v: f64) -> Decimal {
        round_to_step(from_f64(v), self.tick_size)
    }

    pub fn round_quantity(&self, v: f64) -> Decimal {
        round_to_step(from_f64(v), self.step_size)
    }

    /// Smallest quantity that still satisfies the minimum notional at `price`.
    pub fn minimum_quantity(&self, price: f64) -> Decimal {
        if price <= 0.0 {
            return self.min_qty;
        }
        let raw = to_f64(self.min_notional) / price;
        let rounded = round_to_step(from_f64(raw), self.step_size);
        if to_f64(rounded) * price < to_f64(self.min_notional) {
            round_to_step(from_f64(raw) + self.step_size, self.step_size)
        } else {
            rounded
        }
    }
}

fn str_of(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn dec_of(f: Option<&Value>, key: &str, default: &str) -> Decimal {
    f.and_then(|f| str_of(f.get(key))).and_then(|s| parse(&s).ok()).unwrap_or_else(|| parse(default).unwrap())
}

/// Build the flat constraints from one `symbols[]` entry of Binance's `exchangeInfo`.
pub fn extract_filters(symbol: &Value) -> SymbolFilters {
    let filters = symbol.get("filters").and_then(|f| f.as_array()).cloned().unwrap_or_default();
    let of = |t: &str| filters.iter().find(|f| f.get("filterType").and_then(|x| x.as_str()) == Some(t));
    let (price, lot, market_lot, notional, percent) = (of("PRICE_FILTER"), of("LOT_SIZE"), of("MARKET_LOT_SIZE"), of("MIN_NOTIONAL"), of("PERCENT_PRICE"));
    let step = if lot.and_then(|l| l.get("stepSize")).is_some() { dec_of(lot, "stepSize", "0.0001") } else { dec_of(market_lot, "stepSize", "0.0001") };
    let num = |f: Option<&Value>, key: &str, d: f64| f.and_then(|f| str_of(f.get(key))).and_then(|s| s.parse::<f64>().ok()).unwrap_or(d);
    SymbolFilters {
        symbol: symbol.get("symbol").and_then(|s| s.as_str()).unwrap_or("").to_string(),
        tick_size: dec_of(price, "tickSize", "0.01"),
        step_size: step,
        min_qty: if lot.and_then(|l| l.get("minQty")).is_some() { dec_of(lot, "minQty", "0") } else { dec_of(market_lot, "minQty", "0") },
        max_qty: if lot.and_then(|l| l.get("maxQty")).is_some() { dec_of(lot, "maxQty", "1000000") } else { dec_of(market_lot, "maxQty", "1000000") },
        min_notional: dec_of(notional, "notional", "5"),
        min_price: dec_of(price, "minPrice", "0"),
        max_price: dec_of(price, "maxPrice", "1000000000"),
        price_precision: symbol.get("pricePrecision").and_then(|v| v.as_u64()).unwrap_or(2) as u32,
        quantity_precision: symbol.get("quantityPrecision").and_then(|v| v.as_u64()).unwrap_or(3) as u32,
        multiplier_up: num(percent, "multiplierUp", 1.05),
        multiplier_down: num(percent, "multiplierDown", 0.95),
        maint_margin_percent: symbol.get("maintMarginPercent").and_then(|v| str_of(Some(v))).and_then(|s| s.parse().ok()).unwrap_or(2.5),
    }
}

/// An order as the validator sees it. Prices / quantities are already rounded decimals.
#[derive(Debug, Clone, Default)]
pub struct OrderCheck {
    pub price: Option<Decimal>,
    pub quantity: Option<Decimal>,
    pub stop_price: Option<Decimal>,
    pub is_market: bool,
    pub close_position: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Validation {
    pub ok: bool,
    pub errors: Vec<String>,
}

/// Check an order against the exchange filters before it is sent. `reference_price` is the current
/// mark / last price used for the percent-price band.
pub fn validate_order(o: &OrderCheck, f: &SymbolFilters, reference_price: f64) -> Validation {
    let mut errors = Vec::new();
    let band = |p: f64| (reference_price * f.multiplier_down, reference_price * f.multiplier_up, p);

    if !o.is_market {
        match o.price {
            Some(p) if p > Decimal::ZERO => {
                if p < f.min_price {
                    errors.push(format!("Price {p} is below the minimum price {}.", f.min_price));
                }
                if p > f.max_price {
                    errors.push(format!("Price {p} is above the maximum price {}.", f.max_price));
                }
                if reference_price > 0.0 {
                    let (lower, upper, pf) = band(to_f64(p));
                    if pf > upper {
                        errors.push(format!("Price is above the +{:.2}% limit ({:.*}).", (f.multiplier_up - 1.0) * 100.0, f.price_precision as usize, upper));
                    }
                    if pf < lower {
                        errors.push(format!("Price is below the -{:.2}% limit ({:.*}).", (1.0 - f.multiplier_down) * 100.0, f.price_precision as usize, lower));
                    }
                }
            }
            _ => errors.push("A non-market order needs a price.".to_string()),
        }
    }

    if let (Some(sp), true) = (o.stop_price, reference_price > 0.0) {
        let (lower, upper, s) = band(to_f64(sp));
        if s > upper || s < lower {
            errors.push(format!("Stop price {sp} is outside the allowed trigger band."));
        }
    }

    match o.quantity {
        None if !o.close_position => errors.push("Quantity must be greater than zero.".to_string()),
        Some(q) if q > Decimal::ZERO => {
            if q < f.min_qty {
                errors.push(format!("Quantity {q} is below the minimum lot size {}.", f.min_qty));
            }
            if q > f.max_qty {
                errors.push(format!("Quantity {q} is above the maximum lot size {}.", f.max_qty));
            }
            if let Some(p) = o.price.or(o.stop_price) {
                let notional = q * p;
                if notional < f.min_notional {
                    errors.push(format!("Order notional {:.2} USDT is below the minimum {} USDT.", to_f64(notional), f.min_notional));
                }
            }
        }
        Some(_) if !o.close_position => errors.push("Quantity must be greater than zero.".to_string()),
        _ => {}
    }

    Validation { ok: errors.is_empty(), errors }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// ETHUSDT as the TypeScript tests define it.
    pub fn eth() -> SymbolFilters {
        extract_filters(&serde_json::json!({
            "symbol": "ETHUSDT", "pricePrecision": 2, "quantityPrecision": 3, "maintMarginPercent": "2.5000",
            "filters": [
                {"filterType": "PRICE_FILTER", "minPrice": "0.10", "tickSize": "0.01", "maxPrice": "100000"},
                {"filterType": "LOT_SIZE", "maxQty": "10000", "minQty": "0.001", "stepSize": "0.001"},
                {"filterType": "MIN_NOTIONAL", "notional": "5"},
                {"filterType": "PERCENT_PRICE", "multiplierUp": "1.05", "multiplierDown": "0.95"}
            ]
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::eth;
    use super::*;

    #[test]
    fn extracts_the_flat_constraints() {
        let f = eth();
        assert_eq!(f.tick_size.to_string(), "0.01");
        assert_eq!(f.step_size.to_string(), "0.001");
        assert_eq!(f.min_notional.to_string(), "5");
        assert_eq!(f.price_precision, 2);
        assert!((f.multiplier_up - 1.05).abs() < 1e-12);
    }

    #[test]
    fn limit_order_inside_the_limits_is_ok() {
        let f = eth();
        let o = OrderCheck { price: Some(parse("3000.00").unwrap()), quantity: Some(parse("0.100").unwrap()), ..Default::default() };
        assert!(validate_order(&o, &f, 3000.0).ok);
    }

    #[test]
    fn flags_each_broken_limit() {
        let f = eth();
        // 0.001 ETH at 100 = 0.1 USDT: below the 5 USDT minimum notional
        let small = OrderCheck { price: Some(parse("100.00").unwrap()), quantity: Some(parse("0.001").unwrap()), ..Default::default() };
        let v = validate_order(&small, &f, 100.0);
        assert!(!v.ok && v.errors.iter().any(|e| e.contains("minimum")));
        // 10% above the market breaks the +5% band
        let far = OrderCheck { price: Some(parse("3300.00").unwrap()), quantity: Some(parse("1.000").unwrap()), ..Default::default() };
        assert!(validate_order(&far, &f, 3000.0).errors.iter().any(|e| e.contains("above the +5.00% limit")));
        // no price on a limit order
        let none = OrderCheck { quantity: Some(parse("1.000").unwrap()), ..Default::default() };
        assert!(validate_order(&none, &f, 3000.0).errors.iter().any(|e| e.contains("needs a price")));
    }

    #[test]
    fn close_position_orders_carry_no_quantity() {
        let f = eth();
        let o = OrderCheck { stop_price: Some(parse("2900.00").unwrap()), is_market: true, close_position: true, ..Default::default() };
        assert!(validate_order(&o, &f, 3000.0).ok);
    }

    #[test]
    fn minimum_quantity_meets_the_notional() {
        let f = eth();
        let q = f.minimum_quantity(3000.0);
        assert!(to_f64(q) * 3000.0 >= 5.0);
        assert_eq!(q.scale(), 3);
    }
}
