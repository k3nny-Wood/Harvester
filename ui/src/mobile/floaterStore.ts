import { create } from 'zustand';
import type { Side } from '../types';

/** The order being set up with the press-and-hold box. Shared by the box and the chart, which draws its lines and their handles. */
export interface FloaterData {
  /** a new number for every press: a new press starts the box afresh */
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
  /** where the finger was, in the coordinates of the chart tab (a starting point for the box) */
  y: number;
}

interface FloaterStore {
  f: FloaterData | null;
  open: (price: number, side: Side, y: number) => void;
  patch: (p: Partial<FloaterData>) => void;
  close: () => void;
}

export const useFloater = create<FloaterStore>((set) => ({
  f: null,
  open: (price, side, y) => set({ f: { id: Date.now(), price, side, useSl: false, useTp: false, sl: '1%', tp: '2%', y } }),
  patch: (p) => set((s) => (s.f ? { f: { ...s.f, ...p } } : s)),
  close: () => set({ f: null }),
}));
