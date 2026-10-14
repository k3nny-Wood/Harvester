import { useChart } from '../chartStore';
import { DelistNote } from '../components/DelistNote';

/** A banner across the top of the chart when its symbol has a delisting scheduled. */
export function ChartDelistBanner() {
  const symbol = useChart((s) => s.symbol);
  return (
    <div className="delist-banner">
      <DelistNote symbol={symbol} />
    </div>
  );
}
