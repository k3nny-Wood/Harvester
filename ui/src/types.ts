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
