/**
 * A small library of ready-made Pine Script indicators that run through PineTS
 * (https://github.com/LuxAlgo/PineTS) on the Vela chart.
 *
 * Every entry here is executed by `test/pine.test.ts` against a synthetic OHLCV
 * series before the app ships, so nothing in this list is a placeholder.
 */
export interface PineLibraryEntry {
  id: string;
  name: string;
  description: string;
  source: string;
  /** Category used to group the preset dropdown. */
  category?: string;
  /** Attribution for community scripts. */
  sourceUrl?: string;
}

export const PINE_LIBRARY: PineLibraryEntry[] = [
  {
    id: 'ema-cross',
    name: 'EMA Cross',
    description: 'Fast and slow EMAs on the price pane, with crossover and crossunder markers.',
    source: `//@version=5
indicator("EMA Cross", overlay=true)
fastLength = input.int(9, "Fast length", minval=1)
slowLength = input.int(21, "Slow length", minval=2)
fast = ta.ema(close, fastLength)
slow = ta.ema(close, slowLength)
plot(fast, "EMA fast", color.orange, 2)
plot(slow, "EMA slow", color.blue, 2)
plot(ta.crossover(fast, slow) ? low : na, "Buy signal", color.green, 3, plot.style_boxes)
plot(ta.crossunder(fast, slow) ? high : na, "Sell signal", color.red, 3, plot.style_boxes)`,
  },
  {
    id: 'rsi-stoch',
    name: 'RSI + Stochastic',
    description: 'RSI(14) and Stochastic(14,3) in their own pane with the 70/30 bands.',
    source: `//@version=5
indicator("RSI + Stochastic", overlay=false)
rsiLength = input.int(14, "RSI length", minval=2)
stochLength = input.int(14, "Stochastic length", minval=2)
smooth = input.int(3, "Stochastic smoothing", minval=1)
rsi = ta.rsi(close, rsiLength)
k = ta.stoch(close, high, low, stochLength)
d = ta.sma(k, smooth)
plot(rsi, "RSI", color.blue, 2)
plot(k, "Stoch K", color.orange)
plot(d, "Stoch D", color.red)
plot(70, "Overbought", color.gray, 1, plot.style_line)
plot(30, "Oversold", color.gray, 1, plot.style_line)`,
  },
  {
    id: 'macd',
    name: 'MACD',
    description: 'Classic MACD line, signal line and a histogram column in a separate pane.',
    source: `//@version=5
indicator("MACD", overlay=false)
fastLength = input.int(12, "Fast length", minval=1)
slowLength = input.int(26, "Slow length", minval=2)
signalLength = input.int(9, "Signal length", minval=1)
[macdLine, signalLine, hist] = ta.macd(close, fastLength, slowLength, signalLength)
plot(hist, "Histogram", hist >= 0 ? color.green : color.red, 2, plot.style_columns)
plot(macdLine, "MACD", color.blue, 2)
plot(signalLine, "Signal", color.orange, 2)`,
  },
  {
    id: 'bollinger-squeeze',
    name: 'Bollinger Squeeze',
    description: 'Bollinger Bands plus a bar colour that turns yellow when the bands are inside their 20-period low.',
    source: `//@version=5
indicator("Bollinger Squeeze", overlay=true)
length = input.int(20, "Length", minval=2)
mult = input.float(2.0, "Multiplier", minval=0.5, maxval=5.0)
basis = ta.sma(close, length)
dev = mult * ta.stdev(close, length)
upper = basis + dev
lower = basis - dev
plot(upper, "Upper", color.blue)
plot(basis, "Basis", color.gray)
plot(lower, "Lower", color.blue)
bbw = ta.bbw(length, mult)
squeezed = bbw < ta.lowest(bbw, 20)
barcolor(squeezed ? color.yellow : color.gray)`,
  },
  {
    id: 'supertrend',
    name: 'SuperTrend',
    description: 'SuperTrend with the line coloured by direction and the reversal points marked.',
    source: `//@version=5
indicator("SuperTrend", overlay=true)
atrLength = input.int(10, "ATR length", minval=1)
multiplier = input.float(3.0, "Multiplier", minval=0.5, maxval=10.0)
[supertrend, direction] = ta.supertrend(multiplier, atrLength)
plot(supertrend, "SuperTrend", direction < 0 ? color.green : color.red, 2)
plot(direction < 0 ? supertrend : na, "Support", color.green, 1, plot.style_line)
alertcondition(ta.change(direction) != 0, "SuperTrend reversal", "SuperTrend reversed")`,
  },
  {
    id: 'keltner-volume',
    name: 'Keltner + OBV',
    description: 'Keltner channels on the price pane and On-Balance Volume in a second pane.',
    source: `//@version=5
indicator("Keltner + OBV", overlay=true)
length = input.int(20, "EMA length", minval=2)
atrLength = input.int(20, "ATR length", minval=1)
mult = input.float(2.0, "ATR multiplier", minval=0.5, maxval=5.0)
mid = ta.ema(close, length)
band = mult * ta.atr(atrLength)
plot(mid + band, "Keltner upper", color.teal)
plot(mid, "Keltner mid", color.gray)
plot(mid - band, "Keltner lower", color.teal)
plot(ta.obv, "OBV", color.purple, 2, plot.style_area)`,
  },
  {
    id: 'pivot-levels',
    name: 'Pivot Levels',
    description: 'Classic pivot, R1/R2/S1/S2 computed from the previous N bars of the chart timeframe.',
    source: `//@version=5
indicator("Pivot Levels", overlay=true)
period = input.int(288, "Bars per period", minval=2)
prevHigh = ta.highest(high, period)[1]
prevLow = ta.lowest(low, period)[1]
prevClose = close[1]
pivot = (prevHigh + prevLow + prevClose) / 3
plot(pivot, "Pivot", color.white, 1, plot.style_line)
plot(2 * pivot - prevLow, "R1", color.green, 1, plot.style_line)
plot(pivot + (prevHigh - prevLow), "R2", color.green, 1, plot.style_line)
plot(2 * pivot - prevHigh, "S1", color.red, 1, plot.style_line)
plot(pivot - (prevHigh - prevLow), "S2", color.red, 1, plot.style_line)`,
  },
  {
    id: 'momentum-backtest',
    name: 'Momentum Strategy',
    description: 'A strategy() that goes long when the 20 EMA crosses above the 50 EMA and closes on the reverse. Fills are painted on the chart.',
    source: `//@version=5
strategy("EMA Momentum Strategy", overlay=true)
fastLength = input.int(20, "Fast EMA", minval=1)
slowLength = input.int(50, "Slow EMA", minval=2)
fast = ta.ema(close, fastLength)
slow = ta.ema(close, slowLength)
plot(fast, "Fast EMA", color.orange)
plot(slow, "Slow EMA", color.blue)
if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("Long")`,
  },
];

export function findLibraryEntry(id: string): PineLibraryEntry | undefined {
  return PINE_LIBRARY.find((entry) => entry.id === id);
}
