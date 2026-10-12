import type { LeverageBracket } from './types';

/** The maintenance-margin bracket a position of `notional` USDT falls in (the last one when it is above them all). */
export function bracketFor(brackets: LeverageBracket[], notional: number): LeverageBracket | undefined {
  if (!brackets.length) return undefined;
  const sorted = [...brackets].sort((a, b) => a.notionalFloor - b.notionalFloor);
  return sorted.find((b) => notional >= b.notionalFloor && notional < b.notionalCap) ?? sorted[sorted.length - 1];
}

/**
 * Estimated liquidation price of a NEW isolated one-way position bought / sold at `entry` with `leverage`, from Binance's own formula:
 * the position is liquidated when its margin plus the loss reaches the maintenance margin (notional x ratio - cum).
 * Fees and funding are ignored; a cross-margin position is liquidated later (the whole account backs it).
 */
export function estimateLiquidation(side: 'BUY' | 'SELL', entry: number, leverage: number, notional: number, brackets: LeverageBracket[]): number | null {
  if (!(entry > 0) || !(leverage >= 1)) return null;
  const b = bracketFor(brackets, notional);
  const mmr = b?.maintMarginRatio ?? 0.004;
  const cum = b?.cum ?? 0;
  const q = notional > 0 ? notional / entry : 0;
  const margin = notional / leverage;
  // with no known size, use the size-independent form
  const perUnit = q > 0 ? margin / q : entry / leverage;
  const cumPerUnit = q > 0 ? cum / q : 0;
  const price = side === 'BUY' ? (entry - perUnit - cumPerUnit) / (1 - mmr) : (entry + perUnit + cumPerUnit) / (1 + mmr);
  return price > 0 ? price : null;
}
