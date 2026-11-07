// Plain-language view of a store's agent orders for the Overview page: how long
// ago, which colour a status is, where each order is in its life, and an activity
// feed anyone can read. Amounts come from Tokento's API; nothing is computed here
// except picking and wording.
import { CheckoutStatus, type CheckoutOrderView, type PayPalEventView, type SettlementView } from "@tokento/shared";

export type Tone = "success" | "warning" | "error" | "neutral";

export const usd = (value: number) => `$${value.toFixed(2)}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function relativeTime(iso: string, now: Date): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

const WAITING = new Set<string>([CheckoutStatus.PENDING, CheckoutStatus.CREATED, CheckoutStatus.APPROVED, CheckoutStatus.CAPTURED, CheckoutStatus.CAPTURE_PENDING, CheckoutStatus.REFUND_PENDING]);

export function statusTone(status: CheckoutOrderView["status"]): Tone {
  if (status === CheckoutStatus.COMPLETED) return "success";
  if (status === CheckoutStatus.NEEDS_REVIEW || status === CheckoutStatus.FAILED) return "error";
  if (WAITING.has(status)) return "warning";
  return "neutral";
}

export function latestOrder(orders: CheckoutOrderView[]): CheckoutOrderView | null {
  if (orders.length === 0) return null;
  return orders.reduce((best, o) => (o.createdAt > best.createdAt ? o : best));
}

export interface LifecycleStep {
  label: string;
  /** done, current (happening now), todo (not yet), off (will not happen). */
  state: "done" | "current" | "todo" | "off";
}

const APPROVED_OR_LATER = new Set<string>([
  CheckoutStatus.APPROVED, CheckoutStatus.CAPTURE_PENDING, CheckoutStatus.CAPTURED, CheckoutStatus.COMPLETED,
  CheckoutStatus.NEEDS_REVIEW, CheckoutStatus.REFUND_PENDING, CheckoutStatus.REFUNDED,
]);
const CONFIRMED = new Set<string>([CheckoutStatus.COMPLETED, CheckoutStatus.REFUND_PENDING, CheckoutStatus.REFUNDED]);

export function orderLifecycle(order: CheckoutOrderView): LifecycleStep[] {
  const s = order.status;
  const steps: LifecycleStep[] = [
    { label: "Agent picked your store", state: "done" },
    { label: order.reward ? "Reward held" : "No reward used", state: "done" },
  ];

  if (s === CheckoutStatus.CANCELLED) return [...steps, { label: order.reward ? "Cancelled, reward released" : "Cancelled", state: "off" }];
  if (s === CheckoutStatus.FAILED) return [...steps, { label: "PayPal payment failed", state: "off" }];

  const vault = order.paymentMode === "vault";
  steps.push({
    label: vault ? "Paid with saved PayPal" : "Shopper approved in PayPal",
    state: APPROVED_OR_LATER.has(s) || vault ? "done" : "current",
  });
  steps.push({
    label: s === CheckoutStatus.NEEDS_REVIEW ? "PayPal took a different amount" : "PayPal confirmed the payment",
    state: CONFIRMED.has(s) ? "done" : s === CheckoutStatus.NEEDS_REVIEW ? "off" : APPROVED_OR_LATER.has(s) ? "current" : "todo",
  });
  steps.push({ label: "Rewards updated", state: CONFIRMED.has(s) ? "done" : "todo" });

  if (s === CheckoutStatus.REFUNDED || s === CheckoutStatus.REFUND_PENDING) {
    const done = s === CheckoutStatus.REFUNDED;
    steps.push({ label: "Refunded to the shopper", state: done ? "done" : "current" });
    if (order.reward) steps.push({ label: "Reward given back", state: done ? "done" : "todo" });
    return steps;
  }

  const payout = order.settlement.state;
  steps.push({ label: "Paid out to you", state: payout === "paid" ? "done" : payout === "processing" ? "current" : "todo" });
  return steps;
}

export interface ActivityItem {
  id: string;
  actor: "agent" | "paypal" | "you";
  text: string;
  at: string;
  ago: string;
}

const EVENT_TEXT: Record<string, string> = {
  "CHECKOUT.ORDER.APPROVED": "Shopper approved a payment in PayPal",
  "PAYMENT.CAPTURE.COMPLETED": "PayPal confirmed a payment",
  "PAYMENT.CAPTURE.PENDING": "PayPal is reviewing a payment",
  "PAYMENT.CAPTURE.DENIED": "PayPal declined a payment",
  "PAYMENT.CAPTURE.REFUNDED": "PayPal confirmed a refund",
  "PAYMENT.CAPTURE.REVERSED": "PayPal reversed a payment",
};

function itemName(o: CheckoutOrderView): string {
  return `${o.quantity > 1 ? `${o.quantity} × ` : ""}${o.product.name}`;
}

function orderItems(o: CheckoutOrderView): Omit<ActivityItem, "ago">[] {
  const name = itemName(o);
  const items: Omit<ActivityItem, "ago">[] = [];
  const usedReward = o.reward && o.reward.state !== "released" ? ` using a ${usd(o.reward.amount)} reward` : "";
  let text: string;
  switch (o.status) {
    case CheckoutStatus.PENDING:
    case CheckoutStatus.CREATED:
    case CheckoutStatus.APPROVED:
      text = `Shopping agent started a ${usd(o.amountToPay)} order for ${name}. Waiting for the shopper to approve in PayPal`;
      break;
    case CheckoutStatus.CANCELLED:
      text = `An order for ${name} was cancelled before payment`;
      break;
    case CheckoutStatus.FAILED:
      text = `A PayPal payment for ${name} failed`;
      break;
    case CheckoutStatus.NEEDS_REVIEW:
      text = `PayPal took a different amount for ${name}. Check this order`;
      break;
    default:
      text = `Shopping agent bought ${name} for ${usd(o.amountToPay)}${usedReward}`;
  }
  items.push({ id: `order-${o.id}`, actor: "agent", text, at: o.createdAt });
  if (o.status === CheckoutStatus.REFUNDED && o.refundedAt) {
    items.push({
      id: `refund-${o.id}`,
      actor: "you",
      text: `You refunded ${usd(o.amountToPay)}${o.reward ? ". The shopper got their reward back" : ""}`,
      at: o.refundedAt,
    });
  }
  return items;
}

function payoutItem(p: SettlementView): Omit<ActivityItem, "ago"> {
  if (p.status === "SUCCESS") return { id: `payout-${p.id}`, actor: "paypal", text: `PayPal sent your payout of ${usd(p.net)}`, at: p.completedAt ?? p.createdAt };
  if (p.status === "DENIED" || p.status === "FAILED") return { id: `payout-${p.id}`, actor: "paypal", text: `Your payout of ${usd(p.net)} did not go through`, at: p.completedAt ?? p.createdAt };
  return { id: `payout-${p.id}`, actor: "you", text: `You started a payout of ${usd(p.net)}`, at: p.createdAt };
}

/** Orders, verified PayPal events and payouts as one feed, newest first. Payout webhooks are told by their payout. */
export function activityFeed(
  orders: CheckoutOrderView[],
  events: PayPalEventView[],
  payouts: SettlementView[],
  now: Date,
  limit = 8,
): ActivityItem[] {
  const all: Omit<ActivityItem, "ago">[] = [
    ...orders.flatMap(orderItems),
    ...events
      .filter((e) => EVENT_TEXT[e.eventType])
      .map((e) => ({ id: `event-${e.id}`, actor: "paypal" as const, text: EVENT_TEXT[e.eventType], at: e.receivedAt })),
    ...payouts.map(payoutItem),
  ];
  return all
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, limit)
    .map((item) => ({ ...item, ago: relativeTime(item.at, now) }));
}
