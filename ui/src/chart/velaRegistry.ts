import type { Vela } from '@luxalgo/vela';

/** The chart library instance of every open chart tab, by tab id (the analyst takes a screenshot of one). */
export const velaRegistry = new Map<string, Vela>();
