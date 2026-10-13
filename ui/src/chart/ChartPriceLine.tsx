import { useEffect, useRef, useState } from 'react';
import type { Vela } from '@luxalgo/vela';
import { useChart } from '../chartStore';
import { formatPrice } from '../ladderMath';
import { intervalMs } from '../intervals';
import { getProjector } from './projector';

/** m:ss (or h:mm:ss) left until the current candle closes. */
export function countdown(msLeft: number): string {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = (x: number) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s % 60)}` : `${p(m)}:${p(s % 60)}`;
}

/**
 * The line at the last price: white, and it fades slightly in and out so it is easy to find. The chart library's own price line (coloured by
 * direction, steady) is switched off in favour of this one, with the same chip on the price axis: the price and the time until the candle closes.
 */
export function ChartPriceLine({ chart }: { chart: Vela | null }) {
  const price = useChart((s) => s.markPrice);
  const timeframe = useChart((s) => s.timeframe);
  const precision = useChart((s) => s.filters?.pricePrecision ?? 2);
  const rootRef = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!chart) return;
    const bump = () => setTick((t) => t + 1);
    const offs = [chart.on('viewport:changed', bump), chart.on('pane:changed', bump)];
    const timer = window.setInterval(bump, 1000); // also moves the countdown
    return () => {
      offs.forEach((o) => typeof o === 'function' && o());
      window.clearInterval(timer);
    };
  }, [chart]);

  const info = chart ? getProjector(chart) : null;
  const root = rootRef.current;
  let body = null;
  if (info && root && price > 0) {
    const rect = root.getBoundingClientRect();
    const y0 = info.proj.yOf(price, 'price');
    if (y0 != null && y0 >= 0 && y0 <= info.proj.height) {
      const y = info.plotRect.top - rect.top + y0;
      const x0 = info.plotRect.left - rect.left;
      const x1 = x0 + info.proj.width;
      const axisW = Math.max(40, rect.width - x1);
      const ms = intervalMs(timeframe);
      body = (
        <svg className="trade-svg">
          <g className="price-pulse">
            <line x1={x0} x2={x1} y1={y} y2={y} stroke="#ffffff" strokeWidth={1.2} strokeDasharray="2 3" />
            <g transform={`translate(${x1}, ${y - 15})`}>
              <rect width={axisW} height={30} fill="#ffffff" />
              <text x={axisW / 2} y={12} textAnchor="middle" fill="#0b0f15" className="price-chip">
                {formatPrice(price, precision)}
              </text>
              <text x={axisW / 2} y={25} textAnchor="middle" fill="#3a4350" className="price-chip small">
                {countdown(ms - (Date.now() % ms))}
              </text>
            </g>
          </g>
        </svg>
      );
    }
  }
  return (
    <div ref={rootRef} className="trade-layer">
      {body}
    </div>
  );
}
