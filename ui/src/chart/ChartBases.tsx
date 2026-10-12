import { useEffect, useMemo, useRef, useState } from 'react';
import type { Vela } from '@luxalgo/vela';
import { api } from '../api';
import { zoneDistancePct, zoneEdges, zoneLabel, zoneStrength } from '../bases';
import { useBases, DEFAULT_BASES, type BasesConfig } from '../basesConfig';
import { useChart } from '../chartStore';
import { intervalMs } from '../intervals';
import type { BaseZone } from '../types';

const HOLDING = '#4fa3ff';
const BROKEN = 'rgba(79, 163, 255, 0.55)';
const LEVEL = '#e0a33d';

/** What to draw for one zone: a box while it holds (with its crack level dotted below), a dim, shorter box once price broke it. */
export interface ZoneShape {
  key: string;
  kind: 'holding' | 'level' | 'broken';
  time: number;
  endTime: number;
  bottom: number;
  top: number;
  fillOpacity: number;
  lineWidth: number;
  label: string;
}

/**
 * The zones worth drawing under the settings. The distance and count limits keep the zones that still hold readable; a broken zone is
 * history, drawn dim and short, and is never dropped by them (only switched off as a whole with `showBroken`).
 */
export function visibleZones(zones: BaseZone[], cfg: Pick<BasesConfig, 'showBroken' | 'maxDistancePct' | 'maxCount'>, last: number): BaseZone[] {
  const broken = cfg.showBroken ? zones.filter((z) => z.crackTime != null) : [];
  const holding = zones.filter((z) => z.crackTime == null && !(cfg.maxDistancePct > 0 && last > 0 && zoneDistancePct(z, last) > cfg.maxDistancePct));
  let kept = holding;
  if (cfg.maxCount > 0 && holding.length > cfg.maxCount && last > 0) {
    // the nearest to the price win; the rest stay out of the way
    const nearest = [...holding].sort((a, b) => zoneDistancePct(a, last) - zoneDistancePct(b, last)).slice(0, cfg.maxCount);
    kept = holding.filter((z) => nearest.includes(z));
  }
  return [...broken, ...kept].sort((a, b) => a.time - b.time);
}

/** `lengthCandles` of 0 runs a holding zone far to the right (to the edge of the chart). */
export function zoneShapes(symbol: string, timeframe: string, zones: BaseZone[], lengthCandles = 0): ZoneShape[] {
  const step = intervalMs(timeframe);
  const out: ZoneShape[] = [];
  for (const z of zones) {
    const { bottom, top } = zoneEdges(z);
    // everything that changes the picture is part of the key, so a zone that gains a base or a retest is redrawn
    const id = `zone:${symbol}:${timeframe}:${z.time}:${z.low}:${z.high}:B${z.bases}:T${z.touches}:L${lengthCandles}`;
    if (z.crackTime != null) {
      out.push({ key: `${id}:broken:${z.crackTime}`, kind: 'broken', time: z.time, endTime: z.crackTime, bottom, top, fillOpacity: 0.05, lineWidth: 1, label: zoneLabel(z) });
    } else {
      const end = z.time + (lengthCandles > 0 ? lengthCandles : 3000) * step;
      out.push({ key: `${id}:zone`, kind: 'holding', time: z.time, endTime: end, bottom, top, fillOpacity: 0.04 + 0.13 * zoneStrength(z), lineWidth: z.bases > 1 ? 2 : 1, label: zoneLabel(z) });
      out.push({ key: `${id}:level`, kind: 'level', time: z.confirmTime, endTime: end, bottom: z.crackLevel, top: z.crackLevel, fillOpacity: 0, lineWidth: 1, label: '' });
    }
  }
  return out;
}

/**
 * QFL support zones on the chart. A base is a swing low that price pumped away from; bases at nearly the same price are one level
 * that has held more than once, so they are drawn as ONE box (lowest to highest base) that starts at the oldest, darker the more bases
 * and retests it has, with its crack level dotted just below. A zone price already broke is a dim box that stops at the crack.
 * They are Vela drawings, so they follow the chart when it is panned and zoomed. The gear opens the settings.
 */
