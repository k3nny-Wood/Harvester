import { describe, expect, it } from 'vitest';
import { atr, bollinger, ema, last, macd, rsi, sma, swings, volumeProfile } from '../src/analyst/indicators';
import type { Kline } from '../src/types';

const k = (i: number, o: number, h: number, l: number, c: number, v = 100): Kline => ({ time: i * 60_000, open: o, high: h, low: l, close: c, volume: v });

describe('moving averages', () => {
  it('sma averages the last n values and is null before that', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('ema is seeded with the first n values and then follows the closes', () => {
    const e = ema([1, 2, 3, 4, 5, 6], 3);
    expect(e.slice(0, 2)).toEqual([null, null]);
    expect(e[2]).toBe(2);
    // k = 0.5: 4*0.5 + 2*0.5 = 3, then 5*0.5 + 3*0.5 = 4
    expect(e[3]).toBe(3);
    expect(e[4]).toBe(4);
    expect(e[5]).toBe(5);
  });

  it('a series shorter than the period gives nothing', () => {
    expect(ema([1, 2], 5)).toEqual([null, null]);
    expect(last(ema([1, 2], 5))).toBeNull();
  });
});

describe('rsi', () => {
  it('a rising series is 100 and a falling one is 0', () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    const down = Array.from({ length: 30 }, (_, i) => 100 - i);
    expect(last(rsi(up))).toBe(100);
    expect(last(rsi(down))).toBeCloseTo(0, 6);
  });

  it('a flat-then-alternating series sits near 50', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1));
    const r = last(rsi(closes))!;
    expect(r).toBeGreaterThan(40);
    expect(r).toBeLessThan(60);
  });

  it('matches a hand-worked Wilder example', () => {
    // 14 changes: 7 gains of +1 and 7 losses of -1 -> avg gain = avg loss -> RSI 50 at index 14
    const closes = [100];
    for (let i = 0; i < 14; i++) closes.push(closes[i] + (i % 2 === 0 ? 1 : -1));
    expect(rsi(closes, 14)[14]).toBe(50);
  });
});

describe('macd, atr and bands', () => {
  it('macd line is the fast minus the slow ema, and the histogram the line minus its signal', () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 5 + i * 0.1);
    const m = macd(closes);
    const f = ema(closes, 12);
    const s = ema(closes, 26);
    const i = 60;
    expect(m.macd[i]).toBeCloseTo((f[i] as number) - (s[i] as number), 9);
    expect(m.hist[i]).toBeCloseTo((m.macd[i] as number) - (m.signal[i] as number), 9);
    expect(m.macd[10]).toBeNull();
  });

  it('atr of constant-range candles is that range', () => {
    const candles = Array.from({ length: 40 }, (_, i) => k(i, 100, 102, 98, 100));
    expect(last(atr(candles, 14))).toBeCloseTo(4, 9);
  });

  it('bollinger puts a close on the upper band at percentB 1', () => {
    const closes = [...Array.from({ length: 19 }, () => 100), 110];
    const b = bollinger(closes)!;
    expect(b.percentB).toBeGreaterThan(0.8);
    expect(b.upper).toBeGreaterThan(b.mid);
    expect(bollinger([1, 2, 3])).toBeNull();
  });
});

describe('swings and volume profile', () => {
  it('finds the swing high and the swing low of a zig-zag', () => {
    const prices = [10, 11, 12, 13, 14, 15, 14, 13, 12, 11, 10, 9, 8, 9, 10, 11, 12, 13, 14, 15];
    const candles = prices.map((p, i) => k(i, p, p + 0.2, p - 0.2, p));
    const s = swings(candles, 3, 3);
    expect(s.find((x) => x.kind === 'high')?.price).toBeCloseTo(15.2);
    expect(s.find((x) => x.kind === 'low')?.price).toBeCloseTo(7.8);
  });

  it('the point of control is where the volume is, and the value area contains it', () => {
    const candles = [
      ...Array.from({ length: 10 }, (_, i) => k(i, 100, 101, 99, 100, 1000)),
      ...Array.from({ length: 10 }, (_, i) => k(10 + i, 110, 111, 109, 110, 10)),
    ];
    const vp = volumeProfile(candles, 20)!;
    expect(vp.poc).toBeGreaterThan(98);
    expect(vp.poc).toBeLessThan(102);
    expect(vp.val).toBeLessThanOrEqual(vp.poc);
    expect(vp.vah).toBeGreaterThanOrEqual(vp.poc);
    expect(volumeProfile([])).toBeNull();
  });
});
