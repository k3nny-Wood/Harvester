import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Vela } from '@luxalgo/vela';
import { api } from '../api';
import { useChart, useChartId } from '../chartStore';
import { formatPrice, snapToTick } from '../ladderMath';
import { maxPct, sizeFromPct } from '../sizing';
import { useApp } from '../store';
import { refreshTrading } from '../trade';
import type { OrderAck, OrderRequest, Side } from '../types';
import { getProjector } from './projector';

type Which = 'entry' | 'tp' | 'sl';

interface Quick {
  side: Side;
  entry: number;
  tp: number;
  sl: number;
}

/** How far a stop-limit's limit price sits beyond its trigger, so a fast move through the trigger still fills. */
const LIMIT_OFFSET = 0.001;
const DEFAULT_SL_PCT = 1;
const DEFAULT_TP_PCT = 2;

/** What `entry` becomes on the exchange: a stop-limit when the level is beyond the market (a breakout), a plain limit when it is on the near side (a pullback). */
export function entryKind(side: Side, entry: number, mark: number): 'STOP' | 'LIMIT' {
  return side === 'BUY' ? (entry > mark ? 'STOP' : 'LIMIT') : entry < mark ? 'STOP' : 'LIMIT';
}

/** Default take-profit and stop-loss around an entry: the take-profit on the profit side, the stop on the loss side. */
export function defaultBracket(side: Side, entry: number, tick: number): { tp: number; sl: number } {
  const dir = side === 'BUY' ? 1 : -1;
  const r = (p: number) => (tick > 0 ? Number((Math.round(p / tick) * tick).toPrecision(12)) : p);
  return { tp: r(entry * (1 + (dir * DEFAULT_TP_PCT) / 100)), sl: r(entry * (1 - (dir * DEFAULT_SL_PCT) / 100)) };
}

/** Mistakes in the levels themselves (wrong side of the entry); an empty list means the bracket makes sense. */
export function bracketProblems(q: Quick): string[] {
  const out: string[] = [];
  const long = q.side === 'BUY';
  if (!(q.entry > 0) || !(q.tp > 0) || !(q.sl > 0)) return ['Enter all three prices.'];
  if (long ? !(q.tp > q.entry) : !(q.tp < q.entry)) out.push(`The take-profit must be ${long ? 'above' : 'below'} the entry.`);
  if (long ? !(q.sl < q.entry) : !(q.sl > q.entry)) out.push(`The stop-loss must be ${long ? 'below' : 'above'} the entry.`);
  return out;
}

/** True when an exit sits on the wrong side of the CURRENT price (Binance would refuse or fire it at once): it has to wait for the entry to fill. */
export function exitsMustWait(q: Quick, mark: number): boolean {
  if (!(mark > 0)) return false;
  const long = q.side === 'BUY';
  return (long ? q.tp <= mark : q.tp >= mark) || (long ? q.sl >= mark : q.sl <= mark);
}

/**
 * Quick bracket order. Hover the chart and press F (long) or D (short): the entry is a stop-limit at the price under the pointer
 * (a plain limit when that price is on the near side of the market), with a take-profit and a stop-loss. The three lines can be dragged
 * and a panel sets amount and leverage. OK places the entry together with its take-profit and stop-loss (both reduce-only, sized to the entry).
 */
