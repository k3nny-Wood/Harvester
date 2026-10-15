/** Chart drawings of the phone chart: points are (time, price) so they stay put when the chart is panned, zoomed or switched to another timeframe. */

export type Tool = 'cursor' | 'trend' | 'ray' | 'hline' | 'rect' | 'fib' | 'measure';
export type DrawKind = Exclude<Tool, 'cursor' | 'measure'>;

export interface DrawPoint {
  t: number;
  p: number;
}

export interface Drawing {
  id: number;
  kind: DrawKind;
  a: DrawPoint;
  b: DrawPoint;
}

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

/** The (fractional) position of a time among the candle open times; before the first / after the last candle the spacing `span` continues. */
export function indexOfTime(times: number[], t: number, span: number): number {
  const n = times.length;
  if (n === 0) return 0;
  if (t <= times[0]) return (t - times[0]) / span;
  if (t >= times[n - 1]) return n - 1 + (t - times[n - 1]) / span;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const gap = times[lo + 1] - times[lo];
  return lo + (gap > 0 ? (t - times[lo]) / gap : 0);
}

/** The inverse of `indexOfTime`. */
export function timeOfIndex(times: number[], idx: number, span: number): number {
  const n = times.length;
  if (n === 0) return 0;
  if (idx <= 0) return times[0] + idx * span;
  if (idx >= n - 1) return times[n - 1] + (idx - (n - 1)) * span;
  const lo = Math.floor(idx);
  return times[lo] + (idx - lo) * (times[lo + 1] - times[lo]);
}

/** The candle spacing in ms. */
export function spanOf(times: number[]): number {
  const n = times.length;
  return n >= 2 ? Math.max(1, times[n - 1] - times[n - 2]) : 60_000;
}

/** A line through two points continued to `x` (a ray): the y at that x. */
export function rayY(x0: number, y0: number, x1: number, y1: number, x: number): number {
  return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}

/** Fibonacci retracement prices: level 0 at the second point, 1 at the first. */
export function fibPrices(a: number, b: number): Array<{ level: number; price: number }> {
  return FIB_LEVELS.map((level) => ({ level, price: b + (a - b) * level }));
}

/** The label of a measurement between two points. */
export function measureText(a: DrawPoint, b: DrawPoint, span: number): string {
  const pct = a.p > 0 ? ((b.p - a.p) / a.p) * 100 : 0;
  const bars = Math.round((b.t - a.t) / span);
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% · ${Math.abs(bars)} bars`;
}

const KEY = 'harvester.mobile.draw.v1';

function loadAll(): Record<string, Drawing[]> {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as Record<string, Drawing[]> | null;
    if (v && typeof v === 'object') return v;
  } catch {
    /* none */
  }
  return {};
}

export function loadDrawings(symbol: string): Drawing[] {
  const list = loadAll()[symbol];
  return Array.isArray(list) ? list.filter((d) => d && d.a && d.b && typeof d.a.t === 'number') : [];
}

export function saveDrawings(symbol: string, list: Drawing[]): void {
  try {
    const all = loadAll();
    if (list.length) all[symbol] = list;
    else delete all[symbol];
    window.localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* not remembered */
  }
}

export interface Px {
  x: number;
  y: number;
}

/** The distance from (x, y) to the segment a-b, in pixels. */
export function segmentDistance(a: Px, b: Px, x: number, y: number): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
}

/** The distance from (x, y) to the ray that starts at a and goes through b (forever on that side). */
export function rayDistance(a: Px, b: Px, x: number, y: number): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / len2);
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
}

/**
 * How far a finger at (x, y) is from a drawing, in pixels (Infinity when it is nowhere near). `a` and `b` are the drawing's points on screen,
 * `fibYs` the screen heights of a Fibonacci drawing's levels. Rectangles count only near their edges, so a rectangle never blocks panning inside it.
 */
export function hitDistance(kind: DrawKind, a: Px, b: Px, x: number, y: number, plotW: number, fibYs: number[] = []): number {
  if (kind === 'trend') return segmentDistance(a, b, x, y);
  if (kind === 'ray') return rayDistance(a, b, x, y);
  if (kind === 'hline') return x >= 0 && x <= plotW ? Math.abs(y - a.y) : Infinity;
  if (kind === 'rect') {
    const [l, r, t, bt] = [Math.min(a.x, b.x), Math.max(a.x, b.x), Math.min(a.y, b.y), Math.max(a.y, b.y)];
    return Math.min(segmentDistance({ x: l, y: t }, { x: r, y: t }, x, y), segmentDistance({ x: r, y: t }, { x: r, y: bt }, x, y), segmentDistance({ x: r, y: bt }, { x: l, y: bt }, x, y), segmentDistance({ x: l, y: bt }, { x: l, y: t }, x, y));
  }
  const left = Math.min(a.x, b.x);
  let best = segmentDistance(a, b, x, y);
  if (x >= left - 8 && x <= plotW) for (const fy of fibYs) best = Math.min(best, Math.abs(y - fy));
  return best;
}
