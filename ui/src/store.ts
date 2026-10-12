import { create } from 'zustand';
import type { Account, Env, HeldOrder, OpenOrder, OrderKind, ScannerConfig, ScannerStatus, Side, Signal, SymbolQuote, TradingStatus } from './types';

/** App-wide state. Everything that belongs to one chart tab lives in `chartStore.ts` instead. */
/** The order-entry form. Shared so the Orders panel, the chart's right-click menu and the ladder card agree. */
export interface OrderForm {
  side: Side;
  type: OrderKind;
  /** empty = follow the last price */
  price: string;
  /** trigger price of a stop / take-profit (empty = a default near the market) */
  stopPrice: string;
  /** 'pos' = a percentage of the position held in the symbol (closes it: the closing side, reduce-only) */
  sizeMode: 'usdt' | 'qty' | 'pct' | 'pos';
  size: string;
  reduceOnly: boolean;
  postOnly: boolean;
  leverage: string;
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
  /** the exchange's user-data stream is connected (changes arrive at once instead of by polling) */
  streamConnected: boolean;
  account: Account | null;
  orders: OpenOrder[];
  /** limit orders kept on this computer until Binance will take them */
  held: HeldOrder[];
  orderForm: OrderForm;
  toasts: Array<{ id: number; text: string; tone: 'info' | 'signal' | 'warn' }>;
  setTrading: (t: TradingStatus) => void;
  setStreamConnected: (c: boolean) => void;
  setAccount: (a: Account | null) => void;
  setOrders: (o: OpenOrder[]) => void;
  setHeld: (h: HeldOrder[]) => void;
  patchOrderForm: (p: Partial<OrderForm>) => void;
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
  streamConnected: false,
  account: null,
  orders: [],
  held: [],
  orderForm: { side: 'BUY', type: 'LIMIT', price: '', stopPrice: '', sizeMode: 'usdt', size: '100', reduceOnly: false, postOnly: false, leverage: '' },
  toasts: [],
  setTrading: (trading) => set({ trading }),
  setStreamConnected: (streamConnected) => set({ streamConnected }),
  setAccount: (account) => set({ account }),
  setOrders: (orders) => set({ orders }),
  setHeld: (held) => set({ held }),
  patchOrderForm: (p) => set((s) => ({ orderForm: { ...s.orderForm, ...p } })),
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
