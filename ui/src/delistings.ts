import { create } from 'zustand';
import { api, inTauri } from './api';
import { useApp } from './store';
import type { Delisting } from './types';

interface DelistStore {
  list: Delisting[];
  set: (list: Delisting[]) => void;
}

/** The futures contracts Binance has scheduled for delisting (or has just delisted), refreshed every few minutes. */
export const useDelistings = create<DelistStore>((s) => ({ list: [], set: (list) => s({ list }) }));

const RANK = { scheduled: 0, settling: 1, spot: 2 } as const;

/** The warning for a symbol: the futures one wins over a spot-only notice. */
export function delistingFor(symbol: string, list: Delisting[]): Delisting | undefined {
  return list.filter((d) => d.symbol === symbol).sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.dateMs - b.dateMs)[0];
}

export interface DelistText {
  /** 'danger': the contract itself is going; 'warn': only the spot market has an announcement */
  severity: 'danger' | 'warn';
  /** one line for a banner */
  text: string;
  /** a few words for a tooltip or a badge */
  short: string;
}

function untilText(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} days`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "20 Oct 2026 09:00 UTC", or just the day for a spot date (which has no time of day). */
export function dateText(ms: number, withTime: boolean): string {
  const d = new Date(ms);
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return withTime ? `${day} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC` : day;
}

export function describeDelisting(d: Delisting, now: number): DelistText {
  if (d.kind === 'scheduled') {
    const left = d.dateMs - now;
    return {
      severity: 'danger',
      text: `${d.symbol} is scheduled to be DELISTED on ${dateText(d.dateMs, true)} (in ${untilText(left)}). Open positions are settled then and the contract stops trading.`,
      short: `Delisting ${dateText(d.dateMs, false)}`,
    };
  }
  if (d.kind === 'settling') {
    return { severity: 'danger', text: `${d.symbol} is being DELISTED: the contract has settled or is settling (${dateText(d.dateMs, true)}). It cannot be traded.`, short: 'Delisted' };
  }
  return {
    severity: 'warn',
    text: `Binance announced the SPOT delisting of ${d.symbol.replace('USDT', '')} on ${dateText(d.dateMs, false)}. The futures contract is not scheduled yet: read the announcement.`,
    short: `Spot delisting ${dateText(d.dateMs, false)}`,
  };
}

/** Warnings already shown as a toast, remembered so a delisting is announced once, not at every start. */
const SEEN_KEY = 'harvester.delistSeen.v1';

export function seenKey(d: Delisting): string {
  return `${d.symbol}:${d.kind}:${d.dateMs}`;
}

function loadSeen(): Set<string> {
  try {
    return new Set(JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/** The warnings for symbols the trader holds a position or open orders in, that have not been announced yet. */
export function unseenForHoldings(list: Delisting[], held: Set<string>, seen: Set<string>): Delisting[] {
  return list.filter((d) => held.has(d.symbol) && !seen.has(seenKey(d)));
}

async function refresh(force: boolean) {
  if (!inTauri) return;
  try {
    const list = await api.delistings(force);
    useDelistings.getState().set(list);
    // a delisting of something you hold is worth a message of its own
    const app = useApp.getState();
    const held = new Set<string>([...(app.account?.positions ?? []).filter((p) => p.amount !== 0).map((p) => p.symbol), ...app.orders.map((o) => o.symbol)]);
    const seen = loadSeen();
    const fresh = unseenForHoldings(list, held, seen);
    for (const d of fresh) {
      app.toast(describeDelisting(d, Date.now()).text, 'warn');
      seen.add(seenKey(d));
    }
    if (fresh.length) {
      try {
        window.localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-200)));
      } catch {
        /* not remembered */
      }
    }
  } catch {
    /* keep the last list */
  }
}

/** Fetch the warnings now and every 10 minutes. */
export function startDelistPoll(): () => void {
  const first = window.setTimeout(() => void refresh(false), 4000); // after the account has loaded, so holdings are known
  const timer = window.setInterval(() => void refresh(false), 10 * 60 * 1000);
  return () => {
    window.clearTimeout(first);
    window.clearInterval(timer);
  };
}
