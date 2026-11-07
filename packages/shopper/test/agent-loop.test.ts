import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { runAgentTurn, type AgentModelConfig, type ModelClient, type UiEvent } from "../src/lib/agent/loop";
import { AGENT_TOOLS } from "../src/lib/agent/tools";
import { tokentoClient } from "../src/lib/tokento";

type ModelResponse = OpenAI.Responses.Response;
type OutputItem = OpenAI.Responses.ResponseOutputItem;
type StreamEvent = OpenAI.Responses.ResponseStreamEvent;

// ---- A scripted stand-in for the model (Azure OpenAI Responses API) ----

const rand = () => Math.random().toString(36).slice(2, 10);

function response(output: OutputItem[], status: "completed" | "incomplete" = "completed"): ModelResponse {
  return {
    id: `resp_${rand()}`,
    object: "response",
    created_at: 0,
    status,
    output,
    incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
  } as unknown as ModelResponse;
}

const call = (callId: string, name: string, args: Record<string, unknown> | string) =>
  ({ type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: typeof args === "string" ? args : JSON.stringify(args), status: "completed" }) as OutputItem;
const say = (text: string) =>
  ({ type: "message", id: `msg_${rand()}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }) as unknown as OutputItem;
const refuse = (text: string) =>
  ({ type: "message", id: `msg_${rand()}`, role: "assistant", status: "completed", content: [{ type: "refusal", refusal: text }] }) as unknown as OutputItem;
const reasoning = (summary: string, encrypted: string) =>
  ({ type: "reasoning", id: `rs_${rand()}`, summary: [{ type: "summary_text", text: summary }], encrypted_content: encrypted }) as unknown as OutputItem;

function eventsFor(res: ModelResponse): StreamEvent[] {
  const events: unknown[] = [{ type: "response.created", response: { ...res, status: "in_progress", output: [] } }];
  res.output.forEach((item, output_index) => {
    events.push({ type: "response.output_item.added", output_index, item: item.type === "function_call" ? { ...item, arguments: "" } : item });
    if (item.type === "reasoning") {
      item.summary.forEach((part, summary_index) => {
        events.push({ type: "response.reasoning_summary_text.done", item_id: item.id, output_index, summary_index, text: part.text });
      });
    }
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text") events.push({ type: "response.output_text.delta", item_id: item.id, output_index, content_index: 0, delta: part.text });
        if (part.type === "refusal") events.push({ type: "response.refusal.delta", item_id: item.id, output_index, content_index: 0, delta: part.refusal });
      }
    }
    events.push({ type: "response.output_item.done", output_index, item });
  });
  events.push({ type: res.status === "incomplete" ? "response.incomplete" : "response.completed", response: res });
  return events as StreamEvent[];
}

function fakeModel(turns: Array<ModelResponse | ((params: unknown) => ModelResponse)>, opts: { fail?: Error } = {}) {
  const requests: any[] = [];
  const model: ModelClient = {
    responses: {
      async create(params) {
        requests.push(structuredClone(params));
        if (opts.fail) throw opts.fail;
        const next = turns[Math.min(requests.length - 1, turns.length - 1)];
        const res = typeof next === "function" ? next(params) : next;
        return (async function* () {
          yield* eventsFor(res);
        })();
      },
    },
  };
  return { model, requests };
}

const config: AgentModelConfig = { deployment: "tokento-agent", reasoningEffort: "low" };

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

const historyOf = (events: UiEvent[]) => (events.find((e) => e.type === "history") as { messages: any[] }).messages;
const kinds = (items: any[]) => items.map((m) => m.type ?? m.role);

const searchResult = {
  products: [
    { productId: "p-coffee", sku: "CC-MRB-2LB", name: "Morning Ridge Blend, 2 lb", description: null, category: "coffee", price: 28, merchantId: "m-coffee", merchantName: "Coffee Co." },
  ],
};

// A complete CheckoutOrderView, as the API returns it.
const sampleOrder = {
  id: "order-1",
  status: "CREATED",
  customerId: "shopper-1",
  merchant: { id: "m-coffee", name: "Coffee Co." },
  product: { id: "p-coffee", name: "Morning Ridge Blend, 2 lb", sku: "CC-MRB-2LB" },
  quantity: 1,
  subtotal: 28,
  reward: { tokenId: "t-5", amount: 5, state: "held" },
  amountToPay: 23,
  earned: { tokenId: null, amount: 5, state: "expected" },
  paymentMode: "approval",
  outsideMandate: false,
  paypal: { orderId: "PP-1", captureId: null, refundId: null, approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=PP-1" },
  platformFee: 0,
  settlement: { batchId: null, state: "unsettled" },
  agentReason: "Best total value",
  note: null,
  receipt: "Morning Ridge Blend, 2 lb at Coffee Co.: $28.00 − $5.00 reward = $23.00, waiting for PayPal approval.",
  createdAt: "2026-11-09T18:00:00.000Z",
  completedAt: null,
  refundedAt: null,
};

describe("runAgentTurn", () => {
  it("runs tools until the model answers, streams text, and returns the whole conversation", async () => {
    const { model, requests } = fakeModel([
      response([call("call_1", "search_products", { query: "medium roast whole bean 2 lb", max_price: null })]),
      response([say("Coffee Co. has your usual blend.")]),
    ]);
    const { api, calls } = fakeApi({ "GET /catalog/search": () => ({ status: 200, body: searchResult }) });

    const events = await collect(runAgentTurn({ model, config, api }, [], "Reorder my coffee beans"));

    expect(requests).toHaveLength(2);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /catalog/search"]);
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toBe("Coffee Co. has your usual blend.");
    expect(events).toContainEqual({ type: "tool_start", id: "call_1", name: "search_products" });
    expect(events).toContainEqual(expect.objectContaining({ type: "products", products: searchResult.products }));
    expect(requests[1].input.at(-1)).toMatchObject({ type: "function_call_output", call_id: "call_1" });
    expect(kinds(historyOf(events))).toEqual(["user", "function_call", "function_call_output", "message"]);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
  });

  it("passes reasoning back exactly as received, encrypted, and shows its summary as progress", async () => {
    const thought = reasoning("Checking the catalog first.", "enc-abc123");
    const { model, requests } = fakeModel([
      response([thought, call("call_1", "search_products", { query: "coffee", max_price: null })]),
      response([say("Done.")]),
    ]);
    const { api } = fakeApi({ "GET /catalog/search": () => ({ status: 200, body: searchResult }) });

    const events = await collect(runAgentTurn({ model, config, api }, [], "Find coffee"));

    expect(requests[1].input[1]).toEqual(thought);
    expect(events).toContainEqual({ type: "progress", text: "Checking the catalog first." });
  });

  it("turns a Tokento API error into a failed tool result carrying the API's own message", async () => {
    const violation = "Over the $20.00 per-purchase limit. Ask the shopper first. If they agree, retry with paymentMode \"approval\" so they approve this payment in PayPal themselves.";
    const { model, requests } = fakeModel([
      response([call("call_9", "start_checkout", { product_id: "p-coffee", quantity: null, reason: "Best total value", payment_mode: null })]),
      response([say("That's over your limit. Should I go ahead?")]),
    ]);
    const { api } = fakeApi({
      "POST /checkout/orders": () => ({ status: 403, body: { error: { code: "mandate_violation", message: violation, details: { mandateCode: "over_per_purchase_max" } } } }),
    });

    const events = await collect(runAgentTurn({ model, config, api }, [], "Buy it"));

    const result = requests[1].input.at(-1);
    expect(result).toMatchObject({ type: "function_call_output", call_id: "call_9" });
    expect(result.output).toContain("mandate_violation");
    expect(result.output).toContain(violation);
    expect(events).toContainEqual({ type: "tool_result", id: "call_9", name: "start_checkout", ok: false });
  });

  it("stops after 8 tool rounds instead of looping forever", async () => {
    const { model, requests } = fakeModel([() => response([call(`call_${rand()}`, "search_products", { query: "coffee", max_price: null })])]);
    const { api } = fakeApi({ "GET /catalog/search": () => ({ status: 200, body: searchResult }) });

    const events = await collect(runAgentTurn({ model, config, api }, [], "Find coffee"));

    expect(requests).toHaveLength(8);
    expect(events).toContainEqual(expect.objectContaining({ type: "notice" }));
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "max_tool_rounds" });
  });

  it("answers invalid or unparseable tool input with an INVALID_JSON error and never calls the API", async () => {
    const { model, requests } = fakeModel([
      response([call("call_2", "compare_offers", { product_ids: "not-a-list" }), call("call_3", "compare_offers", "{not json")]),
      response([say("Let me retry.")]),
    ]);
    const { api, calls } = fakeApi();

    await collect(runAgentTurn({ model, config, api }, [], "Compare"));

    expect(calls).toHaveLength(0);
    const outputs = requests[1].input.filter((i: { type?: string }) => i.type === "function_call_output");
    expect(outputs.map((o: { call_id: string }) => o.call_id)).toEqual(["call_2", "call_3"]);
    for (const o of outputs) expect(o.output).toContain("INVALID_JSON");
  });

  it("ends the turn on a refusal without running any tool or keeping the reply", async () => {
    const { model } = fakeModel([response([refuse("I can't help with that."), call("call_3", "start_checkout", { product_id: "p-coffee", quantity: null, reason: "x", payment_mode: null })])]);
    const { api, calls } = fakeApi();

    const events = await collect(runAgentTurn({ model, config, api }, [], "Buy something"));

    expect(calls).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({ type: "notice" }));
    expect(kinds(historyOf(events))).toEqual(["user"]);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "refusal" });
  });

  it("ends the turn with a plain error when the model can't be reached", async () => {
    const { model } = fakeModel([], { fail: new Error("401 Access denied due to invalid subscription key") });
    const { api } = fakeApi();

    const events = await collect(runAgentTurn({ model, config, api }, [], "Hi"));

    expect(events).toContainEqual({ type: "error", message: "The shopping assistant is unavailable right now. Please try again." });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "error" });
  });

  it("uses the tool call id as the checkout idempotency key, so a retried call can't buy twice", async () => {
    const { model } = fakeModel([
      response([call("call_buy", "start_checkout", { product_id: "p-coffee", quantity: 1, reason: "Best total value", payment_mode: null })]),
      response([say("Approve in PayPal below.")]),
    ]);
    const { api, calls } = fakeApi({ "POST /checkout/orders": () => ({ status: 201, body: sampleOrder }) });

    const events = await collect(runAgentTurn({ model, config, api }, [], "Buy it"));

    expect(calls[0].headers["idempotency-key"]).toBe("agent-call_buy");
    expect(calls[0].body).toMatchObject({ productId: "p-coffee", quantity: 1, paymentMode: "auto", agentReason: "Best total value" });
    expect(events).toContainEqual({ type: "checkout", order: sampleOrder });
  });

  it("asks the Azure deployment for strict tools, no stored conversation, and reasoning summaries", async () => {
    const { model, requests } = fakeModel([response([say("Hi Maya.")])]);
    const { api } = fakeApi();

    await collect(runAgentTurn({ model, config, api }, [], "Hi"));

    const params = requests[0];
    expect(params.model).toBe("tokento-agent");
    expect(params.stream).toBe(true);
    expect(params.store).toBe(false);
    expect(params.instructions).toContain("Tokento Shopper");
    expect(params.reasoning).toEqual({ effort: "low", summary: "auto" });
    expect(params.include).toContain("reasoning.encrypted_content");
    for (const tool of params.tools) {
      expect(tool).toMatchObject({ type: "function", strict: true, parameters: { type: "object", additionalProperties: false } });
      expect([...tool.parameters.required].sort()).toEqual(Object.keys(tool.parameters.properties).sort());
    }
  });

  it("leaves reasoning out for a deployment that doesn't support it", async () => {
    const { model, requests } = fakeModel([response([say("Hi.")])]);
    const { api } = fakeApi();

    await collect(runAgentTurn({ model, config: { deployment: "gpt41", reasoningEffort: null }, api }, [], "Hi"));

    expect(requests[0]).not.toHaveProperty("reasoning");
    expect(requests[0]).not.toHaveProperty("include");
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
      "POST /checkout/orders": () => ({ status: 201, body: sampleOrder }),
      "GET /checkout/orders/o1": () => ({ status: 200, body: sampleOrder }),
      "GET /checkout/orders": () => ({ status: 200, body: { orders: [] } }),
    });
    const samples: Record<string, Record<string, unknown>> = {
      search_products: { query: "coffee", max_price: null },
      get_rewards: {},
      compare_offers: { product_ids: ["p1"], quantity: null, max_amount_to_pay: null },
      start_checkout: { product_id: "p1", quantity: null, reason: "r", payment_mode: null },
      get_order_status: { order_id: "o1" },
      get_spending_limits: {},
      list_my_orders: {},
    };
    expect(AGENT_TOOLS.map((t) => t.name).sort()).toEqual(Object.keys(samples).sort());

    const { model } = fakeModel([
      response(Object.entries(samples).map(([name, input], i) => call(`call_${i}`, name, input))),
      response([say("ok")]),
    ]);
    const events = await collect(runAgentTurn({ model, config, api }, [], "Do everything"));

    expect(events.filter((e) => e.type === "tool_result" && !e.ok)).toEqual([]);
    const mandateWrites = calls.filter((c) => c.path.startsWith("/mandates") && c.method !== "GET");
    expect(calls.some((c) => c.path === "/mandates/active")).toBe(true);
    expect(mandateWrites).toEqual([]);
  });
});
