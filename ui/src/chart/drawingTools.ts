import type { DrawingTypeKey } from '@luxalgo/vela';

/** The drawing tools Vela ships with, grouped the way a trader reaches for them. */
export const DRAWING_GROUPS: Array<{ id: string; label: string; tools: DrawingTypeKey[] }> = [
  { id: 'lines', label: 'Lines', tools: ['trendline', 'ray', 'extendedline', 'hline', 'vline', 'crossline', 'trendangle'] },
  { id: 'channels', label: 'Channels', tools: ['parallelchannel', 'disjointchannel', 'regressionchannel', 'flattopbottom', 'pitchfork', 'schiffpitchfork'] },
  { id: 'fibonacci', label: 'Fibonacci', tools: ['fibretracement', 'fibfan', 'fibextension', 'fibchannel', 'fibtimezones', 'fibspeedfan'] },
  { id: 'shapes', label: 'Shapes', tools: ['box', 'ellipse', 'triangle', 'circle', 'rotatedrect', 'polyline', 'freehand', 'highlighter'] },
  { id: 'annotations', label: 'Notes', tools: ['text', 'note', 'pricenote', 'comment', 'pricelabel', 'signpost', 'arrow', 'callout'] },
  { id: 'patterns', label: 'Patterns', tools: ['headshoulders', 'xabcd', 'abcd', 'elliottimpulse', 'elliottcorrection', 'gartley', 'bat', 'butterfly', 'crab', 'shark', 'cypher'] },
  { id: 'studies', label: 'Studies', tools: ['anchoredvwap', 'fixedrangevp', 'datepricerange', 'position', 'magnifier'] },
];
