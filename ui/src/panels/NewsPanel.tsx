import { useCallback, useEffect, useState } from 'react';
import { api, inTauri } from '../api';
import { useActiveChart } from '../chartStore';
import { DelistNote } from '../components/DelistNote';
import { useApp } from '../store';
import type { NewsItem, NewsKind, NewsResult } from '../types';

/** The cashtag search on X, newest first: a link that opens in the browser (reading tweets through the API is a paid service). */
export function xSearchUrl(ticker: string): string {
  return `https://x.com/search?q=${encodeURIComponent(`$${ticker}`)}&f=live`;
}

/** "5 min ago", "3 h ago", "2 d ago"; "" when the time is unknown. */
export function timeAgo(ms: number, now: number): string {
  if (!(ms > 0)) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

const KIND_LABEL: Record<NewsKind, string> = { news: '', listing: 'LISTING', delisting: 'DELISTING', notice: 'NOTICE' };

function Item({ item, now }: { item: NewsItem; now: number }) {
  const toast = useApp((s) => s.toast);
  const open = () => void api.openUrl(item.url).catch((e) => toast(`${e}`, 'warn'));
  return (
    <div className={`news-item ${item.kind}`} onClick={open} title={`Open in the browser: ${item.url}`}>
      <div className="news-meta">
        {KIND_LABEL[item.kind] && <span className={`news-kind ${item.kind}`}>{KIND_LABEL[item.kind]}</span>}
        <span className="news-source">{item.source}</span>
        <span className="muted">{timeAgo(item.timeMs, now)}</span>
      </div>
      <div className="news-title">{item.title}</div>
      {item.summary && <div className="news-summary muted">{item.summary}</div>}
    </div>
  );
}

/** News about the coin of the focused chart: Binance announcements and crypto news sites. Clicking an item opens it in the browser. */
export function NewsPanel() {
  const symbol = useActiveChart((s) => s.symbol) ?? '';
  const [result, setResult] = useState<NewsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());

  const load = useCallback(
    async (force: boolean) => {
      if (!inTauri || !symbol) return;
      setLoading(true);
      setError('');
      try {
        setResult(await api.newsFor(symbol, force));
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [symbol],
  );

  useEffect(() => {
    setResult(null);
    void load(false);
    const t = window.setInterval(() => void load(false), 5 * 60 * 1000);
    return () => window.clearInterval(t);
  }, [load]);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  if (!symbol) return <div className="panel pad muted">Open a chart to see its news.</div>;
  const failed = result?.sources.filter((s) => !s.ok) ?? [];
  const checked = result?.sources.reduce((a, s) => a + s.count, 0) ?? 0;
  const hasPanic = result?.sources.some((s) => s.name === 'CryptoPanic') ?? false;

  return (
    <div className="panel news">
      <div className="news-head">
        <b>
          {result?.ticker ?? symbol.replace('USDT', '')}
          {result?.name ? <span className="muted"> · {result.name}</span> : null}
        </b>
        <span className="spacer" />
        <button className="mini" onClick={() => void api.openUrl(xSearchUrl(result?.ticker ?? symbol.replace('USDT', ''))).catch(() => undefined)} title="Search this coin's cashtag on X in your browser">
          X ↗
        </button>
        <button className="mini" disabled={loading} onClick={() => void load(true)} title="Fetch the feeds again">
          {loading ? '…' : '⟳'}
        </button>
      </div>
      <DelistNote symbol={symbol} />
      {error && <div className="warn pad">News: {error}</div>}
      {!result && loading && <div className="muted pad">Loading the feeds…</div>}
      {result && (
        <div className="news-list">
          {result.items.length === 0 && (
            <div className="muted pad">
              Nothing about {result.ticker} in the {checked} latest articles from {result.sources.filter((s) => s.ok).length} sources. Small coins are rarely in the news: try the X link above.
            </div>
          )}
          {result.items.map((i) => (
            <Item key={i.id} item={i} now={now} />
          ))}
          {result.notices.length > 0 && (
            <>
              <div className="news-section">Binance notices (all coins)</div>
              {result.notices.map((i) => (
                <Item key={i.id} item={i} now={now} />
              ))}
            </>
          )}
          <details className="news-sources">
            <summary>
              Sources {failed.length > 0 && <span className="warn">· {failed.length} not answering</span>}
            </summary>
            {result.sources.map((s) => (
              <div key={s.name} className={s.ok ? 'muted' : 'warn'}>
                {s.ok ? '✓' : '✗'} {s.name}
                {s.ok ? ` (${s.count})` : `: ${s.error}`}
              </div>
            ))}
            {!hasPanic && <div className="muted">Add CRYPTOPANIC_API_KEY to the .env file for CryptoPanic's per-coin feed.</div>}
          </details>
        </div>
      )}
    </div>
  );
}
