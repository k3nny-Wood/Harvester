#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod market;
mod stream;

use harvester_core::filters::SymbolFilters;
use harvester_core::ladder::{build_ladder, LadderPreview, LadderSpec};
use market::{Env, Kline, Market, SymbolQuote};
use stream::Streams;
use tauri::{AppHandle, State};

struct AppState {
    market: Market,
    streams: Streams,
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

fn main() {
    let env = Env::from_name(&std::env::var("HARVESTER_ENV").unwrap_or_default());
    tauri::Builder::default()
        .manage(AppState { market: Market::new(env), streams: Streams::default() })
        .invoke_handler(tauri::generate_handler![environment, set_environment, list_symbols, symbol_filters, get_klines, subscribe_klines, unsubscribe_klines, preview_ladder])
        .run(tauri::generate_context!())
        .expect("error while running Harvester");
}
