import { api } from '../api';
import { useBases } from '../basesConfig';
import { delistingFor, describeDelisting, useDelistings } from '../delistings';
import { exitState } from '../positionExits';
import { useSmc } from '../smcConfig';
import { useApp } from '../store';
import { withLiveMarks } from '../livePositions';
import { buildContext, type AnalystInput, type Frame } from './context';

/** The timeframes shown to the model: the chart's own, the hourly, 4-hour and daily, and the 15-minute when the chart is faster than that. */
export function framesFor(timeframe: string): string[] {
  const out = [timeframe];
  if (['1m', '3m', '5m'].includes(timeframe)) out.push('15m');
  for (const tf of ['1h', '4h', '1d']) if (!out.includes(tf)) out.push(tf);
  return out;
}

/** Collect everything about a symbol that the analyst is shown: candles, zones, news, the position. */
export async function gatherInput(symbol: string, timeframe: string, userNote?: string): Promise<AnalystInput> {
  const app = useApp.getState();
  const frames: Frame[] = [];
  for (const interval of framesFor(timeframe)) {
    try {
      const rows = await api.klines(symbol, interval, interval === '1d' ? 200 : 300);
      frames.push({ interval, candles: rows });
    } catch {
      /* a timeframe that did not load is left out */
    }
  }
  if (frames.length === 0) throw new Error(`Could not load candles for ${symbol}.`);
  const bases = useBases.getState().cfg;
  const smcCfg = useSmc.getState().cfg;
  const [qfl, smc, news] = await Promise.all([
    api.qflZones(symbol, timeframe, bases.factor, bases.crackPct, bases.mergePct).catch(() => []),
    api.smcZones(symbol, timeframe, smcCfg.minFvgPct, smcCfg.maxEach).catch(() => []),
    api.newsFor(symbol, false).catch(() => null),
  ]);
  const d = delistingFor(symbol, useDelistings.getState().list);
  const pos = (app.account ? withLiveMarks(app.account.positions, {}) : []).find((p) => p.symbol === symbol && p.amount !== 0);
  const orders = app.orders.filter((o) => o.symbol === symbol);
  let position: AnalystInput['position'];
  if (pos) {
    const ex = exitState(symbol, pos.amount, orders);
    const lev = pos.leverage || app.account?.leverages?.[symbol] || 1;
    const initial = (Math.abs(pos.amount) * pos.entryPrice) / lev;
    position = {
      side: pos.amount > 0 ? 'LONG' : 'SHORT',
      size: Math.abs(pos.amount),
      entry: pos.entryPrice,
      mark: pos.markPrice,
      pnl: pos.unrealizedPnl,
      roePct: initial > 0 ? (pos.unrealizedPnl / initial) * 100 : 0,
      leverage: lev,
      isolated: pos.isolated,
      liquidation: pos.liquidationPrice,
      stopLoss: ex.stop ? ex.stop.stopPrice || ex.stop.price : undefined,
      takeProfit: ex.take ? ex.take.price || ex.take.stopPrice : undefined,
    };
  }
  return {
    symbol,
    timeframe,
    nowMs: Date.now(),
    frames,
    qfl,
    smc,
    news: (news?.items ?? []).map((n) => ({ source: n.source, title: n.title, timeMs: n.timeMs })),
    delisting: d ? describeDelisting(d, Date.now()).text : undefined,
    position,
    openOrders: orders.map((o) => ({ side: o.side, type: o.type, price: o.price || o.stopPrice, qty: o.origQty, reduceOnly: o.reduceOnly })),
    userNote,
  };
}

export { buildContext };
