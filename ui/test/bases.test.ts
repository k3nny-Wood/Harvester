import { describe, expect, it } from 'vitest';
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

  it('broken bases are hidden unless asked for, and far ones are dropped', () => {
    const far: BaseView = { price: 50, time: 100, confirmTime: 200, crackTime: null, crackLevel: 49.75 };
    const all = [holding, cracked, far];
    expect(visibleBases(all, { showBroken: false, maxDistancePct: 0, maxCount: 0 }, 100)).toEqual([holding, far]);
    expect(visibleBases(all, { showBroken: true, maxDistancePct: 0, maxCount: 0 }, 100)).toEqual(all);
    expect(visibleBases(all, { showBroken: false, maxDistancePct: 15, maxCount: 0 }, 100)).toEqual([holding]);
    // without a known price nothing is filtered by distance
    expect(visibleBases(all, { showBroken: false, maxDistancePct: 15, maxCount: 0 }, 0)).toEqual([holding, far]);
  });

  it('keeps only the nearest N when there are too many', () => {
    const mk = (price: number): BaseView => ({ price, time: price, confirmTime: price + 1, crackTime: null, crackLevel: price * 0.995 });
    const many = [mk(99), mk(90), mk(97), mk(80), mk(95)];
    const got = visibleBases(many, { showBroken: false, maxDistancePct: 0, maxCount: 2 }, 100).map((b) => b.price);
    expect(got).toEqual([99, 97]);
  });

  it('a limited length ends the line that many candles after the base, for the line and its crack level', () => {
    const s = baseShapes('X', '15m', [holding], 30);
    const end = 1000 + 30 * 900_000;
    expect(s.map((x) => x.endTime)).toEqual([end, end]);
  });

  it('the length is part of the key, so changing it redraws the lines', () => {
    expect(baseShapes('X', '15m', [holding], 30)[0].key).not.toBe(baseShapes('X', '15m', [holding], 60)[0].key);
  });
});
