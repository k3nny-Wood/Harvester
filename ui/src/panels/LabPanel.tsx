import { useEffect, useMemo, useRef, useState } from 'react';
import { api, hasBackend, onLabProgress } from '../api';
import type { LabAccountResult, LabConfig, LabProgress, LabReport } from '../types';
import { useApp } from '../store';

/** The same numbers as `LabConfig::default()` in the core crate (V2 live), used until the backend answers. */
const FALLBACK: LabConfig = {
  leverage: 3,
  stopPct: 30,
  layers: 3,
  spacingPct: 1,
  weights: [2, 4, 7],
  crackPct: 0.5,
  volatilityFactor: 1,
  sellLayers: 4,
  sellOffsetPct: -1,
  sellGapPct: 1,
  feePct: 0.04,
  fillThroughPct: 0.05,
  fundingPct8h: 0.01,
  mmrPct: 0.5,
  donchLen: 288,
  donchMaxPos: 0.15,
  gateOn: true,
  gateDays: 30,
  gateMinPct: 10,
  startEquity: 1000,
  maxLadders: 25,
  allocPct: 3.6,
  maxBudget: 500,
  marginCapPct: 90,
};

const KEY = 'harvester.lab.v1';

function load(): { cfg: LabConfig; days: number; universe: number } {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return { cfg: { ...FALLBACK, ...p.cfg }, days: p.days ?? 90, universe: p.universe ?? 40 };
    }
  } catch {
    /* use the defaults */
  }
  return { cfg: FALLBACK, days: 90, universe: 40 };
}

export function pct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '∞';
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

