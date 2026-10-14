import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { Vela } from '@luxalgo/vela';
import { api } from '../api';
import { confirmDialog } from '../confirm';
import { refreshTrading } from '../trade';
import { formatPrice, rawRungPrices, snapToTick } from '../ladderMath';
import { ladderSide, useChart, useChartId, type LadderDraft } from '../chartStore';
import { useApp } from '../store';
import type { LadderSpec } from '../types';
import { getProjector } from './projector';

const BUY = '#2e9b6f';
const SELL = '#d0454b';
const HANDLE_R = 7;

export function buildSpec(symbol: string, d: LadderDraft): LadderSpec {
  return {
    symbol,
    side: ladderSide(d),
    count: d.count,
    startPrice: d.startPrice,
    endPrice: d.endPrice,
    distribution: d.distribution,
    sizeMode: d.sizeMode,
    multiplier: d.multiplier,
    total: { mode: d.totalMode, value: d.totalValue },
    groupId: 'draft',
  };
}

interface Geometry {
  /** offset of the plot area inside the overlay */
  offX: number;
  offY: number;
  width: number;
  height: number;
  yOf: (price: number) => number | null;
  priceAt: (clientY: number) => number;
  xInOverlay: (clientX: number) => number;
}

/**
 * The ladder tool. Click once to start the vertical range line, click again for its end, then fine-tune:
 * drag either end (or the line itself), and set the number of orders with the slider.
 * All drawing is a DOM/SVG layer over the chart so it can be dragged smoothly; the exact, rounded and
 * validated rungs come from the Rust core.
 */
/** The ladder's order count after `change` wheel steps, kept between the smallest and the largest ladder. */
export function stepCount(count: number, change: number): number {
  return Math.min(50, Math.max(2, Math.round(count) + change));
}

