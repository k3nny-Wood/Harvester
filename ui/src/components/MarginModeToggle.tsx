import { useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import { refreshTrading } from '../trade';

/** Why the margin mode of a symbol cannot be changed right now (Binance refuses while it holds a position or open orders), or null when it can. */
export function marginModeBlock(symbol: string, positions: Array<{ symbol: string; amount: number }>, orders: Array<{ symbol: string }>): string | null {
  if (positions.some((p) => p.symbol === symbol && p.amount !== 0)) return `${symbol} has an open position: close it first.`;
  if (orders.some((o) => o.symbol === symbol)) return `${symbol} has open orders: cancel them first.`;
  return null;
}

/**
 * Cross / Isolated for one symbol. Cross lets the whole account back the position, isolated limits the loss to the margin put into it.
 * Binance only allows the change while the symbol has no position and no open orders, so the switch is disabled (with the reason) otherwise.
 */
export function MarginModeToggle({ symbol, compact = false }: { symbol: string; compact?: boolean }) {
  const isolated = useApp((s) => s.account?.isolated?.[symbol] ?? false);
  const positions = useApp((s) => s.account?.positions ?? []);
  const orders = useApp((s) => s.orders);
  const canTrade = useApp((s) => !!s.trading?.hasCredentials);
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const block = !canTrade ? 'Trading is not set up.' : marginModeBlock(symbol, positions, orders);

  const choose = async (wantIsolated: boolean) => {
    if (busy || block || wantIsolated === isolated) return;
    setBusy(true);
    try {
      await api.setMarginType(symbol, wantIsolated);
      toast(`${symbol} is now ${wantIsolated ? 'isolated' : 'cross'} margin`, 'info');
      await refreshTrading();
    } catch (e) {
      toast(`Margin mode: ${e}`, 'warn');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`margin-mode${compact ? ' compact' : ''}`} title={block ?? 'Cross: the whole account backs the position. Isolated: the loss is limited to the margin put into it.'}>
      {!compact && <span className="muted">Margin</span>}
      <button className={!isolated ? 'on' : ''} disabled={!!block || busy} onClick={() => void choose(false)}>
        {compact ? 'C' : 'Cross'}
      </button>
      <button className={isolated ? 'on' : ''} disabled={!!block || busy} onClick={() => void choose(true)}>
        {compact ? 'I' : 'Isolated'}
      </button>
      {block && !compact && <span className="muted margin-mode-why">{block}</span>}
    </div>
  );
}
