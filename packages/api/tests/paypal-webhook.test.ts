// The PayPal webhook endpoint, end to end over HTTP, on a real Postgres.
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckoutStatus, EventType } from '@tokento/shared';
import { DbFixtures, prisma, type StoreFixture } from './helpers/db-fixtures';
import { createFakePayPal, type FakePayPal } from './helpers/fake-paypal-client';

const holder = vi.hoisted(() => ({ fake: undefined as unknown as FakePayPal }));
vi.mock('../src/checkout/paypal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/checkout/paypal')>();
  return { ...actual, getPayPal: () => holder.fake.client };
});

import paypalWebhookRoutes from '../src/routes/paypal-webhook.routes';
import { errorHandler } from '../src/middleware/error.middleware';
import { checkoutService } from '../src/checkout/checkout.service';
import { eventBus } from '../src/events/emitter';

const app = express();
app.use(express.json());
app.use('/api/v1/paypal/webhooks', paypalWebhookRoutes);
app.use(errorHandler());

const transmission = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77',
  'paypal-transmission-id': '103e3700-8b0c-11e6-8695-6b62a8a99ac4',
  'paypal-transmission-sig': 'dGVzdC1zaWduYXR1cmU=',
  'paypal-transmission-time': '2026-11-08T18:00:01Z',
};

const db = new DbFixtures();
let coffee: StoreFixture;
let seq = 0;

function captureEvent(type: string, order: { id: string; paypal: { orderId: string | null } }, amount = '23.00', status = 'COMPLETED') {
  seq += 1;
  return {
    id: `WH-${randomUUID()}`,
    event_version: '1.0',
    create_time: '2026-11-08T18:00:00.000Z',
    resource_type: 'capture',
    resource_version: '2.0',
    event_type: type,
    summary: `Payment ${status.toLowerCase()} for $ ${amount} USD`,
    resource: {
      id: `CAPTURE-WH-${randomUUID().slice(0, 8)}-${seq}`,
      status,
      amount: { currency_code: 'USD', value: amount },
      final_capture: true,
      custom_id: order.id,
      invoice_id: order.id,
      supplementary_data: { related_ids: { order_id: order.paypal.orderId } },
      create_time: '2026-11-08T18:00:00Z',
      update_time: '2026-11-08T18:00:00Z',
    },
  };
}

function approvedEvent(order: { id: string; paypal: { orderId: string | null } }) {
  return {
    id: `WH-${randomUUID()}`,
    event_version: '1.0',
    create_time: '2026-11-08T18:00:00.000Z',
    resource_type: 'checkout-order',
    resource_version: '2.0',
    event_type: 'CHECKOUT.ORDER.APPROVED',
    summary: 'An order has been approved by buyer',
    resource: {
      id: order.paypal.orderId,
      status: 'APPROVED',
      intent: 'CAPTURE',
      purchase_units: [{ reference_id: 'default', custom_id: order.id, amount: { currency_code: 'USD', value: '23.00' } }],
    },
  };
}

const post = (body: unknown) => request(app).post('/api/v1/paypal/webhooks').set(transmission).send(body as object);

async function openOrder() {
  const customerId = await db.shopper();
  const rewardId = await db.reward({ customerId, merchantId: coffee.merchantId, earnRuleId: coffee.ruleIds[0], denomination: 5, floor: 10 });
  const order = await checkoutService.create(customerId, {
    productId: coffee.products.beans, quantity: 1, useReward: true, paymentMode: 'auto',
  }, { isSandbox: true, idempotencyKey: randomUUID() });
  return { customerId, rewardId, order };
}

beforeAll(async () => {
  process.env.PAYPAL_WEBHOOK_ID = 'WH-ID-TEST';
  holder.fake = createFakePayPal();
  coffee = await db.store('Coffee Co. (webhook test)', {
    rules: [{ name: 'Spend $20, Get $5 Off', spendThreshold: 20, tokenDenomination: 5, minimumTransactionFloor: 10 }],
    products: [{ key: 'beans', name: 'Morning Ridge Blend, 2 lb', price: '28.00' }],
  });
});

afterAll(async () => {
  await db.cleanup();
});

beforeEach(() => {
  holder.fake.reset();
});