export function LadderOverlay({ chart, host }: { chart: Vela | null; host: RefObject<HTMLDivElement | null> }) {
  const chartId = useChartId();
  const d = useChart((s) => s.ladder);
  const patch = useChart((s) => s.patchLadder);
  const reset = useChart((s) => s.resetLadder);
  const symbol = useChart((s) => s.symbol);
  const filters = useChart((s) => s.filters);
  const markPrice = useChart((s) => s.markPrice);
  const rootRef = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0);
  const [hover, setHover] = useState<{ y: number; price: number } | null>(null);
  const drag = useRef<null | { kind: 'start' | 'end' | 'body'; lastPrice: number }>(null);
  const precision = filters?.pricePrecision ?? 2;

  // Repaint when the chart pans / zooms / resizes.
  useEffect(() => {
    if (!chart) return;
    const bump = () => setTick((t) => t + 1);
    const offs = [chart.on('viewport:changed', bump), chart.on('pane:changed', bump)];
    const ro = new ResizeObserver(bump);
    if (host.current) ro.observe(host.current);
    const timer = window.setInterval(bump, 400); // price-scale auto-fit does not always raise an event
    return () => {
      offs.forEach((o) => typeof o === 'function' && o());
      ro.disconnect();
      window.clearInterval(timer);
    };
  }, [chart, host]);

  const geometry = useCallback((): Geometry | null => {
    const root = rootRef.current;
    if (!chart || !root) return null;
    const info = getProjector(chart);
    if (!info) return null;
    const rect = root.getBoundingClientRect();
    const offX = info.plotRect.left - rect.left;
    const offY = info.plotRect.top - rect.top;
    return {
      offX,
      offY,
      width: info.proj.width,
      height: info.proj.height,
      yOf: (price) => {
        const y = info.proj.yOf(price, 'price');
        return y == null ? null : offY + y;
      },
      priceAt: (clientY) => snapToTick(info.proj.pxToPoint(0, clientY - info.plotRect.top, 'price').price, filters?.tickSize),
      xInOverlay: (clientX) => clientX - rect.left,
    };
  }, [chart, filters?.tickSize]);

  // Keyboard: L starts the tool, Esc cancels it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) return;
      if (useApp.getState().activeChartId !== chartId) return; // only the focused chart reacts
      if (e.key === 'Escape') reset();
      if ((e.key === 'l' || e.key === 'L') && !e.ctrlKey && !e.metaKey) patch({ phase: 'start' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [patch, reset, chartId]);

  // Mouse wheel over the chart changes the number of orders while the ladder is being drawn or adjusted (wheel up = more, down = fewer).
  // It listens before the chart does and swallows the wheel, so the chart does not zoom at the same time.
  const countRef = useRef(d.count);
  countRef.current = d.count;
  const wheelAcc = useRef(0);
  useEffect(() => {
    const el = host.current;
    if (!el || (d.phase !== 'end' && d.phase !== 'armed')) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      wheelAcc.current += e.deltaY;
      // one step per notch (about 100); a trackpad's small movements add up to a step
      const steps = Math.trunc(wheelAcc.current / 100);
      if (steps === 0) return;
      wheelAcc.current -= steps * 100;
      const next = stepCount(countRef.current, -steps);
      if (next !== countRef.current) patch({ count: next });
    };
    el.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => el.removeEventListener('wheel', onWheel, true);
  }, [host, d.phase, patch]);

  // Exact rungs from the Rust core, debounced while the trader drags / slides.
  const spec = useMemo(() => (d.phase === 'armed' || d.phase === 'end' ? buildSpec(symbol, d) : null), [symbol, d]);
  useEffect(() => {
    if (!spec || d.startPrice === d.endPrice || !markPrice) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      api
        .previewLadder(spec, markPrice)
        .then((p) => alive && patch({ preview: p, previewError: null }))
        .catch((e) => alive && patch({ previewError: String(e) }));
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [spec, markPrice, d.startPrice, d.endPrice, patch]);

  const g = geometry();
  const capture = d.phase === 'start' || d.phase === 'end';
  const side = ladderSide(d);
  const color = side === 'BUY' ? BUY : SELL;

  const onMove = (e: ReactPointerEvent) => {
    const geo = geometry();
    if (!geo) return;
    const price = geo.priceAt(e.clientY);
    if (capture) {
      setHover({ y: e.clientY, price });
      if (d.phase === 'end') patch({ endPrice: price });
    }
  };

  const onClick = (e: ReactPointerEvent) => {
    const geo = geometry();
    if (!geo || !capture) return;
    const price = geo.priceAt(e.clientY);
    if (d.phase === 'start') {
      patch({ phase: 'end', x: geo.xInOverlay(e.clientX), startPrice: price, endPrice: price, preview: null });
    } else if (price !== d.startPrice) {
      patch({ phase: 'armed', endPrice: price });
    }
  };

  const beginDrag = (kind: 'start' | 'end' | 'body') => (e: ReactPointerEvent) => {
    const geo = geometry();
    if (!geo) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { kind, lastPrice: geo.priceAt(e.clientY) };
    e.stopPropagation();
  };
  const moveDrag = (e: ReactPointerEvent) => {
    const geo = geometry();
    const st = drag.current;
    if (!geo || !st) return;
    const price = geo.priceAt(e.clientY);
    if (st.kind === 'start') patch({ startPrice: price });
    else if (st.kind === 'end') patch({ endPrice: price });
    else {
      const delta = price - st.lastPrice;
      patch({ startPrice: snapToTick(d.startPrice + delta, filters?.tickSize), endPrice: snapToTick(d.endPrice + delta, filters?.tickSize) });
      st.lastPrice = price;
    }
  };
  const endDrag = () => {
    drag.current = null;
  };

  const prices = useMemo(
    () => (d.phase === 'start' || d.startPrice === d.endPrice ? [] : rawRungPrices(d.startPrice, d.endPrice, d.count, d.distribution)),
    [d.phase, d.startPrice, d.endPrice, d.count, d.distribution],
  );
  const preview = d.preview && d.preview.rungs.length === prices.length ? d.preview : null;

  const yStart = g ? g.yOf(d.startPrice) : null;
  const yEnd = g ? g.yOf(d.endPrice) : null;
  const x = d.x;

  return (
    <div
      ref={rootRef}
      className={`ladder-layer${capture ? ' capture' : ''}`}
      onPointerMove={onMove}
      onPointerDown={capture ? onClick : undefined}
      onPointerLeave={() => setHover(null)}
    >
      {g && d.phase === 'start' && hover && (
        <svg className="ladder-svg">
          <line x1={g.offX} x2={g.offX + g.width} y1={hover.y - rootRef.current!.getBoundingClientRect().top} y2={hover.y - rootRef.current!.getBoundingClientRect().top} stroke="#8b98a5" strokeDasharray="4 4" />
          <text x={g.offX + 8} y={hover.y - rootRef.current!.getBoundingClientRect().top - 6} className="ladder-hint">
            Click to set the START of the ladder · {formatPrice(hover.price, precision)}
          </text>
        </svg>
      )}

      {g && d.phase !== 'idle' && d.phase !== 'start' && yStart != null && yEnd != null && (
        <svg className="ladder-svg">
          {prices.map((p, i) => {
            const y = g.yOf(p);
            if (y == null) return null;
            const rung = preview?.rungs[i];
            const bad = rung && !rung.valid;
            const held = !!rung?.held;
            return (
              <g key={i}>
                <line x1={g.offX} x2={g.offX + g.width} y1={y} y2={y} stroke={bad ? '#e0a33d' : color} strokeWidth={1} strokeDasharray={bad ? '2 4' : '5 4'} opacity={0.85} />
                <line x1={x - 6} x2={x + 6} y1={y} y2={y} stroke={color} strokeWidth={2} />
                <text x={g.offX + g.width - 6} y={y - 3} textAnchor="end" className="ladder-label" fill={bad ? '#e0a33d' : color}>
                  #{i + 1} {rung ? `${rung.quantity} @ ${formatPrice(rung.price, precision)}` : formatPrice(p, precision)}
                  {bad ? ' ⚠' : held ? ' ⏸ held' : ''}
                </text>
              </g>
            );
          })}
          {/* the vertical range line */}
          <line x1={x} x2={x} y1={yStart} y2={yEnd} stroke={color} strokeWidth={3} strokeLinecap="round" />
          <line x1={x} x2={x} y1={yStart} y2={yEnd} stroke="transparent" strokeWidth={16} style={{ cursor: 'grab', pointerEvents: d.phase === 'armed' ? 'stroke' : 'none' }} onPointerDown={beginDrag('body')} onPointerMove={moveDrag} onPointerUp={endDrag} />
          {(['start', 'end'] as const).map((k) => {
            const y = k === 'start' ? yStart : yEnd;
            return (
              <g key={k}>
                <circle cx={x} cy={y} r={HANDLE_R} fill="#0f1620" stroke={color} strokeWidth={2.5} style={{ cursor: 'ns-resize', pointerEvents: d.phase === 'armed' ? 'auto' : 'none' }} onPointerDown={beginDrag(k)} onPointerMove={moveDrag} onPointerUp={endDrag} />
                <text x={x + 12} y={y! + 4} className="ladder-label" fill={color}>
                  {k === 'start' ? 'start' : 'end'} {formatPrice(k === 'start' ? d.startPrice : d.endPrice, precision)}
                </text>
              </g>
            );
          })}
        </svg>
      )}

      {d.phase === 'end' && <div className="ladder-banner">Click to set the END of the ladder · mouse wheel: number of orders ({d.count}) · Esc cancels</div>}

      {d.phase === 'armed' && g && yStart != null && yEnd != null && (
        <LadderCard
          style={{ left: cardLeft(x, g.offX, g.width), top: Math.max(6, Math.min((yStart + yEnd) / 2 - 90, g.offY + g.height - 330)) }}
          color={color}
          precision={precision}
        />
      )}
    </div>
  );
}

