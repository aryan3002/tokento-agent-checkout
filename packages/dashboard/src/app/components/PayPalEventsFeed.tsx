"use client";

// Every PayPal webhook about this store's orders. Deliveries that fail PayPal's
// signature check are rejected before they're stored, so each row here is verified.
import type { PayPalEventView } from "@tokento/shared";
import { eventLabel } from "./agent-orders";

const STATE_LABEL: Record<PayPalEventView["state"], { text: string; tone: string }> = {
  processed: { text: "Processed", tone: "text-success" },
  retrying: { text: "Failed, PayPal will retry", tone: "text-error" },
  received: { text: "Received", tone: "text-warning" },
};

export function PayPalEventsFeed({ events, freshIds }: { events: PayPalEventView[] | null; freshIds: Set<string> }) {
  return (
    <section className="glass p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="folio">PayPal webhooks</p>
          <p className="mt-1 text-xs text-text-muted">Each one checked with PayPal&apos;s verify-webhook-signature API before Tokento acts on it.</p>
        </div>
        {events && <p className="tabular font-mono text-xs text-text-muted">{events.length} shown</p>}
      </div>

      {events === null ? (
        <div className="skeleton mt-4 h-16" />
      ) : events.length === 0 ? (
        <p className="mt-4 text-sm text-text-muted">No PayPal webhooks yet. They appear here as PayPal confirms payments and refunds.</p>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {events.map((e) => {
            const state = STATE_LABEL[e.state];
            return (
              <li key={e.id} className={`grid grid-cols-[88px_1fr_auto] items-baseline gap-3 py-2 text-sm ${freshIds.has(e.id) ? "ink-wash" : ""}`}>
                <span className="tabular font-mono text-xs text-text-muted">
                  {new Date(e.receivedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}
                </span>
                <span className="min-w-0">
                  <span className="font-medium">{eventLabel(e.eventType)}</span>
                  <span className="ml-2 font-mono text-[11px] text-text-muted">{e.eventType}</span>
                  {e.summary && <span className="block truncate text-xs text-text-secondary">{e.summary}</span>}
                </span>
                <span className="text-right text-xs">
                  {e.verified && <span className="font-mono uppercase tracking-wider text-success">✓ Verified</span>}
                  <span className={`block ${state.tone}`}>{state.text}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
