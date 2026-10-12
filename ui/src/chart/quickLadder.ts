/** How the total size is split over the rungs of a ladder, from the first rung (the entry) to the last (the ladder end). */
export type RungWeights = 'equal' | 'up' | 'down';

export interface Rung {
  price: number;
  qty: number;
}

export const MIN_RUNGS = 2;
export const MAX_RUNGS = 10;

function snap(price: number, tick: number): number {
  if (!(tick > 0)) return price;
  const decimals = (String(tick).split('.')[1] ?? '').length;
  return Number((Math.round(price / tick) * tick).toFixed(decimals));
}

function floorStep(qty: number, step: number): number {
  if (!(step > 0)) return qty;
  const decimals = (String(step).split('.')[1] ?? '').length;
  return Number((Math.floor(qty / step + 1e-9) * step).toFixed(decimals));
}

/** Weight of each rung: equal, growing towards the ladder end ('up') or shrinking towards it ('down'). */
export function rungWeights(count: number, mode: RungWeights): number[] {
  const raw = Array.from({ length: count }, (_, i) => (mode === 'up' ? i + 1 : mode === 'down' ? count - i : 1));
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((w) => w / sum);
}

/**
 * `count` orders spread evenly from `entry` to `end` (both included) that add up to `totalQty`. Prices are snapped to the tick, sizes rounded
 * DOWN to the step, so the total can come out a hair under `totalQty`. A single rung is just the entry.
 */
export function ladderRungs(entry: number, end: number, count: number, mode: RungWeights, totalQty: number, tick: number, step: number): Rung[] {
  const n = Math.max(1, Math.min(MAX_RUNGS, Math.round(count)));
  if (n === 1 || !(end > 0) || end === entry) return [{ price: snap(entry, tick), qty: floorStep(totalQty, step) }];
  const weights = rungWeights(n, mode);
  const out: Rung[] = [];
  for (let i = 0; i < n; i++) {
    const price = snap(entry + ((end - entry) * i) / (n - 1), tick);
    // two rungs may land on the same tick of a very narrow ladder: they are merged
    const qty = floorStep(totalQty * weights[i], step);
    const last = out[out.length - 1];
    if (last && last.price === price) last.qty = floorStep(last.qty + qty, step);
    else out.push({ price, qty });
  }
  return out;
}

/** Size-weighted average price of the rungs (what the position costs once all of them filled). */
export function averagePrice(rungs: Rung[]): number {
  const q = rungs.reduce((a, r) => a + r.qty, 0);
  return q > 0 ? rungs.reduce((a, r) => a + r.price * r.qty, 0) / q : (rungs[0]?.price ?? 0);
}
