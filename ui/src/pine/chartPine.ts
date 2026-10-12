import type { IndicatorHandle, Vela } from '@luxalgo/vela';
import { PineWorkerEngine } from '@luxalgo/vela-pinets';
import type { PineReadout, PineScript, PineStore } from './pineStore';

/**
 * Mounts Pine Script indicators onto one Vela chart through the PineTS engine.
 *
 * The engine runs in a Web Worker so a heavy script never blocks the chart. The bridge keeps a handle per script id and
 * reconciles the chart's Pine store against the chart: new scripts are added, edited sources are swapped in place,
 * removed scripts are torn down, and toggles just hide / show (which suspends the computation).
 */
export interface PineBridge {
  sync: (scripts: PineScript[]) => void;
  dispose: () => void;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '-';
    if (Math.abs(value) >= 1000) return value.toFixed(2);
    return value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  }
  return String(value);
}

async function readout(handle: IndicatorHandle): Promise<PineReadout[]> {
  try {
    const context = await handle.context(['plots', 'meta']);
    if (!context) return [];
    return Object.entries(context.plots)
      .filter(([name]) => !name.startsWith('__'))
      .slice(0, 8)
      .map(([name, points]) => {
        const last = [...points].reverse().find((point) => point.value !== null && point.value !== undefined);
        return { label: name, value: formatValue(last?.value) };
      });
  } catch {
    return [];
  }
}

export function createPineBridge(chart: Vela, pine: PineStore): PineBridge {
  const handles = new Map<string, IndicatorHandle>();
  chart.registerEngine('pine', new PineWorkerEngine());
  const state = () => pine.getState();

  const refreshAll = () => {
    for (const [id, handle] of handles) {
      if (!handle.visible) continue;
      void readout(handle).then((values) => state().setReadout(id, values));
    }
  };

  const attach = (script: PineScript) => {
    try {
      const handle = chart.addIndicator(script.source, { id: script.id, title: script.name, language: 'pine' });
      handle.setVisible(script.enabled);
      handle.on('ready', () => {
        state().setStatus(script.id, 'running');
        void readout(handle).then((values) => state().setReadout(script.id, values));
      });
      handle.on('error', (payload) => state().setStatus(script.id, 'error', payload.error?.message ?? 'Script failed'));
      handles.set(script.id, handle);
    } catch (error) {
      state().setStatus(script.id, 'error', (error as Error).message);
    }
  };

  const sync = (scripts: PineScript[]) => {
    for (const script of scripts) {
      const handle = handles.get(script.id);
      if (!handle) {
        attach(script);
        continue;
      }
      handle.setVisible(script.enabled);
      if (handle.source !== script.source) {
        void handle.updateCode(script.source).then((result) => {
          if (!result.ok) state().setStatus(script.id, 'error', result.error?.message ?? 'Script failed');
          else state().setStatus(script.id, 'running');
        });
      }
    }
    for (const [id, handle] of [...handles]) {
      if (!scripts.some((script) => script.id === id)) {
        handle.remove();
        handles.delete(id);
        state().setReadout(id, []);
      }
    }
  };

  // An indicator removed straight from the chart (Vela's own list, a right-click) must leave the store too, otherwise the
  // panel keeps listing it and re-choosing the same preset would do nothing.
  const offRemoved = chart.on('indicator:removed', (payload: { id: string }) => {
    if (!handles.has(payload.id)) return;
    handles.delete(payload.id);
    state().removeScript(payload.id);
  });

  // A new symbol or timeframe restarts every script: re-read the values, and on a slow timer so the panel shows live numbers.
  const offMarket = chart.on('market:changed', () => refreshAll());
  const timer = setInterval(() => refreshAll(), 5000);

  return {
    sync,
    dispose: () => {
      clearInterval(timer);
      if (typeof offRemoved === 'function') offRemoved();
      if (typeof offMarket === 'function') offMarket();
      for (const handle of handles.values()) handle.remove();
      handles.clear();
    },
  };
}