export function ChartBases({ chart }: { chart: Vela | null }) {
  const symbol = useChart((s) => s.symbol);
  const timeframe = useChart((s) => s.timeframe);
  const last = useChart((s) => s.markPrice);
  const cfg = useBases((st) => st.cfg);
  const change = useBases((st) => st.change);
  const [open, setOpen] = useState(false);
  const [zones, setZones] = useState<BaseZone[]>([]);
  const ids = useRef(new Map<string, string>());

  // the detector runs in Rust over the latest 1000 candles; asked again when the settings change and every 20 s
  useEffect(() => {
    if (!cfg.on) {
      setZones([]);
      return;
    }
    let alive = true;
    const load = () =>
      api
        .qflZones(symbol, timeframe, cfg.factor, cfg.crackPct, cfg.mergePct)
        .then((z) => alive && setZones(z))
        .catch(() => undefined);
    const delay = window.setTimeout(() => void load(), 250); // a slider drag settles first
    const t = window.setInterval(load, 20_000);
    return () => {
      alive = false;
      window.clearTimeout(delay);
      window.clearInterval(t);
    };
  }, [symbol, timeframe, cfg.on, cfg.factor, cfg.crackPct, cfg.mergePct]);

  const shown = useMemo(() => visibleZones(zones, cfg, last), [zones, cfg, last]);

  // another market (or switched off): take our drawings off the chart before the next ones are drawn
  useEffect(() => {
    return () => {
      if (!chart) return;
      const all = [...ids.current.values()];
      if (all.length) chart.drawings.removeMany(all);
      ids.current.clear();
    };
  }, [chart, symbol, timeframe, cfg.on, cfg.lengthCandles]);

  useEffect(() => {
    if (!chart) return;
    const shapes = cfg.on ? zoneShapes(symbol, timeframe, shown, cfg.lengthCandles) : [];
    for (const s of shapes) {
      if (ids.current.has(s.key)) continue;
      const d =
        s.kind === 'level'
          ? chart.drawings.add('trendline', { paneId: 'price', anchors: [{ time: s.time, price: s.bottom }, { time: s.endTime, price: s.bottom }], style: { lineColor: LEVEL, lineWidth: 1, lineStyle: 'dotted' } })
          : chart.drawings.add('box', {
              paneId: 'price',
              anchors: [
                { time: s.time, price: s.top },
                { time: s.endTime, price: s.bottom },
              ],
              style: { lineColor: s.kind === 'holding' ? HOLDING : BROKEN, lineWidth: s.lineWidth, lineStyle: s.kind === 'holding' ? 'solid' : 'dashed', fillColor: `rgba(79, 163, 255, ${s.fillOpacity.toFixed(3)})`, fillOpacity: 1 },
              text: s.label ? { value: s.label, color: '#cfe3ff', size: 'tiny', hAlign: 'left', vAlign: 'top' } : undefined,
            });
      if (d) ids.current.set(s.key, d.id);
    }
    const wanted = new Set(shapes.map((s) => s.key));
    for (const [key, id] of [...ids.current.entries()]) {
      if (!wanted.has(key)) {
        chart.drawings.remove(id);
        ids.current.delete(key);
      }
    }
  }, [chart, shown, cfg.on, cfg.lengthCandles, symbol, timeframe]);

  const holding = shown.filter((z) => z.crackTime == null).length;
  const merged = zones.filter((z) => z.bases > 1).length;
  return (
    <>
      <div className="bases-bar">
        <button className={`bases-btn${cfg.on ? ' on' : ''}`} onClick={() => change({ on: !cfg.on })} title="Show / hide the QFL support zones: boxes at the swing lows price pumped away from">
          Bases{cfg.on ? ` (${holding})` : ''}
        </button>
        <button className="bases-gear" onClick={() => setOpen((v) => !v)} title="Base settings: volatility factor, crack %, merging, distance">
          ⚙
        </button>
      </div>
      {open && (
        <div className="bases-pop" onPointerDown={(e) => e.stopPropagation()}>
          <label>
            <span>
              Volatility factor <b>{cfg.factor}</b>
            </span>
            <input type="range" min={0.5} max={8} step={0.25} value={cfg.factor} onChange={(e) => change({ factor: Number(e.target.value) })} />
            <small>A base needs a pump of this many times the coin's normal candle move. Higher = fewer, bigger bases (V2 trades with 1). Applies to every chart.</small>
          </label>
          <label>
            <span>
              Crack % <b>{cfg.crackPct}</b>
            </span>
            <input type="range" min={0.1} max={3} step={0.1} value={cfg.crackPct} onChange={(e) => change({ crackPct: Number(e.target.value) })} />
            <small>How far below a zone price must trade to count as a crack (the dotted line).</small>
          </label>
          <label>
            <span>
              Merge bases within <b>{cfg.mergePct === 0 ? 'off' : `${cfg.mergePct}%`}</b>
            </span>
            <input type="range" min={0} max={3} step={0.1} value={cfg.mergePct} onChange={(e) => change({ mergePct: Number(e.target.value) })} />
            <small>Bases at nearly the same price are one level that held more than once: one box, darker with more bases and retests. A level price already cracked starts over.</small>
          </label>
          <label>
            <span>
              Only within <b>{cfg.maxDistancePct === 0 ? 'any distance' : `${cfg.maxDistancePct}% of price`}</b>
            </span>
            <input type="range" min={0} max={50} step={1} value={cfg.maxDistancePct} onChange={(e) => change({ maxDistancePct: Number(e.target.value) })} />
          </label>
          <label>
            <span>
              Draw at most <b>{cfg.maxCount === 0 ? 'all' : `${cfg.maxCount} nearest`}</b>
            </span>
            <input type="range" min={0} max={40} step={1} value={cfg.maxCount} onChange={(e) => change({ maxCount: Number(e.target.value) })} />
          </label>
          <label>
            <span>
              Box length <b>{cfg.lengthCandles === 0 ? 'to the edge' : `${cfg.lengthCandles} candles`}</b>
            </span>
            <input type="range" min={0} max={200} step={5} value={cfg.lengthCandles} onChange={(e) => change({ lengthCandles: Number(e.target.value) })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={cfg.showBroken} onChange={(e) => change({ showBroken: e.target.checked })} /> Keep broken zones on the chart (dim)
          </label>
          <div className="muted">
            {zones.length} zones found, {merged} made of several bases, {shown.length} drawn
          </div>
          <button onClick={() => change({ ...DEFAULT_BASES, on: cfg.on })}>Reset</button>
        </div>
      )}
    </>
  );
}
