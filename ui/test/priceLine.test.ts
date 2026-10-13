import { describe, expect, it } from 'vitest';
import { countdown } from '../src/chart/ChartPriceLine';

describe('candle countdown', () => {
  it('shows minutes and seconds, and hours when there are any', () => {
    expect(countdown(0)).toBe('00:00');
    expect(countdown(12_300)).toBe('00:13');
    expect(countdown(754_000)).toBe('12:34');
    expect(countdown(3_723_000)).toBe('1:02:03');
    expect(countdown(-5)).toBe('00:00');
  });
});
