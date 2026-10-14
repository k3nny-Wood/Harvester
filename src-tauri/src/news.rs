//! News for the symbol on screen. Fetches Binance's own announcements and a few crypto news RSS feeds (no keys), keeps them for a few minutes,
//! and picks out what is about the coin. A free CryptoPanic key (CRYPTOPANIC_API_KEY in .env) adds their per-coin feed.
//! The reading and matching rules are in `harvester-core::news`; this file is the network, the cache and the coin names.

use futures_util::future::join_all;
use harvester_core::delist::{merge, parse_exchange_info, spot_delistings, Delisting};
use harvester_core::news::{base_ticker, mentions, parse_binance_announcements, parse_rss, NewsItem, NewsKind};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

/// How long a fetched feed is reused.
const TTL_MS: u64 = 5 * 60 * 1000;
/// A manual refresh is ignored when the last fetch was this recent.
const MIN_REFRESH_MS: u64 = 20 * 1000;
const NAMES_MAX_AGE_SECS: u64 = 7 * 24 * 3600;

const RSS_FEEDS: &[(&str, &str)] = &[
    ("Cointelegraph", "https://cointelegraph.com/rss"),
    ("CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"),
    ("Decrypt", "https://decrypt.co/feed"),
    ("The Block", "https://www.theblock.co/rss.xml"),
];

/// (Binance announcement catalog, what it holds)
const BINANCE_CATALOGS: &[(u32, NewsKind)] = &[(48, NewsKind::Listing), (161, NewsKind::Delisting), (49, NewsKind::Notice)];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    pub name: String,
    pub ok: bool,
    pub count: usize,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewsResult {
    pub ticker: String,
    pub name: Option<String>,
    /// about this coin, newest first
    pub items: Vec<NewsItem>,
    /// the exchange's latest notices that do not name this coin (delistings, futures changes...), newest first
    pub notices: Vec<NewsItem>,
    pub fetched_ms: u64,
    pub sources: Vec<SourceStatus>,
}

#[derive(Default)]
struct FeedCache {
    items: Vec<NewsItem>,
    sources: Vec<SourceStatus>,
    fetched_ms: u64,
}

pub struct NewsHub {
    http: reqwest::Client,
    feed: tokio::sync::Mutex<FeedCache>,
    names: Mutex<HashMap<String, String>>,
    names_path: PathBuf,
    panic: Mutex<HashMap<String, (u64, Vec<NewsItem>)>>,
    delist: tokio::sync::Mutex<(u64, Vec<Delisting>)>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn default_names_path() -> PathBuf {
    let base = std::env::var("APPDATA").ok().filter(|v| !v.is_empty()).map(PathBuf::from).or_else(|| std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf()))).unwrap_or_else(|| PathBuf::from("."));
    base.join("Harvester").join("coin_names.json")
}

/// Names of the biggest coins for matching headlines when the list from CoinGecko is not there (yet).
fn builtin_names() -> HashMap<String, String> {
    [("BTC", "Bitcoin"), ("ETH", "Ethereum"), ("SOL", "Solana"), ("XRP", "Ripple"), ("BNB", "BNB Chain"), ("ADA", "Cardano"), ("DOGE", "Dogecoin"), ("TRX", "Tron"), ("AVAX", "Avalanche"), ("LINK", "Chainlink"), ("DOT", "Polkadot"), ("LTC", "Litecoin"), ("SHIB", "Shiba Inu"), ("BCH", "Bitcoin Cash"), ("XLM", "Stellar"), ("ATOM", "Cosmos"), ("NEAR", "NEAR Protocol"), ("APT", "Aptos"), ("ARB", "Arbitrum"), ("OP", "Optimism"), ("SUI", "Sui"), ("PEPE", "Pepe"), ("TON", "Toncoin"), ("UNI", "Uniswap"), ("AAVE", "Aave")]
        .iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect()
}

