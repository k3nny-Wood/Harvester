import { useState } from 'react';
import { api } from '../api';
import { exitState } from '../positionExits';
import { useApp } from '../store';
import { refreshTrading } from '../trade';
import type { Position } from '../types';
import { fmtPrice } from './chartMath';
import { parseLevel, resolveExit } from './exits';
import { Sheet } from './Sheet';

/** Set or move the stop-loss or take-profit of a position (the whole position, reduce-only). A price or a percentage away from the price. */
export function ExitSheet({ kind, position, onClose }: { kind: 'stop' | 'take'; position: Position; onClose: () => void }) {
  const orders = useApp((s) => s.orders);
  const toast = useApp((s) => s.toast);
  const long = position.amount > 0;
  const state = exitState(position.symbol, position.amount, orders);
  const existing = kind === 'stop' ? state.stop : state.take;
  const current = existing ? existing.stopPrice || existing.price : 0;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const level = parseLevel(text);
  const res = level ? resolveExit(kind, long, position.markPrice, level) : null;
  const name = kind === 'stop' ? 'Stop-loss' : 'Take-profit';

  const apply = async () => {
    if (busy || !res || !res.ok) return;
    setBusy(true);
    try {
      if (existing) {
        // a reduce-only limit that works as the target moves by its price, a stop / take-profit by its trigger
        if (existing.type === 'LIMIT') await api.modifyOrder(position.symbol, existing.orderId, false, res.price);
        else await api.modifyOrder(position.symbol, existing.orderId, existing.conditional, undefined, res.price);
      } else {
        await api.placeOrder({ symbol: position.symbol, side: long ? 'SELL' : 'BUY', type: kind === 'stop' ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET', quantity: Math.abs(position.amount), stopPrice: res.price, reduceOnly: true });
      }
      toast(`${position.symbol}: ${name.toLowerCase()} ${existing ? 'moved' : 'set'} to ${fmtPrice(res.price)}`, 'info');
      void refreshTrading();
      onClose();
    } catch (e) {
      toast(`${name}: ${e}`, 'warn');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={`${name} · ${position.symbol}`} onClose={onClose}>
      <div className="m-muted">
        {long ? 'Long' : 'Short'} · price {fmtPrice(position.markPrice)} · {existing ? `now ${fmtPrice(current)}` : 'none set'}
      </div>
      <label className="m-field">
        <span>New level <em className="m-muted">a price, or a distance like 2%</em></span>
        <input type="text" inputMode="decimal" autoFocus placeholder={kind === 'stop' ? 'e.g. 2%' : 'e.g. 4%'} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void apply()} />
        <small className={res?.ok ? 'm-muted' : 'down'}>{res ? (res.ok ? `= ${fmtPrice(res.price)}` : res.error) : ''}</small>
      </label>
      <button className="m-primary" disabled={busy || !res?.ok} onClick={() => void apply()}>
        {busy ? 'Working…' : existing ? `Move ${name.toLowerCase()}` : `Set ${name.toLowerCase()}`}
      </button>
    </Sheet>
  );
}
