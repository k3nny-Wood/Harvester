import { useEffect, useMemo, useState } from 'react';
import { alertSettings, playChime, updateAlerts } from '../alerts';
import { api } from '../api';
import { WithBasePreview } from '../components/BasePreview';
import { Thumb } from '../components/Thumb';
import { openChart } from '../dock';
import { TIMEFRAMES } from '../intervals';
import { useApp } from '../store';
import type { Signal, SignalKind } from '../types';

const KIND_LABEL: Record<SignalKind, string> = { crack: 'CRACK', near: 'WATCH', drop: 'DROP' };
const UNIVERSES = [20, 40, 80, 150];

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${(s / 3600).toFixed(1)}h ago`;
}

function scoreClass(score: number): string {
  return score >= 60 ? 'hi' : score >= 35 ? 'mid' : 'lo';
}

function fmtPrice(p: number | null | undefined): string {
  if (p == null) return '-';
  return p >= 100 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p.toPrecision(4);
}

export function SignalsPanel() {
  const signals = useApp((s) => s.signals);
  const status = useApp((s) => s.scanner);
  const config = useApp((s) => s.scannerConfig);
  const setConfig = useApp((s) => s.setScannerConfig);
  const [kinds, setKinds] = useState<Record<SignalKind, boolean>>({ crack: true, drop: true, near: true });
  const [minScore, setMinScore] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [alerts, setAlerts] = useState(alertSettings.current);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const changeAlerts = (patch: Parameters<typeof updateAlerts>[0]) => setAlerts(updateAlerts(patch));

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const rows = useMemo(() => signals.filter((s) => kinds[s.kind] && s.score >= minScore), [signals, kinds, minScore]);
  const fresh = status && status.lastUpdateMs > 0 && now - status.lastUpdateMs < 30_000;
  const sources = config?.sources ?? { qfl: true };

  const restart = (patch: Partial<{ timeframe: string; universe: number }>) => {
    if (!config) return;
    void api.scannerConfigure({ ...config, ...patch });
  };

  const toggleSource = (key: 'qfl') => {
    if (!config) return;
    const next = { ...sources, [key]: !sources[key] };
    setConfig({ ...config, sources: next });
    void api.scannerSources(next);
  };

  const count = (k: SignalKind) => (k === 'crack' ? status?.crackCount : k === 'drop' ? status?.dropCount : status?.nearCount) ?? 0;

  return (
    <div className="panel signals">
      <div className="sig-head">
        <div className="sig-status">
          <span className={`dot ${status?.running ? (fresh || status.phase !== 'scanning live' ? 'on' : 'stale') : 'off'}`} />
          {!status ? (
            'Starting the scanner…'
          ) : status.phase === 'loading history' ? (
            <>
              Loading history {status.seeded}/{status.symbols}…
            </>
          ) : status.phase === 'scanning live' ? (
            <>
              Scanning {status.symbols} symbols on {status.timeframe}
              <span className="muted"> · {status.lastUpdateMs ? `updated ${ago(status.lastUpdateMs, now)}` : 'waiting for data'}</span>
            </>
          ) : (
            <>
              {status.phase}
              {status.error && <span className="warn"> · {status.error}</span>}
            </>
          )}
        </div>

        <div className="sig-sources" title="Signal sources: each can be switched on or off">
          <span className="muted">Sources</span>
          <button className={`src${sources.qfl ? ' on' : ''}`} onClick={() => toggleSource('qfl')} title="QFL base cracks, drops and watches (rule based)">
            <i /> QFL
          </button>
        </div>

        <div className="sig-controls">
          <select value={config?.timeframe ?? '15m'} onChange={(e) => restart({ timeframe: e.target.value })} title="Timeframe the scanner watches">
            {TIMEFRAMES.filter((t) => ['5m', '15m', '30m', '1h', '4h'].includes(t.interval)).map((t) => (
              <option key={t.interval} value={t.interval}>
                {t.label}
              </option>
            ))}
          </select>
          <select value={config?.universe ?? 40} onChange={(e) => restart({ universe: Number(e.target.value) })} title="How many of the busiest perpetuals to watch">
            {UNIVERSES.map((n) => (
              <option key={n} value={n}>
                top {n}
              </option>
            ))}
          </select>
          {(['crack', 'drop', 'near'] as const).map((k) => (
            <button key={k} className={`chip ${k}${kinds[k] ? ' on' : ''}`} onClick={() => setKinds((v) => ({ ...v, [k]: !v[k] }))} title={`Show / hide ${KIND_LABEL[k].toLowerCase()} entries`}>
              {KIND_LABEL[k]} {count(k)}
            </button>
          ))}
        </div>
        <div className="sig-alerts">
          <button className={`chip${alerts.sound ? ' on crack' : ''}`} onClick={() => changeAlerts({ sound: !alerts.sound })} title="Play a sound when a new signal arrives">
            {alerts.sound ? '🔔 Sound on' : '🔕 Sound off'}
          </button>
          <button className="chip" onClick={() => setAlertsOpen((v) => !v)} title="Choose which signals make a sound">
            Alert settings {alertsOpen ? '▴' : '▾'}
          </button>
        </div>
        {alertsOpen && (
          <div className="alert-box">
            <div className="alert-kinds">
              {(['crack', 'drop', 'near'] as const).map((k) => (
                <label key={k}>
                  <input type="checkbox" checked={alerts.kinds[k]} onChange={() => changeAlerts({ kinds: { ...alerts.kinds, [k]: !alerts.kinds[k] } })} /> {KIND_LABEL[k]}
                </label>
              ))}
            </div>
            <label className="minscore">
              Sound from score <b>{alerts.minScore}</b>
              <input type="range" min={0} max={90} step={5} value={alerts.minScore} onChange={(e) => changeAlerts({ minScore: Number(e.target.value) })} />
            </label>
            <label className="minscore">
              Volume <b>{Math.round(alerts.volume * 100)}</b>
              <input type="range" min={0.1} max={1} step={0.1} value={alerts.volume} onChange={(e) => changeAlerts({ volume: Number(e.target.value) })} />
            </label>
            <button className="chip" onClick={() => playChime([440, 660], alerts.volume)}>
              Test sound
            </button>
          </div>
        )}
        <label className="minscore">
          Min score <b>{minScore}</b>
          <input type="range" min={0} max={90} step={5} value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} />
        </label>
      </div>

      <div className="sig-list">
        {rows.length === 0 && (
          <div className="muted pad">
            {status?.phase === 'scanning live'
              ? 'No setups right now. The scanner is running: cracks and drops appear here as they happen, and WATCH entries show bases that price is approaching.'
              : 'Waiting for the first scan to finish…'}
          </div>
        )}
        {rows.map((s) => (
          <SignalCard key={s.id} s={s} now={now} />
        ))}
      </div>
    </div>
  );
}

function SignalCard({ s, now }: { s: Signal; now: number }) {
  const open = () => openChart(s.symbol, s.timeframe);
  return (
    <div className={`sig-card ${s.kind}`}>
      <WithBasePreview signal={s}>
        <Thumb candles={s.thumb} base={s.base} crackLevel={s.crackLevel} onClick={open} title={`Open ${s.symbol} ${s.timeframe} chart`} />
      </WithBasePreview>
      <div className="sig-body">
        <div className="sig-top">
          <button className="sig-sym" onClick={open} title="Open the chart">
            {s.symbol.replace('USDT', '')}
            <span className="muted">USDT · {s.timeframe}</span>
          </button>
          <span className={`kind ${s.kind}`}>{KIND_LABEL[s.kind]}</span>
          <span className={`score ${scoreClass(s.score)}`} title={`structure ${s.parts.structure.toFixed(0)} · volume ${s.parts.volume.toFixed(0)} · magnitude ${s.parts.magnitude.toFixed(0)} · pivot ${s.parts.pivot.toFixed(0)} · stabilising ${s.parts.stabilising.toFixed(0)}`}>
            {s.score}
          </span>
        </div>
        <div className="sig-nums">
          <span>
            Price <b>{fmtPrice(s.price)}</b>
          </span>
          {s.base != null && (
            <span>
              Base <b>{fmtPrice(s.base)}</b>
            </span>
          )}
          {s.crackLevel != null && (
            <span>
              Crack <b>{fmtPrice(s.crackLevel)}</b>
            </span>
          )}
          {s.distancePct != null && (
            <span className={s.distancePct >= 0 ? '' : 'down'}>
              {s.distancePct >= 0 ? '+' : ''}
              {s.distancePct.toFixed(2)}%
            </span>
          )}
        </div>
        <div className="sig-reasons">
          {s.reasons.slice(0, 3).map((r, i) => (
            <div key={i}>• {r}</div>
          ))}
        </div>
        <div className="sig-age muted">{ago(s.timeMs, now)}</div>
      </div>
    </div>
  );
}
