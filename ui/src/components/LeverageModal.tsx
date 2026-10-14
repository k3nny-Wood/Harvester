import { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import { refreshTrading } from '../trade';

/**
 * Raise the leverage of a symbol that has an open position. Only upward: lowering it needs margin the position may not have, and Binance can
 * refuse either way, in which case its message is shown. The slider runs from the current leverage to the largest the position size allows.
 */
export function LeverageModal({ symbol, notional, isolated, onClose }: { symbol: string; notional: number; isolated: boolean; onClose: () => void }) {
  const toast = useApp((s) => s.toast);
  const env = useApp((s) => s.env);
  const [current, setCurrent] = useState(0);
  const [max, setMax] = useState(0);
  const [lev, setLev] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    // the largest leverage the position's size allows: the bracket that holds its value
    Promise.all([api.symbolLeverage(symbol), api.leverageBrackets(symbol).catch(() => [])])
      .then(([l, brackets]) => {
        if (!alive) return;
        const b = brackets.find((x) => notional >= x.notionalFloor && notional < x.notionalCap);
        setCurrent(l.leverage);
        setMax(Math.max(l.leverage, b ? Math.min(b.initialLeverage, l.maxLeverage) : l.maxLeverage));
        setLev(l.leverage);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const submit = async () => {
    if (busy || lev <= current) return;
    setBusy(true);
    try {
      await api.setLeverage(symbol, lev);
      toast(`${symbol}: leverage raised from ${current}x to ${lev}x`, 'info');
      void refreshTrading();
      onClose();
    } catch (e) {
      toast(`${symbol}: Binance did not accept ${lev}x: ${String(e)}`, 'warn');
      setBusy(false);
    }
  };

  const marginNow = current > 0 ? notional / current : 0;
  const marginNew = lev > 0 ? notional / lev : 0;
  return (
    <div className="size-backdrop" onPointerDown={onClose}>
      <div className="size-modal" onPointerDown={(e) => e.stopPropagation()}>
        <div className="quick-title">
          <b>Raise leverage · {symbol}</b>
          {env === 'live' && <span className="quick-live">LIVE</span>}
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">
            ×
          </button>
        </div>
        <div className="muted quick-note">
          position value ≈ {notional.toFixed(2)} USDT · now {current || '…'}x {isolated ? 'isolated' : 'cross'}
        </div>
        <label className="quick-slider">
          <span>
            Leverage <b>{lev || '…'}x</b>
          </span>
          <input type="range" min={current || 1} max={Math.max(max, current || 1)} step={1} value={lev || 1} disabled={max <= current} onChange={(e) => setLev(Number(e.target.value))} />
        </label>
        <div className="quick-sum">
          <span>margin now {marginNow.toFixed(2)}</span>
          <span>
            margin after <b>{marginNew.toFixed(2)}</b>
          </span>
          <span>max {max || '…'}x</span>
        </div>
        {isolated ? (
          <div className="warn quick-note">Isolated margin: a higher leverage puts less margin behind the position, so the liquidation price moves closer to the market.</div>
        ) : (
          <div className="muted quick-note">Cross margin: the liquidation price depends on the whole account, but the position now ties up less margin.</div>
        )}
        {max > 0 && max <= current && <div className="muted quick-note">This position is already at the highest leverage allowed for its size.</div>}
        <div className="quick-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || lev <= current} onClick={() => void submit()}>
            {busy ? 'Working…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}
