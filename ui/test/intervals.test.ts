import { describe, expect, it } from 'vitest';
import { intervalMs } from '../src/intervals';

describe('intervalMs', () => {
  it('knows the Binance intervals', () => {
    expect(intervalMs('15m')).toBe(900_000);
    expect(intervalMs('1h')).toBe(3_600_000);
    expect(intervalMs('4h')).toBe(14_400_000);
    expect(intervalMs('1d')).toBe(86_400_000);
  });
  it('falls back to 15 minutes for something unknown', () => {
    expect(intervalMs('x')).toBe(900_000);
  });
});
