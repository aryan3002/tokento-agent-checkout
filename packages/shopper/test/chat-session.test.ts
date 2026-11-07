import { describe, expect, it, vi } from "vitest";
import type { CheckoutOrderView } from "@tokento/shared";
import {
  APPROVED_MESSAGE,
  afterPayPal,
  finishRedirect,
  finishVaultRedirect,
  loadTranscript,
  redirectOutcome,
  saveTranscript,
  streamTurn,
  transcriptKey,
} from "../src/lib/chat/client";
import { addNotice, applyEvent, emptyTranscript, startTurn, syncOrders } from "../src/lib/chat/transcript";

const ORDER_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

const blockedStorage = {
  getItem(): string | null {
    throw new Error("SecurityError: storage is disabled");
  },
  setItem(): void {
    throw new Error("QuotaExceededError");
  },
};

const order = (status: string, extra: Partial<CheckoutOrderView> = {}) =>
  ({ id: ORDER_ID, status, reward: null, amountToPay: 23, paypal: { orderId: "PP-1" }, ...extra }) as unknown as CheckoutOrderView;

async function all<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

function ndjson(lines: object[]): Response {
  return new Response(lines.map((l) => `${JSON.stringify(l)}\n`).join(""), {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

describe("saved chat", () => {
  it("restores a shopper's chat after a reload, never stuck mid-turn", () => {
    const store = new MemoryStorage();
    let t = startTurn(emptyTranscript(), "Reorder my coffee beans");
    t = applyEvent(t, { type: "text", delta: "On it." });
    saveTranscript(store, "maya", t);

    const restored = loadTranscript(store, "maya");
    expect(restored.entries).toEqual(t.entries);
    expect(restored.busy).toBe(false);
    expect(loadTranscript(store, "someone-else")).toEqual(emptyTranscript());
  });

  it("starts empty when storage is blocked or holds junk, and saving never throws", () => {
    expect(loadTranscript(null, "maya")).toEqual(emptyTranscript());
    expect(loadTranscript(blockedStorage, "maya")).toEqual(emptyTranscript());

    const store = new MemoryStorage();
    store.setItem(transcriptKey("maya"), "{not json");
    expect(loadTranscript(store, "maya")).toEqual(emptyTranscript());
    store.setItem(transcriptKey("maya"), JSON.stringify({ entries: "nope", history: [] }));
    expect(loadTranscript(store, "maya")).toEqual(emptyTranscript());

    expect(() => saveTranscript(blockedStorage, "maya", emptyTranscript())).not.toThrow();
  });
});

describe("streamTurn", () => {
  it("posts the message with the conversation so far and yields the agent's events", async () => {
    const fetchImpl = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
      ndjson([{ type: "text", delta: "Hi" }, { type: "done", stopReason: "end_turn" }]),
    );
    const history = [{ role: "user", content: "earlier" }];

    const events = await all(streamTurn(fetchImpl, "Find me a travel mug", history as never));

    expect(events).toEqual([{ type: "text", delta: "Hi" }, { type: "done", stopReason: "end_turn" }]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/chat");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ message: "Find me a travel mug", history });
  });

  it("turns an expired session into a notice and frees the input", async () => {
    const fetchImpl = async () =>
      Response.json({ error: { code: "no_session", message: "Start a shopping session first." } }, { status: 401 });

    const events = await all(streamTurn(fetchImpl, "hi", []));

    expect(events).toEqual([
      { type: "error", message: expect.stringContaining("Reload the page") },
      { type: "done", stopReason: "error" },
    ]);
  });

  it("shows the server's reason when the agent isn't configured", async () => {
    const fetchImpl = async () =>
      Response.json({ error: { code: "agent_not_configured", message: "The shopping agent is not configured on this server." } }, { status: 503 });

    const events = await all(streamTurn(fetchImpl, "hi", []));

    expect(events).toEqual([
      { type: "error", message: "The shopping agent is not configured on this server." },
      { type: "done", stopReason: "error" },
    ]);
  });

  it("reports a network failure instead of hanging", async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new TypeError("Failed to fetch");
    };

    const events = await all(streamTurn(fetchImpl, "hi", []));

    expect(events).toEqual([
      { type: "error", message: expect.stringContaining("connection") },
      { type: "done", stopReason: "error" },
    ]);
  });

  it("ends the turn when the stream breaks off before the agent finished", async () => {
    const closedEarly = async () => ndjson([{ type: "text", delta: "Let me" }]);
    const enc = new TextEncoder();
    // error() drops chunks still queued, so the reset comes on the read after the first line.
    const reset = async () => {
      let pulls = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (pulls++ === 0) controller.enqueue(enc.encode('{"type":"text","delta":"Let me"}\n'));
            else controller.error(new Error("connection reset"));
          },
        }),
      );
    };

    for (const fetchImpl of [closedEarly, reset]) {
      const events = await all(streamTurn(fetchImpl, "hi", []));
      expect(events).toEqual([
        { type: "text", delta: "Let me" },
        { type: "error", message: expect.stringContaining("cut off") },
        { type: "done", stopReason: "error" },
      ]);
    }
  });
});

