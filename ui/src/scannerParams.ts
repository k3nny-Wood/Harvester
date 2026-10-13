import { create } from 'zustand';
import type { SignalParams } from './types';

/** The scanner's rules (the same defaults as the Rust side), remembered between runs and sent to the running scanner when they change. */
export const DEFAULT_SCANNER_PARAMS: SignalParams = {
  qfl: { volatilityFactor: 1, crackPct: 0.005, useManual: false, manualMovePct: 0.03 },
  freshBars: 8,
  nearPct: 1,
  dropWindow: 24,
  dropMinPct: 3,
  dropMinMultiple: 2,
  donchLen: 288,
  thumbBars: 72,
};

const KEY = 'harvester.scannerParams.v1';

function load(): SignalParams {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<SignalParams>;
      return { ...DEFAULT_SCANNER_PARAMS, ...p, qfl: { ...DEFAULT_SCANNER_PARAMS.qfl, ...(p.qfl ?? {}) } };
    }
  } catch {
    /* defaults */
  }
  return DEFAULT_SCANNER_PARAMS;
}

interface ScannerParamsStore {
  params: SignalParams;
  change: (patch: Partial<Omit<SignalParams, 'qfl'>> & { qfl?: Partial<SignalParams['qfl']> }) => void;
  reset: () => void;
}

function save(params: SignalParams) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(params));
  } catch {
    /* not remembered */
  }
}

export const useScannerParams = create<ScannerParamsStore>((set) => ({
  params: load(),
  change: (patch) =>
    set((s) => {
      const params = { ...s.params, ...patch, qfl: { ...s.params.qfl, ...(patch.qfl ?? {}) } };
      save(params);
      return { params };
    }),
  reset: () => {
    save(DEFAULT_SCANNER_PARAMS);
    set({ params: DEFAULT_SCANNER_PARAMS });
  },
}));
