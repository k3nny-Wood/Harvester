import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { parseTimeframeInput, timeframeName } from '../intervals';
import { useApp } from '../store';

export interface TimeframePopup {
  text: string;
  /** an unknown timeframe was asked for */
  bad: boolean;
}

/** Digits wait this long for a unit before the number is taken as minutes. */
const IDLE_MS = 900;

/**
 * Timeframe hotkeys, as on TradingView: with the pointer over the chart, type a number (minutes) and optionally a unit and the chart switches:
 * `5` -> 5m, `1h` -> 1 hour, `4h`, `1d`, `1w`. A unit letter applies at once, Enter applies now, digits alone apply after a short pause,
 * Backspace edits, Esc cancels. While typing, a popup in the middle of the chart shows what was chosen; it goes away when the timeframe changes.
 *
 * It listens in the capture phase and swallows the keys it uses, so the F / D order hotkeys (D is also "day") do not fire in the middle of `1d`.
 */
export function useTimeframeHotkeys(opts: { hovering: MutableRefObject<boolean>; chartId: string; timeframe: string; setTimeframe: (interval: string) => void }) {
  const { hovering, chartId, timeframe, setTimeframe } = opts;
  const [popup, setPopup] = useState<TimeframePopup | null>(null);
  const buffer = useRef('');
  const timer = useRef(0);
  const current = useRef(timeframe);
  current.current = timeframe;

  // a changed timeframe closes the popup
  useEffect(() => {
    buffer.current = '';
    window.clearTimeout(timer.current);
    setPopup(null);
  }, [timeframe]);

  useEffect(() => {
    const clearTimer = () => window.clearTimeout(timer.current);
    const finish = (ms: number) => {
      clearTimer();
      timer.current = window.setTimeout(() => {
        buffer.current = '';
        setPopup(null);
      }, ms);
    };
    const apply = () => {
      clearTimer();
      const typed = buffer.current;
      buffer.current = '';
      const hit = parseTimeframeInput(typed);
      if (!hit) {
        setPopup({ text: `No ${typed} chart`, bad: true });
        finish(1300);
        return;
      }
      setPopup({ text: timeframeName(hit.interval), bad: false });
      if (hit.interval === current.current) {
        finish(700); // nothing changes, so nothing would close the popup
        return;
      }
      setTimeframe(hit.interval);
      finish(4000); // closed by the change itself; this only covers a load that never happens
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (!hovering.current || useApp.getState().activeChartId !== chartId) return;
      const typing = buffer.current.length > 0;
      const k = e.key;
      const swallow = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      if (/^[0-9]$/.test(k)) {
        swallow();
        if (e.repeat) return;
        buffer.current = (buffer.current + k).slice(0, 4);
        setPopup({ text: buffer.current, bad: false });
        clearTimer();
        timer.current = window.setTimeout(apply, IDLE_MS);
        return;
      }
      if (!typing) return;
      if (/^[mhdwMHDW]$/.test(k)) {
        swallow();
        buffer.current += k.toLowerCase();
        setPopup({ text: buffer.current, bad: false });
        apply();
      } else if (k === 'Enter') {
        swallow();
        apply();
      } else if (k === 'Backspace') {
        swallow();
        buffer.current = buffer.current.slice(0, -1);
        clearTimer();
        if (buffer.current) {
          setPopup({ text: buffer.current, bad: false });
          timer.current = window.setTimeout(apply, IDLE_MS);
        } else setPopup(null);
      } else if (k === 'Escape') {
        swallow();
        buffer.current = '';
        clearTimer();
        setPopup(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      clearTimer();
    };
  }, [hovering, chartId, setTimeframe]);

  return popup;
}
