//! Delisting warnings. Two sources, both Binance's own:
//!  * the futures `exchangeInfo`: a perpetual whose `deliveryDate` is not the "never" placeholder has been scheduled for settlement (status `TRADING`
//!    until then, `SETTLING` after). This is the authoritative signal for the contracts Harvester trades;
//!  * the spot announcements ("Binance Will Delist EPIC, QUICK on 2026-10-28"): an earlier hint for the same coins, with a date.
//!
//! Pure: no network, no clock (the caller passes `now`).

use crate::news::{days_from_civil, NewsItem};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Binance's placeholder `deliveryDate` of a perpetual that is not being delisted (2100-12-25).
pub const NEVER: u64 = 4_133_404_800_000;
/// A contract that settled longer ago than this is no longer worth a warning (it is not tradable any more).
const SETTLED_KEEP_MS: u64 = 3 * 24 * 3600 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DelistKind {
    /// the futures contract has a settlement date in the future and still trades
    Scheduled,
    /// the futures contract is settling or has just settled
    Settling,
    /// only the spot market has an announcement so far
    Spot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Delisting {
    pub symbol: String,
    pub kind: DelistKind,
    /// when it happens, ms since the epoch (a spot date is the start of that day, UTC)
    pub date_ms: u64,
    pub title: String,
    pub url: String,
}

/// Where Binance lists the delisting announcements.
pub const ANNOUNCEMENTS_URL: &str = "https://www.binance.com/en/support/announcement/c-161";

/// The scheduled and recent delistings among the futures symbols of an `exchangeInfo` answer.
pub fn parse_exchange_info(v: &Value, now_ms: u64) -> Vec<Delisting> {
    let mut out = Vec::new();
    for s in v["symbols"].as_array().into_iter().flatten() {
        let ctype = s["contractType"].as_str().unwrap_or("");
        // quarterly futures have a real delivery date by design: only perpetuals count
        if ctype != "PERPETUAL" && ctype != "TRADIFI_PERPETUAL" {
            continue;
        }
        let (Some(symbol), Some(date)) = (s["symbol"].as_str(), s["deliveryDate"].as_u64()) else { continue };
        if date == NEVER || date >= 4_000_000_000_000 {
            continue;
        }
        let status = s["status"].as_str().unwrap_or("");
        let kind = if date > now_ms && status != "SETTLING" {
            DelistKind::Scheduled
        } else if now_ms.saturating_sub(date) <= SETTLED_KEEP_MS || status == "SETTLING" && now_ms.saturating_sub(date) <= SETTLED_KEEP_MS {
            DelistKind::Settling
        } else {
            continue;
        };
        out.push(Delisting { symbol: symbol.to_string(), kind, date_ms: date, title: format!("{symbol} perpetual contract is being delisted"), url: ANNOUNCEMENTS_URL.to_string() });
    }
    out.sort_by_key(|d| d.date_ms);
    out
}

/// "2026-10-28" to ms (the start of that day, UTC).
pub fn parse_ymd(s: &str) -> Option<u64> {
    let mut p = s.trim().split('-');
    let (y, m, d): (i64, i64, i64) = (p.next()?.parse().ok()?, p.next()?.parse().ok()?, p.next()?.parse().ok()?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || !(2000..=2100).contains(&y) {
        return None;
    }
    u64::try_from(days_from_civil(y, m, d) * 86_400).ok().map(|s| s * 1000)
}

/// "Binance Will Delist EPIC, QUICK on 2026-10-28" gives (["EPIC", "QUICK"], date). Only the spot announcements ("Binance Will Delist ...") count:
/// margin, alpha and "notice of removal" titles are other things.
pub fn parse_spot_delisting(title: &str) -> Option<(Vec<String>, u64)> {
    let rest = title.trim().strip_prefix("Binance Will Delist ")?;
    let (names, date) = rest.rsplit_once(" on ")?;
    let date_ms = parse_ymd(date.split_whitespace().next()?)?;
    let tickers: Vec<String> = names
        .split(|c| c == ',' || c == '&')
        .flat_map(|part| part.split(" and "))
        .filter_map(|t| t.trim().split_whitespace().next().map(str::to_string))
        .filter(|t| t.len() >= 2 && t.len() <= 12 && t.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()))
        .collect();
    (!tickers.is_empty()).then_some((tickers, date_ms))
}

/// Upcoming spot delistings from the announcements, as warnings for the matching USDT futures symbols that exist in `symbols`.
pub fn spot_delistings(items: &[NewsItem], symbols: &[String], now_ms: u64) -> Vec<Delisting> {
    let mut out = Vec::new();
    for i in items {
        let Some((tickers, date_ms)) = parse_spot_delisting(&i.title) else { continue };
        // a date already past is history (the day after counts as still current)
        if date_ms + 86_400_000 < now_ms {
            continue;
        }
        for t in tickers {
            let symbol = format!("{t}USDT");
            // futures quote tiny coins per 1000 units under a prefixed name
            let found = symbols.iter().find(|s| **s == symbol || **s == format!("1000{t}USDT") || **s == format!("1000000{t}USDT"));
            if let Some(f) = found {
                out.push(Delisting { symbol: f.clone(), kind: DelistKind::Spot, date_ms, title: i.title.clone(), url: i.url.clone() });
            }
        }
    }
    out
}

/// The warnings to show: the futures ones win over a spot one for the same symbol; soonest first.
pub fn merge(futures: Vec<Delisting>, spot: Vec<Delisting>) -> Vec<Delisting> {
    let mut out = futures;
    for s in spot {
        if !out.iter().any(|f| f.symbol == s.symbol) {
            out.push(s);
        }
    }
    out.sort_by_key(|d| d.date_ms);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::news::NewsKind;
    use serde_json::json;

    const NOW: u64 = 1_791_960_000_000; // 2026-10-14

    fn info() -> Value {
        json!({"symbols": [
            {"symbol": "EPICUSDT", "status": "TRADING", "contractType": "PERPETUAL", "deliveryDate": 1_792_486_800_000u64},
            {"symbol": "BTCUSDT", "status": "TRADING", "contractType": "PERPETUAL", "deliveryDate": 4_133_404_800_000u64},
            {"symbol": "PROMPTUSDT", "status": "SETTLING", "contractType": "PERPETUAL", "deliveryDate": 1_791_190_800_000u64},
            {"symbol": "ICXUSDT", "status": "SETTLING", "contractType": "PERPETUAL", "deliveryDate": 1_787_734_800_000u64},
            {"symbol": "BTCUSDT_261225", "status": "TRADING", "contractType": "CURRENT_QUARTER", "deliveryDate": 1_798_185_600_000u64},
            {"symbol": "NODATEUSDT", "status": "TRADING", "contractType": "PERPETUAL"}
        ]})
    }

    #[test]
    fn a_perpetual_with_a_real_delivery_date_in_the_future_is_scheduled() {
        let d = parse_exchange_info(&info(), NOW);
        let epic = d.iter().find(|x| x.symbol == "EPICUSDT").expect("EPIC is scheduled");
        assert_eq!(epic.kind, DelistKind::Scheduled);
        assert_eq!(epic.date_ms, 1_792_486_800_000);
    }

    #[test]
    fn the_never_placeholder_quarterly_futures_and_missing_dates_are_ignored() {
        let d = parse_exchange_info(&info(), NOW);
        assert!(!d.iter().any(|x| x.symbol == "BTCUSDT"));
        assert!(!d.iter().any(|x| x.symbol == "BTCUSDT_261225"));
        assert!(!d.iter().any(|x| x.symbol == "NODATEUSDT"));
    }

    #[test]
    fn a_recently_settled_contract_is_reported_and_an_old_one_is_not() {
        let d = parse_exchange_info(&info(), NOW);
        // PROMPT settled 2026-10-05: nine days ago, longer than the keep time, so it is gone; ICX settled in August
        assert!(!d.iter().any(|x| x.symbol == "ICXUSDT"));
        assert!(!d.iter().any(|x| x.symbol == "PROMPTUSDT"));
        let near = parse_exchange_info(&info(), 1_791_190_800_000 + 3_600_000);
        assert_eq!(near.iter().find(|x| x.symbol == "PROMPTUSDT").map(|x| x.kind), Some(DelistKind::Settling));
    }

    #[test]
    fn spot_delisting_titles_give_tickers_and_a_date() {
        let (t, d) = parse_spot_delisting("Binance Will Delist EPIC, QUICK on 2026-10-28").unwrap();
        assert_eq!(t, vec!["EPIC", "QUICK"]);
        assert_eq!(d, parse_ymd("2026-10-28").unwrap());
        assert_eq!(parse_spot_delisting("Binance Will Delist USDP on 2026-09-24").unwrap().0, vec!["USDP"]);
        assert_eq!(parse_spot_delisting("Binance Will Delist ICX, SCRT & STORJ on 2026-09-03").unwrap().0, vec!["ICX", "SCRT", "STORJ"]);
        // other kinds of notices are not spot delistings
        assert!(parse_spot_delisting("Binance Margin And Loan Will Delist BTTC & POWR on 2026-08-14").is_none());
        assert!(parse_spot_delisting("Notice of Removal of Spot Trading Pairs - 2026-10-02").is_none());
        assert!(parse_spot_delisting("Binance Futures Will Delist Multiple USDⓈ-M Perpetual Contracts (2026-10-05)").is_none());
    }

    #[test]
    fn dates_are_read_strictly() {
        assert_eq!(parse_ymd("2026-10-28"), Some(1_793_145_600_000));
        assert_eq!(parse_ymd("2026-13-01"), None);
        assert_eq!(parse_ymd("nonsense"), None);
    }

    fn item(title: &str) -> NewsItem {
        NewsItem { id: title.into(), source: "Binance".into(), title: title.into(), url: "https://www.binance.com/en/support/announcement/x".into(), time_ms: 1, summary: String::new(), kind: NewsKind::Delisting }
    }

    #[test]
    fn spot_notices_become_warnings_for_the_futures_symbols_that_exist() {
        let symbols: Vec<String> = ["EPICUSDT", "QUICKUSDT", "1000PEPEUSDT", "BTCUSDT"].iter().map(|s| s.to_string()).collect();
        let items = [item("Binance Will Delist EPIC, QUICK, NOFUT on 2026-10-28"), item("Binance Will Delist PEPE on 2026-10-30"), item("Binance Will Delist OLD on 2026-08-01")];
        let d = spot_delistings(&items, &symbols, NOW);
        let names: Vec<&str> = d.iter().map(|x| x.symbol.as_str()).collect();
        assert_eq!(names, vec!["EPICUSDT", "QUICKUSDT", "1000PEPEUSDT"]);
        assert!(d.iter().all(|x| x.kind == DelistKind::Spot));
    }

    #[test]
    fn a_futures_schedule_beats_a_spot_notice_and_the_soonest_comes_first() {
        let fut = vec![Delisting { symbol: "EPICUSDT".into(), kind: DelistKind::Scheduled, date_ms: 200, title: "f".into(), url: String::new() }];
        let spot = vec![
            Delisting { symbol: "EPICUSDT".into(), kind: DelistKind::Spot, date_ms: 300, title: "s".into(), url: String::new() },
            Delisting { symbol: "QUICKUSDT".into(), kind: DelistKind::Spot, date_ms: 100, title: "s".into(), url: String::new() },
        ];
        let m = merge(fut, spot);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].symbol, "QUICKUSDT");
        assert_eq!(m[1].kind, DelistKind::Scheduled);
    }
}
