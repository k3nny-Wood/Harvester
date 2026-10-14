import { describe, expect, it } from 'vitest';
import { chartsToClose } from '../src/dock';

const c = (id: string, symbol: string) => ({ id, symbol });

describe('one chart per symbol', () => {
  it('keeps the first tab of each symbol and closes the rest', () => {
    const list = [c('a', 'BTCUSDT'), c('b', 'ETHUSDT'), c('c', 'BTCUSDT'), c('d', 'BTCUSDT'), c('e', 'ETHUSDT')];
    expect(chartsToClose(list)).toEqual(['c', 'd', 'e']);
  });

  it('keeps the tab that has focus instead of the first one', () => {
    const list = [c('a', 'BTCUSDT'), c('b', 'ETHUSDT'), c('c', 'BTCUSDT')];
    expect(chartsToClose(list, 'c')).toEqual(['a']);
  });

  it('nothing to close when every symbol is open once', () => {
    expect(chartsToClose([c('a', 'BTCUSDT'), c('b', 'ETHUSDT')])).toEqual([]);
    expect(chartsToClose([])).toEqual([]);
  });
});
