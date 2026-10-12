import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Account, HeldEvent, HeldOrder, BaseZone, SmcZone, LabConfig, LabProgress, LabReport, Sources, Env, LeverageInfo, OrderRecord, TradeRecord, OpenOrder, OrderAck, OrderRequest, TradingStatus, Kline, KlineEvent, LadderPreview, LadderSpec, ScannerConfig, ScannerStatus, Signal, SymbolFilters, SymbolQuote } from './types';

/** True when running inside the Tauri shell (false in a plain browser, e.g. `vite` on its own). */
export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const api = {
  environment: () => invoke<Env>('environment'),
  setEnvironment: (env: Env) => invoke<void>('set_environment', { env }),
  listSymbols: () => invoke<SymbolQuote[]>('list_symbols'),
  symbolFilters: (symbol: string) => invoke<SymbolFilters>('symbol_filters', { symbol }),
  klines: (symbol: string, interval: string, limit = 500, start?: number, end?: number) =>
    invoke<Kline[]>('get_klines', { symbol, interval, limit, start: start ?? null, end: end ?? null }),
  subscribeKlines: (symbol: string, interval: string) => invoke<void>('subscribe_klines', { symbol, interval }),
  unsubscribeKlines: (symbol: string, interval: string) => invoke<void>('unsubscribe_klines', { symbol, interval }),
  scannerSignals: () => invoke<Signal[]>('scanner_signals'),
  scannerStatus: () => invoke<ScannerStatus>('scanner_status'),
  scannerConfig: () => invoke<ScannerConfig>('scanner_config'),
  scannerSources: (sources: Sources) => invoke<void>('scanner_sources', { sources }),
  scannerConfigure: (config: ScannerConfig) => invoke<void>('scanner_configure', { config }),
  tradingStatus: () => invoke<TradingStatus>('trading_status'),
  account: () => invoke<Account>('account_overview'),
  openOrders: (symbol?: string) => invoke<OpenOrder[]>('open_orders', { symbol: symbol ?? null }),
  placeOrder: (order: OrderRequest) => invoke<OrderAck>('place_order', { order }),
  placeOrders: (orders: OrderRequest[]) => invoke<Array<{ Ok: OrderAck } | { Err: string }>>('place_orders', { orders }),
  heldList: () => invoke<HeldOrder[]>('held_list'),
  moveToHeld: (symbol: string, orderId: number, price: number) => invoke<OrderAck>('move_to_held', { symbol, orderId, price }),
  heldCancel: (id: string) => invoke<boolean>('held_cancel', { id }),
  heldMove: (id: string, price: number) => invoke<void>('held_move', { id, price }),
  cancelOrder: (symbol: string, orderId: number, conditional = false) => invoke<void>('cancel_order', { symbol, orderId, conditional }),
  orderHistory: (symbol: string, limit = 100) => invoke<OrderRecord[]>('order_history', { symbol, limit }),
  tradeHistory: (symbol: string, limit = 200) => invoke<TradeRecord[]>('trade_history', { symbol, limit }),
  modifyOrder: (symbol: string, orderId: number, conditional: boolean, price?: number, stopPrice?: number) =>
    invoke<OrderAck>('modify_order', { symbol, orderId, conditional, price: price ?? null, stopPrice: stopPrice ?? null }),
  symbolLeverage: (symbol: string) => invoke<LeverageInfo>('symbol_leverage', { symbol }),
  cancelAll: (symbol: string) => invoke<void>('cancel_all_orders', { symbol }),
  closePosition: (symbol: string, fraction = 1) => invoke<OrderAck>('close_position', { symbol, fraction }),
  setLeverage: (symbol: string, leverage: number) => invoke<void>('set_leverage', { symbol, leverage }),
  smcZones: (symbol: string, interval: string, minFvgPct: number, maxEach: number) => invoke<SmcZone[]>('smc_zones_cmd', { symbol, interval, minFvgPct, maxEach }),
  qflZones: (symbol: string, interval: string, volatilityFactor: number, crackPct: number, mergePct: number) => invoke<BaseZone[]>('qfl_zones', { symbol, interval, volatilityFactor, crackPct, mergePct }),
  labDefaultConfig: () => invoke<LabConfig>('lab_default_config'),
  labRun: (request: { config: LabConfig; days: number; universe: number; luckRuns: number }) => invoke<LabReport>('lab_run', { request }),
  labCancel: () => invoke<void>('lab_cancel'),
  previewLadder: (spec: LadderSpec, referencePrice: number) => invoke<LadderPreview>('preview_ladder', { spec, referencePrice }),
};

export function onKline(handler: (e: KlineEvent) => void): Promise<UnlistenFn> {
  return listen<KlineEvent>('kline', (ev) => handler(ev.payload));
}

export function onSignals(handler: (s: Signal[]) => void): Promise<UnlistenFn> {
  return listen<Signal[]>('signals', (ev) => handler(ev.payload));
}

export function onSignalNew(handler: (s: Signal) => void): Promise<UnlistenFn> {
  return listen<Signal>('signal-new', (ev) => handler(ev.payload));
}

export function onScannerStatus(handler: (s: ScannerStatus) => void): Promise<UnlistenFn> {
  return listen<ScannerStatus>('scanner-status', (ev) => handler(ev.payload));
}

/** Binance pushed an order / fill / balance change (the state itself is re-read from the exchange). */
export function onAccountChanged(handler: () => void): Promise<UnlistenFn> {
  return listen<string>('account-changed', () => handler());
}

export function onUserStream(handler: (connected: boolean) => void): Promise<UnlistenFn> {
  return listen<{ connected: boolean }>('userstream', (ev) => handler(ev.payload.connected));
}

export function onLabProgress(handler: (p: LabProgress) => void): Promise<UnlistenFn> {
  return listen<LabProgress>('lab-progress', (ev) => handler(ev.payload));
}

/** A held order was sent to Binance (its price came within range) or refused. */
export function onHeldChanged(handler: (e: HeldEvent) => void): Promise<UnlistenFn> {
  return listen<HeldEvent>('held-changed', (ev) => handler(ev.payload));
}
