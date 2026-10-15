import { useEffect, useState } from 'react';
import { api } from '../api';
import { floorQty } from '../addSize';
import { confirmDialog } from '../confirm';
import { maxPct, sizeFromPct } from '../sizing';
import { useApp } from '../store';
import { refreshTrading } from '../trade';
import type { Side, SymbolFilters } from '../types';
import { fmtPrice } from './chartMath';
import { parseLevel, resolveExit } from './exits';
import { Sheet } from './Sheet';

/**
 * Open a position at market with its stop-loss and take-profit: the amount is a share of the account used as margin, the leverage is the
 * symbol's, the exits are percentages away from the price. Nothing is sent until the confirmation.
 */
export function TradeSheet({ side, symbol, mark, onClose }: { side: Side; symbol: string; mark: number; onClose: () => void }) {
  const long = side === 'BUY';
  const account = useApp((s) => s.account);
  const trading = useApp((s) => s.trading);
  const toast = useApp((s) => s.toast);
  const [filters, setFilters] = useState<SymbolFilters | null>(null);
  const [lev, setLev] = useState(1);
  const [maxLev, setMaxLev] = useState(20);
  const [startLev, setStartLev] = useState(1);
  const [pct, setPct] = useState(5);
  const [sl, setSl] = useState('1%');
  const [tp, setTp] = useState('2%');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void api.symbolFilters(symbol).then((f) => alive && setFilters(f)).catch(() => undefined);
    void api.symbolLeverage(symbol).then((l) => {
      if (!alive) return;
      setLev(l.leverage);
      setStartLev(l.leverage);
      setMaxLev(Math.max(1, l.maxLeverage));
    }).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [symbol]);

  const wallet = account?.walletBalance ?? 0;
  const cap = trading?.maxOrderNotional ?? 0;
  // the safety cap limits what is actually ordered; the slider itself always runs 0-100 and does not follow the leverage
  const usedPct = Math.min(pct, maxPct(wallet, lev, cap));
  const { notional, margin } = sizeFromPct(usedPct, wallet, lev);
  const step = Number(filters?.stepSize) || 0;
  const qty = mark > 0 ? floorQty(notional / mark, step) : 0;
  const minNotional = Number(filters?.minNotional) || 0;
  const slRes = (() => { const l = parseLevel(sl); return l ? resolveExit('stop', long, mark, l) : null; })();
  const tpRes = (() => { const l = parseLevel(tp); return l ? resolveExit('take', long, mark, l) : null; })();
  const problem = !(qty > 0) ? 'The amount is too small for this symbol.' : qty * mark < minNotional ? `Below the exchange's minimum order (${minNotional} USDT).` : !slRes || !slRes.ok ? (slRes && !slRes.ok ? slRes.error : 'Enter a stop-loss (a price or a percentage).') : !tpRes || !tpRes.ok ? (tpRes && !tpRes.ok ? tpRes.error : 'Enter a take-profit (a price or a percentage).') : '';
  const risk = slRes?.ok ? qty * Math.abs(mark - slRes.price) : 0;
  const reward = tpRes?.ok ? qty * Math.abs(tpRes.price - mark) : 0;

  const submit = async () => {
    if (busy || problem || !slRes?.ok || !tpRes?.ok) return;
    const ok = await confirmDialog(`${long ? 'LONG' : 'SHORT'} ${symbol}: ${qty} at market (about ${notional.toFixed(2)} USDT, ${lev}x), stop-loss ${fmtPrice(slRes.price)}, take-profit ${fmtPrice(tpRes.price)}?`, { confirmLabel: long ? 'Buy' : 'Sell', danger: !long });
    if (!ok) return;
    setBusy(true);
    try {
      if (lev !== startLev) await api.setLeverage(symbol, lev);
      const entry = await api.placeOrder({ symbol, side, type: 'MARKET', quantity: qty });
      const filled = entry.quantity || qty;
      const exit = side === 'BUY' ? 'SELL' : 'BUY';
      const failed: string[] = [];
      for (const [label, type, price] of [['take-profit', 'TAKE_PROFIT_MARKET', tpRes.price], ['stop-loss', 'STOP_MARKET', slRes.price]] as const) {
        try {
          await api.placeOrder({ symbol, side: exit, type, quantity: filled, stopPrice: price, reduceOnly: true });
        } catch (e) {
          failed.push(`${label}: ${e}`);
        }
      }
      if (failed.length) toast(`${symbol} is open but NOT fully protected (${failed.join('; ')}). Set the missing exit now.`, 'warn');
      else toast(`${symbol} ${long ? 'long' : 'short'} opened with its stop-loss and take-profit`, 'info');
      void refreshTrading();
      onClose();
    } catch (e) {
      toast(`Order rejected: ${e}`, 'warn');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={`${long ? '▲ Long' : '▼ Short'} ${symbol}`} tone={long ? 'up' : 'down'} onClose={onClose}>
      <div className="m-muted">At market · price {fmtPrice(mark)} · {trading?.hasCredentials ? '' : 'no API keys'}</div>
      <label className="m-field">
        <span>Amount <b>{usedPct.toFixed(1)}% of account</b>{usedPct < pct - 0.05 ? <em className="m-muted"> (capped by the safety limit)</em> : null}</span>
        <input type="range" min={0} max={100} step={0.5} value={pct} onChange={(e) => setPct(Number(e.target.value))} />
      </label>
      <label className="m-field">
        <span>Leverage <b>{lev}x</b></span>
        <input type="range" min={1} max={maxLev} step={1} value={lev} onChange={(e) => setLev(Number(e.target.value))} />
      </label>
      <div className="m-two">
        <label className="m-field">
          <span>Stop-loss <em className="m-muted">price or %</em></span>
          <input type="text" inputMode="decimal" value={sl} onChange={(e) => setSl(e.target.value)} />
          <small className={slRes?.ok ? 'm-muted' : 'down'}>{slRes?.ok ? fmtPrice(slRes.price) : slRes ? slRes.error : ''}</small>
        </label>
        <label className="m-field">
          <span>Take-profit <em className="m-muted">price or %</em></span>
          <input type="text" inputMode="decimal" value={tp} onChange={(e) => setTp(e.target.value)} />
          <small className={tpRes?.ok ? 'm-muted' : 'down'}>{tpRes?.ok ? fmtPrice(tpRes.price) : tpRes ? tpRes.error : ''}</small>
        </label>
      </div>
      <div className="m-sum">
        <span>{qty > 0 ? qty : '0'} {symbol.replace('USDT', '')}</span>
        <span>≈ {notional.toFixed(2)} USDT</span>
        <span>margin {margin.toFixed(2)}</span>
        <span className="down">risk {risk.toFixed(2)}</span>
        <span className="up">reward {reward.toFixed(2)}</span>
      </div>
      {problem && <div className="m-warn">{problem}</div>}
      <button className={`m-primary ${long ? 'buy' : 'sell'}`} disabled={busy || !!problem || !trading?.hasCredentials} onClick={() => void submit()}>
        {busy ? 'Sending…' : `${long ? 'Buy / Long' : 'Sell / Short'} at market`}
      </button>
    </Sheet>
  );
}
