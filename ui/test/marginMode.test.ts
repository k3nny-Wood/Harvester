import { describe, expect, it } from 'vitest';
import { marginModeBlock } from '../src/components/MarginModeToggle';

describe('changing the margin mode', () => {
  it('is allowed when the symbol has no position and no orders', () => {
    expect(marginModeBlock('ETHUSDT', [{ symbol: 'BTCUSDT', amount: 1 }], [{ symbol: 'BTCUSDT' }])).toBeNull();
  });

  it('is refused while the symbol has a position (either direction) or open orders', () => {
    expect(marginModeBlock('ETHUSDT', [{ symbol: 'ETHUSDT', amount: 2 }], [])).toContain('open position');
    expect(marginModeBlock('ETHUSDT', [{ symbol: 'ETHUSDT', amount: -2 }], [])).toContain('open position');
    expect(marginModeBlock('ETHUSDT', [], [{ symbol: 'ETHUSDT' }])).toContain('open orders');
  });

  it('a position that is already closed (amount 0) does not block', () => {
    expect(marginModeBlock('ETHUSDT', [{ symbol: 'ETHUSDT', amount: 0 }], [])).toBeNull();
  });
});
