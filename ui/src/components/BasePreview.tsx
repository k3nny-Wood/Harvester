import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { previewBoxes, type PreviewBox } from '../bases';
import { useBases } from '../basesConfig';
import { visibleZones } from '../chart/ChartBases';
import type { BaseZone, Kline, Signal } from '../types';

const W = 560;
const H = 340;
const CACHE_MS = 20_000;
const cache = new Map<string, { at: number; candles: Kline[]; zones: BaseZone[] }>();

function fmt(p: number): string {
  return p >= 100 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p.toPrecision(4);
}

function paint(canvas: HTMLCanvasElement, candles: Kline[], boxes: PreviewBox[], title: string) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const g = canvas.getContext('2d');
  if (!g || candles.length === 0) return;
  g.scale(dpr, dpr);
  g.fillStyle = '#0b0f15';
  g.fillRect(0, 0, W, H);

  const left = 8;
  const right = 78; // room for the price axis
  const top = 24;
  const bottom = 8;
  let lo = Math.min(...candles.map((c) => c.low));
  let hi = Math.max(...candles.map((c) => c.high));
  // lines far from the candles would squash them: keep only those inside a band around the visible range
  const band = (hi - lo) * 0.35;
  const shown = boxes.filter((b) => b.top >= lo - band && b.bottom <= hi + band);
  for (const b of shown) {
    lo = Math.min(lo, b.bottom);
    hi = Math.max(hi, b.top);
  }
  const pad = (hi - lo) * 0.05 || hi * 0.001;
  lo -= pad;
  hi += pad;
  const y = (p: number) => top + (1 - (p - lo) / (hi - lo)) * (H - top - bottom);
  const slot = (W - left - right) / candles.length;
  const x = (i: number) => left + i * slot + slot / 2;

  // price axis
  g.font = '10px sans-serif';
  g.fillStyle = '#7d8a9c';
  g.strokeStyle = 'rgba(255,255,255,0.06)';
  g.lineWidth = 1;
  for (let k = 0; k <= 5; k++) {
    const p = lo + ((hi - lo) * k) / 5;
    g.beginPath();
    g.moveTo(left, y(p));
    g.lineTo(W - right, y(p));
    g.stroke();
    g.fillText(fmt(p), W - right + 6, y(p) + 3);
  }
  g.fillStyle = '#c7d0dc';
  g.font = '11px sans-serif';
  g.fillText(title, left, 15);

  // zones under the candles: a shaded box with a border, and the crack level dotted below
  for (const b of shown) {
    const x0 = x(b.from);
    const x1 = b.to != null ? x(b.to) : W - right;
    const yt = y(b.top);
    const yb = y(b.bottom);
    const h = Math.max(2, yb - yt);
    g.globalAlpha = b.fill;
    g.fillStyle = '#4f8fdd';
    g.fillRect(x0, yt, x1 - x0, h);
    g.globalAlpha = 1;
    g.strokeStyle = b.color;
    g.lineWidth = b.width;
    g.setLineDash(b.dash);
    g.strokeRect(x0, yt, x1 - x0, h);
    g.setLineDash([]);
    if (b.crackLine != null) {
      g.strokeStyle = '#e0a33d';
      g.lineWidth = 1;
      g.setLineDash([2, 3]);
      g.beginPath();
      g.moveTo(x0, y(b.crackLine));
      g.lineTo(x1, y(b.crackLine));
      g.stroke();
      g.setLineDash([]);
    }
  }

  const body = Math.max(1, slot * 0.62);
  candles.forEach((c, i) => {
    const cx = x(i);
    g.strokeStyle = g.fillStyle = c.close >= c.open ? '#2e9b6f' : '#d0454b';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(cx, y(c.high));
    g.lineTo(cx, y(c.low));
    g.stroke();
    const t = y(Math.max(c.open, c.close));
    g.fillRect(cx - body / 2, t, body, Math.max(1, y(Math.min(c.open, c.close)) - t));
  });

  // labels on the right edge, last price tag
  g.font = '10px sans-serif';
  for (const b of shown) {
    if (!b.label) continue;
    g.fillStyle = b.color;
    g.fillText(b.label, W - right + 6, y(b.bottom) - 3);
  }
  const last = candles[candles.length - 1].close;
  g.fillStyle = '#f0b90b';
  g.fillRect(W - right, y(last) - 7, right - 2, 14);
  g.fillStyle = '#10151d';
  g.fillText(fmt(last), W - right + 4, y(last) + 3);
}

