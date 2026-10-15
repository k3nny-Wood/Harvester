import { useEffect, useMemo, useRef, useState } from 'react';
import { api, onKline } from '../api';
import { confirmDialog } from '../confirm';
import { useLivePositions } from '../livePositions';
import { exitState } from '../positionExits';
import { useApp } from '../store';
import { refreshTrading } from '../trade';
import type { Kline, Position } from '../types';
import { fmtPrice, type ChartLine } from './chartMath';
import { ExitSheet } from './ExitSheet';
import { MobileChart, type PendingLine } from './MobileChart';
import { TIMEFRAMES, useMobile } from './store';
import { useFloater } from './floaterStore';
import { OrderFloater, sideFor } from './OrderFloater';
import { pctText, resolveBoth, resolveExit } from './exits';
import { snapToTick } from '../ladderMath';
import type { OpenOrder } from '../types';
import { TradeSheet } from './TradeSheet';

const coin = (s: string) => s.replace('USDT', '');
const signed = (n: number, d = 2) => `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(d)}`;
const tone = (n: number) => (n > 0 ? 'up' : n < 0 ? 'down' : '');

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

// ---------------------------------------------------------------- positions

function PositionCard({ p }: { p: Position }) {
  const orders = useApp((s) => s.orders);
  const toast = useApp((s) => s.toast);
  const openChart = useMobile((s) => s.openChart);
  const [exit, setExit] = useState<'stop' | 'take' | null>(null);
  const long = p.amount > 0;
  const ex = exitState(p.symbol, p.amount, orders);
  const level = (o: typeof ex.stop) => (o ? fmtPrice(o.stopPrice || o.price) : 'none');
  const margin = (Math.abs(p.amount) * p.entryPrice) / Math.max(1, p.leverage);
  const roe = margin > 0 ? (p.unrealizedPnl / margin) * 100 : 0;
  const close = async (fraction: number) => {
    if (!(await confirmDialog(`Close ${Math.round(fraction * 100)}% of the ${p.symbol} ${long ? 'long' : 'short'} at market?`, { confirmLabel: 'Close', danger: true }))) return;
    try {
      await api.closePosition(p.symbol, fraction);
      toast(`Closing ${Math.round(fraction * 100)}% of ${p.symbol}`, 'info');
      void refreshTrading();
    } catch (e) {
      toast(`Close: ${e}`, 'warn');
    }
  };
  return (
    <div className="m-card">
      <div className="m-row" onClick={() => openChart(p.symbol)}>
        <b className="m-coin">{coin(p.symbol)}</b>
        <span className={`m-badge ${long ? 'up' : 'down'}`}>{long ? 'LONG' : 'SHORT'}</span>
        <span className="m-muted">{p.leverage}x {p.isolated ? 'iso' : 'cross'}</span>
        <span className={`m-pnl ${tone(p.unrealizedPnl)}`}>
          {signed(p.unrealizedPnl)} <small>({roe >= 0 ? '+' : ''}{roe.toFixed(1)}%)</small>
        </span>
      </div>
      <div className="m-grid">
        <span>Entry <b>{fmtPrice(p.entryPrice)}</b></span>
        <span>Now <b>{fmtPrice(p.markPrice)}</b></span>
        <span>Size <b>{Math.abs(p.amount)}</b></span>
        <span>Stop <b className={ex.stop ? '' : 'm-warn-text'}>{level(ex.stop)}</b></span>
        <span>Target <b>{level(ex.take)}</b></span>
        <span>Liq <b>{p.liquidationPrice > 0 ? fmtPrice(p.liquidationPrice) : '-'}</b></span>
      </div>
      <div className="m-actions">
        <button onClick={() => setExit('stop')} title={ex.stop ? 'Move the stop-loss' : 'Set a stop-loss'}>{ex.stop ? 'SL ✎' : '+ SL'}</button>
        <button onClick={() => setExit('take')} title={ex.take ? 'Move the take-profit' : 'Set a take-profit'}>{ex.take ? 'TP ✎' : '+ TP'}</button>
        <button className="m-danger" onClick={() => void close(0.5)}>50%</button>
        <button className="m-danger" onClick={() => void close(1)}>Close</button>
      </div>
      {exit && <ExitSheet kind={exit} position={p} onClose={() => setExit(null)} />}
    </div>
  );
}

