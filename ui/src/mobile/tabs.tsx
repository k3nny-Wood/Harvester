import { useEffect, useMemo, useRef, useState } from 'react';
import { api, onKline } from '../api';
import { confirmDialog } from '../confirm';
import { useLivePositions } from '../livePositions';
import { exitState } from '../positionExits';
import { useApp } from '../store';
import { refreshTrading } from '../trade';
import type { Kline, Position } from '../types';
import { fmtPrice, type ChartLine } from './chartMath';
import { ExitSheet } from './ExitSheet';
import { MobileChart, type FillMark, type PendingLine } from './MobileChart';
import { IND_LIST, type IndKey } from './indicators';
import { closedTrades, historyTotals } from './history';
import { insightBadges } from '../insight';
import { fillMarkers } from '../chart/ChartFills';
import { TIMEFRAMES, useMobile } from './store';
import { useFloater } from './floaterStore';
import { OrderFloater, sideFor } from './OrderFloater';
import { pctText, resolveBoth, resolveExit } from './exits';
import { snapToTick } from '../ladderMath';
import { useDragScroll } from './dragScroll';
import { Thumb } from '../components/Thumb';
import { nextSort, sortSymbols, type SortDir, type SortKey } from '../symbolSort';
import type { OpenOrder } from '../types';

const coin = (s: string) => s.replace('USDT', '');

function compactVol(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}

const SYM_SORT_KEY = 'harvester.mobile.symsort.v1';
function loadSymSort(): { key: SortKey; dir: SortDir } {
  try {
    const v = JSON.parse(window.localStorage.getItem(SYM_SORT_KEY) ?? 'null');
    if (v && ['name', 'change', 'volume'].includes(v.key) && ['asc', 'desc'].includes(v.dir)) return v;
  } catch {
    /* default */
  }
  return { key: 'volume', dir: 'desc' };
}
const usd = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: n < 100 ? 2 : 0 });
const signed = (n: number, d = 2) => `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(d)}`;
const tone = (n: number) => (n > 0 ? 'up' : n < 0 ? 'down' : '');

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

// ---------------------------------------------------------------- positions

function PositionCard({ p }: { p: Position }) {
  const orders = useApp((s) => s.orders);
  const toast = useApp((s) => s.toast);
  const openChart = useMobile((s) => s.openChart);
  const [exit, setExit] = useState<'stop' | 'take' | null>(null);
  const [open, setOpen] = useState(false);
  const long = p.amount > 0;
  const ex = exitState(p.symbol, p.amount, orders);
  const level = (o: typeof ex.stop) => (o ? fmtPrice(o.stopPrice || o.price) : 'none');
  // what Binance holds for the position; the estimate from entry value and leverage only when it did not say
  const margin = p.initialMargin && p.initialMargin > 0 ? p.initialMargin : (Math.abs(p.amount) * p.entryPrice) / Math.max(1, p.leverage);
  const roe = margin > 0 ? (p.unrealizedPnl / margin) * 100 : 0;
  const close = async (fraction: number) => {
    if (!(await confirmDialog(`Close ${Math.round(fraction * 100)}% of the ${p.symbol} ${long ? 'long' : 'short'} at market?`, { confirmLabel: 'Close', danger: true }))) return;
    try {
      await api.closePosition(p.symbol, fraction);
      toast(`Closing ${Math.round(fraction * 100)}% of ${p.symbol}`, 'info');
      void refreshTrading();
    } catch (e) {
      toast(`Close: ${e}`, 'warn');
    }
  };
  return (
    <div className={`m-card m-pos ${p.unrealizedPnl > 0 ? 'win' : p.unrealizedPnl < 0 ? 'loss' : 'flat'}`}>
      <div className="m-row m-pos-head" onClick={() => setOpen((v) => !v)} role="button" aria-expanded={open}>
        <button
          className="m-pos-chart"
          aria-label={`Open the ${p.symbol} chart`}
          title="Open the chart"
          onClick={(e) => {
            e.stopPropagation();
            openChart(p.symbol);
          }}
        >
          ▥
        </button>
        <b className="m-coin">{coin(p.symbol)}</b>
        <span className={`m-badge ${long ? 'up' : 'down'}`}>{long ? 'LONG' : 'SHORT'}</span>
        <span className="m-muted">{p.leverage}x {p.isolated ? 'iso' : 'cross'}</span>
        <span className={`m-pnl ${tone(p.unrealizedPnl)}`}>
          {signed(p.unrealizedPnl)} <small>({roe >= 0 ? '+' : ''}{roe.toFixed(1)}%)</small>
        </span>
        <span className="m-chev">{open ? '▴' : '▾'}</span>
      </div>
      {open && <div className="m-grid">
        <span>Entry <b>{fmtPrice(p.entryPrice)}</b></span>
        <span>Now <b>{fmtPrice(p.markPrice)}</b></span>
        <span>Size <b>${usd(Math.abs(p.amount) * (p.markPrice || p.entryPrice))}</b></span>
        <span>Margin <b>${usd(margin)}</b></span>
        <span>Tokens <b>{Math.abs(p.amount)}</b></span>
        <span>Stop <b className={ex.stop ? '' : 'm-warn-text'}>{level(ex.stop)}</b></span>
        <span>Target <b>{level(ex.take)}</b></span>
        <span>Liq <b>{p.liquidationPrice > 0 ? fmtPrice(p.liquidationPrice) : '-'}</b></span>
      </div>}
      {open && <div className="m-actions">
        <button onClick={() => setExit('stop')} title={ex.stop ? 'Move the stop-loss' : 'Set a stop-loss'}>{ex.stop ? 'SL ✎' : '+ SL'}</button>
        <button onClick={() => setExit('take')} title={ex.take ? 'Move the take-profit' : 'Set a take-profit'}>{ex.take ? 'TP ✎' : '+ TP'}</button>
        <button className="m-danger" onClick={() => void close(0.5)}>50%</button>
        <button className="m-danger" onClick={() => void close(1)}>Close</button>
      </div>}
      {exit && <ExitSheet kind={exit} position={p} onClose={() => setExit(null)} />}
    </div>
  );
}

