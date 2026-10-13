import { describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE, profileInputs } from '../src/chart/ChartVolumeProfile';

describe('volume profile settings', () => {
  it('turns the chosen length and opacity into the indicator inputs', () => {
    const i = profileInputs({ width: 40, opacity: 50 });
    expect(i.widthPct).toBe(40);
    expect(i.upColor).toBe('rgba(41, 98, 255, 0.5)');
    expect(i.downColor).toBe('rgba(242, 54, 69, 0.5)');
  });

  it('keeps the values inside what the library accepts', () => {
    expect(profileInputs({ width: 500, opacity: 500 }).widthPct).toBe(90);
    expect(profileInputs({ width: 0, opacity: 0 }).widthPct).toBe(5);
    expect(profileInputs({ width: 30, opacity: 0 }).upColor).toContain('0.02');
  });

  it('the default is the quarter-strength look chosen before', () => {
    expect(DEFAULT_PROFILE).toEqual({ width: 30, opacity: 25 });
    expect(profileInputs(DEFAULT_PROFILE).upColor).toBe('rgba(41, 98, 255, 0.25)');
  });
});
