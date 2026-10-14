//! News for a token: parsing of RSS feeds and Binance announcements, and the decision whether a headline is about a given coin.
//! Pure: no network, no clock. The fetching lives in the app (`src-tauri/src/news.rs`).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NewsKind {
    /// a news article
    News,
    /// the exchange lists a coin
    Listing,
    /// the exchange removes a coin or a contract
    Delisting,
    /// other exchange notices (maintenance, futures changes, promotions)
    Notice,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NewsItem {
    pub id: String,
    pub source: String,
    pub title: String,
    pub url: String,
    /// publication time, ms since the epoch (0 when the feed gave none)
    pub time_ms: u64,
    /// a short plain-text summary (may be empty)
    pub summary: String,
    pub kind: NewsKind,
}

// ------------------------------------------------------------------------------------------------------------ text helpers

fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        if let Some(j) = tail.find(';').filter(|j| *j <= 10) {
            let ent = &tail[1..j];
            let rep = match ent {
                "amp" => Some("&".to_string()),
                "lt" => Some("<".to_string()),
                "gt" => Some(">".to_string()),
                "quot" => Some("\"".to_string()),
                "apos" => Some("'".to_string()),
                "nbsp" => Some(" ".to_string()),
                _ => {
                    let num = ent.strip_prefix('#');
                    num.and_then(|n| if let Some(h) = n.strip_prefix('x').or_else(|| n.strip_prefix('X')) { u32::from_str_radix(h, 16).ok() } else { n.parse::<u32>().ok() }).and_then(char::from_u32).map(|c| c.to_string())
                }
            };
            if let Some(r) = rep {
                out.push_str(&r);
                rest = &tail[j + 1..];
                continue;
            }
        }
        out.push('&');
        rest = &tail[1..];
    }
    out.push_str(rest);
    out
}

/// Plain text of an HTML fragment: tags removed, entities decoded, whitespace collapsed.
pub fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    decode_entities(&out).split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The text of `<tag>...</tag>` inside `block` (CDATA unwrapped), if present.
fn tag_text(block: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}");
    let mut from = 0;
    while let Some(i) = block[from..].find(&open) {
        let start = from + i;
        let after = start + open.len();
        // the tag name must end here (so `<link` does not match `<linkfoo`)
        let next = block[after..].chars().next()?;
        if next != '>' && !next.is_whitespace() {
            from = after;
            continue;
        }
        let gt = block[after..].find('>')? + after;
        if block[..gt].ends_with('/') {
            return None; // self-closing
        }
        let close = format!("</{tag}>");
        let end = block[gt + 1..].find(&close)? + gt + 1;
        let inner = block[gt + 1..end].trim();
        let inner = inner.strip_prefix("<![CDATA[").and_then(|x| x.strip_suffix("]]>")).unwrap_or(inner);
        return Some(inner.trim().to_string());
    }
    None
}

// ------------------------------------------------------------------------------------------------------------ dates

pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// "Wed, 14 Oct 2026 05:35:52 +0000" (RFC 2822, as RSS uses) to ms since the epoch.
pub fn parse_rfc2822(s: &str) -> Option<u64> {
    let s = s.trim();
    let s = s.split_once(',').map_or(s, |(_, rest)| rest).trim();
    let mut it = s.split_whitespace();
    let day: i64 = it.next()?.parse().ok()?;
    let month = match it.next()?.to_ascii_lowercase().get(..3)? {
        "jan" => 1,
        "feb" => 2,
        "mar" => 3,
        "apr" => 4,
        "may" => 5,
        "jun" => 6,
        "jul" => 7,
        "aug" => 8,
        "sep" => 9,
        "oct" => 10,
        "nov" => 11,
        "dec" => 12,
        _ => return None,
    };
    let mut year: i64 = it.next()?.parse().ok()?;
    if year < 100 {
        year += 2000;
    }
    let mut t = it.next()?.split(':');
    let (h, mi): (i64, i64) = (t.next()?.parse().ok()?, t.next()?.parse().ok()?);
    let sec: i64 = t.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let zone = it.next().unwrap_or("+0000");
    let offset_min: i64 = match zone {
        "GMT" | "UT" | "UTC" | "Z" => 0,
        z if (z.starts_with('+') || z.starts_with('-')) && z.len() == 5 => {
            let sign = if z.starts_with('-') { -1 } else { 1 };
            sign * (z[1..3].parse::<i64>().ok()? * 60 + z[3..5].parse::<i64>().ok()?)
        }
        _ => 0,
    };
    let secs = days_from_civil(year, month, day) * 86_400 + h * 3600 + mi * 60 + sec - offset_min * 60;
    u64::try_from(secs).ok().map(|s| s * 1000)
}