impl NewsHub {
    pub fn new(names_path: PathBuf) -> NewsHub {
        let http = reqwest::Client::builder().user_agent("Mozilla/5.0 (Harvester news reader)").timeout(Duration::from_secs(15)).build().expect("an HTTP client");
        let mut names = builtin_names();
        if let Some(saved) = std::fs::read(&names_path).ok().and_then(|b| serde_json::from_slice::<HashMap<String, String>>(&b).ok()) {
            names.extend(saved);
        }
        NewsHub { http, feed: tokio::sync::Mutex::new(FeedCache::default()), names: Mutex::new(names), names_path, panic: Mutex::new(HashMap::new()), delist: tokio::sync::Mutex::new((0, Vec::new())) }
    }

    /// Load the coin names (ticker -> name) of the 1000 biggest coins from CoinGecko, once a week. A failure just leaves the built-in names.
    pub async fn load_names(&self) {
        let fresh = std::fs::metadata(&self.names_path).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map_or(false, |age| age.as_secs() < NAMES_MAX_AGE_SECS);
        if fresh {
            return;
        }
        let mut found: HashMap<String, String> = HashMap::new();
        for page in 1..=4 {
            let url = format!("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page={page}");
            let Ok(resp) = self.http.get(&url).send().await else { break };
            if !resp.status().is_success() {
                break; // rate limited or down: keep what we have
            }
            let Ok(v) = resp.json::<Value>().await else { break };
            for c in v.as_array().into_iter().flatten() {
                if let (Some(sym), Some(name)) = (c["symbol"].as_str(), c["name"].as_str()) {
                    found.entry(sym.to_uppercase()).or_insert_with(|| name.to_string()); // the biggest coin of a ticker wins
                }
            }
            tokio::time::sleep(Duration::from_millis(1500)).await;
        }
        if found.len() > 200 {
            if let Some(dir) = self.names_path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            if let Ok(bytes) = serde_json::to_vec(&found) {
                let _ = std::fs::write(&self.names_path, bytes);
            }
            self.names.lock().unwrap().extend(found);
        }
    }

    fn name_of(&self, ticker: &str) -> Option<String> {
        self.names.lock().unwrap().get(ticker).cloned()
    }

