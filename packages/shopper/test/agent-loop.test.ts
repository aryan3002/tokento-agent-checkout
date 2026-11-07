import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgentTurn, type ClaudeLike, type UiEvent } from "../src/lib/agent/loop";
import { AGENT_TOOLS } from "../src/lib/agent/tools";
import { tokentoClient } from "../src/lib/tokento";

type BetaMessage = Anthropic.Beta.BetaMessage;
type BetaContentBlock = Anthropic.Beta.BetaContentBlock;
type BetaStreamEvent = Anthropic.Beta.BetaRawMessageStreamEvent;

// ---- A scripted stand-in for Claude ----

function message(content: BetaContentBlock[], stop_reason: BetaMessage["stop_reason"]): BetaMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 10)}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  } as unknown as BetaMessage;
}

function eventsFor(msg: BetaMessage): BetaStreamEvent[] {
  const events: BetaStreamEvent[] = [];
  msg.content.forEach((block, index) => {
    if (block.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } } as BetaStreamEvent);
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } } as BetaStreamEvent);
    } else if (block.type === "thinking") {
      events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } } as BetaStreamEvent);
      if (block.thinking) events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } } as BetaStreamEvent);
    } else if (block.type === "tool_use") {
      events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } } as BetaStreamEvent);
    }
    events.push({ type: "content_block_stop", index } as BetaStreamEvent);
  });
  return events;
}

function fakeClaude(turns: Array<BetaMessage | ((params: unknown) => BetaMessage)>) {
  const requests: any[] = [];
  const claude: ClaudeLike = {
    beta: {
      messages: {
        stream(params: any) {
          requests.push(structuredClone(params));
          const next = turns[Math.min(requests.length - 1, turns.length - 1)];
          const msg = typeof next === "function" ? next(params) : next;
          return {
            async *[Symbol.asyncIterator]() { yield* eventsFor(msg); },
            finalMessage: async () => msg,
          };
        },
      },
    },
  };
  return { claude, requests };
}

const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
  ({ type: "tool_use", id, name, input } as unknown as BetaContentBlock);
const text = (t: string) => ({ type: "text", text: t, citations: null } as unknown as BetaContentBlock);

// ---- A recording stand-in for the Tokento API ----

function fakeApi(routes: Record<string, (body: any) => { status: number; body: unknown }> = {}) {
  const calls: Array<{ method: string; path: string; headers: Record<string, string>; body: any }> = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    const path = u.pathname.replace(/^\/api\/v1/, "");
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, headers: Object.fromEntries(new Headers(init.headers).entries()), body });
    const handler = routes[`${method} ${path}`];
    const res = handler ? handler(body) : { status: 404, body: { error: { code: "not_found", message: `Route ${method} ${path} not found.` } } };
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { api: tokentoClient("b2c_dev_session::shopper-1", fetchImpl), calls };
}

