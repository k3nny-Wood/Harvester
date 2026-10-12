import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Env, Kline, KlineEvent, LadderPreview, LadderSpec, ScannerConfig, ScannerStatus, Signal, SymbolFilters, SymbolQuote } from './types';

/** True when running inside the Tauri shell (false in a plain browser, e.g. `vite` on its own). */
export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const api = {
  environment: () => invoke<Env>('environment'),
  setEnvironment: (env: Env) => invoke<void>('set_environment', { env }),
  listSymbols: () => invoke<SymbolQuote[]>('list_symbols'),
  symbolFilters: (symbol: string) => invoke<SymbolFilters>('symbol_filters', { symbol }),
  klines: (symbol: string, interval: string, limit = 500, start?: number, end?: number) =>
    invoke<Kline[]>('get_klines', { symbol, interval, limit, start: start ?? null, end: end ?? null }),
  subscribeKlines: (symbol: string, interval: string) => invoke<void>('subscribe_klines', { symbol, interval }),
  unsubscribeKlines: (symbol: string, interval: string) => invoke<void>('unsubscribe_klines', { symbol, interval }),
  scannerSignals: () => invoke<Signal[]>('scanner_signals'),
  scannerStatus: () => invoke<ScannerStatus>('scanner_status'),
  scannerConfig: () => invoke<ScannerConfig>('scanner_config'),
  scannerConfigure: (config: ScannerConfig) => invoke<void>('scanner_configure', { config }),
  previewLadder: (spec: LadderSpec, referencePrice: number) => invoke<LadderPreview>('preview_ladder', { spec, referencePrice }),
};

export function onKline(handler: (e: KlineEvent) => void): Promise<UnlistenFn> {
  return listen<KlineEvent>('kline', (ev) => handler(ev.payload));
}

export function onSignals(handler: (s: Signal[]) => void): Promise<UnlistenFn> {
  return listen<Signal[]>('signals', (ev) => handler(ev.payload));
}

export function onSignalNew(handler: (s: Signal) => void): Promise<UnlistenFn> {
  return listen<Signal>('signal-new', (ev) => handler(ev.payload));
}

export function onScannerStatus(handler: (s: ScannerStatus) => void): Promise<UnlistenFn> {
  return listen<ScannerStatus>('scanner-status', (ev) => handler(ev.payload));
}
