import { describe, expect, it } from 'vitest';
import { buildPanes, cmf, obv, trix } from '../src/mobile/indicators';
import type { Kline } from '../src/types';

const k = (i: number, o: number, h: number, l: number, c: number, v = 100): Kline => ({ time: i * 60_000, open: o, high: h, low: l, close: c, volume: v });

describe('phone chart indicators', () => {
  it('obv adds the volume on up closes and subtracts it on down closes', () => {
    expect(obv([k(0, 1, 1, 1, 10, 5), k(1, 1, 1, 1, 11, 7), k(2, 1, 1, 1, 9, 3), k(3, 1, 1, 1, 9, 4)])).toEqual([0, 7, 4, 4]);
  });
  it('cmf is +1 when every candle closes at its high and -1 at its low', () => {
    const up = Array.from({ length: 25 }, (_, i) => k(i, 1, 2, 1, 2));
    const down = Array.from({ length: 25 }, (_, i) => k(i, 2, 2, 1, 1));
    expect(cmf(up, 20)[24]).toBeCloseTo(1);
    expect(cmf(down, 20)[24]).toBeCloseTo(-1);
    expect(cmf(up, 20)[18]).toBeNull();
  });
  it('trix is positive in a steady rise and zero in a flat market', () => {
    const rising = Array.from({ length: 80 }, (_, i) => 100 + i);
    const flat = Array.from({ length: 80 }, () => 100);
    const r = trix(rising).trix;
    expect(r[79]).toBeGreaterThan(0);
    expect(trix(flat).trix[79]).toBe(0);
  });
  it('builds a pane for each chosen indicator only', () => {
    const candles = Array.from({ length: 60 }, (_, i) => k(i, 1, 2, 1, 1 + (i % 5)));
    expect(buildPanes(candles, {}).length).toBe(0);
    expect(buildPanes(candles, { rsi: true, macd: true, volume: true, sma: true }).map((p) => p.key)).toEqual(['macd', 'rsi']);
  });
});
