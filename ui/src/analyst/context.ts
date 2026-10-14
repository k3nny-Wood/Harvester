import type { BaseZone, Kline, SmcZone } from '../types';
import { atr, bollinger, ema, last, macd, rsi, sma, swings, volumeProfile } from './indicators';

export interface Frame {
  interval: string;
  candles: Kline[];
}

export interface PositionInfo {
  side: 'LONG' | 'SHORT';
  size: number;
  entry: number;
  mark: number;
  pnl: number;
  roePct: number;
  leverage: number;
  isolated: boolean;
  liquidation: number;
  stopLoss?: number;
  takeProfit?: number;
}

export interface AnalystInput {
  symbol: string;
  /** the timeframe of the chart on screen */
  timeframe: string;
  nowMs: number;
  /** candles per timeframe, the chart's own first */
  frames: Frame[];
  qfl: BaseZone[];
  smc: SmcZone[];
  news: Array<{ source: string; title: string; timeMs: number }>;
  delisting?: string;
  position?: PositionInfo;
  openOrders: Array<{ side: string; type: string; price: number; qty: number; reduceOnly: boolean }>;
  userNote?: string;
}

/** A price with about 6 significant digits, without trailing zeros: 0.0204700 -> 0.02047, 83778.8 -> 83778.8. */
export function fmt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  if (n === 0) return '0';
  return String(Number(n.toPrecision(6)));
}

