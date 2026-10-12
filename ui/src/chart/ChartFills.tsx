import { useEffect, useRef, useState } from 'react';
import type { Vela } from '@luxalgo/vela';
import { api } from '../api';
import { useChart } from '../chartStore';
import { useApp } from '../store';
import type { TradeRecord } from '../types';

const GREEN = '#2ee59d';
const RED = '#ff5c63';

interface Marker {
  key: string;
  time: number;
  price: number;
  side: 'BUY' | 'SELL';
}

/** One arrow per order: its fills merged at the volume-weighted average price, at the time of the first fill. */
export function fillMarkers(symbol: string, fills: TradeRecord[]): Marker[] {
  const byOrder = new Map<number, { side: 'BUY' | 'SELL'; time: number; qty: number; value: number }>();
  for (const f of fills) {
    if (f.symbol !== symbol || !(f.price > 0)) continue;
    const g = byOrder.get(f.orderId) ?? { side: f.side, time: f.time, qty: 0, value: 0 };
    g.time = Math.min(g.time, f.time);
    g.qty += f.qty;
    g.value += f.qty * f.price;
    byOrder.set(f.orderId, g);
  }
  return [...byOrder.entries()].map(([orderId, g]) => ({ key: `fill:${symbol}:${orderId}`, time: g.time, price: g.value / g.qty, side: g.side }));
}

/**
 * Completed trades on the chart: a green up arrow for a buy, a red down arrow for a sell, with the tip on the executed price.
 * They are Vela drawings, so they follow the chart when it is panned and zoomed.
 */
export function ChartFills({ chart }: { chart: Vela | null }) {
  const symbol = useChart((s) => s.symbol);
  const hasKeys = useApp((s) => !!s.trading?.hasCredentials);
  // a change in the number of open orders or positions usually means something just filled: reload at once
  const activity = useApp((s) => `${s.orders.length}:${s.account?.positions.length ?? 0}`);
  const [fills, setFills] = useState<TradeRecord[]>([]);
  const ids = useRef(new Map<string, string>());

  useEffect(() => {
    if (!hasKeys) {
      setFills([]);
      return;
    }
    let alive = true;
    const load = () =>
      api
        .tradeHistory(symbol, 500)
        .then((f) => alive && setFills(f))
        .catch(() => undefined);
    void load();
    const t = window.setInterval(load, 8000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [symbol, hasKeys, activity]);

  // a new symbol: take our arrows off the chart before the next ones are drawn
  useEffect(() => {
    return () => {
      if (!chart) return;
      const all = [...ids.current.values()];
      if (all.length) chart.drawings.removeMany(all);
      ids.current.clear();
    };
  }, [chart, symbol]);

  useEffect(() => {
    if (!chart) return;
    const markers = fillMarkers(symbol, fills);
    for (const m of markers) {
      if (ids.current.has(m.key)) continue;
      const d = chart.drawings.add(m.side === 'BUY' ? 'arrowmarkup' : 'arrowmarkdown', {
        paneId: 'price',
        anchors: [{ time: m.time, price: m.price }],
        style: { lineColor: m.side === 'BUY' ? GREEN : RED, lineWidth: 2, lineStyle: 'solid' },
      });
      if (d) {
        chart.drawings.update(d.id, { locked: true }); // an overlay of the app, not something to drag around
        ids.current.set(m.key, d.id);
      }
    }
    const wanted = new Set(markers.map((m) => m.key));
    for (const [key, id] of [...ids.current.entries()]) {
      if (!wanted.has(key)) {
        chart.drawings.remove(id);
        ids.current.delete(key);
      }
    }
  }, [chart, fills, symbol]);

  return null;
}
