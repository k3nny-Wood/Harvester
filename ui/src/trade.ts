import { api, hasBackend, onAccountChanged, onHeldChanged, onUserStream } from './api';
import { activeChartStore } from './chartStore';
import { confirmDialog } from './confirm';
import { useApp } from './store';
import { closeOrder } from './sizing';
import { leftoverOrders, leftoverSymbols } from './leftovers';
import type { OrderRequest, Side } from './types';

/** Refresh the account, positions and open orders from the exchange. */
export async function refreshTrading(): Promise<void> {
  if (!hasBackend) return;
  const app = useApp.getState();
  const status = await api.tradingStatus().catch(() => null);
  if (status) app.setTrading(status);
  if (!status?.hasCredentials) {
    app.setAccount(null);
    app.setOrders([]);
    return;
  }
  const [account, orders] = await Promise.all([api.account().catch((e) => (app.toast(`Account: ${e}`, 'warn'), null)), api.openOrders().catch(() => null)]);
  if (account) app.setAccount(account);
  if (orders) app.setOrders(orders);
  const held = await api.heldList().catch(() => null);
  if (held) app.setHeld(held);
  void cleanLeftovers();
}

/** Leftover stop-loss / take-profit orders are only cancelled once they have been seen this long, and after a fresh check of the exchange. */
const LEFTOVER_WAIT_MS = 4000;
const leftoverSince = new Map<string, number>();
let cleaning = false;

/**
 * When a position has closed (its take-profit or stop-loss fired, or it was closed by hand) the other exit order is left on the exchange.
 * A reduce-only order with no position can do nothing, so it is cancelled. A symbol only counts when it looks orphaned for a few seconds in a row
 * and again on a fresh read, so the exits of an entry that has just filled are never taken for leftovers.
 */
async function cleanLeftovers(): Promise<void> {
  if (cleaning || !hasBackend) return;
  const app = useApp.getState();
  const positions = app.account?.positions ?? [];
  const candidates = leftoverSymbols(positions, app.orders, app.held, []);
  for (const sym of [...leftoverSince.keys()]) if (!candidates.includes(sym)) leftoverSince.delete(sym);
  if (!candidates.length) return;
  const now = Date.now();
  const ripe = candidates.filter((sym) => {
    if (!leftoverSince.has(sym)) leftoverSince.set(sym, now);
    return now - (leftoverSince.get(sym) ?? now) >= LEFTOVER_WAIT_MS;
  });
  if (!ripe.length) return;
  cleaning = true;
  try {
    const [account, brackets, held] = await Promise.all([api.account(), api.bracketList(), api.heldList()]);
    for (const sym of ripe) {
      const open = await api.openOrders(sym);
      const stale = leftoverOrders(sym, account.positions, open, held, brackets);
      if (!stale.length) {
        leftoverSince.delete(sym);
        continue;
      }
      let cancelled = 0;
      for (const o of stale) {
        try {
          await api.cancelOrder(sym, o.orderId, o.conditional);
          cancelled += 1;
        } catch {
          /* it may have just been cancelled or triggered: the next refresh shows what is left */
        }
      }
      leftoverSince.delete(sym);
      if (cancelled) app.toast(`${sym}: cancelled ${cancelled} leftover stop-loss / take-profit order${cancelled === 1 ? '' : 's'} (the position is closed)`, 'info');
    }
    const refreshed = await api.openOrders().catch(() => null);
    if (refreshed) useApp.getState().setOrders(refreshed);
  } catch {
    /* try again on the next refresh */
  } finally {
    cleaning = false;
  }
}

/** How often to poll: the user-data stream pushes every change, so the poll is only a safety net while it is connected. */
export function pollInterval(streamConnected: boolean): number {
  return streamConnected ? 10_000 : 3000;
}

/**
 * Keep the account, positions and orders current: refresh at once when Binance pushes a change (user-data stream,
 * coalesced so a burst of fills reads once), and poll as a fallback (fast while the stream is down).
 */
export function startTradingPoll(): () => void {
  void refreshTrading();
  let connected = false;
  let timer = 0;
  let debounce = 0;
  const arm = () => {
    window.clearInterval(timer);
    timer = window.setInterval(() => void refreshTrading(), pollInterval(connected));
  };
  arm();
  const offs: Array<() => void> = [];
  let stopped = false;
  const keep = (p: Promise<() => void>) => void p.then((off) => (stopped ? off() : offs.push(off))).catch(() => undefined);
  keep(
    onAccountChanged(() => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => void refreshTrading(), 150);
    }),
  );
  keep(
    onHeldChanged((e) => {
      useApp.getState().toast(e.message, e.status === 'placed' ? 'info' : 'warn');
      void refreshTrading();
    }),
  );
  keep(
    onUserStream((c) => {
      useApp.getState().setStreamConnected(c);
      if (c !== connected) {
        connected = c;
        arm();
      }
    }),
  );
  return () => {
    stopped = true;
    window.clearInterval(timer);
    window.clearTimeout(debounce);
    offs.forEach((o) => o());
  };
}

