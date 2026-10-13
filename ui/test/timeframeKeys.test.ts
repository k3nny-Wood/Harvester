import { describe, expect, it } from 'vitest';
import { intervalToVela, minutesOf, parseTimeframeInput, timeframeName, velaToInterval } from '../src/intervals';

describe('timeframe hotkeys', () => {
  it('a bare number is minutes', () => {
    expect(parseTimeframeInput('1')?.interval).toBe('1m');
    expect(parseTimeframeInput('5')?.interval).toBe('5m');
    expect(parseTimeframeInput('15')?.interval).toBe('15m');
    expect(parseTimeframeInput('30')?.interval).toBe('30m');
  });

  it('a unit letter says otherwise, in either case', () => {
    expect(parseTimeframeInput('1h')?.interval).toBe('1h');
    expect(parseTimeframeInput('4H')?.interval).toBe('4h');
    expect(parseTimeframeInput('1d')?.interval).toBe('1d');
    expect(parseTimeframeInput('1D')?.interval).toBe('1d');
    expect(parseTimeframeInput('1w')?.interval).toBe('1w');
    expect(parseTimeframeInput('15m')?.interval).toBe('15m');
  });

  it('minutes that make a bigger candle size reach it, as on TradingView', () => {
    expect(parseTimeframeInput('60')?.interval).toBe('1h');
    expect(parseTimeframeInput('240')?.interval).toBe('4h');
    expect(parseTimeframeInput('120')?.interval).toBe('2h');
    expect(parseTimeframeInput('1440')?.interval).toBe('1d');
    expect(parseTimeframeInput('24h')?.interval).toBe('1d');
  });

  it('sizes Binance does not have give nothing', () => {
    expect(parseTimeframeInput('7')).toBeNull();
    expect(parseTimeframeInput('0')).toBeNull();
    expect(parseTimeframeInput('2d')).toBeNull();
    expect(parseTimeframeInput('')).toBeNull();
    expect(parseTimeframeInput('h')).toBeNull();
  });

  it('every size it can open is known to the chart and the data provider', () => {
    for (const s of ['1', '3', '5', '15', '30', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '1w']) {
      const hit = parseTimeframeInput(s)!;
      expect(hit, s).not.toBeNull();
      expect(velaToInterval(intervalToVela(hit.interval)), s).toBe(hit.interval);
    }
  });

  it('knows the length of an interval and names it for the popup', () => {
    expect(minutesOf('15m')).toBe(15);
    expect(minutesOf('1w')).toBe(10080);
    expect(timeframeName('1m')).toBe('1 minute');
    expect(timeframeName('15m')).toBe('15 minutes');
    expect(timeframeName('1h')).toBe('1 hour');
    expect(timeframeName('1d')).toBe('1 day');
  });
});
