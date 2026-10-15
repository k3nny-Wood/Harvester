import { useCallback, useRef } from 'react';

/**
 * Lets a mouse drag a scrolling list up and down like a finger does. Touch screens already scroll natively, so only the mouse is handled
 * (a desktop browser narrowed to the phone layout, or a phone emulator with a mouse). A drag that moved the list does not count as a click on the
 * row it ended on. Use the result as the `ref` of the scrolling element.
 */
const handled = new WeakSet<Event>();

export function useDragScroll(): (el: HTMLElement | null) => void {
  const cleanup = useRef<(() => void) | null>(null);
  return useCallback((el: HTMLElement | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!el) return;
    let drag: { y: number; top: number; id: number; moved: boolean } | null = null;
    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      // the innermost list that can scroll takes the drag: an outer list (the page) leaves it alone
      if (handled.has(e) || el.scrollHeight <= el.clientHeight + 1) return;
      handled.add(e);
      drag = { y: e.clientY, top: el.scrollTop, id: e.pointerId, moved: false };
    };
    const move = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dy) > 5) {
        drag.moved = true;
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* the drag still works while the pointer stays over the list */
        }
      }
      if (drag.moved) el.scrollTop = drag.top - dy;
    };
    const end = () => {
      if (drag?.moved) {
        // the click that follows the drag must not press a row
        const swallow = (ev: Event) => ev.stopPropagation();
        el.addEventListener('click', swallow, { capture: true, once: true });
        window.setTimeout(() => el.removeEventListener('click', swallow, { capture: true }), 0);
      }
      drag = null;
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    cleanup.current = () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
    };
  }, []);
}
