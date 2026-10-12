import type { DockviewApi } from 'dockview-react';
import { activeChartStore, chartRegistry } from './chartStore';
import { useApp } from './store';

let dock: DockviewApi | null = null;

export function setDock(d: DockviewApi | null) {
  dock = d;
}

export function getDock(): DockviewApi | null {
  return dock;
}

let counter = 0;
export function newChartId(): string {
  counter += 1;
  return `chart-${Date.now().toString(36)}${counter}`;
}

/**
 * Open a chart for a symbol as a new tab (next to the chart that has focus), or focus the tab that already shows it.
 * `forceNew` always creates a tab, which is how the same symbol is viewed on two timeframes.
 */
export function openChart(symbol: string, timeframe?: string, forceNew = false): void {
  const d = dock;
  if (!d) return;
  const tf = timeframe ?? activeChartStore()?.getState().timeframe ?? '15m';
  if (!forceNew) {
    for (const [id, store] of chartRegistry) {
      const s = store.getState();
      if (s.symbol === symbol && s.timeframe === tf) {
        d.getPanel(id)?.api.setActive();
        return;
      }
    }
  }
  const active = useApp.getState().activeChartId;
  const ref = d.getPanel(active) ?? d.panels.find((p) => p.id.startsWith('chart-'));
  const id = newChartId();
  d.addPanel({
    id,
    component: 'chart',
    title: `${symbol} ${tf}`,
    params: { symbol, timeframe: tf },
    position: ref ? { referencePanel: ref.id, direction: 'within' } : undefined,
  });
  d.getPanel(id)?.api.setRenderer('always'); // keep the chart (and its Vela instance) alive when its tab is hidden
  d.getPanel(id)?.api.setActive();
}

/** Show a symbol in the chart that has focus (the usual click in the symbol list). */
export function showSymbol(symbol: string): void {
  const store = activeChartStore();
  if (store) store.getState().setSymbol(symbol);
  else openChart(symbol);
}
