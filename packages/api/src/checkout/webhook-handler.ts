// ============================================================
// Tokento — PayPal webhooks
// ============================================================
// Verify with PayPal → store by event id (redeliveries are recognised) →
// dispatch → mark processed. A processing error answers 500 so PayPal
// redelivers; every handler is idempotent, so a retry is safe.
import { Prisma } from '@prisma/client';
import { EventType } from '@tokento/shared';
import type { IncomingHttpHeaders } from 'http';
import prisma from '../db/client';
import { emitEvent } from '../events/emitter';
import { logger } from '../utils/logger';
import { checkoutService } from './checkout.service';
import { finalizeCapture } from './finalize';
import { applyRefund } from './refund';
import { getPayPal } from './paypal';

export interface PayPalWebhookEvent {
  id: string;
  event_type: string;
  resource_type?: string;
  summary?: string;
  resource?: Record<string, any>;
}

export interface HandlerOutcome {
  action: string;
  checkoutId?: string;
  merchantId?: string;
}

export type WebhookHandler = (event: PayPalWebhookEvent) => Promise<HandlerOutcome>;

export interface WebhookResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The checkout a capture belongs to: our id in custom_id, else PayPal's order id. */
async function orderForCapture(resource: Record<string, any> | undefined) {
  const customId = typeof resource?.custom_id === 'string' && UUID.test(resource.custom_id) ? resource.custom_id : null;
  if (customId) {
    const byId = await prisma.checkoutOrder.findUnique({ where: { id: customId }, select: { id: true, merchantId: true } });
    if (byId) return byId;
  }
  const paypalOrderId = resource?.supplementary_data?.related_ids?.order_id;
  if (typeof paypalOrderId === 'string') {
    return prisma.checkoutOrder.findUnique({ where: { paypalOrderId }, select: { id: true, merchantId: true } });
  }
  return null;
}

async function onCaptureEvent(event: PayPalWebhookEvent): Promise<HandlerOutcome> {
  const resource = event.resource ?? {};
  const order = await orderForCapture(resource);
  if (!order) return { action: 'unknown_order' };
  await finalizeCapture(order.id, {
    captureId: String(resource.id),
    status: String(resource.status ?? (event.event_type === 'PAYMENT.CAPTURE.COMPLETED' ? 'COMPLETED' : 'DECLINED')),
    amount: String(resource.amount?.value ?? ''),
    currency: String(resource.amount?.currency_code ?? ''),
  }, 'webhook');
  return { action: 'finalized', checkoutId: order.id, merchantId: order.merchantId };
}

async function onOrderApproved(event: PayPalWebhookEvent): Promise<HandlerOutcome> {
  const paypalOrderId = event.resource?.id;
  if (typeof paypalOrderId !== 'string') return { action: 'unknown_order' };
  const order = await prisma.checkoutOrder.findUnique({ where: { paypalOrderId }, select: { id: true, merchantId: true } });
  if (!order) return { action: 'unknown_order' };
  // The shopper approved; capture now in case their browser never comes back.
  await checkoutService.capture(order.id, { kind: 'system', source: 'webhook' });
  return { action: 'captured', checkoutId: order.id, merchantId: order.merchantId };
}

/** The checkout a refund belongs to: our id in custom_id, else the capture it points `up` to. */
async function orderForRefund(resource: Record<string, any> | undefined) {
  const customId = typeof resource?.custom_id === 'string' && UUID.test(resource.custom_id) ? resource.custom_id : null;
  if (customId) {
    const byId = await prisma.checkoutOrder.findUnique({ where: { id: customId }, select: { id: true, merchantId: true } });
    if (byId) return byId;
  }
  const up = Array.isArray(resource?.links) ? resource.links.find((l: { rel?: string }) => l?.rel === 'up') : null;
  const captureId = typeof up?.href === 'string' ? up.href.split('/').pop() : null;
  if (captureId) {
    return prisma.checkoutOrder.findUnique({ where: { paypalCaptureId: captureId }, select: { id: true, merchantId: true } });
  }
  return null;
}

async function onRefundEvent(event: PayPalWebhookEvent): Promise<HandlerOutcome> {
  const resource = event.resource ?? {};
  const order = await orderForRefund(resource);
  if (!order) return { action: 'unknown_order' };
  await applyRefund(order.id, {
    refundId: String(resource.id),
    status: String(resource.status ?? 'COMPLETED'),
    amount: String(resource.amount?.value ?? ''),
  }, 'webhook');
  return { action: 'refunded', checkoutId: order.id, merchantId: order.merchantId };
}

