import type { Kline, OpenOrder } from '../types';

export const MIN_VISIBLE = 12;
export const MAX_VISIBLE = 400;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Which candles are on screen: `visible` of them, ending `offset` candles before the newest (0 = the newest is at the right edge).
 * Both are kept inside what exists, so panning and zooming can never go past the data.
 */
export function windowOf(total: number, visible: number, offset: number): { start: number; end: number; visible: number; offset: number } {
  const v = clamp(Math.round(visible), Math.min(MIN_VISIBLE, Math.max(total, 1)), Math.max(Math.min(MAX_VISIBLE, total), 1));
  const off = clamp(Math.round(offset), 0, Math.max(0, total - v));
  const end = total - off;
  return { start: end - v, end, visible: v, offset: off };
}

export interface ChartLine {
  price: number;
  label: string;
  color: string;
  dashed?: boolean;
  /** present when the line is an order on the exchange that can be adjusted (double-tap it) */
  adjust?: { kind: 'sl' | 'tp' | 'order'; order: OpenOrder };
}

/**
 * The price range to draw: the candles in the window, widened by the horizontal lines that are close to them (a liquidation price far below
 * must not squash the candles into a strip), and by the prices in `always`, with a little room above and below.
 */
export function priceRange(candles: Kline[], lines: ChartLine[], always: number[] = []): { lo: number; hi: number } | null {
  if (!candles.length) return null;
  let lo = Math.min(...candles.map((c) => c.low));
  let hi = Math.max(...candles.map((c) => c.high));
  const span = Math.max(hi - lo, hi * 1e-4);
  for (const l of lines) {
    if (l.price >= lo - span * 0.8 && l.price <= hi + span * 0.8) {
      lo = Math.min(lo, l.price);
      hi = Math.max(hi, l.price);
    }
  }
  // the order being set up is always in view, wherever it is
  for (const p of always) {
    if (Number.isFinite(p) && p > 0) {
      lo = Math.min(lo, p);
      hi = Math.max(hi, p);
    }
  }
  const pad = Math.max(hi - lo, hi * 1e-4) * 0.06;
  return { lo: lo - pad, hi: hi + pad };
}

/** Zoom by a pinch: the candle count scales opposite to the finger distance (fingers apart = fewer, bigger candles). */
export function zoomed(visible: number, startDistance: number, distance: number): number {
  if (!(startDistance > 0) || !(distance > 0)) return visible;
  return clamp(visible * (startDistance / distance), MIN_VISIBLE, MAX_VISIBLE);
}

/** A price with the decimals it needs. */
export function fmtPrice(p: number): string {
  if (!Number.isFinite(p)) return '';
  const a = Math.abs(p);
  if (a >= 1000) return p.toFixed(1);
  if (a >= 1) return p.toFixed(4);
  if (a >= 0.01) return p.toFixed(5);
  return p.toFixed(7);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Timeframes whose labels are dates rather than times of day. */
function isDaily(timeframe: string): boolean {
  return timeframe === '1d' || timeframe === '3d' || timeframe === '1w' || timeframe === '1M';
}

/**
 * The labels of the time axis: about one for every `minGap` pixels, on candles whose position in the whole series is a multiple of the spacing,
 * so the labels stay on the same candles while the chart is panned or a new candle arrives. A label shows the time of day, or the date for the
 * first one, at a change of day and on daily charts. `startIndex` is the position of the first shown candle in the whole series.
 */
export function timeLabels(shown: Kline[], startIndex: number, plotW: number, timeframe: string, minGap = 78): Array<{ x: number; text: string }> {
  if (!shown.length || !(plotW > 0)) return [];
  const step = plotW / shown.length;
  const wanted = Math.max(1, Math.floor(plotW / minGap));
  const every = Math.max(1, Math.round(shown.length / wanted));
  const out: Array<{ x: number; text: string }> = [];
  let lastDay = '';
  shown.forEach((k, i) => {
    if ((startIndex + i) % every !== 0) return;
    const d = new Date(k.time);
    const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const date = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
    const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    out.push({ x: (i + 0.5) * step, text: isDaily(timeframe) || day !== lastDay ? date : clock });
    lastDay = day;
  });
  return out;
}
