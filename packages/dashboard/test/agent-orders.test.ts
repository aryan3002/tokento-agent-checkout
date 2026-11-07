import { describe, expect, it } from "vitest";
import { CheckoutStatus, type CheckoutOrderView, type PayPalEventView } from "@tokento/shared";
import {
  eventFromStream,
  eventLabel,
  maskShopper,
  orderStats,
  orderTotals,
  prependEvent,
  toOrderRow,
  upsertById,
} from "../src/app/components/agent-orders";

const MAYA = "11111111-1111-4111-8111-111111111111";

function order(over: Partial<CheckoutOrderView> = {}): CheckoutOrderView {
  return {
    id: "order-1",
    status: CheckoutStatus.COMPLETED,
    customerId: MAYA,
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
    createdAt: "2026-11-07T10:00:00.000Z",
    completedAt: "2026-11-07T10:01:00.000Z",
    refundedAt: null,
    ...over,
  } as CheckoutOrderView;
}

describe("agent order rows", () => {
  it("shows a paid order with the reward spent, the PayPal amount and the reward earned", () => {
    expect(toOrderRow(order())).toMatchObject({
      id: "order-1",
      product: "Morning Ridge Blend, 2 lb",
      subtotal: 28,
      rewardUsed: 5,
      paid: 23,
      earned: 5,
      paypalOrderId: "PP-ORDER-1",
      paypalCaptureId: "PP-CAPTURE-1",
      statusLabel: "Paid",
      settlementLabel: "Unsettled",
      canRefund: true,
    });
  });

  it("never shows the full shopper id", () => {
    expect(maskShopper(MAYA)).toBe("•••• 1111");
    expect(toOrderRow(order()).shopper).not.toContain(MAYA);
  });

  it("marks money that hasn't moved yet: nothing paid or earned while PayPal waits", () => {
    const row = toOrderRow(order({
      status: CheckoutStatus.CREATED,
      reward: { tokenId: "t-1", amount: 5, state: "held" },
      earned: { tokenId: null, amount: 5, state: "expected" },
      paypal: { orderId: "PP-ORDER-2", captureId: null, refundId: null, approvalUrl: "https://example.test/approve" },
    }));
    expect(row).toMatchObject({ rewardUsed: 5, paid: null, earned: null, statusLabel: "Waiting for PayPal", canRefund: false });
  });

  it("offers a refund only for orders with captured money", () => {
    expect(toOrderRow(order({ status: CheckoutStatus.NEEDS_REVIEW })).canRefund).toBe(true);
    for (const status of [CheckoutStatus.CANCELLED, CheckoutStatus.FAILED, CheckoutStatus.REFUNDED, CheckoutStatus.REFUND_PENDING, CheckoutStatus.CAPTURE_PENDING]) {
      expect(toOrderRow(order({ status })).canRefund).toBe(false);
    }
  });
});

describe("pinned totals", () => {
  it("adds up paid orders to the cent and leaves out unpaid ones", () => {
    const rows = [
      order({ id: "a", subtotal: 25.15, reward: { tokenId: "t", amount: 5.05, state: "redeemed" }, amountToPay: 20.1, earned: { tokenId: "e", amount: 5, state: "issued" } }),
      order({ id: "b", subtotal: 0.2, reward: null, amountToPay: 0.2, earned: null }),
      order({ id: "c", subtotal: 5.05, reward: null, amountToPay: 5.05, earned: null }),
      order({ id: "d", status: CheckoutStatus.CANCELLED, subtotal: 99, amountToPay: 99, reward: { tokenId: null, amount: 5, state: "released" }, earned: null }),
    ].map(toOrderRow);

    expect(orderTotals(rows)).toMatchObject({
      product: "Paid orders: 3",
      subtotal: 30.4,
      rewardUsed: 5.05,
      paid: 25.35,
      earned: 5,
    });
  });
});

describe("stat cards", () => {
  it("counts sales, PayPal money, rewards spent and earned from completed orders only", () => {
    const stats = orderStats([
      order({ id: "a" }),
      order({ id: "b", status: CheckoutStatus.REFUNDED, reward: { tokenId: "t", amount: 5, state: "reissued" }, earned: { tokenId: "e", amount: 5, state: "voided" } }),
      order({ id: "c", status: CheckoutStatus.CREATED, reward: { tokenId: "t", amount: 5, state: "held" }, earned: { tokenId: null, amount: 5, state: "expected" } }),
    ]);
    expect(stats).toEqual({ agentSales: 28, paidWithPayPal: 23, rewardsSpent: 5, rewardsEarned: 5, paidOrders: 1 });
  });
});

describe("live updates", () => {
  it("replaces an order already listed and puts a new one first", () => {
    const list = [order({ id: "a", status: CheckoutStatus.CREATED }), order({ id: "b" })];
    expect(upsertById(list, order({ id: "a", status: CheckoutStatus.COMPLETED })).map((o) => [o.id, o.status])).toEqual([["a", "COMPLETED"], ["b", "COMPLETED"]]);
    expect(upsertById(list, order({ id: "c" })).map((o) => o.id)).toEqual(["c", "a", "b"]);
  });
});

describe("PayPal events feed", () => {
  const event = (id: string, over: Partial<PayPalEventView> = {}): PayPalEventView => ({
    id, eventType: "PAYMENT.CAPTURE.COMPLETED", summary: null, checkoutId: "order-1", verified: true, state: "processed",
    receivedAt: "2026-11-07T10:01:00.000Z", ...over,
  });

  it("names PayPal's event types in plain words", () => {
    expect(eventLabel("CHECKOUT.ORDER.APPROVED")).toBe("Buyer approved");
    expect(eventLabel("PAYMENT.CAPTURE.COMPLETED")).toBe("Payment captured");
    expect(eventLabel("PAYMENT.CAPTURE.REFUNDED")).toBe("Refunded");
    expect(eventLabel("SOMETHING.NEW")).toBe("SOMETHING.NEW");
  });

  it("turns a live paypal.webhook message into a feed row", () => {
    const message = {
      merchantId: "m-1", checkoutId: "order-1", eventId: "WH-9", eventType: "CHECKOUT.ORDER.APPROVED",
      summary: "An order has been approved by buyer", action: "captured", verified: true,
    };
    expect(eventFromStream(message, "2026-11-07T10:05:00.000Z")).toEqual({
      id: "WH-9", eventType: "CHECKOUT.ORDER.APPROVED", summary: "An order has been approved by buyer", checkoutId: "order-1",
      verified: true, state: "processed", receivedAt: "2026-11-07T10:05:00.000Z",
    });
  });

  it("adds a live event on top once, even if PayPal redelivers it, and keeps the list short", () => {
    const list = [event("WH-1"), event("WH-2")];
    expect(prependEvent(list, event("WH-3"), 10).map((e) => e.id)).toEqual(["WH-3", "WH-1", "WH-2"]);
    expect(prependEvent(list, event("WH-1", { state: "retrying" }), 10).map((e) => e.id)).toEqual(["WH-1", "WH-2"]);
    expect(prependEvent(list, event("WH-3"), 2).map((e) => e.id)).toEqual(["WH-3", "WH-1"]);
  });
});
