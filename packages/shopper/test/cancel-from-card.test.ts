import { describe, expect, it } from "vitest";
import type { CheckoutOrderView } from "@tokento/shared";
import { cancelFromCard } from "../src/lib/chat/client";

const ID = "3f6c2a8e-5b1d-4c7a-9e2f-1a2b3c4d5e6f";
const order = (status: string) => ({ id: ID, status }) as CheckoutOrderView;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fetchFrom(routes: Record<string, () => Response>) {
  const seen: string[] = [];
  const impl = async (url: string, init: RequestInit) => {
    const key = `${init.method ?? "GET"} ${url}`;
    seen.push(key);
    const route = routes[key];
    if (!route) throw new Error(`unexpected ${key}`);
    return route();
  };
  return { impl, seen };
}

describe("cancelFromCard", () => {
  it("cancels an order that is still waiting for PayPal", async () => {
    const { impl } = fetchFrom({ [`POST /api/orders/${ID}/cancel`]: () => json(200, order("CANCELLED")) });
    expect(await cancelFromCard(ID, impl)).toEqual({ order: order("CANCELLED"), notice: null });
  });

  it("shows the order's real state when PayPal already took the payment", async () => {
    const { impl, seen } = fetchFrom({
      [`POST /api/orders/${ID}/cancel`]: () => json(409, { error: { code: "not_cancellable", message: "Order is completed and can no longer be cancelled." } }),
      ["GET /api/orders"]: () => json(200, { orders: [order("COMPLETED")] }),
    });
    expect(await cancelFromCard(ID, impl)).toEqual({
      order: order("COMPLETED"),
      notice: { tone: "info", text: "PayPal already has this payment, so it can't be cancelled here." },
    });
    expect(seen).toEqual([`POST /api/orders/${ID}/cancel`, "GET /api/orders"]);
  });

  it("explains other refusals and keeps the card as it is", async () => {
    const { impl } = fetchFrom({ [`POST /api/orders/${ID}/cancel`]: () => json(403, { error: { code: "forbidden", message: "This order belongs to another shopper." } }) });
    expect(await cancelFromCard(ID, impl)).toEqual({ order: null, notice: { tone: "error", text: "This order belongs to another shopper." } });
  });

  it("says when the store can't be reached", async () => {
    const impl = async () => { throw new Error("offline"); };
    expect(await cancelFromCard(ID, impl)).toEqual({ order: null, notice: { tone: "error", text: "Couldn't reach the store. Try again." } });
  });
});
