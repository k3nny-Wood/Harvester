import type { TradeRecord } from '../types';

/** A closed (or partly closed) trade: the fills of one order that realised profit or loss. */
export interface ClosedTrade {
  key: string;
  symbol: string;
  /** the position that was closed was a long (the closing order sold) */
  long: boolean;
  qty: number;
  /** the average closing price, and the entry price it implies */
  exit: number;
  entry: number;
  /** realised profit or loss before fees, the fees of the closing fills, and the net */
  pnl: number;
  fees: number;
  net: number;
  /** the closing value (qty x exit) and the net result relative to the entry value, in percent */
  notional: number;
  pct: number;
  /** when the last closing fill happened (ms) */
  time: number;
}

/** The closed trades in a list of fills: every order whose fills realised profit or loss, newest first. */
export function closedTrades(fills: TradeRecord[]): ClosedTrade[] {
  const by = new Map<string, TradeRecord[]>();
  for (const f of fills) {
    const k = `${f.symbol}:${f.orderId}`;
    by.set(k, [...(by.get(k) ?? []), f]);
  }
  const out: ClosedTrade[] = [];
  for (const [key, list] of by) {
    const closing = list.filter((f) => f.realizedPnl !== 0);
    if (!closing.length) continue;
    const qty = closing.reduce((a, f) => a + f.qty, 0);
    const value = closing.reduce((a, f) => a + f.qty * f.price, 0);
    const pnl = closing.reduce((a, f) => a + f.realizedPnl, 0);
    // the commission is in USDT on the USDT-margined contracts
    const fees = list.reduce((a, f) => a + (f.commissionAsset === 'USDT' || f.commissionAsset === 'USDC' ? f.commission : 0), 0);
    const long = list[0].side === 'SELL';
    const exit = qty > 0 ? value / qty : 0;
    const entry = qty > 0 ? (long ? exit - pnl / qty : exit + pnl / qty) : 0;
    const entryValue = entry * qty;
    out.push({ key, symbol: list[0].symbol, long, qty, exit, entry, pnl, fees, net: pnl - fees, notional: value, pct: entryValue > 0 ? ((pnl - fees) / entryValue) * 100 : 0, time: Math.max(...closing.map((f) => f.time)) });
  }
  return out.sort((a, b) => b.time - a.time);
}

/** The totals of a list of closed trades. */
export function historyTotals(trades: ClosedTrade[]): { count: number; net: number; fees: number; wins: number } {
  return { count: trades.length, net: trades.reduce((a, t) => a + t.net, 0), fees: trades.reduce((a, t) => a + t.fees, 0), wins: trades.filter((t) => t.net > 0).length };
}
