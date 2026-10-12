import { create } from 'zustand';
import type { MoverParams } from './types';

/** The pump / dump watcher's settings (the same defaults as the Rust side), remembered between runs and sent to the backend on start. */
export const DEFAULT_MOVERS: MoverParams = {
  rules: [
    { secs: 60, minPct: 1.5 },
    { secs: 300, minPct: 3 },
    { secs: 900, minPct: 5 },
  ],
  normalMultiple: 5,
  minQuoteVolume: 3_000_000,
  cooldownSecs: 600,
  warmupSecs: 180,
};

const KEY = 'harvester.movers.v1';

function load(): MoverParams {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<MoverParams>;
      return { ...DEFAULT_MOVERS, ...p, rules: Array.isArray(p.rules) && p.rules.length ? p.rules : DEFAULT_MOVERS.rules };
    }
  } catch {
    /* use the defaults */
  }
  return DEFAULT_MOVERS;
}

interface MoversStore {
  params: MoverParams;
  change: (patch: Partial<MoverParams>) => void;
  setRule: (index: number, minPct: number) => void;
}

export const useMovers = create<MoversStore>((set) => ({
  params: load(),
  change: (patch) =>
    set((s) => {
      const params = { ...s.params, ...patch };
      try {
        window.localStorage.setItem(KEY, JSON.stringify(params));
      } catch {
        /* not remembered */
      }
      return { params };
    }),
  setRule: (index, minPct) =>
    set((s) => {
      const params = { ...s.params, rules: s.params.rules.map((r, i) => (i === index ? { ...r, minPct } : r)) };
      try {
        window.localStorage.setItem(KEY, JSON.stringify(params));
      } catch {
        /* not remembered */
      }
      return { params };
    }),
}));

/** The windows as labels: 60 -> "1m", 900 -> "15m". */
export function windowLabel(secs: number): string {
  return secs % 60 === 0 ? `${secs / 60}m` : `${secs}s`;
}
