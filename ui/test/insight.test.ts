import { describe, expect, it } from 'vitest';
import { insightBadges } from '../src/insight';

describe('signal insight badges', () => {
  it('says still falling, or bouncing with how much', () => {
    expect(insightBadges({ kind: 'drop', stillMoving: true })[0]).toMatchObject({ text: 'still falling', tone: 'down' });
    expect(insightBadges({ kind: 'dump', stillMoving: false, retracePct: 61.6 })[0]).toMatchObject({ text: 'bouncing (62% bounced)', tone: 'warn' });
    expect(insightBadges({ kind: 'pump', stillMoving: true })[0].text).toBe('still rising');
    expect(insightBadges({ kind: 'pump', stillMoving: false })[0].text).toBe('fading');
  });
  it('shows volume only when it really spiked, and the reversal score with its notes', () => {
    expect(insightBadges({ kind: 'crack', volSpikePct: 20 })).toEqual([]);
    const b = insightBadges({ kind: 'drop', volSpikePct: 340, reversal: 62, reversalNotes: ['RSI bullish divergence (30%)'] });
    expect(b.map((x) => x.text)).toEqual(['vol +340%', 'reversal 62']);
    expect(b[1]).toMatchObject({ tone: 'up', title: 'RSI bullish divergence (30%)' });
  });
  it('has no badges for a signal without any insight', () => {
    expect(insightBadges({ kind: 'near' })).toEqual([]);
  });
});
