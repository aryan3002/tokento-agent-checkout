import { describe, expect, it } from "vitest";
import type { AgentComparisonStats } from "@tokento/shared";
import { comparisonSummary } from "../src/app/components/agent-comparisons";

function stats(wonWithRewards: number, wonOnPrice: number, notChosen: number): AgentComparisonStats {
  const recommended = wonWithRewards + wonOnPrice;
  return { comparisons: recommended + notChosen, recommended, wonWithRewards, wonOnPrice, notChosen, lastComparedAt: "2026-11-07T16:00:00.000Z" };
}

describe("comparisonSummary", () => {
  it("explains the card before any agent has compared the store", () => {
    const s = comparisonSummary(stats(0, 0, 0));
    expect(s.empty).toBe(true);
    expect(s.segments.every((seg) => seg.percent === 0)).toBe(true);
  });

  it("says how often the store was picked and how often its rewards decided it", () => {
    const s = comparisonSummary(stats(2, 1, 1));
    expect(s.empty).toBe(false);
    expect(s.headline).toBe("Recommended in 3 of 4 agent comparisons");
    expect(s.detail).toBe("In 2 of them, your rewards beat a lower sticker price.");
    expect(s.segments.map((seg) => [seg.key, seg.count, seg.percent])).toEqual([
      ["won_with_rewards", 2, 50],
      ["won_on_price", 1, 25],
      ["not_chosen", 1, 25],
    ]);
  });

  it("uses the singular for a single comparison", () => {
    expect(comparisonSummary(stats(1, 0, 0)).headline).toBe("Recommended in 1 of 1 agent comparison");
  });

  it("credits the rewards for every win when they decided all of them", () => {
    expect(comparisonSummary(stats(1, 0, 2)).detail).toBe("Your rewards beat a lower sticker price to win it.");
    expect(comparisonSummary(stats(3, 0, 2)).detail).toBe("Every time you were picked, your rewards beat a lower sticker price.");
  });

  it("says when the store simply had the lowest price", () => {
    expect(comparisonSummary(stats(0, 2, 1)).detail).toBe("You had the lowest sticker price each time you were picked.");
  });

  it("says another store won when this one was never picked", () => {
    const s = comparisonSummary(stats(0, 0, 3));
    expect(s.headline).toBe("Recommended in 0 of 3 agent comparisons");
    expect(s.detail).toBe("Another store was the better deal so far. Agents count your rewards in every comparison.");
  });

  it("keeps bar widths that add up to 100 when the split isn't even", () => {
    const widths = comparisonSummary(stats(1, 1, 1)).segments.map((seg) => seg.percent);
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
  });
});
