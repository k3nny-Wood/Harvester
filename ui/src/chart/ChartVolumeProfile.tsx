import { useEffect, useRef, useState } from 'react';
import type { IndicatorHandle, Vela } from '@luxalgo/vela';

const KEY = 'harvester.volumeProfile.v1';

function loadOn(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Visible-range volume profile: how much traded at each price level of what is on screen (horizontal bars at the side of the chart, the
 * point of control and the value area marked). It is the chart library's own `vpvr` indicator, so it follows panning and zooming by itself.
 * One switch per chart, remembered between runs.
 */
export function ChartVolumeProfile({ chart }: { chart: Vela | null }) {
  const [on, setOn] = useState(loadOn);
  const handle = useRef<IndicatorHandle | null>(null);

  useEffect(() => {
    if (!chart) return;
    if (on) {
      try {
        handle.current = chart.addNativeIndicator('vpvr');
      } catch {
        handle.current = null;
      }
    }
    return () => {
      try {
        handle.current?.remove();
      } catch {
        /* the chart is already gone */
      }
      handle.current = null;
    };
  }, [chart, on]);

  const toggle = () => {
    const next = !on;
    setOn(next);
    try {
      window.localStorage.setItem(KEY, next ? '1' : '0');
    } catch {
      /* not remembered */
    }
  };

  return (
    <div className="vp-bar">
      <button className={`smc-btn${on ? ' on' : ''}`} onClick={toggle} title="Volume profile of the visible range: volume traded at each price, with the point of control and value area">
        VP
      </button>
    </div>
  );
}
