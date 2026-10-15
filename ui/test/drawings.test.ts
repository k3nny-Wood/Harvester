import { describe, expect, it } from 'vitest';
import { fibPrices, indexOfTime, measureText, rayY, spanOf, timeOfIndex } from '../src/mobile/drawings';

const times = [1000, 2000, 3000, 4000];

describe('drawings', () => {
  it('maps times to candle positions and back', () => {
    expect(indexOfTime(times, 2500, 1000)).toBeCloseTo(1.5);
    expect(indexOfTime(times, 4000, 1000)).toBe(3);
    expect(indexOfTime(times, 6000, 1000)).toBe(5); // the future continues at the candle spacing
    expect(indexOfTime(times, 0, 1000)).toBe(-1);
    for (const t of [500, 1000, 2500, 3999, 7000]) expect(timeOfIndex(times, indexOfTime(times, t, 1000), 1000)).toBeCloseTo(t);
  });
  it('knows the spacing', () => {
    expect(spanOf(times)).toBe(1000);
    expect(spanOf([5])).toBe(60_000);
  });
  it('continues a ray', () => {
    expect(rayY(0, 0, 10, 5, 20)).toBe(10);
    expect(rayY(3, 7, 3, 9, 50)).toBe(9);
  });
  it('computes the fibonacci levels', () => {
    const f = fibPrices(100, 200);
    expect(f[0]).toEqual({ level: 0, price: 200 });
    expect(f[f.length - 1]).toEqual({ level: 1, price: 100 });
    expect(f.find((x) => x.level === 0.5)?.price).toBe(150);
  });
  it('words a measurement', () => {
    expect(measureText({ t: 0, p: 100 }, { t: 5000, p: 110 }, 1000)).toBe('+10.00% · 5 bars');
  });
});
