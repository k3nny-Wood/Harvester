//! Harvester without a window. Runs the Telegram bot (summaries every 30 minutes, commands, alerts), the scanner and the pump / dump
//! detector, so a machine that is left on keeps watching the account whether or not the desktop app is open.
//!
//!   cargo run --release -p harvester-server
//!
//! Settings come from the same `.env` file as the desktop app (HARVESTER_ENV, BINANCE_*, TELEGRAM_*, MAX_ORDER_NOTIONAL ...).
//!
//! Do not run it at the same time as the desktop app while both have Telegram on: two programs cannot poll one bot. Start the desktop app
//! with HARVESTER_TELEGRAM=off, or do not run it. Held and armed orders (the exits that wait for an entry to fill) are processed by the desktop
//! app; set HARVESTER_SERVER_ORDERS=1 to let this server process them instead, and then do not run the desktop app.

use harvester_core::movers::{MoverDetector, MoverParams};
use harvester_engine::brackets::{self, BracketStore};
use harvester_engine::events::Events;
use harvester_engine::held::{self, HeldStore};
use harvester_engine::market::{Env, Market};
use harvester_engine::movers;
use harvester_engine::news::{self, NewsHub};
use harvester_engine::scanner::{Scanner, ScannerConfig};
use harvester_engine::trading::Trading;
use harvester_engine::health::{self, log};
use harvester_engine::{rt, telegram};
use std::sync::{Arc, Mutex};

fn flag(name: &str) -> bool {
    matches!(std::env::var(name).unwrap_or_default().trim().to_lowercase().as_str(), "1" | "true" | "yes" | "on")
}

#[tokio::main]
async fn main() {
    let _ = dotenvy::dotenv();
    rt::init(tokio::runtime::Handle::current());
    let env = Env::from_name(&std::env::var("HARVESTER_ENV").unwrap_or_default());
    log(&format!("[server] Harvester headless: {}", if env == Env::Live { "LIVE (real money)" } else { "testnet" }));
    let market = Arc::new(Market::new(env));
    let trading = Arc::new(Trading::new(market.clone()));
    let status = trading.status();
    log(&format!("[server] {}", if status.has_credentials { "Binance keys found".to_string() } else { format!("no Binance keys: {}", status.message) }));

    let events = Events::none();
    let scanner = Scanner::default();
    scanner.start(events.clone(), market.clone(), ScannerConfig::default());
    let detector = Arc::new(Mutex::new(MoverDetector::new(MoverParams::default())));
    movers::start(events.clone(), market.clone(), scanner.injector(), detector);

    let hub = Arc::new(NewsHub::new(news::default_names_path()));
    {
        let hub = hub.clone();
        rt::spawn(async move { hub.load_names().await });
    }

    if flag("HARVESTER_SERVER_ORDERS") {
        let (bracket_store, held_store) = (Arc::new(BracketStore::open(brackets::default_path())), Arc::new(HeldStore::open(held::default_path())));
        brackets::start(events.clone(), trading.clone(), bracket_store);
        held::start(events.clone(), trading.clone(), held_store);
        log(&format!("[server] processing held and armed orders (do not run the desktop app at the same time)"));
    }

    telegram::start(trading, market, scanner.reader(), hub, "headless server");
    log(&format!("[server] running. Log file: {}. Press Ctrl+C to stop.", health::log_path().display()));
    let _ = tokio::signal::ctrl_c().await;
    log(&format!("[server] stopped"));
}
