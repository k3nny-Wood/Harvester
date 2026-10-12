import { create } from 'zustand';
import type { Distribution, Env, LadderPreview, Side, SizeMode, SymbolFilters, SymbolQuote } from './types';

export type LadderPhase = 'idle' | 'start' | 'end' | 'armed';

export interface LadderDraft {
  phase: LadderPhase;
  /** pixel x (inside the chart) where the vertical range line was started */
  x: number;
  startPrice: number;
  endPrice: number;
  count: number;
  sideOverride: Side | null;
  distribution: Distribution;
  sizeMode: SizeMode;
  multiplier: number;
  totalMode: 'notional' | 'qty';
  totalValue: number;
  preview: LadderPreview | null;
  previewError: string | null;
}

export const initialLadder: LadderDraft = {
  phase: 'idle',
  x: 0,
  startPrice: 0,
  endPrice: 0,
  count: 8,
  sideOverride: null,
  distribution: 'equal',
  sizeMode: 'equal',
  multiplier: 2,
  totalMode: 'notional',
  totalValue: 1000,
  preview: null,
  previewError: null,
};

/** BUY when the range lies below its starting price, SELL when it climbs, unless the trader chose. */
export function ladderSide(d: LadderDraft): Side {
  return d.sideOverride ?? (d.endPrice <= d.startPrice ? 'BUY' : 'SELL');
}

interface AppState {
  symbol: string;
  timeframe: string;
  env: Env;
  markPrice: number;
  filters: SymbolFilters | null;
  symbols: SymbolQuote[];
  ladder: LadderDraft;
  setSymbol: (s: string) => void;
  setTimeframe: (t: string) => void;
  setEnv: (e: Env) => void;
  setMarkPrice: (p: number) => void;
  setFilters: (f: SymbolFilters | null) => void;
  setSymbols: (s: SymbolQuote[]) => void;
  patchLadder: (p: Partial<LadderDraft>) => void;
  resetLadder: () => void;
}

const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem('harvester.view') ?? '{}') as { symbol?: string; timeframe?: string };
  } catch {
    return {};
  }
})();

export const useApp = create<AppState>((set) => ({
  symbol: saved.symbol ?? 'BTCUSDT',
  timeframe: saved.timeframe ?? '15m',
  env: 'testnet',
  markPrice: 0,
  filters: null,
  symbols: [],
  ladder: initialLadder,
  setSymbol: (symbol) => set({ symbol, markPrice: 0, filters: null, ladder: initialLadder }),
  setTimeframe: (timeframe) => set({ timeframe }),
  setEnv: (env) => set({ env }),
  setMarkPrice: (markPrice) => set({ markPrice }),
  setFilters: (filters) => set({ filters }),
  setSymbols: (symbols) => set({ symbols }),
  patchLadder: (p) => set((s) => ({ ladder: { ...s.ladder, ...p } })),
  resetLadder: () => set({ ladder: initialLadder }),
}));

useApp.subscribe((s, prev) => {
  if (s.symbol !== prev.symbol || s.timeframe !== prev.timeframe) {
    try {
      localStorage.setItem('harvester.view', JSON.stringify({ symbol: s.symbol, timeframe: s.timeframe }));
    } catch {
      /* storage unavailable */
    }
  }
});
