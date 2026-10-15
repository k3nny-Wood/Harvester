import { useEffect, useState } from 'react';
import { api, hasBackend } from '../api';
import logo from '../assets/logo.png';
import { ConfirmHost } from '../confirm';
import { WebLogin } from '../components/WebLogin';
import { useLivePositions } from '../livePositions';
import { useScannerEvents } from '../scannerEvents';
import { useApp } from '../store';
import { startTradingPoll } from '../trade';
import './mobile.css';
import { switchView, useMobile, type Tab } from './store';
import { ChartTab, OrdersTab, PositionsTab, ScannerTab } from './tabs';

const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: 'positions', label: 'Positions', icon: '◆' },
  { id: 'chart', label: 'Chart', icon: '▥' },
  { id: 'orders', label: 'Orders', icon: '≡' },
  { id: 'scanner', label: 'Scanner', icon: '◎' },
];

/** The phone layout: positions, chart with quick trading, orders and the scanner, with the balance on top. */
export function MobileApp() {
  const tab = useMobile((s) => s.tab);
  const setTab = useMobile((s) => s.setTab);
  const env = useApp((s) => s.env);
  const setEnv = useApp((s) => s.setEnv);
  const setSymbols = useApp((s) => s.setSymbols);
  const account = useApp((s) => s.account);
  const orders = useApp((s) => s.orders);
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  const live = useLivePositions();
  const [menu, setMenu] = useState(false);

  useScannerEvents();
  useEffect(() => startTradingPoll(), []);
  useEffect(() => {
    if (hasBackend) void api.environment().then(setEnv).catch(() => undefined);
  }, [setEnv]);
  // the symbol list (for the picker), refreshed once a minute
  useEffect(() => {
    if (!hasBackend) return;
    const load = () => void api.listSymbols().then(setSymbols).catch(() => undefined);
    load();
    const t = window.setInterval(load, 60_000);
    return () => window.clearInterval(t);
  }, [setSymbols]);

  const equity = account ? account.walletBalance + (live?.unrealizedPnl ?? account.unrealizedPnl) : null;
  const open = live?.positions.filter((p) => p.amount !== 0).length ?? 0;

  return (
    <div className="m-app">
      <header className="m-top">
        <img className="m-logo" src={logo} alt="" />
        <div className="m-equity">
          <b>{equity == null ? '…' : `$${equity.toFixed(2)}`}</b>
          {account && <small className={(live?.unrealizedPnl ?? 0) >= 0 ? 'up' : 'down'}>{(live?.unrealizedPnl ?? 0) >= 0 ? '+' : '-'}${Math.abs(live?.unrealizedPnl ?? 0).toFixed(2)} open · ${account.availableBalance.toFixed(0)} free</small>}
        </div>
        <span className={`m-env ${env === 'live' ? 'live' : ''}`}>{env === 'live' ? 'LIVE' : 'TESTNET'}</span>
        <button className="m-menu" onClick={() => setMenu((v) => !v)} aria-label="Menu">⋯</button>
        {menu && (
          <div className="m-menu-pop" onClick={() => setMenu(false)}>
            <button onClick={() => switchView('desktop')}>Desktop view</button>
            <button onClick={() => window.location.reload()}>Reload</button>
          </div>
        )}
      </header>
      <main className="m-main">
        {tab === 'positions' && <PositionsTab />}
        {tab === 'chart' && <ChartTab />}
        {tab === 'orders' && <OrdersTab />}
        {tab === 'scanner' && <ScannerTab />}
      </main>
      <nav className="m-nav">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            <span className="m-nav-icon">{t.icon}</span>
            {t.label}
            {t.id === 'positions' && open > 0 ? <i className="m-count">{open}</i> : null}
            {t.id === 'orders' && orders.length > 0 ? <i className="m-count">{orders.length}</i> : null}
          </button>
        ))}
      </nav>
      <div className="m-toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`m-toast ${t.tone}`} onClick={() => dismiss(t.id)}>
            {t.text}
          </div>
        ))}
      </div>
      <ConfirmHost />
      <WebLogin />
      {!hasBackend && <div className="m-warn m-pad">No Harvester engine to talk to.</div>}
    </div>
  );
}
