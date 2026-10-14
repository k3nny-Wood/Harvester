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

/** The chart tabs that show a symbol more than once: every one but the first (or the one to keep). Only one chart per symbol is allowed. */
export function chartsToClose(charts: Array<{ id: string; symbol: string }>, keepId?: string): string[] {
  const keep = new Map<string, string>();
  for (const c of charts) if (!keep.has(c.symbol) || c.id === keepId) keep.set(c.symbol, c.id);
  return charts.filter((c) => keep.get(c.symbol) !== c.id).map((c) => c.id);
}

/** The id of the chart tab that shows `symbol`, if there is one (a tab of a restored layout counts before it has mounted). */
function chartIdOf(d: DockviewApi, symbol: string): string | undefined {
  for (const [id, store] of chartRegistry) if (store.getState().symbol === symbol && d.getPanel(id)) return id;
  return d.panels.find((p) => p.id.startsWith('chart-') && (p.params as { symbol?: string } | undefined)?.symbol === symbol)?.id;
}

/** Close the extra tabs of a symbol (a layout saved before this rule can hold several). */
export function dedupeCharts(d: DockviewApi): void {
  const charts = d.panels.filter((p) => p.id.startsWith('chart-')).map((p) => ({ id: p.id, symbol: (p.params as { symbol?: string } | undefined)?.symbol ?? '' })).filter((c) => c.symbol);
  const active = useApp.getState().activeChartId;
  for (const id of chartsToClose(charts, active)) d.getPanel(id)?.api.close();
}

/**
 * Show a symbol's chart: there is only ever ONE chart per symbol, whatever its timeframe. If the symbol is already open its tab is brought to the
 * front (and switched to `timeframe` when one is asked for); otherwise a new tab opens next to the chart that has focus.
 */
export function openChart(symbol: string, timeframe?: string, _forceNew = false): void {
  const d = dock;
  if (!d) return;
  const existing = chartIdOf(d, symbol);
  if (existing) {
    d.getPanel(existing)?.api.setActive();
    const store = chartRegistry.get(existing);
    if (timeframe && store && store.getState().timeframe !== timeframe) store.getState().setTimeframe(timeframe);
    return;
  }
  const tf = timeframe ?? activeChartStore()?.getState().timeframe ?? '15m';
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

/** Show a symbol in the chart that has focus; when another tab already shows it, that tab is brought up instead (one chart per symbol). */
export function showSymbol(symbol: string): void {
  const d = dock;
  const store = activeChartStore();
  if (d && chartIdOf(d, symbol)) return openChart(symbol);
  if (store) store.getState().setSymbol(symbol);
  else openChart(symbol);
}
