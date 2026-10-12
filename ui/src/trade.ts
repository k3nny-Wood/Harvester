import { api, inTauri, onAccountChanged, onHeldChanged, onUserStream } from './api';
import { activeChartStore } from './chartStore';
import { confirmDialog } from './confirm';
import { useApp } from './store';
import type { OrderRequest, Side } from './types';

/** Refresh the account, positions and open orders from the exchange. */
export async function refreshTrading(): Promise<void> {
  if (!inTauri) return;
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
}

/** How often to poll: the user-data stream pushes every change, so the poll is only a safety net while it is connected. */
export function pollInterval(streamConnected: boolean): number {
  return streamConnected ? 20_000 : 3000;
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
export function quantityFor(price: number, sizeMode: 'usdt' | 'qty' | 'pct', size: number, balance: number, leverage: number): number {
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
  const qty = quantityFor(ref, f.sizeMode, Number(f.size), app.account?.availableBalance ?? 0, lev);
  if (!(qty > 0)) return 'Enter a size greater than zero.';
  return {
    order: { symbol: chart.symbol, side: side ?? f.side, type, quantity: qty, price: limitPrice, stopPrice, postOnly: f.postOnly && hasLimit && type === 'LIMIT', reduceOnly: f.reduceOnly },
    notional: qty * ref,
  };
}
