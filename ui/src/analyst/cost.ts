/** List prices in US dollars per million tokens (input, output). A guide: the Anthropic console has the real bill. */
export const PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
};

/** What one call cost, or null for a model with no known price. */
export function costUsd(model: string, usage: { inputTokens: number; outputTokens: number }): number | null {
  const p = PRICES[model];
  return p ? (usage.inputTokens * p.input + usage.outputTokens * p.output) / 1e6 : null;
}

export function formatCost(c: number | null): string {
  if (c == null) return 'n/a';
  return c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`;
}
