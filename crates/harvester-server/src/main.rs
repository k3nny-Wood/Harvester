//! Harvester without a window.
//!
//!   cargo run --release -p harvester-server
//!
//! Settings come from the same `.env` file as the desktop app (HARVESTER_ENV, BINANCE_*, TELEGRAM_*, MAX_ORDER_NOTIONAL ...).
//!
//! **Watcher mode** (the default): the Telegram bot (summaries every 30 minutes, commands, alerts), the scanner and the pump / dump detector,
//! so a machine that is left on keeps watching the account whether or not the desktop app is open.
//!
//! **Web mode** (set `HARVESTER_WEB_BIND`, for example `127.0.0.1:8787`, and `HARVESTER_WEB_TOKEN`): everything the desktop app does, plus a web
//! server that offers the same page and commands to a browser. Build the page first: `pnpm --dir ui build` (`HARVESTER_WEB_DIR` is where it is,
//! `ui/dist` by default). The token is the password the page asks for. To reach it from other devices bind to an address they can reach (for
//! example your Tailscale address); the server refuses to start without a token.
//!
//! Do not run it at the same time as the desktop app while both have Telegram on: two programs cannot poll one bot. Start the desktop app
//! with HARVESTER_TELEGRAM=off, or do not run it. Held and armed orders (the exits that wait for an entry to fill) are processed by the program
//! that is running: the desktop app, or this server in web mode (or in watcher mode with HARVESTER_SERVER_ORDERS=1). Never by two at once.

mod web;

use harvester_core::movers::{MoverDetector, MoverParams};
use harvester_engine::brackets::{self, BracketStore};
use harvester_engine::core::Core;
use harvester_engine::events::Events;
use harvester_engine::health::{self, log};
use harvester_engine::held::{self, HeldStore};
use harvester_engine::market::{Env, Market};
use harvester_engine::movers;
use harvester_engine::news::{self, NewsHub};
use harvester_engine::scanner::{Scanner, ScannerConfig};
use harvester_engine::trading::Trading;
use harvester_engine::{rt, telegram};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

fn flag(name: &str) -> bool {
    matches!(std::env::var(name).unwrap_or_default().trim().to_lowercase().as_str(), "1" | "true" | "yes" | "on")
}

fn setting(name: &str) -> String {
    std::env::var(name).unwrap_or_default().trim().to_string()
}

#[tokio::main]
async fn main() {
    let _ = dotenvy::dotenv();
    rt::init(tokio::runtime::Handle::current());
    let env = Env::from_name(&setting("HARVESTER_ENV"));
    log(&format!("[server] Harvester headless: {}", if env == Env::Live { "LIVE (real money)" } else { "testnet" }));

    let bind = setting("HARVESTER_WEB_BIND");
    if !bind.is_empty() {
        run_web(&bind).await;
    } else {
        run_watcher(env).await;
    }
    log("[server] stopped");
}

async fn run_web(bind: &str) {
    let addr: SocketAddr = match bind.parse() {
        Ok(a) => a,
        Err(e) => return log(&format!("[server] HARVESTER_WEB_BIND '{bind}' is not an address like 127.0.0.1:8787 ({e})")),
    };
    let token = setting("HARVESTER_WEB_TOKEN");
    if token.len() < 12 {
        return log("[server] web mode needs HARVESTER_WEB_TOKEN in the .env file: a password of at least 12 characters. Nothing was started.");
    }
    let dir = PathBuf::from(std::env::var("HARVESTER_WEB_DIR").unwrap_or_else(|_| "ui/dist".into()));
    if !dir.join("index.html").exists() {
        return log(&format!("[server] the page is not built: {} has no index.html. Run `pnpm --dir ui build` (or set HARVESTER_WEB_DIR).", dir.display()));
    }
    let (bus, _) = tokio::sync::broadcast::channel(2048);
    let core = Core::new(Events::new(web::BusSink(bus.clone())), false);
    let status = core.trading.status();
    log(&format!("[server] {}", if status.has_credentials { "Binance keys found".to_string() } else { format!("no Binance keys: {}", status.message) }));
    core.start_background(Some("headless server"));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => return log(&format!("[server] cannot listen on {addr}: {e}")),
    };
    log(&format!("[server] web page on http://{addr}  (log file: {}). Press Ctrl+C to stop.", health::log_path().display()));
    let app = web::router(core, bus, token, dir);
    let served = axum::serve(listener, app).with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    });
    if let Err(e) = served.await {
        log(&format!("[server] web server error: {e}"));
    }
}

async fn run_watcher(env: Env) {
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
        log("[server] processing held and armed orders (do not run the desktop app at the same time)");
    }

    telegram::start(trading, market, scanner.reader(), hub, "headless server");
    log(&format!("[server] running. Log file: {}. Press Ctrl+C to stop.", health::log_path().display()));
    let _ = tokio::signal::ctrl_c().await;
}
