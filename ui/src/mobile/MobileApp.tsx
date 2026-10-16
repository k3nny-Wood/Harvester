import { useCallback, useEffect, useState } from 'react';
import { api, hasBackend } from '../api';
import logo from '../assets/logo.png';
import { ConfirmHost } from '../confirm';
import { WebLogin } from '../components/WebLogin';
import { useLivePositions } from '../livePositions';
import { useScannerEvents } from '../scannerEvents';
import { useApp } from '../store';
import { refreshTrading, startTradingPoll } from '../trade';
import './mobile.css';
import { useDragScroll } from './dragScroll';
import { PULL_TRIGGER, usePullRefresh } from './pullRefresh';
import { useFloater } from './floaterStore';
import { useMobile, type Tab } from './store';
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
  // while the order dock is open it takes the place of the bottom navigation (in portrait)
  const docked = useFloater((s) => !!s.f);
  const dragScroll = useDragScroll();
  // the scrolling area, also given to the pull-down-to-refresh (not on the chart tab: a drag there pans the chart)
  const [mainEl, setMainEl] = useState<HTMLElement | null>(null);
  const mainRef = useCallback(
    (el: HTMLElement | null) => {
      setMainEl(el);
      dragScroll(el);
    },
    [dragScroll],
  );
  const pull = usePullRefresh(mainEl, tab !== 'chart', async () => {
    await Promise.all([refreshTrading(), api.listSymbols().then(setSymbols)]);
  });

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
  const upnl = live?.unrealizedPnl ?? account?.unrealizedPnl ?? 0;
  const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: Math.abs(n) < 100 ? 2 : 0 })}`;

  return (
    <div className={`m-app${docked ? ' docked' : ''}`}>
      <header className="m-top">
        <img className="m-logo" src={logo} alt="" />
        <div className="m-equity">
          <b>{equity == null ? '…' : `$${equity.toFixed(2)}`}</b>
        </div>
        {account && (
          <div className="m-stats">
            <span>uPnL <b className={upnl > 0 ? 'up' : upnl < 0 ? 'down' : ''}>{upnl >= 0 ? '+' : ''}{money(upnl)}</b></span>
            <span>Wallet <b>{money(account.walletBalance)}</b></span>
            <span>Free <b>{money(account.availableBalance)}</b></span>
            <span>Open <b>{open}</b></span>
          </div>
        )}
        {/* the TESTNET badge and the menu are gone; a LIVE badge stays */}
        {env === 'live' && <span className={`m-env ${env === 'live' ? 'live' : ''}`}>{env === 'live' ? 'LIVE' : 'TESTNET'}</span>}
      </header>
      <main className="m-main" ref={mainRef}>
        {(pull.dist > 0 || pull.refreshing) && (
          <div className="m-pull" style={{ height: pull.dist }}>
            <span className={pull.refreshing ? 'spin' : ''} style={pull.refreshing ? undefined : { transform: `rotate(${Math.min(180, (pull.dist / PULL_TRIGGER) * 180)}deg)` }}>↓</span>
            {pull.refreshing ? 'Refreshing…' : pull.dist >= PULL_TRIGGER ? 'Release to refresh' : 'Pull to refresh'}
          </div>
        )}
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
        {toasts.slice(-2).map((t) => (
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
