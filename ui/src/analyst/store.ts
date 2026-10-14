import { create } from 'zustand';
import { api } from '../api';
import { chartRegistry } from '../chartStore';
import { velaRegistry } from '../chart/velaRegistry';
import { useApp } from '../store';
import type { AiEntry } from '../types';
import { chartJpeg } from './capture';
import { buildContext, gatherInput } from './gather';

const KEY = 'harvester.analyst.v1';

interface Prefs {
  model: string;
  includeImage: boolean;
  showOnChart: boolean;
}

function loadPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) return { model: 'claude-sonnet-5-5', includeImage: true, showOnChart: true, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    /* defaults */
  }
  return { model: 'claude-sonnet-5-5', includeImage: true, showOnChart: true };
}

interface AnalystStore extends Prefs {
  /** the latest analysis of each symbol */
  latest: Record<string, AiEntry>;
  running: boolean;
  error: string;
  setPrefs: (p: Partial<Prefs>) => void;
  setLatest: (entries: AiEntry[]) => void;
  /** analyse the chart that has focus */
  run: (note?: string) => Promise<void>;
}

export const useAnalyst = create<AnalystStore>((set, get) => ({
  ...loadPrefs(),
  latest: {},
  running: false,
  error: '',
  setPrefs: (p) =>
    set((s) => {
      const next = { model: s.model, includeImage: s.includeImage, showOnChart: s.showOnChart, ...p };
      try {
        window.localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* not remembered */
      }
      return next;
    }),
  setLatest: (entries) =>
    set((s) => {
      const latest = { ...s.latest };
      // entries come newest first: keep the newest of each symbol
      for (const e of [...entries].reverse()) latest[e.symbol] = e;
      return { latest };
    }),
  run: async (note) => {
    if (get().running) return;
    const chartId = useApp.getState().activeChartId;
    const store = chartRegistry.get(chartId);
    if (!store) {
      set({ error: 'Open a chart first.' });
      return;
    }
    const { symbol, timeframe, markPrice } = store.getState();
    set({ running: true, error: '' });
    try {
      const input = await gatherInput(symbol, timeframe, note);
      const chart = velaRegistry.get(chartId);
      const image = get().includeImage && chart ? chartJpeg(chart) : null;
      const price = markPrice || input.frames[0].candles[input.frames[0].candles.length - 1].close;
      const entry = await api.aiAnalyze({ model: get().model, symbol, timeframe, price, context: buildContext(input), image });
      set((s) => ({ latest: { ...s.latest, [symbol]: entry }, running: false }));
    } catch (e) {
      set({ running: false, error: String(e) });
    }
  },
}));
