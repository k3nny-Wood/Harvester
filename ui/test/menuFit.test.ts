import { describe, expect, it } from 'vitest';
import { fitMenu } from '../src/menuFit';

describe('keeping a pop-up menu inside the chart', () => {
  it('leaves a menu that already fits where it opened', () => {
    expect(fitMenu(100, 80, 230, 300, 900, 600)).toMatchObject({ left: 100, top: 80 });
  });

  it('moves a menu opened near the bottom up so its last row stays visible', () => {
    const p = fitMenu(100, 500, 230, 300, 900, 600);
    expect(p.top).toBe(600 - 300 - 4);
    expect(p.top + 300).toBeLessThanOrEqual(600 - 4);
  });

  it('moves a menu opened near the right edge left', () => {
    const p = fitMenu(800, 80, 230, 300, 900, 600);
    expect(p.left).toBe(900 - 230 - 4);
  });

  it('never goes past the top-left corner, and caps a menu taller than the chart (it scrolls)', () => {
    const p = fitMenu(5, 5, 230, 900, 900, 400);
    expect(p.top).toBe(4);
    expect(p.left).toBe(5);
    expect(p.maxHeight).toBe(400 - 8);
    // a menu wider than the chart still starts at the left margin
    expect(fitMenu(300, 10, 1200, 100, 900, 600).left).toBe(4);
  });

  it('a menu opened exactly at the bottom edge still fits after the move', () => {
    const p = fitMenu(100, 600, 230, 250, 900, 600);
    expect(p.top + 250).toBeLessThanOrEqual(600);
  });
});
