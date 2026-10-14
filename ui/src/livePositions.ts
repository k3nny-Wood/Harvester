import { useLiveMarks } from './liveMarks';
import { useApp } from './store';
import type { Account, Position } from './types';

/** The positions with Binance's live mark price and the profit it implies (linear contracts: size x (mark - entry)); positions without a fresh live price keep the last account read. */
export function withLiveMarks(positions: Position[], marks: Record<string, number>): Position[] {
  return positions.map((p) => {
    const mark = marks[p.symbol];
    return mark ? { ...p, markPrice: mark, unrealizedPnl: p.amount * (mark - p.entryPrice) } : p;
  });
}

/** The account's total unrealised profit with the live prices applied: the account read's figure, corrected by how much each position's profit moved since. */
export function liveUnrealizedPnl(account: Pick<Account, 'unrealizedPnl' | 'positions'>, live: Position[]): number {
  let total = account.unrealizedPnl;
  for (const p of account.positions) {
    const now = live.find((x) => x.symbol === p.symbol);
    if (now) total += now.unrealizedPnl - p.unrealizedPnl;
  }
  return total;
}

/** The account's positions and total profit, refreshed with every live mark price (once a second) instead of only when the account is read. */
export function useLivePositions(): { positions: Position[]; unrealizedPnl: number } | null {
  const account = useApp((s) => s.account);
  const marks = useLiveMarks(account?.positions.map((p) => p.symbol) ?? []);
  if (!account) return null;
  const positions = withLiveMarks(account.positions, marks);
  return { positions, unrealizedPnl: liveUnrealizedPnl(account, positions) };
}
