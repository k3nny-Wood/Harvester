import { useEffect, useMemo, useState } from 'react';
import { alertSettings, playChime, updateAlerts } from '../alerts';
import { DEFAULT_MOVERS, useMovers, windowLabel } from '../moversConfig';
import { useScannerParams } from '../scannerParams';
import { api } from '../api';
import { WithBasePreview } from '../components/BasePreview';
import { Thumb } from '../components/Thumb';
import { openChart } from '../dock';
import { TIMEFRAMES } from '../intervals';
import { useApp } from '../store';
import type { Signal, SignalKind } from '../types';

const KIND_LABEL: Record<SignalKind, string> = { pump: 'PUMP', dump: 'DUMP', crack: 'CRACK', near: 'WATCH', drop: 'DROP' };
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
  const [kinds, setKinds] = useState<Record<SignalKind, boolean>>({ pump: true, dump: true, crack: true, drop: true, near: true });
  const [minScore, setMinScore] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [alerts, setAlerts] = useState(alertSettings.current);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [moversOpen, setMoversOpen] = useState(false);
  const [qflOpen, setQflOpen] = useState(false);
  const scanParams = useScannerParams((s) => s.params);
  const changeScan = useScannerParams((s) => s.change);
  const resetScan = useScannerParams((s) => s.reset);
  // the running scanner starts with its own defaults: tell it the saved rules, and again whenever they change
  useEffect(() => {
    void api.scannerParams(scanParams).catch(() => undefined);
  }, [scanParams]);
  const movers = useMovers((s) => s.params);
  const changeMovers = useMovers((s) => s.change);
  const setRule = useMovers((s) => s.setRule);
  // the backend starts with its own defaults: tell it what was saved, and again whenever it changes
  useEffect(() => {
    void api.moversConfigure(movers).catch(() => undefined);
  }, [movers]);
  const changeAlerts = (patch: Parameters<typeof updateAlerts>[0]) => setAlerts(updateAlerts(patch));

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const rows = useMemo(() => signals.filter((s) => kinds[s.kind] && s.score >= minScore), [signals, kinds, minScore]);
  const fresh = status && status.lastUpdateMs > 0 && now - status.lastUpdateMs < 30_000;
  const sources = config?.sources ?? { qfl: true, movers: true };

  const restart = (patch: Partial<{ timeframe: string; universe: number }>) => {
    if (!config) return;
    void api.scannerConfigure({ ...config, params: useScannerParams.getState().params, ...patch });
  };

  const toggleSource = (key: 'qfl' | 'movers') => {
    if (!config) return;
    const next = { ...sources, [key]: !sources[key] };
    setConfig({ ...config, sources: next });
    void api.scannerSources(next);
  };

  const count = (k: SignalKind) => (k === 'pump' ? status?.pumpCount : k === 'dump' ? status?.dumpCount : k === 'crack' ? status?.crackCount : k === 'drop' ? status?.dropCount : status?.nearCount) ?? 0;

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
          <button className="src" onClick={() => setQflOpen((v) => !v)} title="QFL / drop / watch settings">
            ⚙
          </button>
          <button className={`src${sources.movers ? ' on' : ''}`} onClick={() => toggleSource('movers')} title="Sudden pumps and dumps across every perpetual (live price stream)">
            <i /> Movers
          </button>
          <button className="src" onClick={() => setMoversOpen((v) => !v)} title="Pump / dump settings">
            ⚙
          </button>
          {sources.movers && status?.moverState && <span className="muted">{status.moverState}</span>}
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
          {(['pump', 'dump', 'crack', 'drop', 'near'] as const).map((k) => (
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
        {qflOpen && (
          <div className="alert-box">
            <div className="muted">Rules of the QFL scanner. They apply at once to every symbol it follows.</div>
            <b>Drops</b>
            <label className="minscore">
              Minimum drop <b>{scanParams.dropMinPct}%</b>
              <input type="range" min={0.5} max={20} step={0.5} value={scanParams.dropMinPct} onChange={(e) => changeScan({ dropMinPct: Number(e.target.value) })} />
            </label>
            <label className="minscore">
              From the high of the last <b>{scanParams.dropWindow} candles</b>
              <input type="range" min={3} max={96} step={1} value={scanParams.dropWindow} onChange={(e) => changeScan({ dropWindow: Number(e.target.value) })} />
            </label>
            <label className="minscore">
              And at least <b>{scanParams.dropMinMultiple === 0 ? 'off' : `${scanParams.dropMinMultiple}x`}</b> the coin's normal move
              <input type="range" min={0} max={8} step={0.5} value={scanParams.dropMinMultiple} onChange={(e) => changeScan({ dropMinMultiple: Number(e.target.value) })} />
            </label>
            <b>Cracks and watches</b>
            <label className="minscore">
              A crack counts for <b>{scanParams.freshBars} candles</b>
              <input type="range" min={1} max={40} step={1} value={scanParams.freshBars} onChange={(e) => changeScan({ freshBars: Number(e.target.value) })} />
            </label>
            <label className="minscore">
              Crack depth below the base <b>{(scanParams.qfl.crackPct * 100).toFixed(1)}%</b>
              <input type="range" min={0.1} max={3} step={0.1} value={Number((scanParams.qfl.crackPct * 100).toFixed(1))} onChange={(e) => changeScan({ qfl: { crackPct: Number(e.target.value) / 100 } })} />
            </label>
            <label className="minscore">
              Watch when within <b>{scanParams.nearPct}%</b> of the crack level
              <input type="range" min={0.2} max={5} step={0.1} value={scanParams.nearPct} onChange={(e) => changeScan({ nearPct: Number(e.target.value) })} />
            </label>
            <label className="minscore">
              Base sensitivity (volatility factor) <b>{scanParams.qfl.volatilityFactor}</b>
              <input type="range" min={0.5} max={5} step={0.1} value={scanParams.qfl.volatilityFactor} onChange={(e) => changeScan({ qfl: { volatilityFactor: Number(e.target.value) } })} />
            </label>
            <small className="muted">A higher factor needs a bigger bounce before a base counts, so fewer bases exist. Same idea as the factor in the chart's Bases settings.</small>
            <button className="chip" onClick={resetScan}>
              Reset
            </button>
          </div>
        )}
        {moversOpen && (
          <div className="alert-box">
            <div className="muted">A sudden move is reported when the price changes by at least this much within the window AND by several times what that coin normally moves in that long.</div>
            {movers.rules.map((r, i) => (
              <label key={r.secs} className="minscore">
                In {windowLabel(r.secs)}: at least <b>{r.minPct}%</b>
                <input type="range" min={0.5} max={15} step={0.5} value={r.minPct} onChange={(e) => setRule(i, Number(e.target.value))} />
              </label>
            ))}
            <label className="minscore">
              Times its normal move <b>{movers.normalMultiple}x</b>
              <input type="range" min={2} max={15} step={0.5} value={movers.normalMultiple} onChange={(e) => changeMovers({ normalMultiple: Number(e.target.value) })} />
            </label>
            <label className="minscore">
              Min 24h volume <b>${(movers.minQuoteVolume / 1e6).toFixed(1)}M</b>
              <input type="range" min={0} max={50} step={0.5} value={movers.minQuoteVolume / 1e6} onChange={(e) => changeMovers({ minQuoteVolume: Number(e.target.value) * 1e6 })} />
            </label>
            <label className="minscore">
              Quiet for <b>{Math.round(movers.cooldownSecs / 60)} min</b> after a report
              <input type="range" min={1} max={60} step={1} value={movers.cooldownSecs / 60} onChange={(e) => changeMovers({ cooldownSecs: Number(e.target.value) * 60 })} />
            </label>
            <button className="chip" onClick={() => changeMovers(DEFAULT_MOVERS)}>
              Reset
            </button>
          </div>
        )}
        {alertsOpen && (
          <div className="alert-box">
            <div className="alert-kinds">
              {(['pump', 'dump', 'crack', 'drop', 'near'] as const).map((k) => (
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
