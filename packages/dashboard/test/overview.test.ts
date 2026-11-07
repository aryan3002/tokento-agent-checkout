import { describe, expect, it } from "vitest";
import { overviewStats } from "../src/app/components/overview";

describe("overviewStats", () => {
  // GET /merchants/me/tokens returns Prisma Decimals as JSON strings ("5"); adding
  // them with + concatenated text and the card read "$055555555" for eight $5 tokens.
  it("adds denominations sent as strings as money, not text", () => {
    const tokens = [
      { status: "ACTIVE", denomination: "5" },
      { status: "REDEEMED", denomination: "5" },
      { status: "ACTIVE", denomination: "12.50" },
    ];
    expect(overviewStats(tokens, [{}, {}])).toEqual({
      tokensIssued: 3,
      activeTokens: 2,
      redemptions: 2,
      totalValue: 22.5,
    });
  });

  it("adds in whole cents so totals are exact", () => {
    const tokens = [0.1, 0.2, 0.7].map((denomination) => ({ status: "ACTIVE", denomination }));
    expect(overviewStats(tokens, []).totalValue).toBe(1);
  });

  it("is zero with no tokens", () => {
    expect(overviewStats([], []).totalValue).toBe(0);
  });
});
