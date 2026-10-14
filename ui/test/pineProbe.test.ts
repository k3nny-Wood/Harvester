import { afterAll, describe, expect, it } from 'vitest';
import { PineTS } from 'pinets';

/**
 * Which Pine features does our engine (PineTS) run? Chart-pattern scripts from TradingView lean on drawings (lines, labels, boxes, polylines),
 * arrays / maps / matrices, user-defined types with methods, and imported libraries. This probes each of them with a tiny script and prints a
 * table, so we know before porting anything whether such a script could run here. A failing probe is information, not a failing test.
 */
function candles() {
  const bars = [];
  let price = 100;
  for (let i = 0; i < 400; i += 1) {
    const open = price;
    const close = open + Math.sin(i / 11) * 1.2 + Math.cos(i / 5) * 0.4;
    bars.push({ open, high: Math.max(open, close) + 0.5, low: Math.min(open, close) - 0.5, close, volume: 1000 + (i % 17) * 40, openTime: 1700000000000 + i * 900000 });
    price = close;
  }
  return bars;
}

const HEAD = '//@version=6\nindicator("probe", overlay=true)\nplot(close)\n';

const PROBES: Array<[string, string]> = [
  ['plot, ta.sma, ta.rsi', `${HEAD}plot(ta.sma(close, 14))\nplot(ta.rsi(close, 14))`],
  ['ta.pivothigh / ta.pivotlow', `${HEAD}ph = ta.pivothigh(high, 5, 5)\npl = ta.pivotlow(low, 5, 5)\nplot(ph)\nplot(pl)`],
  ['line.new (trendline drawing)', `${HEAD}if barstate.islast\n    line.new(bar_index - 20, low[20], bar_index, high, color = color.blue, width = 2)`],
  ['label.new', `${HEAD}if barstate.islast\n    label.new(bar_index, high, "Flag", style = label.style_label_down, color = color.green)`],
  ['box.new', `${HEAD}if barstate.islast\n    box.new(bar_index - 20, high, bar_index, low, bgcolor = color.new(color.blue, 80))`],
  ['polyline.new + chart.point', `${HEAD}if barstate.islast\n    pts = array.new<chart.point>()\n    pts.push(chart.point.from_index(bar_index - 10, low[10]))\n    pts.push(chart.point.from_index(bar_index, high))\n    polyline.new(pts)`],
  ['var + array.new_float / push / get / size', `${HEAD}var a = array.new_float()\narray.push(a, close)\nplot(array.size(a) > 0 ? array.get(a, 0) : na)`],
  ['array of lines (line[] / array.new<line>)', `${HEAD}var ls = array.new<line>()\nif barstate.islast\n    array.push(ls, line.new(bar_index - 5, low, bar_index, high))\nplot(array.size(ls))`],
  ['map.new<string, float>', `${HEAD}var m = map.new<string, float>()\nm.put("a", close)\nplot(m.get("a"))`],
  ['matrix.new<float>', `${HEAD}var mx = matrix.new<float>(2, 2, 0.0)\nmx.set(0, 0, close)\nplot(mx.get(0, 0))`],
  ['user-defined type (type ... .new())', `${HEAD}type Pt\n    int x\n    float y\n\np = Pt.new(bar_index, close)\nplot(p.y)`],
  ['method on a user-defined type', `${HEAD}type Pt\n    int x\n    float y\n\nmethod shifted(Pt this, float d) =>\n    Pt.new(this.x, this.y + d)\n\np = Pt.new(bar_index, close)\nplot(p.shifted(1.0).y)`],
  ['user-defined function with several returns', `${HEAD}f(x) =>\n    [x + 1, x - 1]\n[u, d] = f(close)\nplot(u)\nplot(d)`],
  ['for loop and while loop', `${HEAD}s = 0.0\nfor i = 0 to 9\n    s += nz(close[i])\nplot(s)`],
  ['math.* and linear regression (ta.linreg)', `${HEAD}plot(ta.linreg(close, 20, 0))\nplot(math.abs(close - open))`],
  ['request.security (another timeframe)', `${HEAD}plot(request.security(syminfo.tickerid, "60", close))`],
  ['import of a library (needs the library source)', `//@version=6\nindicator("probe", overlay=true)\nimport TradingView/ta/7 as tvta\nplot(tvta.ema(close, 10))`],
  ['alert() / alertcondition', `${HEAD}alertcondition(close > open, "up", "up")`],
  ['str.tostring and string concatenation', `${HEAD}s = "p" + str.tostring(close, "#.##")\nplot(str.length(s))`],
  ['switch / ternary / na handling', `${HEAD}x = switch\n    close > open => 1.0\n    => -1.0\nplot(nz(x))`],
];

const report: Array<[string, string]> = [];

describe('Pine engine: features chart-pattern scripts rely on', () => {
  for (const [name, source] of PROBES) {
    it(`probe: ${name}`, async () => {
      let status = 'works';
      try {
        const result = await new PineTS(candles()).run(source);
        const plots = Object.keys(result.plots ?? {}).filter((k) => !k.startsWith('__'));
        if (plots.length === 0) status = 'ran, but produced no plot';
      } catch (e) {
        status = `FAILS: ${String(e instanceof Error ? e.message : e).split('\n')[0].slice(0, 110)}`;
      }
      report.push([name, status]);
      expect(typeof status).toBe('string');
    });
  }
});

afterAll(() => {
  const width = Math.max(...report.map(([n]) => n.length));
  // eslint-disable-next-line no-console
  console.log('\nPINE ENGINE PROBE\n' + report.map(([n, s]) => `${n.padEnd(width)}  ${s}`).join('\n') + '\n');
});
