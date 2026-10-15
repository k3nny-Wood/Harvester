import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { floorQty } from '../addSize';
import { maxPct, sizeFromPct } from '../sizing';
import { entryKind, LIMIT_OFFSET } from '../quickMath';
import { snapToTick } from '../ladderMath';
import { useApp } from '../store';
import { refreshTrading } from '../trade';
import type { OrderAck, OrderRequest, Side, SymbolFilters } from '../types';
import { fmtPrice } from './chartMath';
import { exitsWait, resolveBoth } from './exits';
import { useFloater } from './floaterStore';

/** The default side for a level: above the price you would sell there (short), below it you would buy (long). */
export function sideFor(price: number, mark: number): Side {
  return price < mark ? 'BUY' : 'SELL';
}

/**
 * The small order box that opens where the chart was pressed and held: a limit order (or, when the level is beyond the price, a stop-limit)
 * at that price. The SL and TP buttons add a stop-loss and a take-profit to the order (their lines appear on the chart and can be dragged);
 * without them the order is just the entry. Exits that cannot be placed yet wait for the entry to fill.
 */
export function OrderFloater({ symbol, mark, onClose, onHeight, style }: { symbol: string; mark: number; onClose: () => void; /** the box's natural height, so the tab can decide whether it fits above the lines */ onHeight: (h: number) => void; style: React.CSSProperties }) {
  const f = useFloater((s) => s.f)!;
  const patch = useFloater((s) => s.patch);
  const account = useApp((s) => s.account);
  const trading = useApp((s) => s.trading);
  const toast = useApp((s) => s.toast);
  const [filters, setFilters] = useState<SymbolFilters | null>(null);
  const [lev, setLev] = useState(1);
  const [maxLev, setMaxLev] = useState(20);
  const [startLev, setStartLev] = useState(1);
  const [pct, setPct] = useState(5);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const tick = filters?.tickSize;
  const ref = useRef<HTMLDivElement>(null);
  // tell the tab how tall the box wants to be (after every render)
  useEffect(() => {
    const h = ref.current?.scrollHeight;
    if (h) onHeight(h);
  });

  // the price box follows the level when it is moved by the handle on the chart (not while the price is being typed)
  const typed = useRef(false);
  useEffect(() => {
    if (typed.current) {
      typed.current = false;
      return;
    }
    setText(String(snapToTick(f.price, tick)));
  }, [f.price, tick]);

  useEffect(() => {
    let alive = true;
    void api.symbolFilters(symbol).then((x) => alive && setFilters(x)).catch(() => undefined);
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

  const side = f.side;
  const long = side === 'BUY';
  const entry = f.price;
  const entryOk = Number.isFinite(entry) && entry > 0;
  const kind = entryOk ? entryKind(side, entry, mark) : 'LIMIT';
  const wallet = account?.walletBalance ?? 0;
  const cap = trading?.maxOrderNotional ?? 0;
  const usedPct = Math.min(pct, maxPct(wallet, lev, cap));
  const { notional } = sizeFromPct(usedPct, wallet, lev);
  const step = Number(filters?.stepSize) || 0;
  const qty = entryOk ? floorQty(notional / entry, step) : 0;
  const minNotional = Number(filters?.minNotional) || 0;
  const exits = entryOk ? resolveBoth(long, entry, { on: f.useSl, text: f.sl }, { on: f.useTp, text: f.tp }) : { sl: null, tp: null };
  const slPrice = exits.sl?.ok ? exits.sl.price : null;
  const tpPrice = exits.tp?.ok ? exits.tp.price : null;
  const exitsBad = (f.useSl && !exits.sl?.ok) || (f.useTp && !exits.tp?.ok);
  const problem = !entryOk || !(qty > 0) || qty * entry < minNotional || exitsBad;
  const waits = exitsWait(long, mark, slPrice, tpPrice);
  const risk = slPrice != null ? qty * Math.abs(entry - slPrice) : 0;
  const reward = tpPrice != null ? qty * Math.abs(tpPrice - entry) : 0;

  const rollback = async (acks: OrderAck[]) => {
    for (const a of acks) {
      try {
        if (a.status === 'HELD') await api.heldCancel(a.clientId);
        else await api.cancelOrder(symbol, a.orderId, a.conditional);
      } catch {
        /* the toast says to check the orders */
      }
    }
  };

  /** The exits that are switched on, as reduce-only orders for `total`. Returns what failed. */
  const sendExits = async (total: number, slP: number | null, tpP: number | null): Promise<string[]> => {
    const exit = long ? 'SELL' : 'BUY';
    const failed: string[] = [];
    const wanted: Array<[string, 'TAKE_PROFIT_MARKET' | 'STOP_MARKET', number | null]> = [['take-profit', 'TAKE_PROFIT_MARKET', tpP], ['stop-loss', 'STOP_MARKET', slP]];
    for (const [label, type, price] of wanted) {
      if (price == null) continue;
      try {
        await api.placeOrder({ symbol, side: exit, type, quantity: total, stopPrice: price, reduceOnly: true });
      } catch (e) {
        failed.push(`${label}: ${e}`);
      }
    }
    return failed;
  };

  const exitsText = (slP: number | null, tpP: number | null) => [slP != null ? `SL ${fmtPrice(slP)}` : '', tpP != null ? `TP ${fmtPrice(tpP)}` : ''].filter(Boolean).join(' / ');

  /** Enter at once at the market price (the exits, as percentages, are measured from the price), then protect the position if exits were asked for. */
  const placeNow = async () => {
    if (busy || !(mark > 0)) return;
    const mQty = floorQty(notional / mark, step);
    const m = resolveBoth(long, mark, { on: f.useSl, text: f.sl }, { on: f.useTp, text: f.tp });
    const why = !(mQty > 0) ? 'the amount is too small for this symbol' : mQty * mark < minNotional ? `below the exchange's minimum order (${minNotional} USDT)` : f.useSl && !m.sl?.ok ? (m.sl && !m.sl.ok ? m.sl.error : 'enter a stop-loss') : f.useTp && !m.tp?.ok ? (m.tp && !m.tp.ok ? m.tp.error : 'enter a take-profit') : '';
    if (why) {
      toast(`Market entry: ${why}`, 'warn');
      return;
    }
    const mSl = m.sl?.ok ? m.sl.price : null;
    const mTp = m.tp?.ok ? m.tp.price : null;
    setBusy(true);
    try {
      if (lev !== startLev) {
        await api.setLeverage(symbol, lev);
        setStartLev(lev);
      }
      const ack = await api.placeOrder({ symbol, side, type: 'MARKET', quantity: mQty });
      const failed = await sendExits(ack.quantity || mQty, mSl, mTp);
      if (failed.length) toast(`${symbol} is open but NOT fully protected (${failed.join('; ')}). Set the missing exit now.`, 'warn');
      else toast(`${symbol} ${long ? 'long' : 'short'} opened at market${mSl != null || mTp != null ? ` with ${exitsText(mSl, mTp)}` : ' (no stop-loss or take-profit)'}`, 'info');
      void refreshTrading();
      onClose();
    } catch (e) {
      toast(`Order rejected: ${e}`, 'warn');
    } finally {
      setBusy(false);
    }
  };

  /** A limit order (or stop-limit) at the level. */
  const placeResting = async () => {
    if (busy || problem) return;
    setBusy(true);
    const placed: OrderAck[] = [];
    try {
      if (lev !== startLev) {
        await api.setLeverage(symbol, lev);
        setStartLev(lev);
      }
      const limit = (p: number) => snapToTick(p * (long ? 1 + LIMIT_OFFSET : 1 - LIMIT_OFFSET), tick);
      const req: OrderRequest = kind === 'STOP' ? { symbol, side, type: 'STOP', quantity: qty, stopPrice: entry, price: limit(entry) } : { symbol, side, type: 'LIMIT', quantity: qty, price: entry };
      placed.push(await api.placeOrder(req));
      const total = placed[0].quantity || qty;
      const what = `${long ? 'long' : 'short'} ${kind === 'STOP' ? 'stop-limit' : 'limit'} entry @ ${fmtPrice(entry)}`;
      if (slPrice == null && tpPrice == null) {
        toast(`Placed ${symbol} ${what} (no stop-loss or take-profit)`, 'info');
      } else if (waits) {
        // an exit is on the wrong side of the market for now: the server sends them the moment the entry has filled
        try {
          await api.bracketAdd({ symbol, long, takeProfit: tpPrice ?? 0, stopLoss: slPrice ?? 0, entryOrderId: placed[0].status !== 'HELD' ? placed[0].orderId : 0, entryConditional: placed[0].conditional, quantity: total });
        } catch (e) {
          await rollback(placed);
          throw new Error(`could not arm the ${exitsText(slPrice, tpPrice)} (${e}); the entry was cancelled`);
        }
        toast(`Placed ${symbol} ${what}. ${exitsText(slPrice, tpPrice)} ${slPrice != null && tpPrice != null ? 'are' : 'is'} armed: sent to Binance as soon as the entry fills.`, 'info');
      } else {
        const failed = await sendExits(total, slPrice, tpPrice);
        if (failed.length) {
          // never leave an entry without the protection that was asked for
          await rollback(placed);
          toast(`Bracket not complete (${failed.join('; ')}). The entry order was cancelled.`, 'warn');
          void refreshTrading();
          return;
        }
        toast(`Placed ${symbol} ${what} with ${exitsText(slPrice, tpPrice)}`, 'info');
      }
      void refreshTrading();
      onClose();
    } catch (e) {
      toast(`Order rejected: ${e}`, 'warn');
    } finally {
      setBusy(false);
    }
  };

  const box = (which: 'sl' | 'tp') => {
    const res = which === 'sl' ? exits.sl : exits.tp;
    const value = which === 'sl' ? f.sl : f.tp;
    return (
      <label className="m-fl-box" key={which}>
        <span className="m-fl-tag">{which === 'sl' ? 'SL' : 'TP'}</span>
        <input type="text" inputMode="decimal" aria-label={which === 'sl' ? 'Stop-loss: a price or a percentage' : 'Take-profit: a price or a percentage'} value={value} onChange={(e) => patch(which === 'sl' ? { sl: e.target.value } : { tp: e.target.value })} />
        <small className={`m-fl-px${res?.ok ? '' : ' down'}`}>{res?.ok ? fmtPrice(res.price) : '!'}</small>
      </label>
    );
  };

  return (
    <div ref={ref} className="m-floater" style={style} onPointerDown={(e) => e.stopPropagation()}>
      <div className="m-fl-head">
        <input
          type="text"
          inputMode="decimal"
          aria-label="Entry price"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const v = Number(e.target.value.replace(',', '.'));
            if (Number.isFinite(v) && v > 0) {
              typed.current = true;
              patch({ price: v });
            }
          }}
        />
        <button className={`m-toggle sl${f.useSl ? ' on' : ''}`} onClick={() => patch({ useSl: !f.useSl })} title="Add a stop-loss line to this order">SL</button>
        <button className={`m-toggle tp${f.useTp ? ' on' : ''}`} onClick={() => patch({ useTp: !f.useTp })} title="Add a take-profit line to this order">TP</button>
        <div className="m-seg">
          <button className={long ? 'on buy' : ''} onClick={() => patch({ side: 'BUY' })}>Buy</button>
          <button className={!long ? 'on sell' : ''} onClick={() => patch({ side: 'SELL' })}>Sell</button>
        </div>
        <button className="m-x" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="m-fl-note">
        {entryOk ? `${kind === 'STOP' ? 'Stop-limit: triggers at the level' : 'Limit: waits at the level'} · ${(entry / mark - 1) * 100 >= 0 ? '+' : ''}${((entry / mark - 1) * 100).toFixed(2)}% vs price` : ' '}
      </div>
      <div className="m-fl-pair">
        <label>
          <span>Amount <b>{usedPct.toFixed(1)}%</b></span>
          <input type="range" min={0} max={100} step={0.5} value={pct} onChange={(e) => setPct(Number(e.target.value))} />
        </label>
        <label>
          <span>Leverage <b>{lev}x</b></span>
          <input type="range" min={1} max={maxLev} step={1} value={lev} onChange={(e) => setLev(Number(e.target.value))} />
        </label>
      </div>
      {(f.useSl || f.useTp) && <div className={`m-fl-pair${f.useSl && f.useTp ? '' : ' one'}`}>{f.useSl && box('sl')}{f.useTp && box('tp')}</div>}
      <div className="m-fl-sum">
        {qty > 0 ? qty : 0} {symbol.replace('USDT', '')} · ≈ {(qty * entry || 0).toFixed(2)} USDT
        {slPrice != null && <> · <span className="down">risk {risk.toFixed(2)}</span></>}
        {tpPrice != null && <> · <span className="up">reward {reward.toFixed(2)}</span></>}
      </div>
      <div className="m-apply-row">
        <button
          className={`m-market ${long ? 'buy' : 'sell'}`}
          disabled={busy || !trading?.hasCredentials || !(mark > 0)}
          title="Market: enter now at the market price instead of waiting for this level, with the same amount, leverage and exits"
          onClick={() => void placeNow()}
        >
          M
        </button>
        <button className={`m-primary ${long ? 'buy' : 'sell'}`} disabled={busy || problem || !trading?.hasCredentials} onClick={() => void placeResting()}>
          {busy ? 'Placing…' : `Place ${kind === 'STOP' ? 'stop-limit' : 'limit'} ${long ? 'buy' : 'sell'}`}
        </button>
      </div>
    </div>
  );
}
