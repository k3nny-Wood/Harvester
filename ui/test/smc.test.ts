import { describe, expect, it } from 'vitest';
import { smcShapes, wantedZones } from '../src/chart/ChartSmc';
import type { SmcZone } from '../src/types';

const z = (p: Partial<SmcZone>): SmcZone => ({ kind: 'fvg', bullish: true, time: 1000, confirmTime: 2000, low: 100, high: 102, fullLow: 100, fullHigh: 103, partiallyMitigated: false, sizePct: 1, ...p });

describe('smc overlay', () => {
  it('draws only the kinds the settings ask for', () => {
    const all = [z({}), z({ kind: 'orderBlock' }), z({ kind: 'breaker' })];
    expect(wantedZones(all, { showFvg: true, showOrderBlocks: false, showBreakers: false }).map((x) => x.kind)).toEqual(['fvg']);
    expect(wantedZones(all, { showFvg: true, showOrderBlocks: true, showBreakers: true })).toHaveLength(3);
  });

  it('colours support green and resistance red, and runs the zone to the right from its confirming candle', () => {
    const [up, down] = smcShapes('BTCUSDT', '15m', [z({}), z({ bullish: false })], 40);
    expect(up.rgb).toBe('46, 155, 111');
    expect(down.rgb).toBe('208, 69, 75');
    expect(up.time).toBe(1000);
    expect(up.endTime).toBe(2000 + 40 * 900_000);
    expect(up).toMatchObject({ bottom: 100, top: 102 });
  });

  it('labels the kind and direction, shows a tapped zone as tapped and dashes breakers', () => {
    const shapes = smcShapes('X', '1h', [z({}), z({ kind: 'orderBlock', bullish: false, partiallyMitigated: true }), z({ kind: 'breaker' })], 0);
    expect(shapes.map((s) => s.label)).toEqual(['FVG↑', 'OB↓ tapped', 'BB↑']);
    expect(shapes.map((s) => s.dashed)).toEqual([false, false, true]);
    // a length of 0 means to the edge of the chart: far to the right
    expect(shapes[0].endTime).toBeGreaterThan(2000 + 1000 * 3_600_000);
  });

  it('a zone that shrinks or moves is redrawn under a new key', () => {
    const k = (zone: SmcZone) => smcShapes('X', '15m', [zone], 30)[0].key;
    expect(k(z({}))).not.toBe(k(z({ high: 101.5 })));
    expect(smcShapes('A', '15m', [z({})], 30)[0].key).not.toBe(smcShapes('B', '15m', [z({})], 30)[0].key);
  });
});
