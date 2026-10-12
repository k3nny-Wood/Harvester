import type { Signal, SignalKind } from './types';

/** Sound alerts for new signals. Settings are per user and remembered between runs. */
export interface AlertSettings {
  sound: boolean;
  /** only signals scoring at least this much make a sound */
  minScore: number;
  kinds: Record<SignalKind, boolean>;
  /** 0..1 */
  volume: number;
}

const KEY = 'harvester.alerts.v1';
const DEFAULTS: AlertSettings = { sound: true, minScore: 60, kinds: { ml: true, crack: true, drop: false, near: false }, volume: 0.5 };

export function loadAlerts(): AlertSettings {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<AlertSettings>;
      return { ...DEFAULTS, ...p, kinds: { ...DEFAULTS.kinds, ...(p.kinds ?? {}) } };
    }
  } catch {
    /* storage unavailable: use the defaults */
  }
  return { ...DEFAULTS, kinds: { ...DEFAULTS.kinds } };
}

export function saveAlerts(s: AlertSettings): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/** Whether a signal should make a sound under these settings. */
export function shouldAlert(s: Signal, a: AlertSettings): boolean {
  return a.sound && a.kinds[s.kind] && s.score >= a.minScore;
}

/** A short two-note chime: rising for a long / crack, falling for a short, a single note for the rest. */
export function chimeNotes(s: Signal): number[] {
  if (s.kind === 'ml') return s.side === 'SELL' ? [660, 440] : [440, 660];
  if (s.kind === 'crack') return [523, 784];
  return [587];
}

let ctx: AudioContext | null = null;

export function playChime(notes: number[], volume: number): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const now = ctx.currentTime;
    notes.forEach((hz, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      const t0 = now + i * 0.16;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume * 0.3), t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(t0);
      osc.stop(t0 + 0.25);
    });
  } catch {
    /* no audio device: the toast still shows */
  }
}

export const alertSettings = { current: loadAlerts() };

export function updateAlerts(patch: Partial<AlertSettings>): AlertSettings {
  alertSettings.current = { ...alertSettings.current, ...patch };
  saveAlerts(alertSettings.current);
  return alertSettings.current;
}

/** Called for every new signal. */
export function alertForSignal(s: Signal): void {
  if (shouldAlert(s, alertSettings.current)) playChime(chimeNotes(s), alertSettings.current.volume);
}
