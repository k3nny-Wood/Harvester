import type { DataProvider, OHLCV } from '@luxalgo/vela';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { api, onKline } from '../api';
import { TIMEFRAMES, velaToInterval } from '../intervals';

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
    const rows = await api.klines(ticker, velaToInterval(timeframe), Math.min(1500, Math.max(10, range.limit ?? 500)), range.from, range.to);
    return rows.map((r) => ({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
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
