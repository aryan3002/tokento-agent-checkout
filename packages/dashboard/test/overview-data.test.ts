import { describe, expect, it } from "vitest";
import { CheckoutStatus, type CheckoutOrderView, type PayPalEventView, type SettlementView } from "@tokento/shared";
import { activityFeed, latestOrder, orderLifecycle, relativeTime, statusTone } from "../src/app/components/overview-data";

const NOW = new Date("2026-11-07T12:00:00.000Z");

function order(over: Partial<CheckoutOrderView> = {}): CheckoutOrderView {
  return {
    id: "order-1",
    status: CheckoutStatus.COMPLETED,
    customerId: "11111111-1111-4111-8111-1111111114cb",
    merchant: { id: "m-1", name: "Coffee Co." },
    product: { id: "p-1", name: "Morning Ridge Blend, 2 lb", sku: "MRB-2LB" },
    quantity: 1,
    subtotal: 28,
    reward: { tokenId: "t-1", amount: 5, state: "redeemed" },
    amountToPay: 23,
    earned: { tokenId: "t-2", amount: 5, state: "issued" },
    paymentMode: "approval",
    outsideMandate: false,
    paypal: { orderId: "PP-ORDER-1", captureId: "PP-CAPTURE-1", refundId: null, approvalUrl: null },
    platformFee: 0.46,
    settlement: { batchId: null, state: "unsettled" },
    agentReason: "Best total value",
    note: null,
    receipt: "",
    createdAt: "2026-11-07T11:38:00.000Z",
    completedAt: "2026-11-07T11:38:42.000Z",
    refundedAt: null,
    ...over,
  } as CheckoutOrderView;
}

const states = (o: CheckoutOrderView) => orderLifecycle(o).map((s) => `${s.label}:${s.state}`);

describe("relativeTime", () => {
  it("reads like a person would say it", () => {
    expect(relativeTime("2026-11-07T11:59:40.000Z", NOW)).toBe("just now");
    expect(relativeTime("2026-11-07T11:38:00.000Z", NOW)).toBe("22m ago");
    expect(relativeTime("2026-11-07T09:00:00.000Z", NOW)).toBe("3h ago");
    expect(relativeTime("2026-11-05T12:00:00.000Z", NOW)).toBe("2d ago");
    expect(relativeTime("2026-10-20T12:00:00.000Z", NOW)).toBe("Oct 20");
  });
});

describe("statusTone", () => {
  it("is green for paid, amber while waiting, red for problems, gray when undone", () => {
    expect(statusTone(CheckoutStatus.COMPLETED)).toBe("success");
    expect(statusTone(CheckoutStatus.CREATED)).toBe("warning");
    expect(statusTone(CheckoutStatus.CAPTURE_PENDING)).toBe("warning");
    expect(statusTone(CheckoutStatus.NEEDS_REVIEW)).toBe("error");
    expect(statusTone(CheckoutStatus.FAILED)).toBe("error");
    expect(statusTone(CheckoutStatus.REFUNDED)).toBe("neutral");
    expect(statusTone(CheckoutStatus.CANCELLED)).toBe("neutral");
  });
});

describe("latestOrder", () => {
  it("is the newest order, or null when there are none", () => {
    const older = order({ id: "a", createdAt: "2026-11-07T09:00:00.000Z" });
    const newer = order({ id: "b", createdAt: "2026-11-07T11:00:00.000Z" });
    expect(latestOrder([older, newer])?.id).toBe("b");
    expect(latestOrder([])).toBeNull();
  });
});

