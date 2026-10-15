import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { floorQty } from '../addSize';
import { maxPct, sizeFromPct } from '../sizing';
import { bracketProblems, entryKind, exitsMustWait, LIMIT_OFFSET } from '../quickMath';
import { snapToTick } from '../ladderMath';
import { useApp } from '../store';
import { refreshTrading } from '../trade';
import type { OrderAck, OrderRequest, Side, SymbolFilters } from '../types';
import { fmtPrice } from './chartMath';
import { parseLevel, resolveExit } from './exits';

/** The default side for a level: above the price you would sell there (short), below it you would buy (long). */
export function sideFor(price: number, mark: number): Side {
  return price < mark ? 'BUY' : 'SELL';
}

export interface FloaterState {
  /** a new number for every press: a new press starts the box afresh */
  id: number;
  price: number;
  /** where the finger was, in the coordinates of the chart tab */
  x: number;
  y: number;
}

/**
 * The small order box that opens where the chart was pressed and held: a limit order (or, when the level is beyond the price, a stop-limit)
 * at that price, with its stop-loss and take-profit. The take-profit and stop-loss wait for the entry to fill when they could not be placed yet.
 */
export function OrderFloater({ symbol, mark, state, onClose, onPrice, onSide, style }: { symbol: string; mark: number; state: FloaterState; onClose: () => void; onPrice: (p: number, side: Side) => void; onSide: (s: Side) => void; style: React.CSSProperties }) {
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
  const [side, setSide] = useState<Side>(sideFor(state.price, mark));
  const [text, setText] = useState('');
  const tick = filters?.tickSize;

  // the price box follows the level when it is moved by the handle on the chart (not while the price is being typed)
  const typed = useRef(false);
  useEffect(() => {
    if (typed.current) {
      typed.current = false;
      return;
    }
    setText(String(snapToTick(state.price, tick)));
  }, [state.price, tick]);

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

  const long = side === 'BUY';
  const entry = Number(text.replace(',', '.'));
  const entryOk = Number.isFinite(entry) && entry > 0;
  const kind = entryOk ? entryKind(side, entry, mark) : 'LIMIT';
  const wallet = account?.walletBalance ?? 0;
  const cap = trading?.maxOrderNotional ?? 0;
  const usedPct = Math.min(pct, maxPct(wallet, lev, cap));
  const { notional } = sizeFromPct(usedPct, wallet, lev);
  const step = Number(filters?.stepSize) || 0;
  const qty = entryOk ? floorQty(notional / entry, step) : 0;
  const minNotional = Number(filters?.minNotional) || 0;
  const slL = parseLevel(sl);
  const tpL = parseLevel(tp);
  const slRes = entryOk && slL ? resolveExit('stop', long, entry, slL) : null;
  const tpRes = entryOk && tpL ? resolveExit('take', long, entry, tpL) : null;
  const q = { side, entry, sl: slRes?.ok ? slRes.price : 0, tp: tpRes?.ok ? tpRes.price : 0 };
  const levelProblems = entryOk && slRes?.ok && tpRes?.ok ? bracketProblems(q) : [];
  const problem = !entryOk ? 'Enter the entry price.' : !(qty > 0) ? 'The amount is too small for this symbol.' : qty * entry < minNotional ? `Below the exchange's minimum order (${minNotional} USDT).` : !slRes ? 'Enter a stop-loss (a price or a percentage).' : !slRes.ok ? slRes.error : !tpRes ? 'Enter a take-profit (a price or a percentage).' : !tpRes.ok ? tpRes.error : (levelProblems[0] ?? '');
  const waits = entryOk && slRes?.ok && tpRes?.ok ? exitsMustWait(q, mark) : false;
  const risk = slRes?.ok ? qty * Math.abs(entry - slRes.price) : 0;
  const reward = tpRes?.ok ? qty * Math.abs(tpRes.price - entry) : 0;

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

  /** `asMarket`: enter now at the market price with the same amount, leverage and exits (percentages are measured from the price, not from the level). */
  const place = async (asMarket = false) => {
    if (busy) return;
    if (!asMarket && (problem || !slRes?.ok || !tpRes?.ok)) return;
    if (asMarket) {
      if (!(mark > 0)) return;
      const mSl = slL ? resolveExit('stop', long, mark, slL) : null;
      const mTp = tpL ? resolveExit('take', long, mark, tpL) : null;
      const mQty = floorQty(notional / mark, step);
      const why = !(mQty > 0) ? 'the amount is too small for this symbol' : mQty * mark < minNotional ? `below the exchange's minimum order (${minNotional} USDT)` : !mSl ? 'enter a stop-loss' : !mSl.ok ? mSl.error : !mTp ? 'enter a take-profit' : !mTp.ok ? mTp.error : '';
      if (why || !mSl?.ok || !mTp?.ok) {
        toast(`Market entry: ${why}`, 'warn');
        return;
      }
      return placeNow(mQty, mSl.price, mTp.price);
    }
    return placeResting();
  };

  /** Enter at once at the market price, then protect the position. */
  const placeNow = async (marketQty: number, slPrice: number, tpPrice: number) => {
    setBusy(true);
    try {
      if (lev !== startLev) {
        await api.setLeverage(symbol, lev);
        setStartLev(lev);
      }
      const entryAck = await api.placeOrder({ symbol, side, type: 'MARKET', quantity: marketQty });
      const filled = entryAck.quantity || marketQty;
      const exit = long ? 'SELL' : 'BUY';
      const failed: string[] = [];
      for (const [label, type, price] of [['take-profit', 'TAKE_PROFIT_MARKET', tpPrice], ['stop-loss', 'STOP_MARKET', slPrice]] as const) {
        try {
          await api.placeOrder({ symbol, side: exit, type, quantity: filled, stopPrice: price, reduceOnly: true });
        } catch (e) {
          failed.push(`${label}: ${e}`);
        }
      }
      if (failed.length) toast(`${symbol} is open but NOT fully protected (${failed.join('; ')}). Set the missing exit now.`, 'warn');
      else toast(`${symbol} ${long ? 'long' : 'short'} opened at market with TP ${fmtPrice(tpPrice)} and SL ${fmtPrice(slPrice)}`, 'info');
      void refreshTrading();
      onClose();
    } catch (e) {
      toast(`Order rejected: ${e}`, 'warn');
    } finally {
      setBusy(false);
    }
  };

  const placeResting = async () => {
    if (!slRes?.ok || !tpRes?.ok) return;
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
      if (waits) {
        // the exits are on the wrong side of the market for now: the server sends them the moment the entry has filled
        try {
          await api.bracketAdd({ symbol, long, takeProfit: q.tp, stopLoss: q.sl, entryOrderId: placed[0].status !== 'HELD' ? placed[0].orderId : 0, entryConditional: placed[0].conditional, quantity: total });
        } catch (e) {
          await rollback(placed);
          throw new Error(`could not arm the take-profit / stop-loss (${e}); the entry was cancelled`);
        }
        toast(`Placed ${symbol} ${what}. TP ${fmtPrice(q.tp)} / SL ${fmtPrice(q.sl)} are armed: they go to Binance as soon as the entry fills.`, 'info');
      } else {
        const exit = long ? 'SELL' : 'BUY';
        const failed: string[] = [];
        for (const [label, type, price] of [['take-profit', 'TAKE_PROFIT_MARKET', q.tp], ['stop-loss', 'STOP_MARKET', q.sl]] as const) {
          try {
            await api.placeOrder({ symbol, side: exit, type, quantity: total, stopPrice: price, reduceOnly: true });
          } catch (e) {
            failed.push(`${label}: ${e}`);
          }
        }
        if (failed.length) {
          // never leave an entry without its protection
          await rollback(placed);
          toast(`Bracket not complete (${failed.join('; ')}). The entry order was cancelled.`, 'warn');
          void refreshTrading();
          return;
        }
        toast(`Placed ${symbol} ${what} with TP ${fmtPrice(q.tp)} and SL ${fmtPrice(q.sl)}`, 'info');
      }
      void refreshTrading();
      onClose();
    } catch (e) {
      toast(`Order rejected: ${e}`, 'warn');
    } finally {
      setBusy(false);
    }
  };

  const changeSide = (s: Side) => {
    setSide(s);
    onSide(s);
  };

  return (
    <div className="m-floater" style={style} onPointerDown={(e) => e.stopPropagation()}>
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
              onPrice(v, side);
            }
          }}
        />
        <div className="m-seg">
          <button className={long ? 'on buy' : ''} onClick={() => changeSide('BUY')}>Buy</button>
          <button className={!long ? 'on sell' : ''} onClick={() => changeSide('SELL')}>Sell</button>
        </div>
        <button className="m-x" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="m-muted m-fl-note">
        {entryOk ? `${kind === 'STOP' ? 'Stop-limit: triggers when the price reaches the level' : 'Limit: waits at the level'} · ${(((entry / mark - 1) * 100) >= 0 ? '+' : '')}${((entry / mark - 1) * 100).toFixed(2)}% vs price` : ''}
      </div>
      <label className="m-fl-row">
        <span>Amount <b>{usedPct.toFixed(1)}%</b></span>
        <input type="range" min={0} max={100} step={0.5} value={pct} onChange={(e) => setPct(Number(e.target.value))} />
      </label>
      <label className="m-fl-row">
        <span>Leverage <b>{lev}x</b></span>
        <input type="range" min={1} max={maxLev} step={1} value={lev} onChange={(e) => setLev(Number(e.target.value))} />
      </label>
      <div className="m-two">
        <label className="m-fl-in">
          <span>SL</span>
          <input type="text" inputMode="decimal" value={sl} onChange={(e) => setSl(e.target.value)} />
          <small className={slRes?.ok ? 'm-muted' : 'down'}>{slRes?.ok ? fmtPrice(slRes.price) : ''}</small>
        </label>
        <label className="m-fl-in">
          <span>TP</span>
          <input type="text" inputMode="decimal" value={tp} onChange={(e) => setTp(e.target.value)} />
          <small className={tpRes?.ok ? 'm-muted' : 'down'}>{tpRes?.ok ? fmtPrice(tpRes.price) : ''}</small>
        </label>
      </div>
      <div className="m-sum">
        <span>{qty > 0 ? qty : 0} {symbol.replace('USDT', '')}</span>
        <span>≈ {(qty * entry || 0).toFixed(2)} USDT</span>
        <span className="down">risk {risk.toFixed(2)}</span>
        <span className="up">reward {reward.toFixed(2)}</span>
      </div>
      {problem && <div className="m-warn">{problem}</div>}
      {waits && !problem && <div className="m-muted m-fl-note">SL / TP are armed and sent when the entry fills (the server must stay running).</div>}
      <div className="m-apply-row">
        <button
          className={`m-market ${long ? 'buy' : 'sell'}`}
          disabled={busy || !trading?.hasCredentials || !(mark > 0)}
          title="Market: enter now at the market price instead of waiting for this level, with the same amount, leverage, stop-loss and take-profit"
          onClick={() => void place(true)}
        >
          M
        </button>
        <button className={`m-primary ${long ? 'buy' : 'sell'}`} disabled={busy || !!problem || !trading?.hasCredentials} onClick={() => void place()}>
          {busy ? 'Placing…' : `Place ${kind === 'STOP' ? 'stop-limit' : 'limit'} ${long ? 'buy' : 'sell'}`}
        </button>
      </div>
    </div>
  );
}
