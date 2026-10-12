/**
 * Where to put a pop-up menu that opens at (x, y) inside a box of `boxW` x `boxH`, so that all of it stays inside the box (a menu that
 * reaches past the chart is hidden under the panel below it). It is pushed up / left just enough, never past the top-left corner, and
 * when it is taller than the box it is capped to the box height (the menu then scrolls).
 */
export interface MenuPlacement {
  left: number;
  top: number;
  maxHeight: number;
}

export function fitMenu(x: number, y: number, menuW: number, menuH: number, boxW: number, boxH: number, margin = 4): MenuPlacement {
  const maxHeight = Math.max(80, boxH - 2 * margin);
  const h = Math.min(menuH, maxHeight);
  const left = Math.max(margin, Math.min(x, boxW - menuW - margin));
  const top = Math.max(margin, Math.min(y, boxH - h - margin));
  return { left, top, maxHeight };
}
