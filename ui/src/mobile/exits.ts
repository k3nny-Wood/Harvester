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

export interface ExitSetting {
  /** the button is pressed: this exit is part of the order */
  on: boolean;
  /** a price or a percentage */
  text: string;
}

/** The stop-loss and take-profit prices of an order, measured from `entry`. `null` for an exit that is off or whose text is not a level; the result says why when it is refused. */
export function resolveBoth(long: boolean, entry: number, sl: ExitSetting, tp: ExitSetting): { sl: ExitResult | null; tp: ExitResult | null } {
  const one = (kind: 'stop' | 'take', e: ExitSetting): ExitResult | null => {
    if (!e.on) return null;
    const level = parseLevel(e.text);
    return level ? resolveExit(kind, long, entry, level) : { ok: false, error: 'Enter a price or a percentage.' };
  };
  return { sl: one('stop', sl), tp: one('take', tp) };
}

/** True when an exit sits on the wrong side of the CURRENT price (Binance would refuse it or fire it at once): it has to wait for the entry to fill. */
export function exitsWait(long: boolean, mark: number, slPrice: number | null, tpPrice: number | null): boolean {
  if (!(mark > 0)) return false;
  const tpBad = tpPrice != null && (long ? tpPrice <= mark : tpPrice >= mark);
  const slBad = slPrice != null && (long ? slPrice >= mark : slPrice <= mark);
  return tpBad || slBad;
}

/** The distance of `price` from `entry` as the text of a percentage box ("1.37%"); never below 0.05%, so a line dragged to the wrong side stops at the entry. */
export function pctText(entry: number, price: number): string {
  if (!(entry > 0)) return '1%';
  const pct = Math.max(0.05, Math.abs(price / entry - 1) * 100);
  return `${Number(pct.toFixed(2))}%`;
}