describe('POST /api/v1/paypal/webhooks', () => {
  it('rejects an event PayPal does not vouch for, and processes nothing', async () => {
    const { order } = await openOrder();
    holder.fake.setSignatureValid(false);
    const event = captureEvent('PAYMENT.CAPTURE.COMPLETED', order);

    const res = await post(event);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_signature');
    const [verifyInput] = holder.fake.callsTo('verifyWebhookSignature')[0].args as [any];
    expect(verifyInput.webhookId).toBe('WH-ID-TEST');
    expect(verifyInput.event).toEqual(event);
    expect(verifyInput.headers['paypal-transmission-id']).toBe(transmission['paypal-transmission-id']);
    expect(await prisma.paypalWebhookEvent.findUnique({ where: { id: event.id } })).toBeNull();
    expect((await prisma.checkoutOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(CheckoutStatus.CREATED);
  });

  it('completes the order from PAYMENT.CAPTURE.COMPLETED, and acknowledges a redelivery as a duplicate', async () => {
    const { order, rewardId } = await openOrder();
    const event = captureEvent('PAYMENT.CAPTURE.COMPLETED', order);

    const first = await post(event);
    const second = await post(event);

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ received: true, action: 'finalized' });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ received: true, duplicate: true });

    const row = await prisma.checkoutOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe(CheckoutStatus.COMPLETED);
    expect(row.paypalCaptureId).toBe(event.resource.id);
    expect(await prisma.redemption.count({ where: { tokenId: rewardId } })).toBe(1);
    expect(await prisma.paypalWebhookEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ verified: true, eventType: 'PAYMENT.CAPTURE.COMPLETED' });
  });

  it('CHECKOUT.ORDER.APPROVED captures an order the shopper approved but never came back to', async () => {
    const { order } = await openOrder();
    holder.fake.approve(order.paypal.orderId!);

    const res = await post(approvedEvent(order));
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('captured');
    expect((await prisma.checkoutOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(CheckoutStatus.COMPLETED);

    const again = await post(approvedEvent(order));
    expect(again.status).toBe(200);
    expect(holder.fake.callsTo('captureOrder')).toHaveLength(1);
  });

  it('PAYMENT.CAPTURE.DENIED fails the order and frees the reward', async () => {
    const { order } = await openOrder();

    const res = await post(captureEvent('PAYMENT.CAPTURE.DENIED', order, '23.00', 'DECLINED'));

    expect(res.status).toBe(200);
    const row = await prisma.checkoutOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe(CheckoutStatus.FAILED);
    expect(row.rewardTokenId).toBeNull();
  });

  it('acknowledges event types it does not act on', async () => {
    const event = { id: `WH-${randomUUID()}`, event_type: 'BILLING.SUBSCRIPTION.CREATED', resource_type: 'subscription', resource: { id: 'I-123' } };
    const res = await post(event);
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('ignored');
  });

  it('answers 500 when processing fails so PayPal retries, then processes the retry', async () => {
    const { order } = await openOrder();
    holder.fake.approve(order.paypal.orderId!);
    holder.fake.failNext('captureOrder');
    const event = approvedEvent(order);

    const failed = await post(event);
    expect(failed.status).toBe(500);
    const stored = await prisma.paypalWebhookEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(stored.processedAt).toBeNull();
    expect(stored.error).toBeTruthy();

    const retried = await post(event);
    expect(retried.status).toBe(200);
    expect(retried.body.action).toBe('captured');
    expect((await prisma.checkoutOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(CheckoutStatus.COMPLETED);
  });

  it('ignores captures for orders that are not Tokento checkouts', async () => {
    const res = await post(captureEvent('PAYMENT.CAPTURE.COMPLETED', { id: randomUUID(), paypal: { orderId: 'NOT-OURS' } }));
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('unknown_order');
  });

  it('tells the store dashboard a verified PayPal event arrived', async () => {
    const { order } = await openOrder();
    const seen: Array<Record<string, unknown>> = [];
    const listener = (payload: Record<string, unknown>) => seen.push(payload);
    eventBus.on(EventType.PAYPAL_WEBHOOK, listener);
    try {
      const event = captureEvent('PAYMENT.CAPTURE.COMPLETED', order);
      await post(event);
      expect(seen).toEqual([expect.objectContaining({
        merchantId: coffee.merchantId, eventId: event.id, eventType: 'PAYMENT.CAPTURE.COMPLETED', verified: true, checkoutId: order.id,
      })]);
    } finally {
      eventBus.off(EventType.PAYPAL_WEBHOOK, listener);
    }
  });
});
