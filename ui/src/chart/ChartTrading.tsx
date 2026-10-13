import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Vela } from '@luxalgo/vela';
import { api } from '../api';
import type { OpenOrder } from '../types';
import { useChart, useChartId } from '../chartStore';
import { formatPrice, snapToTick } from '../ladderMath';
import { useApp } from '../store';
import { priceBand } from '../priceBand';
import { fitMenu, type MenuPlacement } from '../menuFit';
import { closeOrder, maxPct, notionalOfForm, pctFromNotional, sizeFromPct } from '../sizing';
import { useLiveMarks } from '../liveMarks';
import { orderFromForm, refreshTrading, submitOrder } from '../trade';
import { AddSizeModal, type AddSizeTarget } from '../components/AddSizeModal';
import { orderTag } from './lineTags';
import { getProjector } from './projector';

/** Width of the box at the right end of a line: its name, and the handle to drag the order with. */
const TAG_W = 104;

interface Line {
  key: string;
  /** the box's text: what this line is */
  tag?: string;
  /** colour of the box's text when it differs from the line's (the position: green in profit, red in loss) */
  textColor?: string;
  y: number;
  color: string;
  label: string;
  orderId?: number;
  /** a limit order kept on this computer (not on the exchange yet) */
  heldId?: string;
  conditional?: boolean;
  dashed: boolean;
  /** the price is above (up) or below (down) the visible range: drawn at that edge with an arrow */
  pinned?: 'up' | 'down';
  price?: number;
  dragging?: boolean;
}

interface MenuState {
  x: number;
  y: number;
  price: number;
}

interface DragState {
  /** an order on the exchange (0 for a held one) */
  orderId: number;
  /** a limit order kept on this computer: moving it only changes what will be sent later */
  heldId?: string;
  conditional: boolean;
  /** price of the line when it was picked up */
  from: number;
  /** price under the pointer now */
  to: number;
}

const BUY = '#2e9b6f';
/** the position's own line across the chart */
const POSITION_LINE = '#6cc4ff';
const SELL = '#d0454b';

/**
 * Trading on the chart: the symbol's open orders, position entry and liquidation drawn as lines (orders have an x to cancel),
 * and a right-click menu to place an order or start a ladder at the price under the pointer.
 */
