import { create } from 'zustand';

/** What the Smart Money overlay draws. One setting for every chart tab, remembered between runs. */
export interface SmcConfig {
  on: boolean;
  showFvg: boolean;
  showOrderBlocks: boolean;
  showBreakers: boolean;
  /** smallest fair value gap worth drawing, % of price */
  minFvgPct: number;
  /** at most this many of each kind, the newest */
  maxEach: number;
  /** how many candles a zone runs to the right of its confirming candle (0 = to the edge of the chart) */
  lengthCandles: number;
}

export const DEFAULT_SMC: SmcConfig = { on: false, showFvg: true, showOrderBlocks: true, showBreakers: false, minFvgPct: 0.5, maxEach: 6, lengthCandles: 60 };

const KEY = 'harvester.smc.v1';

function load(): SmcConfig {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SMC, ...(JSON.parse(raw) as Partial<SmcConfig>) };
  } catch {
    /* use the defaults */
  }
  return DEFAULT_SMC;
}

interface SmcStore {
  cfg: SmcConfig;
  change: (patch: Partial<SmcConfig>) => void;
}

export const useSmc = create<SmcStore>((set) => ({
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