// ------------------------------------------------------------------------------------------------------------ feeds

/// The items of an RSS 2.0 feed. Items without a title or link are skipped.
pub fn parse_rss(xml: &str, source: &str) -> Vec<NewsItem> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(i) = rest.find("<item") {
        let tail = &rest[i..];
        let Some(end) = tail.find("</item>") else { break };
        let block = &tail[..end];
        rest = &tail[end + 7..];
        let (Some(title), Some(link)) = (tag_text(block, "title"), tag_text(block, "link").or_else(|| tag_text(block, "guid"))) else { continue };
        let title = strip_html(&title);
        let url = link.trim().to_string();
        if title.is_empty() || !url.starts_with("http") {
            continue;
        }
        let time_ms = tag_text(block, "pubDate").or_else(|| tag_text(block, "dc:date")).and_then(|d| parse_rfc2822(&d)).unwrap_or(0);
        let summary = tag_text(block, "description").map(|d| strip_html(&d)).unwrap_or_default();
        let summary: String = summary.chars().take(280).collect();
        out.push(NewsItem { id: format!("{source}:{url}"), source: source.to_string(), title, url, time_ms, summary, kind: NewsKind::News });
    }
    out
}

/// "2026-10-14T05:35:52Z" or "2026-10-14T05:35:52.123+02:00" (ISO 8601) to ms since the epoch.
pub fn parse_iso8601(s: &str) -> Option<u64> {
    let s = s.trim();
    let (date, time) = s.split_once('T').or_else(|| s.split_once(' '))?;
    let mut d = date.split('-');
    let (y, m, day): (i64, i64, i64) = (d.next()?.parse().ok()?, d.next()?.parse().ok()?, d.next()?.parse().ok()?);
    // split the clock from the zone
    let zone_at = time.find(|c| c == 'Z' || c == '+' || c == '-').unwrap_or(time.len());
    let (clock, zone) = time.split_at(zone_at);
    let mut t = clock.split(':');
    let (h, mi): (i64, i64) = (t.next()?.parse().ok()?, t.next()?.parse().ok()?);
    let sec: i64 = t.next().and_then(|x| x.split('.').next()).and_then(|x| x.parse().ok()).unwrap_or(0);
    let offset_min: i64 = if zone.len() >= 5 && (zone.starts_with('+') || zone.starts_with('-')) {
        let sign = if zone.starts_with('-') { -1 } else { 1 };
        let digits: String = zone[1..].chars().filter(|c| c.is_ascii_digit()).collect();
        if digits.len() < 4 {
            return None;
        }
        sign * (digits[0..2].parse::<i64>().ok()? * 60 + digits[2..4].parse::<i64>().ok()?)
    } else {
        0
    };
    let secs = days_from_civil(y, m, day) * 86_400 + h * 3600 + mi * 60 + sec - offset_min * 60;
    u64::try_from(secs).ok().map(|s| s * 1000)
}

