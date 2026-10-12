import { api, inTauri } from './api';
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
}

/** Poll the exchange every few seconds while the app is open (a user-data websocket comes later). */
export function startTradingPoll(): () => void {
  void refreshTrading();
  const t = window.setInterval(() => void refreshTrading(), 3000);
  return () => window.clearInterval(t);
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
    app.toast(`Placed: ${describeOrder(order.side, order.type, ack.quantity, order.symbol, ack.price ?? undefined)} (${ack.status})`, 'info');
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
