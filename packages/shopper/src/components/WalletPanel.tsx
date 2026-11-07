"use client";

// Sidebar: the shopper's rewards (read through Tokento's Token Query Interface)
// and recent agent orders.
import type { CheckoutOrderView } from "@tokento/shared";
import type { RewardSummary } from "@/lib/agent/events";
import { usd } from "@/lib/format";

const STATUS_LABEL: Record<string, string> = {
  CREATED: "Waiting for PayPal",
  APPROVED: "Approved",
  CAPTURE_PENDING: "PayPal reviewing",
  COMPLETED: "Paid",
  REFUNDED: "Refunded",
  REFUND_PENDING: "Refund pending",
  CANCELLED: "Cancelled",
  FAILED: "Failed",
  NEEDS_REVIEW: "In review",
};

export function WalletPanel({
  name,
  rewards,
  totalValue,
  orders,
}: {
  name: string;
  rewards: RewardSummary[] | null;
  totalValue: number | null;
  orders: CheckoutOrderView[] | null;
}) {
  return (
    <aside className="space-y-6">
      <section className="glass p-4">
        <div className="flex items-baseline justify-between">
          <p className="folio">{name === "Your" ? "Your rewards" : `${name}'s rewards`}</p>
          {totalValue !== null && <p className="tabular font-mono text-sm">{usd(totalValue)}</p>}
        </div>
        {rewards === null ? (
          <div className="skeleton mt-3 h-12 rounded-md" />
        ) : rewards.length === 0 ? (
          <p className="mt-3 text-sm text-text-muted">No rewards right now.</p>
        ) : (
          <ul className="stagger-children mt-3 space-y-2">
            {rewards.map((r) => (
              <li key={r.rewardId} className="animate-slide-up flex items-start justify-between gap-3 border-t border-border pt-2 first:border-0 first:pt-0">
                <div>
                  <p className="text-sm font-medium">{r.store}</p>
                  <p className="text-xs text-text-muted">
                    {r.minimumOrder > 0 ? `Orders of ${usd(r.minimumOrder)}+ · ` : ""}expires {r.expiresOn}
                  </p>
                </div>
                <p className="tabular font-mono text-sm text-success">{usd(r.amount)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="glass p-4">
        <p className="folio">Recent agent orders</p>
        {orders === null ? (
          <div className="skeleton mt-3 h-12 rounded-md" />
        ) : orders.length === 0 ? (
          <p className="mt-3 text-sm text-text-muted">Nothing yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {orders.slice(0, 6).map((o) => (
              <li key={o.id} className="flex items-start justify-between gap-3 border-t border-border pt-2 first:border-0 first:pt-0">
                <div className="min-w-0">
                  <p className="truncate text-sm">{o.product.name}</p>
                  <p className="flex items-center gap-1.5 text-xs text-text-muted"><span className={`dot ${o.status === "COMPLETED" ? "dot-success" : o.status === "CANCELLED" || o.status === "REFUNDED" ? "dot-neutral" : o.status === "FAILED" || o.status === "NEEDS_REVIEW" ? "dot-error" : "dot-warning"}`} />{o.merchant.name} · {STATUS_LABEL[o.status] ?? o.status}</p>
                </div>
                <p className={`tabular font-mono text-sm ${o.status === "CANCELLED" || o.status === "FAILED" ? "text-text-muted line-through" : ""}`}>{usd(o.amountToPay)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="px-1 text-xs leading-relaxed text-text-muted">
        Sandbox demo. Payments use PayPal&apos;s sandbox; no real money moves. Stores and people are fictional.
      </p>
    </aside>
  );
}
