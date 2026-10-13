import { useEffect, useRef, useState } from 'react';
import type { IndicatorHandle, Vela } from '@luxalgo/vela';

const KEY = 'harvester.volumeProfile.v1';
const CFG_KEY = 'harvester.volumeProfile.cfg.v1';

export interface ProfileConfig {
  /** how much of the chart's width the longest bar may take, in percent */
  width: number;
  /** strength of the bars in percent: 100 = the library's own opacity */
  opacity: number;
}

export const DEFAULT_PROFILE: ProfileConfig = { width: 30, opacity: 25 };

const UP = [41, 98, 255];
const DOWN = [242, 54, 69];

/** The indicator inputs for a configuration: bar length, and the library's bar colours at the chosen strength (it paints them at its own opacity on top). */
export function profileInputs(cfg: ProfileConfig): { widthPct: number; upColor: string; downColor: string } {
  const a = Math.min(1, Math.max(0.02, cfg.opacity / 100));
  const rgba = (c: number[]) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${Number(a.toFixed(3))})`;
  return { widthPct: Math.round(Math.min(90, Math.max(5, cfg.width))), upColor: rgba(UP), downColor: rgba(DOWN) };
}

function loadOn(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function loadCfg(): ProfileConfig {
  try {
    const raw = window.localStorage.getItem(CFG_KEY);
    if (raw) return { ...DEFAULT_PROFILE, ...(JSON.parse(raw) as Partial<ProfileConfig>) };
  } catch {
    /* defaults */
  }
  return DEFAULT_PROFILE;
}

/**
 * Visible-range volume profile: how much traded at each price level of what is on screen (horizontal bars at the side of the chart, the
 * point of control and the value area marked). It is the chart library's own `vpvr` indicator, so it follows panning and zooming by itself.
 * A switch and a small settings menu (bar length and opacity), both remembered between runs.
 */
export function ChartVolumeProfile({ chart }: { chart: Vela | null }) {
  const [on, setOn] = useState(loadOn);
  const [cfg, setCfg] = useState(loadCfg);
  const [open, setOpen] = useState(false);
  const handle = useRef<IndicatorHandle | null>(null);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  useEffect(() => {
    if (!chart) return;
    if (on) {
      try {
        handle.current = chart.addNativeIndicator('vpvr', { inputs: profileInputs(cfgRef.current) });
      } catch {
        handle.current = null;
      }
    }
    return () => {
      try {
        handle.current?.remove();
      } catch {
        /* the chart is already gone */
      }
      handle.current = null;
    };
  }, [chart, on]);

  // a changed setting reaches the profile at once
  useEffect(() => {
    try {
      handle.current?.setInputs(profileInputs(cfg));
    } catch {
      /* not mounted */
    }
  }, [cfg]);

  const toggle = () => {
    const next = !on;
    setOn(next);
    try {
      window.localStorage.setItem(KEY, next ? '1' : '0');
    } catch {
      /* not remembered */
    }
  };

  const change = (patch: Partial<ProfileConfig>) =>
    setCfg((c) => {
      const next = { ...c, ...patch };
      try {
        window.localStorage.setItem(CFG_KEY, JSON.stringify(next));
      } catch {
        /* not remembered */
      }
      return next;
    });

  return (
    <>
      <div className="vp-bar">
        <button className={`smc-btn${on ? ' on' : ''}`} onClick={toggle} title="Volume profile of the visible range: volume traded at each price, with the point of control and value area">
          VP
        </button>
        <button className="bases-gear" onClick={() => setOpen((v) => !v)} title="Volume profile settings">
          ⚙
        </button>
      </div>
      {open && (
        <div className="bases-pop vp-pop" onPointerDown={(e) => e.stopPropagation()}>
          <label>
            <span>
              Bar length <b>{cfg.width}%</b> of the chart
            </span>
            <input type="range" min={5} max={90} step={1} value={cfg.width} onChange={(e) => change({ width: Number(e.target.value) })} />
          </label>
          <label>
            <span>
              Opacity <b>{cfg.opacity}%</b>
            </span>
            <input type="range" min={5} max={100} step={1} value={cfg.opacity} onChange={(e) => change({ opacity: Number(e.target.value) })} />
          </label>
          <button onClick={() => change(DEFAULT_PROFILE)}>Reset</button>
        </div>
      )}
    </>
  );
}
