import { useEffect } from 'react';
import { alertForSignal } from './alerts';
import { api, hasBackend, onCrackProgress, onCracks, onScannerStatus, onSignalNew, onSignals } from './api';
import { useApp } from './store';

/** Keep the app store in step with what the Rust scanner reports. */
export function useScannerEvents() {
  useEffect(() => {
    if (!hasBackend) return;
    const { setSignals, setCracks, setScanner, setScannerConfig, toast } = useApp.getState();
    void api.scannerCracks().then(setCracks).catch(() => undefined);
    void api.scannerSignals().then(setSignals).catch(() => undefined);
    void api.scannerStatus().then(setScanner).catch(() => undefined);
    void api.scannerConfig().then(setScannerConfig).catch(() => undefined);
    const offs: Array<() => void> = [];
    let stopped = false;
    const keep = (p: Promise<() => void>) => void p.then((u) => (stopped ? u() : offs.push(u)));
    keep(onSignals(setSignals));
    keep(onScannerStatus(setScanner));
    keep(onCracks(setCracks));
    keep(
      onCrackProgress((p) => {
        const name = p.symbol.replace('USDT', '');
        toast(p.level >= 100 ? `${name} is back at its base` : `${name} is ${p.level}% of the way back to its base`, 'signal');
      }),
    );
    keep(
      onSignalNew((s) => {
        alertForSignal(s);
        toast(`CRACK ${s.symbol} ${s.timeframe} · score ${s.score}`, 'signal');
      }),
    );
    // the status carries the config's timeframe; refresh the full config when the scanner restarts
    keep(onScannerStatus(() => void api.scannerConfig().then(setScannerConfig).catch(() => undefined)));
    return () => {
      stopped = true;
      offs.forEach((o) => o());
    };
  }, []);
}
