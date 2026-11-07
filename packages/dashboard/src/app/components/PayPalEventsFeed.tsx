"use client";

// Every PayPal webhook about this store's orders. Deliveries that fail PayPal's
// signature check are rejected before they're stored, so each row here is verified.
import type { PayPalEventView } from "@tokento/shared";
import { eventLabel } from "./agent-orders";

const STATE_LABEL: Record<PayPalEventView["state"], { text: string; dot: string }> = {
  processed: { text: "Done", dot: "dot-success" },
  retrying: { text: "Failed, PayPal will retry", dot: "dot-error" },
  received: { text: "Received", dot: "dot-warning pulse-dot" },
};

export function PayPalEventsFeed({ events, freshIds }: { events: PayPalEventView[] | null; freshIds: Set<string> }) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface-1">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <p className="text-[13px] text-text-muted">PayPal sends these when a shopper approves, a payment clears, a refund goes through or a payout lands. Each is checked with PayPal&apos;s signature API first.</p>
        {events && <p className="tabular font-mono text-xs text-text-muted">{events.length} shown</p>}
      </div>

      {events === null ? (
        <div className="skeleton m-4 h-16" />
      ) : events.length === 0 ? (
        <p className="p-4 text-sm text-text-muted">Nothing from PayPal yet. Messages appear here as PayPal confirms payments and refunds.</p>
      ) : (
        <ul className="divide-y divide-border">
          {events.map((e) => {
            const state = STATE_LABEL[e.state];
            return (
              <li key={e.id} className={`grid grid-cols-[88px_1fr_auto] items-center gap-3 px-4 py-3 text-sm ${freshIds.has(e.id) ? "ink-wash" : ""}`}>
                <span className="tabular font-mono text-xs text-text-muted">
                  {new Date(e.receivedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}
                </span>
                <span className="min-w-0">
                  <span className="font-medium">{eventLabel(e.eventType)}</span>
                  <span className="ml-2 font-mono text-[11px] text-text-muted">{e.eventType}</span>
                  {e.summary && <span className="block truncate text-xs text-text-secondary">{e.summary}</span>}
                </span>
                <span className="flex flex-col items-end gap-1 text-xs">
                  {e.verified && <span className="rounded-full border border-success/30 bg-success/10 px-2 py-0.5 font-medium text-success">Verified by PayPal</span>}
                  <span className="flex items-center gap-1.5 text-text-muted"><span className={`dot ${state.dot}`} />{state.text}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
