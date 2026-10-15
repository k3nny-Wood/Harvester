import type { DataProvider, OHLCV } from '@luxalgo/vela';
import type { Unlisten as UnlistenFn } from '../transport';
import { api, onKline } from '../api';
import { TIMEFRAMES, velaToInterval } from '../intervals';
import { fetchBars } from './history';

/** Feeds Vela from the Rust core: history over a command, live bars over `kline` events. */
export class HarvesterProvider implements DataProvider {
  info() {
    return {
      name: 'binance-futures',
      displayName: 'Binance USDⓈ-M Futures',
      requiresApiKey: false,
      supportedTimeframes: TIMEFRAMES.map((t) => t.vela),
      capabilities: { enumerate: true, stream: true, symbolInfo: false },
    };
  }

  async listSymbols() {
    const quotes = await api.listSymbols();
    return quotes.map((q) => ({ ticker: q.symbol, description: q.symbol }));
  }

  async getBars(ticker: string, timeframe: string, range: { from?: number; to?: number; limit?: number }): Promise<OHLCV[]> {
    const interval = velaToInterval(timeframe);
    // any size of window: pieces of 1500 are joined, so zooming out or panning back never leaves a gap
    return fetchBars(async (limit, from, to) => (await api.klines(ticker, interval, limit, from, to)).map((r) => ({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume })), range);
  }

  subscribe(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void): () => void {
    const interval = velaToInterval(timeframe);
    let unlisten: UnlistenFn | null = null;
    let stopped = false;
    void onKline((e) => {
      if (e.symbol === ticker && e.interval === interval) onBar({ ...e.bar });
    }).then((u) => {
      if (stopped) u();
      else unlisten = u;
    });
    void api.subscribeKlines(ticker, interval);
    return () => {
      stopped = true;
      unlisten?.();
      void api.unsubscribeKlines(ticker, interval);
    };
  }
}
