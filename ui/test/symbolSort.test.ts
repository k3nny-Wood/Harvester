import { describe, expect, it } from 'vitest';
import { nextSort, sortSymbols } from '../src/symbolSort';
import type { SymbolQuote } from '../src/types';

const q = (symbol: string, changePercent24h: number, volume24hQuote: number): SymbolQuote => ({ symbol, lastPrice: 1, changePercent24h, volume24hQuote });
const rows = [q('SOLUSDT', -3, 500), q('BTCUSDT', 1.5, 9000), q('ETHUSDT', 8, 4000), q('ADAUSDT', 1.5, 100)];
const names = (r: SymbolQuote[]) => r.map((x) => x.symbol.replace('USDT', ''));

describe('sorting the symbol list', () => {
  it('sorts by name, A to Z or Z to A', () => {
    expect(names(sortSymbols(rows, { key: 'name', dir: 'asc' }))).toEqual(['ADA', 'BTC', 'ETH', 'SOL']);
    expect(names(sortSymbols(rows, { key: 'name', dir: 'desc' }))).toEqual(['SOL', 'ETH', 'BTC', 'ADA']);
  });

  it('sorts by volume and by the change in percent, negative changes included', () => {
    expect(names(sortSymbols(rows, { key: 'volume', dir: 'desc' }))).toEqual(['BTC', 'ETH', 'SOL', 'ADA']);
    expect(names(sortSymbols(rows, { key: 'volume', dir: 'asc' }))).toEqual(['ADA', 'SOL', 'ETH', 'BTC']);
    expect(names(sortSymbols(rows, { key: 'change', dir: 'desc' }))).toEqual(['ETH', 'BTC', 'ADA', 'SOL']);
    expect(names(sortSymbols(rows, { key: 'change', dir: 'asc' }))).toEqual(['SOL', 'BTC', 'ADA', 'ETH']);
  });

  it('keeps the incoming order for ties and without a sort, and never changes the list it was given', () => {
    const copy = [...rows];
    expect(sortSymbols(rows, null)).toBe(rows);
    // BTC and ADA both changed 1.5: BTC came first
    expect(names(sortSymbols(rows, { key: 'change', dir: 'desc' })).slice(1, 3)).toEqual(['BTC', 'ADA']);
    expect(rows).toEqual(copy);
  });

  it('a click starts a column in its natural direction and the next click flips it', () => {
    expect(nextSort(null, 'name')).toEqual({ key: 'name', dir: 'asc' });
    expect(nextSort(null, 'volume')).toEqual({ key: 'volume', dir: 'desc' });
    expect(nextSort({ key: 'volume', dir: 'desc' }, 'volume')).toEqual({ key: 'volume', dir: 'asc' });
    expect(nextSort({ key: 'volume', dir: 'asc' }, 'change')).toEqual({ key: 'change', dir: 'desc' });
  });
});
