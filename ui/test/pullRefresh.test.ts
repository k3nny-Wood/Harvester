import { describe, expect, it } from 'vitest';
import { PULL_TRIGGER, pullDistance } from '../src/mobile/pullRefresh';

describe('pull to refresh', () => {
  it('follows the finger with resistance, and stops at a maximum', () => {
    expect(pullDistance(-10)).toBe(0);
    expect(pullDistance(40)).toBe(20);
    expect(pullDistance(1000)).toBeLessThanOrEqual(96);
  });
  it('needs a deliberate pull to trigger', () => {
    expect(pullDistance(60)).toBeLessThan(PULL_TRIGGER);
    expect(pullDistance(130)).toBeGreaterThanOrEqual(PULL_TRIGGER);
  });
});
