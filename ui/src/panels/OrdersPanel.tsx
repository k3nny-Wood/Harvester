import { api } from '../api';
import { useActiveChart } from '../chartStore';
import { snapToTick } from '../ladderMath';
import { useApp } from '../store';
import { orderFromForm, quantityFor, refreshTrading, submitOrder } from '../trade';

/** Manual order entry for the symbol of the focused chart, with that symbol's open orders underneath. */
export function OrdersPanel() {
  const form = useApp((s) => s.orderForm);
  const patch = useApp((s) => s.patchOrderForm);
  const trading = useApp((s) => s.trading);
  const account = useApp((s) => s.account);
  const orders = useApp((s) => s.orders);
  const env = useApp((s) => s.env);
  const toast = useApp((s) => s.toast);
  const symbol = useActiveChart((s) => s.symbol) ?? '';
  const mark = useActiveChart((s) => s.markPrice) ?? 0;
  const filters = useActiveChart((s) => s.filters);
  const precision = filters?.pricePrecision ?? 2;
  const qtyPrecision = filters?.quantityPrecision ?? 3;

  if (trading && !trading.hasCredentials) {
    return (
      <div className="panel pad">
        <h3>Trading is not set up</h3>
        <p className="warn">{trading.message}</p>
      </div>
    );
  }

  const price = form.type === 'LIMIT' ? Number(form.price) || mark : mark;
  const lev = Number(form.leverage) || 1;
  const qty = quantityFor(price, form.sizeMode, Number(form.size), account?.availableBalance ?? 0, lev);
  const notional = qty * price;
  const mine = orders.filter((o) => o.symbol === symbol);
  const color = form.side === 'BUY' ? 'var(--up)' : 'var(--down)';

  const place = async () => {
    const built = orderFromForm();
    if (typeof built === 'string') return toast(built, 'warn');
    const { order, notional: n } = built;
    const risky = form.type === 'MARKET' || env === 'live';
    const text = risky ? `${env === 'live' ? 'LIVE ORDER — real money.\n\n' : ''}${order.side} ${order.type} ${order.quantity.toFixed(qtyPrecision)} ${symbol} ≈ ${n.toFixed(2)} USDT. Place it?` : undefined;
    await submitOrder(order, text);
  };

  const setLeverage = async () => {
    const l = Number(form.leverage);
    if (!l) return toast('Enter a leverage first.', 'warn');
    try {
      await api.setLeverage(symbol, l);
      toast(`${symbol} leverage set to ${l}x`, 'info');
    } catch (e) {
      toast(`Leverage: ${e}`, 'warn');
    }
  };

  return (
    <div className="panel order-entry">
      <div className="of-head">
        <div className="of-sides">
          <button className={`buy${form.side === 'BUY' ? ' on' : ''}`} onClick={() => patch({ side: 'BUY' })}>
            Buy / Long
          </button>
          <button className={`sell${form.side === 'SELL' ? ' on' : ''}`} onClick={() => patch({ side: 'SELL' })}>
            Sell / Short
          </button>
        </div>
        <div className="muted">
          {symbol} · last <b>{mark ? mark.toFixed(precision) : '…'}</b>
        </div>
      </div>

      <div className="of-grid">
        <label>
          <span>Type</span>
          <select value={form.type} onChange={(e) => patch({ type: e.target.value as 'LIMIT' | 'MARKET' })}>
            <option value="LIMIT">Limit</option>
            <option value="MARKET">Market</option>
          </select>
        </label>
        <label>
          <span>Price {form.type === 'LIMIT' && <a onClick={() => patch({ price: '' })}>use last</a>}</span>
          <input
            type="number"
            disabled={form.type === 'MARKET'}
            value={form.type === 'MARKET' ? '' : form.price || (mark ? snapToTick(mark, filters?.tickSize) : '')}
            placeholder={form.type === 'MARKET' ? 'market' : ''}
            onChange={(e) => patch({ price: e.target.value })}
          />
        </label>
        <label>
          <span>Size in</span>
          <select value={form.sizeMode} onChange={(e) => patch({ sizeMode: e.target.value as 'usdt' | 'qty' | 'pct' })}>
            <option value="usdt">USDT</option>
            <option value="qty">Quantity</option>
            <option value="pct">% of balance</option>
          </select>
        </label>
        <label>
          <span>Amount</span>
          <input type="number" min={0} value={form.size} onChange={(e) => patch({ size: e.target.value })} />
        </label>
      </div>

      {form.sizeMode === 'pct' && <input className="of-slider" type="range" min={1} max={100} value={Number(form.size) || 1} onChange={(e) => patch({ size: e.target.value })} />}

      <div className="of-flags">
        <label>
          <input type="checkbox" checked={form.reduceOnly} onChange={(e) => patch({ reduceOnly: e.target.checked })} /> Reduce only
        </label>
        <label>
          <input type="checkbox" checked={form.postOnly} disabled={form.type === 'MARKET'} onChange={(e) => patch({ postOnly: e.target.checked })} /> Post only
        </label>
        <label className="lev">
          Leverage
          <input type="number" min={1} max={125} value={form.leverage} placeholder="x" onChange={(e) => patch({ leverage: e.target.value })} />
          <button onClick={() => void setLeverage()}>Set</button>
        </label>
      </div>

      <div className="of-summary">
        <div>
          <span>Quantity</span>
          <b>{qty ? qty.toFixed(qtyPrecision) : '-'}</b>
        </div>
        <div>
          <span>Notional</span>
          <b>{notional ? `${notional.toFixed(2)} USDT` : '-'}</b>
        </div>
        <div>
          <span>Margin</span>
          <b>{notional && lev ? `${(notional / lev).toFixed(2)} USDT` : '-'}</b>
        </div>
        <div>
          <span>Available</span>
          <b>{account ? `${account.availableBalance.toFixed(2)} USDT` : '-'}</b>
        </div>
      </div>

      <button className="primary place" style={{ background: color, borderColor: color, color: '#fff' }} disabled={!symbol || !qty} onClick={() => void place()}>
        {form.side === 'BUY' ? 'Buy' : 'Sell'} {form.type === 'MARKET' ? 'at market' : 'limit'}
      </button>

      <div className="of-orders">
        <div className="row">
          <b>Open orders · {symbol}</b>
          {mine.length > 0 && (
            <button
              onClick={() =>
                void api
                  .cancelAll(symbol)
                  .then(() => refreshTrading())
                  .catch((e) => toast(`Cancel: ${e}`, 'warn'))
              }
            >
              Cancel all
            </button>
          )}
        </div>
        {mine.length === 0 ? (
          <div className="muted">No open orders on {symbol}.</div>
        ) : (
          <table className="rungs">
            <tbody>
              {mine.map((o) => (
                <tr key={o.orderId}>
                  <td className={o.side === 'BUY' ? 'up' : 'down'}>{o.side}</td>
                  <td>{o.type}</td>
                  <td>{o.origQty}</td>
                  <td>{o.price || o.stopPrice}</td>
                  <td>
                    <button
                      className="icon-btn"
                      title="Cancel this order"
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
    </div>
  );
}
