#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod market;
mod scanner;
mod stream;
mod trading;

use harvester_core::filters::SymbolFilters;
use harvester_core::ladder::{build_ladder, LadderPreview, LadderSpec};
use harvester_core::signals::Signal;
use market::{Env, Kline, Market, SymbolQuote};
use scanner::{Scanner, ScannerConfig, ScannerStatus, Sources};
use std::sync::Arc;
use stream::Streams;
use trading::{Account, BracketRequest, LeverageInfo, OpenOrder, OrderAck, OrderRecord, OrderRequest, Trading, TradingStatus, TradeRecord};
use tauri::{AppHandle, Manager, State};

struct AppState {
    market: Arc<Market>,
    streams: Streams,
    scanner: Scanner,
    trading: Arc<Trading>,
}

#[tauri::command]
fn environment(state: State<'_, AppState>) -> Env {
    state.market.env()
}

#[tauri::command]
fn set_environment(state: State<'_, AppState>, env: Env) {
    state.market.set_env(env);
}

#[tauri::command]
async fn list_symbols(state: State<'_, AppState>) -> Result<Vec<SymbolQuote>, String> {
    state.market.symbols().await
}

#[tauri::command]
async fn symbol_filters(state: State<'_, AppState>, symbol: String) -> Result<SymbolFilters, String> {
    state.market.symbol_filters(&symbol).await
}

#[tauri::command]
async fn get_klines(state: State<'_, AppState>, symbol: String, interval: String, limit: Option<u32>, start: Option<u64>, end: Option<u64>) -> Result<Vec<Kline>, String> {
    state.market.klines(&symbol, &interval, limit.unwrap_or(500), start, end).await
}

#[tauri::command]
fn subscribe_klines(app: AppHandle, state: State<'_, AppState>, symbol: String, interval: String) {
    state.streams.subscribe(app, state.market.env(), &symbol, &interval);
}

#[tauri::command]
fn unsubscribe_klines(state: State<'_, AppState>, symbol: String, interval: String) {
    state.streams.unsubscribe(&symbol, &interval);
}

/// Build the ladder preview for a drawn range: rounded rungs validated against the symbol's filters.
#[tauri::command]
async fn preview_ladder(state: State<'_, AppState>, spec: LadderSpec, reference_price: f64) -> Result<LadderPreview, String> {
    let filters = state.market.symbol_filters(&spec.symbol).await?;
    Ok(build_ladder(&spec, &filters, reference_price))
}

#[tauri::command]
fn trading_status(state: State<'_, AppState>) -> TradingStatus {
    state.trading.status()
}

#[tauri::command]
async fn account_overview(state: State<'_, AppState>) -> Result<Account, String> {
    state.trading.account().await
}

#[tauri::command]
async fn open_orders(state: State<'_, AppState>, symbol: Option<String>) -> Result<Vec<OpenOrder>, String> {
    state.trading.open_orders(symbol.as_deref()).await
}

#[tauri::command]
async fn place_order(state: State<'_, AppState>, order: OrderRequest) -> Result<OrderAck, String> {
    state.trading.place(order).await
}

/// Several orders at once (a ladder); each rung reports its own success or error.
#[tauri::command]
async fn place_orders(state: State<'_, AppState>, orders: Vec<OrderRequest>) -> Result<Vec<Result<OrderAck, String>>, String> {
    state.trading.place_many(orders).await
}

#[tauri::command]
async fn cancel_order(state: State<'_, AppState>, symbol: String, order_id: i64, conditional: Option<bool>) -> Result<(), String> {
    state.trading.cancel(&symbol, order_id, conditional.unwrap_or(false)).await
}

/// Move an open order to a new price (the drag on the chart).
#[tauri::command]
async fn modify_order(state: State<'_, AppState>, symbol: String, order_id: i64, conditional: Option<bool>, price: Option<f64>, stop_price: Option<f64>) -> Result<OrderAck, String> {
    state.trading.modify(&symbol, order_id, conditional.unwrap_or(false), price, stop_price).await
}

/// Place the entry of a trade plan; its stop-loss and take-profit follow automatically once the entry has filled.
#[tauri::command]
async fn place_bracket(app: AppHandle, state: State<'_, AppState>, plan: BracketRequest) -> Result<OrderAck, String> {
    let trading = state.trading.clone();
    trading.place_bracket(app, plan).await
}

#[tauri::command]
async fn order_history(state: State<'_, AppState>, symbol: String, limit: Option<u32>) -> Result<Vec<OrderRecord>, String> {
    state.trading.order_history(&symbol, limit.unwrap_or(100)).await
}

#[tauri::command]
async fn trade_history(state: State<'_, AppState>, symbol: String, limit: Option<u32>) -> Result<Vec<TradeRecord>, String> {
    state.trading.trade_history(&symbol, limit.unwrap_or(200)).await
}

#[tauri::command]
async fn symbol_leverage(state: State<'_, AppState>, symbol: String) -> Result<LeverageInfo, String> {
    state.trading.leverage(&symbol).await
}

#[tauri::command]
async fn cancel_all_orders(state: State<'_, AppState>, symbol: String) -> Result<(), String> {
    state.trading.cancel_all(&symbol).await
}

#[tauri::command]
async fn close_position(state: State<'_, AppState>, symbol: String, fraction: Option<f64>) -> Result<OrderAck, String> {
    state.trading.close_position(&symbol, fraction.unwrap_or(1.0)).await
}

#[tauri::command]
async fn set_leverage(state: State<'_, AppState>, symbol: String, leverage: u32) -> Result<(), String> {
    state.trading.set_leverage(&symbol, leverage).await
}

#[tauri::command]
fn scanner_signals(state: State<'_, AppState>) -> Vec<Signal> {
    state.scanner.signals()
}

#[tauri::command]
fn scanner_status(state: State<'_, AppState>) -> ScannerStatus {
    state.scanner.status()
}

#[tauri::command]
fn scanner_config(state: State<'_, AppState>) -> ScannerConfig {
    state.scanner.config()
}

/// Switch the QFL / ML signal sources on or off (no restart).
#[tauri::command]
fn scanner_sources(app: AppHandle, state: State<'_, AppState>, sources: Sources) {
    state.scanner.set_sources(&app, sources);
}

/// Restart the scanner with a new configuration (timeframe, universe size, thresholds).
#[tauri::command]
fn scanner_configure(app: AppHandle, state: State<'_, AppState>, config: ScannerConfig) {
    state.scanner.start(app, state.market.clone(), config);
}

fn main() {
    let _ = dotenvy::dotenv(); // keys and limits from a .env file (searched upwards from the working directory)
    let env = Env::from_name(&std::env::var("HARVESTER_ENV").unwrap_or_default());
    let market = Arc::new(Market::new(env));
    tauri::Builder::default()
        .manage(AppState { market: market.clone(), streams: Streams::default(), scanner: Scanner::default(), trading: Arc::new(Trading::new(market)) })
        .setup(|app| {
            let state = app.state::<AppState>();
            state.scanner.start(app.handle().clone(), state.market.clone(), ScannerConfig::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            environment, set_environment, list_symbols, symbol_filters, get_klines, subscribe_klines, unsubscribe_klines, preview_ladder,
            scanner_signals, scanner_status, scanner_config, scanner_configure, scanner_sources,
            trading_status, account_overview, open_orders, place_order, place_orders, cancel_order, modify_order, place_bracket, order_history, trade_history, symbol_leverage, cancel_all_orders, close_position, set_leverage
        ])
        .run(tauri::generate_context!())
        .expect("error while running Harvester");
}
