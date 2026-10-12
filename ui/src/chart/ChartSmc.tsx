import { useEffect, useMemo, useRef, useState } from 'react';
import type { Vela } from '@luxalgo/vela';
import { api } from '../api';
import { useChart } from '../chartStore';
import { intervalMs } from '../intervals';
import { DEFAULT_SMC, useSmc, type SmcConfig } from '../smcConfig';
import type { SmcZone } from '../types';

const GREEN = '46, 155, 111';
const RED = '208, 69, 75';

export interface SmcShape {
  key: string;
  time: number;
  endTime: number;
  bottom: number;
  top: number;
  /** r, g, b of the zone colour */
  rgb: string;
  fillOpacity: number;
  dashed: boolean;
  label: string;
}

const NAMES = { fvg: 'FVG', orderBlock: 'OB', breaker: 'BB' } as const;

/** Which zones the settings want on the chart. */
export function wantedZones(zones: SmcZone[], cfg: Pick<SmcConfig, 'showFvg' | 'showOrderBlocks' | 'showBreakers'>): SmcZone[] {
  return zones.filter((z) => (z.kind === 'fvg' && cfg.showFvg) || (z.kind === 'orderBlock' && cfg.showOrderBlocks) || (z.kind === 'breaker' && cfg.showBreakers));
}

/** One box per zone, from the candle that defines it to the right, in the colour of what it is expected to do (green support, red resistance). */
export function smcShapes(symbol: string, timeframe: string, zones: SmcZone[], lengthCandles: number): SmcShape[] {
  const step = intervalMs(timeframe);
  return zones.map((z) => {
    // a zone that was tapped is drawn from what is left of it, and shaded a little less
    const label = `${NAMES[z.kind]}${z.bullish ? '↑' : '↓'}${z.partiallyMitigated ? ' tapped' : ''}`;
    return {
      key: `smc:${symbol}:${timeframe}:${z.kind}:${z.time}:${z.low}:${z.high}:L${lengthCandles}`,
      time: z.time,
      endTime: z.confirmTime + (lengthCandles > 0 ? lengthCandles : 3000) * step,
      bottom: z.low,
      top: z.high,
      rgb: z.bullish ? GREEN : RED,
      fillOpacity: z.kind === 'fvg' ? 0.1 : 0.16,
      dashed: z.kind === 'breaker',
      label,
    };
  });
}

/**
 * Smart Money zones on the chart: fair value gaps, order blocks and breaker blocks (the detectors come from MarketScanner).
 * They are patterns, not signals: nothing here says they pay, and the Lab is where that is tested.
 */
export function ChartSmc({ chart }: { chart: Vela | null }) {
  const symbol = useChart((s) => s.symbol);
  const timeframe = useChart((s) => s.timeframe);
  const cfg = useSmc((st) => st.cfg);
  const change = useSmc((st) => st.change);
  const [open, setOpen] = useState(false);
  const [zones, setZones] = useState<SmcZone[]>([]);
  const ids = useRef(new Map<string, string>());

  useEffect(() => {
    if (!cfg.on) {
      setZones([]);
      return;
    }
    let alive = true;
    const load = () =>
      api
        .smcZones(symbol, timeframe, cfg.minFvgPct, cfg.maxEach)
        .then((z) => alive && setZones(z))
        .catch(() => undefined);
    const delay = window.setTimeout(() => void load(), 250);
    const t = window.setInterval(load, 20_000);
    return () => {
      alive = false;
      window.clearTimeout(delay);
      window.clearInterval(t);
    };
  }, [symbol, timeframe, cfg.on, cfg.minFvgPct, cfg.maxEach]);

  const shown = useMemo(() => wantedZones(zones, cfg), [zones, cfg]);

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
    const shapes = cfg.on ? smcShapes(symbol, timeframe, shown, cfg.lengthCandles) : [];
    for (const s of shapes) {
      if (ids.current.has(s.key)) continue;
      const d = chart.drawings.add('box', {
        paneId: 'price',
        anchors: [
          { time: s.time, price: s.top },
          { time: s.endTime, price: s.bottom },
        ],
        style: { lineColor: `rgba(${s.rgb}, 0.9)`, lineWidth: 1, lineStyle: s.dashed ? 'dashed' : 'solid', fillColor: `rgba(${s.rgb}, ${s.fillOpacity})`, fillOpacity: 1 },
        text: { value: s.label, color: `rgb(${s.rgb})`, size: 'tiny', hAlign: 'left', vAlign: 'top' },
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

  const count = (kind: SmcZone['kind']) => zones.filter((z) => z.kind === kind).length;
  return (
    <>
      <div className="smc-bar">
        <button className={`smc-btn${cfg.on ? ' on' : ''}`} onClick={() => change({ on: !cfg.on })} title="Smart Money zones: fair value gaps, order blocks, breaker blocks">
          SMC{cfg.on ? ` (${shown.length})` : ''}
        </button>
        <button className="bases-gear" onClick={() => setOpen((v) => !v)} title="Smart Money settings">
          ⚙
        </button>
      </div>
      {open && (
        <div className="bases-pop smc-pop" onPointerDown={(e) => e.stopPropagation()}>
          <label className="check">
            <input type="checkbox" checked={cfg.showFvg} onChange={(e) => change({ showFvg: e.target.checked })} /> Fair value gaps ({count('fvg')})
          </label>
          <label className="check">
            <input type="checkbox" checked={cfg.showOrderBlocks} onChange={(e) => change({ showOrderBlocks: e.target.checked })} /> Order blocks ({count('orderBlock')})
          </label>
          <label className="check">
            <input type="checkbox" checked={cfg.showBreakers} onChange={(e) => change({ showBreakers: e.target.checked })} /> Breaker blocks ({count('breaker')})
          </label>
          <small>Green = expected support, red = expected resistance. A zone shrinks as price taps into it and disappears once it is fully used.</small>
          <label>
            <span>
              Smallest gap <b>{cfg.minFvgPct}%</b>
            </span>
            <input type="range" min={0.1} max={3} step={0.1} value={cfg.minFvgPct} onChange={(e) => change({ minFvgPct: Number(e.target.value) })} />
          </label>
          <label>
            <span>
              At most <b>{cfg.maxEach}</b> of each kind (the newest)
            </span>
            <input type="range" min={1} max={30} step={1} value={cfg.maxEach} onChange={(e) => change({ maxEach: Number(e.target.value) })} />
          </label>
          <label>
            <span>
              Zone length <b>{cfg.lengthCandles === 0 ? 'to the edge' : `${cfg.lengthCandles} candles`}</b>
            </span>
            <input type="range" min={0} max={200} step={5} value={cfg.lengthCandles} onChange={(e) => change({ lengthCandles: Number(e.target.value) })} />
          </label>
          <small>These are patterns, not signals. The Lab tests whether they add anything.</small>
          <button onClick={() => change({ ...DEFAULT_SMC, on: cfg.on })}>Reset</button>
        </div>
      )}
    </>
  );
}