async function collect(gen: AsyncGenerator<UiEvent>): Promise<UiEvent[]> {
  const out: UiEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const searchResult = {
  products: [
    { productId: "p-coffee", sku: "CC-MRB-2LB", name: "Morning Ridge Blend, 2 lb", description: null, category: "coffee", price: 28, merchantId: "m-coffee", merchantName: "Coffee Co." },
  ],
};

describe("runAgentTurn", () => {
  it("runs tools until Claude ends its turn, streams text, and returns the whole conversation", async () => {
    const { claude, requests } = fakeClaude([
      message([toolUse("toolu_1", "search_products", { query: "medium roast whole bean 2 lb" })], "tool_use"),
      message([text("Coffee Co. has your usual blend.")], "end_turn"),
    ]);
    const { api, calls } = fakeApi({ "GET /catalog/search": () => ({ status: 200, body: searchResult }) });

    const events = await collect(runAgentTurn({ claude, api }, [], "Reorder my coffee beans"));

    expect(requests).toHaveLength(2);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /catalog/search"]);
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toBe("Coffee Co. has your usual blend.");
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_start", name: "search_products" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "products", products: searchResult.products }));
    const history = events.find((e) => e.type === "history") as { messages: Anthropic.Beta.BetaMessageParam[] };
    expect(history.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
  });

  it("passes thinking blocks back to Claude exactly as received", async () => {
    const thinking = { type: "thinking", thinking: "Checking the catalog first.", signature: "sig-abc123" } as unknown as BetaContentBlock;
    const { claude, requests } = fakeClaude([
      message([thinking, toolUse("toolu_1", "search_products", { query: "coffee" })], "tool_use"),
      message([text("Done.")], "end_turn"),
    ]);
    const { api } = fakeApi({ "GET /catalog/search": () => ({ status: 200, body: searchResult }) });

    const events = await collect(runAgentTurn({ claude, api }, [], "Find coffee"));

    expect(requests[1].messages[1].content[0]).toEqual(thinking);
    expect(events).toContainEqual({ type: "progress", text: "Checking the catalog first." });
  });

  it("turns a Tokento API error into an is_error tool result carrying the API's own message", async () => {
    const violation = "Over the $20.00 per-purchase limit. Ask the shopper first. If they agree, retry with paymentMode \"approval\" so they approve this payment in PayPal themselves.";
    const { claude, requests } = fakeClaude([
      message([toolUse("toolu_9", "start_checkout", { product_id: "p-coffee", reason: "Best total value" })], "tool_use"),
      message([text("That's over your limit. Should I go ahead?")], "end_turn"),
    ]);
    const { api } = fakeApi({
      "POST /checkout/orders": () => ({ status: 403, body: { error: { code: "mandate_violation", message: violation, details: { mandateCode: "over_per_purchase_max" } } } }),
    });

    await collect(runAgentTurn({ claude, api }, [], "Buy it"));

    const results = requests[1].messages.at(-1).content;
    expect(results[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_9", is_error: true });
    expect(results[0].content).toContain("mandate_violation");
    expect(results[0].content).toContain(violation);
  });

  it("stops after 8 tool rounds instead of looping forever", async () => {
    const { claude, requests } = fakeClaude([
      () => message([toolUse(`toolu_${Math.random()}`, "search_products", { query: "coffee" })], "tool_use"),
    ]);
    const { api } = fakeApi({ "GET /catalog/search": () => ({ status: 200, body: searchResult }) });

    const events = await collect(runAgentTurn({ claude, api }, [], "Find coffee"));

    expect(requests).toHaveLength(8);
    expect(events).toContainEqual(expect.objectContaining({ type: "notice" }));
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "max_tool_rounds" });
  });

  it("answers invalid tool input with an INVALID_JSON error and never calls the API", async () => {
    const { claude, requests } = fakeClaude([
      message([toolUse("toolu_2", "compare_offers", { product_ids: "not-a-list" })], "tool_use"),
      message([text("Let me retry.")], "end_turn"),
    ]);
    const { api, calls } = fakeApi();

    await collect(runAgentTurn({ claude, api }, [], "Compare"));

    expect(calls).toHaveLength(0);
    const result = requests[1].messages.at(-1).content[0];
    expect(result).toMatchObject({ tool_use_id: "toolu_2", is_error: true });
    expect(result.content).toContain("INVALID_JSON");
  });

  it("ends the turn on a refusal without running any tool or keeping the partial reply", async () => {
    const { claude } = fakeClaude([
      message([toolUse("toolu_3", "start_checkout", { product_id: "p-coffee", reason: "x" })], "refusal"),
    ]);
    const { api, calls } = fakeApi();
    const history: Anthropic.Beta.BetaMessageParam[] = [];

    const events = await collect(runAgentTurn({ claude, api }, history, "Buy something"));

    expect(calls).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({ type: "notice" }));
    const final = events.find((e) => e.type === "history") as { messages: Anthropic.Beta.BetaMessageParam[] };
    expect(final.messages.map((m) => m.role)).toEqual(["user"]);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "refusal" });
  });

  it("uses the tool call id as the checkout idempotency key, so a retried call can't buy twice", async () => {
    const order = { id: "order-1", status: "CREATED", amountToPay: 23, paypal: { approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=X" } };
    const { claude } = fakeClaude([
      message([toolUse("toolu_buy", "start_checkout", { product_id: "p-coffee", reason: "Best total value", quantity: 1 })], "tool_use"),
      message([text("Approve in PayPal below.")], "end_turn"),
    ]);
    const { api, calls } = fakeApi({ "POST /checkout/orders": () => ({ status: 201, body: order }) });

    const events = await collect(runAgentTurn({ claude, api }, [], "Buy it"));

    expect(calls[0].headers["idempotency-key"]).toBe("agent-toolu_buy");
    expect(calls[0].body).toMatchObject({ productId: "p-coffee", quantity: 1, agentReason: "Best total value" });
    expect(events).toContainEqual({ type: "checkout", order });
  });

  it("asks Claude for Opus 5.5 with strict tools, refusal fallbacks and progress updates", async () => {
    const { claude, requests } = fakeClaude([message([text("Hi Maya.")], "end_turn")]);
    const { api } = fakeApi();

    await collect(runAgentTurn({ claude, api }, [], "Hi"));

    const params = requests[0];
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.fallbacks).toBe("default");
    expect(params.betas).toEqual(expect.arrayContaining(["server-side-fallback-2026-07-01", "thinking-display-updates-2026-08-18"]));
    expect(params.thinking).toEqual({ type: "adaptive", display: "updates" });
    expect(params.output_config.effort).toBeDefined();
    expect(params.tools.every((t: { strict?: boolean; eager_input_streaming?: boolean }) => t.strict && t.eager_input_streaming)).toBe(true);
  });
});

