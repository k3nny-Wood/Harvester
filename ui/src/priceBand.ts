/** Binance's percent-price rule: a LIMIT price must stay within [mark x down, mark x up]. Stops and take-profit triggers are exempt. */
export interface PriceBand {
  low: number;
  high: number;
}

function decimalsOf(tick: string): number {
  return (tick.split('.')[1] ?? '').replace(/0+$/, '').length;
}

/** The allowed limit-price band, with both ends moved inside to a whole tick so a price on the edge is accepted. */
export function priceBand(mark: number, multiplierDown: number, multiplierUp: number, tickSize: string): PriceBand | null {
  if (!(mark > 0) || !(multiplierUp > 1) || !(multiplierDown > 0 && multiplierDown < 1)) return null;
  const tick = Number(tickSize);
  const rawLow = mark * multiplierDown;
  const rawHigh = mark * multiplierUp;
  if (!(tick > 0)) return { low: rawLow, high: rawHigh };
  const d = decimalsOf(tickSize);
  return {
    low: Number((Math.ceil(rawLow / tick - 1e-9) * tick).toFixed(d)),
    high: Number((Math.floor(rawHigh / tick + 1e-9) * tick).toFixed(d)),
  };
}

export function clampToBand(price: number, band: PriceBand | null): number {
  if (!band) return price;
  return Math.min(band.high, Math.max(band.low, price));
}
