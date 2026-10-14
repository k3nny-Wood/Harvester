import type { Kline } from '../types';

/** Simple moving average of the last `n` values at each point (null until there are `n`). */
export function sma(values: number[], n: number): Array<number | null> {
  const out: Array<number | null> = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    out.push(i >= n - 1 ? sum / n : null);
  }
  return out;
}

/** Exponential moving average, seeded with the average of the first `n` values (null before that). */
export function ema(values: number[], n: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length < n) return out;
  const k = 2 / (n + 1);
  let prev = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = prev;
  for (let i = n; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(closes: number[], n = 14): Array<number | null> {
  const out: Array<number | null> = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  const val = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  out[n] = val();
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(0, d)) / n;
    loss = (loss * (n - 1) + Math.max(0, -d)) / n;
    out[i] = val();
  }
  return out;
}

export interface Macd {
  macd: Array<number | null>;
  signal: Array<number | null>;
  hist: Array<number | null>;
}

export function macd(closes: number[], fast = 12, slow = 26, signal = 9): Macd {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line = closes.map((_, i) => (f[i] != null && s[i] != null ? (f[i] as number) - (s[i] as number) : null));
  const firstIdx = line.findIndex((v) => v != null);
  const sig: Array<number | null> = new Array(closes.length).fill(null);
  if (firstIdx >= 0) {
    const tail = ema(line.slice(firstIdx) as number[], signal);
    tail.forEach((v, i) => (sig[firstIdx + i] = v));
  }
  const hist = line.map((v, i) => (v != null && sig[i] != null ? v - (sig[i] as number) : null));
  return { macd: line, signal: sig, hist };
}

/** Average true range (Wilder). */
export function atr(candles: Kline[], n = 14): Array<number | null> {
  const out: Array<number | null> = new Array(candles.length).fill(null);
  if (candles.length <= n) return out;
  const tr = candles.map((c, i) => (i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close))));
  let prev = tr.slice(1, n + 1).reduce((a, b) => a + b, 0) / n;
  out[n] = prev;
  for (let i = n + 1; i < candles.length; i++) {
    prev = (prev * (n - 1) + tr[i]) / n;
    out[i] = prev;
  }
  return out;
}

export interface Bollinger {
  mid: number;
  upper: number;
  lower: number;
  /** where the last close sits in the band: 0 = lower band, 1 = upper band */
  percentB: number;
  /** band width as a percentage of the middle */
  widthPct: number;
}

export function bollinger(closes: number[], n = 20, k = 2): Bollinger | null {
  if (closes.length < n) return null;
  const w = closes.slice(-n);
  const mid = w.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(w.reduce((a, b) => a + (b - mid) ** 2, 0) / n);
  const upper = mid + k * sd;
  const lower = mid - k * sd;
  const last = closes[closes.length - 1];
  return { mid, upper, lower, percentB: upper === lower ? 0.5 : (last - lower) / (upper - lower), widthPct: mid > 0 ? ((upper - lower) / mid) * 100 : 0 };
}

export interface Swing {
  index: number;
  time: number;
  price: number;
  kind: 'high' | 'low';
}

/** Swing highs and lows: a candle whose high (low) is the highest (lowest) of `left` candles before and `right` after. Oldest first. */
export function swings(candles: Kline[], left = 5, right = 5): Swing[] {
  const out: Swing[] = [];
  for (let i = left; i < candles.length - right; i++) {
    let high = true;
    let low = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) high = false;
      if (candles[j].low <= candles[i].low) low = false;
    }
    if (high) out.push({ index: i, time: candles[i].time, price: candles[i].high, kind: 'high' });
    if (low) out.push({ index: i, time: candles[i].time, price: candles[i].low, kind: 'low' });
  }
  return out;
}

export interface VolumeProfile {
  /** price of the row with the most volume (point of control) */
  poc: number;
  /** the top and bottom of the area holding `areaPct` of the volume around the POC */
  vah: number;
  val: number;
  low: number;
  high: number;
}

/** Volume at price: each candle's volume is spread over the rows its range touches. */
export function volumeProfile(candles: Kline[], rows = 40, areaPct = 70): VolumeProfile | null {
  if (candles.length === 0) return null;
  const low = Math.min(...candles.map((c) => c.low));
  const high = Math.max(...candles.map((c) => c.high));
  if (!(high > low)) return null;
  const step = (high - low) / rows;
  const vol = new Array(rows).fill(0);
  for (const c of candles) {
    const a = Math.min(rows - 1, Math.floor((c.low - low) / step));
    const b = Math.min(rows - 1, Math.floor((c.high - low) / step));
    for (let r = a; r <= b; r++) vol[r] += c.volume / (b - a + 1);
  }
  let poc = 0;
  for (let r = 1; r < rows; r++) if (vol[r] > vol[poc]) poc = r;
  const total = vol.reduce((x, y) => x + y, 0);
  let lo = poc;
  let hi = poc;
  let got = vol[poc];
  while (got < (total * areaPct) / 100 && (lo > 0 || hi < rows - 1)) {
    const down = lo > 0 ? vol[lo - 1] : -1;
    const up = hi < rows - 1 ? vol[hi + 1] : -1;
    if (up >= down) {
      hi += 1;
      got += vol[hi];
    } else {
      lo -= 1;
      got += vol[lo];
    }
  }
  const mid = (r: number) => low + (r + 0.5) * step;
  return { poc: mid(poc), vah: low + (hi + 1) * step, val: low + lo * step, low, high };
}

/** The last non-null value of a series. */
export function last(series: Array<number | null>): number | null {
  for (let i = series.length - 1; i >= 0; i--) if (series[i] != null) return series[i];
  return null;
}
