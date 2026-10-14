import { useEffect, useState } from 'react';
import { api, inTauri } from '../api';
import { useActiveChart } from '../chartStore';
import { useAnalyst } from '../analyst/store';
import { useApp } from '../store';
import type { AiEntry, AiModel, AiTrack } from '../types';

export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

const BIAS_CLASS = { bullish: 'up', bearish: 'down', neutral: 'muted' } as const;
const KIND_LABEL = { support: 'Support', resistance: 'Resistance', target: 'Target', invalidation: 'Invalidation' } as const;

function Result({ e, now }: { e: AiEntry; now: number }) {
  const a = e.analysis;
  return (
    <div className="ai-result">
      <div className="ai-head">
        <b className={`ai-bias ${BIAS_CLASS[a.bias]}`}>{a.bias.toUpperCase()}</b>
        <span className="ai-conf" title="50 = no real edge. This is an opinion, not a forecast.">
          {a.confidence}% confidence
        </span>
        <span className="muted"> · {a.horizonHours} h horizon</span>
      </div>
      <div className="ai-bar" title="confidence (50 = coin flip)">
        <i style={{ width: `${a.confidence}%` }} className={BIAS_CLASS[a.bias]} />
        <u />
      </div>
      <div className="muted ai-meta">
        {e.symbol} {e.timeframe} · {ago(e.createdMs, now)} · {e.model.replace('claude-', '')} · {e.usage.inputTokens.toLocaleString()} in / {e.usage.outputTokens.toLocaleString()} out tokens{e.withImage ? ' · with picture' : ''}
      </div>
      <p className="ai-summary">{a.summary}</p>
      {a.positionNote && (
        <div className="ai-pos">
          <b>Your position: </b>
          {a.positionNote}
        </div>
      )}
      {a.keyLevels.length > 0 && (
        <>
          <div className="ai-sec">Key levels</div>
          {[...a.keyLevels]
            .sort((x, y) => y.price - x.price)
            .map((l, i) => (
              <div key={i} className={`ai-level ${l.kind}`}>
                <span className="ai-lk">{KIND_LABEL[l.kind]}</span>
                <b>{l.price}</b>
                <span className="muted">{l.note}</span>
              </div>
            ))}
        </>
      )}
      {a.scenarios.length > 0 && (
        <>
          <div className="ai-sec">Scenarios</div>
          {a.scenarios.map((s, i) => (
            <div key={i} className="ai-scn">
              <b>{s.name}</b>
              <div className="muted">If {s.condition}</div>
              <div>{s.outcome}</div>
            </div>
          ))}
        </>
      )}
      {a.reasons.length > 0 && (
        <>
          <div className="ai-sec">Why</div>
          <ul>
            {a.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </>
      )}
      {a.risks.length > 0 && (
        <>
          <div className="ai-sec">Risks</div>
          <ul className="ai-risks">
            {a.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function TrackRecord() {
  const [track, setTrack] = useState<AiTrack | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const load = () => {
    setLoading(true);
    setError('');
    api
      .aiTrack()
      .then(setTrack)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);
  const now = Date.now();
  if (error) return <div className="warn pad">{error}</div>;
  if (!track) return <div className="muted pad">{loading ? 'Scoring the analyses…' : ''}</div>;
  const r = track.record;
  const fmtPct = (v: number | null, d = 0) => (v == null ? '-' : `${v.toFixed(d)}%`);
  return (
    <div className="ai-track">
      <div className="muted ai-note">
        Each directional call is scored against the real price {r.horizons.map((h) => `${h.hours} h`).join(', ')} later. “Always up” is how often price simply rose over the same periods: a bullish bias has to beat that, and a bearish one has to beat its opposite, to mean anything.
      </div>
      <div className="muted">
        {r.analyses} analyses · {r.directional} directional · {r.neutral} neutral
      </div>
      <table className="rungs">
        <thead>
          <tr>
            <th>After</th>
            <th>Scored</th>
            <th>Hit rate</th>
            <th>Avg move (in its direction)</th>
            <th>Always up</th>
          </tr>
        </thead>
        <tbody>
          {r.horizons.map((h) => (
            <tr key={h.hours}>
              <td>{h.hours} h</td>
              <td>{h.scored}</td>
              <td className={h.hitRatePct != null && h.hitRatePct >= 50 ? 'up' : 'down'}>{fmtPct(h.hitRatePct)}</td>
              <td className={h.avgDirectionalChangePct != null && h.avgDirectionalChangePct >= 0 ? 'up' : 'down'}>{fmtPct(h.avgDirectionalChangePct, 2)}</td>
              <td className="muted">{fmtPct(h.upRatePct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {r.directional < 20 && <div className="muted ai-note">Too few calls so far to say anything: a hit rate over fewer than about 30 calls is mostly luck.</div>}
      <div className="ai-sec">Recent analyses</div>
      {track.entries.map(({ entry, outcomes }) => (
        <div key={entry.id} className="ai-hist">
          <span className={BIAS_CLASS[entry.analysis.bias]}>{entry.analysis.bias}</span> {entry.analysis.confidence}% · {entry.symbol} {entry.timeframe} · <span className="muted">{ago(entry.createdMs, now)}</span>
          <span className="ai-outs">
            {outcomes.map((o) => (
              <span key={o.hours} className={o.correct == null ? 'muted' : o.correct ? 'up' : 'down'} title={`${o.hours} h later`}>
                {o.hours}h {o.changePct == null ? '…' : `${o.changePct >= 0 ? '+' : ''}${o.changePct.toFixed(2)}%`}
              </span>
            ))}
          </span>
        </div>
      ))}
      <button className="mini" onClick={load} disabled={loading}>
        {loading ? '…' : 'Refresh scores'}
      </button>
    </div>
  );
}

/** Analysis and advice for the chart in focus, written by Claude from the chart's indicators, zones, news, your position and a screenshot. */
export function AnalystPanel() {
  const symbol = useActiveChart((s) => s.symbol) ?? '';
  const a = useAnalyst();
  const toast = useApp((s) => s.toast);
  const [models, setModels] = useState<AiModel[]>([]);
  const [tab, setTab] = useState<'analysis' | 'track'>('analysis');
  const [note, setNote] = useState('');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!inTauri) return;
    api.aiModels().then(setModels).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!inTauri || !symbol) return;
    api.aiHistory(symbol).then(a.setLatest).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const entry = a.latest[symbol];
  return (
    <div className="panel ai">
      <div className="ai-controls">
        <select value={a.model} onChange={(e) => a.setPrefs({ model: e.target.value })} title="Haiku is quicker and cheaper; Sonnet looks deeper">
          {(models.length ? models : [{ id: a.model, label: a.model }]).map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <label className="check" title="Send a picture of the chart too, so it can see what you see">
          <input type="checkbox" checked={a.includeImage} onChange={(e) => a.setPrefs({ includeImage: e.target.checked })} /> Picture
        </label>
        <label className="check" title="Draw its key levels and an arrow for its bias on the chart">
          <input type="checkbox" checked={a.showOnChart} onChange={(e) => a.setPrefs({ showOnChart: e.target.checked })} /> On chart
        </label>
        <button className="primary" disabled={a.running || !symbol} onClick={() => void a.run(note).then(() => a.error && toast(a.error, 'warn'))}>
          {a.running ? 'Analysing…' : `Analyse ${symbol.replace('USDT', '') || 'chart'}`}
        </button>
      </div>
      <textarea className="ai-note-input" rows={2} placeholder="Ask something specific (optional): “Should I hold through the delisting?”" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="ai-tabs">
        <button className={tab === 'analysis' ? 'on' : ''} onClick={() => setTab('analysis')}>
          Analysis
        </button>
        <button className={tab === 'track' ? 'on' : ''} onClick={() => setTab('track')}>
          Track record
        </button>
      </div>
      <div className="ai-body">
        {a.error && <div className="warn pad">{a.error}</div>}
        {tab === 'analysis' ? entry ? <Result e={entry} now={now} /> : <div className="muted pad">{a.running ? 'Gathering the data and asking Claude… this takes a few seconds.' : `No analysis of ${symbol} yet. Press Analyse.`}</div> : <TrackRecord />}
      </div>
      <div className="muted ai-disclaimer">An opinion from an AI model reading the data shown, not a forecast and not financial advice. Nobody can reliably predict price. The track record tab shows how its calls actually did.</div>
    </div>
  );
}
