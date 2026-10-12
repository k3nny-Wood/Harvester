import { describe, it, expect } from 'vitest';
import { PineTS } from 'pinets';
import { PINE_LIBRARY } from '../src/pine/library';
import { COMMUNITY_LIBRARY, ALL_PINE_LIBRARY } from '../src/pine/communityLibrary';

/**
 * A deterministic 300-bar series: a rising trend with noise, so every indicator
 * in the library has enough history to produce real numbers.
 */
function candles(): Array<{ open: number; high: number; low: number; close: number; volume: number; openTime: number }> {
  const bars = [];
  let price = 100;
  for (let i = 0; i < 300; i += 1) {
    const drift = 0.15 + Math.sin(i / 17) * 0.6;
    const open = price;
    const close = open + drift + Math.cos(i / 9) * 0.4;
    const high = Math.max(open, close) + 0.35;
    const low = Math.min(open, close) - 0.35;
    bars.push({
      open,
      high,
      low,
      close,
      volume: 1000 + i * 7 + Math.abs(Math.sin(i / 5)) * 500,
      openTime: 1700000000000 + i * 60000,
    });
    price = close;
  }
  return bars;
}

describe('Pine Script library', () => {
  it('the library is not empty and every entry has a name and a source', () => {
    expect(PINE_LIBRARY.length).toBeGreaterThan(0);
    for (const entry of PINE_LIBRARY) {
      expect(entry.id).toMatch(/^[a-z0-9-]+$/i);
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.source).toMatch(/indicator\(|strategy\(/);
    }
  });

  for (const entry of PINE_LIBRARY) {
    it(`"${entry.name}" compiles and produces plot data`, async () => {
      const pineTS = new PineTS(candles());
      const result = await pineTS.run(entry.source);
      const plots = result.plots ?? {};
      const names = Object.keys(plots).filter((name) => !name.startsWith('__'));
      expect(names.length).toBeGreaterThan(0);
      const series = plots[names[0]].data as Array<{ time: number; value: unknown }>;
      expect(Array.isArray(series)).toBe(true);
      expect(series.length).toBeGreaterThan(50);
      const numeric = series.filter((point) => typeof point.value === 'number' && Number.isFinite(point.value));
      expect(numeric.length).toBeGreaterThan(10);
    });
  }
});

/**
 * The everget collection. Every entry was ported to Pine v6 and validated before
 * being generated into the library; this test re-runs all of them so a broken
 * entry can never reach the preset dropdown.
 */
async function runs(source: string): Promise<boolean> {
  try {
    const result = await new PineTS(candles()).run(source);
    const entries = Object.entries(result.plots ?? {}).filter(([name]) => !name.startsWith('__'));
    if (entries.length === 0) return false;
    return entries.some(([, plot]) => {
      const series = (plot.data ?? []) as Array<{ value: unknown }>;
      return series.length > 50 && series.filter((point) => Number.isFinite(point.value)).length > 10;
    });
  } catch {
    return false;
  }
}

describe('community Pine library', () => {
  it('every entry has an id, a name, a category and a source', () => {
    expect(ALL_PINE_LIBRARY.length).toBe(PINE_LIBRARY.length + COMMUNITY_LIBRARY.length);
    for (const entry of ALL_PINE_LIBRARY) {
      expect(entry.id).toMatch(/^[a-z0-9-]+$/i);
      expect(entry.name.length).toBeGreaterThan(0);
      expect((entry.category ?? '').length).toBeGreaterThan(0);
      expect(entry.source).toMatch(/indicator\(|strategy\(/);
    }
  });

  it('ids are unique', () => {
    const ids = ALL_PINE_LIBRARY.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const entry of COMMUNITY_LIBRARY) {
    it(`"${entry.name}" compiles and produces plot data`, async () => {
      expect(await runs(entry.source)).toBe(true);
    });
  }
});
