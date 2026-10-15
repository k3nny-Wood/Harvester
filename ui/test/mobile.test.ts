import { describe, expect, it } from 'vitest';
import { fmtPrice, priceRange, windowOf, zoomed } from '../src/mobile/chartMath';
import { parseLevel, resolveExit } from '../src/mobile/exits';
import type { Kline } from '../src/types';

const k = (low: number, high: number): Kline => ({ time: 0, open: low, high, low, close: high, volume: 1 });

describe('stop-loss and take-profit levels typed on the phone', () => {
  it('reads a price or a percentage and refuses nonsense', () => {
    expect(parseLevel('95000')).toEqual({ kind: 'price', value: 95000 });
    expect(parseLevel(' 2% ')).toEqual({ kind: 'pct', value: 2 });
    expect(parseLevel('1,5%')).toEqual({ kind: 'pct', value: 1.5 });
    for (const bad of ['', 'abc', '-1', '0', '%', 'Infinity']) expect(parseLevel(bad), bad).toBeNull();
  });

  it('refuses an exit on the wrong side of the price', () => {
    const price = (kind: 'stop' | 'take', long: boolean, text: string) => {
      const r = resolveExit(kind, long, 100, parseLevel(text)!);
      return r.ok ? r.price : r.error;
    };
    expect(price('stop', true, '95')).toBe(95);
    expect(price('stop', true, '105')).toMatch(/below/);
    expect(price('take', true, '110')).toBe(110);
    expect(price('take', true, '99')).toMatch(/above/);
    expect(price('stop', false, '105')).toBe(105);
    expect(price('stop', false, '95')).toMatch(/above/);
    expect(price('take', false, '90')).toBe(90);
    // a percentage goes to the right side by itself
    expect(price('stop', true, '2%')).toBeCloseTo(98);
    expect(price('take', true, '5%')).toBeCloseTo(105);
    expect(price('stop', false, '2%')).toBeCloseTo(102);
    expect(price('take', false, '5%')).toBeCloseTo(95);
    expect(price('stop', true, '100%')).toMatch(/below 100/);
    expect(resolveExit('stop', true, 0, { kind: 'price', value: 1 }).ok).toBe(false);
  });
});

describe('the mobile chart maths', () => {
  it('keeps the window inside the data when panning and zooming', () => {
    expect(windowOf(300, 80, 0)).toMatchObject({ start: 220, end: 300, visible: 80, offset: 0 });
    expect(windowOf(300, 80, 50)).toMatchObject({ start: 170, end: 250 });
    // panned past the oldest candle: stops at the start
    expect(windowOf(300, 80, 9999)).toMatchObject({ start: 0, end: 80, offset: 220 });
    // panned past the newest: stops at the right edge
    expect(windowOf(300, 80, -20).offset).toBe(0);
    // zoomed in or out too far
    expect(windowOf(300, 3, 0).visible).toBe(12);
    expect(windowOf(300, 9999, 0).visible).toBe(300);
    // fewer candles than the minimum: shows what there is
    expect(windowOf(5, 80, 0)).toMatchObject({ start: 0, end: 5, visible: 5 });
  });

  it('draws lines near the candles in the range, and ignores far-away ones', () => {
    const candles = [k(100, 110), k(104, 120)];
    const near = priceRange(candles, [{ price: 98, label: 'stop', color: '#f00' }]);
    expect(near!.lo).toBeLessThan(98);
    const far = priceRange(candles, [{ price: 5, label: 'liq', color: '#f90' }]);
    expect(far!.lo).toBeGreaterThan(90);
    expect(priceRange([], [])).toBeNull();
  });

  it('zooms the opposite way to the finger distance and prints prices sensibly', () => {
    expect(zoomed(80, 100, 200)).toBe(40); // fingers apart: fewer candles
    expect(zoomed(80, 200, 100)).toBe(160);
    expect(zoomed(80, 0, 100)).toBe(80);
    expect(zoomed(80, 100, 10000)).toBe(12);
    expect(fmtPrice(81570.04)).toBe('81570.0');
    expect(fmtPrice(2.5)).toBe('2.5000');
    expect(fmtPrice(0.0123456)).toBe('0.01235');
  });
});
