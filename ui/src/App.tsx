import { useEffect, useRef, useState } from 'react';
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps } from 'dockview-react';
import { api, inTauri, onScannerStatus, onSignalNew, onSignals } from './api';
import { ConfirmHost, confirmDialog } from './confirm';
import { activeChartStore, useActiveChart } from './chartStore';
import { ChartPanel } from './chart/ChartPanel';
import { newChartId, openChart, setDock } from './dock';
import { TIMEFRAMES } from './intervals';
import { LadderPanel } from './panels/LadderPanel';
import { OrdersPanel } from './panels/OrdersPanel';
import { PlaceholderPanel } from './panels/PlaceholderPanel';
import { PortfolioPanel } from './panels/PortfolioPanel';
import { SignalsPanel } from './panels/SignalsPanel';
import { SymbolsPanel } from './panels/SymbolsPanel';
import { useApp } from './store';
import { startTradingPoll } from './trade';

const LAYOUT_KEY = 'harvester.layout.v5';

interface PanelDef {
  id: string;
  title: string;
  component: string;
  note?: string;
}

/** Every panel the trader can open from the View menu. Closed panels can always be brought back. */
const PANELS: PanelDef[] = [
  { id: 'symbols', title: 'Symbols', component: 'symbols' },
  { id: 'signals', title: 'Signals', component: 'signals' },
  { id: 'ladder', title: 'Ladder', component: 'ladder' },
  { id: 'orders', title: 'Orders', component: 'orders' },
  { id: 'portfolio', title: 'Portfolio', component: 'portfolio' },
];

const components = {
  chart: (p: IDockviewPanelProps<{ symbol?: string; timeframe?: string }>) => <ChartPanel {...p} />,
  symbols: () => <SymbolsPanel />,
  signals: () => <SignalsPanel />,
  ladder: () => <LadderPanel />,
  orders: () => <OrdersPanel />,
  portfolio: () => <PortfolioPanel />,
  placeholder: (p: IDockviewPanelProps<{ note: string }>) => <PlaceholderPanel {...p} />,
};

type Position = Parameters<DockviewApi['addPanel']>[0]['position'];

function addPanel(dock: DockviewApi, def: PanelDef, position?: Position) {
  if (dock.getPanel(def.id)) return;
  dock.addPanel({ id: def.id, title: def.title, component: def.component, params: { note: def.note }, position });
}

/**
 * Default layout: symbols on the left, the chart tabs in the middle with the portfolio below, and a right-hand column
 * with the Signals section on top and the Ladder / Orders tabs underneath.
 */
function buildDefaultLayout(dock: DockviewApi) {
  const by = (id: string) => PANELS.find((p) => p.id === id)!;
  const chartId = newChartId();
  dock.addPanel({ id: chartId, title: 'BTCUSDT 15m', component: 'chart', params: { symbol: 'BTCUSDT', timeframe: '15m' } });
  addPanel(dock, by('symbols'), { referencePanel: chartId, direction: 'left' });
  addPanel(dock, by('signals'), { referencePanel: chartId, direction: 'right' });
  addPanel(dock, by('orders'), { referencePanel: 'signals', direction: 'below' });
  addPanel(dock, by('ladder'), { referencePanel: 'orders', direction: 'within' });
  addPanel(dock, by('portfolio'), { referencePanel: chartId, direction: 'below' });
  dock.getPanel('orders')?.api.setActive(); // the order form is what the trader needs in view
  dock.getPanel(chartId)?.api.setActive();
  try {
    dock.getPanel('symbols')?.api.setSize({ width: 280 });
    dock.getPanel('signals')?.api.setSize({ width: 450, height: 440 });
    dock.getPanel('portfolio')?.api.setSize({ height: 190 });
  } catch {
    /* sizes are a nicety */
  }
}

/** Keep the app store in step with what the Rust scanner reports. */
function useScannerEvents() {
  useEffect(() => {
    if (!inTauri) return;
    const { setSignals, setScanner, setScannerConfig, toast } = useApp.getState();
    void api.scannerSignals().then(setSignals).catch(() => undefined);
    void api.scannerStatus().then(setScanner).catch(() => undefined);
    void api.scannerConfig().then(setScannerConfig).catch(() => undefined);
    const offs: Array<() => void> = [];
    let stopped = false;
    const keep = (p: Promise<() => void>) => void p.then((u) => (stopped ? u() : offs.push(u)));
    keep(onSignals(setSignals));
    keep(onScannerStatus(setScanner));
    keep(
      onSignalNew((s) => {
        toast(`CRACK ${s.symbol} ${s.timeframe} · score ${s.score}`, 'signal');
      }),
    );
    // the status carries the config's timeframe; refresh the full config when the scanner restarts
    keep(onScannerStatus(() => void api.scannerConfig().then(setScannerConfig).catch(() => undefined)));
    return () => {
      stopped = true;
      offs.forEach((o) => o());
    };
  }, []);
}

