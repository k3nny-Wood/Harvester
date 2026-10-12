import type { Vela } from '@luxalgo/vela';

/** The renderer's data -> pixel transform. Reached through the renderer wrapper (not public API). */
export interface Projector {
  yOf(price: number, paneId: string): number | null;
  pxToPoint(x: number, y: number, paneId: string): { time: number; price: number };
  width: number;
  height: number;
}

export interface ProjectorInfo {
  proj: Projector;
  plotRect: DOMRect;
}

export function getProjector(chart: Vela): ProjectorInfo | null {
  const inner = (chart.renderer as unknown as { renderer?: { drawingProjector?: () => Projector; plot?: HTMLElement } }).renderer;
  if (!inner?.drawingProjector || !inner.plot) return null;
  try {
    return { proj: inner.drawingProjector(), plotRect: inner.plot.getBoundingClientRect() };
  } catch {
    return null;
  }
}