describe("PayPal redirect round trip", () => {
  it("reads the outcome PayPal's return and cancel pages hand back", () => {
    expect(redirectOutcome(`?paid=${ORDER_ID}`)).toEqual({ kind: "paid", orderId: ORDER_ID });
    expect(redirectOutcome(`?cancelled=${ORDER_ID}`)).toEqual({ kind: "cancelled", orderId: ORDER_ID });
    expect(redirectOutcome("")).toBeNull();
    expect(redirectOutcome("?paid=..%2F..%2Fmerchants")).toBeNull();
  });

  it("captures when PayPal sends the shopper back, then returns to the chat", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ id: ORDER_ID, status: "COMPLETED" }));

    await expect(finishRedirect("return", `?checkout=${ORDER_ID}&token=PP-1&PayerID=BUYER`, fetchImpl)).resolves.toBe(`/?paid=${ORDER_ID}`);
    expect(fetchImpl).toHaveBeenCalledWith(`/api/orders/${ORDER_ID}/capture`, { method: "POST" });
  });

  it("cancels when the shopper backs out of PayPal", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ id: ORDER_ID, status: "CANCELLED" }));

    await expect(finishRedirect("cancel", `?checkout=${ORDER_ID}&token=PP-1`, fetchImpl)).resolves.toBe(`/?cancelled=${ORDER_ID}`);
    expect(fetchImpl).toHaveBeenCalledWith(`/api/orders/${ORDER_ID}/cancel`, { method: "POST" });
  });

  it("still returns to the chat when the capture call fails, where the order's real status shows", async () => {
    const down = async (): Promise<Response> => {
      throw new TypeError("Failed to fetch");
    };
    const refused = async () => Response.json({ error: { code: "paypal_unavailable" } }, { status: 502 });

    await expect(finishRedirect("return", `?checkout=${ORDER_ID}`, down)).resolves.toBe(`/?paid=${ORDER_ID}`);
    await expect(finishRedirect("return", `?checkout=${ORDER_ID}`, refused)).resolves.toBe(`/?paid=${ORDER_ID}`);
  });

  it("goes home without calling Tokento when the link has no valid order id", async () => {
    const fetchImpl = vi.fn(async () => Response.json({}));

    await expect(finishRedirect("return", "?token=PP-1", fetchImpl)).resolves.toBe("/");
    await expect(finishRedirect("cancel", "?checkout=not-an-id", fetchImpl)).resolves.toBe("/");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("afterPayPal", () => {
  it("asks the agent to confirm once PayPal has taken the payment", () => {
    expect(afterPayPal("paid", order("COMPLETED"))).toEqual({ autoSend: APPROVED_MESSAGE });
    expect(afterPayPal("paid", order("CAPTURE_PENDING"))).toEqual({ autoSend: APPROVED_MESSAGE });
  });

  it("says so when the shopper came back but the payment didn't go through", () => {
    expect(afterPayPal("paid", order("CREATED"))).toEqual({
      notice: { tone: "error", text: expect.stringContaining("didn't go through") },
    });
  });

  it("confirms a cancel: nothing charged, and the reward is back when one was held", () => {
    const withReward = order("CANCELLED", { reward: { tokenId: null, amount: 5, state: "released" } });
    expect(afterPayPal("cancelled", withReward)).toEqual({
      notice: { tone: "info", text: "You cancelled in PayPal. Nothing was charged, and your reward is back in your wallet." },
    });
    expect(afterPayPal("cancelled", order("CANCELLED"))).toEqual({
      notice: { tone: "info", text: "You cancelled in PayPal. Nothing was charged." },
    });
  });

  it("does nothing for an order it can't find", () => {
    expect(afterPayPal("paid", undefined)).toEqual({});
  });
});

describe("transcript helpers for the app shell", () => {
  it("refreshes checkout cards already in the chat without adding other orders", () => {
    let t = startTurn(emptyTranscript(), "Buy it");
    t = applyEvent(t, { type: "checkout", order: order("CREATED") });

    t = syncOrders(t, [order("COMPLETED"), { ...order("COMPLETED"), id: "another-order" } as CheckoutOrderView]);

    const cards = t.entries.filter((e) => e.kind === "checkout");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ order: { id: ORDER_ID, status: "COMPLETED" } });
  });

  it("adds a notice line in the given tone", () => {
    const t = addNotice(emptyTranscript(), "You cancelled in PayPal.", "info");
    expect(t.entries).toEqual([expect.objectContaining({ kind: "notice", text: "You cancelled in PayPal.", tone: "info" })]);
  });
});

describe("finishVaultRedirect", () => {
  it("confirms the saved PayPal after the one-time approval, then returns to the chat", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ vault: { status: "ACTIVE" } }));
    await expect(finishVaultRedirect("return", `?mandate=${ORDER_ID}&approval_token_id=X`, fetchImpl)).resolves.toBe("/?linked=1");
    expect(fetchImpl).toHaveBeenCalledWith(`/api/mandate/${ORDER_ID}/vault/confirm`, { method: "POST" });
  });

  it("says so when PayPal didn't confirm, and does nothing on cancel or a bad link", async () => {
    const refused = vi.fn(async () => Response.json({ error: { code: "vault_not_approved" } }, { status: 409 }));
    await expect(finishVaultRedirect("return", `?mandate=${ORDER_ID}`, refused)).resolves.toBe("/?linked=0");

    const fetchImpl = vi.fn(async () => Response.json({}));
    await expect(finishVaultRedirect("cancel", `?mandate=${ORDER_ID}`, fetchImpl)).resolves.toBe("/");
    await expect(finishVaultRedirect("return", "?mandate=nope", fetchImpl)).resolves.toBe("/");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
