import { describe, expect, it } from "vitest";
import { UsageGuard, costOf, readGuardLimits, trimHistory, type GuardLimits } from "../src/lib/agent/usage-guard";

const PRICES = { input: 5, cachedInput: 0.5, output: 30 };
const limits = (over: Partial<GuardLimits> = {}): GuardLimits => ({ dailyBudgetUsd: 1, turnBudgetUsd: 0.2, turnsPerHour: 3, prices: PRICES, ...over });
const usage = (input: number, cached: number, output: number) => ({ input_tokens: input, input_tokens_details: { cached_tokens: cached }, output_tokens: output });

function clock(start = Date.UTC(2026, 10, 7, 12)) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("costOf", () => {
  it("prices uncached input, cached input and output separately", () => {
    // 6k uncached × $5 + 4k cached × $0.50 + 2k output × $30, per million
    expect(costOf(usage(10_000, 4_000, 2_000), PRICES)).toBeCloseTo(0.092, 6);
  });
});

describe("UsageGuard", () => {
  it("refuses new requests once the day's spend reaches the daily budget, and resets the next UTC day", () => {
    const c = clock();
    const guard = new UsageGuard(limits({ turnsPerHour: 100, turnBudgetUsd: 5 }), c.now);
    expect(guard.admit("maya")).toEqual({ ok: true });
    guard.meter()(usage(0, 0, 40_000)); // $1.20

    expect(guard.admit("someone-else")).toMatchObject({ ok: false, message: expect.stringContaining("today's usage limit") });
    c.advance(24 * 3600_000);
    expect(guard.admit("maya")).toEqual({ ok: true });
  });

  it("limits each shopper to a number of requests per hour without affecting others", () => {
    const c = clock();
    const guard = new UsageGuard(limits(), c.now);
    for (let i = 0; i < 3; i++) expect(guard.admit("maya")).toEqual({ ok: true });

    expect(guard.admit("maya")).toMatchObject({ ok: false, message: expect.stringContaining("a few minutes") });
    expect(guard.admit("judge-1")).toEqual({ ok: true });
    c.advance(3600_000 + 1);
    expect(guard.admit("maya")).toEqual({ ok: true });
  });

  it("tells a request to stop once it passes its own cost cap", () => {
    const guard = new UsageGuard(limits({ turnBudgetUsd: 0.1 }), clock().now);
    const meter = guard.meter();
    expect(meter(usage(10_000, 4_000, 1_000))).toEqual({ stop: false }); // $0.062
    expect(meter(usage(10_000, 4_000, 1_000))).toEqual({ stop: true }); // $0.124 in total
    expect(guard.meter()(usage(1_000, 0, 100))).toEqual({ stop: false }); // a new request starts fresh
  });
});

describe("readGuardLimits", () => {
  it("has safe defaults and reads overrides from env", () => {
    expect(readGuardLimits({})).toEqual({ dailyBudgetUsd: 10, turnBudgetUsd: 0.75, turnsPerHour: 30, prices: PRICES });
    expect(readGuardLimits({ AGENT_DAILY_BUDGET_USD: "25", AGENT_TURNS_PER_HOUR: "abc" })).toMatchObject({ dailyBudgetUsd: 25, turnsPerHour: 30 });
  });
});

describe("trimHistory", () => {
  const turn = (n: number) => [
    { role: "user", content: `request ${n} ${"x".repeat(200)}` },
    { type: "function_call", call_id: `c${n}`, name: "search_products", arguments: "{}" },
    { type: "function_call_output", call_id: `c${n}`, output: "y".repeat(300) },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
  ];

  it("keeps a short conversation as it is", () => {
    const history = [...turn(1), ...turn(2)];
    expect(trimHistory(history as never, 100_000)).toEqual(history);
  });

  it("drops the oldest turns of a long conversation, cutting only where a shopper message starts", () => {
    const history = [1, 2, 3, 4, 5].flatMap(turn);
    const trimmed = trimHistory(history as never, 2_000) as Array<{ role?: string; content?: string }>;

    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(2_000);
    expect(trimmed[0].role).toBe("user");
    expect(trimmed.at(-1)).toEqual(history.at(-1));
  });
});
