import { describe, expect, it } from 'vitest';
import { leftoverOrders, leftoverSymbols } from '../src/leftovers';
import type { ArmedBracket, HeldOrder, OpenOrder, Position } from '../src/types';

const pos = (symbol: string, amount: number) => ({ symbol, amount }) as Position;
const order = (symbol: string, orderId: number, reduceOnly: boolean, type = 'STOP_MARKET') => ({ symbol, orderId, reduceOnly, type, conditional: type !== 'LIMIT' }) as OpenOrder;

describe('leftover stop-loss and take-profit orders', () => {
  it('a reduce-only order with no position and nothing waiting is left over', () => {
    const orders = [order('ETHUSDT', 1, true), order('ETHUSDT', 2, true, 'TAKE_PROFIT_MARKET')];
    expect(leftoverSymbols([], orders, [], [])).toEqual(['ETHUSDT']);
    expect(leftoverOrders('ETHUSDT', [], orders, [], []).map((o) => o.orderId)).toEqual([1, 2]);
  });

  it('exits of an open position are kept', () => {
    expect(leftoverSymbols([pos('ETHUSDT', 2)], [order('ETHUSDT', 1, true)], [], [])).toEqual([]);
    expect(leftoverSymbols([pos('ETHUSDT', -2)], [order('ETHUSDT', 1, true)], [], [])).toEqual([]);
  });

  it('exits placed together with an entry that has not filled yet are kept', () => {
    const orders = [order('ETHUSDT', 1, false, 'LIMIT'), order('ETHUSDT', 2, true), order('ETHUSDT', 3, true, 'TAKE_PROFIT_MARKET')];
    expect(leftoverSymbols([], orders, [], [])).toEqual([]);
  });

  it('exits are kept while a held order or armed exits wait for their entry', () => {
    const held = [{ status: 'held', request: { symbol: 'ETHUSDT' } }] as HeldOrder[];
    expect(leftoverSymbols([], [order('ETHUSDT', 1, true)], held, [])).toEqual([]);
    const armed = [{ symbol: 'ETHUSDT' }] as ArmedBracket[];
    expect(leftoverSymbols([], [order('ETHUSDT', 1, true)], [], armed)).toEqual([]);
  });

  it('only the symbol without a position is cleaned, and plain orders are never touched', () => {
    const orders = [order('ETHUSDT', 1, true), order('BTCUSDT', 2, true), order('XRPUSDT', 3, false, 'LIMIT')];
    expect(leftoverSymbols([pos('BTCUSDT', 1)], orders, [], [])).toEqual(['ETHUSDT']);
    expect(leftoverOrders('XRPUSDT', [], orders, [], [])).toEqual([]);
  });
});
