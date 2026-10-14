//! Derivatives and positioning data of a futures symbol, read from Binance's public futures endpoints: funding, open interest, the long / short
//! account ratio, taker buying and selling, the 24 hour numbers and the order book's balance. Pure parsing: the requests live in the app.

use serde::Serialize;
use serde_json::Value;

fn num(v: &Value) -> Option<f64> {
    v.as_str().and_then(|s| s.parse::<f64>().ok()).or_else(|| v.as_f64())
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Derivatives {
    /// the funding rate of the current period, in percent (positive: longs pay shorts)
    pub funding_pct: Option<f64>,
    /// the average of the last few settled funding rates, in percent
    pub funding_avg_pct: Option<f64>,
    pub next_funding_ms: Option<u64>,
    /// mark price above the index price, in percent
    pub basis_pct: Option<f64>,
    /// open interest in USDT now
    pub open_interest_usd: Option<f64>,
    /// change of the open interest (USDT) over the hourly history, in percent
    pub open_interest_change_pct: Option<f64>,
    pub open_interest_hours: Option<usize>,
    /// accounts long / accounts short (above 1: more accounts are long), latest, and how it moved over the history
    pub long_short_ratio: Option<f64>,
    pub long_short_change: Option<f64>,
    /// taker buy volume / taker sell volume, latest hour and the average of the history (above 1: aggressive buying)
    pub taker_ratio: Option<f64>,
    pub taker_ratio_avg: Option<f64>,
    pub volume_24h_usd: Option<f64>,
    pub change_24h_pct: Option<f64>,
    /// the depth within 1% of the mid price, in USDT, and the bids' share of the two
    pub bid_depth_usd: Option<f64>,
    pub ask_depth_usd: Option<f64>,
    pub book_bid_share: Option<f64>,
}

/// `premiumIndex`: (funding rate %, next funding time, basis %).
pub fn parse_premium(v: &Value) -> (Option<f64>, Option<u64>, Option<f64>) {
    let funding = num(&v["lastFundingRate"]).map(|r| r * 100.0);
    let next = v["nextFundingTime"].as_u64().filter(|t| *t > 0);
    let basis = match (num(&v["markPrice"]), num(&v["indexPrice"])) {
        (Some(m), Some(i)) if i > 0.0 => Some((m / i - 1.0) * 100.0),
        _ => None,
    };
    (funding, next, basis)
}

/// `fundingRate` history: the average rate in percent.
pub fn parse_funding_avg(v: &Value) -> Option<f64> {
    let rates: Vec<f64> = v.as_array()?.iter().filter_map(|r| num(&r["fundingRate"])).collect();
    (!rates.is_empty()).then(|| rates.iter().sum::<f64>() / rates.len() as f64 * 100.0)
}

/// `openInterestHist` (oldest first): (latest value in USDT, change in percent from the first to the last, number of hours covered).
pub fn parse_open_interest_hist(v: &Value) -> Option<(f64, f64, usize)> {
    let vals: Vec<f64> = v.as_array()?.iter().filter_map(|r| num(&r["sumOpenInterestValue"])).collect();
    let (first, last) = (*vals.first()?, *vals.last()?);
    (first > 0.0).then(|| (last, (last / first - 1.0) * 100.0, vals.len()))
}

/// `globalLongShortAccountRatio` (oldest first): (latest ratio, change of the ratio from the first to the last).
pub fn parse_long_short(v: &Value) -> Option<(f64, f64)> {
    let vals: Vec<f64> = v.as_array()?.iter().filter_map(|r| num(&r["longShortRatio"])).collect();
    Some((*vals.last()?, *vals.last()? - *vals.first()?))
}

/// `takerlongshortRatio` (oldest first): (latest buy/sell ratio, average over the history).
pub fn parse_taker(v: &Value) -> Option<(f64, f64)> {
    let vals: Vec<f64> = v.as_array()?.iter().filter_map(|r| num(&r["buySellRatio"])).collect();
    Some((*vals.last()?, vals.iter().sum::<f64>() / vals.len() as f64))
}

/// `ticker/24hr`: (quote volume in USDT, price change in percent).
pub fn parse_ticker(v: &Value) -> (Option<f64>, Option<f64>) {
    (num(&v["quoteVolume"]), num(&v["priceChangePercent"]))
}

/// `depth`: the USDT resting within `pct` percent of the mid price on each side: (bids, asks).
pub fn book_depth(v: &Value, pct: f64) -> Option<(f64, f64)> {
    let side = |key: &str| -> Vec<(f64, f64)> { v[key].as_array().into_iter().flatten().filter_map(|l| Some((num(&l[0])?, num(&l[1])?))).collect() };
    let (bids, asks) = (side("bids"), side("asks"));
    let (best_bid, best_ask) = (bids.first()?.0, asks.first()?.0);
    let mid = (best_bid + best_ask) / 2.0;
    let within = |levels: &[(f64, f64)], up: bool| levels.iter().filter(|(p, _)| if up { *p <= mid * (1.0 + pct / 100.0) } else { *p >= mid * (1.0 - pct / 100.0) }).map(|(p, q)| p * q).sum::<f64>();
    Some((within(&bids, false), within(&asks, true)))
}

/// Put the parsed pieces together.
#[allow(clippy::too_many_arguments)]
pub fn assemble(premium: &Value, funding_hist: &Value, oi_now: &Value, oi_hist: &Value, long_short: &Value, taker: &Value, ticker: &Value, depth: &Value) -> Derivatives {
    let (funding_pct, next_funding_ms, basis_pct) = parse_premium(premium);
    let oi = parse_open_interest_hist(oi_hist);
    let ls = parse_long_short(long_short);
    let tk = parse_taker(taker);
    let (volume_24h_usd, change_24h_pct) = parse_ticker(ticker);
    let book = book_depth(depth, 1.0);
    // the open interest now is in contracts: its USDT value comes from the hourly history when that is there
    let open_interest_usd = oi.map(|(v, _, _)| v).or_else(|| num(&oi_now["openInterest"]).zip(num(&premium["markPrice"])).map(|(q, p)| q * p));
    Derivatives {
        funding_pct,
        funding_avg_pct: parse_funding_avg(funding_hist),
        next_funding_ms,
        basis_pct,
        open_interest_usd,
        open_interest_change_pct: oi.map(|(_, c, _)| c),
        open_interest_hours: oi.map(|(_, _, n)| n),
        long_short_ratio: ls.map(|(r, _)| r),
        long_short_change: ls.map(|(_, c)| c),
        taker_ratio: tk.map(|(l, _)| l),
        taker_ratio_avg: tk.map(|(_, a)| a),
        volume_24h_usd,
        change_24h_pct,
        bid_depth_usd: book.map(|(b, _)| b),
        ask_depth_usd: book.map(|(_, a)| a),
        book_bid_share: book.and_then(|(b, a)| (b + a > 0.0).then(|| b / (b + a))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn premium() -> Value {
        json!({"symbol": "ONUSDT", "markPrice": "0.12820000", "indexPrice": "0.12780204", "lastFundingRate": "0.00005000", "nextFundingTime": 1791993600000u64})
    }

    #[test]
    fn funding_and_basis_come_from_the_premium_index() {
        let (f, next, basis) = parse_premium(&premium());
        assert!((f.unwrap() - 0.005).abs() < 1e-12, "0.00005 is 0.005 percent");
        assert_eq!(next, Some(1_791_993_600_000));
        assert!((basis.unwrap() - 0.3114).abs() < 0.001);
        assert_eq!(parse_premium(&json!({})), (None, None, None));
    }

    #[test]
    fn the_average_funding_of_the_history() {
        let v = json!([{"fundingRate": "0.00010000"}, {"fundingRate": "-0.00010000"}, {"fundingRate": "0.00030000"}]);
        assert!((parse_funding_avg(&v).unwrap() - 0.01).abs() < 1e-12);
        assert_eq!(parse_funding_avg(&json!([])), None);
    }

    #[test]
    fn open_interest_change_runs_from_the_first_to_the_last_hour() {
        let v = json!([{"sumOpenInterestValue": "5943289.09"}, {"sumOpenInterestValue": "5928856.36"}, {"sumOpenInterestValue": "5853593.72"}]);
        let (now, change, hours) = parse_open_interest_hist(&v).unwrap();
        assert!((now - 5_853_593.72).abs() < 0.01);
        assert!((change - (5_853_593.72 / 5_943_289.09 - 1.0) * 100.0).abs() < 1e-9);
        assert_eq!(hours, 3);
        assert!(parse_open_interest_hist(&json!([])).is_none());
    }

    #[test]
    fn the_long_short_ratio_and_the_taker_flow() {
        let ls = json!([{"longShortRatio": "1.9753"}, {"longShortRatio": "2.0075"}]);
        let (r, change) = parse_long_short(&ls).unwrap();
        assert_eq!(r, 2.0075);
        assert!((change - 0.0322).abs() < 1e-9);
        let tk = json!([{"buySellRatio": "1.0843"}, {"buySellRatio": "0.6882"}]);
        let (latest, avg) = parse_taker(&tk).unwrap();
        assert_eq!(latest, 0.6882);
        assert!((avg - 0.88625).abs() < 1e-9);
    }

    #[test]
    fn the_ticker_gives_volume_and_the_day_s_change() {
        let (vol, chg) = parse_ticker(&json!({"quoteVolume": "3594045.0474000", "priceChangePercent": "-1.080"}));
        assert_eq!(vol, Some(3_594_045.0474));
        assert_eq!(chg, Some(-1.08));
    }

    #[test]
    fn book_depth_counts_only_what_is_within_the_band() {
        // mid 100.0: bids at 99.5 (1 unit) and 98 (10 units, outside 1%), asks at 100.5 (2 units) and 103 (10 units, outside)
        let d = json!({"bids": [["99.9", "1"], ["99.5", "1"], ["98", "10"]], "asks": [["100.1", "2"], ["100.5", "2"], ["103", "10"]]});
        let (bids, asks) = book_depth(&d, 1.0).unwrap();
        assert!((bids - (99.9 + 99.5)).abs() < 1e-9);
        assert!((asks - (200.2 + 201.0)).abs() < 1e-9);
        assert!(book_depth(&json!({"bids": [], "asks": []}), 1.0).is_none());
    }

    #[test]
    fn everything_assembles_and_a_missing_feed_just_leaves_a_gap() {
        let d = assemble(
            &premium(),
            &json!([{"fundingRate": "0.00005"}]),
            &json!({"openInterest": "45193048"}),
            &json!([{"sumOpenInterestValue": "100"}, {"sumOpenInterestValue": "110"}]),
            &json!([{"longShortRatio": "2.0"}]),
            &json!([{"buySellRatio": "1.1"}]),
            &json!({"quoteVolume": "1000", "priceChangePercent": "2.5"}),
            &json!({"bids": [["99", "10"]], "asks": [["101", "10"]]}),
        );
        assert!((d.open_interest_change_pct.unwrap() - 10.0).abs() < 1e-9);
        assert_eq!(d.open_interest_hours, Some(2));
        assert!((d.book_bid_share.unwrap() - 990.0 / (990.0 + 1010.0)).abs() < 1e-9);
        // with nothing at all, nothing is invented
        let empty = assemble(&json!({}), &json!({}), &json!({}), &json!({}), &json!({}), &json!({}), &json!({}), &json!({}));
        assert_eq!(empty, Derivatives::default());
        // the open interest falls back to contracts x mark price when the history is missing
        let fallback = assemble(&premium(), &json!([]), &json!({"openInterest": "1000"}), &json!([]), &json!([]), &json!([]), &json!({}), &json!({}));
        assert!((fallback.open_interest_usd.unwrap() - 128.2).abs() < 1e-9);
    }
}
