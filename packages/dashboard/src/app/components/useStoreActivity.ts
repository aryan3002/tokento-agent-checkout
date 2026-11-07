"use client";

// The store's agent orders, verified PayPal events and payouts, loaded once and
// kept live from the dashboard's one event stream. Overview and PayPal activity
// read from here.
import { useCallback, useEffect, useState } from "react";
import type { CheckoutOrderView, PayPalEventView, SettlementPreview, SettlementView } from "@tokento/shared";
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
    return () => { stale = true; };
  }, [request, refreshPayouts]);

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
      }),
    [subscribe, request, refreshPayouts],
  );

  return { orders, events, payouts, owed, freshEventIds, loadError, refreshPayouts };
}