/// CryptoPanic's `posts` answer (`{"results": [{"title", "url", "published_at", "source": {"title"}}]}`). Written from their documented shape;
/// every field is optional so a change on their side gives fewer items, never a crash.
pub fn parse_cryptopanic(v: &serde_json::Value) -> Vec<NewsItem> {
    let mut out = Vec::new();
    for r in v["results"].as_array().into_iter().flatten() {
        let (Some(title), Some(url)) = (r["title"].as_str(), r["url"].as_str().or_else(|| r["original_url"].as_str())) else { continue };
        let source = r["source"]["title"].as_str().or_else(|| r["domain"].as_str()).unwrap_or("CryptoPanic");
        out.push(NewsItem {
            id: format!("cryptopanic:{url}"),
            source: format!("{source} via CryptoPanic"),
            title: strip_html(title),
            url: url.to_string(),
            time_ms: r["published_at"].as_str().or_else(|| r["created_at"].as_str()).and_then(parse_iso8601).unwrap_or(0),
            summary: String::new(),
            kind: NewsKind::News,
        });
    }
    out
}

/// Binance announcements (`/bapi/composite/v1/public/cms/article/list/query`): the articles of every catalog in the answer.
pub fn parse_binance_announcements(v: &serde_json::Value, kind: NewsKind) -> Vec<NewsItem> {
    let mut out = Vec::new();
    let Some(catalogs) = v["data"]["catalogs"].as_array() else { return out };
    for c in catalogs {
        for a in c["articles"].as_array().into_iter().flatten() {
            let (Some(title), Some(code)) = (a["title"].as_str(), a["code"].as_str()) else { continue };
            let time_ms = a["releaseDate"].as_u64().unwrap_or(0);
            out.push(NewsItem {
                id: format!("binance:{code}"),
                source: "Binance".to_string(),
                title: title.trim().to_string(),
                url: format!("https://www.binance.com/en/support/announcement/{code}"),
                time_ms,
                summary: String::new(),
                kind,
            });
        }
    }
    out
}

// ------------------------------------------------------------------------------------------------------------ is it about this coin?

