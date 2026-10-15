import { hasBackend, inTauri, invoke, listen, type Unlisten } from './transport';
import type { Derivatives, AiEntry, AiModel, AiTrack, Delisting, NewsResult, SignalParams, LeverageBracket, Account, ArmedBracket, MoverParams, HeldEvent, HeldOrder, BaseZone, SmcZone, LabConfig, LabProgress, LabReport, Sources, Env, LeverageInfo, OrderRecord, TradeRecord, OpenOrder, OrderAck, OrderRequest, TradingStatus, Kline, KlineEvent, LadderPreview, LadderSpec, ScannerConfig, ScannerStatus, Signal, SymbolFilters, SymbolQuote } from './types';

export { hasBackend, inTauri };

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
  bracketAdd: (b: { symbol: string; long: boolean; takeProfit: number; stopLoss: number; entryOrderId: number; entryConditional: boolean; quantity?: number }) => invoke<ArmedBracket>('bracket_add', b),
  bracketList: () => invoke<ArmedBracket[]>('bracket_list'),
  bracketCancel: (id: string) => invoke<boolean>('bracket_cancel', { id }),
  aiModels: () => invoke<AiModel[]>('ai_models'),
  aiAnalyze: (request: { model: string; symbol: string; timeframe: string; price: number; context: string; image: string | null }) => invoke<AiEntry>('ai_analyze', { request }),
  aiHistory: (symbol?: string) => invoke<AiEntry[]>('ai_history', { symbol: symbol ?? null }),
  aiTrack: () => invoke<AiTrack>('ai_track'),
  aiMarket: (symbol: string) => invoke<Derivatives>('ai_market', { symbol }),
  delistings: (force = false) => invoke<Delisting[]>('delistings', { force }),
  newsFor: (symbol: string, force = false) => invoke<NewsResult>('news_for', { symbol, force }),
  // the desktop window opens it with the default browser; a browser page opens it itself
  openUrl: (url: string): Promise<void> => (inTauri ? invoke<void>('open_url', { url }) : Promise.resolve(void window.open(url, '_blank', 'noopener,noreferrer'))),
  markPrices: (symbols: string[]) => invoke<Record<string, number>>('mark_prices', { symbols }),
  scannerParams: (params: SignalParams) => invoke<void>('scanner_params', { params }),
  moversConfig: () => invoke<MoverParams>('movers_config'),
  moversConfigure: (params: MoverParams) => invoke<void>('movers_configure', { params }),
  heldList: () => invoke<HeldOrder[]>('held_list'),
  moveToHeld: (symbol: string, orderId: number, price: number) => invoke<OrderAck>('move_to_held', { symbol, orderId, price }),
  heldCancel: (id: string) => invoke<boolean>('held_cancel', { id }),
  heldMove: (id: string, price: number) => invoke<void>('held_move', { id, price }),
  cancelOrder: (symbol: string, orderId: number, conditional = false) => invoke<void>('cancel_order', { symbol, orderId, conditional }),
  orderHistory: (symbol: string, limit = 100) => invoke<OrderRecord[]>('order_history', { symbol, limit }),
  tradeHistory: (symbol: string, limit = 200) => invoke<TradeRecord[]>('trade_history', { symbol, limit }),
  modifyOrder: (symbol: string, orderId: number, conditional: boolean, price?: number, stopPrice?: number, quantity?: number) =>
    invoke<OrderAck>('modify_order', { symbol, orderId, conditional, price: price ?? null, stopPrice: stopPrice ?? null, quantity: quantity ?? null }),
  resizeExits: (symbol: string, expected?: number) => invoke<number>('resize_exits', { symbol, expected: expected ?? null }),
  leverageBrackets: (symbol: string) => invoke<LeverageBracket[]>('leverage_brackets', { symbol }),
  symbolLeverage: (symbol: string) => invoke<LeverageInfo>('symbol_leverage', { symbol }),
  cancelAll: (symbol: string) => invoke<void>('cancel_all_orders', { symbol }),
  closePosition: (symbol: string, fraction = 1) => invoke<OrderAck>('close_position', { symbol, fraction }),
  setCapOverride: (off: boolean) => invoke<void>('set_cap_override', { off }),
  setMarginType: (symbol: string, isolated: boolean) => invoke<void>('set_margin_type', { symbol, isolated }),
  setLeverage: (symbol: string, leverage: number) => invoke<void>('set_leverage', { symbol, leverage }),
  smcZones: (symbol: string, interval: string, minFvgPct: number, maxEach: number) => invoke<SmcZone[]>('smc_zones_cmd', { symbol, interval, minFvgPct, maxEach }),
  qflZones: (symbol: string, interval: string, volatilityFactor: number, crackPct: number, mergePct: number) => invoke<BaseZone[]>('qfl_zones', { symbol, interval, volatilityFactor, crackPct, mergePct }),
  labDefaultConfig: () => invoke<LabConfig>('lab_default_config'),
  labRun: (request: { config: LabConfig; days: number; universe: number; luckRuns: number }) => invoke<LabReport>('lab_run', { request }),
  labCancel: () => invoke<void>('lab_cancel'),
  previewLadder: (spec: LadderSpec, referencePrice: number) => invoke<LadderPreview>('preview_ladder', { spec, referencePrice }),
};

export function onKline(handler: (e: KlineEvent) => void): Promise<Unlisten> {
  return listen<KlineEvent>('kline', handler);
}

export function onSignals(handler: (s: Signal[]) => void): Promise<Unlisten> {
  return listen<Signal[]>('signals', handler);
}

export function onSignalNew(handler: (s: Signal) => void): Promise<Unlisten> {
  return listen<Signal>('signal-new', handler);
}

export function onScannerStatus(handler: (s: ScannerStatus) => void): Promise<Unlisten> {
  return listen<ScannerStatus>('scanner-status', handler);
}

/** Binance pushed an order / fill / balance change (the state itself is re-read from the exchange). */
export function onAccountChanged(handler: () => void): Promise<Unlisten> {
  return listen<string>('account-changed', () => handler());
}

export function onUserStream(handler: (connected: boolean) => void): Promise<Unlisten> {
  return listen<{ connected: boolean }>('userstream', (p) => handler(p.connected));
}

export function onLabProgress(handler: (p: LabProgress) => void): Promise<Unlisten> {
  return listen<LabProgress>('lab-progress', handler);
}

/** A held order was sent to Binance (its price came within range) or refused. */
export function onHeldChanged(handler: (e: HeldEvent) => void): Promise<Unlisten> {
  return listen<HeldEvent>('held-changed', handler);
}
