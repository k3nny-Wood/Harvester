import { DockviewDefaultTab, type IDockviewPanelHeaderProps } from 'dockview-react';
import { useEffect, useState } from 'react';
import { delistingFor, describeDelisting, useDelistings } from '../delistings';
import { useApp } from '../store';

/** A chart's tab: bold green text while the chart's symbol has an open position or order (also one held on this computer). */
export function ChartTab(props: IDockviewPanelHeaderProps) {
  const [title, setTitle] = useState(props.api.title ?? '');
  useEffect(() => {
    setTitle(props.api.title ?? '');
    const d = props.api.onDidTitleChange((e) => setTitle(e.title));
    return () => d.dispose();
  }, [props.api]);
  const symbol = title.split(' ')[0];
  const delist = useDelistings((s) => delistingFor(symbol, s.list));
  const active = useApp(
    (s) =>
      !!symbol &&
      (s.account?.positions.some((p) => p.symbol === symbol && p.amount !== 0) ||
        s.orders.some((o) => o.symbol === symbol) ||
        s.held.some((h) => h.status === 'held' && h.request.symbol === symbol)),
  );
  return (
    <div className={`chart-tab${active ? ' tab-trading' : ''}`}>
      {delist && (
        <span className={`delist-mark tab-warn ${delist.kind === 'spot' ? 'warn' : 'danger'}`} title={describeDelisting(delist, Date.now()).text}>
          ⚠
        </span>
      )}
      <DockviewDefaultTab {...props} />
    </div>
  );
}
