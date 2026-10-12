import { create } from 'zustand';

/** How the bases are found and drawn. One setting for every chart tab, remembered between runs. */
export interface BasesConfig {
  on: boolean;
  /** a base needs a pump of at least this many times the coin's normal candle move: higher = fewer, bigger bases */
  factor: number;
  /** a crack is a break this far below the base, percent */
  crackPct: number;
  /** draw the bases price already broke through */
  showBroken: boolean;
  /** only bases within this % of the price (0 = all) */
  maxDistancePct: number;
  /** draw at most this many, the ones nearest to the price (0 = all) */
  maxCount: number;
  /** how many candles a line runs to the right of its base (0 = no limit: a ray to the edge of the chart) */
  lengthCandles: number;
  /** bases within this % of each other are merged into one line (0 = never merge) */
  mergePct: number;
}

export const DEFAULT_BASES: BasesConfig = { on: true, factor: 3.5, crackPct: 0.5, showBroken: false, maxDistancePct: 15, maxCount: 8, lengthCandles: 30, mergePct: 0.5 };

const KEY = 'harvester.bases.v5';

function load(): BasesConfig {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_BASES, ...(JSON.parse(raw) as Partial<BasesConfig>) };
  } catch {
    /* use the defaults */
  }
  return DEFAULT_BASES;
}

interface BasesStore {
  cfg: BasesConfig;
  change: (patch: Partial<BasesConfig>) => void;
}

export const useBases = create<BasesStore>((set) => ({
  cfg: load(),
  change: (patch) =>
    set((s) => {
      const cfg = { ...s.cfg, ...patch };
      try {
        window.localStorage.setItem(KEY, JSON.stringify(cfg));
      } catch {
        /* not remembered */
      }
      return { cfg };
    }),
}));
