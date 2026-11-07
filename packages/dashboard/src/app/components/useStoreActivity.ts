"use client";

// The store's agent orders, verified PayPal events, payouts and agent comparison
// counts, loaded once and kept live from the dashboard's one event stream. Overview
// and PayPal activity read from here.
import { useCallback, useEffect, useState } from "react";
import type { AgentComparisonStats, CheckoutOrderView, PayPalEventView, SettlementPreview, SettlementView } from "@tokento/shared";
import { eventFromStream, prependEvent, upsertById, type PayPalWebhookMessage } from "./agent-orders";
import type { StreamEvent } from "./AgentOrdersTab";

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type Subscribe = (listener: (event: StreamEvent) => void) => () => void;

export interface StoreActivity {
  orders: CheckoutOrderView[] | null;
  events: PayPalEventView[] | null;
  payouts: SettlementView[] | null;
  owed: SettlementPreview | null;
  freshEventIds: Set<string>;
  /** null while loading. */
  comparisons: AgentComparisonStats | null;
  /** The counts couldn't be loaded; the card stays hidden rather than showing wrong numbers. */
  comparisonsFailed: boolean;
  /** True for a moment after a live comparison changed the counts. */
  comparisonsFresh: boolean;
  loadError: string | null;
  refreshPayouts: () => Promise<void>;
}

export function useStoreActivity(request: Request, subscribe: Subscribe): StoreActivity {
  const [orders, setOrders] = useState<CheckoutOrderView[] | null>(null);
  const [events, setEvents] = useState<PayPalEventView[] | null>(null);
  const [payouts, setPayouts] = useState<SettlementView[] | null>(null);
  const [owed, setOwed] = useState<SettlementPreview | null>(null);
  const [freshEventIds, setFreshEventIds] = useState<Set<string>>(() => new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [comparisons, setComparisons] = useState<AgentComparisonStats | null>(null);
  const [comparisonsFailed, setComparisonsFailed] = useState(false);
  const [comparisonsFresh, setComparisonsFresh] = useState(false);

  const loadComparisons = useCallback(
    () => request<AgentComparisonStats>("/api/v1/merchants/me/agent-comparisons"),
    [request],
  );

  const refreshPayouts = useCallback(async () => {
    const [preview, list] = await Promise.all([
      request<SettlementPreview>("/api/v1/merchants/me/settlements/preview"),
      request<{ settlements: SettlementView[] }>("/api/v1/merchants/me/settlements"),
    ]);
    setOwed(preview);
    setPayouts(list.settlements);
  }, [request]);

  useEffect(() => {
    let stale = false;
    request<{ orders: CheckoutOrderView[] }>("/api/v1/merchants/me/orders")
      .then((res) => { if (!stale) setOrders(res.orders); })
      .catch(() => { if (!stale) setLoadError("Couldn't load orders. Check that the Tokento API is running."); });
    request<{ events: PayPalEventView[] }>("/api/v1/merchants/me/paypal-events")
      .then((res) => { if (!stale) setEvents(res.events); })
      .catch(() => { if (!stale) setEvents([]); });
    void Promise.resolve()
      .then(refreshPayouts)
      .catch(() => { if (!stale) setPayouts([]); });
    loadComparisons()
      .then((res) => { if (!stale) setComparisons(res); })
      .catch(() => { if (!stale) setComparisonsFailed(true); });
    return () => { stale = true; };
  }, [request, refreshPayouts, loadComparisons]);

  useEffect(
    () =>
      subscribe(({ type, payload }) => {
        if (type === "paypal.webhook") {
          const event = eventFromStream(payload as unknown as PayPalWebhookMessage, new Date().toISOString());
          setEvents((prev) => prependEvent(prev ?? [], event, 50));
          setFreshEventIds((prev) => new Set(prev).add(event.id));
          setTimeout(() => setFreshEventIds((prev) => { const next = new Set(prev); next.delete(event.id); return next; }), 1600);
        }
        const checkoutId = typeof payload.checkoutId === "string" ? payload.checkoutId : null;
        if (checkoutId && (type.startsWith("checkout.") || type === "paypal.webhook")) {
          request<CheckoutOrderView>(`/api/v1/merchants/me/orders/${encodeURIComponent(checkoutId)}`)
            .then((order) => setOrders((prev) => upsertById(prev ?? [], order)))
            .catch(() => {});
        }
        if (type.startsWith("settlement.") || type === "checkout.completed" || type === "checkout.refunded") {
          refreshPayouts().catch(() => {});
        }
        if (type === "agent.compared") {
          loadComparisons()
            .then((res) => {
              setComparisons(res);
              setComparisonsFailed(false);
              setComparisonsFresh(true);
              setTimeout(() => setComparisonsFresh(false), 1600);
            })
            .catch(() => {});
        }
      }),
    [subscribe, request, refreshPayouts, loadComparisons],
  );

  return { orders, events, payouts, owed, freshEventIds, comparisons, comparisonsFailed, comparisonsFresh, loadError, refreshPayouts };
}
