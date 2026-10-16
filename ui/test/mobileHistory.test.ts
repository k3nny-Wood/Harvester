import { describe, expect, it } from 'vitest';
import { closedTrades, historyTotals } from '../src/mobile/history';
import type { TradeRecord } from '../src/types';

const f = (id: number, orderId: number, side: 'BUY' | 'SELL', price: number, qty: number, realizedPnl: number, time: number, commission = 0.1): TradeRecord => ({ id, orderId, symbol: 'ETHUSDT', side, price, qty, quoteQty: price * qty, realizedPnl, commission, commissionAsset: 'USDT', maker: false, time });

describe('closed trades from fills', () => {
  it('turns the closing order of a long into one trade with the implied entry', () => {
    // bought 2 @ 100 (opening, no pnl), sold 2 @ 110 in two fills: pnl +20
    const t = closedTrades([f(1, 1, 'BUY', 100, 2, 0, 1000), f(2, 2, 'SELL', 110, 1, 10, 2000), f(3, 2, 'SELL', 110, 1, 10, 2001)]);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ long: true, qty: 2, exit: 110, entry: 100, pnl: 20, time: 2001 });
    expect(t[0].fees).toBeCloseTo(0.2);
    expect(t[0].net).toBeCloseTo(19.8);
    expect(t[0].pct).toBeCloseTo(9.9);
  });
  it('knows a short: the closing order buys, and the entry is above the exit for a profit', () => {
    const t = closedTrades([f(5, 9, 'BUY', 90, 1, 10, 3000)]);
    expect(t[0]).toMatchObject({ long: false, entry: 100, exit: 90 });
  });
  it('lists newest first and totals', () => {
    const t = closedTrades([f(1, 1, 'SELL', 110, 1, 10, 1000), f(2, 2, 'SELL', 95, 1, -5, 2000)]);
    expect(t.map((x) => x.key)).toEqual(['ETHUSDT:2', 'ETHUSDT:1']);
    const s = historyTotals(t);
    expect(s.count).toBe(2);
    expect(s.wins).toBe(1);
    expect(s.net).toBeCloseTo(4.8);
  });
});
