import { useEffect, useState } from 'react';
import { api } from '../api';
import { delistingFor, describeDelisting, useDelistings } from '../delistings';
import { useApp } from '../store';

/** The delisting warning for one symbol, when there is one: a line of text that opens Binance's announcements when clicked. */
export function DelistNote({ symbol, className = '' }: { symbol: string; className?: string }) {
  const list = useDelistings((s) => s.list);
  const toast = useApp((s) => s.toast);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  const d = delistingFor(symbol, list);
  if (!d) return null;
  const t = describeDelisting(d, now);
  return (
    <div className={`delist-note ${t.severity} ${className}`} title="Open the Binance announcement" onClick={() => void api.openUrl(d.url).catch((e) => toast(`${e}`, 'warn'))}>
      ⚠ {t.text}
    </div>
  );
}
