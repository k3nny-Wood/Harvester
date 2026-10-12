import { useEffect, useMemo, useRef, useState } from 'react';
import type { Vela } from '@luxalgo/vela';
import { api } from '../api';
import { useChart } from '../chartStore';
import type { BaseView } from '../types';

const HOLDING = '#4fa3ff';
const CRACKED = 'rgba(79, 163, 255, 0.38)';
const LEVEL = '#e0a33d';
const KEY = 'harvester.bases.v2';

/** How the bases are found and which ones are drawn. Remembered between runs. */
export interface BasesConfig {
  on: boolean;
  /** a base needs a pump of at least this many times the coin's normal candle move: higher = fewer, bigger bases */
  factor: number;
  /** a crack is a break this far below the base, percent */
  crackPct: number;
  /** draw the bases price already broke through */
  showBroken: boolean;
  /** only bases within this % of the price (0 = all) */
  maxDistancePct: number;
  /** draw at most this many, the ones nearest to the price (0 = all) */
  maxCount: number;
}

export const DEFAULT_BASES: BasesConfig = { on: true, factor: 3, crackPct: 0.5, showBroken: false, maxDistancePct: 15, maxCount: 8 };

function load(): BasesConfig {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_BASES, ...(JSON.parse(raw) as Partial<BasesConfig>) };
  } catch {
    /* use the defaults */
  }
  return DEFAULT_BASES;
}

/** What to draw for one base: a horizontal ray while it holds (with its crack level), a short dim line once price broke it. */
export interface BaseShape {
  key: string;
  kind: 'holding' | 'level' | 'cracked';
  time: number;
  endTime?: number;
  price: number;
}

/** The bases worth drawing under the settings: broken ones only if asked for, only those near the price, and at most `maxCount`. */
export function visibleBases(bases: BaseView[], cfg: Pick<BasesConfig, 'showBroken' | 'maxDistancePct' | 'maxCount'>, last: number): BaseView[] {
  const kept = bases.filter((b) => {
    if (b.crackTime != null && !cfg.showBroken) return false;
    if (cfg.maxDistancePct > 0 && last > 0 && Math.abs(b.price / last - 1) * 100 > cfg.maxDistancePct) return false;
    return true;
  });
  if (cfg.maxCount <= 0 || kept.length <= cfg.maxCount || !(last > 0)) return kept;
  // the nearest to the price win; the rest stay out of the way
  const nearest = [...kept].sort((a, b) => Math.abs(a.price / last - 1) - Math.abs(b.price / last - 1)).slice(0, cfg.maxCount);
  return kept.filter((b) => nearest.includes(b));
}

export function baseShapes(symbol: string, timeframe: string, bases: BaseView[]): BaseShape[] {
  const out: BaseShape[] = [];
  for (const b of bases) {
    const id = `base:${symbol}:${timeframe}:${b.time}`;
    if (b.crackTime == null) {
      out.push({ key: `${id}:hold`, kind: 'holding', time: b.time, price: b.price });
      out.push({ key: `${id}:level`, kind: 'level', time: b.confirmTime, price: b.crackLevel });
    } else {
      out.push({ key: `${id}:cracked:${b.crackTime}`, kind: 'cracked', time: b.time, endTime: b.crackTime, price: b.price });
    }
  }
  return out;
}

/**
 * QFL bases on the chart: every confirmed base of the symbol / timeframe as a horizontal line from the candle where it formed.
 * A base that still holds is a bright ray running to the right with its crack level dotted below it; a base price already broke
 * is a dim line that stops at the crack (hidden unless asked for). They are Vela drawings, so they follow pan and zoom.
 * The button opens the settings: the volatility factor decides how big a pump has to be, so raising it removes the small bases.
 */
