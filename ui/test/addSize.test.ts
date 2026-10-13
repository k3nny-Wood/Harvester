import { describe, expect, it } from 'vitest';
import { addQuantity, floorQty, maxAddPct } from '../src/addSize';

describe('adding size', () => {
  it('turns a share of the account into a quantity at the leverage and price', () => {
    // 10% of 1000 = 100 margin, x5 = 500 USDT, at 2 USDT a token = 250 tokens
    expect(addQuantity(10, 1000, 5, 2)).toBeCloseTo(250);
    expect(addQuantity(10, 1000, 5, 0)).toBe(0);
  });

  it('the slider may use the whole account when there is no safety cap', () => {
    expect(maxAddPct(1000, 5, 0, 300)).toBe(100);
  });

  it('what an order is worth already counts against the safety cap', () => {
    // cap 1000 USDT, the order is worth 400, leverage 5, account 1000: room for 600 -> 600/5/1000 = 12%
    expect(maxAddPct(1000, 5, 1000, 400)).toBeCloseTo(12);
    expect(maxAddPct(1000, 5, 1000, 1000)).toBe(0);
    expect(maxAddPct(1000, 5, 1000, 5000)).toBe(0);
  });

  it('rounds quantities down to the step', () => {
    expect(floorQty(12.3456, 0.01)).toBe(12.34);
    expect(floorQty(7, 1)).toBe(7);
    expect(floorQty(0.999, 1)).toBe(0);
    expect(floorQty(5.5, 0)).toBe(5.5);
  });
});