export function App() {
  const dockRef = useRef<DockviewApi | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const symbol = useActiveChart((s) => s.symbol) ?? '';
  const timeframe = useActiveChart((s) => s.timeframe) ?? '15m';
  const markPrice = useActiveChart((s) => s.markPrice) ?? 0;
  const precision = useActiveChart((s) => s.filters?.pricePrecision) ?? 2;
  const ladderPhase = useActiveChart((s) => s.ladder.phase) ?? 'idle';
  const env = useApp((s) => s.env);
  const setEnv = useApp((s) => s.setEnv);
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);

  useScannerEvents();
  useEffect(() => startTradingPoll(), []);

  useEffect(() => {
    if (inTauri) void api.environment().then(setEnv);
  }, [setEnv]);

  const syncOpen = (dock: DockviewApi) => setOpen(new Set(dock.panels.map((p) => p.id)));

  const onReady = (event: DockviewReadyEvent) => {
    const dock = event.api;
    dockRef.current = dock;
    setDock(dock);
    let restored = false;
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (raw) {
        dock.fromJSON(JSON.parse(raw));
        restored = dock.panels.some((p) => p.id.startsWith('chart-'));
      }
    } catch {
      restored = false;
    }
    if (!restored) {
      dock.clear();
      buildDefaultLayout(dock);
    }
    syncOpen(dock);
    dock.onDidLayoutChange(() => {
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(dock.toJSON()));
      } catch {
        /* storage unavailable */
      }
      syncOpen(dock);
    });
  };

  const toggle = (def: PanelDef) => {
    const dock = dockRef.current;
    if (!dock) return;
    const existing = dock.getPanel(def.id);
    if (existing) existing.api.close();
    else addPanel(dock, def, { referencePanel: useApp.getState().activeChartId || dock.panels[0]?.id, direction: 'right' });
  };

  const resetLayout = () => {
    const dock = dockRef.current;
    if (!dock) return;
    dock.clear();
    buildDefaultLayout(dock);
    setMenuOpen(false);
  };

  const store = () => activeChartStore()?.getState();

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Harvester<span>manual trading terminal</span>
        </div>
        <div className="sym-box">
          <b>{symbol}</b>
          <span className="last">{markPrice ? markPrice.toFixed(precision) : '…'}</span>
        </div>
        <div className="tfs">
          {TIMEFRAMES.map((t) => (
            <button key={t.interval} className={t.interval === timeframe ? 'active' : ''} onClick={() => store()?.setTimeframe(t.interval)}>
              {t.label}
            </button>
          ))}
        </div>
        <button className="tool" title="Open this symbol in a new chart tab" onClick={() => openChart(symbol || 'BTCUSDT', timeframe, true)}>
          + Chart
        </button>
        <button className={`tool${ladderPhase !== 'idle' ? ' active' : ''}`} title="Draw a ladder of orders on the chart (L)" onClick={() => store()?.patchLadder({ phase: ladderPhase === 'idle' ? 'start' : 'idle' })}>
          ☰ Ladder <kbd>L</kbd>
        </button>
        <div className="spacer" />
        <button
          className={`env ${env}`}
          title="Switch between the testnet and live exchange"
          onClick={async () => {
            const next = env === 'testnet' ? 'live' : 'testnet';
            if (next === 'live' && !(await confirmDialog('Switch to LIVE market data and trading?\n\nReal money is at risk once live API keys are configured.', { danger: true, confirmLabel: 'Go live' }))) return;
            void api.setEnvironment(next).then(() => {
              setEnv(next);
              window.location.reload();
            });
          }}
        >
          {env.toUpperCase()}
        </button>
        <div className="menu">
          <button onClick={() => setMenuOpen((v) => !v)}>View ▾</button>
          {menuOpen && (
            <div className="menu-pop" onMouseLeave={() => setMenuOpen(false)}>
              {PANELS.map((p) => (
                <label key={p.id}>
                  <input type="checkbox" checked={open.has(p.id)} onChange={() => toggle(p)} /> {p.title}
                </label>
              ))}
              <hr />
              <button onClick={resetLayout}>Reset layout</button>
            </div>
          )}
        </div>
      </header>
      <main className="dock">
        <DockviewReact className="dockview-theme-abyss" components={components} onReady={onReady} />
      </main>
      <ConfirmHost />
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`} onClick={() => dismiss(t.id)}>
            {t.text}
          </div>
        ))}
      </div>
      {!inTauri && <div className="browser-warning">Running outside the Harvester window: market data is unavailable. Start it with <code>pnpm dev</code>.</div>}
    </div>
  );
}