export function PositionsTab() {
  const live = useLivePositions();
  const account = useApp((s) => s.account);
  const trading = useApp((s) => s.trading);
  if (trading && !trading.hasCredentials) return <div className="m-empty">No Binance API keys are set on the server for this environment.</div>;
  if (!account || !live) return <div className="m-empty">Loading the account…</div>;
  const rows = [...live.positions].filter((p) => p.amount !== 0).sort((a, b) => a.unrealizedPnl - b.unrealizedPnl);
  if (!rows.length) return <div className="m-empty">No open positions.</div>;
  return (
    <div className="m-list">
      {rows.map((p) => (
        <PositionCard key={p.symbol} p={p} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- orders

export function OrdersTab() {
  const orders = useApp((s) => s.orders);
  const toast = useApp((s) => s.toast);
  const openChart = useMobile((s) => s.openChart);
  const cancel = async (o: (typeof orders)[number]) => {
    if (!(await confirmDialog(`Cancel the ${o.side} ${o.type.replace(/_/g, ' ').toLowerCase()} on ${o.symbol}?`, { confirmLabel: 'Cancel order' }))) return;
    try {
      await api.cancelOrder(o.symbol, o.orderId, o.conditional);
      void refreshTrading();
    } catch (e) {
      toast(`Cancel: ${e}`, 'warn');
    }
  };
  if (!orders.length) return <div className="m-empty">No open orders.</div>;
  return (
    <div className="m-list">
      {[...orders].sort((a, b) => a.symbol.localeCompare(b.symbol)).map((o) => (
        <div key={`${o.conditional}-${o.orderId}`} className="m-card">
          <div className="m-row" onClick={() => openChart(o.symbol)}>
            <b className="m-coin">{coin(o.symbol)}</b>
            <span className={`m-badge ${o.side === 'BUY' ? 'up' : 'down'}`}>{o.side}</span>
            <span className="m-muted">{o.type.replace(/_/g, ' ').toLowerCase()}{o.reduceOnly ? ' · reduce-only' : ''}</span>
          </div>
          <div className="m-grid">
            <span>Price <b>{fmtPrice(o.stopPrice && !o.price ? o.stopPrice : o.price)}</b></span>
            <span>Qty <b>{o.origQty}</b></span>
            <span>Filled <b>{o.executedQty}</b></span>
          </div>
          <div className="m-actions">
            <button className="m-danger" onClick={() => void cancel(o)}>Cancel</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- scanner

export function ScannerTab() {
  const signals = useApp((s) => s.signals);
  const scanner = useApp((s) => s.scanner);
  const openChart = useMobile((s) => s.openChart);
  const rows = useMemo(() => signals.slice(0, 60), [signals]);
  return (
    <div className="m-list">
      <div className="m-muted m-pad">{scanner ? `${scanner.phase} · ${scanner.seeded}/${scanner.symbols} symbols · ${signals.length} signals` : 'Scanner starting…'}</div>
      {!rows.length && <div className="m-empty">No signals right now.</div>}
      {rows.map((s) => (
        <div key={s.id} className="m-card" onClick={() => openChart(s.symbol)}>
          <div className="m-row">
            <b className="m-coin">{coin(s.symbol)}</b>
            <span className={`m-badge ${s.kind === 'pump' ? 'up' : s.kind === 'dump' || s.kind === 'drop' ? 'down' : 'warn'}`}>{s.kind.toUpperCase()}</span>
            <span className="m-muted">{s.timeframe} · {ago(s.timeMs)} ago</span>
            <span className="m-pnl">score {s.score}</span>
          </div>
          <div className="m-grid">
            <span>Price <b>{fmtPrice(s.price)}</b></span>
            {s.distancePct != null && <span>vs crack <b>{s.distancePct.toFixed(2)}%</b></span>}
            <span>Drop <b>{s.dropPct.toFixed(1)}%</b></span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- chart

const FLOATER_W = 330;

/** The bar for moving an order that is on the exchange: what it is, the new price (typed or from the handle) and Apply / Cancel. */
function AdjustBar({ adjust, busy, atTop, onPrice, onApply, onCancel }: { adjust: { kind: 'sl' | 'tp' | 'order'; order: OpenOrder; price: number; original: number }; busy: boolean; atTop: boolean; onPrice: (p: number) => void; onApply: () => void; onCancel: () => void }) {
  const [text, setText] = useState(String(adjust.price));
  const typed = useRef(false);
  useEffect(() => {
    if (typed.current) {
      typed.current = false;
      return;
    }
    setText(String(adjust.price));
  }, [adjust.price]);
  const change = adjust.original > 0 ? (adjust.price / adjust.original - 1) * 100 : 0;
  const name = adjust.kind === 'sl' ? 'Stop-loss' : adjust.kind === 'tp' ? 'Take-profit' : `${adjust.order.side.toLowerCase()} ${adjust.order.type.replace(/_/g, ' ').toLowerCase()}`;
  return (
    <div className={`m-adjust${atTop ? ' top' : ''}`} onPointerDown={(e) => e.stopPropagation()}>
      <div className="m-adjust-name">
        <b>{name}</b>
        <small>{fmtPrice(adjust.original)} → {change >= 0 ? '+' : ''}{change.toFixed(2)}%</small>
      </div>
      <input
        type="text"
        inputMode="decimal"
        aria-label="New price"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value.replace(',', '.'));
          if (Number.isFinite(v) && v > 0) {
            typed.current = true;
            onPrice(v);
          }
        }}
      />
      <button className="m-apply" disabled={busy || adjust.price === adjust.original} onClick={onApply}>
        {busy ? '…' : 'Apply'}
      </button>
      <button className="m-x" onClick={onCancel} aria-label="Cancel">×</button>
    </div>
  );
}

const FLOATER_GAP = 14;

/**
 * Where the order box goes: above the highest line of the order so every line stays in view; when that does not leave room for the box it
 * flicks to below the lowest line; when it fits neither way it takes the side with more room and scrolls inside. `h` is the height the box wants.
 */
function floaterStyle(startY: number, tab: HTMLElement | null, bounds: { top: number; bottom: number } | null, h: number): React.CSSProperties {
  const w = tab?.clientWidth ?? 360;
  const th = tab?.clientHeight ?? 600;
  const width = Math.min(FLOATER_W, w - 16);
  const left = Math.max(8, (w - width) / 2);
  const top = bounds?.top ?? startY;
  const bottom = bounds?.bottom ?? startY;
  const above = top - FLOATER_GAP - 4;
  const below = th - bottom - FLOATER_GAP - 4;
  if (above >= h) return { left, width, bottom: th - top + FLOATER_GAP };
  if (below >= h) return { left, width, top: bottom + FLOATER_GAP };
  return above >= below ? { left, width, bottom: th - top + FLOATER_GAP, maxHeight: Math.max(120, above) } : { left, width, top: bottom + FLOATER_GAP, maxHeight: Math.max(120, below) };
}

export function ChartTab() {
  const { symbol, timeframe, openChart, setTimeframe } = useMobile();
  const symbols = useApp((s) => s.symbols);
  const orders = useApp((s) => s.orders);
  const trading = useApp((s) => s.trading);
  const live = useLivePositions();
  const [candles, setCandles] = useState<Kline[]>([]);
  const [query, setQuery] = useState('');
  const [picking, setPicking] = useState(false);
  const [trade, setTrade] = useState<'BUY' | 'SELL' | null>(null);
  // the order box opened by pressing and holding the chart, and the side it is set to (drawn as a line on the chart)
  const floater = useFloater((s) => s.f);
  const tabRef = useRef<HTMLDivElement>(null);
  // where the pending order's line is, in the coordinates of the tab
  const [bounds, setBounds] = useState<{ top: number; bottom: number } | null>(null);
  const [floaterH, setFloaterH] = useState(250);
  const [error, setError] = useState('');
  const toast = useApp((s) => s.toast);
  // an order that is on the exchange and is being moved: double-tap its line, drag the handle, press Apply
  const [adjust, setAdjust] = useState<{ kind: 'sl' | 'tp' | 'order'; order: OpenOrder; price: number; original: number } | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const [tick, setTick] = useState<string | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void api.symbolFilters(symbol).then((f) => alive && setTick(f.tickSize)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [symbol]);

  // history, then live candles
  useEffect(() => {
    let alive = true;
    setCandles([]);
    setError('');
    void api.klines(symbol, timeframe, 300).then((k) => alive && setCandles(k)).catch((e) => alive && setError(String(e)));
    void api.subscribeKlines(symbol, timeframe).catch(() => undefined);
    let off: (() => void) | null = null;
    void onKline((e) => {
      if (!alive || e.symbol !== symbol || e.interval !== timeframe) return;
      setCandles((cur) => {
        if (!cur.length) return cur;
        const last = cur[cur.length - 1];
        if (e.bar.time === last.time) return [...cur.slice(0, -1), e.bar];
        return e.bar.time > last.time ? [...cur.slice(-1999), e.bar] : cur;
      });
    }).then((u) => (alive ? (off = u) : u()));
    return () => {
      alive = false;
      off?.();
      void api.unsubscribeKlines(symbol, timeframe).catch(() => undefined);
    };
  }, [symbol, timeframe]);

  useEffect(() => {
    useFloater.getState().close();
    setBounds(null);
    setAdjust(null);
  }, [symbol, timeframe]);

  const pos = live?.positions.find((p) => p.symbol === symbol && p.amount !== 0);
  const mark = pos?.markPrice || candles[candles.length - 1]?.close || 0;
  const lines = useMemo<ChartLine[]>(() => {
    const out: ChartLine[] = [];
    if (pos) {
      out.push({ price: pos.entryPrice, label: 'entry', color: '#e6e9ef' });
      if (pos.liquidationPrice > 0) out.push({ price: pos.liquidationPrice, label: 'liq', color: '#e0a33d', dashed: true });
      const ex = exitState(symbol, pos.amount, orders);
      if (ex.stop) out.push({ price: ex.stop.stopPrice || ex.stop.price, label: 'SL', color: '#d0454b', dashed: true, adjust: { kind: 'sl', order: ex.stop } });
      if (ex.take) out.push({ price: ex.take.stopPrice || ex.take.price, label: 'TP', color: '#2e9b6f', dashed: true, adjust: { kind: 'tp', order: ex.take } });
    }
    for (const o of orders.filter((o) => o.symbol === symbol)) {
      if (pos && o.reduceOnly) continue;
      out.push({ price: o.stopPrice && !o.price ? o.stopPrice : o.price, label: `${o.side.toLowerCase()} ${o.type.replace(/_/g, ' ').toLowerCase()}`, color: '#5b8def', dashed: true, adjust: { kind: 'order', order: o } });
    }
    // the line being moved is drawn as the pending line instead
    return adjust ? out.filter((l) => !(l.adjust && l.adjust.order.orderId === adjust.order.orderId && l.adjust.order.conditional === adjust.order.conditional)) : out;
  }, [pos, orders, symbol, adjust?.order.orderId]); // eslint-disable-line react-hooks/exhaustive-deps

  // the order being set up: the entry line, and the stop-loss and take-profit lines when their buttons are pressed
  const pendingLines = useMemo<PendingLine[]>(() => {
    if (adjust) {
      const c = adjust.kind === 'sl' ? '#d0454b' : adjust.kind === 'tp' ? '#2e9b6f' : '#5b8def';
      return [{ id: 'adjust', price: adjust.price, label: adjust.kind === 'order' ? 'move order' : `new ${adjust.kind.toUpperCase()}`, color: c, handle: adjust.kind === 'order' ? '⇕' : adjust.kind.toUpperCase() }];
    }
    if (!floater) return [];
    const long = floater.side === 'BUY';
    const out: PendingLine[] = [{ id: 'entry', price: floater.price, label: `${long ? 'buy' : 'sell'} here`, color: long ? '#2e9b6f' : '#d0454b', handle: '⇕' }];
    const ex = resolveBoth(long, floater.price, { on: floater.useSl, text: floater.sl }, { on: floater.useTp, text: floater.tp });
    if (ex.sl?.ok) out.push({ id: 'sl', price: ex.sl.price, label: 'SL', color: '#d0454b', handle: 'SL' });
    if (ex.tp?.ok) out.push({ id: 'tp', price: ex.tp.price, label: 'TP', color: '#2e9b6f', handle: 'TP' });
    return out;
  }, [floater, adjust]);
  const moveLine = (id: string, price: number) => {
    if (id === 'adjust') {
      setAdjust((a) => (a ? { ...a, price: snapToTick(price, tick) } : a));
      return;
    }
    const f = useFloater.getState().f;
    if (!f) return;
    if (id === 'entry') return useFloater.getState().patch({ price });
    // an exit line becomes a percentage of the entry; dragged to the wrong side of the entry it stops at the entry
    const long = f.side === 'BUY';
    const valid = id === 'sl' ? (long ? price < f.price : price > f.price) : long ? price > f.price : price < f.price;
    const text = valid ? pctText(f.price, price) : '0.05%';
    useFloater.getState().patch(id === 'sl' ? { sl: text } : { tp: text });
  };

  /** A double tap near the line of an order that is on the exchange starts moving it. */
  const startAdjust = (price: number, tol: number): boolean => {
    let best: { l: ChartLine; d: number } | null = null;
    for (const l of lines) {
      if (!l.adjust) continue;
      const d = Math.abs(l.price - price);
      if (d <= tol && (!best || d < best.d)) best = { l, d };
    }
    if (!best?.l.adjust) return false;
    useFloater.getState().close();
    const a = best.l.adjust;
    setAdjust({ kind: a.kind, order: a.order, price: best.l.price, original: best.l.price });
    return true;
  };

  const applyAdjust = async () => {
    if (!adjust || adjusting) return;
    const { order: o, kind } = adjust;
    const price = snapToTick(adjust.price, tick);
    if (kind !== 'order' && pos) {
      const res = resolveExit(kind === 'sl' ? 'stop' : 'take', pos.amount > 0, mark, { kind: 'price', value: price });
      if (!res.ok) {
        toast(res.error, 'warn');
        return;
      }
    }
    setAdjusting(true);
    try {
      if (o.type === 'LIMIT') await api.modifyOrder(symbol, o.orderId, false, price);
      else if (o.type === 'STOP') await api.modifyOrder(symbol, o.orderId, o.conditional, o.price + (price - o.stopPrice), price);
      else await api.modifyOrder(symbol, o.orderId, o.conditional, undefined, price);
      toast(`${symbol}: ${kind === 'order' ? 'order' : kind === 'sl' ? 'stop-loss' : 'take-profit'} moved to ${fmtPrice(price)}`, 'info');
      void refreshTrading();
      setAdjust(null);
    } catch (e) {
      toast(`Could not move it: ${e}`, 'warn');
    } finally {
      setAdjusting(false);
    }
  };

  // the order being moved is gone (filled or cancelled elsewhere): stop adjusting
  useEffect(() => {
    if (adjust && !orders.some((o) => o.orderId === adjust.order.orderId && o.conditional === adjust.order.conditional)) setAdjust(null);
  }, [orders, adjust]);

  const matches = useMemo(() => {
    const q = query.trim().toUpperCase();
    return [...symbols].filter((s) => !q || s.symbol.includes(q)).sort((a, b) => b.volume24hQuote - a.volume24hQuote).slice(0, 40);
  }, [symbols, query]);

  return (
    <div className="m-chart-tab" ref={tabRef}>
      <div className="m-chart-head">
        <button className="m-symbol" onClick={() => setPicking((v) => !v)}>
          {coin(symbol)} <small>▾</small>
        </button>
        <b className="m-last">{mark ? fmtPrice(mark) : ''}</b>
        {pos && <span className={`m-pnl ${tone(pos.unrealizedPnl)}`}>{signed(pos.unrealizedPnl)}</span>}
      </div>
      {picking && (
        <div className="m-picker">
          <input autoFocus placeholder="Search a symbol" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="m-picker-list">
            {matches.map((s) => (
              <button key={s.symbol} onClick={() => { openChart(s.symbol); setPicking(false); setQuery(''); }}>
                <b>{coin(s.symbol)}</b>
                <span>{fmtPrice(s.lastPrice)}</span>
                <span className={s.changePercent24h >= 0 ? 'up' : 'down'}>{s.changePercent24h.toFixed(1)}%</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="m-tfs">
        {TIMEFRAMES.map((tf) => (
          <button key={tf} className={tf === timeframe ? 'on' : ''} onClick={() => setTimeframe(tf)}>
            {tf}
          </button>
        ))}
      </div>
      {error ? <div className="m-warn">{error}</div> : <MobileChart
          candles={candles}
          lines={lines}
          pending={pendingLines}
          onPendingMove={moveLine}
          onPendingBounds={(top, bottom) => {
            const t = tabRef.current?.getBoundingClientRect().top ?? 0;
            setBounds({ top: top - t, bottom: bottom - t });
          }}
          onTap={() => useFloater.getState().close()}
          onDoubleTap={({ price, tol }) => startAdjust(price, tol)}
          onLongPress={(p) => {
            const rect = tabRef.current?.getBoundingClientRect();
            if (!rect || !trading?.hasCredentials || !(mark > 0)) return;
            setPicking(false);
            setAdjust(null);
            useFloater.getState().open(p.price, sideFor(p.price, mark), p.y - rect.top);
          }}
        />}
      <div className="m-trade-bar">
        <button className="m-buy" disabled={!trading?.hasCredentials || !(mark > 0)} onClick={() => setTrade('BUY')}>Long</button>
        <button className="m-sell" disabled={!trading?.hasCredentials || !(mark > 0)} onClick={() => setTrade('SELL')}>Short</button>
      </div>
      {floater && (
        <OrderFloater
          key={floater.id}
          symbol={symbol}
          mark={mark}
          onClose={() => useFloater.getState().close()}
          onHeight={(h) => setFloaterH((cur) => (Math.abs(cur - h) > 1 ? h : cur))}
          style={floaterStyle(floater.y, tabRef.current, bounds, floaterH)}
        />
      )}
      {adjust && (
        <AdjustBar
          adjust={adjust}
          busy={adjusting}
          atTop={bounds != null && bounds.top > (tabRef.current?.clientHeight ?? 600) * 0.5}
          onPrice={(price) => setAdjust((a) => (a ? { ...a, price } : a))}
          onApply={() => void applyAdjust()}
          onCancel={() => setAdjust(null)}
        />
      )}
      {trade && <TradeSheet side={trade} symbol={symbol} mark={mark} onClose={() => setTrade(null)} />}
    </div>
  );
}
