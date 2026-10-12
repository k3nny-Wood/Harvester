import type { OHLCV } from '@luxalgo/vela';

/** Binance serves at most this many klines per request. */
export const CHUNK = 1500;
/** The deepest history a chart loads on its own by panning / zooming out. */
export const MAX_BARS = 30_000;
/** How many bars a fresh chart loads. */
export const START_BARS = 400;

type Fetch = (limit: number, from?: number, to?: number) => Promise<OHLCV[]>;

function tidy(rows: OHLCV[]): OHLCV[] {
  const byTime = new Map<number, OHLCV>();
  for (const r of rows) byTime.set(r.time, r);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * Bars for a request of any size. One Binance call returns at most 1500, so a bigger window is fetched in pieces:
 * a window with a start walks forward from it, an open-ended request walks backward from `to` (default: now) until `limit` bars.
 */
export async function fetchBars(fetchChunk: Fetch, range: { from?: number; to?: number; limit?: number }): Promise<OHLCV[]> {
  const limit = Math.max(10, range.limit ?? 500);
  if (range.from != null) {
    const out: OHLCV[] = [];
    let cursor = range.from;
    for (let i = 0; i < 40; i++) {
      const rows = await fetchChunk(CHUNK, cursor, range.to);
      out.push(...rows);
      if (rows.length < CHUNK || (range.to == null && out.length >= limit)) break;
      const next = rows[rows.length - 1].time + 1;
      if (next <= cursor) break;
      cursor = next;
    }
    return tidy(out);
  }
  if (limit <= CHUNK) return tidy(await fetchChunk(limit, undefined, range.to));
  let out: OHLCV[] = [];
  let end = range.to;
  for (let i = 0; i < 40 && out.length < limit; i++) {
    const rows = await fetchChunk(Math.min(CHUNK, limit - out.length), undefined, end);
    if (!rows.length) break;
    out = tidy([...rows, ...out]);
    if (rows.length < Math.min(CHUNK, limit - out.length + rows.length)) break; // the exchange has nothing older
    end = out[0].time - 1;
  }
  return out;
}

/**
 * How many bars the chart should hold once the user has panned / zoomed so that `from` is on screen, or null when no deeper load is needed.
 * `oldest` is the open time of the oldest bar held, `loaded` how many bars it holds, `span` the visible width (ms), `barMs` one candle.
 */
export function deeperTarget(view: { from: number; to: number }, oldest: number, loaded: number, barMs: number, now: number): number | null {
  if (!(oldest > 0) || !(barMs > 0) || loaded >= MAX_BARS) return null;
  const span = Math.max(barMs, view.to - view.from);
  // the left edge of the view is within a tenth of a screen of the oldest bar (or beyond it)
  if (view.from > oldest + span * 0.1) return null;
  const needed = Math.ceil((now - (view.from - span)) / barMs);
  const target = Math.max(Math.ceil(loaded * 2), needed);
  return Math.min(MAX_BARS, target) > loaded ? Math.min(MAX_BARS, target) : null;
}
