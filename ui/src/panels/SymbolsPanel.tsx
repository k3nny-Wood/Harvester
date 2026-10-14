import { delistingFor, describeDelisting, useDelistings } from '../delistings';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useActiveChart } from '../chartStore';
import { openChart } from '../dock';
import { useApp } from '../store';

function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}

export function SymbolsPanel() {
  const symbols = useApp((s) => s.symbols);
  const setSymbols = useApp((s) => s.setSymbols);
  const current = useActiveChart((s) => s.symbol) ?? '';
  const delistings = useDelistings((s) => s.list);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .listSymbols()
        .then((s) => {
          if (alive) {
            setSymbols(s);
            setError(null);
          }
        })
        .catch((e) => alive && setError(String(e)));
    void load();
    const timer = window.setInterval(load, 20_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [setSymbols]);

  const rows = useMemo(() => {
    const q = query.trim().toUpperCase();
    return symbols.filter((s) => !q || s.symbol.includes(q));
  }, [symbols, query]);

  return (
    <div className="panel symbols">
      <input className="search" placeholder={`Search ${symbols.length || ''} perpetuals…`} value={query} onChange={(e) => setQuery(e.target.value)} />
      {error && <div className="warn pad">{error}</div>}
      <div className="symbol-list">
        {rows.map((s) => (
          <button
            key={s.symbol}
            className={`symbol-row${s.symbol === current ? ' active' : ''}`}
            title="Opens a chart tab for this symbol (switches to it if it is already open). Ctrl+click always opens a new tab."
            onClick={(e) => openChart(s.symbol, undefined, e.ctrlKey)}
          >
            <span className="sym">{s.symbol.replace('USDT', '')}</span>
            {delistingFor(s.symbol, delistings) && (
              <span className={`delist-mark ${delistingFor(s.symbol, delistings)?.kind === 'spot' ? 'warn' : 'danger'}`} title={describeDelisting(delistingFor(s.symbol, delistings)!, Date.now()).text}>
                ⚠
              </span>
            )}
            <span className="px">{s.lastPrice}</span>
            <span className={s.changePercent24h >= 0 ? 'up' : 'down'}>{s.changePercent24h.toFixed(2)}%</span>
            <span className="vol">{compact(s.volume24hQuote)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
