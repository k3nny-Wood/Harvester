#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod market;
mod scanner;
mod stream;

use harvester_core::filters::SymbolFilters;
use harvester_core::ladder::{build_ladder, LadderPreview, LadderSpec};
use harvester_core::signals::Signal;
use market::{Env, Kline, Market, SymbolQuote};
use scanner::{Scanner, ScannerConfig, ScannerStatus};
use std::sync::Arc;
use stream::Streams;
use tauri::{AppHandle, Manager, State};

struct AppState {
    market: Arc<Market>,
    streams: Streams,
    scanner: Scanner,
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

/// Restart the scanner with a new configuration (timeframe, universe size, thresholds).
#[tauri::command]
fn scanner_configure(app: AppHandle, state: State<'_, AppState>, config: ScannerConfig) {
    state.scanner.start(app, state.market.clone(), config);
}

fn main() {
    let env = Env::from_name(&std::env::var("HARVESTER_ENV").unwrap_or_default());
    tauri::Builder::default()
        .manage(AppState { market: Arc::new(Market::new(env)), streams: Streams::default(), scanner: Scanner::default() })
        .setup(|app| {
            let state = app.state::<AppState>();
            state.scanner.start(app.handle().clone(), state.market.clone(), ScannerConfig::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            environment, set_environment, list_symbols, symbol_filters, get_klines, subscribe_klines, unsubscribe_klines, preview_ladder,
            scanner_signals, scanner_status, scanner_config, scanner_configure
        ])
        .run(tauri::generate_context!())
        .expect("error while running Harvester");
}
