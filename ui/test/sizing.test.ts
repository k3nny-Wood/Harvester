import { describe, expect, it } from 'vitest';
import { maxPct, notionalOfForm, pctFromNotional, sizeFromPct } from '../src/sizing';

describe('order size from the menu slider', () => {
  it('a share of the account is margin, and the position is margin times leverage', () => {
    const v = sizeFromPct(10, 4000, 3);
    expect(v.margin).toBeCloseTo(400, 9);
    expect(v.notional).toBeCloseTo(1200, 9);
  });

  it('turning a position value back into a share of the account gives the same number', () => {
    const v = sizeFromPct(12.5, 4552.15, 5);
    expect(pctFromNotional(v.notional, 4552.15, 5)).toBeCloseTo(12.5, 9);
  });

  it('leverage below 1, a negative share or no balance cannot give a nonsense size', () => {
    expect(sizeFromPct(10, 1000, 0).notional).toBeCloseTo(100, 9);
    expect(sizeFromPct(-5, 1000, 3).notional).toBe(0);
    expect(pctFromNotional(100, 0, 3)).toBe(0);
    expect(pctFromNotional(0, 1000, 3)).toBe(0);
  });

  it('reads the order form in whatever mode it is in', () => {
    expect(notionalOfForm('usdt', 250, 2, 1000, 3)).toBe(250);
    expect(notionalOfForm('qty', 50, 2, 1000, 3)).toBe(100);
    // % balance uses the available balance as margin: 10% of 1000 at 3x is a 300 position
    expect(notionalOfForm('pct', 10, 2, 1000, 3)).toBeCloseTo(300, 9);
    expect(notionalOfForm('usdt', 0, 2, 1000, 3)).toBe(0);
  });

  it('the slider stops at the whole account or at the safety cap, whichever is lower', () => {
    expect(maxPct(4000, 1, 5000)).toBe(100);
    expect(maxPct(4000, 3, 5000)).toBeCloseTo((5000 / 3 / 4000) * 100, 9);
    expect(maxPct(4000, 3, 0)).toBe(100);
    expect(maxPct(0, 3, 5000)).toBe(0);
  });
});
