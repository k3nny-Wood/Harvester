import type { BaseZone } from './types';

/** How strongly a zone should be drawn: more bases and more retests that held make a darker, firmer box. */
export function zoneStrength(z: Pick<BaseZone, 'bases' | 'touches'>): number {
  return Math.min(1, 0.25 + 0.2 * (z.bases - 1) + 0.08 * Math.min(z.touches, 5));
}

/** The vertical extent of a zone as a box. A lone base has no height of its own, so it gets a sliver just above the low. */
export function zoneEdges(z: Pick<BaseZone, 'low' | 'high'>): { bottom: number; top: number } {
  return { bottom: z.low, top: Math.max(z.high, z.low * 1.0012) };
}

/** A short label for a zone, e.g. "×3 · 2 retests"; empty for a lone base nobody came back to. */
export function zoneLabel(z: Pick<BaseZone, 'bases' | 'touches'>): string {
  const parts: string[] = [];
  if (z.bases > 1) parts.push(`×${z.bases}`);
  if (z.touches > 0 && (z.bases > 1 || z.touches > 1)) parts.push(`${z.touches} ${z.touches === 1 ? 'retest' : 'retests'}`);
  return parts.join(' · ');
}

/** Distance in percent from the price to the nearest edge of a zone (0 when the price is inside it). */
export function zoneDistancePct(z: Pick<BaseZone, 'low' | 'high'>, last: number): number {
  if (!(last > 0)) return 0;
  if (last >= z.low && last <= z.high) return 0;
  return Math.min(Math.abs(z.low / last - 1), Math.abs(z.high / last - 1)) * 100;
}

export interface PreviewBox {
  bottom: number;
  top: number;
  /** index of the first candle the box covers */
  from: number;
  /** index of the last candle it covers; undefined = to the right edge */
  to?: number;
  color: string;
  /** fill opacity 0..1 */
  fill: number;
  width: number;
  dash: number[];
  label: string;
  /** the dotted crack level under a zone (a line, not a box) */
  crackLine?: number;
}

const BLUE = '#4f8fdd';
const BRIGHT = '#7cc0ff';
const DIM = 'rgba(79, 143, 221, 0.6)';

/**
 * Boxes for the big hover preview: every zone that holds as a box from its oldest base to the right with its crack level dotted
 * below, merged zones labelled with how many bases and retests they combine, broken zones as dim boxes ending at the crack, and the
 * signal's own base highlighted (a crack signal is about a base price has already broken).
 */
export function previewBoxes(candles: Array<{ time: number }>, zones: BaseZone[], ownBase: number | null | undefined, fmt: (p: number) => string): PreviewBox[] {
  const index = (t: number) => {
    const i = candles.findIndex((c) => c.time >= t);
    return i < 0 ? candles.length - 1 : i;
  };
  const out: PreviewBox[] = [];
  for (const z of zones) {
    const { bottom, top } = zoneEdges(z);
    const own = ownBase != null && ownBase > 0 && ownBase >= z.low * 0.997 && ownBase <= z.high * 1.003;
    const extra = zoneLabel(z);
    const label = `${own ? 'this base ' : ''}${fmt(z.low)}${extra ? ` ${extra}` : ''}`;
    if (z.crackTime != null) {
      out.push({ bottom, top, from: index(z.time), to: index(z.crackTime), color: own ? BRIGHT : DIM, fill: own ? 0.22 : 0.08, width: own ? 1.5 : 1, dash: own ? [] : [4, 3], label: own || extra ? label : '', crackLine: own ? z.crackLevel : undefined });
    } else {
      out.push({ bottom, top, from: index(z.time), color: own ? BRIGHT : BLUE, fill: 0.08 + 0.2 * zoneStrength(z), width: z.bases > 1 ? 1.6 : 1, dash: [], label, crackLine: z.crackLevel });
    }
  }
  return out;
}