export function ChartBases({ chart }: { chart: Vela | null }) {
  const symbol = useChart((s) => s.symbol);
  const timeframe = useChart((s) => s.timeframe);
  const last = useChart((s) => s.markPrice);
  const [cfg, setCfg] = useState<BasesConfig>(load);
  const [open, setOpen] = useState(false);
  const [bases, setBases] = useState<BaseView[]>([]);
  const ids = useRef(new Map<string, string>());

  const change = (patch: Partial<BasesConfig>) =>
    setCfg((c) => {
      const next = { ...c, ...patch };
      try {
        window.localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* not remembered */
      }
      return next;
    });

  // the detector runs in Rust over the latest 1000 candles; asked again when the settings change and every 20 s
  useEffect(() => {
    if (!cfg.on) {
      setBases([]);
      return;
    }
    let alive = true;
    const load = () =>
      api
        .qflBases(symbol, timeframe, cfg.factor, cfg.crackPct)
        .then((b) => alive && setBases(b))
        .catch(() => undefined);
    const delay = window.setTimeout(() => void load(), 250); // a slider drag settles first
    const t = window.setInterval(load, 20_000);
    return () => {
      alive = false;
      window.clearTimeout(delay);
      window.clearInterval(t);
    };
  }, [symbol, timeframe, cfg.on, cfg.factor, cfg.crackPct]);

  const shown = useMemo(() => visibleBases(bases, cfg, last), [bases, cfg, last]);

  // another market (or switched off): take our lines off the chart before the next ones are drawn
  useEffect(() => {
    return () => {
      if (!chart) return;
      const all = [...ids.current.values()];
      if (all.length) chart.drawings.removeMany(all);
      ids.current.clear();
    };
  }, [chart, symbol, timeframe, cfg.on]);

  useEffect(() => {
    if (!chart) return;
    const shapes = cfg.on ? baseShapes(symbol, timeframe, shown) : [];
    for (const s of shapes) {
      if (ids.current.has(s.key)) continue;
      const style = s.kind === 'holding' ? { lineColor: HOLDING, lineWidth: 2, lineStyle: 'solid' as const } : s.kind === 'level' ? { lineColor: LEVEL, lineWidth: 1, lineStyle: 'dotted' as const } : { lineColor: CRACKED, lineWidth: 1, lineStyle: 'dashed' as const };
      const d =
        s.kind === 'cracked'
          ? chart.drawings.add('trendline', { paneId: 'price', anchors: [{ time: s.time, price: s.price }, { time: s.endTime ?? s.time, price: s.price }], style })
          : chart.drawings.add('hray', { paneId: 'price', anchors: [{ time: s.time, price: s.price }], style });
      if (d) ids.current.set(s.key, d.id);
    }
    const wanted = new Set(shapes.map((s) => s.key));
    for (const [key, id] of [...ids.current.entries()]) {
      if (!wanted.has(key)) {
        chart.drawings.remove(id);
        ids.current.delete(key);
      }
    }
  }, [chart, shown, cfg.on, symbol, timeframe]);

  const holding = shown.filter((b) => b.crackTime == null).length;
  return (
    <>
      <div className="bases-bar">
        <button className={`bases-btn${cfg.on ? ' on' : ''}`} onClick={() => change({ on: !cfg.on })} title="Show / hide the QFL bases: lines at the swing lows price pumped away from">
          Bases{cfg.on ? ` (${holding})` : ''}
        </button>
        <button className="bases-gear" onClick={() => setOpen((v) => !v)} title="Base settings: volatility factor, crack %, distance">
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
            <small>A base needs a pump of this many times the coin's normal candle move. Higher = fewer, bigger bases (V2 trades with 1).</small>
          </label>
          <label>
            <span>
              Crack % <b>{cfg.crackPct}</b>
            </span>
            <input type="range" min={0.1} max={3} step={0.1} value={cfg.crackPct} onChange={(e) => change({ crackPct: Number(e.target.value) })} />
            <small>How far below a base price must trade to count as a crack (the dotted line).</small>
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
          <label className="check">
            <input type="checkbox" checked={cfg.showBroken} onChange={(e) => change({ showBroken: e.target.checked })} /> Also draw broken bases (dim)
          </label>
          <div className="muted">
            {bases.length} found, {shown.length} drawn
          </div>
          <button onClick={() => change({ ...DEFAULT_BASES, on: cfg.on })}>Reset</button>
        </div>
      )}
    </>
  );
}
