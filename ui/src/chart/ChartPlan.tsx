import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { Vela } from '@luxalgo/vela';
import { api } from '../api';
import { useChart } from '../chartStore';
import { confirmDialog } from '../confirm';
import { formatPrice, snapToTick } from '../ladderMath';
import { withLevels } from '../plan';
import { useApp } from '../store';
import { refreshTrading } from '../trade';
import { getProjector, type Projector } from './projector';

const GREEN = '#2e9b6f';
const RED = '#d0454b';
const BLUE = '#4f8fdd';

/** x (in the plot) of a candle time, found by bisection on the chart's own pixel -> time mapping. */
function xForTime(proj: Projector, time: number): number {
  let lo = 0;
  let hi = proj.width;
  const t = (x: number) => proj.pxToPoint(x, 0, 'price').time;
  if (time <= t(lo)) return lo;
  if (time >= t(hi)) return hi;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    if (t(mid) < time) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The trade plan of an ML signal on the chart: a green reward zone and a red risk zone around the entry, an arrow from the
 * entry to the target, and stop / target lines the trader can drag. A card sets the size and places entry + stop-loss + take-profit.
 */
export function ChartPlan({ chart, host }: { chart: Vela | null; host: RefObject<HTMLDivElement | null> }) {
  const symbol = useChart((s) => s.symbol);
  const filters = useChart((s) => s.filters);
  const ps = useApp((s) => s.plans[symbol]);
  const patchPlan = useApp((s) => s.patchPlan);
  const clearPlan = useApp((s) => s.clearPlan);
  const trading = useApp((s) => s.trading);
  const env = useApp((s) => s.env);
  const toast = useApp((s) => s.toast);
  const rootRef = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0);
  const [drag, setDrag] = useState<'stop' | 'target' | null>(null);
  const [busy, setBusy] = useState(false);
  const precision = filters?.pricePrecision ?? 2;
  const qtyPrecision = filters?.quantityPrecision ?? 3;

  useEffect(() => {
    if (!chart || !ps) return;
    const bump = () => setTick((t) => t + 1);
    const offs = [chart.on('viewport:changed', bump), chart.on('pane:changed', bump)];
    const ro = new ResizeObserver(bump);
    if (host.current) ro.observe(host.current);
    const timer = window.setInterval(bump, 500);
    return () => {
      offs.forEach((o) => typeof o === 'function' && o());
      ro.disconnect();
      window.clearInterval(timer);
    };
  }, [chart, host, ps]);

  const priceAt = useCallback(
    (clientY: number): number | null => {
      if (!chart) return null;
      const info = getProjector(chart);
      if (!info) return null;
      return snapToTick(info.proj.pxToPoint(0, clientY - info.plotRect.top, 'price').price, filters?.tickSize);
    },
    [chart, filters?.tickSize],
  );

  if (!ps) return null;
  const { plan } = ps;
  const long = plan.side === 'BUY';
  const color = long ? GREEN : RED;
  const tick = Number(filters?.tickSize) || 0.0000001;

  const info = chart ? getProjector(chart) : null;
  const root = rootRef.current;
  let overlay: React.ReactNode = null;
  if (info && root) {
    const rect = root.getBoundingClientRect();
    const offX = info.plotRect.left - rect.left;
    const offY = info.plotRect.top - rect.top;
    const W = info.proj.width;
    const H = info.proj.height;
    const yOf = (p: number) => offY + Math.min(H, Math.max(0, info.proj.yOf(p, 'price') ?? (p > plan.entry ? 0 : H)));
    const xe = offX + Math.min(W - 120, xForTime(info.proj, plan.entryTime));
    const zoneW = Math.max(70, Math.min(230, offX + W - xe - 80));
    const [yE, yS, yT] = [yOf(plan.entry), yOf(plan.stop), yOf(plan.target)];
    const x2 = xe + zoneW;
    const head = (x: number, y: number, fromX: number, fromY: number, c: string) => {
      const a = Math.atan2(y - fromY, x - fromX);
      const p = (r: number, da: number) => `${x + r * Math.cos(a + da)},${y + r * Math.sin(a + da)}`;
      return <polygon points={`${x},${y} ${p(-12, 0.45)} ${p(-12, -0.45)}`} fill={c} />;
    };
    const label = (text: string, y: number, c: string) => (
      <text x={offX + W - 6} y={y - 4} textAnchor="end" className="plan-label" fill={c}>
        {text}
      </text>
    );
    overlay = (
      <svg className="plan-svg">
        {/* zones */}
        <rect x={xe} y={Math.min(yE, yT)} width={zoneW} height={Math.abs(yT - yE)} fill={GREEN} opacity={0.14} />
        <rect x={xe} y={Math.min(yE, yS)} width={zoneW} height={Math.abs(yS - yE)} fill={RED} opacity={0.14} />
        {/* levels */}
        <line x1={xe} x2={offX + W} y1={yE} y2={yE} stroke={BLUE} strokeWidth={1.4} />
        <line x1={xe} x2={offX + W} y1={yT} y2={yT} stroke={GREEN} strokeWidth={drag === 'target' ? 2.6 : 1.4} strokeDasharray="6 4" />
        <line x1={xe} x2={offX + W} y1={yS} y2={yS} stroke={RED} strokeWidth={drag === 'stop' ? 2.6 : 1.4} strokeDasharray="6 4" />
        {/* arrows: entry -> target (the plan), entry -> stop (the risk) */}
        <line x1={xe} y1={yE} x2={x2} y2={yT} stroke={GREEN} strokeWidth={3} strokeLinecap="round" />
        {head(x2, yT, xe, yE, GREEN)}
        <line x1={xe} y1={yE} x2={x2} y2={yS} stroke={RED} strokeWidth={1.6} strokeDasharray="4 4" />
        {head(x2, yS, xe, yE, RED)}
        <circle cx={xe} cy={yE} r={6} fill="#0f1620" stroke={BLUE} strokeWidth={2.5} />
        {/* labels */}
        {label(`TP ${formatPrice(plan.target, precision)}  +${plan.rewardPct.toFixed(2)}%`, yT, GREEN)}
        {label(`ENTRY ${formatPrice(plan.entry, precision)}  ${long ? 'LONG' : 'SHORT'} ${(ps.probability * 100).toFixed(0)}%  R:R ${plan.rr.toFixed(1)}`, yE, BLUE)}
        {label(`SL ${formatPrice(plan.stop, precision)}  -${plan.riskPct.toFixed(2)}%`, yS, RED)}
        {/* grab areas for the two movable levels */}
        {(['target', 'stop'] as const).map((k) => {
          const y = k === 'target' ? yT : yS;
          return (
            <line
              key={k}
              className="order-hit"
              x1={xe}
              x2={offX + W - 240}
              y1={y}
              y2={y}
              stroke="transparent"
              strokeWidth={14}
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                (e.currentTarget as Element).setPointerCapture(e.pointerId);
                setDrag(k);
              }}
              onPointerMove={(e) => moveLevel(e, k)}
              onPointerUp={() => setDrag(null)}
              onPointerCancel={() => setDrag(null)}
            >
              <title>Drag to move the {k === 'stop' ? 'stop-loss' : 'take-profit'}</title>
            </line>
          );
        })}
      </svg>
    );
  }

  function moveLevel(e: ReactPointerEvent, k: 'stop' | 'target') {
    if (drag !== k) return;
    const p = priceAt(e.clientY);
    if (p == null || p <= 0) return;
    const e0 = plan.entry;
    // a stop stays on the losing side of the entry and a target on the winning side, at least one tick away
    const stop = k === 'stop' ? (long ? Math.min(p, e0 - tick) : Math.max(p, e0 + tick)) : plan.stop;
    const target = k === 'target' ? (long ? Math.max(p, e0 + tick) : Math.min(p, e0 - tick)) : plan.target;
    patchPlan(symbol, { plan: withLevels(plan, stop, target) });
  }

  // sizing: quantity so that being stopped out costs `riskUsd`
  const riskPerUnit = Math.abs(plan.entry - plan.stop);
  const rawQty = riskPerUnit > 0 ? ps.riskUsd / riskPerUnit : 0;
  const step = Number(filters?.stepSize) || 0.001;
  const qty = Math.floor(rawQty / step + 1e-9) * step;
  const notional = qty * plan.entry;
  const cap = trading?.maxOrderNotional ?? 0;
  const over = cap > 0 && notional > cap;
  const canPlace = !!trading?.hasCredentials && qty > 0 && !over && !busy;

  const setRisk = (pct: number) => {
    const stop = long ? plan.entry * (1 - pct / 100) : plan.entry * (1 + pct / 100);
    const risk = Math.abs(plan.entry - stop);
    const target = long ? plan.entry + plan.rr * risk : plan.entry - plan.rr * risk; // keep the R:R
    patchPlan(symbol, { plan: withLevels(plan, snapToTick(stop, filters?.tickSize), snapToTick(target, filters?.tickSize)) });
  };
  const setRR = (rr: number) => {
    const risk = Math.abs(plan.entry - plan.stop);
    const target = long ? plan.entry + rr * risk : plan.entry - rr * risk;
    patchPlan(symbol, { plan: withLevels(plan, plan.stop, snapToTick(target, filters?.tickSize)) });
  };

  const place = async () => {
    const text = [
      env === 'live' ? 'LIVE ORDER - real money.\n' : '',
      `${long ? 'LONG' : 'SHORT'} ${symbol}  ${qty.toFixed(qtyPrecision)}  (≈ ${notional.toFixed(2)} USDT)`,
      `Entry: ${ps.entryType === 'market' ? 'at market' : `limit ${formatPrice(plan.entry, precision)}`}`,
      `Stop-loss ${formatPrice(plan.stop, precision)}  (-${plan.riskPct.toFixed(2)}%, about -${ps.riskUsd.toFixed(2)} USDT)`,
      `Take-profit ${formatPrice(plan.target, precision)}  (+${plan.rewardPct.toFixed(2)}%, R:R ${plan.rr.toFixed(1)})`,
      '',
      'The stop-loss and take-profit are placed as soon as the entry has filled (Harvester must stay open until then).',
    ]
      .filter((l) => l !== '')
      .join('\n');
    if (!(await confirmDialog(text, { danger: env === 'live', confirmLabel: `Place ${long ? 'long' : 'short'}` }))) return;
    setBusy(true);
    try {
      await api.placeBracket({ symbol, side: plan.side, quantity: qty, entryPrice: ps.entryType === 'limit' ? plan.entry : undefined, stop: plan.stop, target: plan.target });
      toast(`Entry placed for ${symbol}. Stop-loss and take-profit follow when it fills.`, 'info');
      clearPlan(symbol);
      void refreshTrading();
    } catch (e) {
      toast(`Could not place the plan: ${e}`, 'warn');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={rootRef} className="plan-layer">
      {overlay}
      <div className="plan-card" onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
        <div className="plan-head">
          <span className={`kind side ${long ? 'long' : 'short'}`}>{long ? 'LONG' : 'SHORT'}</span>
          <b>{symbol}</b>
          <span className="muted">ML {(ps.probability * 100).toFixed(0)}%</span>
          <button className="icon-btn" title="Remove the plan from the chart" onClick={() => clearPlan(symbol)}>
            ×
          </button>
        </div>
        <div className="plan-seg">
          <button className={ps.entryType === 'market' ? 'on' : ''} onClick={() => patchPlan(symbol, { entryType: 'market' })}>
            Market entry
          </button>
          <button className={ps.entryType === 'limit' ? 'on' : ''} onClick={() => patchPlan(symbol, { entryType: 'limit' })}>
            Limit @ {formatPrice(plan.entry, precision)}
          </button>
        </div>
        <label className="plan-row">
          <span>Stop distance</span>
          <b className="down">{plan.riskPct.toFixed(2)}%</b>
        </label>
        <input type="range" min={0.2} max={10} step={0.05} value={Math.min(10, Math.max(0.2, plan.riskPct))} onChange={(e) => setRisk(Number(e.target.value))} />
        <label className="plan-row">
          <span>Reward : risk</span>
          <b className="up">{plan.rr.toFixed(1)} R</b>
        </label>
        <input type="range" min={0.5} max={6} step={0.1} value={Math.min(6, Math.max(0.5, plan.rr))} onChange={(e) => setRR(Number(e.target.value))} />
        <label className="plan-row">
          <span>Risk if stopped out</span>
          <b>{ps.riskUsd.toFixed(0)} USDT</b>
        </label>
        <input type="range" min={5} max={250} step={5} value={ps.riskUsd} onChange={(e) => patchPlan(symbol, { riskUsd: Number(e.target.value) })} />
        <div className="plan-sum">
          <div>
            <span>Size</span>
            <b>
              {qty.toFixed(qtyPrecision)} {symbol.replace('USDT', '')}
            </b>
          </div>
          <div>
            <span>Notional</span>
            <b className={over ? 'down' : ''}>{notional.toFixed(2)} USDT</b>
          </div>
          <div>
            <span>Potential gain</span>
            <b className="up">{(ps.riskUsd * plan.rr).toFixed(2)} USDT</b>
          </div>
        </div>
        {over && <div className="warn plan-note">Above the {cap} USDT safety cap per order: lower the risk or widen the stop.</div>}
        <div className="plan-actions">
          <button className="primary" style={{ background: color, borderColor: color, color: '#fff' }} disabled={!canPlace} title={trading?.hasCredentials ? '' : trading?.message} onClick={() => void place()}>
            {busy ? 'Placing…' : `Place ${long ? 'long' : 'short'} (entry + SL + TP)`}
          </button>
        </div>
        <div className="muted plan-note">A plan, not advice. Drag the red and green lines to adjust.</div>
      </div>
    </div>
  );
}