export function ChartTrading({ chart, host }: { chart: Vela | null; host: RefObject<HTMLDivElement | null> }) {
  const chartId = useChartId();
  const symbol = useChart((s) => s.symbol);
  const filters = useChart((s) => s.filters);
  const patchLadder = useChart((s) => s.patchLadder);
  const orders = useApp((s) => s.orders);
  const held = useApp((s) => s.held);
  const account = useApp((s) => s.account);
  const liveMark = useLiveMarks([symbol])[symbol];
  const trading = useApp((s) => s.trading);
  const patchForm = useApp((s) => s.patchOrderForm);
  const toast = useApp((s) => s.toast);
  const rootRef = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [sizeModal, setSizeModal] = useState<AddSizeTarget | null>(null);
  const mark = useChart((s) => s.markPrice);
  const precision = filters?.pricePrecision ?? 2;
  const canTrade = !!trading?.hasCredentials;
  const band = filters ? priceBand(mark, filters.multiplierDown, filters.multiplierUp, filters.tickSize) : null;

  useEffect(() => {
    if (!chart) return;
    const bump = () => setTick((t) => t + 1);
    const offs = [chart.on('viewport:changed', bump), chart.on('pane:changed', bump)];
    const ro = new ResizeObserver(bump);
    if (host.current) ro.observe(host.current);
    const timer = window.setInterval(bump, 500);
    return () => {
      offs.forEach((o) => typeof o === 'function' && o());
      ro.disconnect();
      window.clearInterval(timer);
    };
  }, [chart, host]);

  const priceAt = useCallback(
    (clientY: number): number | null => {
      if (!chart) return null;
      const info = getProjector(chart);
      if (!info) return null;
      return snapToTick(info.proj.pxToPoint(0, clientY - info.plotRect.top, 'price').price, filters?.tickSize);
    },
    [chart, filters?.tickSize],
  );

  // Right-click on the chart opens the order menu at that price.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      const price = priceAt(e.clientY);
      const root = rootRef.current;
      if (price == null || !root) return;
      const r = root.getBoundingClientRect();
      setMenu({ x: e.clientX - r.left, y: e.clientY - r.top, price });
    };
    const close = () => setMenu(null);
    el.addEventListener('contextmenu', onContext);
    el.addEventListener('pointerdown', close);
    window.addEventListener('keydown', (e) => e.key === 'Escape' && close());
    return () => {
      el.removeEventListener('contextmenu', onContext);
      el.removeEventListener('pointerdown', close);
    };
  }, [host, priceAt]);

  const lines: Line[] = [];
  const info = chart ? getProjector(chart) : null;
  const root = rootRef.current;
  if (info && root) {
    const rect = root.getBoundingClientRect();
    const offY = info.plotRect.top - rect.top;
    const topPrice = info.proj.pxToPoint(0, 0, 'price').price;
    const bottomPrice = info.proj.pxToPoint(0, info.proj.height, 'price').price;
    const pinnedCount = { up: 0, down: 0 };
    /** y of a price inside the plot; for a price outside the visible range, a stacked slot at the nearest edge. */
    const place = (p: number): { y: number; pinned?: 'up' | 'down' } | null => {
      if (p > topPrice) return { y: offY + 12 + 18 * pinnedCount.up++, pinned: 'up' };
      if (p < bottomPrice) return { y: offY + info.proj.height - 12 - 18 * pinnedCount.down++, pinned: 'down' };
      const y = info.proj.yOf(p, 'price');
      return y == null ? null : { y: offY + y };
    };
    const yOf = (p: number) => place(p)?.y ?? null;
    for (const o of orders.filter((o) => o.symbol === symbol)) {
      const dragging = drag && drag.orderId === o.orderId && drag.conditional === o.conditional ? drag : null;
      const p = dragging ? dragging.to : o.price || o.stopPrice;
      const at = p ? place(p) : null;
      if (!at) continue;
      lines.push({
        key: `o${o.orderId}`,
        tag: orderTag(o),
        y: at.y,
        pinned: at.pinned,
        price: p,
        color: o.side === 'BUY' ? BUY : SELL,
        label: dragging
          ? `${o.side} ${o.type.replace(/_/g, ' ')} ${o.origQty} → ${formatPrice(p, precision)}${mark > 0 ? `  (${((p / mark - 1) * 100).toFixed(2)}% from last)` : ''}  · ${!o.conditional && band && (p > band.high || p < band.low) ? 'beyond Binance\'s range: release to hold it here instead' : 'release to move'}`
          : `${at.pinned === 'up' ? '▲ ' : at.pinned === 'down' ? '▼ ' : ''}${o.side} ${o.type.replace(/_/g, ' ')} ${o.origQty} @ ${formatPrice(p, precision)}${o.conditional && o.price ? ` (trigger ${formatPrice(o.stopPrice, precision)})` : ''}`,
        orderId: o.orderId,
        conditional: o.conditional,
        dashed: o.type !== 'LIMIT' && !dragging,
        dragging: !!dragging,
      });
    }
    // limit orders waiting on this computer for Binance's price band to reach them
    for (const h of held.filter((x) => x.status === 'held' && x.request.symbol === symbol)) {
      const dragging = drag && drag.heldId === h.id ? drag : null;
      const hp = dragging ? dragging.to : (h.request.price ?? 0);
      const at = hp ? place(hp) : null;
      if (!at) continue;
      lines.push({
        key: `h${h.id}`,
        tag: `HELD ${h.request.side} LIMIT`,
        y: at.y,
        pinned: at.pinned,
        price: hp,
        color: '#9aa7b8',
        label: dragging
          ? `HELD ${h.request.side} LIMIT ${h.request.quantity} → ${formatPrice(hp, precision)}${mark > 0 ? `  (${((hp / mark - 1) * 100).toFixed(2)}% from last)` : ''}  · release to move`
          : `${at.pinned === 'up' ? '▲ ' : at.pinned === 'down' ? '▼ ' : ''}HELD ${h.request.side} LIMIT ${h.request.quantity} @ ${formatPrice(hp, precision)} · sent when Binance allows it`,
        heldId: h.id,
        dashed: true,
        dragging: !!dragging,
      });
    }
    const pos = account?.positions.find((p) => p.symbol === symbol);
    if (pos) {
      const ye = yOf(pos.entryPrice);
      // Binance's mark price and the profit it implies, with the return on the position's initial margin
      const pnl = liveMark ? pos.amount * (liveMark - pos.entryPrice) : pos.unrealizedPnl;
      const lv = pos.leverage || account?.leverages?.[symbol] || 0;
      const initial = lv > 0 ? (Math.abs(pos.amount) * pos.entryPrice) / lv : 0;
      const roe = initial > 0 ? `  ROE ${pnl >= 0 ? '+' : ''}${((pnl / initial) * 100).toFixed(2)}%` : '';
      // green while in profit, red in a loss; the box shows the return on the position's margin (price change when the leverage is unknown)
      const pct = initial > 0 ? (pnl / initial) * 100 : pos.entryPrice > 0 ? ((liveMark ?? pos.markPrice) / pos.entryPrice - 1) * 100 * (pos.amount > 0 ? 1 : -1) : 0;
      if (ye != null) lines.push({ key: 'pos', tag: `${pos.amount > 0 ? 'LONG' : 'SHORT'} ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`, y: ye, color: POSITION_LINE, textColor: pnl >= 0 ? BUY : SELL, label: `${pos.amount > 0 ? 'LONG' : 'SHORT'} ${pos.amount} @ ${formatPrice(pos.entryPrice, precision)}  PNL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}${roe}`, dashed: false });
      const yl = pos.liquidationPrice > 0 ? yOf(pos.liquidationPrice) : null;
      if (yl != null) lines.push({ key: 'liq', tag: 'LIQUIDATION', y: yl, color: '#e0a33d', label: `LIQ ${formatPrice(pos.liquidationPrice, precision)}`, dashed: true });
    }
  }
  // the parts of the chart where a limit order would be refused (percent-price band), as shaded zones with the edge price
  const zones: Array<{ y: number; h: number; label: string; edgeY: number }> = [];
  if (info && root && band) {
    const rect = root.getBoundingClientRect();
    const offY = info.plotRect.top - rect.top;
    const topP = info.proj.pxToPoint(0, 0, 'price').price;
    const botP = info.proj.pxToPoint(0, info.proj.height, 'price').price;
    if (band.high < topP) {
      const edge = Math.max(0, info.proj.yOf(band.high, 'price') ?? 0);
      zones.push({ y: offY, h: edge, edgeY: offY + edge, label: `limit orders above ${formatPrice(band.high, precision)} are held here until price comes closer` });
    }
    if (band.low > botP) {
      const edge = Math.min(info.proj.height, info.proj.yOf(band.low, 'price') ?? info.proj.height);
      zones.push({ y: offY + edge, h: info.proj.height - edge, edgeY: offY + edge, label: `limit orders below ${formatPrice(band.low, precision)} are held here until price comes closer` });
    }
  }
  const plotW = info?.proj.width ?? 0;
  const offX = info && root ? info.plotRect.left - root.getBoundingClientRect().left : 0;

  /** Press on an order line: the line follows the pointer; releasing the button moves the order on the exchange. */
  const startDrag = (e: React.PointerEvent, l: Line) => {
    if ((l.orderId == null && l.heldId == null) || l.pinned || !l.price) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setMenu(null);
    setDrag({ orderId: l.orderId ?? 0, heldId: l.heldId, conditional: !!l.conditional, from: l.price, to: l.price });
  };
  const moveDrag = (e: React.PointerEvent) => {
    if (!drag) return;
    const raw = priceAt(e.clientY);
    if (raw == null || raw <= 0) return;
    // a held order lives on this computer, so it may be dragged anywhere, also outside the band
    if (drag.heldId) {
      setDrag({ ...drag, to: raw });
      return;
    }
    // a limit order can be dragged anywhere: beyond Binance's range it is cancelled there and kept here instead (a held order)
    setDrag({ ...drag, to: raw });
  };
  const endDrag = async (e: React.PointerEvent, fromTag = false) => {
    const d = drag;
    if (!d) return;
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    setDrag(null);
    if (d.to === d.from) {
      // a click on the box without dragging: open the size dialog of that order
      if (fromTag && !d.heldId) {
        const o = useApp.getState().orders.find((x) => x.orderId === d.orderId && x.conditional === d.conditional);
        if (o) setSizeModal({ kind: 'order', symbol: o.symbol, side: o.side, orderId: o.orderId, conditional: o.conditional, type: o.type, price: o.price || o.stopPrice, qty: o.origQty, reduceOnly: o.reduceOnly });
      }
      return;
    }
    if (d.heldId) {
      // show the new price at once; the saved copy on disk follows
      const app = useApp.getState();
      app.setHeld(app.held.map((x) => (x.id === d.heldId ? { ...x, request: { ...x.request, price: d.to } } : x)));
      try {
        await api.heldMove(d.heldId, d.to);
        toast(`Moved the held order to ${formatPrice(d.to, precision)}. It is sent when Binance's range reaches it.`, 'info');
      } catch (err) {
        toast(`Could not move the held order: ${err}`, 'warn');
      }
      void refreshTrading();
      return;
    }
    const o: OpenOrder | undefined = useApp.getState().orders.find((x) => x.orderId === d.orderId && x.conditional === d.conditional);
    if (!o) return;
    // beyond the exchange's range: cancel it on Binance and keep it on this computer until the range reaches it
    if (!o.conditional && band && (d.to > band.high || d.to < band.low)) {
      try {
        const ack = await api.moveToHeld(o.symbol, o.orderId, d.to);
        toast(`Moved ${o.side} LIMIT to ${formatPrice(ack.price ?? d.to, precision)}: it was cancelled on Binance and is held on this computer until the price comes within range (Harvester must be open).`, 'info');
      } catch (err) {
        toast(`Could not hold the order: ${err}`, 'warn');
      }
      void refreshTrading();
      return;
    }
    const delta = d.to - (o.price || o.stopPrice);
    const price = o.conditional ? (o.price ? o.price + delta : undefined) : d.to;
    const stopPrice = o.conditional ? o.stopPrice + delta : undefined;
    // show the new price at once so the line does not jump back while the exchange answers
    useApp.getState().setOrders(useApp.getState().orders.map((x) => (x === o ? { ...x, price: price ?? x.price, stopPrice: stopPrice ?? x.stopPrice } : x)));
    try {
      const ack = await api.modifyOrder(o.symbol, o.orderId, o.conditional, price, stopPrice);
      toast(`Moved ${o.side} ${o.type.replace(/_/g, ' ')} to ${formatPrice(ack.price ?? d.to, precision)}`, 'info');
    } catch (err) {
      toast(`Could not move the order: ${err}`, 'warn');
    }
    void refreshTrading();
  };
  useEffect(() => {
    if (!drag) return;
    const esc = (ev: KeyboardEvent) => ev.key === 'Escape' && setDrag(null);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [drag]);

  // order size as the right-click menu shows it, kept in the shared order form so the Orders panel agrees
  const form = useApp((s) => s.orderForm);
  const wallet = account?.walletBalance ?? 0;
  const lev = Number(form.leverage) || 1;
  const cap = trading?.maxOrderNotional ?? 0;
  const notional = notionalOfForm(form.sizeMode, Number(form.size), menu?.price ?? mark, account?.availableBalance ?? 0, lev);
  const sizePct = pctFromNotional(notional, wallet, lev);
  const sliderMax = maxPct(wallet, lev, cap);
  const margin = notional / Math.max(1, lev);
  const overCap = cap > 0 && notional > cap;
  // leverage of this symbol: read when the menu first opens for it, set on the exchange when the slider is released (like the Orders panel)
  const [maxLev, setMaxLev] = useState(20);
  const levLoaded = useRef('');
  useEffect(() => {
    if (!menu || !canTrade || levLoaded.current === symbol) return;
    levLoaded.current = symbol;
    api
      .symbolLeverage(symbol)
      .then((l) => {
        setMaxLev(Math.max(1, l.maxLeverage));
        patchForm({ leverage: String(l.leverage) });
      })
      .catch(() => undefined);
  }, [menu, canTrade, symbol, patchForm]);
  const commitLeverage = async () => {
    const want = Number(useApp.getState().orderForm.leverage);
    if (!(want >= 1)) return;
    try {
      await api.setLeverage(symbol, want);
      toast(`${symbol} leverage set to ${want}x`, 'info');
    } catch (e) {
      toast(`Leverage: ${e}`, 'warn');
    }
  };
  const setSizeFromPct = (pct: number) => patchForm({ sizeMode: 'usdt', size: sizeFromPct(pct, wallet, lev).notional.toFixed(2) });

  // holdings: close a share of the position with a reduce-only limit order at the clicked price (sell a long, buy back a short)
  const [closePct, setClosePct] = useState(50);
  const holding = account?.positions.find((p) => p.symbol === symbol && p.amount !== 0);
  const closing = holding ? closeOrder(holding.amount, closePct, Number(filters?.stepSize) || 0) : null;
  const closeAt = async (price: number) => {
    if (!holding || !closing) return;
    setMenu(null);
    const env = useApp.getState().env;
    const verb = closing.side === 'SELL' ? 'Sell' : 'Buy back';
    await submitOrder(
      { symbol, side: closing.side, type: 'LIMIT', quantity: closing.quantity, price, reduceOnly: true },
      `${env === 'live' ? 'LIVE ORDER - real money.\n\n' : ''}${verb} ${closing.quantity.toFixed(filters?.quantityPrecision ?? 3)} ${symbol} (${closePct}% of your ${holding.amount > 0 ? 'long' : 'short'}) @ ${formatPrice(price, precision)}\nReduce-only limit, about ${(closing.quantity * price).toFixed(2)} USDT. Place it?`,
    );
  };

  // keep the whole menu inside the chart: opened near the bottom or the right edge it is moved up / left (below the chart it would hide
  // under the next panel). Measured before the browser paints, so it never flashes in the wrong place.
  const menuRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  useLayoutEffect(() => {
    const el = menuRef.current;
    const box = rootRef.current;
    if (!menu || !el || !box) {
      setPlacement(null);
      return;
    }
    // measure at the natural size: take any earlier height cap off for the reading
    const prev = el.style.maxHeight;
    el.style.maxHeight = '';
    const next = fitMenu(menu.x + 4, menu.y + 4, el.offsetWidth, el.offsetHeight, box.clientWidth, box.clientHeight);
    el.style.maxHeight = prev;
    setPlacement((p) => (p && p.left === next.left && p.top === next.top && p.maxHeight === next.maxHeight ? p : next));
  }, [menu, holding, overCap, maxLev, closing?.quantity]);

  const placeAt = async (side: 'BUY' | 'SELL', price: number) => {
    setMenu(null);
    const built = orderFromForm(price, side);
    if (typeof built === 'string') return toast(built, 'warn');
    const { order, notional } = built;
    const env = useApp.getState().env;
    await submitOrder(order, `${env === 'live' ? 'LIVE ORDER - real money.\n\n' : ''}${side} LIMIT ${order.quantity.toFixed(filters?.quantityPrecision ?? 3)} ${symbol} @ ${formatPrice(price, precision)}\n≈ ${notional.toFixed(2)} USDT. Place it?`);
  };

  return (
    <div ref={rootRef} className="trade-layer">
      <svg className="trade-svg">
        {zones.map((z, i) => (
          <g key={`z${i}`} className="band-zone">
            <rect x={offX} y={z.y} width={plotW} height={Math.max(0, z.h)} />
            <line x1={offX} x2={offX + plotW} y1={z.edgeY} y2={z.edgeY} />
            <text x={offX + plotW - 90} y={i === 0 ? z.edgeY - 4 : z.edgeY + 12} textAnchor="end">
              {z.label}
            </text>
          </g>
        ))}
        {lines.map((l) => (
          <g key={l.key}>
            <line x1={offX} x2={offX + plotW} y1={l.y} y2={l.y} stroke={l.color} strokeWidth={l.dragging ? 2.4 : l.pinned ? 0.8 : 1.2} strokeDasharray={l.pinned ? '2 5' : l.dashed ? '5 4' : undefined} opacity={l.pinned ? 0.55 : 0.9} />
            {(l.orderId != null || l.heldId != null) && !l.pinned && (
              <line
                className="order-hit"
                x1={offX}
                x2={offX + plotW - TAG_W - 30}
                y1={l.y}
                y2={l.y}
                stroke="transparent"
                strokeWidth={14}
                onPointerDown={(e) => startDrag(e, l)}
                onPointerMove={moveDrag}
                onPointerUp={(e) => void endDrag(e)}
                onPointerCancel={() => setDrag(null)}
              >
                <title>{l.heldId != null ? 'Drag to move this held order (it is kept on this computer)' : 'Drag to move this order'}</title>
              </line>
            )}
            {l.tag && (
              <g
                className={l.orderId != null || l.heldId != null ? 'line-tag drag' : 'line-tag'}
                onClick={() => {
                  if (l.key !== 'pos') return;
                  const p = account?.positions.find((x) => x.symbol === symbol && x.amount !== 0);
                  if (p) setSizeModal({ kind: 'position', symbol, amount: p.amount, mark: liveMark ?? p.markPrice });
                }}
                transform={`translate(${offX + plotW - TAG_W - 2}, ${l.y - 9})`}
                onPointerDown={(e) => startDrag(e, l)}
                onPointerMove={moveDrag}
                onPointerUp={(e) => void endDrag(e, true)}
                onPointerCancel={() => setDrag(null)}
              >
                <rect width={TAG_W} height={18} rx={3} fill="#0f1620" fillOpacity={0.45} stroke={l.key === 'pos' ? '#ffffff' : l.color} strokeWidth={l.key === 'pos' ? 1.5 : l.dragging ? 2 : 1} />
                <text x={TAG_W / 2} y={12.5} textAnchor="middle" fill={l.textColor ?? l.color}>
                  {l.tag}
                </text>
                <title>{l.orderId != null || l.heldId != null ? 'Grab to move this order up or down' : l.tag}</title>
              </g>
            )}
            <text x={l.pinned ? offX + plotW - TAG_W - 8 : offX + 8} y={l.y - 4} textAnchor={l.pinned ? 'end' : 'start'} className="trade-label" fill={l.color}>
              {l.label}
            </text>
            {l.heldId != null && (
              <g
                className="cancel-x"
                transform={`translate(${offX + plotW - TAG_W - 16}, ${l.y})`}
                onClick={() =>
                  void api
                    .heldCancel(l.heldId!)
                    .then(() => refreshTrading())
                    .catch((e) => toast(`Cancel: ${e}`, 'warn'))
                }
              >
                <title>Cancel this held order (it was never sent to Binance)</title>
                <circle r={8} fill="#0f1620" stroke={l.color} />
                <text textAnchor="middle" y={4} fill={l.color} fontSize={12}>
                  ×
                </text>
              </g>
            )}
            {l.orderId != null && (
              <g
                className="cancel-x"
                transform={`translate(${offX + plotW - TAG_W - 16}, ${l.y})`}
                onClick={() =>
                  void api
                    .cancelOrder(symbol, l.orderId!, l.conditional)
                    .then(() => refreshTrading())
                    .catch((e) => toast(`Cancel: ${e}`, 'warn'))
                }
              >
                <title>Cancel this order</title>
                <circle r={8} fill="#0f1620" stroke={l.color} />
                <text textAnchor="middle" y={4} fill={l.color} fontSize={12}>
                  ×
                </text>
              </g>
            )}
          </g>
        ))}
      </svg>
      {sizeModal && <AddSizeModal target={sizeModal} onClose={() => setSizeModal(null)} />}

      {menu && (
        <div ref={menuRef} className="ctx-menu" style={{ left: placement?.left ?? menu.x + 4, top: placement?.top ?? menu.y + 4, maxHeight: placement?.maxHeight, overflowY: 'auto' }} onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
          <div className="ctx-title">
            {symbol} @ {formatPrice(menu.price, precision)}
          </div>
          <button disabled={!canTrade} title={canTrade ? '' : trading?.message} onClick={() => void placeAt('BUY', menu.price)}>
            <span className="up">▲</span> Buy limit here
          </button>
          <button disabled={!canTrade} title={canTrade ? '' : trading?.message} onClick={() => void placeAt('SELL', menu.price)}>
            <span className="down">▼</span> Sell limit here
          </button>
          <button
            onClick={() => {
              patchLadder({ phase: 'end', x: menu.x, startPrice: menu.price, endPrice: menu.price, preview: null });
              setMenu(null);
            }}
          >
            ☰ Start a ladder from here
          </button>
          <button
            onClick={() => {
              patchForm({ type: 'LIMIT', price: String(menu.price) });
              setMenu(null);
              toast(`Order form price set to ${formatPrice(menu.price, precision)}`, 'info');
            }}
          >
            ✎ Use this price in the order form
          </button>
          {holding && closing && (
            <div className="ctx-size ctx-close">
              <div className="ctx-size-row">
                <span>Close</span>
                <b>
                  {closePct}% of your {holding.amount > 0 ? 'long' : 'short'}
                </b>
              </div>
              <input type="range" min={5} max={100} step={5} value={closePct} onChange={(e) => setClosePct(Number(e.target.value))} title="Share of the position this order closes" />
              <div className="ctx-size-row muted">
                <span>
                  {closing.side === 'SELL' ? 'sells' : 'buys back'} {closing.quantity.toFixed(filters?.quantityPrecision ?? 3)} of {Math.abs(holding.amount)}
                </span>
                <span>≈ ${(closing.quantity * menu.price).toFixed(2)}</span>
              </div>
              <button disabled={!canTrade} title={canTrade ? 'Reduce-only limit order at this price' : trading?.message} onClick={() => void closeAt(menu.price)}>
                <span className={closing.side === 'SELL' ? 'down' : 'up'}>{closing.side === 'SELL' ? '▼' : '▲'}</span> {closing.side === 'SELL' ? 'Sell' : 'Buy back'} {closePct}% of holdings here
              </button>
            </div>
          )}
          <div className="ctx-size">
            <div className="ctx-size-row">
              <span>Size</span>
              <b>{sizePct.toFixed(1)}% of account</b>
            </div>
            <input type="range" min={0} max={sliderMax} step={0.5} value={Math.min(sizePct, sliderMax)} disabled={!(wallet > 0)} title={wallet > 0 ? 'Share of the account used as margin' : 'No account balance yet'} onChange={(e) => setSizeFromPct(Number(e.target.value))} />
            <div className="ctx-size-row muted">
              <span>
                margin {margin.toFixed(2)} · {lev}x
              </span>
              <label className="ctx-dollar">
                position $
                <input type="number" min={0} step={10} value={Number(notional.toFixed(2))} onChange={(e) => patchForm({ sizeMode: 'usdt', size: String(Math.max(0, Number(e.target.value) || 0)) })} />
              </label>
            </div>
            <div className="ctx-size-row">
              <span>Leverage</span>
              <b>{lev}x</b>
            </div>
            <input
              type="range"
              min={1}
              max={maxLev}
              step={1}
              value={Math.min(lev, maxLev)}
              disabled={!canTrade}
              title={canTrade ? `Up to ${maxLev}x for ${symbol}; applied to the symbol when you release the slider` : 'No API keys'}
              onChange={(e) => patchForm({ leverage: String(Math.round(Number(e.target.value))) })}
              onPointerUp={() => void commitLeverage()}
              onKeyUp={() => void commitLeverage()}
            />
            {overCap && <div className="warn">Above the safety cap of {cap.toFixed(0)} USDT per order.</div>}
          </div>
        </div>
      )}
      <span hidden>{chartId}</span>
    </div>
  );
}