export function PositionsTab() {
  const live = useLivePositions();
  const account = useApp((s) => s.account);
  const trading = useApp((s) => s.trading);
  if (trading && !trading.hasCredentials) return <div className="m-empty">No Binance API keys are set on the server for this environment.</div>;
  if (!account || !live) return <div className="m-empty">Loading the account…</div>;
  const rows = [...live.positions].filter((p) => p.amount !== 0).sort((a, b) => a.unrealizedPnl - b.unrealizedPnl);
  if (!rows.length) return <div className="m-empty">No open positions.</div>;
  return (
    <div className="m-list">
      {rows.map((p) => (
        <PositionCard key={p.symbol} p={p} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- orders

export function OrdersTab() {
  const orders = useApp((s) => s.orders);
  const toast = useApp((s) => s.toast);
  const openChart = useMobile((s) => s.openChart);
  const cancel = async (o: (typeof orders)[number]) => {
    if (!(await confirmDialog(`Cancel the ${o.side} ${o.type.replace(/_/g, ' ').toLowerCase()} on ${o.symbol}?`, { confirmLabel: 'Cancel order' }))) return;
    try {
      await api.cancelOrder(o.symbol, o.orderId, o.conditional);
      void refreshTrading();
    } catch (e) {
      toast(`Cancel: ${e}`, 'warn');
    }
  };
  const cancelAll = async (sym: string, list: typeof orders) => {
    if (!(await confirmDialog(`Cancel all ${list.length} order${list.length === 1 ? '' : 's'} on ${sym}?`, { confirmLabel: 'Cancel all', danger: true }))) return;
    let failed = 0;
    for (const o of list) {
      try {
        await api.cancelOrder(o.symbol, o.orderId, o.conditional);
      } catch {
        failed++;
      }
    }
    if (failed) toast(`${sym}: ${failed} of ${list.length} orders could not be cancelled`, 'warn');
    void refreshTrading();
  };
  const groups = useMemo(() => {
    const by = new Map<string, typeof orders>();
    for (const o of [...orders].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.price - b.price)) by.set(o.symbol, [...(by.get(o.symbol) ?? []), o]);
    return [...by.entries()];
  }, [orders]);
  if (!orders.length) return <div className="m-empty">No open orders.</div>;
  return (
    <div className="m-list">
      {groups.map(([sym, list]) => (
        <div key={sym} className="m-ogroup">
          <div className="m-ogroup-head" onClick={() => openChart(sym)}>
            <b className="m-coin">{coin(sym)}</b>
            <span className="m-muted">{list.length} order{list.length === 1 ? '' : 's'}</span>
            <button
              className="m-danger m-order-x m-cancel-all"
              onClick={(e) => {
                e.stopPropagation();
                void cancelAll(sym, list);
              }}
            >
              Cancel all
            </button>
            <span className="m-chev">›</span>
          </div>
          {list.map((o) => (
          <div key={`${o.conditional}-${o.orderId}`} className="m-card m-order m-order-in">
            <div className="m-row">
              <span className={`m-badge ${o.side === 'BUY' ? 'up' : 'down'}`}>{o.side}</span>
              <span className="m-muted m-order-type">{o.type.replace(/_/g, ' ').toLowerCase()}{o.reduceOnly ? ' · reduce' : ''}</span>
              <button
                className="m-danger m-order-x"
                onClick={(e) => {
                  e.stopPropagation();
                  void cancel(o);
                }}
              >
                Cancel
              </button>
            </div>
            <div className="m-order-info">
              Price <b>{fmtPrice(o.stopPrice && !o.price ? o.stopPrice : o.price)}</b> · Qty <b>{o.origQty}</b>
              {o.executedQty > 0 && (
                <>
                  {' '}
                  · Filled <b>{o.executedQty}</b>
                </>
              )}
            </div>
          </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- history

const HISTORY_DAYS = [1, 7, 30] as const;
/** How many symbols' fills are fetched at a time (each is one request to Binance). */
const HISTORY_BATCH = 8;

/** The closed trades of the account: every order that realised profit or loss, grouped from the fills of the symbols that did. */
export function HistoryTab() {
  const trading = useApp((s) => s.trading);
  const toast = useApp((s) => s.toast);
  const openChart = useMobile((s) => s.openChart);
  const [days, setDays] = useState<(typeof HISTORY_DAYS)[number]>(7);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [fills, setFills] = useState<Record<string, import('../types').TradeRecord[]>>({});
  const [loading, setLoading] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // "Clear" hides everything up to now on this phone (Binance keeps the real history, which cannot be deleted); "Show all" brings it back
  const [clearedAt, setClearedAt] = useState(() => {
    try {
      return Number(window.localStorage.getItem('harvester.mobile.histClear.v1')) || 0;
    } catch {
      return 0;
    }
  });
  const keepCleared = (ms: number) => {
    setClearedAt(ms);
    try {
      window.localStorage.setItem('harvester.mobile.histClear.v1', String(ms));
    } catch {
      /* not remembered */
    }
  };
  const hasKeys = !!trading?.hasCredentials;

  // a pull-down refresh asks for everything again
  useEffect(() => {
    const again = () => setTick((t) => t + 1);
    window.addEventListener('harvester-refresh', again);
    return () => window.removeEventListener('harvester-refresh', again);
  }, []);

  const loadSymbols = async (n: number, list: string[]) => {
    const next = list.slice(0, n);
    const got: Record<string, import('../types').TradeRecord[]> = {};
    for (const sym of next) {
      try {
        got[sym] = await api.tradeHistory(sym, 300);
      } catch (e) {
        toast(`${sym}: ${e}`, 'warn');
      }
    }
    setFills((f) => ({ ...f, ...got }));
  };

  useEffect(() => {
    if (!hasKeys) return;
    let alive = true;
    setLoading(true);
    api
      .incomeSymbols(days)
      .then(async (rows) => {
        if (!alive) return;
        const list = rows.map((r) => r.symbol);
        setSymbols(list);
        setFills({});
        await loadSymbols(HISTORY_BATCH, list);
      })
      .catch((e) => toast(`History: ${e}`, 'warn'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, hasKeys, tick]);

  const loaded = Object.keys(fills).length;
  const since = Date.now() - days * 86_400_000;
  const account = useApp((s) => s.account);
  const openSizes = useMemo(() => Object.fromEntries((account?.positions ?? []).map((p) => [p.symbol, p.amount])), [account]);
  const trades = useMemo(() => closedTrades(Object.values(fills).flat(), openSizes).filter((t) => t.time >= since && t.time > clearedAt), [fills, since, openSizes, clearedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const totals = historyTotals(trades);
  if (trading && !trading.hasCredentials) return <div className="m-empty">No Binance API keys are set on the server for this environment.</div>;
  const when = (ms: number) => {
    const d = new Date(ms);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
  };
  return (
    <div className="m-list">
      <div className="m-chips">
        {HISTORY_DAYS.map((d) => (
          <button key={d} className={`m-chip on-ind${days === d ? ' on' : ''}`} onClick={() => setDays(d)}>
            {d === 1 ? '24h' : `${d} days`}
          </button>
        ))}
        <button
          className="m-chip m-chip-clear"
          disabled={!trades.length}
          onClick={() => {
            void confirmDialog(`Clear the ${trades.length} trade${trades.length === 1 ? '' : 's'} shown? They are only hidden on this phone; Binance keeps the history.`, { confirmLabel: 'Clear', danger: true }).then((ok) => ok && keepCleared(Date.now()));
          }}
        >
          Clear
        </button>
      </div>
      {clearedAt > 0 && (
        <div className="m-muted m-pad">
          Showing trades after {when(clearedAt)} · <a onClick={() => keepCleared(0)}>Show all</a>
        </div>
      )}
      <div className="m-hist-sum">
        <span>Trades <b>{totals.count}</b></span>
        <span>Net <b className={tone(totals.net)}>{signed(totals.net)}</b></span>
        <span>Win <b>{totals.count ? Math.round((totals.wins / totals.count) * 100) : 0}%</b></span>
        <span>Fees <b>${totals.fees.toFixed(2)}</b></span>
      </div>
      {!trades.length && <div className="m-empty">{loading ? 'Loading…' : 'No closed trades in this period.'}</div>}
      {trades.map((t) => {
        const isOpen = openKey === t.key;
        return (
          <div key={t.key} className={`m-card m-pos ${t.net > 0 ? 'win' : t.net < 0 ? 'loss' : 'flat'}`} onClick={() => setOpenKey(isOpen ? null : t.key)}>
            <div className="m-row m-pos-head">
              <button
                className="m-pos-chart"
                aria-label={`Open the ${t.symbol} chart`}
                title="Open the chart"
                onClick={(e) => {
                  e.stopPropagation();
                  openChart(t.symbol);
                }}
              >
                ▥
              </button>
              <b className="m-coin">{coin(t.symbol)}</b>
              <span className={`m-badge ${t.long ? 'up' : 'down'}`}>{t.long ? 'LONG' : 'SHORT'}</span>
              {t.partial && <span className="m-badge warn" title="Closed only part of the position">PARTIAL</span>}
              <span className="m-muted m-sig-meta">{when(t.time)}</span>
              <span className={`m-pnl ${tone(t.net)}`}>
                {signed(t.net)} <small>({t.pct >= 0 ? '+' : ''}{t.pct.toFixed(1)}%)</small>
              </span>
              <span className="m-chev">{isOpen ? '▴' : '▾'}</span>
            </div>
            {isOpen && (
              <div className="m-grid">
                <span>Entry <b>{fmtPrice(t.entry)}</b></span>
                <span>Exit <b>{fmtPrice(t.exit)}</b></span>
                <span>Tokens <b>{t.qty}</b></span>
                <span>Value <b>${usd(t.notional)}</b></span>
                <span>Gross <b className={tone(t.pnl)}>{signed(t.pnl)}</b></span>
                <span>Fees <b>${t.fees.toFixed(2)}</b></span>
                {t.partial && <span>Still open <b>{t.remaining}</b></span>}
              </div>
            )}
          </div>
        );
      })}
      {loaded < symbols.length && (
        <div className="m-actions">
          <button
            disabled={loading}
            onClick={() => {
              setLoading(true);
              void loadSymbols(loaded + HISTORY_BATCH, symbols).finally(() => setLoading(false));
            }}
          >
            {loading ? 'Loading…' : `Load older (${symbols.length - loaded} more symbols)`}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- scanner

const SCAN_KINDS = ['crack', 'near', 'drop', 'pump', 'dump'] as const;
const SCAN_LABEL: Record<(typeof SCAN_KINDS)[number], string> = { crack: 'CRACK', near: 'WATCH', drop: 'DROP', pump: 'PUMP', dump: 'DUMP' };
const SCAN_KEY = 'harvester.mobile.scanKinds.v1';

function loadScanKinds(): Record<string, boolean> {
  const all = { crack: true, near: true, drop: true, pump: true, dump: true };
  try {
    const v = JSON.parse(window.localStorage.getItem(SCAN_KEY) ?? 'null') as Record<string, boolean> | null;
    if (v) for (const k of SCAN_KINDS) if (typeof v[k] === 'boolean') all[k] = v[k];
  } catch {
    /* all shown */
  }
  return all;
}

export function ScannerTab() {
  const signals = useApp((s) => s.signals);
  const scanner = useApp((s) => s.scanner);
  const openChart = useMobile((s) => s.openChart);
  const [kinds, setKinds] = useState(loadScanKinds);
  const [openId, setOpenId] = useState<string | null>(null);
  // the thumbnail fills the card (the screen less the list's and the card's padding)
  const thumbW = Math.max(200, Math.min(window.innerWidth, 560) - 60);
  const toggle = (k: string) =>
    setKinds((v) => {
      const next = { ...v, [k]: !v[k] };
      try {
        window.localStorage.setItem(SCAN_KEY, JSON.stringify(next));
      } catch {
        /* not remembered */
      }
      return next;
    });
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of signals) c[s.kind] = (c[s.kind] ?? 0) + 1;
    return c;
  }, [signals]);
  // sorted as the server sends them (by score), or by the reversal score (the signs that the move is ending), strongest first
  const [byReversal, setByReversal] = useState(() => {
    try {
      return window.localStorage.getItem('harvester.mobile.scanSort') === 'reversal';
    } catch {
      return false;
    }
  });
  // the lowest score shown (kept on the phone)
  const [minScore, setMinScore] = useState(() => {
    try {
      return Math.max(0, Math.min(100, Number(window.localStorage.getItem('harvester.mobile.minScore')) || 0));
    } catch {
      return 0;
    }
  });
  const rows = useMemo(() => {
    const list = signals.filter((s) => kinds[s.kind] && s.score >= minScore);
    if (byReversal) list.sort((a, b) => (b.reversal ?? -1) - (a.reversal ?? -1) || b.score - a.score);
    return list.slice(0, 60);
  }, [signals, kinds, byReversal, minScore]);
  return (
    <div className="m-list">
      <div className="m-chips">
        {SCAN_KINDS.map((k) => (
          <button key={k} className={`m-chip ${k}${kinds[k] ? ' on' : ''}`} onClick={() => toggle(k)}>
            {SCAN_LABEL[k]} {counts[k] ?? 0}
          </button>
        ))}
        <button
          className={`m-chip on-ind${byReversal ? ' on' : ''}`}
          onClick={() => {
            const next = !byReversal;
            setByReversal(next);
            try {
              window.localStorage.setItem('harvester.mobile.scanSort', next ? 'reversal' : 'score');
            } catch {
              /* not remembered */
            }
          }}
          title="Strongest signs of a reversal first (RSI, MACD, CMF, OBV)"
        >
          ↧ Reversal
        </button>
      </div>
      <label className="m-minscore">
        <span>Min score <b>{minScore}</b></span>
        <input
          type="range"
          min={0}
          max={90}
          step={5}
          value={minScore}
          onChange={(e) => {
            const v = Number(e.target.value);
            setMinScore(v);
            try {
              window.localStorage.setItem('harvester.mobile.minScore', String(v));
            } catch {
              /* not remembered */
            }
          }}
          aria-label="Minimum score"
        />
      </label>
      <div className="m-muted m-pad">{scanner ? `${scanner.phase} · ${scanner.seeded}/${scanner.symbols} symbols · ${rows.length} of ${signals.length} signals` : 'Scanner starting…'}</div>
      {!rows.length && <div className="m-empty">No signals right now.</div>}
      {rows.map((s) => {
        const isOpen = openId === s.id;
        return (
          <div key={s.id} className="m-card m-sig" onClick={() => setOpenId(isOpen ? null : s.id)}>
            <div className="m-row">
              <b className="m-coin">{coin(s.symbol)}</b>
              <span className={`m-badge ${s.kind === 'pump' ? 'up' : s.kind === 'dump' || s.kind === 'drop' ? 'down' : 'warn'}`}>{s.kind.toUpperCase()}</span>
              <span className="m-muted m-sig-meta">{s.distancePct != null ? `${s.distancePct.toFixed(2)}%` : `drop ${s.dropPct.toFixed(1)}%`} · {s.timeframe} · {ago(s.timeMs)}</span>
              <span className="m-pnl">{s.score}</span>
              <span className="m-chev">{isOpen ? '▴' : '▾'}</span>
            </div>
            {isOpen && (
              <div className="m-sig-more" onClick={(e) => e.stopPropagation()}>
                {s.thumb.length > 0 && <Thumb candles={s.thumb} base={s.base} crackLevel={s.crackLevel} width={thumbW} height={120} />}
                {insightBadges(s).length > 0 && (
                  <div className="m-ins-row">
                    {insightBadges(s).map((b) => (
                      <span key={b.text} className={`m-ins ${b.tone}`}>
                        {b.text}
                      </span>
                    ))}
                  </div>
                )}
                {(s.reversalNotes ?? []).length > 0 && <div className="m-muted m-ins-notes">{(s.reversalNotes ?? []).join(' · ')}</div>}
                <div className="m-grid">
                  <span>Price <b>{fmtPrice(s.price)}</b></span>
                  <span>Drop <b>{s.dropPct.toFixed(1)}%</b></span>
                  {s.distancePct != null && <span>vs crack <b>{s.distancePct.toFixed(2)}%</b></span>}
                  <span>Volume <b>{s.volSpikePct != null ? `+${Math.round(s.volSpikePct)}%` : `${s.volRatio.toFixed(1)}x`}</b></span>
                  {s.base != null && <span>Base <b>{fmtPrice(s.base)}</b></span>}
                  {s.crackLevel != null && <span>Crack <b>{fmtPrice(s.crackLevel)}</b></span>}
                </div>
                <div className="m-actions">
                  <button onClick={() => openChart(s.symbol)}>Open {coin(s.symbol)} chart</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- chart


/**
 * While an order that is on the exchange is being moved: just the large readout (old price, new price, % change) beside its line. There is no
 * bar: drag the white handle, double-tap to set, tap elsewhere on the chart to cancel.
 */
function AdjustReadout({ adjust, style }: { adjust: { kind: 'sl' | 'tp' | 'order'; order: OpenOrder; price: number; original: number }; style: React.CSSProperties }) {
  const change = adjust.original > 0 ? (adjust.price / adjust.original - 1) * 100 : 0;
  const moved = adjust.price !== adjust.original;
  const name = adjust.kind === 'sl' ? 'Stop-loss' : adjust.kind === 'tp' ? 'Take-profit' : 'Order';
  return (
    <div className="m-adjust-wrap" style={style}>
      <div className="m-adjust-read">
        {moved ? (
          <>
            <span>{fmtPrice(adjust.original)}</span> → <b>{fmtPrice(adjust.price)}</b>
            <i className={change >= 0 ? 'up' : 'down'}>{change >= 0 ? '+' : ''}{change.toFixed(2)}%</i>
          </>
        ) : (
          <span className="m-adjust-hint">{name}: drag the handle, double-tap to set · tap elsewhere to cancel</span>
        )}
      </div>
    </div>
  );
}

/** The readout sits just above the line being moved (below it when there is no room above) and follows it while the handle is dragged. */
const ADJUST_H = 34; // the readout
const ADJUST_GAP = 20;
function adjustStyle(tab: HTMLElement | null, bounds: { top: number; bottom: number } | null): React.CSSProperties {
  const th = tab?.clientHeight ?? 600;
  const y = bounds?.top ?? th / 2;
  return y - ADJUST_GAP - 4 >= ADJUST_H ? { bottom: th - y + ADJUST_GAP } : { top: y + ADJUST_GAP };
}

export function ChartTab() {
  const { symbol, timeframe, openChart, setTimeframe } = useMobile();
  const symbols = useApp((s) => s.symbols);
  const orders = useApp((s) => s.orders);
  const trading = useApp((s) => s.trading);
  const live = useLivePositions();
  const [candles, setCandles] = useState<Kline[]>([]);
  const [query, setQuery] = useState('');
  const [picking, setPicking] = useState(false);
  // the order box opened by pressing and holding the chart, and the side it is set to (drawn as a line on the chart)
  const floater = useFloater((s) => s.f);
  const tabRef = useRef<HTMLDivElement>(null);
  // where the pending order's line is, in the coordinates of the tab
  const [bounds, setBounds] = useState<{ top: number; bottom: number; entry: number | null } | null>(null);
  const [error, setError] = useState('');
  const toast = useApp((s) => s.toast);
  // an order that is on the exchange and is being moved: double-tap its line, drag the handle, press Apply
  const [adjust, setAdjust] = useState<{ kind: 'sl' | 'tp' | 'order'; order: OpenOrder; price: number; original: number } | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const [tick, setTick] = useState<string | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void api.symbolFilters(symbol).then((f) => alive && setTick(f.tickSize)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [symbol]);

  // history, then live candles
  useEffect(() => {
    let alive = true;
    setCandles([]);
    setError('');
    void api.klines(symbol, timeframe, 300).then((k) => alive && setCandles(k)).catch((e) => alive && setError(String(e)));
    void api.subscribeKlines(symbol, timeframe).catch(() => undefined);
    let off: (() => void) | null = null;
    void onKline((e) => {
      if (!alive || e.symbol !== symbol || e.interval !== timeframe) return;
      setCandles((cur) => {
        if (!cur.length) return cur;
        const last = cur[cur.length - 1];
        if (e.bar.time === last.time) return [...cur.slice(0, -1), e.bar];
        return e.bar.time > last.time ? [...cur.slice(-1999), e.bar] : cur;
      });
    }).then((u) => (alive ? (off = u) : u()));
    return () => {
      alive = false;
      off?.();
      void api.unsubscribeKlines(symbol, timeframe).catch(() => undefined);
    };
  }, [symbol, timeframe]);

  useEffect(() => {
    useFloater.getState().close();
    setBounds(null);
    setAdjust(null);
  }, [symbol, timeframe]);

  // executed trades of this symbol, drawn as arrows (reloaded every few seconds and when the number of orders / positions changes)
  const hasKeys = useApp((s) => !!s.trading?.hasCredentials);
  const activity = useApp((s) => `${s.orders.length}:${s.account?.positions.length ?? 0}`);
  const [fills, setFills] = useState<FillMark[]>([]);
  // the chosen indicators (kept on the phone) and whether their picker is open
  const [inds, setInds] = useState<Partial<Record<IndKey, boolean>>>(() => {
    try {
      return JSON.parse(window.localStorage.getItem('harvester.mobile.ind.v1') ?? '{}') as Partial<Record<IndKey, boolean>>;
    } catch {
      return {};
    }
  });
  const [indOpen, setIndOpen] = useState(false);
  const toggleInd = (k: IndKey) =>
    setInds((v) => {
      const next = { ...v, [k]: !v[k] };
      try {
        window.localStorage.setItem('harvester.mobile.ind.v1', JSON.stringify(next));
      } catch {
        /* not remembered */
      }
      return next;
    });
  useEffect(() => setFills([]), [symbol, hasKeys]);
  useEffect(() => {
    if (!hasKeys) return;
    let alive = true;
    const load = () =>
      api
        .tradeHistory(symbol, 500)
        .then((f) => alive && setFills(fillMarkers(symbol, f)))
        .catch(() => undefined);
    void load();
    const t = window.setInterval(load, 8000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [symbol, hasKeys, activity]);

  const pos = live?.positions.find((p) => p.symbol === symbol && p.amount !== 0);
  const mark = pos?.markPrice || candles[candles.length - 1]?.close || 0;
  const lines = useMemo<ChartLine[]>(() => {
    const out: ChartLine[] = [];
    if (pos) {
      out.push({ price: pos.entryPrice, label: 'entry', color: '#e6e9ef' });
      if (pos.liquidationPrice > 0) out.push({ price: pos.liquidationPrice, label: 'liq', color: '#e0a33d', dashed: true });
      const ex = exitState(symbol, pos.amount, orders);
      if (ex.stop) out.push({ price: ex.stop.stopPrice || ex.stop.price, label: 'SL', color: '#d0454b', dashed: true, adjust: { kind: 'sl', order: ex.stop } });
      if (ex.take) out.push({ price: ex.take.stopPrice || ex.take.price, label: 'TP', color: '#2e9b6f', dashed: true, adjust: { kind: 'tp', order: ex.take } });
    }
    for (const o of orders.filter((o) => o.symbol === symbol)) {
      if (pos && o.reduceOnly) continue;
      out.push({ price: o.stopPrice && !o.price ? o.stopPrice : o.price, label: `${o.side.toLowerCase()} ${o.type.replace(/_/g, ' ').toLowerCase()}`, color: '#5b8def', dashed: true, adjust: { kind: 'order', order: o } });
    }
    // the line being moved is drawn as the pending line instead
    return adjust ? out.filter((l) => !(l.adjust && l.adjust.order.orderId === adjust.order.orderId && l.adjust.order.conditional === adjust.order.conditional)) : out;
  }, [pos, orders, symbol, adjust?.order.orderId]); // eslint-disable-line react-hooks/exhaustive-deps

  // the order being set up: the entry line, and the stop-loss and take-profit lines when their buttons are pressed
  const pendingLines = useMemo<PendingLine[]>(() => {
    if (adjust) {
      const c = adjust.kind === 'sl' ? '#d0454b' : adjust.kind === 'tp' ? '#2e9b6f' : '#5b8def';
      return [{ id: 'adjust', price: adjust.price, label: adjust.kind === 'order' ? 'move order' : `new ${adjust.kind.toUpperCase()}`, color: c, handle: adjust.kind === 'order' ? '⇕' : adjust.kind.toUpperCase(), edit: true }];
    }
    if (!floater) return [];
    const long = floater.side === 'BUY';
    const out: PendingLine[] = [{ id: 'entry', price: floater.price, label: `${long ? 'buy' : 'sell'} here`, color: long ? '#2e9b6f' : '#d0454b', handle: '⇕' }];
    const ex = resolveBoth(long, floater.price, { on: floater.useSl, text: floater.sl }, { on: floater.useTp, text: floater.tp });
    if (ex.sl?.ok) out.push({ id: 'sl', price: ex.sl.price, label: 'SL', color: '#d0454b', handle: 'SL' });
    if (ex.tp?.ok) out.push({ id: 'tp', price: ex.tp.price, label: 'TP', color: '#2e9b6f', handle: 'TP' });
    return out;
  }, [floater, adjust]);
  const moveLine = (id: string, price: number) => {
    if (id === 'adjust') {
      setAdjust((a) => (a ? { ...a, price: snapToTick(price, tick) } : a));
      return;
    }
    const f = useFloater.getState().f;
    if (!f) return;
    if (id === 'entry') return useFloater.getState().patch({ price });
    // an exit line becomes a percentage of the entry; dragged to the wrong side of the entry it stops at the entry
    const long = f.side === 'BUY';
    const valid = id === 'sl' ? (long ? price < f.price : price > f.price) : long ? price > f.price : price < f.price;
    const text = valid ? pctText(f.price, price) : '0.05%';
    useFloater.getState().patch(id === 'sl' ? { sl: text } : { tp: text });
  };

  /** The X on a stop-loss / take-profit line: cancel that order (after a confirmation: a position without its stop is exposed). */
  const removeLine = async (l: ChartLine) => {
    if (!l.adjust || l.adjust.kind === 'order') return;
    const name = l.adjust.kind === 'sl' ? 'stop-loss' : 'take-profit';
    const o = l.adjust.order;
    if (!(await confirmDialog(`Remove the ${name} of ${symbol} (${fmtPrice(l.price)})?${l.adjust.kind === 'sl' ? ' The position will have no stop.' : ''}`, { confirmLabel: 'Remove', danger: true }))) return;
    try {
      await api.cancelOrder(symbol, o.orderId, o.conditional);
      toast(`${symbol}: ${name} removed`, 'info');
      void refreshTrading();
    } catch (e) {
      toast(`Could not remove it: ${e}`, 'warn');
    }
  };

  /** A double tap near the line of an order that is on the exchange starts moving it. */
  const startAdjust = (price: number, tol: number): boolean => {
    // already moving an order: a double tap on its line sets it, as a double tap on its handle does
    if (adjust && Math.abs(adjust.price - price) <= tol) {
      void applyAdjust();
      return true;
    }
    let best: { l: ChartLine; d: number } | null = null;
    for (const l of lines) {
      if (!l.adjust) continue;
      const d = Math.abs(l.price - price);
      if (d <= tol && (!best || d < best.d)) best = { l, d };
    }
    if (!best?.l.adjust) return false;
    useFloater.getState().close();
    const a = best.l.adjust;
    setAdjust({ kind: a.kind, order: a.order, price: best.l.price, original: best.l.price });
    return true;
  };

  const applyAdjust = async () => {
    if (!adjust || adjusting) return;
    const { order: o, kind } = adjust;
    const price = snapToTick(adjust.price, tick);
    if (adjust.price === adjust.original) {
      toast('Drag the handle to the new level first, then double-tap to set it.', 'info');
      return;
    }
    if (kind !== 'order' && pos) {
      const res = resolveExit(kind === 'sl' ? 'stop' : 'take', pos.amount > 0, mark, { kind: 'price', value: price });
      if (!res.ok) {
        toast(res.error, 'warn');
        return;
      }
    }
    setAdjusting(true);
    try {
      if (o.type === 'LIMIT') await api.modifyOrder(symbol, o.orderId, false, price);
      else if (o.type === 'STOP') await api.modifyOrder(symbol, o.orderId, o.conditional, o.price + (price - o.stopPrice), price);
      else await api.modifyOrder(symbol, o.orderId, o.conditional, undefined, price);
      // an entry that has its own stop-loss / take-profit on the exchange (same size, opposite side, nothing open yet): they move with it,
      // keeping their distance, so the old levels are not left behind
      let moved = 0;
      if (kind === 'order' && !pos && !o.reduceOnly) {
        const delta = price - adjust.original;
        const linked = orders.filter((x) => x.symbol === symbol && x.conditional && x.reduceOnly && x.side !== o.side && Math.abs(x.origQty - o.origQty) <= o.origQty * 1e-6);
        for (const x of linked) {
          try {
            await api.modifyOrder(symbol, x.orderId, true, undefined, snapToTick(x.stopPrice + delta, tick));
            moved++;
          } catch (e) {
            toast(`The order moved, but its ${x.type.includes('TAKE') ? 'take-profit' : 'stop-loss'} could not: ${e}`, 'warn');
          }
        }
      }
      toast(`${symbol}: ${kind === 'order' ? 'order' : kind === 'sl' ? 'stop-loss' : 'take-profit'} moved to ${fmtPrice(price)}${moved ? ` (with its ${moved === 2 ? 'SL and TP' : 'exit'})` : ''}`, 'info');
      void refreshTrading();
      setAdjust(null);
    } catch (e) {
      toast(`Could not move it: ${e}`, 'warn');
    } finally {
      setAdjusting(false);
    }
  };

  // the order being moved is gone (filled or cancelled elsewhere): stop adjusting
  useEffect(() => {
    if (adjust && !orders.some((o) => o.orderId === adjust.order.orderId && o.conditional === adjust.order.conditional)) setAdjust(null);
  }, [orders, adjust]);

  // while a stop-loss or take-profit is being moved: what it would make or lose, shown at the entry line (on the side of it where the new level is)
  const entryNote = useMemo(() => {
    if (!adjust || !pos || adjust.kind === 'order') return null;
    const pnl = pos.amount * (adjust.price - pos.entryPrice);
    const margin = (Math.abs(pos.amount) * pos.entryPrice) / Math.max(1, pos.leverage);
    const roe = margin > 0 ? (pnl / margin) * 100 : 0;
    const move = pos.entryPrice > 0 ? (adjust.price / pos.entryPrice - 1) * 100 : 0;
    const sign = (n: number) => (n >= 0 ? '+' : '-');
    return {
      price: pos.entryPrice,
      lines: [`${sign(pnl)}$${Math.abs(pnl).toFixed(2)}  (${sign(roe)}${Math.abs(roe).toFixed(1)}% on margin)`, `${sign(move)}${Math.abs(move).toFixed(2)}% price move from the entry`],
      color: pnl >= 0 ? '#3ecf8e' : '#ff6b6b',
      above: adjust.price > pos.entryPrice,
    };
  }, [adjust, pos]);

  const dragScroll = useDragScroll();
  // every symbol, searchable and sortable by name, 24h change or volume (the choice is remembered)
  const [symSort, setSymSort] = useState<{ key: SortKey; dir: SortDir }>(loadSymSort);
  const clickSort = (key: SortKey) =>
    setSymSort((cur) => {
      const next = nextSort(cur, key);
      try {
        window.localStorage.setItem(SYM_SORT_KEY, JSON.stringify(next));
      } catch {
        /* not remembered */
      }
      return next;
    });
  const matches = useMemo(() => {
    const q = query.trim().toUpperCase();
    return sortSymbols(symbols.filter((s) => !q || s.symbol.includes(q)), symSort);
  }, [symbols, query, symSort]);
  const head = (key: SortKey, label: string) => (
    <button className={`m-sort${symSort.key === key ? ' on' : ''}`} onClick={() => clickSort(key)}>
      {label}
      {symSort.key === key ? (symSort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </button>
  );

  return (
    <div className="m-chart-tab" ref={tabRef}>
      <div className="m-chart-head">
        <button className="m-symbol" onClick={() => setPicking((v) => !v)}>
          {coin(symbol)} <small>▾</small>
        </button>
        <select className="m-tf" value={timeframe} onChange={(e) => setTimeframe(e.target.value)} aria-label="Timeframe">
          {TIMEFRAMES.map((tf) => (
            <option key={tf} value={tf}>
              {tf}
            </option>
          ))}
        </select>
        <b className="m-last">{mark ? fmtPrice(mark) : ''}</b>
        <button className={`m-fx${indOpen || Object.values(inds).some(Boolean) ? ' on' : ''}`} onClick={() => setIndOpen((v) => !v)} aria-label="Indicators" title="Indicators">ƒx</button>
        {pos && <span className={`m-pnl ${tone(pos.unrealizedPnl)}`}>{signed(pos.unrealizedPnl)}</span>}
      </div>
      {indOpen && (
        <div className="m-chips m-ind-chips">
          {IND_LIST.map((i) => (
            <button key={i.key} className={`m-chip on-ind${inds[i.key] ? ' on' : ''}`} onClick={() => toggleInd(i.key)} title={i.hint}>
              {i.label}
            </button>
          ))}
        </div>
      )}
      {picking && (
        <div className="m-picker">
          <input autoFocus placeholder={`Search ${symbols.length || ''} symbols`} value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="m-picker-list" ref={dragScroll}>
            <div className="m-picker-head">
              {head('name', 'Name')}
              <span>Price</span>
              {head('change', '24h %')}
              {head('volume', 'Volume')}
            </div>
            {matches.map((s) => (
              <button key={s.symbol} className={s.symbol === symbol ? 'cur' : ''} onClick={() => { openChart(s.symbol); setPicking(false); setQuery(''); }}>
                <b>{coin(s.symbol)}</b>
                <span>{fmtPrice(s.lastPrice)}</span>
                <span className={s.changePercent24h >= 0 ? 'up' : 'down'}>{s.changePercent24h.toFixed(1)}%</span>
                <span className="m-muted">{compactVol(s.volume24hQuote)}</span>
              </button>
            ))}
            {!matches.length && <div className="m-empty">No symbol matches.</div>}
          </div>
        </div>
      )}
      {error ? <div className="m-warn">{error}</div> : <MobileChart
          candles={candles}
          lines={lines}
          marks={fills}
          indicators={inds}
          pending={pendingLines}
          onRemoveLine={(l) => void removeLine(l)}
          onRemovePending={(id) => useFloater.getState().patch(id === 'sl' ? { useSl: false } : { useTp: false })}
          entryNote={entryNote}
          watermark={{ symbol, timeframe }}
          onPendingMove={moveLine}
          onPendingBounds={(top, bottom, entry) => {
            const t = tabRef.current?.getBoundingClientRect().top ?? 0;
            setBounds({ top: top - t, bottom: bottom - t, entry: entry != null ? entry - t : null });
          }}
          onTap={({ price, tol }) => {
            // while an order is being moved a tap away from its line cancels the move; a tap on the line may be the first half of the double tap that sets it
            if (adjust && Math.abs(adjust.price - price) > tol) setAdjust(null);
          }}
          onDoubleTap={({ price, tol }) => startAdjust(price, tol)}
          onPendingDoubleTap={(id) => id === 'adjust' && void applyAdjust()}
          onLongPress={(p) => {
            const rect = tabRef.current?.getBoundingClientRect();
            if (!rect || !trading?.hasCredentials || !(mark > 0)) return;
            setPicking(false);
            setAdjust(null);
            useFloater.getState().open(p.price, sideFor(p.price, mark), p.y - rect.top);
          }}
        />}
      {floater && <OrderFloater key={floater.id} symbol={symbol} mark={mark} onClose={() => useFloater.getState().close()} />}
      {adjust && <AdjustReadout adjust={adjust} style={adjustStyle(tabRef.current, bounds)} />}
    </div>
  );
}
