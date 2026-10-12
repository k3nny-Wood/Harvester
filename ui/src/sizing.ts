/** Order size as the right-click menu shows it: a share of the account, the margin it ties up and the position it buys. */
export interface SizeView {
  /** percent of the account (wallet balance) used as margin */
  pct: number;
  /** USDT of margin */
  margin: number;
  /** USDT value of the position (margin x leverage) */
  notional: number;
}

/** What `pct` percent of the account buys at `leverage`. */
export function sizeFromPct(pct: number, wallet: number, leverage: number): SizeView {
  const lev = Math.max(1, leverage || 1);
  const margin = Math.max(0, wallet) * Math.max(0, pct) / 100;
  return { pct: Math.max(0, pct), margin, notional: margin * lev };
}

/** The share of the account a position of `notional` USDT is, at `leverage`. */
export function pctFromNotional(notional: number, wallet: number, leverage: number): number {
  const lev = Math.max(1, leverage || 1);
  return wallet > 0 && notional > 0 ? (notional / lev / wallet) * 100 : 0;
}

/** The position value, in USDT, of the order form's current size setting at `price`. */
export function notionalOfForm(sizeMode: 'usdt' | 'qty' | 'pct', size: number, price: number, available: number, leverage: number): number {
  if (!(size > 0)) return 0;
  if (sizeMode === 'usdt') return size;
  if (sizeMode === 'qty') return size * Math.max(0, price);
  return available * (size / 100) * Math.max(1, leverage || 1); // '% balance' uses the available balance as margin
}

/** The largest share of the account the slider may reach: the whole account, or less when the safety cap on one order is lower. */
export function maxPct(wallet: number, leverage: number, cap: number): number {
  if (!(wallet > 0)) return 0;
  const lev = Math.max(1, leverage || 1);
  return Math.min(100, cap > 0 ? (cap / lev / wallet) * 100 : 100);
}
