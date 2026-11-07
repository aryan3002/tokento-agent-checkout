import { describe, expect, it } from "vitest";
import { readNdjson } from "../src/lib/chat/ndjson";
import { applyEvent, emptyTranscript, startTurn, upsertOrder } from "../src/lib/chat/transcript";
import type { CheckoutOrderView } from "@tokento/shared";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function all<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

const order = (status: string, extra: Partial<CheckoutOrderView> = {}) => ({
  id: "order-1", status, amountToPay: 23, paypal: { orderId: "PP-1" }, ...extra,
}) as unknown as CheckoutOrderView;

describe("readNdjson", () => {
  it("yields one object per line even when lines are split across chunks", async () => {
    const events = await all(readNdjson(streamOf(['{"type":"text","de', 'lta":"Hi"}\n{"type":"do', 'ne","stopReason":"end_turn"}\n'])));
    expect(events).toEqual([{ type: "text", delta: "Hi" }, { type: "done", stopReason: "end_turn" }]);
  });

  it("reads a last line that has no trailing newline and skips blank lines", async () => {
    const events = await all(readNdjson(streamOf(['{"a":1}\n\n', '{"b":2}'])));
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe("transcript", () => {
  it("adds the shopper's message and marks the agent busy", () => {
    const t = startTurn(emptyTranscript(), "Reorder my coffee beans");
    expect(t.busy).toBe(true);
    expect(t.entries).toEqual([expect.objectContaining({ kind: "user", text: "Reorder my coffee beans" })]);
  });

  it("joins streamed text into one reply until a tool or card interrupts it", () => {
    let t = startTurn(emptyTranscript(), "Hi");
    t = applyEvent(t, { type: "text", delta: "Let me " });
    t = applyEvent(t, { type: "text", delta: "look." });
    t = applyEvent(t, { type: "tool_start", id: "toolu_1", name: "search_products" });
    t = applyEvent(t, { type: "text", delta: "Found it." });
    expect(t.entries.map((e) => e.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(t.entries[1]).toMatchObject({ text: "Let me look." });
    expect(t.entries[3]).toMatchObject({ text: "Found it." });
  });

  it("marks a tool chip done or failed when its result arrives", () => {
    let t = startTurn(emptyTranscript(), "Hi");
    t = applyEvent(t, { type: "tool_start", id: "toolu_1", name: "compare_offers" });
    t = applyEvent(t, { type: "tool_result", id: "toolu_1", name: "compare_offers", ok: false });
    expect(t.entries[1]).toMatchObject({ kind: "tool", state: "error" });
  });

  it("keeps one checkout card per order and updates it as the order moves on", () => {
    let t = startTurn(emptyTranscript(), "Buy it");
    t = applyEvent(t, { type: "checkout", order: order("CREATED") });
    t = applyEvent(t, { type: "order", order: order("COMPLETED") });
    t = upsertOrder(t, order("REFUNDED"));
    const cards = t.entries.filter((e) => e.kind === "checkout");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ order: { status: "REFUNDED" } });
  });

  it("stores the conversation Claude needs next turn and frees the input when done", () => {
    let t = startTurn(emptyTranscript(), "Hi");
    const history = [{ role: "user" as const, content: "Hi" }, { role: "assistant" as const, content: [{ type: "text" as const, text: "Hello" }] }];
    t = applyEvent(t, { type: "history", messages: history as never });
    t = applyEvent(t, { type: "done", stopReason: "end_turn" });
    expect(t.history).toEqual(history);
    expect(t.busy).toBe(false);
  });

  it("shows errors and notices as their own lines", () => {
    let t = startTurn(emptyTranscript(), "Hi");
    t = applyEvent(t, { type: "error", message: "The shopping assistant is unavailable right now." });
    t = applyEvent(t, { type: "notice", text: "I stopped after 8 steps." });
    expect(t.entries.slice(1)).toEqual([
      expect.objectContaining({ kind: "notice", tone: "error" }),
      expect.objectContaining({ kind: "notice", tone: "info" }),
    ]);
  });
});
