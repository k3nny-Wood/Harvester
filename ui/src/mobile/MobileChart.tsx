import { useEffect, useRef, useState } from 'react';
import type { Kline } from '../types';
import { fmtPrice, priceRange, windowOf, zoomed, type ChartLine } from './chartMath';

const UP = '#2e9b6f';
const DOWN = '#d0454b';
const AXIS_W = 62;
const DEFAULT_VISIBLE = 70;

/**
 * A small candlestick chart for the phone: drag to pan, pinch to zoom, double-tap to jump back to the newest candle. Horizontal lines mark the
 * position's entry, stop-loss, take-profit and liquidation and the open orders.
 */
export function MobileChart({ candles, lines }: { candles: Kline[]; lines: ChartLine[] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 320, h: 300 });
  const [view, setView] = useState({ visible: DEFAULT_VISIBLE, offset: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ visible: number; offset: number; x: number; dist: number } | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: Math.max(100, el.clientWidth), h: Math.max(100, el.clientHeight) }));
    ro.observe(el);
    setSize({ w: Math.max(100, el.clientWidth), h: Math.max(100, el.clientHeight) });
    return () => ro.disconnect();
  }, []);

  const win = windowOf(candles.length, view.visible, view.offset);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0b0f15';
    g.fillRect(0, 0, size.w, size.h);
    const shown = candles.slice(win.start, win.end);
    const range = priceRange(shown, lines);
    if (!range || !shown.length) {
      g.fillStyle = '#8b98a5';
      g.font = '13px system-ui, sans-serif';
      g.fillText('Loading…', 12, 24);
      return;
    }
    const plotW = size.w - AXIS_W;
    const y = (p: number) => ((range.hi - p) / (range.hi - range.lo)) * (size.h - 4) + 2;
    // grid and the price axis
    g.font = '11px system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const p = range.lo + ((range.hi - range.lo) * i) / 4;
      g.strokeStyle = '#1a2230';
      g.beginPath();
      g.moveTo(0, y(p));
      g.lineTo(plotW, y(p));
      g.stroke();
      g.fillStyle = '#8b98a5';
      g.fillText(fmtPrice(p), plotW + 4, y(p));
    }
    // candles
    const step = plotW / shown.length;
    const bodyW = Math.max(1, step * 0.7);
    shown.forEach((k, i) => {
      const x = i * step + step / 2;
      const col = k.close >= k.open ? UP : DOWN;
      g.strokeStyle = col;
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(x, y(k.high));
      g.lineTo(x, y(k.low));
      g.stroke();
      const top = y(Math.max(k.open, k.close));
      g.fillRect(x - bodyW / 2, top, bodyW, Math.max(1, y(Math.min(k.open, k.close)) - top));
    });
    // the position and the orders
    for (const l of lines) {
      if (l.price < range.lo || l.price > range.hi) continue;
      g.strokeStyle = l.color;
      g.lineWidth = 1.2;
      g.setLineDash(l.dashed ? [6, 4] : []);
      g.beginPath();
      g.moveTo(0, y(l.price));
      g.lineTo(plotW, y(l.price));
      g.stroke();
      g.setLineDash([]);
      g.lineWidth = 1;
      g.fillStyle = l.color;
      g.textBaseline = 'bottom';
      g.fillText(`${l.label} ${fmtPrice(l.price)}`, 6, y(l.price) - 2);
      g.textBaseline = 'middle';
    }
    // the last price
    const last = candles[candles.length - 1];
    if (last && win.offset === 0) {
      const ly = y(last.close);
      g.strokeStyle = '#9ad0ff';
      g.setLineDash([2, 3]);
      g.beginPath();
      g.moveTo(0, ly);
      g.lineTo(plotW, ly);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#9ad0ff';
      g.fillRect(plotW, ly - 9, AXIS_W, 18);
      g.fillStyle = '#0b0f15';
      g.fillText(fmtPrice(last.close), plotW + 4, ly);
    }
  }, [candles, lines, size, win.start, win.end, win.offset]);

  const down = (e: React.PointerEvent) => {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    gesture.current = { visible: win.visible, offset: win.offset, x: pts[0].x, dist: pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0 };
  };
  const move = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    const g = gesture.current;
    if (pts.length >= 2) {
      if (g.dist === 0) {
        gesture.current = { ...g, dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) };
        return;
      }
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      setView((v) => ({ ...v, visible: zoomed(g.visible, g.dist, dist) }));
    } else {
      // dragging right shows older candles
      const perCandle = (size.w - AXIS_W) / win.visible;
      setView((v) => ({ ...v, offset: g.offset + (e.clientX - g.x) / perCandle }));
    }
  };
  const up = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const pts = [...pointers.current.values()];
    // a finger lifted from a pinch: carry on dragging with the other one from where the view is now
    gesture.current = pts.length ? { visible: win.visible, offset: win.offset, x: pts[0].x, dist: 0 } : null;
  };

  return (
    <div ref={box} className="m-chart" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onDoubleClick={() => setView({ visible: DEFAULT_VISIBLE, offset: 0 })}>
      <canvas ref={canvas} style={{ width: size.w, height: size.h }} />
    </div>
  );
}
