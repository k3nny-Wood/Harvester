import { describe, expect, it } from 'vitest';
import { orderTag } from '../src/chart/lineTags';

describe('chart line tags', () => {
  it('exits of a position are named by what they do', () => {
    expect(orderTag({ side: 'SELL', type: 'TAKE_PROFIT_MARKET', reduceOnly: true })).toBe('TAKE PROFIT');
    expect(orderTag({ side: 'SELL', type: 'STOP_MARKET', reduceOnly: true })).toBe('STOP LOSS');
  });
  it('entries are named by side and type', () => {
    expect(orderTag({ side: 'BUY', type: 'LIMIT', reduceOnly: false })).toBe('BUY LIMIT');
    expect(orderTag({ side: 'BUY', type: 'STOP', reduceOnly: false })).toBe('BUY STOP-LIMIT');
    expect(orderTag({ side: 'SELL', type: 'STOP_MARKET', reduceOnly: false })).toBe('SELL STOP');
    expect(orderTag({ side: 'SELL', type: 'TAKE_PROFIT', reduceOnly: false })).toBe('SELL TP');
  });
});