    async fn get_text(&self, url: &str) -> Result<String, String> {
        let resp = self.http.get(url).send().await.map_err(|e| format!("{e}"))?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status().as_u16()));
        }
        resp.text().await.map_err(|e| format!("{e}"))
    }

    async fn fetch_rss(&self, name: &str, url: &str) -> (SourceStatus, Vec<NewsItem>) {
        match self.get_text(url).await {
            Ok(xml) => {
                let items = parse_rss(&xml, name);
                let status = SourceStatus { name: name.to_string(), ok: !items.is_empty(), count: items.len(), error: if items.is_empty() { "no items in the feed".into() } else { String::new() } };
                (status, items)
            }
            Err(e) => (SourceStatus { name: name.to_string(), ok: false, count: 0, error: e }, vec![]),
        }
    }

    async fn fetch_binance(&self, catalog: u32, kind: NewsKind) -> (SourceStatus, Vec<NewsItem>) {
        let name = format!("Binance announcements ({})", match kind {
            NewsKind::Listing => "listings",
            NewsKind::Delisting => "delistings",
            _ => "news",
        });
        let url = format!("https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId={catalog}&pageNo=1&pageSize=20");
        match self.get_text(&url).await.and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| format!("{e}"))) {
            Ok(v) => {
                let items = parse_binance_announcements(&v, kind);
                (SourceStatus { name, ok: !items.is_empty(), count: items.len(), error: if items.is_empty() { "no articles".into() } else { String::new() } }, items)
            }
            Err(e) => (SourceStatus { name, ok: false, count: 0, error: e }, vec![]),
        }
    }

    /// Everything the feeds hold right now, fetched at most every few minutes (shared by every symbol).
    async fn refresh_feed(&self, force: bool) -> (Vec<NewsItem>, Vec<SourceStatus>, u64) {
        let mut cache = self.feed.lock().await;
        let age = now_ms().saturating_sub(cache.fetched_ms);
        let stale = cache.fetched_ms == 0 || age > TTL_MS;
        if stale || (force && age > MIN_REFRESH_MS) {
            let rss = RSS_FEEDS.iter().map(|(n, u)| self.fetch_rss(n, u));
            let bin = BINANCE_CATALOGS.iter().map(|(c, k)| self.fetch_binance(*c, *k));
            let (rss, bin) = futures_util::future::join(join_all(rss), join_all(bin)).await;
            let mut items = Vec::new();
            let mut sources = Vec::new();
            for (s, i) in bin.into_iter().chain(rss) {
                sources.push(s);
                items.extend(i);
            }
            // the same article can come from two catalogs
            items.sort_by(|a, b| b.time_ms.cmp(&a.time_ms));
            let mut seen = std::collections::HashSet::new();
            items.retain(|i| seen.insert(i.id.clone()));
            // a feed that failed this time keeps its previous items, so one flaky source does not empty the panel
            if sources.iter().any(|s| !s.ok) {
                let fresh: std::collections::HashSet<String> = items.iter().map(|i| i.source.clone()).collect();
                items.extend(cache.items.iter().filter(|i| !fresh.contains(&i.source)).cloned());
                items.sort_by(|a, b| b.time_ms.cmp(&a.time_ms));
            }
            *cache = FeedCache { items, sources, fetched_ms: now_ms() };
        }
        (cache.items.clone(), cache.sources.clone(), cache.fetched_ms)
    }

    /// The futures contracts that are scheduled to be delisted, or have just been: Binance's futures `exchangeInfo` (a perpetual with a real
    /// settlement date) plus the spot delisting announcements for coins that have a futures contract. Kept for 10 minutes.
    pub async fn delistings(&self, force: bool) -> Vec<Delisting> {
        let mut cache = self.delist.lock().await;
        let age = now_ms().saturating_sub(cache.0);
        if cache.0 != 0 && age < 10 * 60 * 1000 && !(force && age > MIN_REFRESH_MS) {
            return cache.1.clone();
        }
        let info = self.get_text("https://fapi.binance.com/fapi/v1/exchangeInfo").await.and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| format!("{e}")));
        let now = now_ms();
        let (futures, symbols) = match &info {
            Ok(v) => {
                let symbols: Vec<String> = v["symbols"].as_array().into_iter().flatten().filter(|s| s["status"] == "TRADING").filter_map(|s| s["symbol"].as_str().map(str::to_string)).collect();
                (parse_exchange_info(v, now), symbols)
            }
            // the exchange did not answer: keep what was known rather than showing "no delistings"
            Err(_) if cache.0 != 0 => return cache.1.clone(),
            Err(_) => (Vec::new(), Vec::new()),
        };
        let (items, _, _) = self.refresh_feed(false).await;
        let spot = spot_delistings(&items, &symbols, now);
        let merged = merge(futures, spot);
        *cache = (now, merged.clone());
        merged
    }

    /// CryptoPanic's feed for one coin, when a key is set. Kept for the same few minutes.
    async fn cryptopanic(&self, ticker: &str, force: bool) -> Option<(SourceStatus, Vec<NewsItem>)> {
        let key = std::env::var("CRYPTOPANIC_API_KEY").ok().map(|k| k.trim().to_string()).filter(|k| !k.is_empty())?;
        if let Some((t, items)) = self.panic.lock().unwrap().get(ticker) {
            if now_ms().saturating_sub(*t) < if force { MIN_REFRESH_MS } else { TTL_MS } {
                return Some((SourceStatus { name: "CryptoPanic".into(), ok: true, count: items.len(), error: String::new() }, items.clone()));
            }
        }
        let url = format!("https://cryptopanic.com/api/v1/posts/?auth_token={key}&currencies={ticker}&public=true");
        let result = self.get_text(&url).await.and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| format!("{e}")));
        let (status, items) = match result {
            Ok(v) => {
                let items = harvester_core::news::parse_cryptopanic(&v);
                (SourceStatus { name: "CryptoPanic".into(), ok: true, count: items.len(), error: String::new() }, items)
            }
            Err(e) => (SourceStatus { name: "CryptoPanic".into(), ok: false, count: 0, error: e }, vec![]),
        };
        self.panic.lock().unwrap().insert(ticker.to_string(), (now_ms(), items.clone()));
        Some((status, items))
    }

    /// The news about `symbol`'s coin, plus the exchange's latest general notices.
    pub async fn news_for(&self, symbol: &str, force: bool) -> NewsResult {
        let ticker = base_ticker(symbol);
        let name = self.name_of(&ticker);
        let (all, mut sources, fetched_ms) = self.refresh_feed(force).await;
        let mut items: Vec<NewsItem> = Vec::new();
        let mut notices: Vec<NewsItem> = Vec::new();
        for i in all {
            let exact = i.source == "Binance";
            let text = format!("{} {}", i.title, i.summary);
            if mentions(&text, symbol, name.as_deref(), exact) {
                items.push(i);
            } else if exact && matches!(i.kind, NewsKind::Delisting | NewsKind::Notice) {
                notices.push(i);
            }
        }
        if let Some((s, extra)) = self.cryptopanic(&ticker, force).await {
            sources.push(s);
            for e in extra {
                if !items.iter().any(|x| x.url == e.url) {
                    items.push(e);
                }
            }
        }
        items.sort_by(|a, b| b.time_ms.cmp(&a.time_ms));
        notices.truncate(6);
        NewsResult { ticker, name, items, notices, fetched_ms, sources }
    }
}

