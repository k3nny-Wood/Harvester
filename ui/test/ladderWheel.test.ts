import { describe, expect, it } from 'vitest';
import { stepCount } from '../src/chart/LadderOverlay';

describe('ladder order count by mouse wheel', () => {
  it('moves by the steps given', () => {
    expect(stepCount(8, 1)).toBe(9);
    expect(stepCount(8, -3)).toBe(5);
    expect(stepCount(8, 0)).toBe(8);
  });

  it('stays between 2 and 50 orders', () => {
    expect(stepCount(2, -1)).toBe(2);
    expect(stepCount(50, 1)).toBe(50);
    expect(stepCount(49, 5)).toBe(50);
    expect(stepCount(3, -10)).toBe(2);
  });
});
