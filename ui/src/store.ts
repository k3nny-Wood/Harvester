import { create } from 'zustand';
import type { Account, TradePlan, Env, OpenOrder, OrderKind, ScannerConfig, ScannerStatus, Side, Signal, SymbolQuote, TradingStatus } from './types';

/** App-wide state. Everything that belongs to one chart tab lives in `chartStore.ts` instead. */
/** The order-entry form. Shared so the Orders panel, the chart's right-click menu and the ladder card agree. */
export interface OrderForm {
  side: Side;
  type: OrderKind;
  /** empty = follow the last price */
  price: string;
  /** trigger price of a stop / take-profit (empty = a default near the market) */
  stopPrice: string;
  sizeMode: 'usdt' | 'qty' | 'pct';
  size: string;
  reduceOnly: boolean;
  postOnly: boolean;
  leverage: string;
}

/** The trade plan on show for a symbol (from an ML signal). The trader can move the stop and the target and place it. */
export interface PlanState {
  signalId: string;
  timeframe: string;
  plan: TradePlan;
  /** the model's probability, for the label */
  probability: number;
  /** USDT the trader is willing to lose if the stop is hit */
  riskUsd: number;
  /** 'market' enters now, 'limit' rests at the entry price */
  entryType: 'market' | 'limit';
}

interface AppState {
  env: Env;
  symbols: SymbolQuote[];
  /** dockview panel id of the chart tab that has focus */
  activeChartId: string;
  signals: Signal[];
  scanner: ScannerStatus | null;
  scannerConfig: ScannerConfig | null;
  trading: TradingStatus | null;
  account: Account | null;
  orders: OpenOrder[];
  orderForm: OrderForm;
  plans: Record<string, PlanState>;
  toasts: Array<{ id: number; text: string; tone: 'info' | 'signal' | 'warn' }>;
  setTrading: (t: TradingStatus) => void;
  setAccount: (a: Account | null) => void;
  setOrders: (o: OpenOrder[]) => void;
  patchOrderForm: (p: Partial<OrderForm>) => void;
  setPlan: (symbol: string, p: PlanState) => void;
  patchPlan: (symbol: string, p: Partial<PlanState>) => void;
  clearPlan: (symbol: string) => void;
  setEnv: (e: Env) => void;
  setSymbols: (s: SymbolQuote[]) => void;
  setActiveChart: (id: string) => void;
  setSignals: (s: Signal[]) => void;
  setScanner: (s: ScannerStatus) => void;
  setScannerConfig: (c: ScannerConfig) => void;
  toast: (text: string, tone?: 'info' | 'signal' | 'warn') => void;
  dismissToast: (id: number) => void;
}

let toastId = 1;

export const useApp = create<AppState>((set) => ({
  env: 'testnet',
  symbols: [],
  activeChartId: '',
  signals: [],
  scanner: null,
  scannerConfig: null,
  trading: null,
  account: null,
  orders: [],
  orderForm: { side: 'BUY', type: 'LIMIT', price: '', stopPrice: '', sizeMode: 'usdt', size: '100', reduceOnly: false, postOnly: false, leverage: '' },
  plans: {},
  toasts: [],
  setTrading: (trading) => set({ trading }),
  setAccount: (account) => set({ account }),
  setOrders: (orders) => set({ orders }),
  patchOrderForm: (p) => set((s) => ({ orderForm: { ...s.orderForm, ...p } })),
  setPlan: (symbol, p) => set((s) => ({ plans: { ...s.plans, [symbol]: p } })),
  patchPlan: (symbol, p) => set((s) => (s.plans[symbol] ? { plans: { ...s.plans, [symbol]: { ...s.plans[symbol], ...p } } } : s)),
  clearPlan: (symbol) =>
    set((s) => {
      const { [symbol]: _gone, ...rest } = s.plans;
      return { plans: rest };
    }),
  setEnv: (env) => set({ env }),
  setSymbols: (symbols) => set({ symbols }),
  setActiveChart: (activeChartId) => set({ activeChartId }),
  setSignals: (signals) => set({ signals }),
  setScanner: (scanner) => set({ scanner }),
  setScannerConfig: (scannerConfig) => set({ scannerConfig }),
  toast: (text, tone = 'info') => {
    const id = toastId++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, tone }] }));
    window.setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 6000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
