#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod brackets;
mod held;
mod movers;
mod lab;
mod marks;
mod userstream;
mod market;
mod scanner;
mod stream;
mod trading;

use harvester_core::filters::SymbolFilters;
use harvester_core::ladder::{build_ladder, LadderPreview, LadderSpec};
use harvester_core::qfl::{base_zones, BaseZone, QflParams};
use harvester_core::smc::{smc_zones, SmcParams, SmcZone};
use harvester_core::signals::Signal;
use harvester_core::lab::{LabConfig, LabReport};
use harvester_core::movers::{MoverDetector, MoverParams};
use brackets::{Bracket, BracketStore};
use held::{HeldOrder, HeldStore};
use lab::{Lab, LabRequest};
use market::{Env, Kline, Market, SymbolQuote};
use scanner::{Scanner, ScannerConfig, ScannerStatus, Sources};
use std::sync::{Arc, Mutex};
use stream::Streams;
use trading::{Account, LeverageInfo, OpenOrder, OrderAck, OrderRecord, OrderRequest, Trading, TradingStatus, TradeRecord};
use tauri::{AppHandle, Manager, State};

struct AppState {
    lab: Lab,
    movers: movers::SharedDetector,
    brackets: Arc<BracketStore>,
    marks: marks::Marks,
    held: Arc<HeldStore>,
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
    // a limit order beyond Binance's price band is held here until the band reaches it (status "HELD")
    held::place_or_hold(&state.trading, &state.held, order).await
}

/// Several orders at once (a ladder); each rung reports its own success or error.
#[tauri::command]
async fn place_orders(state: State<'_, AppState>, orders: Vec<OrderRequest>) -> Result<Vec<Result<OrderAck, String>>, String> {
    held::place_many_or_hold(&state.trading, &state.held, orders).await
}

/// Orders kept on this computer until Binance will take them (and the recent ones that were sent or refused).
#[tauri::command]
fn held_list(state: State<'_, AppState>) -> Vec<HeldOrder> {
    state.held.list(state.trading.env())
}

/// Move a limit order that rests on Binance to a price beyond its range: it is held on this computer and cancelled on the exchange.
#[tauri::command]
async fn move_to_held(state: State<'_, AppState>, symbol: String, order_id: i64, price: f64) -> Result<OrderAck, String> {
    held::move_to_held(&state.trading, &state.held, &symbol, order_id, price).await
}

/// Exits (take-profit / stop-loss) that wait for an entry order to fill, then are placed on Binance.
#[tauri::command]
fn bracket_add(state: State<'_, AppState>, symbol: String, long: bool, take_profit: f64, stop_loss: f64, entry_order_id: i64, entry_conditional: bool) -> Result<Bracket, String> {
    state.brackets.add(state.trading.env(), symbol, long, take_profit, stop_loss, entry_order_id, entry_conditional)
}

#[tauri::command]
fn bracket_list(state: State<'_, AppState>) -> Vec<Bracket> {
    state.brackets.list(state.trading.env())
}

#[tauri::command]
fn bracket_cancel(state: State<'_, AppState>, id: String) -> bool {
    state.brackets.cancel(&id)
}

/// Live mark prices (from the websocket) of the given symbols; symbols without a price yet are left out.
#[tauri::command]
fn mark_prices(state: State<'_, AppState>, symbols: Vec<String>) -> std::collections::HashMap<String, f64> {
    let m = state.marks.read().unwrap();
    symbols.into_iter().filter_map(|s| m.get(&s).map(|p| (s, *p))).collect()
}

/// The pump / dump watcher's settings.
#[tauri::command]
fn movers_config(state: State<'_, AppState>) -> MoverParams {
    state.movers.lock().unwrap().params().clone()
}

#[tauri::command]
fn movers_configure(state: State<'_, AppState>, params: MoverParams) {
    state.movers.lock().unwrap().set_params(params);
}

#[tauri::command]
fn held_cancel(state: State<'_, AppState>, id: String) -> bool {
    state.held.cancel(&id)
}

