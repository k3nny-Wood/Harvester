import { describe, expect, it } from 'vitest';
import { fmtPrice, priceRange, timeLabels, windowOf, zoomed } from '../src/mobile/chartMath';
import { exitsWait, parseLevel, pctText, resolveBoth, resolveExit } from '../src/mobile/exits';
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

describe('optional stop-loss and take-profit', () => {
  it('only the exits that are switched on are worked out', () => {
    const r = resolveBoth(true, 100, { on: true, text: '2%' }, { on: false, text: '5%' });
    expect(r.sl).toMatchObject({ ok: true });
    expect(r.tp).toBeNull();
    const bad = resolveBoth(true, 100, { on: true, text: 'abc' }, { on: true, text: '99' });
    expect(bad.sl).toMatchObject({ ok: false });
    expect(bad.tp).toMatchObject({ ok: false }); // a take-profit below a long's entry
    const both = resolveBoth(false, 100, { on: true, text: '1%' }, { on: true, text: '2%' });
    expect(both.sl).toMatchObject({ ok: true, price: expect.closeTo(101) });
    expect(both.tp).toMatchObject({ ok: true, price: expect.closeTo(98) });
  });

  it('an exit waits when it is on the wrong side of the current price', () => {
    // a long limit entry below the market: its take-profit is still below the market
    expect(exitsWait(true, 100, 95, 98)).toBe(true);
    expect(exitsWait(true, 100, 95, 105)).toBe(false);
    expect(exitsWait(true, 100, 105, null)).toBe(true); // a stop above the price
    expect(exitsWait(true, 100, null, null)).toBe(false);
    expect(exitsWait(false, 100, 105, 95)).toBe(false);
    expect(exitsWait(false, 100, 95, 98)).toBe(true);
  });

  it('a dragged line becomes a percentage, never smaller than the least step', () => {
    expect(pctText(100, 102.5)).toBe('2.5%');
    expect(pctText(100, 98.123)).toBe('1.88%');
    expect(pctText(100, 100)).toBe('0.05%');
    expect(pctText(0, 5)).toBe('1%');
  });

  it('the price range always holds the order being set up', () => {
    const candles = [k(100, 110), k(104, 120)];
    const r = priceRange(candles, [], [150, 60]);
    expect(r!.hi).toBeGreaterThan(150);
    expect(r!.lo).toBeLessThan(60);
  });
});

describe('the time axis', () => {
  const at = (h: number, m: number, d = 15): Kline => ({ time: new Date(2026, 9, d, h, m).getTime(), open: 1, high: 1, low: 1, close: 1, volume: 1 });
  const series = (n: number, startMinute = 0): Kline[] => Array.from({ length: n }, (_, i) => at(0, 0).time + (startMinute + i) * 15 * 60_000).map((time) => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1 }));

  it('puts about one label per 78 px, the first with its date and the rest with the time of day', () => {
    const labels = timeLabels(series(60), 0, 312, '15m');
    expect(labels.length).toBe(4);
    expect(labels[0].text).toBe('15 Oct');
    expect(labels.slice(1).every((l) => /^\d\d:\d\d$/.test(l.text))).toBe(true);
    // evenly spread inside the plot
    expect(labels.every((l) => l.x > 0 && l.x < 312)).toBe(true);
  });

  it('shows the date again when the day changes, and always on daily charts', () => {
    const across = timeLabels(series(80, 56), 0, 320, '15m'); // from 14:00 for 20 hours: crosses midnight
    expect(across.some((l, i) => i > 0 && /Oct/.test(l.text))).toBe(true);
    const daily = timeLabels(series(40), 0, 320, '1d');
    expect(daily.every((l) => /^\d+ [A-Z][a-z]{2}$/.test(l.text))).toBe(true);
  });

  it('keeps each label on the same candle while the chart is panned', () => {
    const all = series(120);
    const a = timeLabels(all.slice(20, 80), 20, 312, '15m');
    const b = timeLabels(all.slice(24, 84), 24, 312, '15m');
    const times = (labels: ReturnType<typeof timeLabels>, from: number) => labels.map((l) => from + Math.round(l.x / (312 / 60) - 0.5));
    const shared = times(a, 20).filter((i) => times(b, 24).includes(i));
    expect(shared.length).toBeGreaterThanOrEqual(2);
    expect(timeLabels([], 0, 300, '15m')).toEqual([]);
  });
});