/// The coin's own ticker for a futures symbol: `ONUSDT` -> `ON`, `1000PEPEUSDT` -> `PEPE`.
pub fn base_ticker(symbol: &str) -> String {
    let base = symbol.strip_suffix("USDT").or_else(|| symbol.strip_suffix("USDC")).or_else(|| symbol.strip_suffix("BUSD")).unwrap_or(symbol);
    let base = base.trim_start_matches("1000000").trim_start_matches("10000").trim_start_matches("1000");
    base.to_string()
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Whether `word` occurs in `text` as a whole word. Case-sensitive when `exact_case`.
fn has_word(text: &str, word: &str, exact_case: bool) -> bool {
    if word.is_empty() {
        return false;
    }
    let (hay, needle) = if exact_case { (text.to_string(), word.to_string()) } else { (text.to_lowercase(), word.to_lowercase()) };
    let mut from = 0;
    while let Some(i) = hay[from..].find(&needle) {
        let start = from + i;
        let end = start + needle.len();
        let before_ok = hay[..start].chars().next_back().map_or(true, |c| !is_word_char(c));
        let after_ok = hay[end..].chars().next().map_or(true, |c| !is_word_char(c));
        if before_ok && after_ok {
            return true;
        }
        from = start + needle.chars().next().map_or(1, |c| c.len_utf8());
        if from >= hay.len() {
            break;
        }
    }
    false
}

/// Tickers so well known that their bare capitals in a headline almost always mean the coin.
const MAJORS: &[&str] = &["BTC", "ETH", "SOL", "XRP", "BNB", "ADA", "DOT", "TRX", "LTC", "BCH", "XLM", "ATOM", "NEAR", "APT", "ARB", "SUI", "TON", "ETC", "UNI", "AAVE", "DOGE", "SHIB", "PEPE", "AVAX", "LINK", "MATIC", "POL"];

/// Is this headline (and summary) about the coin? `Trusted` sources (the exchange's own announcements) write bare capitals for tickers, so those
/// count at any length; elsewhere a short ticker such as `ON` or `S` is also a common word, so it needs a cashtag, brackets, the pair, the
/// full name, or to be a major coin.
pub fn mentions(text: &str, symbol: &str, name: Option<&str>, exact_tickers: bool) -> bool {
    let ticker = base_ticker(symbol);
    if ticker.is_empty() {
        return false;
    }
    if has_word(text, symbol, true) {
        return true; // the pair itself: "ONUSDT Perpetual"
    }
    if text.contains(&format!("${ticker}")) && has_word(&text.replace('$', " "), &ticker, false) {
        return true; // a cashtag
    }
    if text.contains(&format!("({ticker})")) || text.contains(&format!("({ticker}/")) || text.contains(&format!("{ticker}/USDT")) {
        return true; // "Ondo (ONDO)", "ONDO/USDT"
    }
    if let Some(n) = name.map(str::trim).filter(|n| n.chars().count() >= 3) {
        if has_word(text, n, false) {
            return true;
        }
    }
    let long_enough = ticker.chars().count() >= 4 || MAJORS.contains(&ticker.as_str());
    if (exact_tickers || long_enough) && has_word(text, &ticker, true) {
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dates_in_the_rss_format_become_epoch_milliseconds() {
        // 2026-10-14 05:35:52 UTC
        assert_eq!(parse_rfc2822("Wed, 14 Oct 2026 05:35:52 +0000"), Some(1_791_956_152_000));
        assert_eq!(parse_rfc2822("Wed, 14 Oct 2026 05:35:52 GMT"), Some(1_791_956_152_000));
        // an offset moves the instant: 07:35:52 +0200 is the same moment
        assert_eq!(parse_rfc2822("Wed, 14 Oct 2026 07:35:52 +0200"), Some(1_791_956_152_000));
        assert_eq!(parse_rfc2822("14 Oct 2026 05:35"), Some(1_791_956_100_000));
        assert_eq!(parse_rfc2822("garbage"), None);
    }

    #[test]
    fn text_is_cleaned_of_markup_and_entities() {
        assert_eq!(strip_html("<p>Ether &amp; Bitcoin&nbsp;rally &#8217;s <b>up</b></p>"), "Ether & Bitcoin rally ’s up");
        assert_eq!(decode_entities("a &lt; b &#x41; &unknown; &"), "a < b A &unknown; &");
    }

    #[test]
    fn an_rss_feed_is_read_item_by_item() {
        let xml = r#"<?xml version="1.0"?><rss><channel><title>Feed</title><link>https://x.com</link>
            <item><title>Here’s what happened &amp; why</title><pubDate>Wed, 14 Oct 2026 05:35:52 +0000</pubDate>
              <link><![CDATA[https://news.example/a?utm=1]]></link><description><![CDATA[<p>Bitcoin <b>rose</b>.</p>]]></description></item>
            <item><title>No link here</title></item>
            <item><title>Second</title><link>https://news.example/b</link><guid>https://news.example/b</guid></item></channel></rss>"#;
        let items = parse_rss(xml, "Example");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "Here’s what happened & why");
        assert_eq!(items[0].url, "https://news.example/a?utm=1");
        assert_eq!(items[0].time_ms, 1_791_956_152_000);
        assert_eq!(items[0].summary, "Bitcoin rose .");
        assert_eq!(items[1].time_ms, 0);
        assert_eq!(items[1].source, "Example");
    }

    #[test]
    fn iso_dates_become_epoch_milliseconds() {
        assert_eq!(parse_iso8601("2026-10-14T05:35:52Z"), Some(1_791_956_152_000));
        assert_eq!(parse_iso8601("2026-10-14T05:35:52.987Z"), Some(1_791_956_152_000));
        assert_eq!(parse_iso8601("2026-10-14T07:35:52+02:00"), Some(1_791_956_152_000));
        assert_eq!(parse_iso8601("2026-10-14T00:35:52-05:00"), Some(1_791_956_152_000));
        assert_eq!(parse_iso8601("nonsense"), None);
    }

    #[test]
    fn cryptopanic_posts_are_read_defensively() {
        let v = json!({"results": [
            {"title": "ONDO &amp; friends", "url": "https://cryptopanic.com/news/1/x", "published_at": "2026-10-14T05:35:52Z", "source": {"title": "CoinDesk"}},
            {"title": "no url"},
            {"title": "Minimal", "original_url": "https://e.com/m"}]});
        let items = parse_cryptopanic(&v);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].source, "CoinDesk via CryptoPanic");
        assert_eq!(items[0].title, "ONDO & friends");
        assert_eq!(items[0].time_ms, 1_791_956_152_000);
        assert_eq!(items[1].time_ms, 0);
        assert!(parse_cryptopanic(&json!({"unexpected": true})).is_empty());
    }

    #[test]
    fn binance_announcements_become_items_with_links() {
        let v = json!({"data": {"catalogs": [{"catalogId": 161, "articles": [
            {"title": "Binance Will Delist EPIC, QUICK on 2026-10-28", "code": "abc123", "releaseDate": 1791957608049u64},
            {"title": "missing code"}]}]}});
        let items = parse_binance_announcements(&v, NewsKind::Delisting);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].url, "https://www.binance.com/en/support/announcement/abc123");
        assert_eq!(items[0].kind, NewsKind::Delisting);
        assert_eq!(items[0].time_ms, 1_791_957_608_049);
        assert!(parse_binance_announcements(&json!({}), NewsKind::Notice).is_empty());
    }

    #[test]
    fn the_coin_of_a_futures_symbol() {
        assert_eq!(base_ticker("ONUSDT"), "ON");
        assert_eq!(base_ticker("1000PEPEUSDT"), "PEPE");
        assert_eq!(base_ticker("1000000MOGUSDT"), "MOG");
        assert_eq!(base_ticker("BTCUSDT"), "BTC");
    }

    #[test]
    fn a_long_ticker_in_capitals_is_enough() {
        assert!(mentions("DOGE jumps after Musk tweet", "DOGEUSDT", None, false));
        assert!(!mentions("doge memes everywhere", "DOGEUSDT", None, false)); // lower case is not the ticker
        assert!(!mentions("Dogecoin rallies", "DOGEUSDT", None, false)); // the name is not known here
        assert!(mentions("Dogecoin rallies", "DOGEUSDT", Some("Dogecoin"), false));
    }

    #[test]
    fn a_short_ticker_that_is_also_a_word_needs_more() {
        // ON, US, S, W: ordinary words
        assert!(!mentions("Bitcoin ON a tear as US yields fall", "ONUSDT", None, false));
        assert!(!mentions("The S&P 500 and US stocks", "USUSDT", None, false));
        assert!(mentions("Why $ON is rallying", "ONUSDT", None, false));
        assert!(mentions("Onyxcoin (ON) listed on a new exchange", "ONUSDT", None, false));
        assert!(mentions("Onyxcoin rallies", "ONUSDT", Some("Onyxcoin"), false));
        assert!(mentions("Binance Futures Will Launch USDⓈ-M ONUSDT Perpetual Contract", "ONUSDT", None, false));
        // a major coin's bare ticker is fine
        assert!(mentions("BTC breaks 90k", "BTCUSDT", None, false));
    }

    #[test]
    fn the_exchanges_own_announcements_use_bare_capitals_for_every_ticker() {
        assert!(mentions("Binance Will Delist EPIC, QUICK on 2026-10-28", "QUICKUSDT", None, true));
        assert!(mentions("Binance Will List ON", "ONUSDT", None, true));
        // but "on" in lower case is never the ticker
        assert!(!mentions("Binance Will Delist EPIC on 2026-10-28", "ONUSDT", None, true));
    }

    #[test]
    fn a_word_inside_another_word_does_not_count() {
        assert!(!mentions("ONDO rallies hard", "ONUSDT", None, true));
        assert!(!mentions("Cashtag $ONDO", "ONUSDT", None, false));
    }
}