#[tauri::command]
fn held_move(state: State<'_, AppState>, id: String, price: f64) -> Result<(), String> {
    state.held.set_price(&id, price)
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

#[tauri::command]
async fn order_history(state: State<'_, AppState>, symbol: String, limit: Option<u32>) -> Result<Vec<OrderRecord>, String> {
    state.trading.order_history(&symbol, limit.unwrap_or(100)).await
}

#[tauri::command]
async fn trade_history(state: State<'_, AppState>, symbol: String, limit: Option<u32>) -> Result<Vec<TradeRecord>, String> {
    state.trading.trade_history(&symbol, limit.unwrap_or(200)).await
}

#[tauri::command]
async fn leverage_brackets(state: State<'_, AppState>, symbol: String) -> Result<Vec<trading::LeverageBracket>, String> {
    state.trading.leverage_brackets(&symbol).await
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

/// Switch the QFL signal source on or off (no restart).
#[tauri::command]
fn scanner_sources(app: AppHandle, state: State<'_, AppState>, sources: Sources) {
    state.scanner.set_sources(&app, sources);
}

/// Restart the scanner with a new configuration (timeframe, universe size, thresholds).
#[tauri::command]
fn scanner_configure(app: AppHandle, state: State<'_, AppState>, config: ScannerConfig) {
    state.scanner.start(app, state.market.clone(), config);
}

/// The QFL support zones of a symbol / timeframe for the chart to draw: bases at nearly the same price combined (Pine-exact detector
/// over the latest 1000 candles), each with how many bases and how many retests it has.
#[tauri::command]
async fn qfl_zones(state: State<'_, AppState>, symbol: String, interval: String, volatility_factor: Option<f64>, crack_pct: Option<f64>, merge_pct: Option<f64>) -> Result<Vec<BaseZone>, String> {
    let rows = state.market.klines(&symbol, &interval, 1000, None, None).await?;
    let candles: Vec<harvester_core::candle::Candle> = rows.iter().map(|k| harvester_core::candle::Candle::new(k.time, k.open, k.high, k.low, k.close, k.volume)).collect();
    let params = QflParams { volatility_factor: volatility_factor.unwrap_or(1.0).clamp(0.1, 20.0), crack_pct: crack_pct.unwrap_or(0.5).clamp(0.05, 20.0) / 100.0, ..QflParams::default() };
    Ok(base_zones(&candles, &params, merge_pct.unwrap_or(0.5).clamp(0.0, 5.0), 60))
}

/// Smart Money zones (fair value gaps, order blocks, breaker blocks) of a symbol / timeframe for the chart to draw.
#[tauri::command]
async fn smc_zones_cmd(state: State<'_, AppState>, symbol: String, interval: String, min_fvg_pct: Option<f64>, max_each: Option<usize>) -> Result<Vec<SmcZone>, String> {
    let rows = state.market.klines(&symbol, &interval, 1000, None, None).await?;
    let candles: Vec<harvester_core::candle::Candle> = rows.iter().map(|k| harvester_core::candle::Candle::new(k.time, k.open, k.high, k.low, k.close, k.volume)).collect();
    let params = SmcParams { min_fvg_size_pct: min_fvg_pct.unwrap_or(0.5).clamp(0.05, 10.0), ..SmcParams::default() };
    Ok(smc_zones(&candles, &params, max_each.unwrap_or(6).clamp(1, 60)))
}

/// The Lab's starting configuration (the V2 live setting).
#[tauri::command]
fn lab_default_config() -> LabConfig {
    LabConfig::default()
}

/// Backtest the QFL ladder as one shared account over recent history (public data; downloads and caches candles).
#[tauri::command]
async fn lab_run(app: AppHandle, state: State<'_, AppState>, request: LabRequest) -> Result<LabReport, String> {
    state.lab.run(app, state.market.clone(), request).await
}

#[tauri::command]
fn lab_cancel(state: State<'_, AppState>) {
    state.lab.cancel();
}

fn main() {
    let _ = dotenvy::dotenv(); // keys and limits from a .env file (searched upwards from the working directory)
    let env = Env::from_name(&std::env::var("HARVESTER_ENV").unwrap_or_default());
    let market = Arc::new(Market::new(env));
    tauri::Builder::default()
        .manage(AppState { lab: Lab::default(), brackets: Arc::new(BracketStore::open(brackets::default_path())), marks: Default::default(), movers: Arc::new(Mutex::new(MoverDetector::new(MoverParams::default()))), held: Arc::new(HeldStore::open(held::default_path())), market: market.clone(), streams: Streams::default(), scanner: Scanner::default(), trading: Arc::new(Trading::new(market)) })
        .setup(|app| {
            let state = app.state::<AppState>();
            state.scanner.start(app.handle().clone(), state.market.clone(), ScannerConfig::default());
            userstream::start(app.handle().clone(), state.trading.clone());
            brackets::start(app.handle().clone(), state.trading.clone(), state.brackets.clone());
            marks::start(state.trading.clone(), state.marks.clone());
            held::start(app.handle().clone(), state.trading.clone(), state.held.clone());
            movers::start(app.handle().clone(), state.market.clone(), state.scanner.injector(), state.movers.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            environment, set_environment, list_symbols, symbol_filters, get_klines, subscribe_klines, unsubscribe_klines, preview_ladder,
            qfl_zones, smc_zones_cmd, lab_default_config, lab_run, lab_cancel, scanner_signals, scanner_status, scanner_config, scanner_configure, scanner_sources,
            trading_status, account_overview, open_orders, place_order, place_orders, held_list, held_cancel, held_move, move_to_held, movers_config, movers_configure, mark_prices, bracket_add, bracket_list, bracket_cancel, cancel_order, modify_order, order_history, trade_history, symbol_leverage, leverage_brackets, cancel_all_orders, close_position, set_leverage
        ])
        .run(tauri::generate_context!())
        .expect("error while running Harvester");
}
