import type { CrackView } from '../types';

const fmt = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

/** How a cracked base is doing: a bar from its lowest price (0) to the base (100), with the numbers under it. */
export function CrackBar({ c }: { c: CrackView }) {
  const done = c.status !== 'active';
  const pct = Math.round(c.recoveryPct);
  return (
    <div className={`crack-bar ${c.status}`}>
      <div className="crack-track" title={`${pct}% of the way from the lowest price back to the base`}>
        <i style={{ width: `${Math.max(2, c.recoveryPct)}%` }} />
        {[50, 80].map((l) => (
          <u key={l} style={{ left: `${l}%` }} />
        ))}
      </div>
      <div className="crack-nums">
        {c.status === 'recovered' ? (
          <span className="up">back at the base</span>
        ) : c.status === 'expired' ? (
          <span className="muted">not back after the tracking time</span>
        ) : (
          <span>
            <b className={c.belowBasePct < 0 ? 'down' : 'up'}>{fmt(c.belowBasePct)}</b> vs base
          </span>
        )}
        <span>
          deepest <b>{fmt(c.depthPct)}</b>
        </span>
        <span>
          <b className={done && c.status === 'recovered' ? 'up' : ''}>{pct}%</b> back
        </span>
      </div>
    </div>
  );
}
