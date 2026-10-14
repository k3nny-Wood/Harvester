import { useEffect, useRef, useState } from 'react';
import type { Vela } from '@luxalgo/vela';
import { useAnalyst } from '../analyst/store';
import { useChart } from '../chartStore';
import { formatPrice } from '../ladderMath';
import { ago } from '../panels/AnalystPanel';
import { getProjector } from './projector';

const COLORS = { support: '#2e9b6f', resistance: '#d0454b', target: '#4fa3ff', invalidation: '#e0a33d' } as const;
const BIAS = { bullish: { color: '#2e9b6f', label: 'bullish' }, bearish: { color: '#d0454b', label: 'bearish' }, neutral: { color: '#9aa7b8', label: 'neutral' } } as const;

/**
 * The analyst's key levels as dotted lines on the chart, and its bias as a small arrow beside the price. Always labelled as an opinion: the
 * Track record tab shows whether such calls have earned any trust.
 */
export function ChartAnalysis({ chart }: { chart: Vela | null }) {
  const symbol = useChart((s) => s.symbol);
  const filters = useChart((s) => s.filters);
  const price = useChart((s) => s.markPrice);
  const entry = useAnalyst((s) => s.latest[symbol]);
  const show = useAnalyst((s) => s.showOnChart);
  const rootRef = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!chart || !show || !entry) return;
    const bump = () => setTick((t) => t + 1);
    const offs = [chart.on('viewport:changed', bump), chart.on('pane:changed', bump)];
    const timer = window.setInterval(bump, 1000);
    return () => {
      offs.forEach((o) => typeof o === 'function' && o());
      window.clearInterval(timer);
    };
  }, [chart, show, entry]);

  const info = chart ? getProjector(chart) : null;
  const root = rootRef.current;
  let body = null;
  if (show && entry && info && root) {
    const rect = root.getBoundingClientRect();
    const offY = info.plotRect.top - rect.top;
    const x0 = info.plotRect.left - rect.left;
    const x1 = x0 + info.proj.width;
    const precision = filters?.pricePrecision ?? 2;
    const yOf = (p: number) => {
      const y = info.proj.yOf(p, 'price');
      return y == null || y < 0 || y > info.proj.height ? null : offY + y;
    };
    const a = entry.analysis;
    const bias = BIAS[a.bias];
    const yP = yOf(price);
    const age = ago(entry.createdMs, Date.now());
    body = (
      <svg className="trade-svg">
        {a.keyLevels.map((l, i) => {
          const y = yOf(l.price);
          if (y == null) return null;
          return (
            <g key={i}>
              <line x1={x0} x2={x1} y1={y} y2={y} stroke={COLORS[l.kind]} strokeWidth={1} strokeDasharray="2 5" opacity={0.85} />
              <text x={x0 + 8} y={y - 4} className="trade-label" fill={COLORS[l.kind]}>
                {`AI ${l.kind} ${formatPrice(l.price, precision)}${l.note ? ' · ' + l.note : ''}`}
              </text>
            </g>
          );
        })}
        {yP != null && (
          <g transform={`translate(${x1 - 175}, ${yP})`}>
            {a.bias !== 'neutral' && <polygon points={a.bias === 'bullish' ? '0,-8 -9,8 9,8' : '0,8 -9,-8 9,-8'} transform={`translate(0, ${a.bias === 'bullish' ? -22 : 22})`} fill={bias.color} />}
            {a.bias === 'neutral' && <rect x={-8} y={-30} width={16} height={16} transform="rotate(45 0 -22)" fill={bias.color} opacity={0.8} />}
            <text y={a.bias === 'bearish' ? 44 : -40} textAnchor="middle" fill={bias.color} className="trade-label">
              {`AI opinion: ${bias.label} ${a.confidence}% · ${age}`}
            </text>
          </g>
        )}
      </svg>
    );
  }
  const setPrefs = useAnalyst((s) => s.setPrefs);
  return (
    <>
      <div className="ai-bar-top">
        <button className={`ai-toggle${show ? ' on' : ''}`} onClick={() => setPrefs({ showOnChart: !show })} title="Show / hide the AI analyst's levels and bias arrow on this chart">
          AI{show && entry ? ' ●' : ''}
        </button>
      </div>
      <div ref={rootRef} className="trade-layer">
        {body}
      </div>
    </>
  );
}
