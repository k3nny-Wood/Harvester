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
import { intervalToVela } from '../intervals';
import { useApp } from '../store';
import { DRAWING_GROUPS } from './drawingTools';
import { ChartBases } from './ChartBases';
import { ChartFills } from './ChartFills';
import { ChartSmc } from './ChartSmc';
import { ChartTrading } from './ChartTrading';
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
      bars: 400,
      drawings: { toolbar: true, groups: DRAWING_GROUPS },
      volume: true,
      currentPriceLine: true,
    });
    c.data.registerProvider('binance', new HarvesterProvider());
    c.drawings.setStayMode(true);
    c.drawings.setSnapMode('weak');
    pushLayerData(c, 'ticker-watermark', { symbol: initial.current.symbol, enabled: true });
    c.on('market:changed', (p: { symbol: string }) => pushLayerData(c, 'ticker-watermark', { symbol: p.symbol.split(':').pop() ?? p.symbol, enabled: true }));
    setChart(c);
    return () => {
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

  useEffect(() => {
    if (!chart) return;
    void chart.setMarket({ symbol: `binance:${symbol}`, timeframe: intervalToVela(timeframe) });
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
      <ChartTrading chart={chart} host={ref} />
      <LadderOverlay chart={chart} host={ref} />
    </div>
  );
}
