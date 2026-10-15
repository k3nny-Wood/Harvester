import { delistingFor, describeDelisting, useDelistings } from '../delistings';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useActiveChart } from '../chartStore';
import { openChart } from '../dock';
import { useApp } from '../store';
import { nextSort, sortSymbols, type SortDir, type SortKey } from '../symbolSort';

const SORT_KEY = 'harvester.symbols.sort.v1';
type Sort = { key: SortKey; dir: SortDir } | null;

function loadSort(): Sort {
  try {
    const v = JSON.parse(window.localStorage.getItem(SORT_KEY) ?? 'null');
    if (v && ['name', 'change', 'volume'].includes(v.key) && ['asc', 'desc'].includes(v.dir)) return v;
  } catch {
    /* no remembered sort */
  }
  return null;
}

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
  const [sort, setSort] = useState<Sort>(loadSort);
  const clickSort = (key: SortKey) =>
    setSort((cur) => {
      const next = nextSort(cur, key);
      try {
        window.localStorage.setItem(SORT_KEY, JSON.stringify(next));
      } catch {
        /* not remembered */
      }
      return next;
    });
  const head = (key: SortKey, label: string) => (
    <button className={`sort-head${sort?.key === key ? ' on' : ''}`} onClick={() => clickSort(key)} title={`Sort by ${label.toLowerCase()} (click again to reverse)`}>
      {label}
      {sort?.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </button>
  );

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
    return sortSymbols(symbols.filter((s) => !q || s.symbol.includes(q)), sort);
  }, [symbols, query, sort]);

  return (
    <div className="panel symbols">
      <input className="search" placeholder={`Search ${symbols.length || ''} perpetuals…`} value={query} onChange={(e) => setQuery(e.target.value)} />
      {error && <div className="warn pad">{error}</div>}
      <div className="symbol-head">
        {head('name', 'Name')}
        <span className="muted">Price</span>
        {head('change', '24h %')}
        {head('volume', 'Volume')}
      </div>
      <div className="symbol-list">
        {rows.map((s) => (
          <button
            key={s.symbol}
            className={`symbol-row${s.symbol === current ? ' active' : ''}`}
            title="Opens the chart of this symbol (there is one chart per symbol: switches to it if it is already open)"
            onClick={() => openChart(s.symbol)}
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
