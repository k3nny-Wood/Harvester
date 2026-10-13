import { maxPct, sizeFromPct } from './sizing';

/** Quantity bought by adding `pct` percent of the account as margin at `leverage`, at `price`. */
export function addQuantity(pct: number, wallet: number, leverage: number, price: number): number {
  return price > 0 ? sizeFromPct(pct, wallet, leverage).notional / price : 0;
}

/**
 * The largest share of the account the "add" slider may use. Beyond the account itself, one order may not be worth more than the safety cap:
 * when growing an order, what it is worth already counts against that cap.
 */
export function maxAddPct(wallet: number, leverage: number, cap: number, currentNotional: number): number {
  if (cap > 0 && cap <= currentNotional) return 0;
  return maxPct(wallet, leverage, cap > 0 ? cap - currentNotional : 0);
}

/** Round a quantity DOWN to the exchange's step (never more than was asked for). */
export function floorQty(qty: number, step: number): number {
  if (!(step > 0)) return qty;
  const decimals = (String(step).split('.')[1] ?? '').length;
  return Number((Math.floor(qty / step + 1e-9) * step).toFixed(decimals));
}
