import { describe, expect, it } from 'vitest';
import { mergeBases, previewLines } from '../src/bases';
import { baseShapes, visibleBases } from '../src/chart/ChartBases';
import type { BaseView } from '../src/types';

const holding: BaseView = { price: 100, time: 1000, confirmTime: 2000, crackTime: null, crackLevel: 99.5 };
const cracked: BaseView = { price: 90, time: 500, confirmTime: 800, crackTime: 3000, crackLevel: 89.55 };

describe('base shapes', () => {
  it('a holding base is a ray plus its crack level, a cracked one a short dim line', () => {
    const s = baseShapes('BTCUSDT', '15m', [holding, cracked]);
    expect(s.map((x) => x.kind)).toEqual(['holding', 'level', 'cracked']);
    expect(s[0]).toMatchObject({ time: 1000, price: 100 });
    expect(s[0].endTime).toBeUndefined(); // a ray to the edge when no length is set
    expect(s[1]).toMatchObject({ time: 2000, price: 99.5 });
    expect(s[2]).toMatchObject({ time: 500, endTime: 3000, price: 90 });
  });

  it('keys change when a base gets cracked, so the old ray is replaced', () => {
    const before = baseShapes('X', '1h', [holding]).map((x) => x.key);
    const after = baseShapes('X', '1h', [{ ...holding, crackTime: 5000 }]).map((x) => x.key);
    expect(before.some((k) => after.includes(k))).toBe(false);
  });

  it('keys are scoped to the market, so another symbol never reuses a line', () => {
    expect(baseShapes('A', '15m', [holding])[0].key).not.toBe(baseShapes('B', '15m', [holding])[0].key);
  });

  it('broken bases stay on the chart by default; the limits only thin out the bases that still hold', () => {
    const far: BaseView = { price: 50, time: 100, confirmTime: 200, crackTime: null, crackLevel: 49.75 };
    const all = [holding, cracked, far];
    // everything is kept when nothing limits it, in time order
    expect(visibleBases(all, { showBroken: true, maxDistancePct: 0, maxCount: 0 }, 100).map((b) => b.price)).toEqual([50, 90, 100]);
    // the distance limit drops the far HOLDING base, never the broken one (price 90 is 10% away, the limit is 5%)
    expect(visibleBases(all, { showBroken: true, maxDistancePct: 5, maxCount: 0 }, 100).map((b) => b.price)).toEqual([90, 100]);
    // switching broken bases off removes only them
    expect(visibleBases(all, { showBroken: false, maxDistancePct: 0, maxCount: 0 }, 100).map((b) => b.price)).toEqual([50, 100]);
    // without a known price nothing is filtered by distance
    expect(visibleBases(all, { showBroken: true, maxDistancePct: 15, maxCount: 0 }, 0)).toHaveLength(3);
  });

  it('keeps only the nearest N when there are too many', () => {
    const mk = (price: number): BaseView => ({ price, time: price, confirmTime: price + 1, crackTime: null, crackLevel: price * 0.995 });
    const many = [mk(99), mk(90), mk(97), mk(80), mk(95)];
    const brokenOne: BaseView = { price: 60, time: 1, confirmTime: 2, crackTime: 3, crackLevel: 59.7 };
    const got = visibleBases([...many, brokenOne], { showBroken: true, maxDistancePct: 0, maxCount: 2 }, 100).map((b) => b.price);
    // the broken base does not count towards the 2 nearest
    expect(got.sort((a, b) => a - b)).toEqual([60, 97, 99]);
  });

  it('a limited length ends the line that many candles after the base, for the line and its crack level', () => {
    const s = baseShapes('X', '15m', [holding], 30);
    const end = 1000 + 30 * 900_000;
    expect(s.map((x) => x.endTime)).toEqual([end, end]);
  });

  it('the length is part of the key, so changing it redraws the lines', () => {
    expect(baseShapes('X', '15m', [holding], 30)[0].key).not.toBe(baseShapes('X', '15m', [holding], 60)[0].key);
  });

  it('merges holding bases at nearly the same price into one that starts at the oldest', () => {
    const b = (price: number, time: number): BaseView => ({ price, time, confirmTime: time + 10, crackTime: null, crackLevel: price * 0.995 });
    const merged = mergeBases([b(100, 3000), b(100.3, 1000), b(100.4, 2000), b(120, 500)], 0.5);
    expect(merged).toHaveLength(2);
    const near = merged.find((m) => Math.abs(m.price - 100.2333) < 0.01)!;
    expect(near.count).toBe(3);
    expect(near.time).toBe(1000);
    expect(near.confirmTime).toBe(1010);
    expect(merged.find((m) => m.price === 120)!.count).toBe(1);
  });

  it('does not chain a slowly rising run of bases into one line, and leaves broken bases alone', () => {
    const b = (price: number, time: number): BaseView => ({ price, time, confirmTime: time + 1, crackTime: null, crackLevel: price });
    const run = [b(100, 1), b(100.4, 2), b(100.8, 3), b(101.2, 4)];
    expect(mergeBases(run, 0.5).map((m) => m.count)).toEqual([2, 2]);
    const broken: BaseView = { ...cracked, price: 100.1 };
    const out = mergeBases([b(100, 1), broken], 0.5);
    expect(out).toHaveLength(2);
    expect(out.find((m) => m.crackTime != null)!.count).toBe(1);
    // tolerance 0 means no merging at all
    expect(mergeBases(run, 0)).toHaveLength(4);
  });

  it('the preview labels merged levels and marks the own base', () => {
    const candles = [{ time: 100 }, { time: 200 }, { time: 300 }];
    const bases: BaseView[] = [
      { price: 50, time: 200, confirmTime: 300, crackTime: null, crackLevel: 49.75, count: 3 },
      { price: 40, time: 100, confirmTime: 200, crackTime: null, crackLevel: 39.8, count: 1 },
      { price: 30, time: 100, confirmTime: 100, crackTime: 250, crackLevel: 29.85, count: 1 },
    ];
    const lines = previewLines(candles, bases, 50.05, (p) => p.toFixed(2));
    const labels = lines.map((l) => l.label).filter(Boolean);
    expect(labels).toEqual(['this base 50.00 ×3', '40.00']);
    // the broken base is a dim segment (one line); a crack level line follows each base that holds
    expect(lines).toHaveLength(5);
    expect(lines[0].from).toBe(1);
  });

  it('draws broken bases as dim segments ending at the crack, the signal own one bright with its crack level', () => {
    const candles = [{ time: 100 }, { time: 200 }, { time: 300 }, { time: 400 }];
    const ownBroken: BaseView = { price: 50, time: 100, confirmTime: 200, crackTime: 300, crackLevel: 49.75 };
    const otherBroken: BaseView = { price: 70, time: 100, confirmTime: 200, crackTime: 400, crackLevel: 69.65 };
    const lines = previewLines(candles, [ownBroken, otherBroken], 50.02, (p) => p.toFixed(1));
    expect(lines.map((l) => l.label).filter(Boolean)).toEqual(['this base 50.0']);
    const dim = lines.find((l) => l.price === 70)!;
    expect(dim).toMatchObject({ from: 0, to: 3, width: 1 });
    expect(lines.filter((l) => l.price === 70)).toHaveLength(1); // no crack level line for a base that is not the signal's
    expect(lines.find((l) => l.price === 49.75)).toBeDefined();
  });
});
