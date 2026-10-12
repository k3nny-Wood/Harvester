import { describe, expect, it } from 'vitest';
import { previewBoxes, zoneDistancePct, zoneEdges, zoneLabel, zoneStrength } from '../src/bases';
import { visibleZones, zoneShapes } from '../src/chart/ChartBases';
import type { BaseZone } from '../src/types';

const zone = (p: Partial<BaseZone> & { low: number }): BaseZone => ({ high: p.low, time: 1000, confirmTime: 2000, crackTime: null, crackLevel: p.low * 0.995, bases: 1, touches: 0, ...p });
const lone = zone({ low: 100 });
const broken = zone({ low: 90, time: 500, confirmTime: 800, crackTime: 3000 });
const strong = zone({ low: 80, high: 80.3, bases: 3, touches: 4 });

describe('zone helpers', () => {
  it('a lone base gets a sliver of height, a merged zone keeps its own extent', () => {
    const e = zoneEdges(lone);
    expect(e.bottom).toBe(100);
    expect(e.top).toBeGreaterThan(100);
    expect(zoneEdges(strong)).toEqual({ bottom: 80, top: 80.3 });
  });

  it('strength grows with bases and retests and stays within 0..1', () => {
    expect(zoneStrength(strong)).toBeGreaterThan(zoneStrength(lone));
    expect(zoneStrength({ bases: 20, touches: 50 })).toBe(1);
  });

  it('labels merged zones and zones that were retested, and stays quiet for a lone base', () => {
    expect(zoneLabel(strong)).toBe('×3 · 4 retests');
    expect(zoneLabel(zone({ low: 1, touches: 1 }))).toBe('');
    expect(zoneLabel(zone({ low: 1, touches: 2 }))).toBe('2 retests');
    expect(zoneLabel(zone({ low: 1, bases: 2, touches: 1 }))).toBe('×2 · 1 retest');
  });

  it('the distance to a zone is to its nearest edge, and zero inside it', () => {
    expect(zoneDistancePct(strong, 80.1)).toBe(0);
    expect(zoneDistancePct(strong, 88)).toBeCloseTo((1 - 80.3 / 88) * 100 * (88 / 80.3 > 1 ? 1 : 1), 0);
    expect(zoneDistancePct(lone, 0)).toBe(0);
  });
});

describe('visible zones', () => {
  it('broken zones stay by default; the limits only thin out zones that still hold', () => {
    const all = [lone, broken, strong];
    expect(visibleZones(all, { showBroken: true, maxDistancePct: 0, maxCount: 0 }, 100).map((z) => z.low)).toEqual([90, 100, 80]);
    // the distance limit drops the far HOLDING zone, never the broken one
    expect(visibleZones(all, { showBroken: true, maxDistancePct: 5, maxCount: 0 }, 100).map((z) => z.low)).toEqual([90, 100]);
    // switching broken zones off removes only them
    expect(visibleZones(all, { showBroken: false, maxDistancePct: 0, maxCount: 0 }, 100).map((z) => z.low)).toEqual([100, 80]);
  });

  it('keeps only the nearest N holding zones, and broken ones do not count', () => {
    const many = [99, 90, 97, 80, 95].map((low) => zone({ low, time: low }));
    const out = visibleZones([...many, broken], { showBroken: true, maxDistancePct: 0, maxCount: 2 }, 100).map((z) => z.low);
    expect(out.sort((a, b) => a - b)).toEqual([90, 97, 99]);
  });
});

describe('zone shapes', () => {
  it('a holding zone is a box with a dotted crack level; a broken one a dim box that stops at the crack', () => {
    const s = zoneShapes('BTCUSDT', '15m', [lone, broken], 30);
    expect(s.map((x) => x.kind)).toEqual(['holding', 'level', 'broken']);
    expect(s[0].endTime).toBe(1000 + 30 * 900_000);
    expect(s[1]).toMatchObject({ time: 2000, bottom: lone.crackLevel, top: lone.crackLevel });
    expect(s[2]).toMatchObject({ time: 500, endTime: 3000 });
  });

  it('a zone that gains a base or a retest, or changes the length, is redrawn under a new key', () => {
    const k = (z: BaseZone, len = 30) => zoneShapes('X', '1h', [z], len)[0].key;
    expect(k(lone)).not.toBe(k({ ...lone, bases: 2 }));
    expect(k(lone)).not.toBe(k({ ...lone, touches: 3 }));
    expect(k(lone)).not.toBe(k(lone, 60));
    expect(zoneShapes('A', '15m', [lone])[0].key).not.toBe(zoneShapes('B', '15m', [lone])[0].key);
  });

  it('a stronger zone is drawn more opaque', () => {
    const a = zoneShapes('X', '15m', [lone], 30)[0];
    const b = zoneShapes('X', '15m', [strong], 30)[0];
    expect(b.fillOpacity).toBeGreaterThan(a.fillOpacity);
  });
});

describe('preview boxes', () => {
  const candles = [{ time: 100 }, { time: 200 }, { time: 300 }, { time: 400 }];

  it('labels merged zones, marks the own zone and draws broken zones as dim boxes ending at the crack', () => {
    const zones = [
      zone({ low: 50, high: 50.2, time: 200, confirmTime: 300, bases: 3, touches: 2 }),
      zone({ low: 40, time: 100, confirmTime: 200 }),
      zone({ low: 70, time: 100, confirmTime: 200, crackTime: 400 }),
    ];
    const boxes = previewBoxes(candles, zones, 50.05, (p) => p.toFixed(1));
    expect(boxes.map((b) => b.label)).toEqual(['this base 50.0 ×3 · 2 retests', '40.0', '']);
    expect(boxes[0].from).toBe(1);
    expect(boxes[2]).toMatchObject({ from: 0, to: 3, dash: [4, 3] });
    expect(boxes[2].crackLine).toBeUndefined();
    expect(boxes[0].crackLine).toBeDefined();
  });

  it('draws the signal own zone even when broken, with its crack level', () => {
    const own = zone({ low: 50, time: 100, confirmTime: 200, crackTime: 300 });
    const [b] = previewBoxes(candles, [own], 50.02, (p) => p.toFixed(1));
    expect(b.label).toBe('this base 50.0');
    expect(b.crackLine).toBe(own.crackLevel);
    expect(b.to).toBe(2);
  });
});