/** Event type → handler. Payouts handlers register themselves here. */
export const webhookHandlers: Record<string, WebhookHandler> = {
  'CHECKOUT.ORDER.APPROVED': onOrderApproved,
  'PAYMENT.CAPTURE.COMPLETED': onCaptureEvent,
  'PAYMENT.CAPTURE.PENDING': onCaptureEvent,
  'PAYMENT.CAPTURE.DENIED': onCaptureEvent,
  'PAYMENT.CAPTURE.DECLINED': onCaptureEvent,
  'PAYMENT.CAPTURE.REFUNDED': onRefundEvent,
  'PAYMENT.CAPTURE.REVERSED': onRefundEvent,
};

function parseEvent(body: unknown): PayPalWebhookEvent | null {
  if (!body || typeof body !== 'object') return null;
  const e = body as Record<string, unknown>;
  if (typeof e.id !== 'string' || typeof e.event_type !== 'string') return null;
  return e as unknown as PayPalWebhookEvent;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export async function receivePayPalWebhook(input: { headers: IncomingHttpHeaders; body: unknown }): Promise<WebhookResult> {
  const event = parseEvent(input.body);
  if (!event) {
    return { httpStatus: 400, body: { error: { code: 'invalid_event', message: 'Not a PayPal webhook event.' } } };
  }

  let verified: boolean;
  try {
    verified = await getPayPal().verifyWebhookSignature({
      headers: input.headers,
      event: input.body,
      webhookId: process.env.PAYPAL_WEBHOOK_ID || '',
    });
  } catch (err) {
    logger.error({ err, eventId: event.id }, 'Could not verify PayPal webhook; asking PayPal to retry');
    return { httpStatus: 503, body: { error: { code: 'verification_unavailable', message: 'Could not verify the event right now.' } } };
  }
  if (!verified) {
    logger.warn({ eventId: event.id, eventType: event.event_type }, 'Rejected PayPal webhook with an unverified signature');
    return { httpStatus: 400, body: { error: { code: 'invalid_signature', message: 'Webhook signature verification failed.' } } };
  }

  const existing = await prisma.paypalWebhookEvent.findUnique({ where: { id: event.id } });
  if (existing?.processedAt) {
    return { httpStatus: 200, body: { received: true, duplicate: true } };
  }
  if (!existing) {
    try {
      await prisma.paypalWebhookEvent.create({
        data: {
          id: event.id,
          eventType: event.event_type,
          resourceId: typeof event.resource?.id === 'string' ? event.resource.id : null,
          verified: true,
          payload: input.body as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      // A concurrent delivery stored it first; both may process, and handlers are idempotent.
      if (!isUniqueViolation(err)) throw err;
    }
  }
  // An existing, unprocessed row means an earlier delivery failed: process it again.

  const handler = webhookHandlers[event.event_type];
  try {
    const outcome = handler ? await handler(event) : { action: 'ignored' };
    await prisma.paypalWebhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), error: null } });
    if (outcome.merchantId) {
      emitEvent(EventType.PAYPAL_WEBHOOK, {
        merchantId: outcome.merchantId,
        checkoutId: outcome.checkoutId,
        eventId: event.id,
        eventType: event.event_type,
        summary: event.summary ?? null,
        action: outcome.action,
        verified: true,
      });
    }
    logger.info({ eventId: event.id, eventType: event.event_type, action: outcome.action }, 'PayPal webhook processed');
    return { httpStatus: 200, body: { received: true, action: outcome.action } };
  } catch (err) {
    const message = (err as Error).message ?? 'unknown error';
    await prisma.paypalWebhookEvent
      .update({ where: { id: event.id }, data: { error: message.slice(0, 500) } })
      .catch((updateErr: unknown) => logger.error({ err: updateErr }, 'Could not record webhook error'));
    logger.error({ err, eventId: event.id, eventType: event.event_type }, 'PayPal webhook processing failed; PayPal will retry');
    return { httpStatus: 500, body: { error: { code: 'webhook_processing_failed', message: 'Could not process the event; PayPal will retry.' } } };
  }
}
