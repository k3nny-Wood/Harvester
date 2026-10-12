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
