/** Vela timeframes are minutes ("60" = 1h) with D/W/M above; Binance wants "1h", "1d". */
export const TIMEFRAMES: Array<{ interval: string; vela: string; label: string }> = [
  { interval: '1m', vela: '1', label: '1m' },
  { interval: '3m', vela: '3', label: '3m' },
  { interval: '5m', vela: '5', label: '5m' },
  { interval: '15m', vela: '15', label: '15m' },
  { interval: '30m', vela: '30', label: '30m' },
  { interval: '1h', vela: '60', label: '1h' },
  { interval: '4h', vela: '240', label: '4h' },
  { interval: '1d', vela: 'D', label: '1D' },
];

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
