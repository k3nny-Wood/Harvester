import { createStore, useStore, type StoreApi } from 'zustand';

export interface PineScript {
  id: string;
  name: string;
  source: string;
  enabled: boolean;
}

export type PineStatus = 'pending' | 'running' | 'error';

export interface PineReadout {
  /** Name of the plot as declared in the script. */
  label: string;
  /** Latest value, formatted for display. */
  value: string;
}

export interface PineState {
  scripts: PineScript[];
  status: Record<string, PineStatus | undefined>;
  errors: Record<string, string | undefined>;
  readouts: Record<string, PineReadout[] | undefined>;
  addScript: (script: PineScript) => void;
  removeScript: (id: string) => void;
  updateScript: (id: string, patch: Partial<Pick<PineScript, 'name' | 'source' | 'enabled'>>) => void;
  setStatus: (id: string, status: PineStatus, error?: string) => void;
  setReadout: (id: string, readout: PineReadout[]) => void;
}

export type PineStore = StoreApi<PineState>;

function load(key: string): PineScript[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    return (JSON.parse(raw) as PineScript[]).filter((s) => typeof s?.source === 'string' && typeof s?.name === 'string' && typeof s?.id === 'string');
  } catch {
    return [];
  }
}

/** The Pine scripts of ONE chart tab. They are remembered under `storageKey` (the tab's id), so they survive a restart. */
export function createPineStore(storageKey: string): PineStore {
  const store = createStore<PineState>((set, get) => ({
    scripts: load(storageKey),
    status: {},
    errors: {},
    readouts: {},
    addScript: (script) => {
      const has = get().scripts.some((s) => s.id === script.id);
      set({ scripts: has ? get().scripts.map((s) => (s.id === script.id ? script : s)) : [...get().scripts, script] });
    },
    removeScript: (id) =>
      set({
        scripts: get().scripts.filter((s) => s.id !== id),
        status: { ...get().status, [id]: undefined },
        readouts: { ...get().readouts, [id]: undefined },
      }),
    updateScript: (id, patch) => set({ scripts: get().scripts.map((s) => (s.id === id ? { ...s, ...patch } : s)) }),
    setStatus: (id, status, error) => set({ status: { ...get().status, [id]: status }, errors: { ...get().errors, [id]: error } }),
    setReadout: (id, readout) => set({ readouts: { ...get().readouts, [id]: readout } }),
  }));
  store.subscribe((s, prev) => {
    if (s.scripts === prev.scripts) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(s.scripts));
    } catch {
      /* storage unavailable */
    }
  });
  return store;
}

export function usePineStore<T>(store: PineStore, selector: (s: PineState) => T): T {
  return useStore(store, selector);
}

export function newPineId(): string {
  return Math.random().toString(36).slice(2, 9);
}
