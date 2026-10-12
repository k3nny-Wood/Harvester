import { createContext, useContext, useEffect, useReducer } from 'react';
import { createStore, useStore, type StoreApi } from 'zustand';
import type { PineStore } from './pine/pineStore';
import { useApp } from './store';
import type { Distribution, LadderPreview, Side, SizeMode, SymbolFilters } from './types';

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

/** The state of ONE chart tab: its own symbol, timeframe, price, exchange limits and ladder draft. */
export interface ChartState {
  symbol: string;
  timeframe: string;
  markPrice: number;
  filters: SymbolFilters | null;
  ladder: LadderDraft;
  setSymbol: (s: string) => void;
  setTimeframe: (t: string) => void;
  setMarkPrice: (p: number) => void;
  setFilters: (f: SymbolFilters | null) => void;
  patchLadder: (p: Partial<LadderDraft>) => void;
  resetLadder: () => void;
}

export type ChartStore = StoreApi<ChartState>;

export function createChartStore(symbol: string, timeframe: string): ChartStore {
  return createStore<ChartState>((set) => ({
    symbol,
    timeframe,
    markPrice: 0,
    filters: null,
    ladder: initialLadder,
    setSymbol: (s) => set({ symbol: s, markPrice: 0, filters: null, ladder: initialLadder }),
    setTimeframe: (t) => set({ timeframe: t }),
    setMarkPrice: (markPrice) => set({ markPrice }),
    setFilters: (filters) => set({ filters }),
    patchLadder: (p) => set((s) => ({ ladder: { ...s.ladder, ...p } })),
    resetLadder: () => set({ ladder: initialLadder }),
  }));
}

/** Every open chart tab, by its dockview panel id. */
export const chartRegistry = new Map<string, ChartStore>();

export const ChartContext = createContext<{ id: string; store: ChartStore; pine: PineStore } | null>(null);

/** Read from the chart this component lives in (a chart tab and everything inside it). */
export function useChart<T>(selector: (s: ChartState) => T): T {
  const ctx = useContext(ChartContext);
  if (!ctx) throw new Error('useChart outside a chart panel');
  return useStore(ctx.store, selector);
}

/** The Pine store of the chart tab this component lives in. */
export function usePine(): PineStore {
  const ctx = useContext(ChartContext);
  if (!ctx) throw new Error('usePine outside a chart panel');
  return ctx.pine;
}

export function useChartId(): string {
  const ctx = useContext(ChartContext);
  if (!ctx) throw new Error('useChartId outside a chart panel');
  return ctx.id;
}

/** The chart tab that currently has focus, for the header and the side panels. Undefined before any chart exists. */
export function useActiveChart<T>(selector: (s: ChartState) => T): T | undefined {
  const id = useApp((s) => s.activeChartId);
  const [, force] = useReducer((x: number) => x + 1, 0);
  const store = chartRegistry.get(id);
  useEffect(() => {
    if (!store) return;
    return store.subscribe(force);
  }, [store]);
  return store ? selector(store.getState()) : undefined;
}

export function activeChartStore(): ChartStore | undefined {
  return chartRegistry.get(useApp.getState().activeChartId);
}
