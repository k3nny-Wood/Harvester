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
}

export interface LadderPreview {
  rungs: LadderRung[];
  totalQuantity: number;
  totalNotional: number;
  averageEntry: number;
}

export type SignalKind = 'crack' | 'near' | 'drop';

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

export interface ScannerConfig {
  timeframe: string;
  universe: number;
  params: SignalParams;
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
}

export interface Account {
  walletBalance: number;
  availableBalance: number;
  unrealizedPnl: number;
  positions: Position[];
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
}

export interface OrderRequest {
  symbol: string;
  side: Side;
  type: 'LIMIT' | 'MARKET';
  quantity: number;
  price?: number;
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
}
