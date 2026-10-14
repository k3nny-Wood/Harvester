import { describe, expect, it } from 'vitest';
import { liveUnrealizedPnl, withLiveMarks } from '../src/livePositions';
import type { Position } from '../src/types';

const pos = (symbol: string, amount: number, entryPrice: number, markPrice: number, unrealizedPnl: number) => ({ symbol, amount, entryPrice, markPrice, unrealizedPnl }) as Position;

describe('live profit', () => {
  it('applies the live mark price to each position, long and short', () => {
    const live = withLiveMarks([pos('ETHUSDT', 2, 100, 101, 2), pos('BTCUSDT', -1, 50, 49, 1)], { ETHUSDT: 105, BTCUSDT: 48 });
    expect(live[0].markPrice).toBe(105);
    expect(live[0].unrealizedPnl).toBeCloseTo(10);
    expect(live[1].unrealizedPnl).toBeCloseTo(2);
  });

  it('a position without a live price keeps the account read', () => {
    const live = withLiveMarks([pos('ETHUSDT', 2, 100, 101, 2)], {});
    expect(live[0].markPrice).toBe(101);
    expect(live[0].unrealizedPnl).toBe(2);
  });

  it('the total moves by exactly how much the positions moved', () => {
    const positions = [pos('ETHUSDT', 2, 100, 101, 2), pos('BTCUSDT', -1, 50, 49, 1)];
    const account = { unrealizedPnl: 3.5, positions }; // 0.5 comes from somewhere else (rounding, a closed leg)
    const live = withLiveMarks(positions, { ETHUSDT: 105, BTCUSDT: 48 });
    expect(liveUnrealizedPnl(account, live)).toBeCloseTo(3.5 + (10 - 2) + (2 - 1));
    expect(liveUnrealizedPnl(account, positions)).toBeCloseTo(3.5);
  });
});
