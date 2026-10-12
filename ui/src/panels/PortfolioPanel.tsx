import { api } from '../api';
import { openChart } from '../dock';
import { useApp } from '../store';
import { refreshTrading } from '../trade';

function money(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Balances, open positions (with close buttons) and every open order on the account. */
export function PortfolioPanel() {
  const trading = useApp((s) => s.trading);
  const account = useApp((s) => s.account);
  const orders = useApp((s) => s.orders);
  const toast = useApp((s) => s.toast);

  if (trading && !trading.hasCredentials) {
    return (
      <div className="panel pad">
        <p className="warn">{trading.message}</p>
      </div>
    );
  }
  if (!account) return <div className="panel pad muted">Loading the account…</div>;

  const close = (symbol: string, fraction: number) => {
    if (!window.confirm(`Close ${Math.round(fraction * 100)}% of the ${symbol} position at market?`)) return;
    void api
      .closePosition(symbol, fraction)
      .then(() => {
        toast(`Closing ${Math.round(fraction * 100)}% of ${symbol}`, 'info');
        return refreshTrading();
      })
      .catch((e) => toast(`Close: ${e}`, 'warn'));
  };

  return (
    <div className="panel portfolio">
      <div className="pf-balances">
        <div>
          <span>Wallet</span>
          <b>{money(account.walletBalance)}</b>
        </div>
        <div>
          <span>Available</span>
          <b>{money(account.availableBalance)}</b>
        </div>
        <div>
          <span>Unrealised P&amp;L</span>
          <b className={account.unrealizedPnl >= 0 ? 'up' : 'down'}>{money(account.unrealizedPnl)}</b>
        </div>
        <div>
          <span>Positions</span>
          <b>{account.positions.length}</b>
        </div>
        <div>
          <span>Open orders</span>
          <b>{orders.length}</b>
        </div>
      </div>

      <table className="rungs pf-table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Size</th>
            <th>Entry</th>
            <th>Mark</th>
            <th>P&amp;L</th>
            <th>Liq.</th>
            <th>Lev</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {account.positions.length === 0 && (
            <tr>
              <td colSpan={8} className="muted">
                No open positions.
              </td>
            </tr>
          )}
          {account.positions.map((p) => (
            <tr key={p.symbol}>
              <td>
                <a onClick={() => openChart(p.symbol)}>{p.symbol}</a>
              </td>
              <td className={p.amount > 0 ? 'up' : 'down'}>{p.amount}</td>
              <td>{p.entryPrice}</td>
              <td>{p.markPrice}</td>
              <td className={p.unrealizedPnl >= 0 ? 'up' : 'down'}>{money(p.unrealizedPnl)}</td>
              <td>{p.liquidationPrice || '-'}</td>
              <td>{p.leverage || '-'}x</td>
              <td className="pf-actions">
                {[0.25, 0.5, 1].map((f) => (
                  <button key={f} onClick={() => close(p.symbol, f)}>
                    {f * 100}%
                  </button>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {orders.length > 0 && (
        <table className="rungs pf-table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Symbol</th>
              <th>Type</th>
              <th>Qty</th>
              <th>Price</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.orderId}>
                <td className={o.side === 'BUY' ? 'up' : 'down'}>{o.side}</td>
                <td>
                  <a onClick={() => openChart(o.symbol)}>{o.symbol}</a>
                </td>
                <td>{o.type}</td>
                <td>{o.origQty}</td>
                <td>{o.price || o.stopPrice}</td>
                <td>
                  <button
                    className="icon-btn"
                    onClick={() =>
                      void api
                        .cancelOrder(o.symbol, o.orderId)
                        .then(() => refreshTrading())
                        .catch((e) => toast(`Cancel: ${e}`, 'warn'))
                    }
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
