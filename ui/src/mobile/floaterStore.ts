import { create } from 'zustand';
import type { Side } from '../types';

/** The order being set up with the press-and-hold dock. Shared by the dock and the chart, which draws its lines and their handles. */
export interface FloaterData {
  /** a new number for every press: a new press starts the dock afresh */
  id: number;
  /** the entry price */
  price: number;
  side: Side;
  /** the SL / TP buttons: an exit is part of the order only when its button is pressed */
  useSl: boolean;
  useTp: boolean;
  /** a price or a percentage, measured from the entry */
  sl: string;
  tp: string;
  /** where the finger was, in the coordinates of the chart tab */
  y: number;
}

const KEY = 'harvester.mobile.order.v1';

/** What is remembered between orders: the exits and the amount, so a trader who always trades the same way rarely opens the settings. */
interface Saved {
  sl: string;
  tp: string;
  useSl: boolean;
  useTp: boolean;
  pct: number;
}

const DEFAULTS: Saved = { sl: '1%', tp: '2%', useSl: false, useTp: false, pct: 5 };

export function loadSaved(): Saved {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as Partial<Saved> | null;
    if (v) {
      return {
        sl: typeof v.sl === 'string' && v.sl ? v.sl : DEFAULTS.sl,
        tp: typeof v.tp === 'string' && v.tp ? v.tp : DEFAULTS.tp,
        useSl: !!v.useSl,
        useTp: !!v.useTp,
        pct: typeof v.pct === 'number' && v.pct >= 0 && v.pct <= 100 ? v.pct : DEFAULTS.pct,
      };
    }
  } catch {
    /* defaults */
  }
  return { ...DEFAULTS };
}

export function save(patch: Partial<Saved>): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...loadSaved(), ...patch }));
  } catch {
    /* not remembered */
  }
}

interface FloaterStore {
  f: FloaterData | null;
  open: (price: number, side: Side, y: number) => void;
  patch: (p: Partial<FloaterData>) => void;
  close: () => void;
}

export const useFloater = create<FloaterStore>((set) => ({
  f: null,
  open: (price, side, y) => {
    const s = loadSaved();
    set({ f: { id: Date.now(), price, side, useSl: s.useSl, useTp: s.useTp, sl: s.sl, tp: s.tp, y } });
  },
  patch: (p) => {
    set((s) => (s.f ? { f: { ...s.f, ...p } } : s));
    // the exits are remembered for the next order
    const keep: Partial<Saved> = {};
    if (p.sl !== undefined) keep.sl = p.sl;
    if (p.tp !== undefined) keep.tp = p.tp;
    if (p.useSl !== undefined) keep.useSl = p.useSl;
    if (p.useTp !== undefined) keep.useTp = p.useTp;
    if (Object.keys(keep).length) save(keep);
  },
  close: () => set({ f: null }),
}));