const CARD_W = 280;

/** Beside the range line: to its right when there is room, otherwise to its left, so it never covers the line. */
function cardLeft(x: number, plotLeft: number, plotWidth: number): number {
  const right = x + 28;
  if (right + CARD_W <= plotLeft + plotWidth - 70) return right; // 70px keeps the price labels clear
  return Math.max(4, x - 28 - CARD_W);
}

function LadderCard({ style, color, precision }: { style: React.CSSProperties; color: string; precision: number }) {
  const d = useChart((s) => s.ladder);
  const patch = useChart((s) => s.patchLadder);
  const reset = useChart((s) => s.resetLadder);
  const symbol = useChart((s) => s.symbol);
  const side = ladderSide(d);
  const qtyPrecision = useChart((s) => s.filters?.quantityPrecision ?? 3);
  const trading = useApp((s) => s.trading);
  const env = useApp((s) => s.env);
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const p = d.preview;
  const invalid = p ? p.rungs.filter((r) => !r.valid).length : 0;
  const heldCount = p ? p.rungs.filter((r) => r.valid && r.held).length : 0;
  const valid = p ? p.rungs.filter((r) => r.valid) : [];

  const place = async () => {
    if (!p || valid.length === 0) return;
    const text = `${env === 'live' ? 'LIVE ORDERS - real money.\n\n' : ''}Place ${valid.length} ${side} limit orders on ${symbol}?\nTotal about ${p.totalNotional.toFixed(2)} USDT, average ${formatPrice(p.averageEntry, precision)}${invalid ? `\n(${invalid} rung(s) that break exchange limits are skipped)` : ''}${heldCount ? `\n${heldCount} rung(s) are beyond Binance's price band: they are kept on this computer and sent automatically when the price comes within range (Harvester must be open).` : ''}`;
    if (!(await confirmDialog(text, { danger: env === 'live', confirmLabel: `Place ${valid.length} orders` }))) return;
    setBusy(true);
    const tag = `hv${Date.now().toString(36)}`;
    try {
      const results = await api.placeOrders(valid.map((r, i) => ({ symbol, side, type: 'LIMIT' as const, quantity: r.quantity, price: r.price, clientId: `${tag}-${i}` })));
      const failed = results.filter((x) => 'Err' in x) as Array<{ Err: string }>;
      const ok = results.length - failed.length;
      const heldNow = results.filter((x) => 'Ok' in x && x.Ok.status === 'HELD').length;
      toast(failed.length === 0 ? `Ladder placed: ${ok - heldNow} ${side} orders on ${symbol}${heldNow ? ` and ${heldNow} held on this computer until the price comes within Binance's range` : ''}` : `Ladder: ${ok} placed, ${failed.length} failed - ${failed[0].Err}`, failed.length ? 'warn' : 'info');
      void refreshTrading();
      if (failed.length === 0) reset();
    } catch (e) {
      toast(`Ladder: ${e}`, 'warn');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ladder-card" style={style} onPointerDown={(e) => e.stopPropagation()}>
      <div className="ladder-card-head">
        <button className="side-badge" style={{ background: color }} title="Switch between buy and sell" onClick={() => patch({ sideOverride: side === 'BUY' ? 'SELL' : 'BUY' })}>
          {side}
        </button>
        <span className="ladder-card-title">{symbol} ladder</span>
        <button className="icon-btn" title="Cancel (Esc)" onClick={reset}>
          ×
        </button>
      </div>

      <label className="row">
        <span>Orders</span>
        <b>{d.count}</b>
      </label>
      <input type="range" min={2} max={50} step={1} value={d.count} onChange={(e) => patch({ count: Number(e.target.value) })} />

      <div className="grid2">
        <label>
          <span>Spacing</span>
          <select value={d.distribution} onChange={(e) => patch({ distribution: e.target.value as LadderDraft['distribution'] })}>
            <option value="equal">Equal</option>
            <option value="geometric">Geometric</option>
          </select>
        </label>
        <label>
          <span>Sizes</span>
          <select value={d.sizeMode} onChange={(e) => patch({ sizeMode: e.target.value as LadderDraft['sizeMode'] })}>
            <option value="equal">Equal</option>
            <option value="linearUp">Growing</option>
            <option value="linearDown">Shrinking</option>
            <option value="exponential">Exponential</option>
          </select>
        </label>
        <label>
          <span>Total in</span>
          <select value={d.totalMode} onChange={(e) => patch({ totalMode: e.target.value as LadderDraft['totalMode'] })}>
            <option value="notional">USDT</option>
            <option value="qty">Quantity</option>
          </select>
        </label>
        <label>
          <span>Amount</span>
          <input type="number" min={0} value={d.totalValue} onChange={(e) => patch({ totalValue: Number(e.target.value) })} />
        </label>
        {d.sizeMode === 'exponential' && (
          <label>
            <span>Growth x</span>
            <input type="number" min={1} step={0.1} value={d.multiplier} onChange={(e) => patch({ multiplier: Number(e.target.value) })} />
          </label>
        )}
      </div>

      <div className="ladder-summary">
        {p ? (
          <>
            <div>
              <span>Size</span>
              <b>{p.totalQuantity.toFixed(qtyPrecision)}</b>
            </div>
            <div>
              <span>Notional</span>
              <b>{p.totalNotional.toFixed(2)} USDT</b>
            </div>
            <div>
              <span>Avg entry</span>
              <b>{formatPrice(p.averageEntry, precision)}</b>
            </div>
            {invalid > 0 && <div className="warn">{invalid} order(s) break the exchange limits (see ⚠)</div>}
          </>
        ) : (
          <div className="muted">{d.previewError ?? 'Calculating…'}</div>
        )}
      </div>

      <div className="ladder-actions">
        <button className="primary" disabled={busy || !trading?.hasCredentials || valid.length === 0} title={trading?.hasCredentials ? 'Place every valid rung as a limit order' : trading?.message} onClick={() => void place()}>
          {busy ? 'Placing...' : `Place ${valid.length || d.count} orders`}
        </button>
        <button onClick={reset}>Cancel</button>
      </div>
    </div>
  );
}
