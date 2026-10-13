import type { ArmedBracket, HeldOrder, OpenOrder, Position } from './types';

/**
 * Symbols whose reduce-only orders (the stop-loss, take-profit and closing limits) are left over: the position is gone, and nothing is
 * waiting that those orders could belong to (no entry order still open, no armed exits, no held order). Once a position has closed by its
 * take-profit, its stop-loss is useless; a reduce-only order with no position can never do anything.
 */
export function leftoverSymbols(positions: Position[], orders: OpenOrder[], held: HeldOrder[], brackets: ArmedBracket[]): string[] {
  const holding = new Set(positions.filter((p) => p.amount !== 0).map((p) => p.symbol));
  const waiting = new Set<string>();
  for (const o of orders) if (!o.reduceOnly) waiting.add(o.symbol); // an entry that has not filled yet
  for (const h of held) if (h.status === 'held') waiting.add(h.request.symbol);
  for (const b of brackets) waiting.add(b.symbol);
  const out = new Set<string>();
  for (const o of orders) {
    if (o.reduceOnly && !holding.has(o.symbol) && !waiting.has(o.symbol)) out.add(o.symbol);
  }
  return [...out].sort();
}

/** The orders to cancel on a symbol, given what it looks like right now. */
export function leftoverOrders(symbol: string, positions: Position[], orders: OpenOrder[], held: HeldOrder[], brackets: ArmedBracket[]): OpenOrder[] {
  if (!leftoverSymbols(positions, orders, held, brackets).includes(symbol)) return [];
  return orders.filter((o) => o.symbol === symbol && o.reduceOnly);
}
