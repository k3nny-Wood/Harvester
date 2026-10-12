import { describe, expect, it } from 'vitest';
import { bracketFor, estimateLiquidation } from '../src/liquidation';
import type { LeverageBracket } from '../src/types';

const brackets: LeverageBracket[] = [
  { notionalFloor: 0, notionalCap: 50_000, maintMarginRatio: 0.004, cum: 0, initialLeverage: 125 },
  { notionalFloor: 50_000, notionalCap: 250_000, maintMarginRatio: 0.005, cum: 50, initialLeverage: 100 },
];

describe('estimated liquidation price', () => {
  it('picks the bracket of the position size', () => {
    expect(bracketFor(brackets, 1000)?.maintMarginRatio).toBe(0.004);
    expect(bracketFor(brackets, 60_000)?.maintMarginRatio).toBe(0.005);
    expect(bracketFor(brackets, 9e9)?.maintMarginRatio).toBe(0.005);
    expect(bracketFor([], 1)).toBeUndefined();
  });

  it('a 10x long is liquidated a little before 10% below the entry, a short a little before 10% above', () => {
    const l = estimateLiquidation('BUY', 100, 10, 1000, brackets)!;
    expect(l).toBeCloseTo((100 - 10) / (1 - 0.004), 6);
    expect(l).toBeGreaterThan(90);
    expect(l).toBeLessThan(91);
    const s = estimateLiquidation('SELL', 100, 10, 1000, brackets)!;
    expect(s).toBeCloseTo(110 / 1.004, 6);
    expect(s).toBeLessThan(110);
  });

  it('higher leverage liquidates closer to the entry', () => {
    const a = estimateLiquidation('BUY', 100, 5, 1000, brackets)!;
    const b = estimateLiquidation('BUY', 100, 20, 1000, brackets)!;
    expect(b).toBeGreaterThan(a);
  });

  it('a 1x long has no liquidation price, and a bad entry gives nothing', () => {
    expect(estimateLiquidation('BUY', 100, 1, 1000, brackets)).toBeNull(); // 1x long: only a price of zero would wipe it out
    expect(estimateLiquidation('BUY', 0, 10, 1000, brackets)).toBeNull();
  });
});
