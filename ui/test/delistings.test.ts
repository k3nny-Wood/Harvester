import { describe, expect, it } from 'vitest';
import { dateText, delistingFor, describeDelisting, seenKey, unseenForHoldings } from '../src/delistings';
import type { Delisting } from '../src/types';

const d = (symbol: string, kind: Delisting['kind'], dateMs: number): Delisting => ({ symbol, kind, dateMs, title: 't', url: 'https://x' });
const OCT20 = Date.UTC(2026, 9, 20, 9, 0);
const NOW = Date.UTC(2026, 9, 14, 8, 0);

describe('delisting warnings', () => {
  it('a scheduled futures delisting is a danger with the date, the time and how long is left', () => {
    const t = describeDelisting(d('EPICUSDT', 'scheduled', OCT20), NOW);
    expect(t.severity).toBe('danger');
    expect(t.text).toContain('20 Oct 2026 09:00 UTC');
    expect(t.text).toContain('in 6 days');
    expect(t.short).toBe('Delisting 20 Oct 2026');
  });

  it('under two days left is counted in hours, under an hour in minutes', () => {
    expect(describeDelisting(d('X', 'scheduled', NOW + 5 * 3_600_000), NOW).text).toContain('in 5 h');
    expect(describeDelisting(d('X', 'scheduled', NOW + 20 * 60_000), NOW).text).toContain('in 20 min');
  });

  it('a spot-only announcement is a milder warning that says the contract is not scheduled', () => {
    const t = describeDelisting(d('EPICUSDT', 'spot', Date.UTC(2026, 9, 28)), NOW);
    expect(t.severity).toBe('warn');
    expect(t.text).toContain('SPOT');
    expect(t.text).toContain('28 Oct 2026');
    expect(t.text).toContain('not scheduled yet');
  });

  it('a contract that is settling cannot be traded', () => {
    const t = describeDelisting(d('EPICUSDT', 'settling', NOW - 3_600_000), NOW);
    expect(t.severity).toBe('danger');
    expect(t.text).toContain('cannot be traded');
  });

  it('the futures warning wins over a spot one for the same symbol', () => {
    const list = [d('EPICUSDT', 'spot', 300), d('EPICUSDT', 'scheduled', 500), d('QUICKUSDT', 'spot', 100)];
    expect(delistingFor('EPICUSDT', list)?.kind).toBe('scheduled');
    expect(delistingFor('QUICKUSDT', list)?.kind).toBe('spot');
    expect(delistingFor('BTCUSDT', list)).toBeUndefined();
  });

  it('only warnings for what is held, and not announced before, produce a message', () => {
    const list = [d('EPICUSDT', 'scheduled', 500), d('QUICKUSDT', 'spot', 100), d('ONUSDT', 'scheduled', 700)];
    const held = new Set(['EPICUSDT', 'ONUSDT']);
    const seen = new Set([seenKey(list[2])]);
    const fresh = unseenForHoldings(list, held, seen);
    expect(fresh.map((x) => x.symbol)).toEqual(['EPICUSDT']);
  });

  it('dates are written in UTC', () => {
    expect(dateText(OCT20, true)).toBe('20 Oct 2026 09:00 UTC');
    expect(dateText(OCT20, false)).toBe('20 Oct 2026');
  });
});
