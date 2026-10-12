// Shapes of the payloads the Rust core sends. Decimals travel as strings; prices used for drawing are numbers.

export type Env = 'testnet' | 'live';
export type Side = 'BUY' | 'SELL';

export interface Kline {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface KlineEvent {
  symbol: string;
  interval: string;
  bar: Kline;
  closed: boolean;
}

export interface SymbolQuote {
  symbol: string;
  lastPrice: number;
  changePercent24h: number;
  volume24hQuote: number;
}

export interface SymbolFilters {
  symbol: string;
  tickSize: string;
  stepSize: string;
  minQty: string;
  maxQty: string;
  minNotional: string;
  minPrice: string;
  maxPrice: string;
  pricePrecision: number;
  quantityPrecision: number;
  multiplierUp: number;
  multiplierDown: number;
  maintMarginPercent: number;
}

export type Distribution = 'equal' | 'geometric' | 'custom';
export type SizeMode = 'equal' | 'linearUp' | 'linearDown' | 'exponential';
export type LadderTotal = { mode: 'qty'; value: number } | { mode: 'notional'; value: number } | { mode: 'balancePct'; value: number };

export interface LadderSpec {
  symbol: string;
  side: Side;
  count: number;
  startPrice: number;
  endPrice: number;
  distribution: Distribution;
  customPrices?: number[];
  sizeMode: SizeMode;
  multiplier?: number;
  total: LadderTotal;
  balance?: number;
  leverage?: number;
  reduceOnly?: boolean;
  groupId: string;
}

export interface LadderRung {
  index: number;
  price: number;
  quantity: number;
  notional: number;
  valid: boolean;
  errors: string[];
  /** beyond Binance's price band right now: kept on this computer until the market comes closer */
  held?: boolean;
}

export interface LadderPreview {
  rungs: LadderRung[];
  totalQuantity: number;
  totalNotional: number;
  averageEntry: number;
}

export type SignalKind = 'crack' | 'near' | 'drop' | 'pump' | 'dump';

export interface ScoreParts {
  structure: number;
  volume: number;
  magnitude: number;
  pivot: number;
  stabilising: number;
}

export interface Signal {
  id: string;
  symbol: string;
  timeframe: string;
  kind: SignalKind;
  timeMs: number;
  price: number;
  base: number | null;
  crackLevel: number | null;
  distancePct: number | null;
  dropPct: number;
  volRatio: number;
  donchPos: number | null;
  score: number;
  parts: ScoreParts;
  reasons: string[];
  /** [time, open, high, low, close] */
  thumb: Array<[number, number, number, number, number]>;
}

export interface ScannerStatus {
  running: boolean;
  phase: string;
  timeframe: string;
  symbols: number;
  seeded: number;
  updates: number;
  lastUpdateMs: number;
  crackCount: number;
  nearCount: number;
  dropCount: number;
  pumpCount: number;
  dumpCount: number;
  /** the pump / dump watcher: warming up, or how many coins it watches */
  moverState: string;
  error: string | null;
}

export interface SignalParams {
  qfl: { volatilityFactor: number; crackPct: number; useManual: boolean; manualMovePct: number };
  freshBars: number;
  nearPct: number;
  dropWindow: number;
  dropMinPct: number;
  dropMinMultiple: number;
  donchLen: number;
  thumbBars: number;
}

export interface Sources {
  qfl: boolean;
  movers: boolean;
}

/** One window of the pump / dump watcher: a move this big (%) within this many seconds counts. */
export interface WindowRule {
  secs: number;
  minPct: number;
}

export interface MoverParams {
  rules: WindowRule[];
  /** a move must be this many times the coin's normal move for the window */
  normalMultiple: number;
  /** ignore coins with less 24 h quote volume (USDT) than this */
  minQuoteVolume: number;
  cooldownSecs: number;
  warmupSecs: number;
}

export interface ScannerConfig {
  timeframe: string;
  universe: number;
  params: SignalParams;
  sources: Sources;
}

export interface TradingStatus {
  env: Env;
  hasCredentials: boolean;
  maxOrderNotional: number;
  message: string;
}

export interface Position {
  symbol: string;
  amount: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  liquidationPrice: number;
  leverage: number;
  isolated: boolean;
  /** cash in an isolated position; Binance shows it as the position margin */
  isolatedWallet?: number;
}

export interface Account {
  walletBalance: number;
  availableBalance: number;
  unrealizedPnl: number;
  positions: Position[];
  /** leverage per symbol, also for symbols with no position */
  leverages?: Record<string, number>;
}

export interface OpenOrder {
  orderId: number;
  symbol: string;
  side: Side;
  type: string;
  price: number;
  stopPrice: number;
  origQty: number;
  executedQty: number;
  status: string;
  reduceOnly: boolean;
  clientId: string;
  time: number;
  /** a stop / take-profit (cancelled by its algo id) */
  conditional: boolean;
}

export type OrderKind = 'LIMIT' | 'MARKET' | 'STOP_MARKET' | 'STOP' | 'TAKE_PROFIT_MARKET' | 'TAKE_PROFIT';

export interface LeverageInfo {
  leverage: number;
  maxLeverage: number;
}

export interface OrderRequest {
  symbol: string;
  side: Side;
  type: OrderKind;
  quantity: number;
  price?: number;
  stopPrice?: number;
  postOnly?: boolean;
  reduceOnly?: boolean;
  clientId?: string;
}

export interface OrderAck {
  orderId: number;
  symbol: string;
  status: string;
  clientId: string;
  /** the rounded quantity and price that were actually sent */
  quantity: number;
  price: number | null;
  conditional: boolean;
}

export interface OrderRecord {
  orderId: number;
  symbol: string;
  side: Side;
  type: string;
  status: string;
  price: number;
  stopPrice: number;
  avgPrice: number;
  origQty: number;
  executedQty: number;
  reduceOnly: boolean;
  time: number;
  updateTime: number;
  conditional: boolean;
}

export interface TradeRecord {
  id: number;
  orderId: number;
  symbol: string;
  side: Side;
  price: number;
  qty: number;
  quoteQty: number;
  realizedPnl: number;
  commission: number;
  commissionAsset: string;
  maker: boolean;
  time: number;
}

/** The Lab's strategy and account settings (the V2 live setting by default; mirrors `harvester_core::lab::LabConfig`). */
export interface LabConfig {
  leverage: number;
  stopPct: number;
  layers: number;
  spacingPct: number;
  weights: number[];
  crackPct: number;
  volatilityFactor: number;
  sellLayers: number;
  /** negative = the first sell sits ABOVE the base */
  sellOffsetPct: number;
  sellGapPct: number;
  feePct: number;
  fillThroughPct: number;
  fundingPct8h: number;
  mmrPct: number;
  donchLen: number;
  donchMaxPos: number;
  gateOn: boolean;
  gateDays: number;
  gateMinPct: number;
  startEquity: number;
  maxLadders: number;
  allocPct: number;
  maxBudget: number;
  marginCapPct: number;
}

export interface LabAccountResult {
  returnPct: number;
  maxDrawdownPct: number;
  profitFactor: number | null;
  ladders: number;
  skipped: number;
  closed: number;
  wins: number;
  stops: number;
  equity: number[];
}

export interface LabReport {
  symbols: number;
  candles: number;
  windowStartMs: number;
  windowEndMs: number;
  setups: number;
  base: LabAccountResult;
  luck: { runs: number; keptPct: number; medianReturnPct: number; p10ReturnPct: number; medianDrawdownPct: number };
  starts: Array<{ startMs: number; returnPct: number; maxDrawdownPct: number }>;
  worstStartReturnPct: number;
  stressed: LabAccountResult;
  notes: string[];
}

export interface LabProgress {
  phase: string;
  done: number;
  total: number;
}


/** A QFL support zone as the chart draws it: one or more bases at nearly the same price. */
export interface BaseZone {
  /** the lowest base price in the zone */
  low: number;
  /** the highest base price in the zone (equal to `low` for a lone base) */
  high: number;
  /** open time of the oldest base low candle */
  time: number;
  /** open time of the candle that confirmed the oldest base */
  confirmTime: number;
  /** the first candle that cracked it; null while it still holds */
  crackTime: number | null;
  crackLevel: number;
  /** how many bases were combined */
  bases: number;
  /** how many times price came back to the zone and held it */
  touches: number;
}

/** A Smart Money zone: a fair value gap, an order block or a breaker block. */
export interface SmcZone {
  kind: 'fvg' | 'orderBlock' | 'breaker';
  /** true = expected support, false = expected resistance */
  bullish: boolean;
  time: number;
  confirmTime: number;
  /** what is left of the zone after price tapped into it */
  low: number;
  high: number;
  fullLow: number;
  fullHigh: number;
  partiallyMitigated: boolean;
  sizePct: number;
}

/** A limit order kept on this computer because Binance will not take its price yet (outside the percent-price band). */
export interface HeldOrder {
  id: string;
  env: Env;
  request: OrderRequest;
  createdMs: number;
  status: 'held' | 'placed' | 'failed';
  note: string;
  placedOrderId: number | null;
}

export interface HeldEvent {
  id: string;
  symbol: string;
  status: 'held' | 'placed' | 'failed';
  message: string;
}
