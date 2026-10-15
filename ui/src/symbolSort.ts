import type { SymbolQuote } from './types';

export type SortKey = 'name' | 'change' | 'volume';
export type SortDir = 'asc' | 'desc';

/** The direction a column starts with when it is first clicked: names A to Z, the biggest volume and the biggest rise first. */
export function firstDirection(key: SortKey): SortDir {
  return key === 'name' ? 'asc' : 'desc';
}

/** The sort after a click on `key`: a new column starts in its natural direction, the same column flips. */
export function nextSort(current: { key: SortKey; dir: SortDir } | null, key: SortKey): { key: SortKey; dir: SortDir } {
  if (current && current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: firstDirection(key) };
}

/** A sorted copy. Ties and unsorted lists keep the order they came in (the sort is stable). */
export function sortSymbols(rows: SymbolQuote[], sort: { key: SortKey; dir: SortDir } | null): SymbolQuote[] {
  if (!sort) return rows;
  const sign = sort.dir === 'asc' ? 1 : -1;
  const value = (s: SymbolQuote): number | string => (sort.key === 'name' ? s.symbol : sort.key === 'change' ? s.changePercent24h : s.volume24hQuote);
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (typeof x === 'string' && typeof y === 'string') return sign * x.localeCompare(y);
    return sign * ((x as number) - (y as number));
  });
}