/// Open a link in the default browser. Only http(s) links without spaces or quotes are accepted, and the shell is not involved.
pub fn open_in_browser(url: &str) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) || url.chars().any(|c| c.is_whitespace() || c == '"' || c == '\'' || c == '<' || c == '>' || c == '^' || c == '`') || url.len() > 2000 {
        return Err("That is not a link Harvester will open.".into());
    }
    std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn().map(|_| ()).map_err(|e| format!("could not open the browser: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_web_links_are_opened() {
        assert!(open_in_browser("file:///C:/Windows/System32/calc.exe").is_err());
        assert!(open_in_browser("javascript:alert(1)").is_err());
        assert!(open_in_browser("https://example.com/a b").is_err());
        assert!(open_in_browser("https://example.com/\"&calc").is_err());
        assert!(open_in_browser("").is_err());
        assert!(open_in_browser(&format!("https://example.com/{}", "a".repeat(2100))).is_err());
    }

    #[test]
    fn the_builtin_names_cover_the_majors() {
        let n = builtin_names();
        assert_eq!(n.get("BTC").map(String::as_str), Some("Bitcoin"));
        assert!(n.len() >= 20);
    }
}

#[cfg(test)]
mod live {
    use super::*;

    /// Talks to the real servers: `cargo test live_news -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_news() {
        let path = std::env::temp_dir().join("harvester_names_live_test.json");
        let _ = std::fs::remove_file(&path);
        let hub = NewsHub::new(path);
        hub.load_names().await;
        println!("names known: {}", hub.names.lock().unwrap().len());
        for symbol in ["BTCUSDT", "DOGEUSDT", "ONUSDT", "SOLUSDT", "EPICUSDT"] {
            let r = hub.news_for(symbol, true).await;
            println!("\n== {symbol}: ticker {} name {:?} -> {} items, {} notices", r.ticker, r.name, r.items.len(), r.notices.len());
            for s in &r.sources {
                println!("   source {:<42} ok={} count={} {}", s.name, s.ok, s.count, s.error);
            }
            for i in r.items.iter().take(4) {
                println!("   [{}] {} ({})", i.source, i.title, i.time_ms);
            }
        }
    }
}

#[cfg(test)]
mod live_delist {
    use super::*;

    /// Talks to the real servers: `cargo test live_delistings -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_delistings() {
        let hub = NewsHub::new(std::env::temp_dir().join("harvester_names_live_test2.json"));
        let d = hub.delistings(true).await;
        println!("{} delisting warnings", d.len());
        for x in &d {
            println!("  {:<16} {:?} {} | {}", x.symbol, x.kind, x.date_ms, x.title);
        }
    }
}
