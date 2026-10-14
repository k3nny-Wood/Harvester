import { useEffect, useState } from 'react';
import { api } from '../api';
import { addQuantity, floorQty, maxAddPct } from '../addSize';
import { formatPrice } from '../ladderMath';
import { CapToggle } from './CapToggle';
import { useApp } from '../store';
import { refreshTrading } from '../trade';
import type { Side, SymbolFilters } from '../types';

/** What the dialog adds size to: an open order that has not filled, or a position that is open. */
export type AddSizeTarget =
  | { kind: 'order'; symbol: string; side: Side; orderId: number; conditional: boolean; type: string; price: number; qty: number; reduceOnly: boolean }
  | { kind: 'position'; symbol: string; amount: number; mark: number };

/**
 * Add size to an open order (its quantity is amended, or it is replaced by a bigger one at the same price) or to an open position (a new order in
 * its direction, with its stop-loss and take-profit resized to the new total when asked).
 */
export function AddSizeModal({ target, onClose }: { target: AddSizeTarget; onClose: () => void }) {
  const symbol = target.symbol;
  const account = useApp((s) => s.account);
  const trading = useApp((s) => s.trading);
  const env = useApp((s) => s.env);
  const toast = useApp((s) => s.toast);
  const [filters, setFilters] = useState<SymbolFilters | null>(null);
  const [pct, setPct] = useState(5);
  const [mode, setMode] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [limitPrice, setLimitPrice] = useState(target.kind === 'position' ? target.mark : 0);
  const [resize, setResize] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api.symbolFilters(symbol).then((f) => alive && setFilters(f)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [symbol]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const wallet = account?.walletBalance ?? 0;
  const lev = account?.leverages?.[symbol] || (account?.positions.find((p) => p.symbol === symbol)?.leverage ?? 1) || 1;
  const cap = trading?.maxOrderNotional ?? 0;
  const precision = filters?.quantityPrecision ?? 3;
  const pricePrecision = filters?.pricePrecision ?? 2;
  const step = Number(filters?.stepSize) || 0;
  const unit = symbol.replace('USDT', '');

  const refPrice = target.kind === 'order' ? target.price : mode === 'LIMIT' && limitPrice > 0 ? limitPrice : target.mark;
  const currentQty = target.kind === 'order' ? target.qty : Math.abs(target.amount);
  const currentNotional = currentQty * (target.kind === 'order' ? target.price : target.mark);
  // the safety cap limits ONE order: when growing an order its whole size counts, but a new order added to a position is only the new part
  const sliderMax = maxAddPct(wallet, lev, cap, target.kind === 'order' ? currentNotional : 0);
  const used = Math.min(pct, sliderMax);
  const addQty = floorQty(addQuantity(used, wallet, lev, refPrice), step);
  const newQty = currentQty + addQty;
  const minNotional = Number(filters?.minNotional) || 0;
  const tooSmall = addQty <= 0 || (target.kind === 'position' && addQty * refPrice < minNotional);
  const blocked = target.kind === 'order' && target.reduceOnly;
  const isolated = account?.isolated?.[symbol] ?? false;
  const long = target.kind === 'position' ? target.amount > 0 : target.side === 'BUY';

  const submit = async () => {
    if (busy || tooSmall || blocked) return;
    setBusy(true);
    try {
      if (target.kind === 'order') {
        await api.modifyOrder(symbol, target.orderId, target.conditional, undefined, undefined, newQty);
        toast(`${symbol}: the order is now ${newQty.toFixed(precision)} ${unit} (was ${currentQty.toFixed(precision)})`, 'info');
      } else {
        const side: Side = target.amount > 0 ? 'BUY' : 'SELL';
        const ack = await api.placeOrder(mode === 'MARKET' ? { symbol, side, type: 'MARKET', quantity: addQty } : { symbol, side, type: 'LIMIT', quantity: addQty, price: limitPrice });
        if (mode === 'MARKET') {
          let note = '';
          if (resize) {
            try {
              const n = await api.resizeExits(symbol, currentQty + ack.quantity);
              note = n > 0 ? ` Stop-loss / take-profit resized to the new total (${n} order${n === 1 ? '' : 's'}).` : '';
            } catch (e) {
              note = ` The stop-loss / take-profit could NOT be resized: ${e}. Check them.`;
            }
          }
          toast(`${symbol}: added ${ack.quantity.toFixed(precision)} ${unit} at market.${note}`, note.includes('NOT') ? 'warn' : 'info');
        } else {
          toast(`${symbol}: limit order for ${ack.quantity.toFixed(precision)} ${unit} @ ${formatPrice(limitPrice, pricePrecision)} placed. Stop-loss / take-profit are not resized until it fills.`, 'info');
        }
      }
      void refreshTrading();
      onClose();
    } catch (e) {
      toast(`Could not add size: ${e}`, 'warn');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="size-backdrop" onPointerDown={onClose}>
      <div className="size-modal" onPointerDown={(e) => e.stopPropagation()}>
        <div className="quick-title">
          <b className={long ? 'up' : 'down'}>
            {target.kind === 'order' ? `Add size to ${target.side} ${target.type.replace(/_/g, ' ')}` : `Add to ${long ? 'LONG' : 'SHORT'} ${symbol}`}
          </b>
          {env === 'live' && <span className="quick-live">LIVE</span>}
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">
            ×
          </button>
        </div>
        <div className="muted quick-note">
          {symbol} · now {currentQty.toFixed(precision)} {unit} ≈ {currentNotional.toFixed(2)} USDT · {lev}x {isolated ? 'isolated' : 'cross'}
        </div>
        {blocked ? (
          <div className="warn quick-note">This order only closes a position, so making it bigger does nothing. Use “Add to position” instead: it grows the position and resizes the stop-loss and take-profit for you.</div>
        ) : (
          <>
            {target.kind === 'position' && (
              <div className="margin-mode">
                <span className="muted">Add with</span>
                <button className={mode === 'MARKET' ? 'on' : ''} onClick={() => setMode('MARKET')}>
                  Market
                </button>
                <button className={mode === 'LIMIT' ? 'on' : ''} onClick={() => setMode('LIMIT')}>
                  Limit
                </button>
                {mode === 'LIMIT' && <input type="number" value={limitPrice} step={Number(filters?.tickSize) || 'any'} onChange={(e) => setLimitPrice(Number(e.target.value))} style={{ width: 100 }} />}
              </div>
            )}
            <label className="quick-slider">
              <span>
                Add <b>{used.toFixed(1)}% of the account</b>
              </span>
              <input type="range" min={0} max={Math.max(0.5, sliderMax)} step={0.1} value={used} disabled={!(wallet > 0) || sliderMax <= 0} onChange={(e) => setPct(Number(e.target.value))} />
            </label>
            <div className="quick-sum">
              <span>
                + {addQty.toFixed(precision)} {unit}
              </span>
              <span>≈ {(addQty * refPrice).toFixed(2)} USDT</span>
              <span>margin {((addQty * refPrice) / Math.max(1, lev)).toFixed(2)}</span>
              <span>
                new total <b>{newQty.toFixed(precision)} {unit}</b>
              </span>
            </div>
            {cap > 0 && sliderMax > 0 && sliderMax < 100 && wallet > 0 && (
              <div className="muted quick-note">
                One order is limited to {cap} USDT of position value (MAX_ORDER_NOTIONAL in the .env file): that is why the slider stops at {sliderMax.toFixed(1)}%. <CapToggle />
              </div>
            )}
            {sliderMax <= 0 && cap > 0 && (
              <div className="warn quick-note">
                This order is already at the safety cap of {cap} USDT (MAX_ORDER_NOTIONAL). <CapToggle />
              </div>
            )}
            {cap === 0 && trading?.capOverride && <div className="muted quick-note">The safety cap is off for this session: the slider is not limited. <CapToggle /></div>}
            {target.kind === 'order' && target.conditional && <div className="muted quick-note">A stop / take-profit cannot be amended: it is replaced by a bigger one at the same trigger (the old one is put back if that fails).</div>}
            {target.kind === 'order' && !target.conditional && <div className="muted quick-note">The order keeps its price. A bigger order goes to the back of the queue at that price.</div>}
            {target.kind === 'position' && mode === 'MARKET' && (
              <label className="quick-check">
                <input type="checkbox" checked={resize} onChange={(e) => setResize(e.target.checked)} /> Resize the stop-loss and take-profit to the new total
              </label>
            )}
            {target.kind === 'position' && mode === 'LIMIT' && <div className="muted quick-note">The stop-loss and take-profit stay as they are until the limit order fills; resize them then with “Add to position”, or by moving them.</div>}
            {target.kind === 'position' && mode === 'MARKET' && !resize && <div className="warn quick-note">Without resizing, the added size has no stop-loss or take-profit.</div>}
            {tooSmall && addQty > 0 && <div className="warn quick-note">Too small: the exchange needs at least {minNotional} USDT per order.</div>}
          </>
        )}
        <div className="quick-actions">
          <button onClick={onClose}>Cancel</button>
          <button className={`primary ${long ? 'buy' : 'sell'}`} disabled={busy || tooSmall || blocked || !trading?.hasCredentials} onClick={() => void submit()}>
            {busy ? 'Working…' : 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}
