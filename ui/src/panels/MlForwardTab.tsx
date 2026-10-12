import { useEffect, useRef, useState } from 'react';
import { api, inTauri, onLabProgress } from '../api';
import type { LabProgress, MlForwardReport, MlForwardStats } from '../types';
import { dateOf, pct } from './LabPanel';

function Row({ label, s }: { label: string; s: MlForwardStats }) {
  return (
    <tr>
      <td>{label}</td>
      <td>{s.trades}</td>
      <td>{s.winRatePct.toFixed(0)}%</td>
      <td className={s.avgGrossPct >= 0 ? 'up' : 'down'}>{pct(s.avgGrossPct, 3)}</td>
      <td className={s.avgNetPct >= 0 ? 'up' : 'down'}>{pct(s.avgNetPct, 3)}</td>
      <td>{s.avgR.toFixed(2)}</td>
      <td>{s.profitFactor == null ? '-' : s.profitFactor.toFixed(2)}</td>
    </tr>
  );
}

/** Replay the ML trade finder on recent candles and score every plan it would have shown. */
export function MlForwardTab() {
  const [days, setDays] = useState(30);
  const [universe, setUniverse] = useState(40);
  const [minConfidence, setMinConfidence] = useState(0.75);
  const [reversal, setReversal] = useState(true);
  const [fee, setFee] = useState(0.05);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<LabProgress | null>(null);
  const [report, setReport] = useState<MlForwardReport | null>(null);
  const [error, setError] = useState('');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let off: (() => void) | undefined;
    if (inTauri) void onLabProgress((p) => mounted.current && setProgress(p)).then((o) => (off = o));
    return () => {
      mounted.current = false;
      off?.();
    };
  }, []);

  const run = async () => {
    setRunning(true);
    setError('');
    setReport(null);
    try {
      const r = await api.labMlForward({ days, universe, minConfidence, reversalFilter: reversal, forward: { maxHold: 96, cooldown: 16, feePct: fee, slippagePct: 0.02 } });
      if (mounted.current) setReport(r);
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setRunning(false);
    }
  };

  const active = report ? report.weeks.filter((w) => w.trades > 0).map((w) => w.avgNetPct) : [];
  const worst = active.length ? Math.min(...active) : 0;
  const best = active.length ? Math.max(...active) : 0;

  return (
    <div className="lab-form">
      <div className="lab-row">
        <label className="lab-field">
          <span>Replay the last</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[14, 30, 60, 90].map((d) => (
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
        <label className="lab-field">
          <span>Min confidence</span>
          <input type="number" step={0.01} min={0.5} max={0.99} value={minConfidence} onChange={(e) => setMinConfidence(Number(e.target.value))} />
        </label>
        <label className="lab-field">
          <span>Fee % per side</span>
          <input type="number" step={0.01} value={fee} onChange={(e) => setFee(Number(e.target.value))} />
        </label>
        <label className="lab-field check" title="Longs only when RSI is low, shorts only when RSI is high">
          <input type="checkbox" checked={reversal} onChange={(e) => setReversal(e.target.checked)} /> RSI reversal filter
        </label>
        {running ? (
          <button className="danger" onClick={() => void api.labCancel()}>
            Cancel
          </button>
        ) : (
          <button className="primary" disabled={!inTauri} onClick={() => void run()}>
            Run replay
          </button>
        )}
        {running && (
          <span className="muted">
            {progress?.phase ?? 'starting'} {progress && progress.total > 0 ? `${progress.done}/${progress.total}` : ''}…
          </span>
        )}
        {error && <span className="warn">{error}</span>}
      </div>

      {report && (
        <div className="lab-out">
          <div className="muted lab-window">
            {dateOf(report.windowStartMs)} → {dateOf(report.windowEndMs)} · {report.symbols} coins · {report.candlesScanned.toLocaleString()} candles scored · entry at the next open, 2R plan, 24 h time limit
          </div>
          <div className="lab-card">
            <h4>Every plan the ML finder would have shown</h4>
            <table className="lab-table wide">
              <thead>
                <tr>
                  <th />
                  <th>Trades</th>
                  <th>Win</th>
                  <th>Avg gross</th>
                  <th>Avg net of fees</th>
                  <th>Avg R</th>
                  <th>Profit factor</th>
                </tr>
              </thead>
              <tbody>
                <Row label="All" s={report.all} />
                <Row label="Longs" s={report.longs} />
                <Row label="Shorts" s={report.shorts} />
              </tbody>
            </table>
            <p className="muted">
              {report.targets} reached the target, {report.stops} hit the stop, {report.timeouts} timed out.
              {active.length > 0 && ` Week by week the average net per trade ran from ${pct(worst, 3)} to ${pct(best, 3)}.`}
            </p>
          </div>
          <div className="lab-card">
            <h4>By week</h4>
            <table className="lab-table">
              <tbody>
                {report.weeks.map((w) => (
                  <tr key={w.weekStartMs}>
                    <td>{dateOf(w.weekStartMs)}</td>
                    <td className="muted">{w.trades} trades</td>
                    <td className={w.avgNetPct >= 0 ? 'up' : 'down'}>{w.trades ? pct(w.avgNetPct, 3) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="lab-notes">
            {report.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
      {!report && !running && !error && (
        <p className="muted">
          Replays the ML finder on recent public candles, exactly as the Signals panel would have seen them, and scores each plan: entry at the next open, the plan's stop and target, a 24 hour limit, fees on both sides. The first run
          downloads history; later runs reuse it. Nothing here places an order.
        </p>
      )}
    </div>
  );
}
