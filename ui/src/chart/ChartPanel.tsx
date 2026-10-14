import { useEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { Vela } from '@luxalgo/vela';
import { api, onKline } from '../api';
import { PinePanel } from '../components/PinePanel';
import { PinePicker } from '../components/PinePicker';
import { createPineBridge } from '../pine/chartPine';
import { createPineStore, usePineStore } from '../pine/pineStore';
import { ChartContext, chartRegistry, createChartStore, useChart, useChartId, usePine, type ChartStore } from '../chartStore';
import { getDock } from '../dock';
import { intervalMs, intervalToVela } from '../intervals';
import { deeperTarget, START_BARS } from './history';
import { useTimeframeHotkeys } from './useTimeframeHotkeys';
import { useApp } from '../store';
import { DRAWING_GROUPS } from './drawingTools';
import { ChartBases } from './ChartBases';
import { ChartFills } from './ChartFills';
import { ChartSmc } from './ChartSmc';
import { ChartDelistBanner } from './ChartDelistBanner';
import { ChartPriceLine } from './ChartPriceLine';
import { ChartVolumeProfile } from './ChartVolumeProfile';
import { ChartTrading } from './ChartTrading';
import { QuickOrder } from './QuickOrder';
import { ChartAnalysis } from './ChartAnalysis';
import { velaRegistry } from './velaRegistry';
import { LadderOverlay } from './LadderOverlay';
import { pushLayerData } from './projector';
import { HarvesterProvider } from './provider';
import { registerTickerWatermarkLayer } from './tickerWatermark';

let watermarkRegistered = false;

interface ChartParams {
  symbol?: string;
  timeframe?: string;
}

/** One chart tab: its own store (symbol, timeframe, ladder draft), its own Vela instance. */
export function ChartPanel(props: IDockviewPanelProps<ChartParams>) {
  const id = props.api.id;
  const [store] = useState<ChartStore>(() => createChartStore(props.params?.symbol ?? 'BTCUSDT', props.params?.timeframe ?? '15m'));
  const [pine] = useState(() => createPineStore(`harvester.pine.v1.${id}`));
  const setActive = useApp((s) => s.setActiveChart);

  useEffect(() => {
    chartRegistry.set(id, store);
    if (props.api.isActive || !useApp.getState().activeChartId) setActive(id);
    const sub = props.api.onDidActiveChange((e) => e.isActive && setActive(id));
    // keep the tab title and the saved layout in step with what the chart shows
    const unsub = store.subscribe((s, prev) => {
      if (s.symbol !== prev.symbol || s.timeframe !== prev.timeframe) {
        props.api.setTitle(`${s.symbol} ${s.timeframe}`);
        try {
          getDock()?.getPanel(id)?.update({ params: { symbol: s.symbol, timeframe: s.timeframe } });
        } catch {
          /* the title is what matters */
        }
      }
    });
    props.api.setRenderer('always');
    return () => {
      sub.dispose();
      unsub();
      chartRegistry.delete(id);
      if (useApp.getState().activeChartId === id) setActive([...chartRegistry.keys()][0] ?? '');
    };
  }, [id, store, props.api, setActive]);

  return (
    <ChartContext.Provider value={{ id, store, pine }}>
      <ChartBody />
    </ChartContext.Provider>
  );
}

function ChartBody() {
  const ref = useRef<HTMLDivElement>(null);
  const [chart, setChart] = useState<Vela | null>(null);
  const symbol = useChart((s) => s.symbol);
  const timeframe = useChart((s) => s.timeframe);
  const setFilters = useChart((s) => s.setFilters);
  const setMarkPrice = useChart((s) => s.setMarkPrice);
  const initial = useRef({ symbol, timeframe });
  const chartId = useChartId();
  const pine = usePine();
  const pineCount = usePineStore(pine, (s) => s.scripts.length);
  const [pineOpen, setPineOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const hovering = useRef(false);
  const setTimeframe = useChart((s) => s.setTimeframe);
  const tfPopup = useTimeframeHotkeys({ hovering, chartId, timeframe, setTimeframe });

  // One Vela instance for the tab's lifetime; the market is switched in place.
  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    if (!watermarkRegistered) {
      registerTickerWatermarkLayer(); // before the first chart exists
      watermarkRegistered = true;
    }
    const c = new Vela(container, {
      symbol: `binance:${initial.current.symbol}`,
      timeframe: intervalToVela(initial.current.timeframe),
      live: true,
      theme: 'dark',
      bars: START_BARS,
      drawings: { toolbar: true, groups: DRAWING_GROUPS },
      volume: true,
      currentPriceLine: false, // drawn by ChartPriceLine instead (white, pulsing)
      // every chart tab owns a renderer, and a browser only allows about 16 WebGL contexts at once: beyond that the candles of the extra charts
      // never appear (a blank, white chart). The 2D canvas has no such limit.
      nativeBackend: 'canvas2d',
    });
    c.data.registerProvider('binance', new HarvesterProvider());
    c.drawings.setStayMode(true);
    c.drawings.setSnapMode('weak');
    pushLayerData(c, 'ticker-watermark', { symbol: initial.current.symbol, enabled: true });
    c.on('market:changed', (p: { symbol: string }) => pushLayerData(c, 'ticker-watermark', { symbol: p.symbol.split(':').pop() ?? p.symbol, enabled: true }));
    setChart(c);
    velaRegistry.set(chartId, c);
    return () => {
      velaRegistry.delete(chartId);
      setChart(null);
      c.destroy();
    };
  }, []);

  // Pine scripts of this tab run on this chart's engine; the bridge keeps the chart in step with the tab's Pine store.
  useEffect(() => {
    if (!chart) return;
    const bridge = createPineBridge(chart, pine);
    bridge.sync(pine.getState().scripts);
    const unsub = pine.subscribe((s, prev) => {
      if (s.scripts !== prev.scripts) bridge.sync(s.scripts);
    });
    return () => {
      unsub();
      bridge.dispose();
    };
  }, [chart, pine]);

  // `/` opens the quick picker while the pointer is over the focused chart.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      if (e.key !== '/' || !hovering.current || useApp.getState().activeChartId !== chartId) return;
      e.preventDefault();
      setPineOpen(false);
      setPickerOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chartId]);

  // A trendline the user draws starts solid and blue (the library's default is a faded dotted line). Only drawings placed with the tool:
  // the app's own lines (bases, zones) are added from code, without a placement draft before them.
  useEffect(() => {
    if (!chart) return;
    let lastDraft = 0;
    const draft = chart.on('drawing:draft', (e: { doc: unknown }) => {
      if (e.doc) lastDraft = Date.now();
    });
    const created = chart.on('drawing:created', (e: { id: string }) => {
      if (Date.now() - lastDraft > 3000) return;
      const d = chart.drawings.all().find((x) => x.id === e.id);
      if (!d || d.type !== 'trendline') return;
      chart.drawings.update(e.id, { style: { ...d.style, lineColor: '#2962ff', lineWidth: Math.max(2, d.style.lineWidth || 2), lineStyle: 'solid' } });
    });
    return () => {
      [draft, created].forEach((o) => typeof o === 'function' && o());
    };
  }, [chart]);

  // Older candles on demand: Vela holds a fixed depth, so when panning or zooming out reaches the oldest bar the chart is
  // reloaded deeper (the view stays where it is) until the exchange has nothing older.
  const depth = useRef({ oldest: 0, loaded: START_BARS, genesis: false, loading: false });
  const timeframeRef = useRef(timeframe);
  timeframeRef.current = timeframe;
  useEffect(() => {
    if (!chart) return;
    const d = depth.current;
    const done = chart.on('history:complete', (e: { reason: string; oldestTime: number; barsLoaded: number }) => {
      d.oldest = e.oldestTime;
      d.loaded = e.barsLoaded;
      d.genesis = e.reason === 'genesis';
      d.loading = false;
    });
    const moved = chart.on('viewport:changed', (v: { from: number; to: number }) => {
      if (d.loading || d.genesis) return;
      const target = deeperTarget(v, d.oldest, d.loaded, intervalMs(timeframeRef.current), Date.now());
      if (target == null) return;
      d.loading = true;
      window.setTimeout(() => (d.loading = false), 30_000); // never stay stuck if a load never reports back
      void chart.setMarket({ bars: target, visibleRange: { from: v.from, to: v.to } }).catch(() => (d.loading = false));
    });
    return () => {
      [done, moved].forEach((o) => typeof o === 'function' && o());
    };
  }, [chart]);

  useEffect(() => {
    if (!chart) return;
    depth.current = { oldest: 0, loaded: START_BARS, genesis: false, loading: false };
    void chart.setMarket({ symbol: `binance:${symbol}`, timeframe: intervalToVela(timeframe), bars: START_BARS });
    pushLayerData(chart, 'ticker-watermark', { symbol, enabled: true });
  }, [chart, symbol, timeframe]);

  // Trading constraints of the symbol on screen (tick, step, minimum notional...).
  useEffect(() => {
    let alive = true;
    api
      .symbolFilters(symbol)
      .then((f) => alive && setFilters(f))
      .catch(() => alive && setFilters(null));
    return () => {
      alive = false;
    };
  }, [symbol, setFilters]);

  // Last price for the symbol, from the same kline events that feed the chart.
  useEffect(() => {
    let off: (() => void) | null = null;
    let stopped = false;
    void onKline((e) => {
      if (e.symbol === symbol) setMarkPrice(e.bar.close);
    }).then((u) => {
      if (stopped) u();
      else off = u;
    });
    return () => {
      stopped = true;
      off?.();
    };
  }, [symbol, setMarkPrice]);

  return (
    <div className="chart-shell" onPointerEnter={() => (hovering.current = true)} onPointerLeave={() => (hovering.current = false)}>
      <div ref={ref} className="chart-host" />
      <button
        className={`pine-btn${pineCount > 0 ? ' on' : ''}`}
        title="Pine Script indicators for this chart (press / over the chart for the quick picker)"
        onClick={() => {
          setPickerOpen(false);
          setPineOpen((v) => !v);
        }}
      >
        Pine{pineCount > 0 ? ` (${pineCount})` : ''}
      </button>
      <PinePanel open={pineOpen} onClose={() => setPineOpen(false)} />
      <PinePicker open={pickerOpen} onClose={() => setPickerOpen(false)} />
      <ChartFills chart={chart} />
      <ChartBases chart={chart} />
      <ChartSmc chart={chart} />
      <ChartAnalysis chart={chart} />
      <ChartDelistBanner />
      {tfPopup && <div className={`tf-popup${tfPopup.bad ? ' bad' : ''}`}>{tfPopup.text}</div>}
      <ChartPriceLine chart={chart} />
      <ChartVolumeProfile chart={chart} />
      <ChartTrading chart={chart} host={ref} />
      <LadderOverlay chart={chart} host={ref} />
      <QuickOrder chart={chart} host={ref} />
    </div>
  );
}
