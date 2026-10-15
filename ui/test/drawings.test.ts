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

import { hitDistance, rayDistance, segmentDistance } from '../src/mobile/drawings';

describe('hitting drawings', () => {
  it('measures the distance to a segment and a ray', () => {
    expect(segmentDistance({ x: 0, y: 0 }, { x: 10, y: 0 }, 5, 3)).toBe(3);
    expect(segmentDistance({ x: 0, y: 0 }, { x: 10, y: 0 }, 14, 3)).toBe(5); // beyond the end: to the end point
    expect(rayDistance({ x: 0, y: 0 }, { x: 10, y: 0 }, 14, 3)).toBe(3); // a ray goes on
    expect(rayDistance({ x: 0, y: 0 }, { x: 10, y: 0 }, -4, 3)).toBe(5); // but not backwards
  });
  it('hits lines, rectangle edges and fibonacci levels, not the inside of a rectangle', () => {
    const a = { x: 10, y: 10 };
    const b = { x: 110, y: 60 };
    expect(hitDistance('hline', a, b, 50, 14, 300)).toBe(4);
    expect(hitDistance('rect', a, b, 60, 10, 300)).toBe(0);
    expect(hitDistance('rect', a, b, 60, 35, 300)).toBeGreaterThan(20); // inside: free to pan
    expect(hitDistance('fib', a, b, 200, 40, 300, [10, 40, 60])).toBe(0);
  });
});
