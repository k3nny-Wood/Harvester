import { formatPrice } from '../ladderMath';
import { activeChartStore, initialLadder, ladderSide, useActiveChart, type LadderDraft } from '../chartStore';

/** The numbers behind the ladder drawn on the chart: every rung as it would be sent to the exchange. */
export function LadderPanel() {
  const d = useActiveChart((s) => s.ladder) ?? initialLadder;
  const precision = useActiveChart((s) => s.filters?.pricePrecision) ?? 2;
  const qtyPrecision = useActiveChart((s) => s.filters?.quantityPrecision) ?? 3;
  const symbol = useActiveChart((s) => s.symbol) ?? '';
  const patch = (p: Partial<LadderDraft>) => activeChartStore()?.getState().patchLadder(p);
  const reset = () => activeChartStore()?.getState().resetLadder();
  const p = d.preview;

  if (d.phase === 'idle') {
    return (
      <div className="panel pad">
        <h3>Ladder tool</h3>
        <p className="muted">Spread a set of limit orders over a price range.</p>
        <ol className="steps">
          <li>
            Press <kbd>L</kbd> or the button below, then click on the chart where the ladder <b>starts</b>.
          </li>
          <li>
            Click again where it <b>ends</b>. A vertical line marks the range.
          </li>
          <li>Use the slider to choose how many orders; drag the ends to adjust.</li>
        </ol>
        <button className="primary" onClick={() => patch({ phase: 'start' })}>
          Draw a ladder on {symbol}
        </button>
      </div>
    );
  }

  return (
    <div className="panel pad">
      <div className="row">
        <h3>
          {ladderSide(d)} ladder · {symbol}
        </h3>
        <button onClick={reset}>Clear</button>
      </div>
      {d.phase !== 'armed' && <p className="muted">Finish drawing on the chart…</p>}
      {p ? (
        <>
          <div className="ladder-summary wide">
            <div>
              <span>Orders</span>
              <b>{p.rungs.length}</b>
            </div>
            <div>
              <span>Size</span>
              <b>{p.totalQuantity.toFixed(qtyPrecision)}</b>
            </div>
            <div>
              <span>Notional</span>
              <b>{p.totalNotional.toFixed(2)}</b>
            </div>
            <div>
              <span>Avg entry</span>
              <b>{formatPrice(p.averageEntry, precision)}</b>
            </div>
          </div>
          <table className="rungs">
            <thead>
              <tr>
                <th>#</th>
                <th>Price</th>
                <th>Qty</th>
                <th>USDT</th>
              </tr>
            </thead>
            <tbody>
              {p.rungs.map((r) => (
                <tr key={r.index} className={r.valid ? '' : 'bad'} title={r.errors.join('\n')}>
                  <td>{r.index + 1}</td>
                  <td>{formatPrice(r.price, precision)}</td>
                  <td>{r.quantity.toFixed(qtyPrecision)}</td>
                  <td>{r.notional.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <p className="muted">{d.previewError ?? 'Waiting for a range…'}</p>
      )}
    </div>
  );
}
