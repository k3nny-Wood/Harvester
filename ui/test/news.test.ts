import { describe, expect, it } from 'vitest';
import { timeAgo, xSearchUrl } from '../src/panels/NewsPanel';

describe('news panel helpers', () => {
  it('the X link is the cashtag search, newest first', () => {
    expect(xSearchUrl('ON')).toBe('https://x.com/search?q=%24ON&f=live');
    expect(xSearchUrl('1000PEPE')).toContain('%241000PEPE');
  });

  it('ages are written the way a person would say them', () => {
    const now = 1_000_000_000_000;
    expect(timeAgo(0, now)).toBe('');
    expect(timeAgo(now - 30_000, now)).toBe('just now');
    expect(timeAgo(now - 10 * 60_000, now)).toBe('10 min ago');
    expect(timeAgo(now - 5 * 3_600_000, now)).toBe('5 h ago');
    expect(timeAgo(now - 3 * 86_400_000, now)).toBe('3 d ago');
    expect(timeAgo(now + 5000, now)).toBe('just now');
  });
});
