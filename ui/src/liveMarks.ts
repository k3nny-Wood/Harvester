import { useEffect, useState } from 'react';
import { api, inTauri } from './api';

/** Mark prices of the given symbols from the live websocket (Binance's own mark price), refreshed four times a second (Binance sends a new mark price once a second). */
export function useLiveMarks(symbols: string[]): Record<string, number> {
  const [marks, setMarks] = useState<Record<string, number>>({});
  const key = symbols.join(',');
  useEffect(() => {
    if (!key) return;
    let stop = false;
    const load = () => void api.markPrices(key.split(',')).then((m) => !stop && setMarks(m)).catch(() => undefined);
    load();
    const t = window.setInterval(load, inTauri ? 250 : 1000); // over the network once a second is plenty (Binance sends a new price once a second)
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [key]);
  return marks;
}