function pct(n: number | null | undefined, digits = 2): string {
  return n == null || !Number.isFinite(n) ? 'n/a' : `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

function utc(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** The numbers of one timeframe, as lines of text. */
export function summarizeFrame(f: Frame): string[] {
  const c = f.candles;
  if (c.length < 30) return [`${f.interval}: only ${c.length} candles, too few to summarise`];
  const closes = c.map((x) => x.close);
  const price = closes[closes.length - 1];
  const rel = (n: number) => {
    const e = last(ema(closes, n));
    return e == null ? 'n/a' : `${fmt(e)} (price ${pct((price / e - 1) * 100)})`;
  };
  const m = macd(closes);
  const hist = m.hist.filter((x): x is number => x != null);
  const histNow = hist[hist.length - 1];
  const histPrev = hist[hist.length - 4];
  const a = last(atr(c, 14));
  const b = bollinger(closes);
  const vols = c.map((x) => x.volume);
  const volAvg = last(sma(vols, 20));
  const sw = swings(c, 4, 4);
  const highs = sw.filter((s) => s.kind === 'high').slice(-3);
  const lows = sw.filter((s) => s.kind === 'low').slice(-3);
  const window = c.slice(-200);
  const vp = volumeProfile(window);
  const span = (n: number) => {
    const w = c.slice(-n);
    return `${fmt(Math.min(...w.map((x) => x.low)))} - ${fmt(Math.max(...w.map((x) => x.high)))}`;
  };
  const change = (n: number) => (c.length > n ? pct((price / closes[closes.length - 1 - n] - 1) * 100) : 'n/a');
  const out = [
    `[${f.interval}] last close ${fmt(price)}; change over 10 candles ${change(10)}, over 50 candles ${change(50)}`,
    `  EMA20 ${rel(20)}; EMA50 ${rel(50)}; EMA200 ${c.length >= 200 ? rel(200) : 'n/a (too few candles)'}`,
    `  RSI14 ${fmt(last(rsi(closes, 14)))}; MACD histogram ${fmt(histNow)} (${histNow != null && histPrev != null ? (histNow > histPrev ? 'rising' : 'falling') : 'n/a'}), MACD line ${fmt(last(m.macd))}`,
    `  ATR14 ${fmt(a)} (${a != null ? pct((a / price) * 100) : 'n/a'} of price); Bollinger(20,2) %B ${b ? b.percentB.toFixed(2) : 'n/a'}, width ${b ? b.widthPct.toFixed(2) : 'n/a'}%`,
    `  last volume ${fmt(vols[vols.length - 1])} vs 20-candle average ${fmt(volAvg)}`,
    `  range of the last 24 candles ${span(24)}; of the last 100 candles ${span(100)}`,
    `  recent swing highs: ${highs.length ? highs.map((s) => `${fmt(s.price)} (${utc(s.time)})`).join(', ') : 'none'}`,
    `  recent swing lows: ${lows.length ? lows.map((s) => `${fmt(s.price)} (${utc(s.time)})`).join(', ') : 'none'}`,
  ];
  if (vp) out.push(`  volume profile of the last ${window.length} candles: POC ${fmt(vp.poc)}, value area ${fmt(vp.val)} - ${fmt(vp.vah)}`);
  return out;
}

/** The recent candles of the chart's own timeframe as a compact table. */
export function candleTable(candles: Kline[], rows = 40): string[] {
  return candles.slice(-rows).map((x) => `${utc(x.time)} O ${fmt(x.open)} H ${fmt(x.high)} L ${fmt(x.low)} C ${fmt(x.close)} V ${fmt(x.volume)}`);
}

/** Everything the model is shown, as plain text. */
export function buildContext(i: AnalystInput): string {
  const main = i.frames.find((f) => f.interval === i.timeframe) ?? i.frames[0];
  const price = main?.candles[main.candles.length - 1]?.close;
  const lines: string[] = [
    `Analyse ${i.symbol} (Binance USDT perpetual). The trader's chart is on the ${i.timeframe} timeframe. Time now: ${utc(i.nowMs)} UTC. Last price: ${fmt(price)}.`,
    '',
    '== INDICATORS BY TIMEFRAME ==',
  ];
  for (const f of i.frames) lines.push(...summarizeFrame(f));
  if (main) {
    lines.push('', `== LAST ${Math.min(40, main.candles.length)} CANDLES (${main.interval}, UTC, oldest first) ==`, ...candleTable(main.candles));
  }
  if (i.qfl.length || i.smc.length) {
    lines.push('', '== ZONES FOUND BY THE APP\'S DETECTORS ==');
    for (const z of i.qfl.slice(0, 8)) {
      lines.push(`QFL base zone ${fmt(z.low)}${z.high !== z.low ? ` - ${fmt(z.high)}` : ''}: ${z.bases} base(s), ${z.touches} retest(s), ${z.crackTime ? 'CRACKED (broken)' : 'still holding'}`);
    }
    for (const z of i.smc.slice(0, 10)) {
      const name = z.kind === 'fvg' ? 'fair value gap' : z.kind === 'orderBlock' ? 'order block' : 'breaker block';
      lines.push(`SMC ${name} ${fmt(z.low)} - ${fmt(z.high)} (${z.bullish ? 'expected support' : 'expected resistance'}${z.partiallyMitigated ? ', partly filled' : ''}, ${z.sizePct.toFixed(2)}% tall)`);
    }
  }
  if (i.news.length || i.delisting) {
    lines.push('', '== NEWS AND NOTICES ==');
    if (i.delisting) lines.push(`WARNING: ${i.delisting}`);
    for (const n of i.news.slice(0, 6)) lines.push(`${utc(n.timeMs)}  [${n.source}] ${n.title}`);
  }
  if (i.position) {
    const p = i.position;
    lines.push(
      '',
      '== THE TRADER\'S POSITION ==',
      `${p.side} ${fmt(p.size)} at entry ${fmt(p.entry)}, mark ${fmt(p.mark)}, unrealised P&L ${fmt(p.pnl)} USDT (${pct(p.roePct)} on margin), ${p.leverage}x ${p.isolated ? 'isolated' : 'cross'}, liquidation ${p.liquidation > 0 ? fmt(p.liquidation) : 'none (cross margin, not reachable)'}`,
      `Stop-loss: ${p.stopLoss ? fmt(p.stopLoss) : 'NONE'}. Take-profit: ${p.takeProfit ? fmt(p.takeProfit) : 'NONE'}.`,
    );
  } else {
    lines.push('', '== THE TRADER\'S POSITION ==', 'No open position in this symbol.');
  }
  if (i.openOrders.length) {
    lines.push('Open orders: ' + i.openOrders.map((o) => `${o.side} ${o.type} ${fmt(o.qty)} @ ${fmt(o.price)}${o.reduceOnly ? ' (reduce-only)' : ''}`).join('; '));
  }
  if (i.userNote?.trim()) lines.push('', '== THE TRADER ASKS ==', i.userNote.trim());
  lines.push('', 'Give your analysis now in the required JSON format.');
  return lines.join('\n');
}
