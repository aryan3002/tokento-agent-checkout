// Pure helpers for the Agent orders tab: grid rows, the pinned totals row, the
// stat cards and the PayPal events feed. Every amount comes from Tokento's API.
// The only math here is adding figures up for display, done in whole cents so
// the totals are exact.
import type { CheckoutOrderView, PayPalEventView } from "@tokento/shared";

export interface AgentOrderRow {
  id: string;
  createdAt: string;
  shopper: string;
  product: string;
  quantity: number;
  subtotal: number;
  /** The shopper's reward applied to this order (held while PayPal waits). */
  rewardUsed: number | null;
  /** What PayPal took; null until PayPal has the money. */
  paid: number | null;
  /** The reward this purchase earned; null until it is issued. */
  earned: number | null;
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
  status: CheckoutOrderView["status"];
  statusLabel: string;
  settlementLabel: string;
  canRefund: boolean;
  agentReason: string | null;
}

export type TotalsRow = Pick<AgentOrderRow, "id" | "product" | "subtotal" | "rewardUsed" | "paid" | "earned">;

const STATUS_LABEL: Record<string, string> = {
  PENDING: "Starting",
  CREATED: "Waiting for PayPal",
  APPROVED: "Approved",
  CAPTURED: "Captured",
  CAPTURE_PENDING: "PayPal reviewing",
  COMPLETED: "Paid",
  REFUND_PENDING: "Refund pending",
  REFUNDED: "Refunded",
  NEEDS_REVIEW: "Needs review",
  CANCELLED: "Cancelled",
  FAILED: "Failed",
};

const SETTLEMENT_LABEL: Record<string, string> = {
  unsettled: "Unsettled",
  processing: "Paying out",
  paid: "Paid out",
  failed: "Payout failed",
};

/** Statuses where PayPal holds (or held) the shopper's money. */
const MONEY_CAPTURED = new Set(["CAPTURED", "COMPLETED", "NEEDS_REVIEW", "REFUND_PENDING", "REFUNDED"]);
/** Refunds are allowed once money is captured and not yet returned. */
const REFUNDABLE = new Set(["COMPLETED", "NEEDS_REVIEW"]);

export function maskShopper(customerId: string): string {
  return `•••• ${customerId.replace(/-/g, "").slice(-4)}`;
}

export function toOrderRow(order: CheckoutOrderView): AgentOrderRow {
  const rewardApplied = order.reward && (order.reward.state === "held" || order.reward.state === "redeemed");
  const earnedIssued = order.earned && (order.earned.state === "issued" || order.earned.state === "kept");
  return {
    id: order.id,
    createdAt: order.createdAt,
    shopper: maskShopper(order.customerId),
    product: order.product.name,
    quantity: order.quantity,
    subtotal: order.subtotal,
    rewardUsed: rewardApplied ? order.reward!.amount : null,
    paid: MONEY_CAPTURED.has(order.status) ? order.amountToPay : null,
    earned: earnedIssued ? order.earned!.amount : null,
    paypalOrderId: order.paypal.orderId,
    paypalCaptureId: order.paypal.captureId,
    status: order.status,
    statusLabel: STATUS_LABEL[order.status] ?? order.status,
    settlementLabel: order.status === "COMPLETED" ? SETTLEMENT_LABEL[order.settlement.state] ?? order.settlement.state : "—",
    canRefund: REFUNDABLE.has(order.status),
    agentReason: order.agentReason,
  };
}

const cents = (value: number | null | undefined) => (value === null || value === undefined ? 0 : Math.round(value * 100));
const dollars = (totalCents: number) => totalCents / 100;

/** The pinned bottom row: paid orders only, so cancelled or waiting orders never inflate the totals. */
export function orderTotals(rows: AgentOrderRow[]): TotalsRow {
  const paid = rows.filter((r) => r.status === "COMPLETED");
  const sum = (pick: (r: AgentOrderRow) => number | null) => dollars(paid.reduce((total, r) => total + cents(pick(r)), 0));
  return {
    id: "totals",
    product: `Paid orders: ${paid.length}`,
    subtotal: sum((r) => r.subtotal),
    rewardUsed: sum((r) => r.rewardUsed),
    paid: sum((r) => r.paid),
    earned: sum((r) => r.earned),
  };
}

export interface OrderStats {
  agentSales: number;
  paidWithPayPal: number;
  rewardsSpent: number;
  rewardsEarned: number;
  paidOrders: number;
}

export function orderStats(orders: CheckoutOrderView[]): OrderStats {
  const completed = orders.filter((o) => o.status === "COMPLETED");
  const total = (list: CheckoutOrderView[], pick: (o: CheckoutOrderView) => number) =>
    dollars(list.reduce((sum, o) => sum + cents(pick(o)), 0));
  return {
    agentSales: total(completed, (o) => o.subtotal),
    paidWithPayPal: total(completed, (o) => o.amountToPay),
    rewardsSpent: total(orders.filter((o) => o.reward?.state === "redeemed"), (o) => o.reward!.amount),
    rewardsEarned: total(orders.filter((o) => o.earned?.state === "issued" || o.earned?.state === "kept"), (o) => o.earned!.amount),
    paidOrders: completed.length,
  };
}

/** Replace an order already in the list (keeping its place) or put a new one first. */
export function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  return list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [item, ...list];
}

const EVENT_LABEL: Record<string, string> = {
  "CHECKOUT.ORDER.APPROVED": "Buyer approved",
  "PAYMENT.CAPTURE.COMPLETED": "Payment captured",
  "PAYMENT.CAPTURE.PENDING": "Capture pending",
  "PAYMENT.CAPTURE.DENIED": "Capture denied",
  "PAYMENT.CAPTURE.REFUNDED": "Refunded",
  "PAYMENT.CAPTURE.REVERSED": "Payment reversed",
  "PAYMENT.PAYOUTSBATCH.PROCESSING": "Payout processing",
  "PAYMENT.PAYOUTSBATCH.SUCCESS": "Payout sent",
  "PAYMENT.PAYOUTSBATCH.DENIED": "Payout denied",
};

export function eventLabel(eventType: string): string {
  return EVENT_LABEL[eventType] ?? eventType;
}

/** The SSE `paypal.webhook` message, sent after a verified event was processed. */
export interface PayPalWebhookMessage {
  merchantId: string;
  checkoutId?: string | null;
  eventId: string;
  eventType: string;
  summary?: string | null;
  action?: string;
  verified: boolean;
}

export function eventFromStream(message: PayPalWebhookMessage, receivedAt: string): PayPalEventView {
  return {
    id: message.eventId,
    eventType: message.eventType,
    summary: message.summary ?? null,
    checkoutId: message.checkoutId ?? null,
    verified: message.verified,
    state: "processed",
    receivedAt,
  };
}

/** A live event goes on top; a redelivery updates its row in place instead of adding another. */
export function prependEvent(list: PayPalEventView[], event: PayPalEventView, max: number): PayPalEventView[] {
  if (list.some((e) => e.id === event.id)) return list.map((e) => (e.id === event.id ? event : e));
  return [event, ...list].slice(0, max);
}
