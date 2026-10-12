import { describe, expect, it } from 'vitest';
import { chimeNotes, shouldAlert, type AlertSettings } from '../src/alerts';
import type { Signal } from '../src/types';

const base: AlertSettings = { sound: true, minScore: 60, kinds: { crack: true, drop: false, near: false, pump: true, dump: true }, volume: 0.5 };
const sig = (p: Partial<Signal>) => ({ kind: 'crack', score: 70, side: null, ...p }) as Signal;

describe('signal alerts', () => {
  it('sounds only for chosen kinds above the minimum score', () => {
    expect(shouldAlert(sig({}), base)).toBe(true);
    expect(shouldAlert(sig({ score: 59 }), base)).toBe(false);
    expect(shouldAlert(sig({ kind: 'drop' }), base)).toBe(false);
    expect(shouldAlert(sig({}), { ...base, sound: false })).toBe(false);
  });
  it('a crack gets a rising two-note chime, the other kinds a single note', () => {
    const crack = chimeNotes(sig({ kind: 'crack' }));
    expect(crack[1]).toBeGreaterThan(crack[0]);
    expect(chimeNotes(sig({ kind: 'drop' })).length).toBe(1);
  });
});

import { pollInterval } from '../src/trade';
describe('trading poll', () => {
  it('slows down while the user-data stream is connected', () => {
    expect(pollInterval(true)).toBeGreaterThan(pollInterval(false));
  });
});

describe('pump and dump alerts', () => {
  it('a pump chimes upwards and a dump downwards', () => {
    const up = chimeNotes({ kind: 'pump', score: 80 } as Signal);
    const down = chimeNotes({ kind: 'dump', score: 80 } as Signal);
    expect(up[1]).toBeGreaterThan(up[0]);
    expect(down[1]).toBeLessThan(down[0]);
  });

  it('they follow the same kind and score rules as other signals', () => {
    expect(shouldAlert({ kind: 'pump', score: 70 } as Signal, base)).toBe(true);
    expect(shouldAlert({ kind: 'dump', score: 50 } as Signal, base)).toBe(false);
    expect(shouldAlert({ kind: 'dump', score: 90 } as Signal, { ...base, kinds: { ...base.kinds, dump: false } })).toBe(false);
  });
});
