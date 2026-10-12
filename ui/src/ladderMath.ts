import type { Distribution } from './types';

/** Instant, unrounded rung prices for drawing while the trader drags (the Rust core does the exact rounding). */
export function rawRungPrices(start: number, end: number, count: number, distribution: Distribution): number[] {
  const n = Math.max(2, Math.min(50, Math.round(count)));
  if (distribution === 'geometric' && start > 0 && end > 0) {
    const ratio = (end / start) ** (1 / (n - 1));
    return Array.from({ length: n }, (_, i) => start * ratio ** i);
  }
  const step = (end - start) / (n - 1);
  return Array.from({ length: n }, (_, i) => start + step * i);
}

export function snapToTick(price: number, tickSize: string | undefined): number {
  const tick = Number(tickSize);
  if (!tickSize || !tick || tick <= 0) return price;
  const decimals = (tickSize.split('.')[1] ?? '').replace(/0+$/, '').length;
  return Number((Math.round(price / tick) * tick).toFixed(decimals));
}

export function formatPrice(price: number, precision: number): string {
  return price.toFixed(Math.max(0, Math.min(10, precision)));
}