/** Quantity for the order form's size setting at a given price. */
export function quantityFor(price: number, sizeMode: 'usdt' | 'qty' | 'pct' | 'pos', size: number, balance: number, leverage: number, positionAmount = 0): number {
  if (sizeMode === 'pos') return Math.abs(positionAmount) * (size > 0 ? Math.min(size, 100) : 0) / 100;
  if (!(price > 0) || !(size > 0)) return 0;
  if (sizeMode === 'qty') return size;
  if (sizeMode === 'usdt') return size / price;
  return (balance * (size / 100) * Math.max(1, leverage)) / price; // % of balance used as margin x leverage
}

export function describeOrder(side: Side, type: string, qty: number, symbol: string, price?: number): string {
  return `${side} ${type} ${qty} ${symbol.replace('USDT', '')}${price ? ` @ ${price}` : ''}`;
}

/** Place one order and report the outcome as a toast. Returns true when the exchange accepted it. */
export async function submitOrder(order: OrderRequest, confirmText?: string): Promise<boolean> {
  const app = useApp.getState();
  if (confirmText && !(await confirmDialog(confirmText, { danger: app.env === 'live', confirmLabel: 'Place order' }))) return false;
  try {
    const ack = await api.placeOrder(order);
    if (ack.status === 'HELD') {
      app.toast(`Held on this computer: ${describeOrder(order.side, order.type, ack.quantity, order.symbol, ack.price ?? undefined)}. Binance only accepts limit orders close to the market; this one is sent automatically when the price comes within range (Harvester must be open).`, 'info');
    } else {
      app.toast(`Placed: ${describeOrder(order.side, order.type, ack.quantity, order.symbol, ack.price ?? undefined)} (${ack.status})`, 'info');
    }
    void refreshTrading();
    return true;
  } catch (e) {
    app.toast(`Order rejected: ${e}`, 'warn');
    return false;
  }
}

/** The current form settings turned into an order for the focused chart's symbol. */
export function orderFromForm(price?: number, side?: Side): { order: OrderRequest; notional: number } | string {
  const app = useApp.getState();
  const chart = activeChartStore()?.getState();
  if (!chart) return 'No chart is open.';
  const f = app.orderForm;
  const type = price != null ? 'LIMIT' : f.type; // the right-click menu always places a limit order at the clicked price
  const isStop = type === 'STOP_MARKET' || type === 'STOP' || type === 'TAKE_PROFIT_MARKET' || type === 'TAKE_PROFIT';
  const hasLimit = type === 'LIMIT' || type === 'STOP' || type === 'TAKE_PROFIT';
  const stopPrice = isStop ? Number(f.stopPrice) || undefined : undefined;
  if (isStop && !stopPrice) return 'Enter a trigger (stop) price.';
  const limitPrice = hasLimit ? price ?? (Number(f.price) || stopPrice || chart.markPrice) : undefined;
  const ref = limitPrice ?? stopPrice ?? chart.markPrice;
  const lev = Number(f.leverage) || 1;
  // a share of the holdings: the closing side, reduce-only, never more than is held
  if (f.sizeMode === 'pos') {
    const pos = app.account?.positions.find((p) => p.symbol === chart.symbol && p.amount !== 0);
    if (!pos) return `You hold no ${chart.symbol} position to close.`;
    const c = closeOrder(pos.amount, Number(f.size), Number(chart.filters?.stepSize) || 0);
    if (!c) return 'That share of the position is below the smallest order size.';
    return {
      order: { symbol: chart.symbol, side: c.side, type, quantity: c.quantity, price: limitPrice, stopPrice, postOnly: f.postOnly && hasLimit && type === 'LIMIT', reduceOnly: true },
      notional: c.quantity * ref,
    };
  }
  const qty = quantityFor(ref, f.sizeMode, Number(f.size), app.account?.availableBalance ?? 0, lev);
  if (!(qty > 0)) return 'Enter a size greater than zero.';
  return {
    order: { symbol: chart.symbol, side: side ?? f.side, type, quantity: qty, price: limitPrice, stopPrice, postOnly: f.postOnly && hasLimit && type === 'LIMIT', reduceOnly: f.reduceOnly },
    notional: qty * ref,
  };
}
