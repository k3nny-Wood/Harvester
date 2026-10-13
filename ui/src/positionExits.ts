import type { OpenOrder } from './types';

/** Where a new stop-loss / take-profit starts, as a percentage away from the current price. */
export const DEFAULT_STOP_PCT = 1.5;
export const DEFAULT_TAKE_PCT = 3;

export interface ExitState {
  /** the position's stop-loss: a reduce-only stop order on the closing side */
  stop: OpenOrder | null;
  /** the position's take-profit: a reduce-only take-profit order, or a reduce-only limit on the closing side */
  take: OpenOrder | null;
}

/** The stop-loss and take-profit a position already has, among the open orders. */
export function exitState(symbol: string, positionAmount: number, orders: OpenOrder[]): ExitState {
  const closing = positionAmount > 0 ? 'SELL' : 'BUY';
  const mine = orders.filter((o) => o.symbol === symbol && o.reduceOnly && o.side === closing);
  const stop = mine.find((o) => o.type.startsWith('STOP')) ?? null;
  const take = mine.find((o) => o.type.startsWith('TAKE_PROFIT') || o.type === 'LIMIT') ?? null;
  return { stop, take };
}

/** The price a new exit starts at: below the market for a long's stop-loss and above it for its take-profit, mirrored for a short. */
export function defaultExitPrice(kind: 'stop' | 'take', long: boolean, mark: number): number {
  const against = kind === 'stop' ? -1 : 1; // the profit side is up for a long
  const dir = (long ? 1 : -1) * against;
  const pct = kind === 'stop' ? DEFAULT_STOP_PCT : DEFAULT_TAKE_PCT;
  return mark * (1 + (dir * pct) / 100);
}