describe("agent tools", () => {
  it("no tool can change the shopper's spending limits", async () => {
    const { api, calls } = fakeApi({
      "GET /mandates/active": () => ({ status: 200, body: { mandate: null } }),
      "GET /catalog/search": () => ({ status: 200, body: searchResult }),
      "GET /wallet/me/tokens": () => ({ status: 200, body: { tokens: [], totalValue: 0 } }),
      "GET /catalog/stores": () => ({ status: 200, body: { stores: [] } }),
      "POST /checkout/quote": () => ({ status: 200, body: { offers: [], recommendedProductId: null, comparison: "" } }),
      "POST /checkout/orders": () => ({ status: 201, body: { id: "o1", status: "CREATED" } }),
      "GET /checkout/orders/o1": () => ({ status: 200, body: { id: "o1", status: "CREATED" } }),
      "GET /checkout/orders": () => ({ status: 200, body: { orders: [] } }),
    });
    const samples: Record<string, Record<string, unknown>> = {
      search_products: { query: "coffee" },
      get_rewards: {},
      compare_offers: { product_ids: ["p1"] },
      start_checkout: { product_id: "p1", reason: "r" },
      get_order_status: { order_id: "o1" },
      get_spending_limits: {},
      list_my_orders: {},
    };
    expect(AGENT_TOOLS.map((t) => t.name).sort()).toEqual(Object.keys(samples).sort());

    const { claude } = fakeClaude([
      message(Object.entries(samples).map(([name, input], i) => toolUse(`toolu_${i}`, name, input)), "tool_use"),
      message([text("ok")], "end_turn"),
    ]);
    await collect(runAgentTurn({ claude, api }, [], "Do everything"));

    const mandateWrites = calls.filter((c) => c.path.startsWith("/mandates") && c.method !== "GET");
    expect(calls.some((c) => c.path === "/mandates/active")).toBe(true);
    expect(mandateWrites).toEqual([]);
  });
});
