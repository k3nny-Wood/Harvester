/**
 * How the page talks to Harvester's engine. Inside the desktop window it uses Tauri (one `rpc` command and Tauri events); in a browser it
 * talks to `harvester-server` over HTTP (`POST /api/<command>`) and a WebSocket (`/ws`). The rest of the UI cannot tell the difference.
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';

/** True when running inside the Tauri shell. */
export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** True when there is an engine to talk to: the desktop window, or a page served over http(s) by harvester-server. */
export const hasBackend = inTauri || (typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol));

export type Unlisten = () => void;

const TOKEN_KEY = 'harvester.web.token';

export function getToken(): string {
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token.trim());
  } catch {
    /* not remembered */
  }
}

let authNeeded = false;
const authListeners = new Set<(needed: boolean) => void>();

/** Called with true when the server has refused the access token (or none is set yet). */
export function onAuthNeeded(cb: (needed: boolean) => void): Unlisten {
  authListeners.add(cb);
  cb(authNeeded);
  return () => authListeners.delete(cb);
}

function setAuthNeeded(v: boolean) {
  if (authNeeded === v) return;
  authNeeded = v;
  authListeners.forEach((cb) => cb(v));
}

/** Run one engine command. A failure rejects with the message as text, in both modes. */
export async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (inTauri) return tauriInvoke<T>('rpc', { name: cmd, args });
  let res: Response;
  try {
    res = await fetch(`/api/${cmd}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}` }, body: JSON.stringify(args) });
  } catch (e) {
    throw `Cannot reach the Harvester server: ${e}`;
  }
  if (res.status === 401) {
    setAuthNeeded(true);
    throw 'The Harvester server needs its access token.';
  }
  let data: { error?: string } | null = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  if (!res.ok) throw data?.error ?? `The Harvester server answered HTTP ${res.status}.`;
  return data as T;
}

// ---- events

type Handler = (payload: unknown) => void;
const handlers = new Map<string, Set<Handler>>();
let socket: WebSocket | null = null;
let retry = 1000;
let reconnectTimer: number | undefined;

function socketUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}/ws?token=${encodeURIComponent(getToken())}`;
}

function ensureSocket() {
  if (socket || inTauri || handlers.size === 0 || !getToken()) return;
  const s = new WebSocket(socketUrl());
  socket = s;
  s.onopen = () => {
    retry = 1000;
    setAuthNeeded(false);
  };
  s.onmessage = (m) => {
    try {
      const { event, payload } = JSON.parse(String(m.data)) as { event: string; payload: unknown };
      handlers.get(event)?.forEach((h) => h(payload));
    } catch {
      /* not an event */
    }
  };
  s.onclose = () => {
    if (socket === s) socket = null;
    // a refused token closes the socket at once: keep trying slowly, the next command will say if the token is wrong
    window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(ensureSocket, retry);
    retry = Math.min(retry * 2, 15_000);
  };
  s.onerror = () => s.close();
}

/** Listen to an engine event; resolves to the function that stops listening. */
export async function listen<T>(event: string, handler: (payload: T) => void): Promise<Unlisten> {
  if (inTauri) {
    const off = await tauriListen<T>(event, (ev) => handler(ev.payload));
    return () => off();
  }
  let set = handlers.get(event);
  if (!set) handlers.set(event, (set = new Set()));
  const h = handler as Handler;
  set.add(h);
  ensureSocket();
  return () => {
    set!.delete(h);
  };
}
