import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Vela } from '@luxalgo/vela';
import { api } from '../api';
import { useChart, useChartId } from '../chartStore';
import { formatPrice, snapToTick } from '../ladderMath';
import { estimateLiquidation } from '../liquidation';
import { maxPct, sizeFromPct } from '../sizing';
import { useApp } from '../store';
import { refreshTrading } from '../trade';
import type { LeverageBracket, OrderAck, OrderRequest, Side } from '../types';
import { getProjector } from './projector';
import { averagePrice, ladderRungs, MAX_RUNGS, MIN_RUNGS, type RungWeights } from './quickLadder';

const TAG_W = 156;

type Which = 'entry' | 'tp' | 'sl' | 'end';

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

/** The move from the entry to `p` in percent, positive when it is in the trade's favour (a long gains going up, a short going down). */
export function gainPct(side: Side, entry: number, p: number): number {
  return entry > 0 ? (side === 'BUY' ? 1 : -1) * (p / entry - 1) * 100 : 0;
}

export function signed(pct: number, digits = 2): string {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(digits)}%`;
}

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
export function bracketProblems(q: Quick, ladderEnd?: number): string[] {
  const out: string[] = [];
  const long = q.side === 'BUY';
  if (!(q.entry > 0) || !(q.tp > 0) || !(q.sl > 0)) return ['Enter all three prices.'];
  // with a ladder the exits must be beyond every rung: above the highest for a take-profit, below the lowest for a stop-loss (long)
  const prices = ladderEnd != null && ladderEnd > 0 ? [q.entry, ladderEnd] : [q.entry];
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const what = prices.length > 1 ? 'every rung of the ladder' : 'the entry';
  if (long ? !(q.tp > high) : !(q.tp < low)) out.push(`The take-profit must be ${long ? 'above' : 'below'} ${what}.`);
  if (long ? !(q.sl < low) : !(q.sl > high)) out.push(`The stop-loss must be ${long ? 'below' : 'above'} ${what}.`);
  if (ladderEnd != null && ladderEnd > 0 && ladderEnd === q.entry) out.push('The ladder end is the same price as the entry.');
  return out;
}

/** Where a new ladder ends by default: 1.5% beyond the entry, against the trade (a long scales in lower, a short higher). */
export function defaultLadderEnd(side: Side, entry: number, tick: number): number {
  const p = entry * (1 + (side === 'BUY' ? -1 : 1) * 0.015);
  return tick > 0 ? Number((Math.round(p / tick) * tick).toPrecision(12)) : p;
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
  const [brackets, setBrackets] = useState<LeverageBracket[]>([]);
  // a ladder: several entry orders spread from the entry to `end`; the take-profit and stop-loss cover all of them
  const [lad, setLad] = useState<{ on: boolean; count: number; end: number; mode: RungWeights }>({ on: false, count: 5, end: 0, mode: 'equal' });
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
      setLad((l) => ({ ...l, end: defaultLadderEnd(side, entry, tickSize) }));
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

  // the maintenance-margin brackets of the symbol, for the estimated liquidation price
  useEffect(() => {
    if (!q || !canTrade) return;
    let alive = true;
    api
      .leverageBrackets(symbol)
      .then((b) => alive && setBrackets(b))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [q === null, canTrade, symbol]);

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
  const ladOn = lad.on && lad.end > 0 && lad.end !== q.entry;
  const problems = bracketProblems(q, lad.on ? lad.end : undefined);
  const waits = exitsMustWait(q, mark);
  const size = sizeFromPct(pct, wallet, lev);
  const sliderMax = maxPct(wallet, lev, cap);
  const usedPct = Math.min(pct, sliderMax);
  const notional = sizeFromPct(usedPct, wallet, lev).notional;
  const stepSize = Number(filters?.stepSize) || 0;
  // the orders: one entry, or the rungs of the ladder. The total is sized at the (unrounded) average price, then split and rounded per rung
  const shape = ladderRungs(q.entry, ladOn ? lad.end : q.entry, ladOn ? lad.count : 1, lad.mode, 1, tickSize, 0);
  const shapeAvg = shape.reduce((a, x) => a + x.price * x.qty, 0) || q.entry;
  const rungs = ladderRungs(q.entry, ladOn ? lad.end : q.entry, ladOn ? lad.count : 1, lad.mode, shapeAvg > 0 ? notional / shapeAvg : 0, tickSize, stepSize);
  const qty = rungs.reduce((a, x) => a + x.qty, 0);
  const avg = rungs.length > 1 ? averagePrice(rungs) : q.entry;
  const minNotional = Number(filters?.minNotional) || 0;
  const rungTooSmall = qty > 0 && rungs.some((x) => x.qty <= 0 || x.qty * x.price < minNotional);
  const risk = qty * Math.abs(avg - q.sl);
  const reward = qty * Math.abs(q.tp - avg);
  const side2: Side = long ? 'SELL' : 'BUY';
  const liq = estimateLiquidation(q.side, avg, lev, notional, brackets);
  // a stop-loss beyond the liquidation price is never reached: the position is liquidated first
  const slBeyondLiq = liq != null && (long ? q.sl <= liq : q.sl >= liq);
  const gain = (p: number) => gainPct(q.side, avg, p);

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
  const yEnd = ladOn ? yOf(lad.end) : null;
  const yL = liq != null ? yOf(liq) : null;
  const clampY = (y: number | null) => (y == null ? null : Math.max(offY, Math.min(offY + plotH, y)));

  const set = (which: Which, p: number) => (which === 'end' ? setLad((l) => ({ ...l, end: p })) : setQ((cur) => (cur ? { ...cur, [which]: p } : cur)));
  // one switch for the ladder, used by the checkbox in the panel and the one on the amount box
  const toggleLadder = (on: boolean) => setLad((l) => ({ ...l, on, end: l.end > 0 && l.end !== q.entry ? l.end : defaultLadderEnd(q.side, q.entry, tickSize) }));
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

  /** Take back entry orders that were placed (a rejected rung, or exits that could not be placed): nothing is left half-built. */
  const rollback = async (acks: OrderAck[]): Promise<number> => {
    let undone = 0;
    for (const a of acks) {
      try {
        if (a.status === 'HELD') await api.heldCancel(a.clientId);
        else await api.cancelOrder(symbol, a.orderId, a.conditional);
        undone += 1;
      } catch {
        /* the caller says how many could not be taken back */
      }
    }
    return undone;
  };

  const place = async () => {
    if (busy || problems.length || rungTooSmall || !(qty > 0)) return;
    setBusy(true);
    const app = useApp.getState();
    const placed: OrderAck[] = [];
    try {
      if (lev !== initialLev.current) {
        await api.setLeverage(symbol, lev);
        initialLev.current = lev;
      }
      const limit = (p: number) => snapToTick(p * (long ? 1 + LIMIT_OFFSET : 1 - LIMIT_OFFSET), filters?.tickSize);
      for (const [i, rung] of rungs.entries()) {
        const k = entryKind(q.side, rung.price, mark);
        const req: OrderRequest =
          k === 'STOP' ? { symbol, side: q.side, type: 'STOP', quantity: rung.qty, stopPrice: rung.price, price: limit(rung.price) } : { symbol, side: q.side, type: 'LIMIT', quantity: rung.qty, price: rung.price };
        try {
          placed.push(await api.placeOrder(req));
        } catch (e) {
          const undone = await rollback(placed);
          throw new Error(`order ${i + 1} of ${rungs.length} @ ${formatPrice(rung.price, precision)} was refused (${e}). ${placed.length ? `${undone} of the ${placed.length} orders before it were cancelled.` : 'Nothing was placed.'}`);
        }
      }
      // the protective orders cover the whole entry, and are reduce-only so they can never open a position
      const total = placed.reduce((a, x) => a + x.quantity, 0);
      const single = placed.length === 1 ? placed[0] : null;
      const exit = (type: 'TAKE_PROFIT_MARKET' | 'STOP_MARKET', stopPrice: number): OrderRequest => ({ symbol, side: side2, type, quantity: total, stopPrice, reduceOnly: true });
      const what = rungs.length > 1 ? `${rungs.length}-order ${long ? 'long' : 'short'} ladder ${formatPrice(q.entry, precision)} to ${formatPrice(rungs[rungs.length - 1].price, precision)}` : `${long ? 'long' : 'short'} ${kind === 'STOP' ? 'stop-limit' : 'limit'} entry @ ${formatPrice(q.entry, precision)}`;
      if (waits) {
        // the exits are on the wrong side of the market for now: Harvester sends them the moment the entry has filled
        try {
          await api.bracketAdd({ symbol, long, takeProfit: q.tp, stopLoss: q.sl, entryOrderId: single && single.status !== 'HELD' ? single.orderId : 0, entryConditional: single ? single.conditional : false, quantity: total });
        } catch (e) {
          await rollback(placed);
          throw new Error(`could not arm the take-profit / stop-loss (${e}); the entry orders were cancelled`);
        }
        app.toast(`Placed ${symbol} ${what}. TP ${formatPrice(q.tp, precision)} / SL ${formatPrice(q.sl, precision)} are armed: they go to Binance as soon as the entry fills (keep Harvester open).`, 'info');
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
        // never leave an entry without its protection: take the entry orders back
        const undone = await rollback(placed);
        app.toast(`Bracket not complete (${failed.join('; ')}). ${undone === placed.length ? 'The entry orders were cancelled.' : 'Check the entry orders: some are still open.'}`, 'warn');
      } else {
        app.toast(`Placed ${symbol} ${what} with TP ${formatPrice(q.tp, precision)} and SL ${formatPrice(q.sl, precision)}`, 'info');
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
  const line = (which: Which, y: number | null, color: string, label: string, tag: string) =>
    y == null ? null : (
      <g key={which}>
        <line x1={offX} x2={offX + plotW} y1={y} y2={y} stroke={color} strokeWidth={drag === which ? 2.4 : 1.4} strokeDasharray={which === 'entry' ? undefined : '6 4'} />
        <line className="quick-hit" x1={offX} x2={offX + plotW} y1={y} y2={y} stroke="transparent" strokeWidth={14} onPointerDown={(e) => startDrag(e, which)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={() => setDrag(null)}>
          <title>Drag to move</title>
        </line>
        <g className="line-tag drag" transform={`translate(${offX + plotW - TAG_W - 2}, ${y - 9})`} onPointerDown={(e) => startDrag(e, which)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={() => setDrag(null)} onDoubleClick={() => canTrade && void place()}>
          <rect width={TAG_W} height={18} rx={3} fill="#0f1620" fillOpacity={0.45} stroke={color} strokeWidth={drag === which ? 2 : 1} />
          <text x={TAG_W / 2} y={12.5} textAnchor="middle" fill={color}>
            {tag}
          </text>
          <title>Grab to move · double-click to place the order</title>
        </g>
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
        value={which === 'end' ? lad.end : q[which]}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) set(which, v);
        }}
      />
      <em className={which === 'tp' ? 'up' : which === 'sl' ? 'down' : ''} title={which === 'entry' || which === 'end' ? undefined : `${signed(gain(q[which]))} price move, multiplied by the ${lev}x leverage`}>
        {which === 'entry' ? (mark > 0 ? `${((q.entry / mark - 1) * 100).toFixed(2)}% vs last` : '') : which === 'end' ? `${((lad.end / q.entry - 1) * 100).toFixed(2)}% vs entry` : signed(gain(q[which]) * lev)}
      </em>
    </label>
  );

  return (
    <div ref={rootRef} className="trade-layer">
      <svg className="trade-svg">
        {yE != null && yT != null && clampY(yE) != null && <rect x={offX} width={plotW} y={Math.min(clampY(yE)!, clampY(yT)!)} height={Math.abs(clampY(yE)! - clampY(yT)!)} fill="rgba(46, 155, 111, 0.10)" />}
        {yE != null && yS != null && <rect x={offX} width={plotW} y={Math.min(clampY(yE)!, clampY(yS)!)} height={Math.abs(clampY(yE)! - clampY(yS)!)} fill="rgba(208, 69, 75, 0.10)" />}
        {line('tp', yT, '#2e9b6f', `TP ${formatPrice(q.tp, precision)}  ${signed(gain(q.tp) * lev)} on margin at ${lev}x · ${signed(gain(q.tp))} price move`, `TAKE PROFIT ${signed(gain(q.tp) * lev)}`)}
        {line('sl', yS, '#d0454b', `SL ${formatPrice(q.sl, precision)}  ${signed(gain(q.sl) * lev)} on margin at ${lev}x · ${signed(gain(q.sl))} price move`, `STOP LOSS ${signed(gain(q.sl) * lev)}`)}
        {liq != null && yL != null && (
          <g>
            <line x1={offX} x2={offX + plotW} y1={yL} y2={yL} stroke="#e0a33d" strokeWidth={1.2} strokeDasharray="2 4" />
            <g className="line-tag" transform={`translate(${offX + plotW - TAG_W - 2}, ${yL - 9})`}>
              <rect width={TAG_W} height={18} rx={3} fill="#0f1620" fillOpacity={0.45} stroke="#e0a33d" />
              <text x={TAG_W / 2} y={12.5} textAnchor="middle" fill="#e0a33d">
                {`LIQUIDATION ~${signed(gain(liq) * lev, 0)}`}
              </text>
              <title>Estimated liquidation price for this position size and leverage (isolated margin, fees ignored)</title>
            </g>
            <text x={offX + 8} y={yL - 4} className="trade-label" fill="#e0a33d">
              {`Est. liquidation ${formatPrice(liq, precision)}  ${signed(gain(liq))} from entry`}
            </text>
          </g>
        )}
        {ladOn && yE != null && yEnd != null && <rect x={offX} width={plotW} y={Math.min(yE, yEnd)} height={Math.abs(yE - yEnd)} fill={long ? 'rgba(46, 155, 111, 0.07)' : 'rgba(208, 69, 75, 0.07)'} />}
        {ladOn &&
          rungs.slice(1, -1).map((x) => {
            const y = yOf(x.price);
            return y == null ? null : <line key={x.price} x1={offX} x2={offX + plotW} y1={y} y2={y} stroke={colorE} strokeWidth={1} strokeDasharray="1 5" opacity={0.8} />;
          })}
        {ladOn && line('end', yEnd, colorE, `LADDER END ${formatPrice(lad.end, precision)}  (${rungs.length} orders, avg ${formatPrice(avg, precision)})`, `LADDER END ×${rungs.length}`)}
        {line('entry', yE, colorE, `${long ? 'LONG' : 'SHORT'} ${ladOn ? 'LADDER START' : kind === 'STOP' ? 'STOP-LIMIT' : 'LIMIT'} @ ${formatPrice(q.entry, precision)}`, `${long ? 'LONG' : 'SHORT'} ${ladOn ? 'LADDER' : kind === 'STOP' ? 'STOP-LIMIT' : 'LIMIT'}`)}
      </svg>
      {yE != null && (
        <div
          className="quick-amount"
          style={{ left: offX + plotW - TAG_W - 2, top: yE + 12 + 64 > offY + plotH ? yE - 76 : yE + 12, width: TAG_W }}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <input type="range" min={0} max={Math.max(1, sliderMax)} step={0.5} value={usedPct} disabled={!(wallet > 0)} title="Drag to change the amount (% of the account used as margin)" onChange={(e) => setPct(Number(e.target.value))} />
          <div>
            {qty > 0 ? qty.toFixed(filters?.quantityPrecision ?? 3) : '0'} {symbol.replace('USDT', '')}{ladOn ? ' (all rungs)' : ''}
          </div>
          <div className="muted">
            ≈ {notional.toFixed(2)} USDT · {usedPct.toFixed(1)}%
          </div>
          <label className="quick-ladder-check" title="Spread the entry over several orders (same switch as in the panel)">
            <input type="checkbox" checked={lad.on} onChange={(e) => toggleLadder(e.target.checked)} /> Ladder
          </label>
        </div>
      )}
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
          {kind === 'STOP' ? `Stop-limit: triggers at the entry price, limit ${(LIMIT_OFFSET * 100).toFixed(1)}% beyond it.` : `Limit order: the entry is on the near side of the market, so it waits as a normal limit order.`} Drag the boxes on the chart or type prices; double-click a box to place the order. Tick “Ladder” to spread the entry over several orders.
        </div>
        {field('entry', ladOn ? 'Ladder start' : 'Entry')}
        <label className="quick-check">
          <input
            type="checkbox"
            checked={lad.on}
            onChange={(e) => toggleLadder(e.target.checked)}
          />{' '}
          Ladder: spread the entry over several orders
        </label>
        {lad.on && (
          <>
            {field('end', 'Ladder end')}
            <label className="quick-slider">
              <span>
                Orders <b>{rungs.length}</b>
              </span>
              <input type="range" min={MIN_RUNGS} max={MAX_RUNGS} step={1} value={lad.count} onChange={(e) => setLad((l) => ({ ...l, count: Number(e.target.value) }))} />
            </label>
            <label className="quick-row">
              <span>Sizes</span>
              <select value={lad.mode} onChange={(e) => setLad((l) => ({ ...l, mode: e.target.value as RungWeights }))}>
                <option value="equal">Equal</option>
                <option value="up">Bigger towards the end</option>
                <option value="down">Smaller towards the end</option>
              </select>
              <em />
            </label>
            <div className="muted quick-note">
              {rungs.map((x) => `${x.qty.toFixed(filters?.quantityPrecision ?? 3)} @ ${formatPrice(x.price, precision)}`).join(' · ')}
            </div>
          </>
        )}
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
          {ladOn && <span>Avg entry {formatPrice(avg, precision)}</span>}
          <span>Margin {(notional / Math.max(1, lev)).toFixed(2)}</span>
          <span className="down">Risk {risk.toFixed(2)}</span>
          <span className="up">Reward {reward.toFixed(2)}</span>
          <span>R:R {risk > 0 ? (reward / risk).toFixed(2) : '-'}</span>
          {liq != null && <span style={{ color: '#e0a33d' }}>Est. liquidation {formatPrice(liq, precision)} ({signed(gain(liq))})</span>}
        </div>
        {waits && problems.length === 0 && <div className="muted quick-note">The take-profit / stop-loss are on the far side of the current price, so Binance would reject them now. They are armed here and sent as soon as the entry fills (Harvester must stay open).</div>}
        {slBeyondLiq && <div className="warn quick-note">The stop-loss is beyond the estimated liquidation price {formatPrice(liq!, precision)}: the position would be liquidated before it triggers. Lower the leverage or move the stop closer.</div>}
        {rungTooSmall && <div className="warn quick-note">An order of the ladder is below the exchange's minimum size ({minNotional} USDT): use fewer orders or a bigger amount.</div>}
        {problems.map((p) => (
          <div key={p} className="warn quick-note">
            {p}
          </div>
        ))}
        {!canTrade && <div className="warn quick-note">{trading?.message}</div>}
        {cap > 0 && size.notional > cap && <div className="muted quick-note">Limited to the safety cap of {cap} USDT per order.</div>}
        <div className="quick-actions">
          <button onClick={() => setQ(null)}>Cancel</button>
          <button className={`primary ${long ? 'buy' : 'sell'}`} disabled={busy || !canTrade || problems.length > 0 || rungTooSmall || !(qty > 0)} onClick={() => void place()}>
            {busy ? 'Placing…' : 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}
