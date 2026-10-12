import { useEffect, useState } from 'react';
import { api } from './api';

/** Mark prices of the given symbols from the live websocket (Binance's own mark price), refreshed four times a second (Binance sends a new mark price once a second). */
export function useLiveMarks(symbols: string[]): Record<string, number> {
  const [marks, setMarks] = useState<Record<string, number>>({});
  const key = symbols.join(',');
  useEffect(() => {
    if (!key) return;
    let stop = false;
    const load = () => void api.markPrices(key.split(',')).then((m) => !stop && setMarks(m)).catch(() => undefined);
    load();
    const t = window.setInterval(load, 250);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [key]);
  return marks;
}
