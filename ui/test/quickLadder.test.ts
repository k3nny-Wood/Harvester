import { describe, expect, it } from 'vitest';
import { averagePrice, ladderRungs, rungWeights } from '../src/chart/quickLadder';

describe('quick order ladder', () => {
  it('weights add up to one', () => {
    for (const mode of ['equal', 'up', 'down'] as const) {
      expect(rungWeights(5, mode).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    }
    const up = rungWeights(4, 'up');
    expect(up[3]).toBeGreaterThan(up[0]);
    const down = rungWeights(4, 'down');
    expect(down[0]).toBeGreaterThan(down[3]);
  });

  it('spreads the rungs evenly from the entry to the end, both included', () => {
    const r = ladderRungs(100, 96, 5, 'equal', 10, 0.01, 0.001);
    expect(r.map((x) => x.price)).toEqual([100, 99, 98, 97, 96]);
    expect(r.every((x) => x.qty === 2)).toBe(true);
  });

  it('a ladder upwards (a short) works the same way', () => {
    const r = ladderRungs(100, 104, 3, 'equal', 3, 0.01, 0.001);
    expect(r.map((x) => x.price)).toEqual([100, 102, 104]);
  });

  it('sizes never add up to more than the total, and bigger rungs go where the weights say', () => {
    const r = ladderRungs(100, 90, 4, 'up', 10, 0.01, 0.01);
    expect(r.reduce((a, x) => a + x.qty, 0)).toBeLessThanOrEqual(10);
    expect(r[3].qty).toBeGreaterThan(r[0].qty);
  });

  it('one rung, or an end equal to the entry, is just the entry', () => {
    expect(ladderRungs(100, 90, 1, 'equal', 5, 0.01, 0.1)).toEqual([{ price: 100, qty: 5 }]);
    expect(ladderRungs(100, 100, 5, 'equal', 5, 0.01, 0.1)).toEqual([{ price: 100, qty: 5 }]);
  });

  it('rungs that land on the same tick are merged', () => {
    const r = ladderRungs(100, 100.02, 5, 'equal', 5, 0.01, 0.001);
    expect(new Set(r.map((x) => x.price)).size).toBe(r.length);
    expect(r.reduce((a, x) => a + x.qty, 0)).toBeCloseTo(5, 2);
  });

  it('the average price is weighted by size', () => {
    expect(averagePrice([{ price: 100, qty: 1 }, { price: 90, qty: 3 }])).toBeCloseTo(92.5);
    expect(averagePrice([])).toBe(0);
  });
});
