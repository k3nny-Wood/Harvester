import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Vela } from '@luxalgo/vela';
import { api } from '../api';
import { useChart, useChartId } from '../chartStore';
import { formatPrice, snapToTick } from '../ladderMath';
import { useApp } from '../store';
import { orderFromForm, refreshTrading, submitOrder } from '../trade';
import { getProjector } from './projector';

interface Line {
  key: string;
  y: number;
  color: string;
  label: string;
  orderId?: number;
  conditional?: boolean;
  dashed: boolean;
  /** the price is above (up) or below (down) the visible range: drawn at that edge with an arrow */
  pinned?: 'up' | 'down';
  price?: number;
}

interface MenuState {
  x: number;
  y: number;
  price: number;
}

const BUY = '#2e9b6f';
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
  const account = useApp((s) => s.account);
  const trading = useApp((s) => s.trading);
  const patchForm = useApp((s) => s.patchOrderForm);
  const toast = useApp((s) => s.toast);
  const rootRef = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const precision = filters?.pricePrecision ?? 2;
  const canTrade = !!trading?.hasCredentials;

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
      const p = o.price || o.stopPrice;
      const at = p ? place(p) : null;
      if (!at) continue;
      lines.push({
        key: `o${o.orderId}`,
        y: at.y,
        pinned: at.pinned,
        price: p,
        color: o.side === 'BUY' ? BUY : SELL,
        label: `${at.pinned === 'up' ? '▲ ' : at.pinned === 'down' ? '▼ ' : ''}${o.side} ${o.type.replace(/_/g, ' ')} ${o.origQty} @ ${formatPrice(p, precision)}${o.conditional && o.price ? ` (trigger ${formatPrice(o.stopPrice, precision)})` : ''}`,
        orderId: o.orderId,
        conditional: o.conditional,
        dashed: o.type !== 'LIMIT',
      });
    }
    const pos = account?.positions.find((p) => p.symbol === symbol);
    if (pos) {
      const ye = yOf(pos.entryPrice);
      if (ye != null) lines.push({ key: 'pos', y: ye, color: '#3b8fd6', label: `${pos.amount > 0 ? 'LONG' : 'SHORT'} ${pos.amount} @ ${formatPrice(pos.entryPrice, precision)}  P&L ${pos.unrealizedPnl.toFixed(2)}`, dashed: false });
      const yl = pos.liquidationPrice > 0 ? yOf(pos.liquidationPrice) : null;
      if (yl != null) lines.push({ key: 'liq', y: yl, color: '#e0a33d', label: `LIQ ${formatPrice(pos.liquidationPrice, precision)}`, dashed: true });
    }
  }
  const plotW = info?.proj.width ?? 0;
  const offX = info && root ? info.plotRect.left - root.getBoundingClientRect().left : 0;

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
        {lines.map((l) => (
          <g key={l.key}>
            <line x1={offX} x2={offX + plotW} y1={l.y} y2={l.y} stroke={l.color} strokeWidth={l.pinned ? 0.8 : 1.2} strokeDasharray={l.pinned ? '2 5' : l.dashed ? '5 4' : undefined} opacity={l.pinned ? 0.55 : 0.9} />
            <text x={l.pinned ? offX + plotW - 90 : offX + 8} y={l.y - 4} textAnchor={l.pinned ? 'end' : 'start'} className="trade-label" fill={l.color}>
              {l.label}
            </text>
            {l.orderId != null && (
              <g
                className="cancel-x"
                transform={`translate(${offX + plotW - 70}, ${l.y})`}
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

      {menu && (
        <div className="ctx-menu" style={{ left: menu.x + 4, top: menu.y + 4 }} onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
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
          <div className="ctx-note">Size comes from the Orders panel.</div>
        </div>
      )}
      <span hidden>{chartId}</span>
    </div>
  );
}
