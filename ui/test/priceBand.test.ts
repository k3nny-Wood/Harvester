import { describe, expect, it } from 'vitest';
import { clampToBand, priceBand } from '../src/priceBand';

describe('limit price band', () => {
  it('is mark x multipliers, moved inside to a whole tick', () => {
    const b = priceBand(0.0671, 0.95, 1.05, '0.0001')!;
    expect(b.low).toBeCloseTo(0.0638, 10); // 0.063745 rounds up
    expect(b.high).toBeCloseTo(0.0704, 10); // 0.070455 rounds down
  });
  it('clamps a price that is outside', () => {
    const b = priceBand(100, 0.95, 1.05, '0.01');
    expect(clampToBand(120, b)).toBe(105);
    expect(clampToBand(50, b)).toBe(95);
    expect(clampToBand(101, b)).toBe(101);
  });
  it('is absent without a market price, and clamping then does nothing', () => {
    expect(priceBand(0, 0.95, 1.05, '0.01')).toBeNull();
    expect(clampToBand(7, null)).toBe(7);
  });
});
