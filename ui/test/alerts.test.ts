import { describe, expect, it } from 'vitest';
import { chimeNotes, shouldAlert, type AlertSettings } from '../src/alerts';
import type { Signal } from '../src/types';

const base: AlertSettings = { sound: true, minScore: 60, kinds: { ml: true, crack: true, drop: false, near: false }, volume: 0.5 };
const sig = (p: Partial<Signal>) => ({ kind: 'crack', score: 70, side: null, ...p }) as Signal;

describe('signal alerts', () => {
  it('sounds only for chosen kinds above the minimum score', () => {
    expect(shouldAlert(sig({}), base)).toBe(true);
    expect(shouldAlert(sig({ score: 59 }), base)).toBe(false);
    expect(shouldAlert(sig({ kind: 'drop' }), base)).toBe(false);
    expect(shouldAlert(sig({}), { ...base, sound: false })).toBe(false);
  });
  it('rises for a long and falls for a short', () => {
    const up = chimeNotes(sig({ kind: 'ml', side: 'BUY' }));
    const down = chimeNotes(sig({ kind: 'ml', side: 'SELL' }));
    expect(up[1]).toBeGreaterThan(up[0]);
    expect(down[1]).toBeLessThan(down[0]);
  });
});

import { pollInterval } from '../src/trade';
describe('trading poll', () => {
  it('slows down while the user-data stream is connected', () => {
    expect(pollInterval(true)).toBeGreaterThan(pollInterval(false));
  });
});
