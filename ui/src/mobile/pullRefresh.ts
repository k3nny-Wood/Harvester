import { useEffect, useRef, useState } from 'react';

/** How far (px, as shown) the list has to be pulled down before letting go refreshes. */
export const PULL_TRIGGER = 56;
const MAX_PULL = 96;

/** The pull distance shown for a finger that moved `dy` px: it gets harder the further it goes. */
export function pullDistance(dy: number): number {
  if (dy <= 0) return 0;
  return Math.min(MAX_PULL, dy * 0.5);
}

/**
 * Pull-down-to-refresh for a scrolling element: when the list is at its top and the finger drags down, the list follows (with resistance); letting go
 * past the trigger runs `refresh`. A home-screen web app on a phone has no browser refresh of its own. `enabled` false (the chart tab, where a drag
 * pans the chart) turns it off.
 */
export function usePullRefresh(el: HTMLElement | null, enabled: boolean, refresh: () => Promise<unknown>): { dist: number; refreshing: boolean } {
  const [dist, setDist] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const run = useRef(refresh);
  run.current = refresh;

  useEffect(() => {
    if (!el || !enabled) {
      setDist(0);
      return;
    }
    let startY: number | null = null;
    let startX = 0;
    // the direction of a touch is decided once it has moved a little: a sideways swipe (the filter buttons that scroll across) is never a pull
    let decided = false;
    let pulling = false;
    let current = 0;
    let busy = false;
    const start = (e: TouchEvent) => {
      startY = !busy && e.touches.length === 1 && el.scrollTop <= 0 ? e.touches[0].clientY : null;
      startX = e.touches[0].clientX;
      decided = false;
      pulling = false;
      current = 0;
    };
    const move = (e: TouchEvent) => {
      if (startY == null) return;
      const dy = e.touches[0].clientY - startY;
      if (!decided) {
        const dx = Math.abs(e.touches[0].clientX - startX);
        if (Math.max(dx, Math.abs(dy)) < 8) return; // not moved enough to tell
        decided = true;
        if (dx >= Math.abs(dy)) {
          startY = null; // sideways: leave the touch to whatever scrolls sideways
          return;
        }
      }
      if (dy <= 0 || el.scrollTop > 0) {
        if (pulling) setDist(0);
        pulling = false;
        current = 0;
        return;
      }
      pulling = true;
      if (e.cancelable) e.preventDefault(); // the page itself must not bounce or scroll while it is being pulled
      current = pullDistance(dy);
      setDist(current);
    };
    const end = () => {
      const was = pulling;
      const reached = current >= PULL_TRIGGER;
      startY = null;
      pulling = false;
      current = 0;
      if (!was) return;
      if (!reached) {
        setDist(0);
        return;
      }
      busy = true;
      setRefreshing(true);
      setDist(PULL_TRIGGER);
      // at least a moment on screen, so the refresh is seen even when it is fast
      void Promise.all([run.current().catch(() => undefined), new Promise((r) => window.setTimeout(r, 700))]).finally(() => {
        busy = false;
        setRefreshing(false);
        setDist(0);
      });
    };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    return () => {
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end);
    };
  }, [el, enabled]);

  return { dist, refreshing };
}