describe("orderLifecycle", () => {
  it("walks a paid approval order up to the payout", () => {
    expect(states(order())).toEqual([
      "Agent picked your store:done",
      "Reward held:done",
      "Shopper approved in PayPal:done",
      "PayPal confirmed the payment:done",
      "Rewards updated:done",
      "Paid out to you:todo",
    ]);
    expect(states(order({ settlement: { batchId: "b-1", state: "paid" } })).at(-1)).toBe("Paid out to you:done");
    expect(states(order({ settlement: { batchId: "b-1", state: "processing" } })).at(-1)).toBe("Paid out to you:current");
  });

  it("shows where a waiting order is stuck", () => {
    const waiting = order({ status: CheckoutStatus.CREATED, paypal: { orderId: "PP-1", captureId: null, refundId: null, approvalUrl: "x" }, completedAt: null });
    expect(states(waiting)).toEqual([
      "Agent picked your store:done",
      "Reward held:done",
      "Shopper approved in PayPal:current",
      "PayPal confirmed the payment:todo",
      "Rewards updated:todo",
      "Paid out to you:todo",
    ]);
  });

  it("says when the shopper's saved PayPal paid with no approval, and when no reward was used", () => {
    const vault = order({ paymentMode: "vault", reward: null });
    expect(states(vault).slice(0, 3)).toEqual(["Agent picked your store:done", "No reward used:done", "Paid with saved PayPal:done"]);
  });

  it("ends a refunded order with the refund and the returned reward", () => {
    const refunded = order({ status: CheckoutStatus.REFUNDED, refundedAt: "2026-11-07T11:50:00.000Z", reward: { tokenId: "t-3", amount: 5, state: "reissued" } });
    expect(states(refunded).slice(-2)).toEqual(["Refunded to the shopper:done", "Reward given back:done"]);
    expect(states(refunded)).not.toContain("Paid out to you:todo");
  });

  it("stops a cancelled order and says the reward went back", () => {
    const cancelled = order({ status: CheckoutStatus.CANCELLED, reward: { tokenId: null, amount: 5, state: "released" }, completedAt: null, paypal: { orderId: "PP-1", captureId: null, refundId: null, approvalUrl: null } });
    expect(states(cancelled)).toEqual(["Agent picked your store:done", "Reward held:done", "Cancelled, reward released:off"]);
  });
});

describe("activityFeed", () => {
  const event = (over: Partial<PayPalEventView>): PayPalEventView => ({
    id: "e-1", eventType: "PAYMENT.CAPTURE.COMPLETED", summary: "Payment completed for $ 23.0 USD", checkoutId: "order-1",
    verified: true, state: "processed", receivedAt: "2026-11-07T11:38:44.000Z", ...over,
  });
  const payout = (over: Partial<SettlementView>): SettlementView => ({
    id: "s-1", status: "SUCCESS", orders: 1, gross: 23, fees: 0.46, refundAdjustments: 0, net: 22.54,
    receiverEmail: "store@example.com", paypalPayoutBatchId: "BATCH1", settlementRefs: [], error: null,
    createdAt: "2026-11-07T11:45:00.000Z", completedAt: "2026-11-07T11:45:42.000Z", ...over,
  } as SettlementView);

  it("tells the story newest first, in plain words, with who did it", () => {
    const feed = activityFeed([order()], [event({})], [payout({})], NOW);
    expect(feed.map((a) => [a.actor, a.text])).toEqual([
      ["paypal", "PayPal sent your payout of $22.54"],
      ["paypal", "PayPal confirmed a payment"],
      ["agent", "Shopping agent bought Morning Ridge Blend, 2 lb for $23.00 using a $5.00 reward"],
    ]);
    expect(feed[0].ago).toBe("14m ago");
  });

  it("explains waiting, refunded and cancelled orders", () => {
    const feed = activityFeed(
      [
        order({ id: "w", status: CheckoutStatus.CREATED, quantity: 2, createdAt: "2026-11-07T11:00:00.000Z" }),
        order({ id: "r", status: CheckoutStatus.REFUNDED, refundedAt: "2026-11-07T10:30:00.000Z", createdAt: "2026-11-07T10:00:00.000Z" }),
        order({ id: "c", status: CheckoutStatus.CANCELLED, reward: null, createdAt: "2026-11-07T09:00:00.000Z" }),
      ],
      [],
      [],
      NOW,
    );
    expect(feed.map((a) => a.text)).toEqual([
      "Shopping agent started a $23.00 order for 2 × Morning Ridge Blend, 2 lb. Waiting for the shopper to approve in PayPal",
      "You refunded $23.00. The shopper got their reward back",
      "Shopping agent bought Morning Ridge Blend, 2 lb for $23.00 using a $5.00 reward",
      "An order for Morning Ridge Blend, 2 lb was cancelled before payment",
    ]);
  });

  it("keeps the newest items up to the limit", () => {
    const orders = Array.from({ length: 12 }, (_, i) => order({ id: `o${i}`, createdAt: new Date(NOW.getTime() - i * 60_000).toISOString() }));
    expect(activityFeed(orders, [], [], NOW, 5)).toHaveLength(5);
  });
});
