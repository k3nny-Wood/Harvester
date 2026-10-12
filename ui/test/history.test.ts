import { describe, expect, it } from 'vitest';
import type { OHLCV } from '@luxalgo/vela';
import { CHUNK, deeperTarget, fetchBars, MAX_BARS } from '../src/chart/history';

const MIN = 60_000;
const bar = (t: number): OHLCV => ({ time: t, open: 1, high: 1, low: 1, close: 1, volume: 1 });

/** A fake exchange with candles at every minute from t=0 to t=total-1 minutes, answering like Binance (max 1500). */
function exchange(total: number) {
  const calls: Array<[number, number | undefined, number | undefined]> = [];
  const fetchChunk = async (limit: number, from?: number, to?: number): Promise<OHLCV[]> => {
    calls.push([limit, from, to]);
    const lo = from ?? 0;
    const hi = Math.min(to ?? Infinity, (total - 1) * MIN);
    const all: OHLCV[] = [];
    for (let t = Math.ceil(lo / MIN) * MIN; t <= hi; t += MIN) all.push(bar(t));
    // without a start Binance returns the NEWEST `limit` bars up to `to`; with one it returns the first `limit` from it
    return from == null ? all.slice(-Math.min(limit, CHUNK)) : all.slice(0, Math.min(limit, CHUNK));
  };
  return { fetchChunk, calls };
}

describe('fetching bars in pieces', () => {
  it('a small request is one call', async () => {
    const ex = exchange(5000);
    const rows = await fetchBars(ex.fetchChunk, { limit: 400 });
    expect(rows).toHaveLength(400);
    expect(ex.calls).toHaveLength(1);
  });

  it('a window wider than 1500 bars is joined without a gap', async () => {
    const ex = exchange(6000);
    const rows = await fetchBars(ex.fetchChunk, { from: 1000 * MIN, to: 4999 * MIN, limit: 4000 });
    expect(rows).toHaveLength(4000);
    expect(rows[0].time).toBe(1000 * MIN);
    for (let i = 1; i < rows.length; i++) expect(rows[i].time - rows[i - 1].time).toBe(MIN);
  });

  it('a deep open-ended request walks backward and stops at the start of the market', async () => {
    const ex = exchange(3200);
    const rows = await fetchBars(ex.fetchChunk, { limit: 10_000 });
    expect(rows).toHaveLength(3200);
    expect(rows[0].time).toBe(0);
    for (let i = 1; i < rows.length; i++) expect(rows[i].time - rows[i - 1].time).toBe(MIN);
  });

  it('a deep request with an exact size returns exactly that many newest bars', async () => {
    const ex = exchange(9000);
    const rows = await fetchBars(ex.fetchChunk, { limit: 4000 });
    expect(rows).toHaveLength(4000);
    expect(rows[rows.length - 1].time).toBe(8999 * MIN);
  });
});

describe('when to load older candles', () => {
  const barMs = 15 * MIN;
  const now = 1_000_000 * barMs;
  const oldest = now - 400 * barMs;

  it('does nothing while the view is well inside the loaded history', () => {
    expect(deeperTarget({ from: now - 100 * barMs, to: now }, oldest, 400, barMs, now)).toBeNull();
  });

  it('loads deeper when the left edge reaches the oldest bar, or passes it (zooming out)', () => {
    expect(deeperTarget({ from: oldest + barMs, to: now }, oldest, 400, barMs, now)).toBeGreaterThan(400);
    expect(deeperTarget({ from: oldest - 200 * barMs, to: now }, oldest, 400, barMs, now)!).toBeGreaterThanOrEqual(800);
  });

  it('asks for enough bars to cover a far-left view and never more than the cap', () => {
    const far = deeperTarget({ from: now - 5000 * barMs, to: now - 4000 * barMs }, oldest, 400, barMs, now)!;
    expect(far).toBeGreaterThanOrEqual(5000);
    expect(deeperTarget({ from: 0, to: now }, oldest, 400, barMs, now)).toBe(MAX_BARS);
    expect(deeperTarget({ from: 0, to: now }, oldest, MAX_BARS, barMs, now)).toBeNull();
  });

  it('waits until the oldest bar is known', () => {
    expect(deeperTarget({ from: 0, to: now }, 0, 400, barMs, now)).toBeNull();
  });
});
