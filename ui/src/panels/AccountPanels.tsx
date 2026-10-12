import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { chartRegistry } from '../chartStore';
import { confirmDialog } from '../confirm';
import { openChart } from '../dock';
import { useApp } from '../store';
import { refreshTrading } from '../trade';
import type { OrderRecord, TradeRecord } from '../types';

function money(n: number, digits = 2): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function when(ms: number): string {
  if (!ms) return '-';
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function NoKeys() {
  const trading = useApp((s) => s.trading);
  return <div className="panel pad warn">{trading?.message || 'Trading is not set up.'}</div>;
}

function SymbolLink({ symbol }: { symbol: string }) {
  return <a onClick={() => openChart(symbol)}>{symbol}</a>;
}

/** Mark prices of the given symbols from the live websocket (Binance's own mark price), refreshed every second. */
function useLiveMarks(symbols: string[]): Record<string, number> {
  const [marks, setMarks] = useState<Record<string, number>>({});
  const key = symbols.join(',');
  useEffect(() => {
    if (!key) return;
    let stop = false;
    const load = () => void api.markPrices(key.split(',')).then((m) => !stop && setMarks(m)).catch(() => undefined);
    load();
    const t = window.setInterval(load, 1000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [key]);
  return marks;
}

/** Open positions with unrealised P&L, return on margin, and close buttons. */
export function PositionsPanel() {
  const trading = useApp((s) => s.trading);
  const account = useApp((s) => s.account);
  const toast = useApp((s) => s.toast);
  const live = useLiveMarks(account?.positions.map((p) => p.symbol) ?? []);
  if (trading && !trading.hasCredentials) return <NoKeys />;
  if (!account) return <div className="panel pad muted">Loading the account…</div>;
  // the REST read can be seconds old: show Binance's live mark price and the profit it implies (linear contracts)
  const positions = account.positions.map((p) => {
    const mark = live[p.symbol] ?? p.markPrice;
    return { ...p, markPrice: mark, unrealizedPnl: live[p.symbol] ? p.amount * (mark - p.entryPrice) : p.unrealizedPnl };
  });

  const close = async (symbol: string, fraction: number) => {
    if (!(await confirmDialog(`Close ${Math.round(fraction * 100)}% of the ${symbol} position at market?`, { confirmLabel: 'Close' }))) return;
    try {
      await api.closePosition(symbol, fraction);
      toast(`Closing ${Math.round(fraction * 100)}% of ${symbol}`, 'info');
      await refreshTrading();
    } catch (e) {
      toast(`Close: ${e}`, 'warn');
    }
  };

  const closeAll = async () => {
    if (!(await confirmDialog(`Close ALL ${account.positions.length} positions at market?`, { danger: true, confirmLabel: 'Close all' }))) return;
    for (const p of account.positions) {
      try {
        await api.closePosition(p.symbol, 1);
      } catch (e) {
        toast(`${p.symbol}: ${e}`, 'warn');
      }
    }
    await refreshTrading();
  };

  return (
    <div className="panel tbl">
      <table className="rungs pf-table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Side</th>
            <th>Size</th>
            <th>Entry</th>
            <th>Mark</th>
            <th>Value</th>
            <th>Margin</th>
            <th>Unrealised P&amp;L</th>
            <th>ROE</th>
            <th>Liq.</th>
            <th>Lev</th>
            <th>
              {account.positions.length > 1 && (
                <button onClick={() => void closeAll()} className="mini">
                  Close all
                </button>
              )}
            </th>
          </tr>
        </thead>
        <tbody>
          {account.positions.length === 0 && (
            <tr>
              <td colSpan={12} className="muted">
                No open positions.
              </td>
            </tr>
          )}
          {positions.map((p) => {
            const value = Math.abs(p.amount) * p.markPrice;
            const lev = p.leverage || account.leverages?.[p.symbol] || 0;
            const margin = lev > 0 ? (Math.abs(p.amount) * p.entryPrice) / lev : 0;
            const roe = margin > 0 ? (p.unrealizedPnl / margin) * 100 : 0;
            return (
              <tr key={p.symbol}>
                <td>
                  <SymbolLink symbol={p.symbol} />
                </td>
                <td className={p.amount > 0 ? 'up' : 'down'}>{p.amount > 0 ? 'LONG' : 'SHORT'}</td>
                <td>{Math.abs(p.amount)}</td>
                <td>{p.entryPrice}</td>
                <td>{p.markPrice}</td>
                <td>{money(value)}</td>
                <td>{margin ? money(margin) : '-'}</td>
                <td className={p.unrealizedPnl >= 0 ? 'up' : 'down'}>{money(p.unrealizedPnl)}</td>
                <td className={roe >= 0 ? 'up' : 'down'}>{margin ? `${roe.toFixed(1)}%` : '-'}</td>
                <td>{p.liquidationPrice || '-'}</td>
                <td>{lev ? `${lev}x` : '-'}</td>
                <td className="pf-actions">
                  {[0.25, 0.5, 1].map((f) => (
                    <button key={f} onClick={() => void close(p.symbol, f)}>
                      {f * 100}%
                    </button>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Every open order on the account, stops and take-profits included. */
export function OpenOrdersPanel() {
  const trading = useApp((s) => s.trading);
  const orders = useApp((s) => s.orders);
  const leverages = useApp((s) => s.account?.leverages);
  const held = useApp((s) => s.held).filter((h) => h.status === 'held');
  const toast = useApp((s) => s.toast);
  if (trading && !trading.hasCredentials) return <NoKeys />;

  const cancelHeld = async (id: string) => {
    try {
      await api.heldCancel(id);
      await refreshTrading();
    } catch (e) {
      toast(`Cancel: ${e}`, 'warn');
    }
  };

  const cancel = async (symbol: string, id: number, conditional: boolean) => {
    try {
      await api.cancelOrder(symbol, id, conditional);
      await refreshTrading();
    } catch (e) {
      toast(`Cancel: ${e}`, 'warn');
    }
  };

  const cancelAll = async () => {
    const symbols = [...new Set(orders.map((o) => o.symbol))];
    if (!(await confirmDialog(`Cancel all ${orders.length} open orders on ${symbols.length} symbol(s)?`, { confirmLabel: 'Cancel all orders' }))) return;
    for (const s of symbols) {
      try {
        await api.cancelAll(s);
      } catch (e) {
        toast(`${s}: ${e}`, 'warn');
      }
    }
    await refreshTrading();
  };

  return (
    <div className="panel tbl">
      <table className="rungs pf-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Symbol</th>
            <th>Side</th>
            <th>Type</th>
            <th>Qty</th>
            <th>Filled</th>
            <th>Price</th>
            <th>Trigger</th>
            <th>Lev</th>
            <th>Flags</th>
            <th>
              {orders.length > 0 && (
                <button className="mini" onClick={() => void cancelAll()}>
                  Cancel all
                </button>
              )}
            </th>
          </tr>
        </thead>
        <tbody>
          {orders.length === 0 && held.length === 0 && (
            <tr>
              <td colSpan={11} className="muted">
                No open orders.
              </td>
            </tr>
          )}
          {held.map((h) => (
            <tr key={h.id} className="held-row">
              <td className="muted">{when(h.createdMs)}</td>
              <td>
                <SymbolLink symbol={h.request.symbol} />
              </td>
              <td className={h.request.side === 'BUY' ? 'up' : 'down'}>{h.request.side}</td>
              <td>LIMIT (held here)</td>
              <td>{h.request.quantity}</td>
              <td>-</td>
              <td>{h.request.price}</td>
              <td>-</td>
              <td>{leverages?.[h.request.symbol] ? `${leverages[h.request.symbol]}x` : '-'}</td>
              <td className="muted" title="Kept on this computer: Binance only takes limit orders close to the market. It is sent automatically when the price comes within range, while Harvester is open.">
                waiting for range{h.request.reduceOnly ? ' · reduce-only' : ''}
              </td>
              <td>
                <button className="icon-btn" title="Cancel this held order (it was never sent to Binance)" onClick={() => void cancelHeld(h.id)}>
                  ×
                </button>
              </td>
            </tr>
          ))}
          {orders.map((o) => (
            <tr key={`${o.conditional}-${o.orderId}`}>
              <td className="muted">{when(o.time)}</td>
              <td>
                <SymbolLink symbol={o.symbol} />
              </td>
              <td className={o.side === 'BUY' ? 'up' : 'down'}>{o.side}</td>
              <td>{o.type.replace(/_/g, ' ')}</td>
              <td>{o.origQty}</td>
              <td>{o.executedQty || '-'}</td>
              <td>{o.price || '-'}</td>
              <td>{o.stopPrice || '-'}</td>
              <td>{leverages?.[o.symbol] ? `${leverages[o.symbol]}x` : '-'}</td>
              <td className="muted">{o.reduceOnly ? 'reduce-only' : ''}</td>
              <td>
                <button className="icon-btn" title="Cancel this order" onClick={() => void cancel(o.symbol, o.orderId, o.conditional)}>
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Which symbols a history tab should query. Binance only serves history per symbol. */
function useHistorySymbols() {
  const activeId = useApp((s) => s.activeChartId);
  const positions = useApp((s) => s.account?.positions);
  const orders = useApp((s) => s.orders);
  const [scope, setScope] = useState<'chart' | 'open' | 'activity'>('chart');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((x) => x + 1), 1500);
    return () => window.clearInterval(t);
  }, []);
  const symbols = useMemo(() => {
    void tick;
    const charts = [...chartRegistry.entries()];
    const active = chartRegistry.get(activeId)?.getState().symbol;
    if (scope === 'chart') return active ? [active] : [];
    const set = new Set<string>();
    for (const [, st] of charts) set.add(st.getState().symbol);
    if (scope === 'activity') {
      positions?.forEach((p) => set.add(p.symbol));
      orders.forEach((o) => set.add(o.symbol));
    }
    return [...set].sort();
  }, [scope, activeId, positions, orders, tick]);
  const key = symbols.join(',');
  return { scope, setScope, symbols, key };
}

function ScopeBar({ scope, setScope, symbols, onRefresh, loading, children }: { scope: string; setScope: (s: 'chart' | 'open' | 'activity') => void; symbols: string[]; onRefresh: () => void; loading: boolean; children?: React.ReactNode }) {
  return (
    <div className="hist-bar">
      <span className="muted">Symbols:</span>
      <button className={scope === 'chart' ? 'on' : ''} onClick={() => setScope('chart')} title="The symbol of the chart that has focus">
        This chart
      </button>
      <button className={scope === 'open' ? 'on' : ''} onClick={() => setScope('open')} title="Every symbol that has a chart tab open">
        Open charts
      </button>
      <button className={scope === 'activity' ? 'on' : ''} onClick={() => setScope('activity')} title="Open charts plus symbols with a position or an open order">
        + positions &amp; orders
      </button>
      <span className="muted">
        {symbols.length ? symbols.join(', ') : 'none'} · the exchange lists history per symbol
      </span>
      <span className="spacer" />
      {children}
      <button onClick={onRefresh}>{loading ? 'Loading…' : 'Refresh'}</button>
    </div>
  );
}

function useHistory<T extends { time: number }>(symbols: string[], key: string, fetcher: (symbol: string) => Promise<T[]>) {
  const trading = useApp((s) => s.trading);
  const toast = useApp((s) => s.toast);
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!trading?.hasCredentials || symbols.length === 0) {
      setRows([]);
      return;
    }
    setLoading(true);
    const all: T[] = [];
    for (const s of symbols) {
      try {
        all.push(...(await fetcher(s)));
      } catch (e) {
        toast(`${s}: ${e}`, 'warn');
      }
    }
    all.sort((a, b) => b.time - a.time);
    setRows(all);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, trading?.hasCredentials]);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(t);
  }, [load]);
  return { rows, loading, load };
}

const STATUS_CLASS: Record<string, string> = { FILLED: 'up', PARTIALLY_FILLED: 'up', NEW: '', CANCELED: 'muted', CANCELLED: 'muted', EXPIRED: 'muted', REJECTED: 'down', TRIGGERED: 'up', FINISHED: 'up' };

/** Past orders (filled, cancelled, expired, rejected) of the chosen symbols. */
export function OrderHistoryPanel() {
  const trading = useApp((s) => s.trading);
  const { scope, setScope, symbols, key } = useHistorySymbols();
  const { rows, loading, load } = useHistory<OrderRecord>(symbols, key, (s) => api.orderHistory(s, 100));
  if (trading && !trading.hasCredentials) return <NoKeys />;
  return (
    <div className="panel tbl">
      <ScopeBar scope={scope} setScope={setScope} symbols={symbols} onRefresh={() => void load()} loading={loading} />
      <table className="rungs pf-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Symbol</th>
            <th>Side</th>
            <th>Type</th>
            <th>Qty</th>
            <th>Filled</th>
            <th>Price</th>
            <th>Avg price</th>
            <th>Trigger</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={10} className="muted">
                {loading ? 'Loading…' : 'No orders found for these symbols.'}
              </td>
            </tr>
          )}
          {rows.map((o) => (
            <tr key={`${o.conditional}-${o.orderId}`}>
              <td className="muted">{when(o.time)}</td>
              <td>
                <SymbolLink symbol={o.symbol} />
              </td>
              <td className={o.side === 'BUY' ? 'up' : 'down'}>{o.side}</td>
              <td>{o.type.replace(/_/g, ' ')}</td>
              <td>{o.origQty}</td>
              <td>{o.executedQty || '-'}</td>
              <td>{o.price || '-'}</td>
              <td>{o.avgPrice || '-'}</td>
              <td>{o.stopPrice || '-'}</td>
              <td className={STATUS_CLASS[o.status] ?? ''}>{o.status.replace(/_/g, ' ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Individual fills with realised P&L and fees, plus totals for what is listed. */
export function TradeHistoryPanel() {
  const trading = useApp((s) => s.trading);
  const { scope, setScope, symbols, key } = useHistorySymbols();
  const { rows, loading, load } = useHistory<TradeRecord>(symbols, key, (s) => api.tradeHistory(s, 200));
  if (trading && !trading.hasCredentials) return <NoKeys />;
  const pnl = rows.reduce((a, t) => a + t.realizedPnl, 0);
  const fees = rows.reduce((a, t) => a + t.commission, 0);
  return (
    <div className="panel tbl">
      <ScopeBar scope={scope} setScope={setScope} symbols={symbols} onRefresh={() => void load()} loading={loading}>
        <span className="muted">
          {rows.length} fills · realised <b className={pnl >= 0 ? 'up' : 'down'}>{money(pnl)}</b> · fees <b>{money(fees, 3)}</b> · net <b className={pnl - fees >= 0 ? 'up' : 'down'}>{money(pnl - fees)}</b> USDT
        </span>
      </ScopeBar>
      <table className="rungs pf-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Symbol</th>
            <th>Side</th>
            <th>Price</th>
            <th>Qty</th>
            <th>Value</th>
            <th>Realised P&amp;L</th>
            <th>Fee</th>
            <th>Role</th>
            <th>Order</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={10} className="muted">
                {loading ? 'Loading…' : 'No fills found for these symbols.'}
              </td>
            </tr>
          )}
          {rows.map((t) => (
            <tr key={`${t.symbol}-${t.id}`}>
              <td className="muted">{when(t.time)}</td>
              <td>
                <SymbolLink symbol={t.symbol} />
              </td>
              <td className={t.side === 'BUY' ? 'up' : 'down'}>{t.side}</td>
              <td>{t.price}</td>
              <td>{t.qty}</td>
              <td>{money(t.quoteQty)}</td>
              <td className={t.realizedPnl > 0 ? 'up' : t.realizedPnl < 0 ? 'down' : ''}>{t.realizedPnl ? money(t.realizedPnl) : '-'}</td>
              <td>
                {t.commission.toFixed(4)} {t.commissionAsset}
              </td>
              <td className="muted">{t.maker ? 'maker' : 'taker'}</td>
              <td className="muted">{t.orderId}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
