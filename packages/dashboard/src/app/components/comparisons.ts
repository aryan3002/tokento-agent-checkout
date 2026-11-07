// The Comparisons grid: each agent comparison as this store saw it, kept live.
import type { AgentComparisonLine, ComparisonOutcome } from "@tokento/shared";

export const OUTCOME: Record<ComparisonOutcome, { label: string; dot: string }> = {
  won_with_rewards: { label: "Won with rewards", dot: "dot-success" },
  won_on_price: { label: "Won on price", dot: "dot-brand" },
  not_chosen: { label: "Not chosen", dot: "dot-neutral" },
};

/** Comparisons the grid doesn't show yet, newest first (so adding them at the top keeps the order). */
export function unseenLines(shown: Set<string>, fetched: AgentComparisonLine[]): AgentComparisonLine[] {
  return fetched.filter((l) => !shown.has(l.id)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
