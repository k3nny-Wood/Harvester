import { describe, expect, it } from 'vitest';
import { bracketProblems, defaultBracket, entryKind, exitsMustWait } from '../src/chart/QuickOrder';

describe('quick bracket order', () => {
  it('a long above the market is a stop-limit, below it a plain limit; a short is the mirror', () => {
    expect(entryKind('BUY', 105, 100)).toBe('STOP');
    expect(entryKind('BUY', 95, 100)).toBe('LIMIT');
    expect(entryKind('SELL', 95, 100)).toBe('STOP');
    expect(entryKind('SELL', 105, 100)).toBe('LIMIT');
  });

  it('the default take-profit and stop-loss sit on the profit and loss sides', () => {
    const l = defaultBracket('BUY', 100, 0.01);
    expect(l.tp).toBeGreaterThan(100);
    expect(l.sl).toBeLessThan(100);
    const s = defaultBracket('SELL', 100, 0.01);
    expect(s.tp).toBeLessThan(100);
    expect(s.sl).toBeGreaterThan(100);
  });

  it('accepts levels on the right sides of the entry and refuses wrong-way ones', () => {
    expect(bracketProblems({ side: 'BUY', entry: 105, tp: 110, sl: 102 })).toEqual([]);
    expect(bracketProblems({ side: 'BUY', entry: 105, tp: 104, sl: 102 }).length).toBeGreaterThan(0);
    expect(bracketProblems({ side: 'BUY', entry: 105, tp: 110, sl: 106 }).length).toBeGreaterThan(0);
    expect(bracketProblems({ side: 'SELL', entry: 95, tp: 90, sl: 98 })).toEqual([]);
    expect(bracketProblems({ side: 'SELL', entry: 95, tp: 96, sl: 98 }).length).toBeGreaterThan(0);
    expect(bracketProblems({ side: 'SELL', entry: 95, tp: 90, sl: 93 }).length).toBeGreaterThan(0);
    expect(bracketProblems({ side: 'BUY', entry: 0, tp: 1, sl: 1 }).length).toBeGreaterThan(0);
  });

  it('exits that Binance would refuse today are armed to wait for the entry', () => {
    // long breakout at 105 with the market at 100: the stop at 102 is above the market, so it must wait
    expect(exitsMustWait({ side: 'BUY', entry: 105, tp: 110, sl: 102 }, 100)).toBe(true);
    expect(exitsMustWait({ side: 'BUY', entry: 105, tp: 110, sl: 98 }, 100)).toBe(false);
    // long pullback limit at 95 with the market at 100: the take-profit at 98 is below the market, so it must wait
    expect(exitsMustWait({ side: 'BUY', entry: 95, tp: 98, sl: 92 }, 100)).toBe(true);
    expect(exitsMustWait({ side: 'SELL', entry: 95, tp: 90, sl: 98 }, 100)).toBe(true);
    expect(exitsMustWait({ side: 'SELL', entry: 95, tp: 90, sl: 101 }, 100)).toBe(false);
    expect(exitsMustWait({ side: 'BUY', entry: 105, tp: 110, sl: 102 }, 0)).toBe(false);
  });
});

import { gainPct, signed } from '../src/chart/QuickOrder';

describe('percentage shown on the take-profit and stop-loss', () => {
  it('a long gains going up and loses going down', () => {
    expect(gainPct('BUY', 100, 102)).toBeCloseTo(2);
    expect(gainPct('BUY', 100, 99)).toBeCloseTo(-1);
  });
  it('a short gains going down and loses going up', () => {
    expect(gainPct('SELL', 100, 98)).toBeCloseTo(2);
    expect(gainPct('SELL', 100, 101)).toBeCloseTo(-1);
  });
  it('is written with an explicit sign', () => {
    expect(signed(2)).toBe('+2.00%');
    expect(signed(-1.234)).toBe('-1.23%');
    expect(signed(20, 1)).toBe('+20.0%');
  });
});

import { defaultLadderEnd } from '../src/chart/QuickOrder';

describe('exits of a ladder', () => {
  it('must be beyond every rung: above the highest for a long take-profit, below the lowest for its stop', () => {
    // a long ladder from 100 down to 97
    expect(bracketProblems({ side: 'BUY', entry: 100, tp: 103, sl: 95 }, 97)).toEqual([]);
    expect(bracketProblems({ side: 'BUY', entry: 100, tp: 103, sl: 98 }, 97).length).toBeGreaterThan(0);
    expect(bracketProblems({ side: 'BUY', entry: 100, tp: 99, sl: 95 }, 97).length).toBeGreaterThan(0);
  });

  it('a short ladder is the mirror', () => {
    expect(bracketProblems({ side: 'SELL', entry: 100, tp: 96, sl: 106 }, 103)).toEqual([]);
    expect(bracketProblems({ side: 'SELL', entry: 100, tp: 96, sl: 102 }, 103).length).toBeGreaterThan(0);
  });

  it('a ladder end equal to the entry is flagged', () => {
    expect(bracketProblems({ side: 'BUY', entry: 100, tp: 103, sl: 95 }, 100).length).toBeGreaterThan(0);
  });

  it('a new ladder ends against the trade', () => {
    expect(defaultLadderEnd('BUY', 100, 0.01)).toBeLessThan(100);
    expect(defaultLadderEnd('SELL', 100, 0.01)).toBeGreaterThan(100);
  });
});

import { keepOutside } from '../src/chart/QuickOrder';

describe('keeping the exits outside a ladder', () => {
  const long = { side: 'BUY' as const, entry: 100, tp: 102, sl: 99 };

  it('pushes an exit that ended up inside the range out to the default distance beyond the edge', () => {
    // long ladder 100 -> 97: the stop at 99 is inside, the take-profit at 102 is already outside
    const r = keepOutside(long, 97, 0.01, 'push');
    expect(r.tp).toBe(102);
    expect(r.sl).toBeCloseTo(97 * 0.99, 2);
  });

  it('clamps an exit dragged into the range at the edge', () => {
    expect(keepOutside({ ...long, tp: 99.5 }, 97, 0.01, 'clamp').tp).toBeCloseTo(100.01, 6);
    expect(keepOutside({ ...long, sl: 98 }, 97, 0.01, 'clamp').sl).toBeCloseTo(96.99, 6);
  });

  it('leaves exits that are already outside alone, and does nothing without a ladder', () => {
    expect(keepOutside({ ...long, sl: 95 }, 97, 0.01, 'push')).toEqual({ tp: 102, sl: 95 });
    expect(keepOutside(long, 0, 0.01, 'push')).toEqual({ tp: 102, sl: 99 });
  });

  it('a short ladder is the mirror', () => {
    const s = { side: 'SELL' as const, entry: 100, tp: 99, sl: 101 };
    // ladder 100 -> 103: the stop at 101 is inside, the take-profit at 99 is outside
    const r = keepOutside(s, 103, 0.01, 'push');
    expect(r.tp).toBe(99);
    expect(r.sl).toBeCloseTo(103 * 1.01, 2);
    expect(keepOutside({ ...s, tp: 101.5 }, 103, 0.01, 'clamp').tp).toBeCloseTo(99.99, 6);
  });
});
