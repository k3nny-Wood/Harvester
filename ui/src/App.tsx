import { useEffect, useRef, useState } from 'react';
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps } from 'dockview-react';
import { api, inTauri } from './api';
import { ChartPanel } from './chart/ChartPanel';
import { TIMEFRAMES } from './intervals';
import { LadderPanel } from './panels/LadderPanel';
import { PlaceholderPanel } from './panels/PlaceholderPanel';
import { SymbolsPanel } from './panels/SymbolsPanel';
import { useApp } from './store';

const LAYOUT_KEY = 'harvester.layout.v1';

interface PanelDef {
  id: string;
  title: string;
  component: string;
  note?: string;
}

/** Every panel the trader can open from the View menu. Closed panels can always be brought back. */
const PANELS: PanelDef[] = [
  { id: 'chart', title: 'Chart', component: 'chart' },
  { id: 'symbols', title: 'Symbols', component: 'symbols' },
  { id: 'ladder', title: 'Ladder', component: 'ladder' },
  { id: 'signals', title: 'Signals', component: 'placeholder', note: 'QFL base cracks and drop-scanner signals, scored by structure, appear here.' },
  { id: 'orders', title: 'Orders', component: 'placeholder', note: 'Open orders, with cancel and edit, appear here once trading is connected.' },
  { id: 'portfolio', title: 'Portfolio', component: 'placeholder', note: 'Positions, balances and trade history appear here once trading is connected.' },
];

const components = {
  chart: () => <ChartPanel />,
  symbols: () => <SymbolsPanel />,
  ladder: () => <LadderPanel />,
  placeholder: (p: IDockviewPanelProps<{ note: string }>) => <PlaceholderPanel {...p} />,
};

function addPanel(api: DockviewApi, def: PanelDef, position?: Parameters<DockviewApi['addPanel']>[0]['position']) {
  if (api.getPanel(def.id)) return;
  api.addPanel({ id: def.id, title: def.title, component: def.component, params: { note: def.note }, position });
}

function buildDefaultLayout(dock: DockviewApi) {
  const by = (id: string) => PANELS.find((p) => p.id === id)!;
  addPanel(dock, by('chart'));
  addPanel(dock, by('symbols'), { referencePanel: 'chart', direction: 'left' });
  addPanel(dock, by('signals'), { referencePanel: 'symbols', direction: 'within' });
  addPanel(dock, by('ladder'), { referencePanel: 'chart', direction: 'right' });
  addPanel(dock, by('orders'), { referencePanel: 'ladder', direction: 'within' });
  addPanel(dock, by('portfolio'), { referencePanel: 'chart', direction: 'below' });
  dock.getPanel('symbols')?.api.setActive();
  dock.getPanel('ladder')?.api.setActive();
  try {
    dock.getPanel('symbols')?.api.setSize({ width: 300 });
    dock.getPanel('ladder')?.api.setSize({ width: 340 });
    dock.getPanel('portfolio')?.api.setSize({ height: 200 });
  } catch {
    /* sizes are a nicety */
  }
}

export function App() {
  const dockRef = useRef<DockviewApi | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const symbol = useApp((s) => s.symbol);
  const timeframe = useApp((s) => s.timeframe);
  const setTimeframe = useApp((s) => s.setTimeframe);
  const markPrice = useApp((s) => s.markPrice);
  const precision = useApp((s) => s.filters?.pricePrecision ?? 2);
  const env = useApp((s) => s.env);
  const setEnv = useApp((s) => s.setEnv);
  const ladderPhase = useApp((s) => s.ladder.phase);
  const patchLadder = useApp((s) => s.patchLadder);

  useEffect(() => {
    if (inTauri) void api.environment().then(setEnv);
  }, [setEnv]);

  const syncOpen = (dock: DockviewApi) => setOpen(new Set(dock.panels.map((p) => p.id)));

  const onReady = (event: DockviewReadyEvent) => {
    const dock = event.api;
    dockRef.current = dock;
    let restored = false;
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (raw) {
        dock.fromJSON(JSON.parse(raw));
        restored = !!dock.getPanel('chart');
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
    else addPanel(dock, def, dock.getPanel('chart') ? { referencePanel: 'chart', direction: 'right' } : undefined);
  };

  const resetLayout = () => {
    const dock = dockRef.current;
    if (!dock) return;
    dock.clear();
    buildDefaultLayout(dock);
    setMenuOpen(false);
  };

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
            <button key={t.interval} className={t.interval === timeframe ? 'active' : ''} onClick={() => setTimeframe(t.interval)}>
              {t.label}
            </button>
          ))}
        </div>
        <button className={`tool${ladderPhase !== 'idle' ? ' active' : ''}`} title="Draw a ladder of orders on the chart (L)" onClick={() => patchLadder({ phase: ladderPhase === 'idle' ? 'start' : 'idle' })}>
          ☰ Ladder <kbd>L</kbd>
        </button>
        <div className="spacer" />
        <button
          className={`env ${env}`}
          title="Switch between the testnet and live exchange"
          onClick={() => {
            const next = env === 'testnet' ? 'live' : 'testnet';
            if (next === 'live' && !window.confirm('Switch to LIVE market data and trading? Real money is at risk once orders are enabled.')) return;
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
      {!inTauri && <div className="browser-warning">Running outside the Harvester window: market data is unavailable. Start it with <code>pnpm dev</code>.</div>}
    </div>
  );
}
