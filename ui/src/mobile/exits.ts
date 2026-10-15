/** A stop-loss / take-profit level as typed on the phone: `95000` is a price, `2%` a distance from the current price on the right side. */
export type Level = { kind: 'price' | 'pct'; value: number };

export function parseLevel(text: string): Level | null {
  const t = text.trim().replace(',', '.');
  const pct = t.endsWith('%');
  const v = Number(pct ? t.slice(0, -1) : t);
  if (!t || !Number.isFinite(v) || v <= 0) return null;
  return { kind: pct ? 'pct' : 'price', value: v };
}

export type ExitResult = { ok: true; price: number } | { ok: false; error: string };

/** The price for the exit, refused when it is on the wrong side of the current price (a stop that would fire at once). */
export function resolveExit(kind: 'stop' | 'take', long: boolean, mark: number, level: Level): ExitResult {
  if (!(mark > 0)) return { ok: false, error: 'There is no current price to check against.' };
  // is the exit on the profit side of the price?
  const above = (kind === 'take') === long;
  let price: number;
  if (level.kind === 'pct') {
    if (level.value >= 100) return { ok: false, error: 'A percentage must be below 100.' };
    price = above ? mark * (1 + level.value / 100) : mark * (1 - level.value / 100);
  } else {
    price = level.value;
  }
  if ((above && price <= mark) || (!above && price >= mark)) {
    return { ok: false, error: `A ${kind === 'stop' ? 'stop-loss' : 'take-profit'} for a ${long ? 'long' : 'short'} must be ${above ? 'above' : 'below'} the current price.` };
  }
  return { ok: true, price };
}
