import type { Signal } from './types';

export interface Badge {
  text: string;
  tone: 'up' | 'down' | 'warn' | 'muted';
  title?: string;
}

/**
 * What a signal says about how its move is going, as short badges: whether it is still running or already coming back, how much volume came in,
 * and the reversal score (signs that the move is ending, from RSI / MACD / CMF / OBV).
 */
export function insightBadges(s: Pick<Signal, 'kind' | 'stillMoving' | 'retracePct' | 'volSpikePct' | 'reversal' | 'reversalNotes'>): Badge[] {
  const out: Badge[] = [];
  const falling = s.kind === 'drop' || s.kind === 'dump';
  const rising = s.kind === 'pump';
  if ((falling || rising) && s.stillMoving != null) {
    const back = s.retracePct != null ? ` (${Math.round(s.retracePct)}% ${falling ? 'bounced' : 'given back'})` : '';
    out.push(
      s.stillMoving
        ? { text: falling ? 'still falling' : 'still rising', tone: falling ? 'down' : 'up', title: 'The price is still at the end of the move' }
        : { text: (falling ? 'bouncing' : 'fading') + back, tone: 'warn', title: 'The price has already given a good part of the move back' },
    );
  }
  if (s.volSpikePct != null && s.volSpikePct >= 50) out.push({ text: `vol +${Math.round(s.volSpikePct)}%`, tone: 'muted', title: 'The latest candle\'s volume against the recent average' });
  if (s.reversal != null && s.reversal >= 1) {
    const r = Math.round(s.reversal);
    out.push({ text: `reversal ${r}`, tone: r >= 50 ? 'up' : r >= 25 ? 'warn' : 'muted', title: (s.reversalNotes ?? []).length ? (s.reversalNotes ?? []).join('\n') : 'No divergence found' });
  }
  return out;
}