export function QuickOrder({ chart, host }: { chart: Vela | null; host: RefObject<HTMLDivElement | null> }) {
  const chartId = useChartId();
  const symbol = useChart((s) => s.symbol);
  const filters = useChart((s) => s.filters);
  const mark = useChart((s) => s.markPrice);
  const account = useApp((s) => s.account);
  const trading = useApp((s) => s.trading);
  const env = useApp((s) => s.env);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastY = useRef<number | null>(null);
  const inside = useRef(false);
  const [q, setQ] = useState<Quick | null>(null);
  const [drag, setDrag] = useState<Which | null>(null);
  const [pct, setPct] = useState(10);
  const [lev, setLev] = useState(1);
  const [maxLev, setMaxLev] = useState(20);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);
  const tickSize = Number(filters?.tickSize) || 0;
  const precision = filters?.pricePrecision ?? 2;
  const wallet = account?.walletBalance ?? 0;
  const cap = trading?.maxOrderNotional ?? 0;
  const canTrade = !!trading?.hasCredentials;
  const initialLev = useRef(1);

  const priceAt = useCallback(
    (clientY: number): number | null => {
      if (!chart) return null;
      const info = getProjector(chart);
      if (!info) return null;
      return snapToTick(info.proj.pxToPoint(0, clientY - info.plotRect.top, 'price').price, filters?.tickSize);
    },
    [chart, filters?.tickSize],
  );

  // where the pointer is over this chart, and the F / D keys
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const move = (e: PointerEvent) => {
      lastY.current = e.clientY;
      inside.current = true;
    };
    const leave = () => (inside.current = false);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
    };
  }, [host]);

  const open = useCallback(
    (side: Side) => {
      const raw = lastY.current != null ? priceAt(lastY.current) : null;
      const entry = raw ?? snapToTick(mark, filters?.tickSize);
      if (!(entry > 0)) return;
      setQ({ side, entry, ...defaultBracket(side, entry, tickSize) });
    },
    [priceAt, mark, filters?.tickSize, tickSize],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return setQ(null);
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const k = e.key.toLowerCase();
      if (k !== 'f' && k !== 'd') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (!inside.current || useApp.getState().activeChartId !== chartId) return;
      e.preventDefault();
      open(k === 'f' ? 'BUY' : 'SELL');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chartId, open]);

  // the symbol's leverage when the panel opens
  const levFor = useRef('');
  useEffect(() => {
    if (!q || !canTrade || levFor.current === symbol) return;
    levFor.current = symbol;
    api
      .symbolLeverage(symbol)
      .then((l) => {
        setMaxLev(Math.max(1, l.maxLeverage));
        setLev(l.leverage);
        initialLev.current = l.leverage;
      })
      .catch(() => undefined);
  }, [q, canTrade, symbol]);

  // a different symbol on this chart closes the panel; the lines follow the viewport
  useEffect(() => setQ(null), [symbol]);
  useEffect(() => {
    if (!chart || !q) return;
    const bump = () => setTick((t) => t + 1);
    const offs = [chart.on('viewport:changed', bump), chart.on('pane:changed', bump)];
    const timer = window.setInterval(bump, 300);
    return () => {
      offs.forEach((o) => typeof o === 'function' && o());
      window.clearInterval(timer);
    };
  }, [chart, q === null]);

  if (!q) return <div ref={rootRef} className="trade-layer" />;

  const long = q.side === 'BUY';
  const kind = entryKind(q.side, q.entry, mark);
  const problems = bracketProblems(q);
  const waits = exitsMustWait(q, mark);
  const size = sizeFromPct(pct, wallet, lev);
  const sliderMax = maxPct(wallet, lev, cap);
  const usedPct = Math.min(pct, sliderMax);
  const notional = sizeFromPct(usedPct, wallet, lev).notional;
  const qty = q.entry > 0 ? notional / q.entry : 0;
  const risk = qty * Math.abs(q.entry - q.sl);
  const reward = qty * Math.abs(q.tp - q.entry);
  const side2: Side = long ? 'SELL' : 'BUY';
  const fromEntry = (p: number) => (q.entry > 0 ? ((p / q.entry - 1) * 100).toFixed(2) : '0');

  const info = chart ? getProjector(chart) : null;
  const root = rootRef.current;
  const rect = root?.getBoundingClientRect();
  const offY = info && rect ? info.plotRect.top - rect.top : 0;
  const offX = info && rect ? info.plotRect.left - rect.left : 0;
  const plotW = info?.proj.width ?? 0;
  const plotH = info?.proj.height ?? 0;
  const yOf = (p: number): number | null => {
    const y = info?.proj.yOf(p, 'price');
    return y == null ? null : offY + y;
  };
  const yE = yOf(q.entry);
  const yT = yOf(q.tp);
  const yS = yOf(q.sl);
  const clampY = (y: number | null) => (y == null ? null : Math.max(offY, Math.min(offY + plotH, y)));

  const set = (which: Which, p: number) => setQ((cur) => (cur ? { ...cur, [which]: p } : cur));
  const startDrag = (e: React.PointerEvent, which: Which) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setDrag(which);
  };
  const moveDrag = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = priceAt(e.clientY);
    if (p != null && p > 0) set(drag, p);
  };
  const endDrag = (e: React.PointerEvent) => {
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    setDrag(null);
  };

  const place = async () => {
    if (busy || problems.length || !(qty > 0)) return;
    setBusy(true);
    const app = useApp.getState();
    try {
      if (lev !== initialLev.current) {
        await api.setLeverage(symbol, lev);
        initialLev.current = lev;
      }
      const limit = (p: number) => snapToTick(p * (long ? 1 + LIMIT_OFFSET : 1 - LIMIT_OFFSET), filters?.tickSize);
      const entry: OrderRequest =
        kind === 'STOP' ? { symbol, side: q.side, type: 'STOP', quantity: qty, stopPrice: q.entry, price: limit(q.entry) } : { symbol, side: q.side, type: 'LIMIT', quantity: qty, price: q.entry };
      const ack: OrderAck = await api.placeOrder(entry);
      // the protective orders are sized to what was actually sent, and reduce-only so they can never open a position
      const exit = (type: 'TAKE_PROFIT_MARKET' | 'STOP_MARKET', stopPrice: number): OrderRequest => ({ symbol, side: side2, type, quantity: ack.quantity, stopPrice, reduceOnly: true });
      if (waits) {
        // the exits are on the wrong side of the market for now: Harvester sends them the moment the entry has filled
        try {
          await api.bracketAdd({ symbol, long, takeProfit: q.tp, stopLoss: q.sl, entryOrderId: ack.status === 'HELD' ? 0 : ack.orderId, entryConditional: ack.conditional });
        } catch (e) {
          if (ack.status !== 'HELD') await api.cancelOrder(symbol, ack.orderId, ack.conditional).catch(() => undefined);
          throw new Error(`could not arm the take-profit / stop-loss (${e}); the entry was cancelled`);
        }
        app.toast(`Placed ${long ? 'long' : 'short'} ${symbol} ${kind === 'STOP' ? 'stop-limit' : 'limit'} entry @ ${formatPrice(q.entry, precision)}. TP ${formatPrice(q.tp, precision)} / SL ${formatPrice(q.sl, precision)} are armed: they go to Binance as soon as the entry fills (keep Harvester open).`, 'info');
        setQ(null);
        void refreshTrading();
        return;
      }
      const failed: string[] = [];
      for (const [label, req] of [['take-profit', exit('TAKE_PROFIT_MARKET', q.tp)], ['stop-loss', exit('STOP_MARKET', q.sl)]] as const) {
        try {
          await api.placeOrder(req);
        } catch (e) {
          failed.push(`${label}: ${e}`);
        }
      }
      if (failed.length) {
        // never leave an entry without its protection: take the entry back if it is on the exchange
        let undone = false;
        if (ack.status !== 'HELD') {
          try {
            await api.cancelOrder(symbol, ack.orderId, ack.conditional);
            undone = true;
          } catch {
            /* reported below */
          }
        }
        app.toast(`Bracket not complete (${failed.join('; ')}). ${undone ? 'The entry was cancelled.' : 'Check the entry order: it is still open.'}`, 'warn');
      } else {
        app.toast(`Placed ${long ? 'long' : 'short'} ${symbol}: ${kind === 'STOP' ? 'stop-limit' : 'limit'} entry @ ${formatPrice(q.entry, precision)} with TP ${formatPrice(q.tp, precision)} and SL ${formatPrice(q.sl, precision)}`, 'info');
        setQ(null);
      }
      void refreshTrading();
    } catch (e) {
      app.toast(`Order rejected: ${e}`, 'warn');
    } finally {
      setBusy(false);
    }
  };

  const colorE = long ? '#2e9b6f' : '#d0454b';
  const line = (which: Which, y: number | null, color: string, label: string) =>
    y == null ? null : (
      <g key={which}>
        <line x1={offX} x2={offX + plotW} y1={y} y2={y} stroke={color} strokeWidth={drag === which ? 2.4 : 1.4} strokeDasharray={which === 'entry' ? undefined : '6 4'} />
        <line className="quick-hit" x1={offX} x2={offX + plotW} y1={y} y2={y} stroke="transparent" strokeWidth={14} onPointerDown={(e) => startDrag(e, which)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={() => setDrag(null)}>
          <title>Drag to move</title>
        </line>
        <text x={offX + 8} y={y - 4} className="trade-label" fill={color}>
          {label}
        </text>
      </g>
    );

  const field = (which: Which, label: string) => (
    <label className="quick-row">
      <span>{label}</span>
      <input
        type="number"
        step={tickSize || 'any'}
        value={q[which]}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) set(which, v);
        }}
      />
      <em className={which === 'tp' ? 'up' : which === 'sl' ? 'down' : ''}>{which === 'entry' ? (mark > 0 ? `${((q.entry / mark - 1) * 100).toFixed(2)}% vs last` : '') : `${fromEntry(q[which])}%`}</em>
    </label>
  );

  return (
    <div ref={rootRef} className="trade-layer">
      <svg className="trade-svg">
        {yE != null && yT != null && clampY(yE) != null && <rect x={offX} width={plotW} y={Math.min(clampY(yE)!, clampY(yT)!)} height={Math.abs(clampY(yE)! - clampY(yT)!)} fill="rgba(46, 155, 111, 0.10)" />}
        {yE != null && yS != null && <rect x={offX} width={plotW} y={Math.min(clampY(yE)!, clampY(yS)!)} height={Math.abs(clampY(yE)! - clampY(yS)!)} fill="rgba(208, 69, 75, 0.10)" />}
        {line('tp', yT, '#2e9b6f', `TP ${formatPrice(q.tp, precision)} (${fromEntry(q.tp)}%)`)}
        {line('sl', yS, '#d0454b', `SL ${formatPrice(q.sl, precision)} (${fromEntry(q.sl)}%)`)}
        {line('entry', yE, colorE, `${long ? 'LONG' : 'SHORT'} ${kind === 'STOP' ? 'STOP-LIMIT' : 'LIMIT'} @ ${formatPrice(q.entry, precision)}`)}
      </svg>
      <div className="quick-panel" onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
        <div className="quick-title">
          <b className={long ? 'up' : 'down'}>
            {long ? '▲ Long' : '▼ Short'} {symbol}
          </b>
          {env === 'live' && <span className="quick-live">LIVE</span>}
          <button className="icon-btn" title="Cancel (Esc)" onClick={() => setQ(null)}>
            ×
          </button>
        </div>
        <div className="muted quick-note">
          {kind === 'STOP' ? `Stop-limit: triggers at the entry price, limit ${(LIMIT_OFFSET * 100).toFixed(1)}% beyond it.` : `Limit order: the entry is on the near side of the market, so it waits as a normal limit order.`} Drag the lines on the chart or type prices.
        </div>
        {field('entry', 'Entry')}
        {field('tp', 'Take-profit')}
        {field('sl', 'Stop-loss')}
        <label className="quick-slider">
          <span>
            Amount <b>{usedPct.toFixed(1)}% of account</b>
          </span>
          <input type="range" min={0} max={Math.max(1, sliderMax)} step={0.5} value={usedPct} disabled={!(wallet > 0)} onChange={(e) => setPct(Number(e.target.value))} />
        </label>
        <label className="quick-slider">
          <span>
            Leverage <b>{lev}x</b>
          </span>
          <input type="range" min={1} max={maxLev} step={1} value={lev} onChange={(e) => setLev(Number(e.target.value))} />
        </label>
        <div className="quick-sum">
          <span>Position {notional.toFixed(2)} USDT</span>
          <span>Margin {(notional / Math.max(1, lev)).toFixed(2)}</span>
          <span className="down">Risk {risk.toFixed(2)}</span>
          <span className="up">Reward {reward.toFixed(2)}</span>
          <span>R:R {risk > 0 ? (reward / risk).toFixed(2) : '-'}</span>
        </div>
        {waits && problems.length === 0 && <div className="muted quick-note">The take-profit / stop-loss are on the far side of the current price, so Binance would reject them now. They are armed here and sent as soon as the entry fills (Harvester must stay open).</div>}
        {problems.map((p) => (
          <div key={p} className="warn quick-note">
            {p}
          </div>
        ))}
        {!canTrade && <div className="warn quick-note">{trading?.message}</div>}
        {cap > 0 && size.notional > cap && <div className="muted quick-note">Limited to the safety cap of {cap} USDT per order.</div>}
        <div className="quick-actions">
          <button onClick={() => setQ(null)}>Cancel</button>
          <button className={`primary ${long ? 'buy' : 'sell'}`} disabled={busy || !canTrade || problems.length > 0 || !(qty > 0)} onClick={() => void place()}>
            {busy ? 'Placing…' : 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}
