import type { BaseView } from './types';

/**
 * Combine bases that sit at nearly the same price into one. Old and new bases at a similar level are the same support: the line
 * starts where the earliest one formed, sits at the average price, and `count` says how many were merged.
 *
 * Only bases that still hold are merged (a broken base is a separate, finished event). Clusters are anchored on their lowest price,
 * so a chain of slowly rising bases cannot drift into one giant line.
 */
export function mergeBases(bases: BaseView[], tolerancePct: number): BaseView[] {
  const holding = bases.filter((b) => b.crackTime == null).sort((a, b) => a.price - b.price);
  const others = bases.filter((b) => b.crackTime != null);
  if (tolerancePct <= 0) return bases.map((b) => ({ ...b, count: b.count ?? 1 }));
  const clusters: BaseView[][] = [];
  for (const b of holding) {
    const current = clusters[clusters.length - 1];
    if (current && b.price <= current[0].price * (1 + tolerancePct / 100)) current.push(b);
    else clusters.push([b]);
  }
  const merged: BaseView[] = clusters.map((c) => {
    const n = c.length;
    return {
      price: c.reduce((s, b) => s + b.price, 0) / n,
      time: Math.min(...c.map((b) => b.time)),
      confirmTime: Math.min(...c.map((b) => b.confirmTime)),
      crackTime: null,
      crackLevel: c.reduce((s, b) => s + b.crackLevel, 0) / n,
      count: n,
    };
  });
  return [...merged, ...others.map((b) => ({ ...b, count: 1 }))].sort((a, b) => a.time - b.time);
}

export interface PreviewLine {
  price: number;
  /** index of the first candle the line covers */
  from: number;
  /** index of the last candle it covers; undefined = to the right edge */
  to?: number;
  color: string;
  width: number;
  dash: number[];
  label: string;
}

const BLUE = '#4f8fdd';
const BRIGHT = '#7cc0ff';
const AMBER = '#e0a33d';
const DIM = 'rgba(79, 143, 221, 0.45)';

/**
 * Lines for the big hover preview: every base that holds as a line from its candle to the right, its crack level dotted, merged bases
 * labelled with how many they combine, broken bases as dim lines that end at the crack, and the signal's own base brighter and
 * labelled (a crack signal is about a base price has already broken).
 */
export function previewLines(candles: Array<{ time: number }>, bases: BaseView[], ownBase: number | null | undefined, fmt: (p: number) => string): PreviewLine[] {
  const out: PreviewLine[] = [];
  const index = (t: number) => {
    const i = candles.findIndex((c) => c.time >= t);
    return i < 0 ? candles.length - 1 : i;
  };
  for (const b of bases) {
    const own = ownBase != null && ownBase > 0 && Math.abs(b.price / ownBase - 1) < 0.003;
    if (b.crackTime != null) {
      // finished history: a dim segment from the base to the candle that cracked it (the signal's own one brighter, with its crack level)
      out.push({ price: b.price, from: index(b.time), to: index(b.crackTime), color: own ? BRIGHT : DIM, width: own ? 2.5 : 1, dash: own ? [] : [4, 3], label: own ? `this base ${fmt(b.price)}` : '' });
      if (own) out.push({ price: b.crackLevel, from: index(b.confirmTime), to: index(b.crackTime), color: AMBER, width: 1, dash: [2, 3], label: '' });
      continue;
    }
    const n = b.count ?? 1;
    out.push({ price: b.price, from: index(b.time), color: own ? BRIGHT : BLUE, width: own ? 2.5 : n > 1 ? 2 : 1.4, dash: [], label: `${own ? 'this base ' : ''}${fmt(b.price)}${n > 1 ? ` ×${n}` : ''}` });
    out.push({ price: b.crackLevel, from: index(b.confirmTime), color: AMBER, width: 1, dash: [2, 3], label: '' });
  }
  return out;
}
