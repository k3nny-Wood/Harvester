import { useLivePositions } from '../livePositions';

/** The account's unrealised profit, moved by every live mark price. A component of its own so only this figure re-renders, not the whole window. */
export function LiveUPnL({ fallback }: { fallback: number }) {
  const live = useLivePositions();
  const v = live?.unrealizedPnl ?? fallback;
  return <b className={v >= 0 ? 'up' : 'down'}>{v.toFixed(2)}</b>;
}
