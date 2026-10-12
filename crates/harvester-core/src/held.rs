//! Orders held on the client: the pure rules for when a limit order has to wait.
//!
//! Binance refuses a LIMIT order whose price is too far from the market (the percent-price filter, a few percent either way). The
//! allowed band moves with the market, so a price that is out of range now can be in range later. Harvester keeps such an order on the
//! computer and sends it once the band has reached it. Stop and take-profit triggers are not subject to the band and never wait.

use crate::filters::SymbolFilters;

/// The prices a limit order may have right now: (lowest, highest).
pub fn band(mark: f64, f: &SymbolFilters) -> (f64, f64) {
    (mark * f.multiplier_down, mark * f.multiplier_up)
}

/// True when `price` is beyond the band around `mark`, so the exchange would refuse a limit order at that price.
pub fn outside_band(price: f64, mark: f64, f: &SymbolFilters) -> bool {
    if !(mark > 0.0) || !(price > 0.0) {
        return false; // no market price to judge against: let the exchange decide
    }
    let (lo, hi) = band(mark, f);
    price > hi || price < lo
}

/// True when `price` is inside the band with `margin_pct` percent of the market price to spare at both edges. The margin keeps an order
/// from being sent at the very edge, where the market moving a tick between the check and the request would get it refused.
pub fn ready_to_place(price: f64, mark: f64, f: &SymbolFilters, margin_pct: f64) -> bool {
    if !(mark > 0.0) || !(price > 0.0) {
        return false;
    }
    let (lo, hi) = band(mark, f);
    let m = mark * margin_pct / 100.0;
    price <= hi - m && price >= lo + m
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filters::test_support::eth;

    #[test]
    fn the_band_is_the_markets_multipliers() {
        let f = eth(); // +-5%
        let (lo, hi) = band(3000.0, &f);
        assert!((lo - 2850.0).abs() < 1e-9 && (hi - 3150.0).abs() < 1e-9);
    }

    #[test]
    fn a_price_beyond_the_band_is_outside_and_the_edge_is_inside() {
        let f = eth();
        assert!(outside_band(3200.0, 3000.0, &f));
        assert!(outside_band(2800.0, 3000.0, &f));
        assert!(!outside_band(3150.0, 3000.0, &f));
        assert!(!outside_band(3000.0, 3000.0, &f));
        // without a market price nothing is held
        assert!(!outside_band(3200.0, 0.0, &f));
    }

    #[test]
    fn ready_needs_a_margin_from_the_edge() {
        let f = eth();
        // 3145 is inside the band (hi 3150) but within 0.2% (6.0) of the edge: not yet
        assert!(!ready_to_place(3145.0, 3000.0, &f, 0.2));
        assert!(ready_to_place(3100.0, 3000.0, &f, 0.2));
        assert!(!ready_to_place(2851.0, 3000.0, &f, 0.2));
        assert!(!ready_to_place(3200.0, 3000.0, &f, 0.2));
        assert!(!ready_to_place(3000.0, 0.0, &f, 0.2));
    }

    #[test]
    fn a_held_buy_becomes_ready_as_the_market_falls_towards_it() {
        let f = eth();
        let price = 2700.0; // 10% below the market: held
        assert!(outside_band(price, 3000.0, &f));
        assert!(!ready_to_place(price, 2900.0, &f, 0.2)); // 6.9% away: still out of range
        assert!(ready_to_place(price, 2800.0, &f, 0.2)); // 3.6% away: in range
    }
}
