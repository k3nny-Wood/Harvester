import { useEffect, useMemo, useRef, useState } from 'react';
import type { Kline } from '../types';
import { confirmDialog } from '../confirm';
import { buildPanes, buildSmas, type IndKey } from './indicators';
import { fibPrices, indexOfTime, hitDistance, loadDrawings, measureText, rayY, saveDrawings, spanOf, timeOfIndex, type Drawing, type DrawKind, type DrawPoint, type Px, type Tool } from './drawings';
import { fmtPrice, MAX_VISIBLE, MIN_VISIBLE, priceRange, timeLabels, windowOf, zoomed, type ChartLine } from './chartMath';

/** An executed order: when and at what average price. */
export interface FillMark {
  key: string;
  time: number;
  price: number;
  side: 'BUY' | 'SELL';
}

const UP = '#2e9b6f';
const DOWN = '#d0454b';
const AXIS_W = 62;
/** The height of the time axis along the bottom of the chart. */
const TIME_H = 22;
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

export function MobileChart({ candles, lines, indicators = {}, marks = [], pending = [], entryNote, watermark, onRemoveLine, onRemovePending, onPendingMove, onPendingBounds, onPendingDoubleTap, onLongPress, onTap, onDoubleTap }: { candles: Kline[]; lines: ChartLine[]; /** the chosen indicators: volume and the moving averages on the price pane, the others in panes under it */ indicators?: Partial<Record<IndKey, boolean>>; /** executed trades: an arrow per order (up = buy, down = sell) with its tip on the price */ marks?: FillMark[]; /** the order being set up: lines with handles to drag */ pending?: PendingLine[]; /** text drawn at the position's entry line (above it or below it): what the order being moved would make or lose */ entryNote?: { price: number; lines: string[]; color: string; above: boolean } | null; /** the symbol and timeframe, drawn large and faint behind the candles */ watermark?: { symbol: string; timeframe: string } | null; /** an X at the left of a stop-loss / take-profit line that is on the exchange: asks to remove it */ onRemoveLine?: (line: ChartLine) => void; /** the same for the stop-loss / take-profit line of an order not sent yet: switches it off */ onRemovePending?: (id: string) => void; onPendingMove?: (id: string, price: number) => void; /** the screen heights (client y) of the highest and lowest pending line, so the order box can stay clear of them */ onPendingBounds?: (top: number, bottom: number, entry: number | null) => void; /** a double tap on a handle (without dragging it) */ onPendingDoubleTap?: (id: string) => void; onLongPress?: (p: { price: number; x: number; y: number }) => void; onTap?: (p: { price: number; tol: number }) => void; /** a double tap at this price (`tol` = how far a line may be from it to count as hit); return true when it was used, else the chart jumps to the newest candle */ onDoubleTap?: (p: { price: number; tol: number }) => boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 320, h: 300 });
  const [view, setView] = useState({ visible: DEFAULT_VISIBLE, offset: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ visible: number; offset: number; x: number; y: number; dist: number; rlo: number; rhi: number } | null>(null);
  // dragging on the price axis (the right edge) stretches or squashes the chart vertically; from then on the price range is manual and one finger moves the chart up and down as well
  const [manual, setManual] = useState<{ lo: number; hi: number } | null>(null);
  const axis = useRef<{ startY: number; lo: number; hi: number; moved: boolean } | null>(null);
  const lastAxisTap = useRef(0);
  // dragging on the time axis (along the bottom) stretches or squashes the chart horizontally
  const taxis = useRef<{ startX: number; visible: number; moved: boolean } | null>(null);
  const lastTimeTap = useRef(0);
  // press and hold: where the finger went down, the timer that fires after LONG_PRESS_MS, and whether it already fired (then the rest of the touch does nothing)
  const press = useRef<{ x: number; y: number; timer: number; fired: boolean; moved: boolean } | null>(null);
  const rangeRef = useRef<{ lo: number; hi: number; h: number } | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const lastDouble = useRef(0);

  // drawing tools: the toolbar at the left, the drawings of this symbol (kept on the phone), the one being drawn, and the last measurement
  const drawSymbol = watermark?.symbol ?? '';
  const [tool, setTool] = useState<Tool>('cursor');
  const [barOpen, setBarOpen] = useState(() => {
    try {
      return window.localStorage.getItem('harvester.mobile.drawbar') !== '0';
    } catch {
      return true;
    }
  });
  const [drawings, setDrawings] = useState<Drawing[]>(() => loadDrawings(drawSymbol));
  const [draft, setDraft] = useState<{ kind: Tool; a: DrawPoint; b: DrawPoint } | null>(null);
  const draw = useRef<{ kind: Tool; a: DrawPoint } | null>(null);
  // a drawing touched with the move tool is selected: its end points can be dragged, or the whole drawing
  const [selected, setSelected] = useState<number | null>(null);
  const edit = useRef<{ mode: 'a' | 'b' | 'move'; start: DrawPoint; orig: Drawing; latest: Drawing } | null>(null);
  const toolRef = useRef<Tool>('cursor');
  toolRef.current = tool;
  useEffect(() => {
    setDrawings(loadDrawings(drawSymbol));
    setDraft(null);
    setSelected(null);
    setTool('cursor');
  }, [drawSymbol]);
  const times = useMemo(() => candles.map((k) => k.time), [candles]);
  const span = spanOf(times);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // a rotation can swallow the pointerup of a finger that was down: forget every gesture so the next press starts clean
    const resetGestures = () => {
      if (press.current) window.clearTimeout(press.current.timer);
      press.current = null;
      pointers.current.clear();
      gesture.current = null;
      taxis.current = null;
      axis.current = null;
    };
    const ro = new ResizeObserver(() => {
      resetGestures();
      setSize({ w: Math.max(100, el.clientWidth), h: Math.max(100, el.clientHeight) });
    });
    ro.observe(el);
    setSize({ w: Math.max(100, el.clientWidth), h: Math.max(100, el.clientHeight) });
    return () => ro.disconnect();
  }, []);

  // the panes of the chosen indicators sit between the price pane and the time axis; a small screen shows fewer of them
  const axisY = size.h - TIME_H;
  const indKey = Object.entries(indicators).filter(([, v]) => v).map(([k]) => k).join(',');
  const allPanes = useMemo(() => buildPanes(candles, indicators), [candles, indKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const smas = useMemo(() => (indicators.sma ? buildSmas(candles) : []), [candles, indKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const panes = allPanes.slice(0, Math.max(0, Math.floor((axisY * 0.55) / 34)));
  const subH = panes.length ? Math.min(96, Math.floor((axisY * 0.55) / panes.length)) : 0;
  const plotH = axisY - panes.length * subH; // the candles and lines use the price pane above the indicator panes
  const win = windowOf(candles.length, view.visible, view.offset);
  // the price range holds the candles, the position's lines and the order being set up; while a handle is being dragged the range is held still,
  // so the chart does not rescale under the finger
  const pendingKey = pending.map((p) => p.price).join(',');
  const liveRange = useMemo(() => priceRange(candles.slice(win.start, win.end), lines, pending.map((p) => p.price)), [candles, lines, pendingKey, win.start, win.end]); // eslint-disable-line react-hooks/exhaustive-deps
  const frozen = useRef<{ lo: number; hi: number } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const range = manual ?? (dragging && frozen.current ? frozen.current : liveRange);
  // a different chart starts with the automatic range again
  useEffect(() => setManual(null), [watermark?.symbol, watermark?.timeframe]);

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
    rangeRef.current = range ? { lo: range.lo, hi: range.hi, h: plotH } : null;
    if (!range || !shown.length) {
      g.fillStyle = '#8b98a5';
      g.font = '13px system-ui, sans-serif';
      g.fillText('Loading…', 12, 24);
      return;
    }
    const plotW = size.w - AXIS_W;
    const y = (p: number) => ((range.hi - p) / (range.hi - range.lo)) * (plotH - 4) + 2;
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
      g.fillText(watermark.symbol, plotW / 2, plotH * 0.4);
      g.font = `700 ${Math.max(14, Math.round(px * 0.4))}px system-ui, sans-serif`;
      g.fillText(watermark.timeframe, plotW / 2, plotH * 0.4 + px * 0.75);
      g.restore();
      g.textBaseline = 'middle';
    }
    // candles
    const step = plotW / shown.length;
    const bodyW = Math.max(1, step * 0.7);
    if (indicators.volume) {
      let top = 0;
      shown.forEach((k) => (top = Math.max(top, k.volume)));
      const vh = plotH * 0.18;
      shown.forEach((k, i) => {
        g.fillStyle = k.close >= k.open ? 'rgba(46, 155, 111, 0.32)' : 'rgba(208, 69, 75, 0.32)';
        const h = top > 0 ? (k.volume / top) * vh : 0;
        g.fillRect(i * step + step / 2 - bodyW / 2, plotH - h, bodyW, h);
      });
    }
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
    // executed trades: an up arrow under the price for a buy, a down arrow over it for a sell
    if (marks.length && shown.length) {
      const span = shown.length > 1 ? shown[1].time - shown[0].time : 60_000;
      for (const m of marks) {
        if (m.time < shown[0].time || m.time >= shown[shown.length - 1].time + span || m.price < range.lo || m.price > range.hi) continue;
        let idx = 0;
        while (idx + 1 < shown.length && shown[idx + 1].time <= m.time) idx++;
        const mx = idx * step + step / 2;
        const my = y(m.price);
        const dir = m.side === 'BUY' ? 1 : -1; // the body is below the tip for a buy, above for a sell
        const col = m.side === 'BUY' ? '#2ee59d' : '#ff5c63';
        g.fillStyle = col;
        g.strokeStyle = '#05080c';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(mx, my);
        g.lineTo(mx - 6, my + dir * 11);
        g.lineTo(mx - 2.5, my + dir * 11);
        g.lineTo(mx - 2.5, my + dir * 19);
        g.lineTo(mx + 2.5, my + dir * 19);
        g.lineTo(mx + 2.5, my + dir * 11);
        g.lineTo(mx + 6, my + dir * 11);
        g.closePath();
        g.fill();
        g.stroke();
      }
    }
    // moving averages
    for (const m of smas) {
      g.strokeStyle = m.color;
      g.lineWidth = 1.3;
      g.beginPath();
      let pen = false;
      for (let i = 0; i < shown.length; i++) {
        const v = m.values[win.start + i];
        if (v == null) {
          pen = false;
          continue;
        }
        if (pen) g.lineTo(i * step + step / 2, y(v));
        else g.moveTo(i * step + step / 2, y(v));
        pen = true;
      }
      g.stroke();
      g.lineWidth = 1;
    }
    // drawings (and the one being drawn)
    {
      const xAt = (t: number) => (indexOfTime(times, t, span) - win.start) * step + step / 2;
      g.save();
      g.beginPath();
      g.rect(0, 0, plotW, plotH);
      g.clip();
      g.font = '10px system-ui, sans-serif';
      const items: Array<{ kind: Tool; a: DrawPoint; b: DrawPoint; temp?: boolean }> = [...drawings];
      if (draft) items.push({ kind: draft.kind, a: draft.a, b: draft.b, temp: true });
      for (const d of items) {
        const x0 = xAt(d.a.t);
        const y0 = y(d.a.p);
        const x1 = xAt(d.b.t);
        const y1 = y(d.b.p);
        const sel = !d.temp && 'id' in d && (d as Drawing).id === selected;
        g.lineWidth = d.temp ? 1 : sel ? 2.5 : 1.5;
        g.setLineDash(d.temp ? [4, 3] : []);
        g.strokeStyle = '#f0b90b';
        g.fillStyle = '#f0b90b';
        g.textBaseline = 'bottom';
        if (d.kind === 'trend' || d.kind === 'ray') {
          g.beginPath();
          g.moveTo(x0, y0);
          const ex = d.kind === 'ray' ? (x1 >= x0 ? plotW : 0) : x1;
          g.lineTo(ex, d.kind === 'ray' ? rayY(x0, y0, x1, y1, ex) : y1);
          g.stroke();
        } else if (d.kind === 'hline') {
          g.beginPath();
          g.moveTo(0, y0);
          g.lineTo(plotW, y0);
          g.stroke();
          g.fillText(fmtPrice(d.a.p), 4, y0 - 2);
        } else if (d.kind === 'rect') {
          g.fillStyle = 'rgba(240, 185, 11, 0.12)';
          g.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
          g.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
        } else if (d.kind === 'fib') {
          const left = Math.min(x0, x1);
          for (const f of fibPrices(d.a.p, d.b.p)) {
            const fy = y(f.price);
            g.strokeStyle = f.level === 0 || f.level === 1 ? '#8b98a5' : f.level === 0.618 ? '#2ee59d' : '#f0b90b';
            g.fillStyle = g.strokeStyle;
            g.beginPath();
            g.moveTo(left, fy);
            g.lineTo(plotW, fy);
            g.stroke();
            g.textAlign = 'left';
            g.fillText(`${f.level} ${fmtPrice(f.price)}`, Math.max(2, left + 3), fy - 1);
          }
          g.strokeStyle = '#8b98a5';
          g.setLineDash([3, 3]);
          g.beginPath();
          g.moveTo(x0, y0);
          g.lineTo(x1, y1);
          g.stroke();
        } else if (d.kind === 'measure') {
          const up = d.b.p >= d.a.p;
          const col = up ? '#2ee59d' : '#ff5c63';
          g.strokeStyle = col;
          g.fillStyle = up ? 'rgba(46, 229, 157, 0.14)' : 'rgba(255, 92, 99, 0.14)';
          g.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
          g.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
          const label = measureText(d.a, d.b, span);
          g.font = '700 11px system-ui, sans-serif';
          const tw = g.measureText(label).width + 10;
          const lx = Math.max(2, Math.min(plotW - tw - 2, (x0 + x1) / 2 - tw / 2));
          const ly = Math.max(16, Math.min(plotH - 4, up ? Math.min(y0, y1) - 4 : Math.max(y0, y1) + 18));
          g.fillStyle = '#05080c';
          g.fillRect(lx, ly - 14, tw, 18);
          g.fillStyle = col;
          g.textAlign = 'left';
          g.fillText(label, lx + 5, ly);
          g.font = '10px system-ui, sans-serif';
        }
        g.setLineDash([]);
        g.textAlign = 'left';
        if (sel) {
          // round handles on the end points (a horizontal line has one)
          const ends: Array<[number, number]> = d.kind === 'hline' ? [[Math.min(40, plotW / 2), y0]] : [[x0, y0], [x1, y1]];
          for (const [hx, hy] of ends) {
            g.fillStyle = '#ffffff';
            g.strokeStyle = '#f0b90b';
            g.lineWidth = 2;
            g.beginPath();
            g.arc(hx, hy, 7, 0, Math.PI * 2);
            g.fill();
            g.stroke();
          }
        }
      }
      g.restore();
      g.lineWidth = 1;
      g.textBaseline = 'middle';
    }
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
      g.fillText(`${l.label} ${fmtPrice(l.price)}`, l.adjust && l.adjust.kind !== 'order' ? 34 : 6, y(l.price) - 2);
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
      g.fillText(`${pl.label} ${fmtPrice(pl.price)}`, pl.id === 'sl' || pl.id === 'tp' ? 34 : 6, y(pl.price) - 3);
      g.textBaseline = 'middle';
    }
    // what the order being moved would make or lose, at the entry line
    if (entryNote && entryNote.price >= range.lo && entryNote.price <= range.hi) {
      const ey = y(entryNote.price);
      g.textAlign = 'right'; // against the right side, clear of the "entry" label at the left
      g.lineJoin = 'round';
      entryNote.lines.forEach((line, k) => {
        const big = k === 0;
        g.font = `${big ? 800 : 600} ${big ? 10 : 8}px system-ui, sans-serif`;
        // above the line: the first line is the one nearest to it
        const dy = entryNote.above ? -(big ? 10 : 22) : big ? 12 : 24;
        g.lineWidth = 3;
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
    // the panes of the other indicators under the price pane
    panes.forEach((pane, pi) => {
      const top = plotH + pi * subH;
      g.fillStyle = '#0b0f15';
      g.fillRect(0, top, size.w, subH);
      g.strokeStyle = '#243043';
      g.beginPath();
      g.moveTo(0, top + 0.5);
      g.lineTo(size.w, top + 0.5);
      g.stroke();
      let lo = Infinity;
      let hi = -Infinity;
      if (pane.fixed) [lo, hi] = pane.fixed;
      else {
        for (const s of pane.series) {
          for (let i = win.start; i < win.end; i++) {
            const v = s.values[i];
            if (v != null) {
              lo = Math.min(lo, v);
              hi = Math.max(hi, v);
            }
          }
        }
      }
      g.font = '10px system-ui, sans-serif';
      g.textBaseline = 'middle';
      g.textAlign = 'left';
      g.fillStyle = '#8b98a5';
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        g.fillText(`${pane.title}: not enough candles`, 40, top + 10);
        return;
      }
      if (pane.series.some((s) => s.kind === 'hist')) {
        lo = Math.min(lo, 0);
        hi = Math.max(hi, 0);
      }
      if (hi === lo) {
        hi += 1;
        lo -= 1;
      }
      if (!pane.fixed) {
        const pad = (hi - lo) * 0.08;
        lo -= pad;
        hi += pad;
      }
      const iy = (v: number) => top + 15 + (1 - (v - lo) / (hi - lo)) * (subH - 19);
      const num = (v: number) => (v === 0 ? '0' : Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e4 ? `${(v / 1e3).toFixed(0)}K` : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4));
      g.save();
      g.beginPath();
      g.rect(0, top + 1, plotW, subH - 1);
      g.clip();
      g.strokeStyle = '#2a3547';
      g.setLineDash([3, 3]);
      for (const gv of pane.guides ?? []) {
        if (gv < lo || gv > hi) continue;
        g.beginPath();
        g.moveTo(0, iy(gv));
        g.lineTo(plotW, iy(gv));
        g.stroke();
      }
      g.setLineDash([]);
      for (const s of pane.series) {
        if (s.kind === 'hist') {
          const zero = iy(0);
          for (let i = 0; i < shown.length; i++) {
            const v = s.values[win.start + i];
            if (v == null) continue;
            g.fillStyle = v >= 0 ? 'rgba(46, 155, 111, 0.65)' : 'rgba(208, 69, 75, 0.65)';
            g.fillRect(i * step + step / 2 - bodyW / 2, Math.min(zero, iy(v)), bodyW, Math.max(1, Math.abs(iy(v) - zero)));
          }
        } else {
          g.strokeStyle = s.color;
          g.lineWidth = 1.3;
          g.beginPath();
          let pen = false;
          for (let i = 0; i < shown.length; i++) {
            const v = s.values[win.start + i];
            if (v == null) {
              pen = false;
              continue;
            }
            if (pen) g.lineTo(i * step + step / 2, iy(v));
            else g.moveTo(i * step + step / 2, iy(v));
            pen = true;
          }
          g.stroke();
          g.lineWidth = 1;
        }
      }
      g.restore();
      // the name and the latest values, and the range at the right
      const latest = pane.series
        .filter((s) => s.kind === 'line')
        .map((s) => {
          const v = s.values[win.end - 1];
          return v == null ? '' : num(v);
        })
        .filter(Boolean)
        .join(' ');
      g.fillStyle = '#c9d2de';
      g.fillText(`${pane.title}  ${latest}`, 40, top + 9);
      g.fillStyle = '#8b98a5';
      g.fillText(num(hi), plotW + 4, top + 14);
      g.fillText(num(lo), plotW + 4, top + subH - 6);
      g.font = '11px system-ui, sans-serif';
    });
    // the time axis along the bottom
    g.fillStyle = '#0b0f15';
    g.fillRect(0, axisY, size.w, TIME_H);
    g.strokeStyle = '#243043';
    g.beginPath();
    g.moveTo(0, axisY + 0.5);
    g.lineTo(size.w, axisY + 0.5);
    g.stroke();
    g.font = '11px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#8b98a5';
    for (const l of timeLabels(shown, win.start, plotW, watermark?.timeframe ?? '15m')) {
      g.fillText(l.text, l.x, axisY + TIME_H / 2 + 1);
      g.strokeStyle = '#243043';
      g.beginPath();
      g.moveTo(l.x, axisY);
      g.lineTo(l.x, axisY + 3);
      g.stroke();
    }
    g.textAlign = 'left';
  }, [candles, lines, marks, drawings, draft, selected, indKey, panes.length, subH, pendingKey, watermark?.symbol, watermark?.timeframe, entryNote?.price, entryNote?.lines.join('|'), entryNote?.above, range, size, win.start, win.end, win.offset]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (!handled) {
      setView({ visible: DEFAULT_VISIBLE, offset: 0 });
      setManual(null);
    }
  };
  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
  };
  /** The chart point (time, price) under a finger. */
  const pointAt = (clientX: number, clientY: number): DrawPoint | null => {
    const bx = box.current?.getBoundingClientRect();
    const r = rangeRef.current;
    if (!bx || !r) return null;
    const plotW = size.w - AXIS_W;
    const st = plotW / Math.max(1, win.end - win.start);
    const idx = (clientX - bx.left - st / 2) / st + win.start;
    return { t: timeOfIndex(times, idx, span), p: r.hi - ((clientY - bx.top - 2) / (r.h - 4)) * (r.hi - r.lo) };
  };
  /** A drawing's points on the screen (relative to the chart box). */
  const toPx = (pt: DrawPoint): Px | null => {
    const r = rangeRef.current;
    if (!r) return null;
    const plotW = size.w - AXIS_W;
    const st = plotW / Math.max(1, win.end - win.start);
    return { x: (indexOfTime(times, pt.t, span) - win.start) * st + st / 2, y: ((r.hi - pt.p) / (r.hi - r.lo)) * (r.h - 4) + 2 };
  };
  /** The drawing (and which part of it) a finger at this chart position is on: the end points of the selected one first, then any line. */
  const drawingAt = (x: number, y: number): { d: Drawing; mode: 'a' | 'b' | 'move' } | null => {
    const plotW = size.w - AXIS_W;
    const sel = drawings.find((d) => d.id === selected);
    if (sel) {
      const pa = toPx(sel.a);
      const pb = toPx(sel.b);
      if (sel.kind === 'hline') {
        if (pa && Math.hypot(x - Math.min(40, plotW / 2), y - pa.y) < 26) return { d: sel, mode: 'a' };
      } else {
        if (pa && Math.hypot(x - pa.x, y - pa.y) < 26) return { d: sel, mode: 'a' };
        if (pb && Math.hypot(x - pb.x, y - pb.y) < 26) return { d: sel, mode: 'b' };
      }
    }
    let best: { d: Drawing; dist: number } | null = null;
    for (const d of drawings) {
      const pa = toPx(d.a);
      const pb = toPx(d.b);
      if (!pa || !pb) continue;
      const fibYs = d.kind === 'fib' ? fibPrices(d.a.p, d.b.p).map((f) => toPx({ t: d.a.t, p: f.price })?.y ?? -1e9) : [];
      const dist = hitDistance(d.kind, pa, pb, x, y, plotW, fibYs);
      if (dist <= 18 && (!best || dist < best.dist)) best = { d, dist };
    }
    return best ? { d: best.d, mode: 'move' } : null;
  };
  const down = (e: React.PointerEvent) => {
    // the first finger of a touch cannot have company: anything left over from a lost pointerup is stale
    if (e.isPrimary) pointers.current.clear();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    gesture.current = { visible: win.visible, offset: win.offset, x: pts[0].x, y: pts[0].y, dist: pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0, rlo: range?.lo ?? 0, rhi: range?.hi ?? 0 };
    cancelPress();
    const bx = box.current?.getBoundingClientRect();
    if (bx && pts.length === 1 && e.clientY > bx.bottom - TIME_H) {
      taxis.current = { startX: e.clientX, visible: win.visible, moved: false };
      press.current = null;
      return;
    }
    if (bx && pts.length === 1 && range && e.clientX > bx.right - AXIS_W && e.clientY < bx.top + plotH) {
      axis.current = { startY: e.clientY, lo: range.lo, hi: range.hi, moved: false };
      press.current = null;
      return;
    }
    // the move tool: a touch on a drawing selects it and drags it (an end point, or the whole drawing); a touch elsewhere deselects and pans as usual
    if (toolRef.current === 'cursor' && pts.length === 1 && bx && e.clientX < bx.right - AXIS_W && e.clientY < bx.top + plotH) {
      const hit = drawingAt(e.clientX - bx.left, e.clientY - bx.top);
      const pt = hit ? pointAt(e.clientX, e.clientY) : null;
      if (hit && pt) {
        setSelected(hit.d.id);
        edit.current = { mode: hit.mode, start: pt, orig: hit.d, latest: hit.d };
        press.current = null;
        return;
      }
      if (selected != null) setSelected(null);
    }
    // a drawing tool is chosen: this touch draws instead of panning
    if (toolRef.current !== 'cursor' && pts.length === 1 && bx && e.clientX < bx.right - AXIS_W && e.clientY < bx.top + plotH) {
      const pt = pointAt(e.clientX, e.clientY);
      if (pt) {
        draw.current = { kind: toolRef.current, a: pt };
        setDraft({ kind: toolRef.current, a: pt, b: pt });
        press.current = null;
        return;
      }
    }
    if (pts.length === 1 && onLongPress && bx && e.clientY < bx.top + plotH) {
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
    if (edit.current) {
      const pt = pointAt(e.clientX, e.clientY);
      if (pt) {
        const ed = edit.current;
        const o = ed.orig;
        let nd: Drawing;
        if (o.kind === 'hline') {
          const dp = ed.mode === 'move' ? pt.p - ed.start.p : pt.p - o.a.p;
          nd = { ...o, a: { t: o.a.t, p: o.a.p + dp }, b: { t: o.b.t, p: o.a.p + dp } };
        } else if (ed.mode === 'a') nd = { ...o, a: pt };
        else if (ed.mode === 'b') nd = { ...o, b: pt };
        else {
          const dt = pt.t - ed.start.t;
          const dp = pt.p - ed.start.p;
          nd = { ...o, a: { t: o.a.t + dt, p: o.a.p + dp }, b: { t: o.b.t + dt, p: o.b.p + dp } };
        }
        ed.latest = nd;
        setDrawings((list) => list.map((x) => (x.id === nd.id ? nd : x)));
      }
      return;
    }
    if (draw.current) {
      const pt = pointAt(e.clientX, e.clientY);
      const a = draw.current.a;
      if (pt) setDraft({ kind: draw.current.kind, a, b: pt });
      return;
    }
    const ta = taxis.current;
    if (ta) {
      // dragging right squashes the chart (more candles), dragging left stretches it (fewer, wider candles)
      const dx = e.clientX - ta.startX;
      if (Math.abs(dx) > 4) ta.moved = true;
      setView((v) => ({ ...v, visible: Math.max(MIN_VISIBLE, Math.min(MAX_VISIBLE, ta.visible * Math.exp(dx / 200))) }));
      return;
    }
    const a = axis.current;
    if (a) {
      // dragging down squashes the chart (a larger price range), dragging up stretches it
      const dy = e.clientY - a.startY;
      if (Math.abs(dy) > 4) a.moved = true;
      const mid = (a.lo + a.hi) / 2;
      const span = Math.max(mid * 1e-4, (a.hi - a.lo) * Math.exp(dy / 200));
      setManual({ lo: mid - span / 2, hi: mid + span / 2 });
      return;
    }
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
      // with a manual price range the chart also moves up and down with the finger
      if (manual && g.rhi > g.rlo) {
        const shift = ((e.clientY - g.y) * (g.rhi - g.rlo)) / (plotH - 4);
        setManual({ lo: g.rlo + shift, hi: g.rhi + shift });
      }
    }
  };
  const up = (e: React.PointerEvent) => {
    if (edit.current) {
      const nd = edit.current.latest;
      edit.current = null;
      pointers.current.delete(e.pointerId);
      gesture.current = null;
      const list = drawings.map((x) => (x.id === nd.id ? nd : x));
      setDrawings(list);
      saveDrawings(drawSymbol, list);
      return;
    }
    if (draw.current) {
      const cur = draw.current;
      draw.current = null;
      const pt = e.type === 'pointerup' ? pointAt(e.clientX, e.clientY) : null;
      pointers.current.delete(e.pointerId);
      gesture.current = null;
      if (pt) {
        if (cur.kind === 'hline') {
          const list = [...drawings, { id: Date.now(), kind: 'hline' as DrawKind, a: cur.a, b: cur.a }];
          setDrawings(list);
          saveDrawings(drawSymbol, list);
          setDraft(null);
          setTool('cursor');
        } else if (cur.kind === 'measure') {
          setTool('cursor');
          setDraft({ kind: 'measure', a: cur.a, b: pt }); // stays until the next drawing or a symbol change
        } else {
          const range = rangeRef.current;
          const moved = Math.abs(pt.t - cur.a.t) / span > 0.3 || Math.abs(pt.p - cur.a.p) > ((range?.hi ?? 0) - (range?.lo ?? 0)) * 0.01;
          if (moved) {
            const list = [...drawings, { id: Date.now(), kind: cur.kind as DrawKind, a: cur.a, b: pt }];
            setDrawings(list);
            saveDrawings(drawSymbol, list);
          }
          setDraft(null);
          setTool('cursor');
        }
      } else {
        setDraft(null);
      }
      return;
    }
    const ta = taxis.current;
    if (ta) {
      taxis.current = null;
      // two quick taps on the time axis go back to the default zoom
      if (!ta.moved && e.type === 'pointerup') {
        const now = Date.now();
        if (now - lastTimeTap.current < 320) {
          lastTimeTap.current = 0;
          setView({ visible: DEFAULT_VISIBLE, offset: 0 });
        } else {
          lastTimeTap.current = now;
        }
      }
      pointers.current.delete(e.pointerId);
      gesture.current = null;
      return;
    }
    const a = axis.current;
    if (a) {
      axis.current = null;
      // two quick taps on the axis go back to the automatic price range
      if (!a.moved && e.type === 'pointerup') {
        const now = Date.now();
        if (now - lastAxisTap.current < 320) {
          lastAxisTap.current = 0;
          setManual(null);
        } else {
          lastAxisTap.current = now;
        }
      }
      pointers.current.delete(e.pointerId);
      gesture.current = null;
      return;
    }
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
    gesture.current = pts.length ? { visible: win.visible, offset: win.offset, x: pts[0].x, y: pts[0].y, dist: 0, rlo: range?.lo ?? 0, rhi: range?.hi ?? 0 } : null;
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
  const yOfPrice = (price: number): number | null => (range ? Math.max(2, Math.min(plotH - 2, ((range.hi - price) / (range.hi - range.lo)) * (plotH - 4) + 2)) : null);
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
    <div ref={box} className="m-chart" data-visible={win.visible} data-offset={win.offset} data-manual={manual ? 1 : 0} data-lo={range ? range.lo.toFixed(2) : ""} data-hi={range ? range.hi.toFixed(2) : ""} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onContextMenu={(e) => e.preventDefault()} onDoubleClick={(e) => Date.now() - lastDouble.current > 600 && doubleTap(e.clientY)}>
      <canvas ref={canvas} style={{ width: size.w, height: size.h }} />
      <div className="m-draw-bar" onPointerDown={(e) => e.stopPropagation()}>
        <button
          className="m-draw-btn"
          onClick={() => {
            setBarOpen((v) => {
              try {
                window.localStorage.setItem('harvester.mobile.drawbar', v ? '0' : '1');
              } catch {
                /* not remembered */
              }
              return !v;
            });
            setTool('cursor');
          }}
          aria-label={barOpen ? 'Hide the drawing tools' : 'Show the drawing tools'}
          title="Drawing tools"
        >
          {barOpen ? '‹' : '✎'}
        </button>
        {barOpen &&
          (
            [
              ['cursor', '↖', 'Move the chart'],
              ['trend', '╱', 'Trend line: drag from start to end'],
              ['ray', '↗', 'Ray: drag, the line continues to the right'],
              ['hline', '─', 'Horizontal line: tap a price'],
              ['rect', '▭', 'Rectangle: drag across'],
              ['fib', 'Fib', 'Fibonacci retracement: drag from one end of a move to the other'],
              ['measure', '📏', 'Measure: drag to see the move in % and price, the bars and the time'],
            ] as Array<[Tool, string, string]>
          ).map(([t, icon, hint]) => (
            <button
              key={t}
              className={`m-draw-btn${tool === t ? ' on' : ''}`}
              onClick={() => {
                setDraft(null);
                setSelected(null);
                setTool(t);
              }}
              aria-label={hint}
              title={hint}
            >
              {icon}
            </button>
          ))}
        {barOpen && (
          <>
            {(
              <button
                className="m-draw-btn"
                disabled={selected == null}
                onClick={() => {
                  const list = drawings.filter((d) => d.id !== selected);
                  setDrawings(list);
                  saveDrawings(drawSymbol, list);
                  setSelected(null);
                }}
                aria-label="Delete the selected drawing"
                title="Delete the selected drawing: touch a drawing with the move tool first"
              >
                🗑
              </button>
            )}
            <button
              className="m-draw-btn"
              disabled={!drawings.length}
              onClick={() => {
                const list = drawings.slice(0, -1);
                setDrawings(list);
                saveDrawings(drawSymbol, list);
              }}
              aria-label="Undo the last drawing"
              title="Undo the last drawing"
            >
              ↶
            </button>
            <button
              className="m-draw-btn"
              disabled={!drawings.length}
              onClick={() => {
                void confirmDialog(`Remove all ${drawings.length} drawing${drawings.length === 1 ? '' : 's'} on ${drawSymbol}?`, { confirmLabel: 'Remove all', danger: true }).then((ok) => {
                  if (!ok) return;
                  setDrawings([]);
                  saveDrawings(drawSymbol, []);
                });
              }}
              aria-label="Remove all drawings"
              title="Remove all drawings"
            >
              ✕
            </button>
          </>
        )}
      </div>
      {range &&
        lines.map((l, i) => {
          if (!l.adjust || l.adjust.kind === 'order' || !onRemoveLine || l.price < range.lo || l.price > range.hi) return null;
          const ly = yOfPrice(l.price);
          if (ly == null) return null;
          return (
            <button
              key={`x-${i}-${l.adjust.order.orderId}`}
              className="m-line-x"
              style={{ top: ly - 13, color: l.color, borderColor: l.color }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onRemoveLine(l);
              }}
              aria-label={`Remove the ${l.label}`}
              title={`Remove the ${l.label}`}
            >
              ×
            </button>
          );
        })}
      {range &&
        pending.map((pl) => {
          if ((pl.id !== 'sl' && pl.id !== 'tp') || !onRemovePending || pl.price < range.lo || pl.price > range.hi) return null;
          const ly = yOfPrice(pl.price);
          if (ly == null) return null;
          return (
            <button key={`px-${pl.id}`} className="m-line-x" style={{ top: ly - 13, color: pl.color, borderColor: pl.color }} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onRemovePending(pl.id); }} aria-label={`Remove the ${pl.label}`} title={`Remove the ${pl.label}`}>
              ×
            </button>
          );
        })}
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
