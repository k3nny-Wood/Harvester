import { create } from 'zustand';
import type { Env, ScannerConfig, ScannerStatus, Signal, SymbolQuote } from './types';

/** App-wide state. Everything that belongs to one chart tab lives in `chartStore.ts` instead. */
interface AppState {
  env: Env;
  symbols: SymbolQuote[];
  /** dockview panel id of the chart tab that has focus */
  activeChartId: string;
  signals: Signal[];
  scanner: ScannerStatus | null;
  scannerConfig: ScannerConfig | null;
  toasts: Array<{ id: number; text: string; tone: 'info' | 'signal' | 'warn' }>;
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
  toasts: [],
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
