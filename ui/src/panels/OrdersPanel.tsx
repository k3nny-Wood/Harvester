import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useActiveChart } from '../chartStore';
import { openChart } from '../dock';
import { snapToTick } from '../ladderMath';
import { useApp } from '../store';
import { closeOrder } from '../sizing';
import { MarginModeToggle } from '../components/MarginModeToggle';
import { orderFromForm, quantityFor, refreshTrading, submitOrder } from '../trade';
import type { OrderKind } from '../types';

const TYPES: Array<{ id: OrderKind; label: string; hint: string }> = [
  { id: 'MARKET', label: 'Market', hint: 'Fills immediately at the best price' },
  { id: 'LIMIT', label: 'Limit', hint: 'Rests at your price' },
  { id: 'STOP_MARKET', label: 'Stop', hint: 'Market order once the trigger price is reached' },
  { id: 'STOP', label: 'Stop-limit', hint: 'Limit order once the trigger price is reached' },
  { id: 'TAKE_PROFIT_MARKET', label: 'Take-profit', hint: 'Market order once the profit trigger is reached' },
  { id: 'TAKE_PROFIT', label: 'TP-limit', hint: 'Limit order once the profit trigger is reached' },
];

const needsLimit = (t: OrderKind) => t === 'LIMIT' || t === 'STOP' || t === 'TAKE_PROFIT';
const needsTrigger = (t: OrderKind) => t === 'STOP_MARKET' || t === 'STOP' || t === 'TAKE_PROFIT_MARKET' || t === 'TAKE_PROFIT';

/** A labelled number input with a slider under it. */
function SliderField(props: { label: string; value: number; min: number; max: number; step: number; suffix?: string; digits?: number; sub?: string; onChange: (v: number) => void; onCommit?: () => void }) {
  const { label, value, min, max, step, suffix, digits = 2, sub, onChange, onCommit } = props;
  const clamped = Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
  return (
    <div className="sf">
      <div className="sf-row">
        <span>{label}</span>
        <span className="sf-val">
          <input type="number" value={Number.isFinite(value) ? Number(value.toFixed(digits)) : ''} step={step} onChange={(e) => onChange(Number(e.target.value))} onBlur={onCommit} />
          {suffix && <em>{suffix}</em>}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={clamped}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
      />
      {sub && <div className="sf-sub">{sub}</div>}
    </div>
  );
}

