import { ema, macd, rsi, sma } from '../analyst/indicators';
import type { Kline } from '../types';

/** The indicators the phone chart can show: volume and the moving averages sit on the price pane, the rest get a pane of their own under it. */
export type IndKey = 'volume' | 'sma' | 'macd' | 'trix' | 'rsi' | 'obv' | 'cmf';

export const IND_LIST: Array<{ key: IndKey; label: string; hint: string }> = [
  { key: 'volume', label: 'Volume', hint: 'Volume bars at the bottom of the price pane' },
  { key: 'sma', label: 'SMA', hint: 'Simple moving averages: 20 (gold) and 50 (blue)' },
  { key: 'macd', label: 'MACD', hint: 'MACD 12 / 26 / 9' },
  { key: 'trix', label: 'TRIX', hint: 'TRIX 15 with a 9 period signal line' },
  { key: 'rsi', label: 'RSI', hint: 'Relative strength index 14' },
  { key: 'obv', label: 'OBV', hint: 'On-balance volume' },
  { key: 'cmf', label: 'CMF', hint: 'Chaikin money flow 20' },
];

export interface PaneSeries {
  kind: 'line' | 'hist';
  values: Array<number | null>;
  color: string;
}

export interface Pane {
  key: IndKey;
  title: string;
  series: PaneSeries[];
  /** the value range is fixed (RSI is always 0..100) */
  fixed?: [number, number];
  /** dotted guide lines */
  guides?: number[];
}

type Series = Array<number | null>;

/** An EMA over a series that starts with nulls: it starts at the first real value. */
function emaOf(values: Series, n: number): Series {
  const first = values.findIndex((v) => v != null);
  const out: Series = new Array(values.length).fill(null);
  if (first < 0) return out;
  const tail = ema(values.slice(first) as number[], n);
  tail.forEach((v, i) => (out[first + i] = v));
  return out;
}

/** TRIX: the one-period percentage change of a triple-smoothed EMA of the close, and its signal line. */
export function trix(closes: number[], n = 15, signal = 9): { trix: Series; signal: Series } {
  const e3 = emaOf(emaOf(emaOf(closes, n), n), n);
  const t: Series = e3.map((v, i) => (v != null && i > 0 && e3[i - 1] != null && (e3[i - 1] as number) !== 0 ? (100 * (v - (e3[i - 1] as number))) / (e3[i - 1] as number) : null));
  return { trix: t, signal: emaOf(t, signal) };
}

/** On-balance volume: volume added on up closes and subtracted on down closes. */
export function obv(candles: Kline[]): number[] {
  const out: number[] = [];
  let total = 0;
  candles.forEach((c, i) => {
    if (i > 0) total += c.close > candles[i - 1].close ? c.volume : c.close < candles[i - 1].close ? -c.volume : 0;
    out.push(total);
  });
  return out;
}

/** Chaikin money flow: money-flow volume over `n` candles relative to the volume, -1..1. */
export function cmf(candles: Kline[], n = 20): Series {
  const mfv = candles.map((c) => (c.high > c.low ? ((c.close - c.low - (c.high - c.close)) / (c.high - c.low)) * c.volume : 0));
  const out: Series = new Array(candles.length).fill(null);
  for (let i = n - 1; i < candles.length; i++) {
    let a = 0;
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) {
      a += mfv[j];
      v += candles[j].volume;
    }
    out[i] = v > 0 ? a / v : 0;
  }
  return out;
}

/** The sub panes for the chosen indicators, in a fixed order. */
export function buildPanes(candles: Kline[], on: Partial<Record<IndKey, boolean>>): Pane[] {
  const closes = candles.map((c) => c.close);
  const panes: Pane[] = [];
  if (on.macd) {
    const m = macd(closes);
    panes.push({ key: 'macd', title: 'MACD 12 26 9', series: [{ kind: 'hist', values: m.hist, color: '#6f7b8b' }, { kind: 'line', values: m.macd, color: '#4f8fdd' }, { kind: 'line', values: m.signal, color: '#f0b90b' }], guides: [0] });
  }
  if (on.trix) {
    const t = trix(closes);
    panes.push({ key: 'trix', title: 'TRIX 15 9', series: [{ kind: 'line', values: t.trix, color: '#4f8fdd' }, { kind: 'line', values: t.signal, color: '#f0b90b' }], guides: [0] });
  }
  if (on.rsi) panes.push({ key: 'rsi', title: 'RSI 14', series: [{ kind: 'line', values: rsi(closes, 14), color: '#b48cf2' }], fixed: [0, 100], guides: [30, 70] });
  if (on.obv) panes.push({ key: 'obv', title: 'OBV', series: [{ kind: 'line', values: obv(candles), color: '#4fd1c5' }] });
  if (on.cmf) panes.push({ key: 'cmf', title: 'CMF 20', series: [{ kind: 'line', values: cmf(candles, 20), color: '#2ee59d' }], guides: [0] });
  return panes;
}

/** The two moving averages drawn on the price pane. */
export function buildSmas(candles: Kline[]): Array<{ n: number; color: string; values: Series }> {
  const closes = candles.map((c) => c.close);
  return [
    { n: 20, color: '#f0b90b', values: sma(closes, 20) },
    { n: 50, color: '#4f8fdd', values: sma(closes, 50) },
  ];
}
