import { describe, expect, it } from "vitest";
import { combinedMeter, readSharedUsage, sharedUsage } from "../src/lib/agent/shared-usage";

const KEY = "k".repeat(40);
const PRICES = { input: 5, cachedInput: 0.5, output: 30 };

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const seen: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { impl, seen };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("sharedUsage", () => {
  it("asks the API's shared guard before a request, with the server key", async () => {
    const { impl, seen } = fakeFetch(() => json(200, { ok: true }));
    const guard = sharedUsage({ apiUrl: "http://api.test/", key: KEY, fetchImpl: impl });
    expect(await guard.admit("cust-1")).toEqual({ ok: true });
    expect(seen[0]).toEqual({ url: "http://api.test/api/v1/internal/agent-usage/admit", headers: expect.objectContaining({ "X-Agent-Usage-Key": KEY }), body: { customerId: "cust-1" } });
  });

  it("passes the API's refusal on to the shopper", async () => {
    const { impl } = fakeFetch(() => json(200, { ok: false, code: "daily_budget", message: "The demo agent reached today's usage limit." }));
    expect(await sharedUsage({ apiUrl: "http://api.test", key: KEY, fetchImpl: impl }).admit("cust-1")).toEqual({ ok: false, message: "The demo agent reached today's usage limit." });
  });

  it("refuses the request when the guard can't be checked, since it protects real money", async () => {
    const down = fakeFetch(() => { throw new Error("ECONNREFUSED"); });
    const broken = fakeFetch(() => json(500, { error: { code: "internal_error" } }));
    for (const { impl } of [down, broken]) {
      const admission = await sharedUsage({ apiUrl: "http://api.test", key: KEY, fetchImpl: impl }).admit("cust-1");
      expect(admission).toEqual({ ok: false, message: expect.stringMatching(/unavailable/) });
    }
  });

  it("charges each model call and says stop once the day's budget is spent, or when the charge fails", async () => {
    const spent = fakeFetch(() => json(200, { spentTodayUsd: 10.02, overBudget: true }));
    const guard = sharedUsage({ apiUrl: "http://api.test", key: KEY, fetchImpl: spent.impl });
    expect(await guard.charge(0.07)).toEqual({ stop: true });
    expect(spent.seen[0]).toMatchObject({ url: "http://api.test/api/v1/internal/agent-usage/charge", body: { costUsd: 0.07 } });

    const fine = fakeFetch(() => json(200, { spentTodayUsd: 1.5, overBudget: false }));
    expect(await sharedUsage({ apiUrl: "http://api.test", key: KEY, fetchImpl: fine.impl }).charge(0.07)).toEqual({ stop: false });

    const down = fakeFetch(() => { throw new Error("ECONNRESET"); });
    expect(await sharedUsage({ apiUrl: "http://api.test", key: KEY, fetchImpl: down.impl }).charge(0.07)).toEqual({ stop: true });
  });
});

describe("readSharedUsage", () => {
  it("is off unless a key of 32+ characters is set", () => {
    expect(readSharedUsage({})).toBeNull();
    expect(readSharedUsage({ AGENT_USAGE_KEY: "short" })).toBeNull();
    expect(readSharedUsage({ AGENT_USAGE_KEY: KEY, TOKENTO_API_URL: "http://api.test" })).not.toBeNull();
  });
});

describe("combinedMeter", () => {
  const usage = { input_tokens: 10_000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1_000 };

  it("charges the shared guard with the call's cost and stops if either side says so", async () => {
    const charged: number[] = [];
    const shared = { admit: async () => ({ ok: true as const }), charge: async (c: number) => (charged.push(c), { stop: false }) };
    expect(await combinedMeter(() => ({ stop: false }), shared, PRICES)(usage)).toEqual({ stop: false });
    expect(charged).toEqual([0.08]);
    expect(await combinedMeter(() => ({ stop: true }), shared, PRICES)(usage)).toEqual({ stop: true });
    const sharedStops = { ...shared, charge: async () => ({ stop: true }) };
    expect(await combinedMeter(() => ({ stop: false }), sharedStops, PRICES)(usage)).toEqual({ stop: true });
  });
});