/** Manual order entry for the symbol of the focused chart: every parameter has a field and a slider. */
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
  const tick = filters?.tickSize;

  // leverage of this symbol on the exchange (read once per symbol, set when the slider is released)
  const [lev, setLev] = useState(1);
  const [maxLev, setMaxLev] = useState(20);
  const levLoaded = useRef('');
  useEffect(() => {
    if (!symbol || !trading?.hasCredentials || levLoaded.current === symbol) return;
    levLoaded.current = symbol;
    api
      .symbolLeverage(symbol)
      .then((l) => {
        setLev(l.leverage);
        setMaxLev(Math.max(1, l.maxLeverage));
        patch({ leverage: String(l.leverage) });
      })
      .catch(() => undefined);
  }, [symbol, trading?.hasCredentials, patch]);

  // a leverage set elsewhere (the chart's right-click menu) shows here too
  useEffect(() => {
    const f = Number(form.leverage);
    if (f >= 1 && f !== lev) setLev(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.leverage]);

  if (trading && !trading.hasCredentials) {
    return (
      <div className="panel pad">
        <h3>Trading is not set up</h3>
        <p className="warn">{trading.message}</p>
      </div>
    );
  }

  const t = form.type;
  const base = mark || 0;
  const setPct = (field: 'price' | 'stopPrice', pct: number) => patch({ [field]: String(snapToTick(base * (1 + pct / 100), tick)) } as never);
  const pctOf = (v: string) => (base > 0 && Number(v) > 0 ? (Number(v) / base - 1) * 100 : 0);

  const limitPrice = needsLimit(t) ? Number(form.price) || (needsTrigger(t) ? Number(form.stopPrice) : base) || base : base;
  const refPrice = needsTrigger(t) ? Number(form.stopPrice) || base : limitPrice;
  const available = account?.availableBalance ?? 0;
  const position = account?.positions.find((p) => p.symbol === symbol && p.amount !== 0);
  const qty = form.sizeMode === 'pos' ? (closeOrder(position?.amount ?? 0, Number(form.size), Number(filters?.stepSize) || 0)?.quantity ?? 0) : quantityFor(refPrice, form.sizeMode, Number(form.size), available, lev);
  const notional = qty * refPrice;
  const margin = notional / Math.max(1, lev);
  const maker = t === 'LIMIT' && form.postOnly;
  const fee = notional * (maker || t === 'LIMIT' ? 0.0002 : 0.0005);
  const mmr = (filters?.maintMarginPercent ?? 0.5) / 100;
  const liq = refPrice > 0 ? (form.side === 'BUY' ? refPrice * (1 - 1 / lev + mmr) : refPrice * (1 + 1 / lev - mmr)) : 0;
  const mine = orders.filter((o) => o.symbol === symbol);
  const color = form.side === 'BUY' ? 'var(--up)' : 'var(--down)';

  const chooseType = (next: OrderKind) => {
    const p: Record<string, string | OrderKind> = { type: next };
    if (needsTrigger(next) && !form.stopPrice && base > 0) {
      // a sensible default trigger on the correct side of the market: a stop sits against the position, a take-profit with it
      const isStop = next === 'STOP_MARKET' || next === 'STOP';
      const above = isStop === (form.side === 'BUY');
      p.stopPrice = String(snapToTick(base * (above ? 1.01 : 0.99), tick));
    }
    patch(p as never);
  };

  const commitLeverage = async () => {
    if (!symbol || lev < 1) return;
    try {
      await api.setLeverage(symbol, lev);
      patch({ leverage: String(lev) });
      toast(`${symbol} leverage set to ${lev}x`, 'info');
    } catch (e) {
      toast(`Leverage: ${e}`, 'warn');
    }
  };

  const place = async () => {
    const built = orderFromForm();
    if (typeof built === 'string') return toast(built, 'warn');
    const { order, notional: n } = built;
    const desc = TYPES.find((x) => x.id === order.type)?.label ?? order.type;
    const lines = [
      `${order.side} ${desc}`,
      `${order.quantity.toFixed(qtyPrecision)} ${symbol}  ≈ ${n.toFixed(2)} USDT`,
      order.price ? `Limit price ${order.price}` : '',
      order.stopPrice ? `Trigger ${order.stopPrice}` : '',
      `Leverage ${lev}x, margin ≈ ${(n / Math.max(1, lev)).toFixed(2)} USDT`,
      order.reduceOnly ? 'Reduce only' : '',
    ].filter(Boolean);
    await submitOrder(order, `${env === 'live' ? 'LIVE ORDER - real money.\n\n' : ''}${lines.join('\n')}\n\nPlace it?`);
  };

  const sizeMax = form.sizeMode === 'pct' || form.sizeMode === 'pos' ? 100 : form.sizeMode === 'usdt' ? Math.max(100, Math.floor(available * Math.max(1, lev))) : Math.max(0.001, (available * Math.max(1, lev)) / Math.max(refPrice, 1e-9));
  const sizeStep = form.sizeMode === 'pct' || form.sizeMode === 'pos' ? 1 : form.sizeMode === 'usdt' ? 1 : Number(filters?.stepSize) || 0.001;

  return (
    <div className="panel order-entry">
      <div className="of-sides">
        <button className={`buy${form.side === 'BUY' ? ' on' : ''}`} onClick={() => patch({ side: 'BUY' })}>
          Buy / Long
        </button>
        <button className={`sell${form.side === 'SELL' ? ' on' : ''}`} onClick={() => patch({ side: 'SELL' })}>
          Sell / Short
        </button>
      </div>
      <div className="of-sym">
        <a className="sym-link" title="Bring up this symbol's chart" onClick={() => openChart(symbol)}>
          {symbol}
        </a>
        <span className="muted">
          last <b>{mark ? mark.toFixed(precision) : '…'}</b> · available <b>{available.toFixed(2)}</b> USDT
        </span>
      </div>

      <div className="of-types">
        {TYPES.map((x) => (
          <button key={x.id} className={x.id === t ? 'on' : ''} title={x.hint} onClick={() => chooseType(x.id)}>
            {x.label}
          </button>
        ))}
      </div>
      <div className="muted of-hint">{TYPES.find((x) => x.id === t)?.hint}</div>

      {needsTrigger(t) && (
        <SliderField
          label="Trigger price"
          value={Number(form.stopPrice) || base}
          min={base * 0.8}
          max={base * 1.2}
          step={Number(tick) || 0.01}
          digits={precision}
          sub={`${pctOf(form.stopPrice) >= 0 ? '+' : ''}${pctOf(form.stopPrice).toFixed(2)}% from last`}
          onChange={(v) => patch({ stopPrice: String(snapToTick(v, tick)) })}
        />
      )}
      {needsLimit(t) && (
        <SliderField
          label="Limit price"
          value={Number(form.price) || (needsTrigger(t) ? Number(form.stopPrice) : base) || base}
          min={base * 0.8}
          max={base * 1.2}
          step={Number(tick) || 0.01}
          digits={precision}
          sub={`${pctOf(form.price || String(base)) >= 0 ? '+' : ''}${pctOf(form.price || String(base)).toFixed(2)}% from last${form.price ? '' : ' (following the last price)'}`}
          onChange={(v) => setPct('price', (v / (base || 1) - 1) * 100)}
        />
      )}
      {(needsLimit(t) || needsTrigger(t)) && (
        <div className="of-quick">
          <span className="muted">Offset from last:</span>
          {[-5, -2, -1, -0.5, 0.5, 1, 2, 5].map((p) => (
            <button key={p} onClick={() => setPct(needsTrigger(t) ? 'stopPrice' : 'price', p)}>
              {p > 0 ? '+' : ''}
              {p}%
            </button>
          ))}
          {needsLimit(t) && !needsTrigger(t) && <a onClick={() => patch({ price: '' })}>follow last</a>}
        </div>
      )}

      <div className="of-sizemode">
        <span>Size in</span>
        {(['usdt', 'qty', 'pct', 'pos'] as const).map((m) => (
          <button
            key={m}
            className={form.sizeMode === m ? 'on' : ''}
            disabled={m === 'pos' && !position}
            title={m === 'pos' ? (position ? 'A share of the position you hold: the order closes it (sell a long, buy back a short), reduce-only' : `You hold no ${symbol} position`) : undefined}
            onClick={() => {
              if (m === 'pos' && position) patch({ sizeMode: m, size: '50', side: position.amount > 0 ? 'SELL' : 'BUY', reduceOnly: true });
              else patch({ sizeMode: m, size: m === 'pct' ? '10' : m === 'usdt' ? '100' : String(qty ? qty.toFixed(qtyPrecision) : '0.01') });
            }}
          >
            {m === 'usdt' ? 'USDT' : m === 'qty' ? 'Quantity' : m === 'pct' ? '% balance' : '% position'}
          </button>
        ))}
      </div>
      <SliderField
        label={form.sizeMode === 'pct' ? 'Margin used' : form.sizeMode === 'pos' ? 'Share of your position' : form.sizeMode === 'usdt' ? 'Order value' : 'Quantity'}
        value={Number(form.size)}
        min={form.sizeMode === 'pct' || form.sizeMode === 'pos' ? 1 : 0}
        max={sizeMax}
        step={sizeStep}
        digits={form.sizeMode === 'qty' ? qtyPrecision : 2}
        suffix={form.sizeMode === 'pct' ? '% of balance' : form.sizeMode === 'pos' ? '% of position' : form.sizeMode === 'usdt' ? 'USDT' : symbol.replace('USDT', '')}
        sub={form.sizeMode === 'pos' && position ? `${position.amount > 0 ? 'sells' : 'buys back'} ${qty ? qty.toFixed(qtyPrecision) : 0} of your ${position.amount > 0 ? 'long' : 'short'} ${Math.abs(position.amount)} ${symbol.replace('USDT', '')}  ·  ≈ ${notional.toFixed(2)} USDT  ·  reduce-only` : `≈ ${qty ? qty.toFixed(qtyPrecision) : 0} ${symbol.replace('USDT', '')}  ·  ${notional.toFixed(2)} USDT`}
        onChange={(v) => patch({ size: String(v) })}
      />

      <MarginModeToggle symbol={symbol} />
      <SliderField label="Leverage" value={lev} min={1} max={maxLev} step={1} digits={0} suffix="x" sub={`max ${maxLev}x for ${symbol} · applied to the symbol when you release the slider`} onChange={(v) => setLev(Math.round(v))} onCommit={() => void commitLeverage()} />

      <div className="of-flags">
        <label>
          <input type="checkbox" checked={form.reduceOnly} onChange={(e) => patch({ reduceOnly: e.target.checked })} /> Reduce only
        </label>
        <label>
          <input type="checkbox" checked={form.postOnly} disabled={t !== 'LIMIT'} onChange={(e) => patch({ postOnly: e.target.checked })} /> Post only (maker)
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
          <b>{notional ? `${margin.toFixed(2)} USDT` : '-'}</b>
        </div>
        <div>
          <span>Est. fee</span>
          <b>{notional ? `${fee.toFixed(3)} USDT` : '-'}</b>
        </div>
        <div>
          <span>Est. liquidation</span>
          <b>{liq ? liq.toFixed(precision) : '-'}</b>
        </div>
        <div>
          <span>Max order</span>
          <b>{trading ? `${trading.maxOrderNotional} USDT` : '-'}</b>
        </div>
      </div>

      <button className="primary place" style={{ background: color, borderColor: color, color: '#fff' }} disabled={!symbol || !qty} onClick={() => void place()}>
        {form.side === 'BUY' ? 'Buy' : 'Sell'} · {TYPES.find((x) => x.id === t)?.label}
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
                <tr key={`${o.conditional}-${o.orderId}`}>
                  <td className={o.side === 'BUY' ? 'up' : 'down'}>{o.side}</td>
                  <td>{o.type.replace(/_/g, ' ')}</td>
                  <td>{o.origQty}</td>
                  <td>
                    {o.price || o.stopPrice}
                    {o.conditional && o.price ? ` (trig ${o.stopPrice})` : ''}
                  </td>
                  <td>
                    <button
                      className="icon-btn"
                      title="Cancel this order"
                      onClick={() =>
                        void api
                          .cancelOrder(o.symbol, o.orderId, o.conditional)
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
