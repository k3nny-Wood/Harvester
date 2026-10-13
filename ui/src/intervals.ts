/** Vela timeframes are minutes ("60" = 1h) with D/W/M above; Binance wants "1h", "1d". */
export const TIMEFRAMES: Array<{ interval: string; vela: string; label: string; /** reachable by hotkey only, not a button in the top bar */ extra?: boolean }> = [
  { interval: '1m', vela: '1', label: '1m' },
  { interval: '3m', vela: '3', label: '3m' },
  { interval: '5m', vela: '5', label: '5m' },
  { interval: '15m', vela: '15', label: '15m' },
  { interval: '30m', vela: '30', label: '30m' },
  { interval: '1h', vela: '60', label: '1h' },
  { interval: '4h', vela: '240', label: '4h' },
  { interval: '1d', vela: 'D', label: '1D' },
  // more of Binance's sizes, reached with the timeframe hotkeys
  { interval: '2h', vela: '120', label: '2h', extra: true },
  { interval: '6h', vela: '360', label: '6h', extra: true },
  { interval: '8h', vela: '480', label: '8h', extra: true },
  { interval: '12h', vela: '720', label: '12h', extra: true },
  { interval: '1w', vela: 'W', label: '1W', extra: true },
];

/** The timeframes that have a button in the top bar. */
export const BAR_TIMEFRAMES = TIMEFRAMES.filter((t) => !t.extra);

/** Length of an interval in whole minutes (a week is 10080). */
export function minutesOf(interval: string): number {
  const m = /^(\d+)(m|h|d|w)$/.exec(interval);
  if (!m) return 0;
  return Number(m[1]) * { m: 1, h: 60, d: 1440, w: 10080 }[m[2] as 'm' | 'h' | 'd' | 'w'];
}

/**
 * What a typed timeframe means, as on TradingView: a number is minutes, and a unit letter (m, h, d, w) after it says otherwise.
 * `5` -> 5m, `60` -> 1h, `1h` -> 1h, `4H` -> 4h, `1d` -> 1d. Null when Binance has no such candle size (`7`, `0`, `2d`).
 */
export function parseTimeframeInput(input: string): { interval: string } | null {
  const m = /^(\d{1,4})([mhdw]?)$/i.exec(input.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n > 0)) return null;
  const minutes = n * { m: 1, h: 60, d: 1440, w: 10080 }[(m[2] || 'm').toLowerCase() as 'm' | 'h' | 'd' | 'w'];
  const hit = TIMEFRAMES.find((t) => minutesOf(t.interval) === minutes);
  return hit ? { interval: hit.interval } : null;
}

/** "1 minute", "15 minutes", "1 hour", "1 day", "1 week": the name shown in the popup. */
export function timeframeName(interval: string): string {
  const m = /^(\d+)(m|h|d|w)$/.exec(interval);
  if (!m) return interval;
  const n = Number(m[1]);
  const unit = { m: 'minute', h: 'hour', d: 'day', w: 'week' }[m[2] as 'm' | 'h' | 'd' | 'w'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

export function velaToInterval(tf: string): string {
  const t = String(tf).toLowerCase();
  const hit = TIMEFRAMES.find((x) => x.vela.toLowerCase() === t || x.interval === t);
  if (hit) return hit.interval;
  const m = /^(\d+)(m|h|d|w)?$/.exec(t);
  if (!m) return '15m';
  const n = Number(m[1]);
  const unit = m[2] ?? 'm';
  return `${n}${unit}`;
}

export function intervalToVela(interval: string): string {
  return TIMEFRAMES.find((x) => x.interval === interval)?.vela ?? '15';
}

/** Length of one candle of a Binance interval ("15m", "4h", "1d") in milliseconds. */
export function intervalMs(interval: string): number {
  const m = /^(\d+)(m|h|d|w)$/.exec(interval);
  if (!m) return 900_000;
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as 'm' | 'h' | 'd' | 'w'];
  return Number(m[1]) * unit;
}
