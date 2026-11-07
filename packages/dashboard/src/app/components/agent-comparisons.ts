// "Why agents pick you": the store's agent comparison counts, in words anyone can
// follow, plus the widths of a three-part bar (won with rewards / on price / not chosen).
import type { AgentComparisonStats, ComparisonOutcome } from "@tokento/shared";

export interface ComparisonSegment {
  key: ComparisonOutcome;
  label: string;
  count: number;
  /** Share of all comparisons, 0–100, for the bar. */
  percent: number;
}

export interface ComparisonSummary {
  empty: boolean;
  headline: string;
  detail: string;
  segments: ComparisonSegment[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function detailFor(s: AgentComparisonStats): string {
  if (s.recommended === 0) return "Another store was the better deal so far. Agents count your rewards in every comparison.";
  if (s.wonWithRewards === 0) return "You had the lowest sticker price each time you were picked.";
  if (s.wonWithRewards === s.recommended) {
    return s.recommended === 1
      ? "Your rewards beat a lower sticker price to win it."
      : "Every time you were picked, your rewards beat a lower sticker price.";
  }
  return `In ${s.wonWithRewards} of them, your rewards beat a lower sticker price.`;
}

export function comparisonSummary(s: AgentComparisonStats): ComparisonSummary {
  const share = (count: number) => (s.comparisons > 0 ? (count / s.comparisons) * 100 : 0);
  const segments: ComparisonSegment[] = [
    { key: "won_with_rewards", label: "Won with rewards", count: s.wonWithRewards, percent: share(s.wonWithRewards) },
    { key: "won_on_price", label: "Won on price", count: s.wonOnPrice, percent: share(s.wonOnPrice) },
    { key: "not_chosen", label: "Not chosen", count: s.notChosen, percent: share(s.notChosen) },
  ];
  if (s.comparisons === 0) {
    return {
      empty: true,
      headline: "No agent comparisons yet",
      detail: "When a shopper's agent compares stores, you'll see how often it picks you, and when your rewards were the reason.",
      segments,
    };
  }
  return {
    empty: false,
    headline: `Recommended in ${s.recommended} of ${plural(s.comparisons, "agent comparison")}`,
    detail: detailFor(s),
    segments,
  };
}
