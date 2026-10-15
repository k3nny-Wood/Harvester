import type { Side } from './types';

/** The arithmetic of a quick bracket order (entry with take-profit and stop-loss), shared by the desktop chart and the phone layout. */
export interface Quick {
  side: Side;
  entry: number;
  tp: number;
  sl: number;
}

/** How far a stop-limit's limit price sits beyond its trigger, so a fast move through the trigger still fills. */
export const LIMIT_OFFSET = 0.001;
const DEFAULT_SL_PCT = 1;
const DEFAULT_TP_PCT = 2;

/** The move from the entry to `p` in percent, positive when it is in the trade's favour (a long gains going up, a short going down). */
export function gainPct(side: Side, entry: number, p: number): number {
  return entry > 0 ? (side === 'BUY' ? 1 : -1) * (p / entry - 1) * 100 : 0;
}

export function signed(pct: number, digits = 2): string {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(digits)}%`;
}

/** What `entry` becomes on the exchange: a stop-limit when the level is beyond the market (a breakout), a plain limit when it is on the near side (a pullback). */
export function entryKind(side: Side, entry: number, mark: number): 'STOP' | 'LIMIT' {
  return side === 'BUY' ? (entry > mark ? 'STOP' : 'LIMIT') : entry < mark ? 'STOP' : 'LIMIT';
}

/** Default take-profit and stop-loss around an entry: the take-profit on the profit side, the stop on the loss side. */
export function defaultBracket(side: Side, entry: number, tick: number): { tp: number; sl: number } {
  const dir = side === 'BUY' ? 1 : -1;
  const r = (p: number) => (tick > 0 ? Number((Math.round(p / tick) * tick).toPrecision(12)) : p);
  return { tp: r(entry * (1 + (dir * DEFAULT_TP_PCT) / 100)), sl: r(entry * (1 - (dir * DEFAULT_SL_PCT) / 100)) };
}

/** Mistakes in the levels themselves (wrong side of the entry); an empty list means the bracket makes sense. */
export function bracketProblems(q: Quick, ladderEnd?: number): string[] {
  const out: string[] = [];
  const long = q.side === 'BUY';
  if (!(q.entry > 0) || !(q.tp > 0) || !(q.sl > 0)) return ['Enter all three prices.'];
  // with a ladder the exits must be beyond every rung: above the highest for a take-profit, below the lowest for a stop-loss (long)
  const prices = ladderEnd != null && ladderEnd > 0 ? [q.entry, ladderEnd] : [q.entry];
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const what = prices.length > 1 ? 'every rung of the ladder' : 'the entry';
  if (long ? !(q.tp > high) : !(q.tp < low)) out.push(`The take-profit must be ${long ? 'above' : 'below'} ${what}.`);
  if (long ? !(q.sl < low) : !(q.sl > high)) out.push(`The stop-loss must be ${long ? 'below' : 'above'} ${what}.`);
  if (ladderEnd != null && ladderEnd > 0 && ladderEnd === q.entry) out.push('The ladder end is the same price as the entry.');
  return out;
}

const snapTo = (p: number, tick: number) => (tick > 0 ? Number((Math.round(p / tick) * tick).toPrecision(12)) : p);

/**
 * Keep the take-profit and stop-loss outside a ladder's range. `push`: an exit that ended up inside (the ladder was switched on or widened)
 * moves out to the default distance beyond the nearest edge. `clamp`: an exit the user drags or types into the range stops at the edge.
 */
export function keepOutside(q: Quick, end: number, tick: number, mode: 'push' | 'clamp'): { tp: number; sl: number } {
  if (!(end > 0)) return { tp: q.tp, sl: q.sl };
  const long = q.side === 'BUY';
  const high = Math.max(q.entry, end);
  const low = Math.min(q.entry, end);
  const step = tick > 0 ? tick : high * 1e-6;
  let { tp, sl } = q;
  if (long) {
    if (tp <= high) tp = mode === 'push' ? snapTo(high * (1 + DEFAULT_TP_PCT / 100), tick) : snapTo(high + step, tick);
    if (sl >= low) sl = mode === 'push' ? snapTo(low * (1 - DEFAULT_SL_PCT / 100), tick) : snapTo(low - step, tick);
  } else {
    if (tp >= low) tp = mode === 'push' ? snapTo(low * (1 - DEFAULT_TP_PCT / 100), tick) : snapTo(low - step, tick);
    if (sl <= high) sl = mode === 'push' ? snapTo(high * (1 + DEFAULT_SL_PCT / 100), tick) : snapTo(high + step, tick);
  }
  return { tp, sl };
}

/** Where a new ladder ends by default: 1.5% beyond the entry, against the trade (a long scales in lower, a short higher). */
export function defaultLadderEnd(side: Side, entry: number, tick: number): number {
  const p = entry * (1 + (side === 'BUY' ? -1 : 1) * 0.015);
  return tick > 0 ? Number((Math.round(p / tick) * tick).toPrecision(12)) : p;
}

/** True when an exit sits on the wrong side of the CURRENT price (Binance would refuse or fire it at once): it has to wait for the entry to fill. */
export function exitsMustWait(q: Quick, mark: number): boolean {
  if (!(mark > 0)) return false;
  const long = q.side === 'BUY';
  return (long ? q.tp <= mark : q.tp >= mark) || (long ? q.sl >= mark : q.sl <= mark);
}
