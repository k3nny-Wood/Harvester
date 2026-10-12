import { useEffect, useRef, useState } from 'react';
import { Vela } from '@luxalgo/vela';
import { api, onKline } from '../api';
import { intervalToVela } from '../intervals';
import { useApp } from '../store';
import { DRAWING_GROUPS } from './drawingTools';
import { HarvesterProvider } from './provider';
import { LadderOverlay } from './LadderOverlay';

declare global {
  interface Window {
    __velaChart?: Vela;
  }
}

export function ChartPanel() {
  const ref = useRef<HTMLDivElement>(null);
  const [chart, setChart] = useState<Vela | null>(null);
  const symbol = useApp((s) => s.symbol);
  const timeframe = useApp((s) => s.timeframe);
  const setFilters = useApp((s) => s.setFilters);
  const setMarkPrice = useApp((s) => s.setMarkPrice);
  const initial = useRef({ symbol, timeframe });

  // One Vela instance for the panel's lifetime; the market is switched in place.
  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const c = new Vela(container, {
      symbol: `binance:${initial.current.symbol}`,
      timeframe: intervalToVela(initial.current.timeframe),
      live: true,
      theme: 'dark',
      bars: 400,
      drawings: { toolbar: true, groups: DRAWING_GROUPS },
      volume: true,
      currentPriceLine: true,
    });
    c.data.registerProvider('binance', new HarvesterProvider());
    c.drawings.setStayMode(true);
    c.drawings.setSnapMode('weak');
    window.__velaChart = c;
    setChart(c);
    return () => {
      setChart(null);
      c.destroy();
    };
  }, []);

  useEffect(() => {
    if (!chart) return;
    void chart.setMarket({ symbol: `binance:${symbol}`, timeframe: intervalToVela(timeframe) });
  }, [chart, symbol, timeframe]);

  // Trading constraints of the symbol on screen (tick, step, minimum notional...).
  useEffect(() => {
    let alive = true;
    api
      .symbolFilters(symbol)
      .then((f) => alive && setFilters(f))
      .catch(() => alive && setFilters(null));
    return () => {
      alive = false;
    };
  }, [symbol, setFilters]);

  // Last price for the symbol, from the same kline events that feed the chart.
  useEffect(() => {
    let off: (() => void) | null = null;
    let stopped = false;
    void onKline((e) => {
      if (e.symbol === symbol) setMarkPrice(e.bar.close);
    }).then((u) => {
      if (stopped) u();
      else off = u;
    });
    return () => {
      stopped = true;
      off?.();
    };
  }, [symbol, setMarkPrice]);

  return (
    <div className="chart-shell">
      <div ref={ref} className="chart-host" />
      <LadderOverlay chart={chart} host={ref} />
    </div>
  );
}
