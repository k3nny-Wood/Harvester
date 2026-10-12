/** The short name shown in the box at the right end of an order's line on the chart. */
export function orderTag(o: { side: string; type: string; reduceOnly: boolean }): string {
  const t = o.type.toUpperCase();
  if (o.reduceOnly && t.startsWith('TAKE_PROFIT')) return 'TAKE PROFIT';
  if (o.reduceOnly && t.startsWith('STOP')) return 'STOP LOSS';
  if (t.startsWith('TAKE_PROFIT')) return `${o.side} TP`;
  if (t === 'STOP' || t === 'STOP_MARKET') return `${o.side} STOP${t === 'STOP' ? '-LIMIT' : ''}`;
  if (t === 'MARKET') return `${o.side} MARKET`;
  return `${o.side} LIMIT`;
}
