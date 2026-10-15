import { useEffect, useMemo, useRef, useState } from 'react';
import type { Kline } from '../types';
import { fmtPrice, priceRange, windowOf, zoomed, type ChartLine } from './chartMath';

const UP = '#2e9b6f';
const DOWN = '#d0454b';
const AXIS_W = 62;
const LONG_PRESS_MS = 450;
const MOVE_SLOP = 8;
const DEFAULT_VISIBLE = 70;

/**
 * A small candlestick chart for the phone: drag to pan, pinch to zoom, double-tap to jump back to the newest candle. Horizontal lines mark the
 * position's entry, stop-loss, take-profit and liquidation and the open orders.
 */
export interface PendingLine {
  id: string;
  price: number;
  label: string;
  color: string;
  /** the text on its handle */
  handle: string;
  /** an order that is being edited: its handle is drawn white */
  edit?: boolean;
}

export function MobileChart({ candles, lines, pending = [], entryNote, watermark, onPendingMove, onPendingBounds, onPendingDoubleTap, onLongPress, onTap, onDoubleTap }: { candles: Kline[]; lines: ChartLine[]; /** the order being set up: lines with handles to drag */ pending?: PendingLine[]; /** text drawn at the position's entry line (above it or below it): what the order being moved would make or lose */ entryNote?: { price: number; lines: string[]; color: string; above: boolean } | null; /** the symbol and timeframe, drawn large and faint behind the candles */ watermark?: { symbol: string; timeframe: string } | null; onPendingMove?: (id: string, price: number) => void; /** the screen heights (client y) of the highest and lowest pending line, so the order box can stay clear of them */ onPendingBounds?: (top: number, bottom: number, entry: number | null) => void; /** a double tap on a handle (without dragging it) */ onPendingDoubleTap?: (id: string) => void; onLongPress?: (p: { price: number; x: number; y: number }) => void; onTap?: (p: { price: number; tol: number }) => void; /** a double tap at this price (`tol` = how far a line may be from it to count as hit); return true when it was used, else the chart jumps to the newest candle */ onDoubleTap?: (p: { price: number; tol: number }) => boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 320, h: 300 });
  const [view, setView] = useState({ visible: DEFAULT_VISIBLE, offset: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ visible: number; offset: number; x: number; dist: number } | null>(null);
  // press and hold: where the finger went down, the timer that fires after LONG_PRESS_MS, and whether it already fired (then the rest of the touch does nothing)
  const press = useRef<{ x: number; y: number; timer: number; fired: boolean; moved: boolean } | null>(null);
  const rangeRef = useRef<{ lo: number; hi: number; h: number } | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const lastDouble = useRef(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: Math.max(100, el.clientWidth), h: Math.max(100, el.clientHeight) }));
    ro.observe(el);
    setSize({ w: Math.max(100, el.clientWidth), h: Math.max(100, el.clientHeight) });
    return () => ro.disconnect();
  }, []);

  const win = windowOf(candles.length, view.visible, view.offset);
  // the price range holds the candles, the position's lines and the order being set up; while a handle is being dragged the range is held still,
  // so the chart does not rescale under the finger
  const pendingKey = pending.map((p) => p.price).join(',');
  const liveRange = useMemo(() => priceRange(candles.slice(win.start, win.end), lines, pending.map((p) => p.price)), [candles, lines, pendingKey, win.start, win.end]); // eslint-disable-line react-hooks/exhaustive-deps
  const frozen = useRef<{ lo: number; hi: number } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const range = dragging && frozen.current ? frozen.current : liveRange;

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
    rangeRef.current = range ? { lo: range.lo, hi: range.hi, h: size.h } : null;
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
    // the symbol and timeframe as a faint watermark behind the candles
    if (watermark) {
      g.save();
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      let px = 64;
      g.font = `800 ${px}px system-ui, sans-serif`;
      const wide = g.measureText(watermark.symbol).width;
      if (wide > plotW * 0.86) {
        px = Math.floor((px * plotW * 0.86) / wide);
        g.font = `800 ${px}px system-ui, sans-serif`;
      }
      g.fillStyle = 'rgba(190, 205, 225, 0.09)';
      g.fillText(watermark.symbol, plotW / 2, size.h * 0.4);
      g.font = `700 ${Math.max(14, Math.round(px * 0.4))}px system-ui, sans-serif`;
      g.fillText(watermark.timeframe, plotW / 2, size.h * 0.4 + px * 0.75);
      g.restore();
      g.textBaseline = 'middle';
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
    // the order being set up
    for (const pl of pending) {
      if (pl.price < range.lo || pl.price > range.hi) continue;
      g.strokeStyle = pl.color;
      g.lineWidth = 2;
      g.setLineDash([8, 5]);
      g.beginPath();
      g.moveTo(0, y(pl.price));
      g.lineTo(plotW, y(pl.price));
      g.stroke();
      g.setLineDash([]);
      g.lineWidth = 1;
      g.fillStyle = pl.color;
      g.textBaseline = 'bottom';
      g.fillText(`${pl.label} ${fmtPrice(pl.price)}`, 6, y(pl.price) - 3);
      g.textBaseline = 'middle';
    }
    // what the order being moved would make or lose, at the entry line
    if (entryNote && entryNote.price >= range.lo && entryNote.price <= range.hi) {
      const ey = y(entryNote.price);
      g.textAlign = 'right'; // against the right side, clear of the "entry" label at the left
      g.lineJoin = 'round';
      entryNote.lines.forEach((line, k) => {
        const big = k === 0;
        g.font = `${big ? 800 : 600} ${big ? 18 : 12}px system-ui, sans-serif`;
        // above the line: the first line is the one nearest to it
        const dy = entryNote.above ? -(big ? 17 : 38) : big ? 19 : 40;
        g.lineWidth = 4;
        g.strokeStyle = '#05080c';
        g.strokeText(line, plotW - 8, ey + dy);
        g.fillStyle = big ? entryNote.color : '#cfd6df';
        g.fillText(line, plotW - 8, ey + dy);
      });
      g.textAlign = 'left';
      g.lineWidth = 1;
      g.font = '11px system-ui, sans-serif';
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
  }, [candles, lines, pendingKey, watermark?.symbol, watermark?.timeframe, entryNote?.price, entryNote?.lines.join('|'), entryNote?.above, range, size, win.start, win.end, win.offset]); // eslint-disable-line react-hooks/exhaustive-deps

  const doubleTap = (clientY: number) => {
    lastDouble.current = Date.now();
    const r = rangeRef.current;
    const top = box.current?.getBoundingClientRect().top ?? 0;
    let handled = false;
    if (r) {
      const per = (r.hi - r.lo) / (r.h - 4); // price per pixel
      const price = r.hi - (clientY - top - 2) * per;
      handled = onDoubleTap?.({ price, tol: 28 * per }) ?? false;
    }
    if (!handled) setView({ visible: DEFAULT_VISIBLE, offset: 0 });
  };
  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
  };
  const down = (e: React.PointerEvent) => {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    gesture.current = { visible: win.visible, offset: win.offset, x: pts[0].x, dist: pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0 };
    cancelPress();
    if (pts.length === 1 && onLongPress) {
      const top = box.current?.getBoundingClientRect().top ?? 0;
      const [cx, cy] = [e.clientX, e.clientY];
      const timer = window.setTimeout(() => {
        const r = rangeRef.current;
        if (!press.current || !r) return;
        press.current.fired = true;
        const price = r.hi - ((cy - top - 2) / (r.h - 4)) * (r.hi - r.lo);
        if (price > 0) {
          navigator.vibrate?.(15);
          onLongPress({ price, x: cx, y: cy });
        }
      }, LONG_PRESS_MS);
      press.current = { x: cx, y: cy, timer, fired: false, moved: false };
    } else {
      press.current = null;
    }
  };
  const move = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pr = press.current;
    if (pr) {
      if (pr.fired) return; // the press opened the order box: the finger that is still down does not pan the chart
      if (Math.hypot(e.clientX - pr.x, e.clientY - pr.y) > MOVE_SLOP) {
        pr.moved = true;
        window.clearTimeout(pr.timer);
      } else {
        return; // a finger that has not really moved yet: neither a pan nor a press that was cancelled
      }
    }
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
    const pr = press.current;
    if (pr) {
      window.clearTimeout(pr.timer);
      // a quick touch that did not move is a tap; two of them close together are a double tap
      if (!pr.fired && !pr.moved && e.type === 'pointerup') {
        const now = Date.now();
        const lt = lastTap.current;
        if (lt && now - lt.t < 320 && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < 30) {
          lastTap.current = null;
          doubleTap(e.clientY);
        } else {
          lastTap.current = { t: now, x: e.clientX, y: e.clientY };
          const r = rangeRef.current;
          const top = box.current?.getBoundingClientRect().top ?? 0;
          if (r) {
            const per = (r.hi - r.lo) / (r.h - 4);
            onTap?.({ price: r.hi - (e.clientY - top - 2) * per, tol: 28 * per });
          } else {
            onTap?.({ price: 0, tol: 0 });
          }
        }
      }
      press.current = null;
    }
    pointers.current.delete(e.pointerId);
    const pts = [...pointers.current.values()];
    // a finger lifted from a pinch: carry on dragging with the other one from where the view is now
    gesture.current = pts.length ? { visible: win.visible, offset: win.offset, x: pts[0].x, dist: 0 } : null;
  };

  // the handles on the order's lines: drag one up or down to move its line
  const dragId = useRef<string | null>(null);
  const handleTap = useRef<{ t: number; moved: boolean; x: number; y: number }>({ t: 0, moved: false, x: 0, y: 0 });
  const priceAtY = (clientY: number): number | null => {
    const r = rangeRef.current;
    const top = box.current?.getBoundingClientRect().top;
    if (!r || top == null) return null;
    const price = r.hi - ((clientY - top - 2) / (r.h - 4)) * (r.hi - r.lo);
    return Math.max(r.lo, Math.min(r.hi, price));
  };
  const yOfPrice = (price: number): number | null => (range ? Math.max(2, Math.min(size.h - 2, ((range.hi - price) / (range.hi - range.lo)) * (size.h - 4) + 2)) : null);
  const handleYs = pending.map((p) => yOfPrice(p.price));
  const boundsKey = handleYs.join(',');

  useEffect(() => {
    const ys = handleYs.filter((v): v is number => v != null);
    if (!ys.length) return;
    const top = box.current?.getBoundingClientRect().top ?? 0;
    const ei = pending.findIndex((p) => p.id === 'entry');
    const ey = ei >= 0 ? handleYs[ei] : null;
    onPendingBounds?.(top + Math.min(...ys), top + Math.max(...ys), ey != null ? top + ey : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundsKey, size.h]);

  return (
    <div ref={box} className="m-chart" data-visible={win.visible} data-offset={win.offset} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onContextMenu={(e) => e.preventDefault()} onDoubleClick={(e) => Date.now() - lastDouble.current > 600 && doubleTap(e.clientY)}>
      <canvas ref={canvas} style={{ width: size.w, height: size.h }} />
      {pending.map((pl, i) => {
        const hy = handleYs[i];
        if (hy == null) return null;
        const end = () => {
          dragId.current = null;
          frozen.current = null;
          setDragging(null);
        };
        return (
          <div
            key={pl.id}
            className="m-handle"
            style={pl.edit ? { top: hy - 18, right: AXIS_W + 6 + i * 58, color: '#101418', borderColor: '#ffffff', background: '#ffffff' } : { top: hy - 18, right: AXIS_W + 6 + i * 58, color: pl.color, borderColor: pl.color }}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              (e.currentTarget as Element).setPointerCapture(e.pointerId);
              dragId.current = pl.id;
              handleTap.current = { ...handleTap.current, moved: false, x: e.clientX, y: e.clientY };
              frozen.current = liveRange;
              setDragging(pl.id);
            }}
            onPointerMove={(e) => {
              if (dragId.current !== pl.id) return;
              if (Math.hypot(e.clientX - handleTap.current.x, e.clientY - handleTap.current.y) > 6) handleTap.current.moved = true;
              const p = priceAtY(e.clientY);
              if (p != null) onPendingMove?.(pl.id, p);
            }}
            onPointerUp={(e) => {
              try {
                (e.currentTarget as Element).releasePointerCapture(e.pointerId);
              } catch {
                /* already released */
              }
              // two quick taps on the handle (not a drag) are a double tap
              if (!handleTap.current.moved) {
                const now = Date.now();
                if (now - handleTap.current.t < 350) {
                  handleTap.current.t = 0;
                  onPendingDoubleTap?.(pl.id);
                } else {
                  handleTap.current.t = now;
                }
              }
              end();
            }}
            onPointerCancel={end}
            title={`Drag to move the ${pl.label}`}
          >
            {pl.handle}
          </div>
        );
      })}
    </div>
  );
}
