// Verified PayPal webhooks that concern one store's orders, for the dashboard
// feed. Unverified deliveries are rejected before they are stored (see
// webhook-handler.ts), so every event listed here passed PayPal's signature check.
import type { PayPalEventView } from '@tokento/shared';
import prisma from '../db/client';

export async function listPayPalEventsForMerchant(merchantId: string, limit = 50): Promise<PayPalEventView[]> {
  // A webhook names a PayPal resource: the order, its capture or its refund.
  const orders = await prisma.checkoutOrder.findMany({
    where: { merchantId, paypalOrderId: { not: null } },
    select: { id: true, paypalOrderId: true, paypalCaptureId: true, paypalRefundId: true },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  const orderByResource = new Map<string, string>();
  for (const order of orders) {
    for (const resourceId of [order.paypalOrderId, order.paypalCaptureId, order.paypalRefundId]) {
      if (resourceId) orderByResource.set(resourceId, order.id);
    }
  }
  if (orderByResource.size === 0) return [];

  const events = await prisma.paypalWebhookEvent.findMany({
    where: { resourceId: { in: [...orderByResource.keys()] } },
    orderBy: { receivedAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 100),
  });
  return events.map((e) => ({
    id: e.id,
    eventType: e.eventType,
    summary: summaryOf(e.payload),
    checkoutId: e.resourceId ? orderByResource.get(e.resourceId) ?? null : null,
    verified: e.verified,
    state: e.processedAt ? 'processed' : e.error ? 'retrying' : 'received',
    receivedAt: e.receivedAt.toISOString(),
  }));
}

function summaryOf(payload: unknown): string | null {
  const summary = (payload as { summary?: unknown } | null)?.summary;
  return typeof summary === 'string' ? summary.slice(0, 200) : null;
}
