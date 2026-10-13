import { describe, expect, it } from 'vitest';
import { defaultExitPrice, exitState } from '../src/positionExits';
import type { OpenOrder } from '../src/types';

const order = (symbol: string, side: string, type: string, reduceOnly: boolean) => ({ symbol, side, type, reduceOnly, orderId: 1, conditional: type !== 'LIMIT' }) as OpenOrder;

describe('which exits a position already has', () => {
  it('a long with a reduce-only sell stop and sell take-profit has both', () => {
    const orders = [order('ETHUSDT', 'SELL', 'STOP_MARKET', true), order('ETHUSDT', 'SELL', 'TAKE_PROFIT_MARKET', true)];
    const s = exitState('ETHUSDT', 2, orders);
    expect(s.stop).not.toBeNull();
    expect(s.take).not.toBeNull();
  });

  it('a reduce-only limit on the closing side counts as the take-profit', () => {
    expect(exitState('ETHUSDT', 2, [order('ETHUSDT', 'SELL', 'LIMIT', true)]).take).not.toBeNull();
  });

  it('entries, other symbols and the wrong side do not count', () => {
    const orders = [order('ETHUSDT', 'SELL', 'STOP_MARKET', false), order('BTCUSDT', 'SELL', 'STOP_MARKET', true), order('ETHUSDT', 'BUY', 'STOP_MARKET', true)];
    const s = exitState('ETHUSDT', 2, orders);
    expect(s.stop).toBeNull();
    expect(s.take).toBeNull();
  });

  it('a short is closed by buying', () => {
    const s = exitState('ETHUSDT', -2, [order('ETHUSDT', 'BUY', 'STOP_MARKET', true)]);
    expect(s.stop).not.toBeNull();
    expect(s.take).toBeNull();
  });
});

describe('where a new exit starts', () => {
  it('a long: stop below, take-profit above the market', () => {
    expect(defaultExitPrice('stop', true, 100)).toBeCloseTo(98.5);
    expect(defaultExitPrice('take', true, 100)).toBeCloseTo(103);
  });

  it('a short: stop above, take-profit below the market', () => {
    expect(defaultExitPrice('stop', false, 100)).toBeCloseTo(101.5);
    expect(defaultExitPrice('take', false, 100)).toBeCloseTo(97);
  });
});
