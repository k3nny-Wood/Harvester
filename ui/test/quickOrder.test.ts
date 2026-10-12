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
