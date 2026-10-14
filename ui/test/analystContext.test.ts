import { describe, expect, it } from 'vitest';
import { buildContext, candleTable, fmt, summarizeFrame, type AnalystInput } from '../src/analyst/context';
import type { Kline } from '../src/types';

function series(n: number, start = 100): Kline[] {
  let p = start;
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    p = o + Math.sin(i / 7) * 1.1 + 0.05;
    return { time: Date.UTC(2026, 9, 1) + i * 900_000, open: o, high: Math.max(o, p) + 0.4, low: Math.min(o, p) - 0.4, close: p, volume: 1000 + (i % 9) * 50 };
  });
}

const base = (over: Partial<AnalystInput> = {}): AnalystInput => ({
  symbol: 'ETHUSDT',
  timeframe: '15m',
  nowMs: Date.UTC(2026, 9, 14, 12, 0),
  frames: [{ interval: '15m', candles: series(300) }, { interval: '1h', candles: series(120) }],
  qfl: [],
  smc: [],
  news: [],
  openOrders: [],
  ...over,
});

describe('number formatting', () => {
  it('keeps about six significant digits and drops trailing zeros', () => {
    expect(fmt(0.02047)).toBe('0.02047');
    expect(fmt(83778.8)).toBe('83778.8');
    expect(fmt(1.5)).toBe('1.5');
    expect(fmt(0.00000123456789)).toBe('0.00000123457');
    expect(fmt(0)).toBe('0');
    expect(fmt(null)).toBe('n/a');
    expect(fmt(NaN)).toBe('n/a');
  });
});

describe('the text the model reads', () => {
  it('names the symbol, the chart timeframe and the price, and summarises every timeframe', () => {
    const t = buildContext(base());
    expect(t).toContain('Analyse ETHUSDT');
    expect(t).toContain('15m timeframe');
    expect(t).toContain('[15m] last close');
    expect(t).toContain('[1h] last close');
    expect(t).toContain('RSI14');
    expect(t).toContain('volume profile');
    expect(t).toContain('LAST 40 CANDLES');
    expect(t).toContain('No open position');
  });

  it('a frame with too few candles says so instead of inventing numbers', () => {
    expect(summarizeFrame({ interval: '1d', candles: series(10) })[0]).toContain('too few');
  });

  it('the candle table is as long as asked and oldest first', () => {
    const rows = candleTable(series(100), 5);
    expect(rows).toHaveLength(5);
    expect(rows[0] < rows[4]).toBe(true);
  });

  it('a position, its missing stop-loss, a delisting warning and news are all in the text', () => {
    const t = buildContext(
      base({
        position: { side: 'SHORT', size: 5165.1, entry: 0.38037, mark: 0.38062, pnl: -1.31, roePct: -0.67, leverage: 10, isolated: true, liquidation: 0.4141, takeProfit: 0.376 },
        delisting: 'EPICUSDT is scheduled to be DELISTED on 20 Oct 2026',
        news: [{ source: 'Binance', title: 'Binance Will Delist EPIC, QUICK on 2026-10-28', timeMs: Date.UTC(2026, 9, 14, 9, 0) }],
        openOrders: [{ side: 'BUY', type: 'TAKE_PROFIT_MARKET', price: 0.376, qty: 5165.1, reduceOnly: true }],
        userNote: 'Should I hold through the delisting?',
      }),
    );
    expect(t).toContain('SHORT 5165.1 at entry 0.38037');
    expect(t).toContain('10x isolated');
    expect(t).toContain('Stop-loss: NONE');
    expect(t).toContain('Take-profit: 0.376');
    expect(t).toContain('WARNING: EPICUSDT is scheduled');
    expect(t).toContain('Binance Will Delist EPIC');
    expect(t).toContain('(reduce-only)');
    expect(t).toContain('Should I hold through the delisting?');
  });

  it('detector zones are listed with their state', () => {
    const t = buildContext(
      base({
        qfl: [{ low: 95, high: 96, time: 0, confirmTime: 0, crackTime: null, crackLevel: 94.5, bases: 2, touches: 3 }],
        smc: [{ kind: 'fvg', bullish: true, time: 0, confirmTime: 0, low: 97, high: 98, fullLow: 97, fullHigh: 98.5, partiallyMitigated: true, sizePct: 0.8 }],
      }),
    );
    expect(t).toContain('QFL base zone 95 - 96: 2 base(s), 3 retest(s), still holding');
    expect(t).toContain('SMC fair value gap 97 - 98 (expected support, partly filled');
  });

  it('a cross-margin position without a liquidation price says it cannot be reached', () => {
    const t = buildContext(base({ position: { side: 'LONG', size: 10, entry: 100, mark: 101, pnl: 10, roePct: 5, leverage: 5, isolated: false, liquidation: 0 } }));
    expect(t).toContain('none (cross margin, not reachable)');
  });
});
