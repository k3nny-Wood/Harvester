import { openChart } from './dock';
import { useApp } from './store';
import type { Signal, TradePlan } from './types';

/** Show an ML signal's trade plan on its chart (opening or switching to the chart tab). */
export function showPlan(s: Signal): void {
  if (!s.plan) return;
  useApp.getState().setPlan(s.symbol, { signalId: s.id, timeframe: s.timeframe, plan: s.plan, probability: s.probability ?? 0, riskUsd: 25, entryType: 'market' });
  openChart(s.symbol, s.timeframe);
}

/** The plan with a new stop and / or target; the percentages and R:R follow. */
export function withLevels(p: TradePlan, stop: number, target: number): TradePlan {
  const risk = (Math.abs(p.entry - stop) / p.entry) * 100;
  const reward = (Math.abs(target - p.entry) / p.entry) * 100;
  return { ...p, stop, target, riskPct: risk, rewardPct: reward, rr: risk > 0 ? reward / risk : 0 };
}