/** The large view shown while the pointer rests on a signal's thumbnail: recent candles with the bases (merged) drawn on them. */
function Popup({ signal, anchor }: { signal: Signal; anchor: DOMRect }) {
  const cfg = useBases((s) => s.cfg);
  const [data, setData] = useState<{ candles: Kline[]; zones: BaseZone[] } | null>(null);
  const [error, setError] = useState('');
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let alive = true;
    const key = `${signal.symbol}:${signal.timeframe}:${cfg.factor}:${cfg.crackPct}:${cfg.mergePct}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      setData(hit);
      return;
    }
    Promise.all([api.klines(signal.symbol, signal.timeframe, 240), api.qflZones(signal.symbol, signal.timeframe, cfg.factor, cfg.crackPct, cfg.mergePct)])
      .then(([candles, zones]) => {
        const entry = { at: Date.now(), candles, zones };
        cache.set(key, entry);
        if (alive) setData(entry);
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [signal.symbol, signal.timeframe, cfg.factor, cfg.crackPct, cfg.mergePct]);

  useEffect(() => {
    if (!data || !ref.current) return;
    // the preview shows more of the picture than the chart does: a wider distance and more zones
    const drawn = visibleZones(data.zones, { showBroken: cfg.showBroken, maxDistancePct: Math.max(cfg.maxDistancePct, 30), maxCount: 12 }, data.candles[data.candles.length - 1]?.close ?? 0);
    // a crack signal is about a base price has already broken: always include the zone that holds it
    const own = signal.base ? data.zones.find((z) => signal.base! >= z.low * 0.997 && signal.base! <= z.high * 1.003) : undefined;
    const shown = own && !drawn.includes(own) ? [...drawn, own] : drawn;
    const holding = shown.filter((z) => z.crackTime == null);
    const boxes = previewBoxes(data.candles, shown, signal.base, fmt);
    paint(ref.current, data.candles, boxes, `${signal.symbol} ${signal.timeframe} · ${holding.length} holding zones (volatility factor ${cfg.factor})`);
  }, [data, cfg.showBroken, cfg.maxDistancePct, cfg.factor, signal.base, signal.symbol, signal.timeframe]);

  // beside the card: to its left (the Signals panel lives at the right of the window), or to its right if there is no room
  const left = anchor.left - W - 12 >= 8 ? anchor.left - W - 12 : Math.min(window.innerWidth - W - 8, anchor.right + 12);
  const top = Math.max(8, Math.min(window.innerHeight - H - 8, anchor.top + anchor.height / 2 - H / 2));
  return createPortal(
    <div className="base-preview" style={{ left, top, width: W, height: H }}>
      {error ? <div className="warn pad">{error}</div> : !data ? <div className="muted pad">Loading…</div> : <canvas ref={ref} style={{ width: W, height: H }} />}
    </div>,
    document.body,
  );
}

/** Wrap a thumbnail: resting the pointer on it for a moment opens the large preview with the bases. */
export function WithBasePreview({ signal, children }: { signal: Signal; children: React.ReactNode }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const timer = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <div
      ref={box}
      className="thumb-wrap"
      onPointerEnter={() => {
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => box.current && setAnchor(box.current.getBoundingClientRect()), 280);
      }}
      onPointerLeave={() => {
        window.clearTimeout(timer.current);
        setAnchor(null);
      }}
    >
      {children}
      {anchor && <Popup signal={signal} anchor={anchor} />}
    </div>
  );
}