export function dateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A small equity line with the start level marked. */
function Curve({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 600;
  const h = 90;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - ((v - lo) / span) * (h - 6) - 3).toFixed(1)}`).join(' ');
  const start = values[0];
  const y0 = h - ((start - lo) / span) * (h - 6) - 3;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="lab-curve" preserveAspectRatio="none">
      <line x1={0} x2={w} y1={y0} y2={y0} stroke="var(--line)" strokeDasharray="3 4" />
      <polyline points={pts} fill="none" stroke={values[values.length - 1] >= start ? 'var(--up)' : 'var(--down)'} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Num({ label, value, onChange, step = 1, min, title }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; title?: string }) {
  return (
    <label className="lab-field" title={title}>
      <span>{label}</span>
      <input type="number" value={Number.isFinite(value) ? value : 0} step={step} min={min} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function Stat({ label, value, tone, title }: { label: string; value: string; tone?: 'up' | 'down'; title?: string }) {
  return (
    <div className="lab-stat" title={title}>
      <span>{label}</span>
      <b className={tone}>{value}</b>
    </div>
  );
}

function Account({ title, r }: { title: string; r: LabAccountResult }) {
  const winRate = r.closed ? (r.wins / r.closed) * 100 : 0;
  return (
    <div className="lab-card">
      <h4>{title}</h4>
      <div className="lab-stats">
        <Stat label="Return" value={pct(r.returnPct)} tone={r.returnPct >= 0 ? 'up' : 'down'} />
        <Stat label="Max drawdown" value={`${r.maxDrawdownPct.toFixed(1)}%`} title="Worst fall from a peak, counting ladders that were still open" tone="down" />
        <Stat label="Profit factor" value={r.profitFactor == null ? '∞' : r.profitFactor.toFixed(2)} title="Gross profit / gross loss of the closed ladders" />
        <Stat label="Ladders" value={`${r.ladders}`} title={`${r.skipped} more were skipped (cap, margin, or the symbol already had one)`} />
        <Stat label="Win rate" value={`${winRate.toFixed(0)}%`} title={`${r.wins} of ${r.closed} closed ladders`} />
        <Stat label="Stops / liq." value={`${r.stops}`} />
      </div>
    </div>
  );
}

/** Backtest the QFL ladder as one shared account, with the luck test, start-date spread and stressed costs next to the headline. */
export function LabPanel() {
  const saved = useMemo(load, []);
  const [cfg, setCfg] = useState<LabConfig>(saved.cfg);
  const [days, setDays] = useState(saved.days);
  const [universe, setUniverse] = useState(saved.universe);
  const [weightsText, setWeightsText] = useState(saved.cfg.weights.join(', '));
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<LabProgress | null>(null);
  const [report, setReport] = useState<LabReport | null>(null);
  const [error, setError] = useState('');
  const toast = useApp((s) => s.toast);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let off: (() => void) | undefined;
    if (hasBackend) void onLabProgress((p) => mounted.current && setProgress(p)).then((o) => (off = o));
    return () => {
      mounted.current = false;
      off?.();
    };
  }, []);

  const set = (patch: Partial<LabConfig>) => setCfg((c) => ({ ...c, ...patch }));

  const run = async () => {
    const weights = weightsText
      .split(/[,\s]+/)
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0);
    const config = { ...cfg, weights: weights.length ? weights : [1] };
    try {
      window.localStorage.setItem(KEY, JSON.stringify({ cfg: config, days, universe }));
    } catch {
      /* not remembered */
    }
    setRunning(true);
    setError('');
    setReport(null);
    try {
      const r = await api.labRun({ config, days, universe, luckRuns: 30 });
      if (mounted.current) setReport(r);
    } catch (e) {
      if (mounted.current) setError(String(e));
      toast(`Lab: ${e}`, 'warn');
    } finally {
      if (mounted.current) setRunning(false);
    }
  };

  const reset = () => {
    setCfg(FALLBACK);
    setWeightsText(FALLBACK.weights.join(', '));
  };

  const pctDone = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : null;

  return (
    <div className="panel lab">
      <div className="lab-form">
        <div className="lab-row">
          <label className="lab-field">
            <span>Test the last</span>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {[30, 60, 90, 120, 180].map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </label>
          <label className="lab-field">
            <span>Coins</span>
            <select value={universe} onChange={(e) => setUniverse(Number(e.target.value))}>
              {[20, 40, 80].map((n) => (
                <option key={n} value={n}>
                  top {n} by volume
                </option>
              ))}
            </select>
          </label>
          <Num label="Leverage x" value={cfg.leverage} onChange={(v) => set({ leverage: v })} min={1} title="Whole numbers on Binance" />
          <Num label="Stop % below base" value={cfg.stopPct} onChange={(v) => set({ stopPct: v })} min={0} title="0 = no stop" />
          <Num label="Buy layers" value={cfg.layers} onChange={(v) => set({ layers: Math.max(1, Math.round(v)) })} min={1} />
          <Num label="Layer gap %" value={cfg.spacingPct} onChange={(v) => set({ spacingPct: v })} step={0.1} />
          <label className="lab-field" title="Relative size of each layer, e.g. 2, 4, 7">
            <span>Layer weights</span>
            <input value={weightsText} onChange={(e) => setWeightsText(e.target.value)} />
          </label>
          <Num label="Crack %" value={cfg.crackPct} onChange={(v) => set({ crackPct: v })} step={0.1} title="How far below the base the first buy sits" />
        </div>
        <div className="lab-row">
          <Num label="Sell layers" value={cfg.sellLayers} onChange={(v) => set({ sellLayers: Math.max(1, Math.round(v)) })} min={1} />
          <Num label="First sell % above base" value={-cfg.sellOffsetPct} onChange={(v) => set({ sellOffsetPct: -v })} step={0.1} title="Negative puts the first sell below the base" />
          <Num label="Sell gap %" value={cfg.sellGapPct} onChange={(v) => set({ sellGapPct: v })} step={0.1} />
          <Num label="Per ladder % of equity" value={cfg.allocPct} onChange={(v) => set({ allocPct: v })} step={0.1} />
          <Num label="Max ladders" value={cfg.maxLadders} onChange={(v) => set({ maxLadders: Math.max(1, Math.round(v)) })} min={1} />
          <Num label="Fee % per side" value={cfg.feePct} onChange={(v) => set({ feePct: v })} step={0.01} />
          <label className="lab-field check" title="Only open ladders when the pool of coins is rising (their average trailing return)">
            <input type="checkbox" checked={cfg.gateOn} onChange={(e) => set({ gateOn: e.target.checked })} /> Market gate
          </label>
          <Num label="Gate days" value={cfg.gateDays} onChange={(v) => set({ gateDays: Math.max(1, Math.round(v)) })} min={1} />
          <Num label="Gate ≥ %" value={cfg.gateMinPct} onChange={(v) => set({ gateMinPct: v })} />
          <Num label="Donchian bars (0 = off)" value={cfg.donchLen} onChange={(v) => set({ donchLen: Math.max(0, Math.round(v)) })} min={0} title="Only a base in the lowest part of the last N candles" />
          <Num label="Donchian max pos" value={cfg.donchMaxPos} onChange={(v) => set({ donchMaxPos: v })} step={0.05} title="0.15 = the lowest 15% of the range" />
        </div>
        <div className="lab-row">
          {running ? (
            <button className="danger" onClick={() => void api.labCancel()}>
              Cancel
            </button>
          ) : (
            <button className="primary" disabled={!hasBackend} onClick={() => void run()}>
              Run backtest
            </button>
          )}
          <button onClick={reset} disabled={running} title="Back to the V2 live setting">
            V2 live setting
          </button>
          {running && (
            <span className="muted">
              {progress?.phase ?? 'starting'}
              {pctDone != null ? ` ${progress!.done}/${progress!.total}` : ''}…
              {progress?.phase === 'downloading candles' && ' (first run downloads history politely; later runs reuse the cache)'}
            </span>
          )}
          {error && <span className="warn">{error}</span>}
        </div>
      </div>

      {report && (
        <div className="lab-out">
          <div className="muted lab-window">
            {dateOf(report.windowStartMs)} → {dateOf(report.windowEndMs)} · {report.symbols} coins · {report.setups} setups passed the filters · 15 m candles · one shared account of {cfg.startEquity} USDT
          </div>
          <div className="lab-grid">
            <Account title="Backtest" r={report.base} />
            <Account title="Stressed costs (fee 0.06%, slippage 0.25%, funding 0.02%)" r={report.stressed} />
            <div className="lab-card">
              <h4>Luck test</h4>
              <p className="muted">Runs the account {report.luck.runs} times with a random {Math.round(100 - report.luck.keptPct)}% of the setups removed.</p>
              <div className="lab-stats">
                <Stat label="Median return" value={pct(report.luck.medianReturnPct)} tone={report.luck.medianReturnPct >= 0 ? 'up' : 'down'} />
                <Stat label="Bad luck (10th pct)" value={pct(report.luck.p10ReturnPct)} tone={report.luck.p10ReturnPct >= 0 ? 'up' : 'down'} />
                <Stat label="Median drawdown" value={`${report.luck.medianDrawdownPct.toFixed(1)}%`} tone="down" />
              </div>
            </div>
            <div className="lab-card">
              <h4>Start dates</h4>
              <p className="muted">The same account started on eight different days. Worst: {pct(report.worstStartReturnPct)}.</p>
              <table className="lab-table">
                <tbody>
                  {report.starts.map((s) => (
                    <tr key={s.startMs}>
                      <td>{dateOf(s.startMs)}</td>
                      <td className={s.returnPct >= 0 ? 'up' : 'down'}>{pct(s.returnPct)}</td>
                      <td className="muted">DD {s.maxDrawdownPct.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="lab-card">
            <h4>Account value</h4>
            <Curve values={report.base.equity} />
          </div>
          <ul className="lab-notes">
            {report.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
      {!report && !running && !error && (
        <p className="muted pad">
          Backtests the QFL ladder on recent public candles as one shared account (cap on open ladders, budget per ladder, drawdown counting open ladders). Treat one flattering number with suspicion: the luck test,
          the start dates and the stressed costs show how fragile it is. Nothing here places an order.
        </p>
      )}
    </div>
  );
}
