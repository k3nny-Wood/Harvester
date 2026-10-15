import { create } from 'zustand';

export type Tab = 'positions' | 'chart' | 'orders' | 'scanner';
export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;

const KEY = 'harvester.mobile.v1';

interface Remembered {
  tab: Tab;
  symbol: string;
  timeframe: string;
}

function load(): Remembered {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as Partial<Remembered> | null;
    if (v) {
      return {
        tab: (['positions', 'chart', 'orders', 'scanner'] as string[]).includes(v.tab ?? '') ? (v.tab as Tab) : 'positions',
        symbol: typeof v.symbol === 'string' && v.symbol ? v.symbol : 'BTCUSDT',
        timeframe: (TIMEFRAMES as readonly string[]).includes(v.timeframe ?? '') ? (v.timeframe as string) : '15m',
      };
    }
  } catch {
    /* defaults */
  }
  return { tab: 'positions', symbol: 'BTCUSDT', timeframe: '15m' };
}

interface MobileState extends Remembered {
  setTab: (t: Tab) => void;
  /** show a symbol's chart */
  openChart: (symbol: string) => void;
  setTimeframe: (tf: string) => void;
}

export const useMobile = create<MobileState>((set, get) => {
  const keep = (patch: Partial<Remembered>) => {
    const next = { tab: get().tab, symbol: get().symbol, timeframe: get().timeframe, ...patch };
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* not remembered */
    }
    set(patch);
  };
  return {
    ...load(),
    setTab: (tab) => keep({ tab }),
    openChart: (symbol) => keep({ symbol, tab: 'chart' }),
    setTimeframe: (timeframe) => keep({ timeframe }),
  };
});

/** Whether to show the phone layout: a narrow screen, unless the other view was chosen (`?mobile=1`, `?desktop=1`, or remembered). */
export function wantsMobile(): boolean {
  if (typeof window === 'undefined') return false;
  if ('__TAURI_INTERNALS__' in window) return false;
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get('mobile') === '1') {
      window.localStorage.setItem('harvester.view', 'mobile');
    } else if (q.get('desktop') === '1') {
      window.localStorage.setItem('harvester.view', 'desktop');
    }
    const chosen = window.localStorage.getItem('harvester.view');
    if (chosen === 'mobile') return true;
    if (chosen === 'desktop') return false;
  } catch {
    /* no remembered choice */
  }
  return window.matchMedia('(max-width: 820px)').matches;
}

/** Remember the other view and reload into it. */
export function switchView(view: 'mobile' | 'desktop'): void {
  try {
    window.localStorage.setItem('harvester.view', view);
  } catch {
    /* ignore */
  }
  window.location.href = window.location.pathname;
}
