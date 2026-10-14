import { describe, expect, it } from 'vitest';
import { buildContext, candleTable, fmt, summarizeFrame, type AnalystInput } from '../src/analyst/context';
import type { Kline } from '../src/types';
import { costUsd, formatCost } from '../src/analyst/cost';

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

const deriv = {
  fundingPct: 0.005, fundingAvgPct: 0.01, nextFundingMs: null, basisPct: 0.31, openInterestUsd: 5_853_593, openInterestChangePct: -1.5, openInterestHours: 24,
  longShortRatio: 2.0075, longShortChange: 0.03, takerRatio: 0.69, takerRatioAvg: 0.89, volume24hUsd: 3_594_045, change24hPct: -1.08, bidDepthUsd: 1200, askDepthUsd: 800, bookBidShare: 0.6,
};

describe('derivatives, the BTC backdrop and the previous analysis', () => {
  it('writes positioning data, the BTC lines and the previous call into the text', () => {
    const t = buildContext(
      base({
        market: deriv,
        btc: { market: deriv, change1hPct: 0.4, change4hPct: -1.2 },
        previous: { createdMs: Date.UTC(2026, 9, 14, 9, 0), bias: 'bullish', confidence: 58, price: 99.5, summary: 'Holding above support', levels: [{ kind: 'support', price: 97 }] },
      }),
    );
    expect(t).toContain('POSITIONING AND DERIVATIVES');
    expect(t).toContain('funding 0.0050%');
    expect(t).toContain('open interest 5.85M USDT, -1.5%');
    expect(t).toContain('long/short account ratio 2.01');
    expect(t).toContain('60% bids');
    expect(t).toContain('BTC BACKDROP');
    expect(t).toContain('BTCUSDT moved +0.40% over the last hour and -1.20%');
    expect(t).toContain('PREVIOUS ANALYSIS');
    expect(t).toContain('bullish, 58% confidence');
    expect(t).toContain('support 97');
  });

  it('leaves the sections out when there is nothing to show', () => {
    const t = buildContext(base());
    expect(t).not.toContain('POSITIONING');
    expect(t).not.toContain('BTC BACKDROP');
    expect(t).not.toContain('PREVIOUS ANALYSIS');
  });
});

describe('what an analysis costs', () => {
  it('uses the list price of the model', () => {
    expect(costUsd('claude-haiku-5-5', { inputTokens: 10_000, outputTokens: 2000 })).toBeCloseTo(0.002, 9);
    expect(costUsd('claude-sonnet-5-5', { inputTokens: 10_000, outputTokens: 2000 })).toBeCloseTo(0.04, 9);
    expect(costUsd('something-else', { inputTokens: 1, outputTokens: 1 })).toBeNull();
    expect(formatCost(0.002)).toBe('$0.0020');
    expect(formatCost(0.04)).toBe('$0.04');
    expect(formatCost(null)).toBe('n/a');
  });
});
