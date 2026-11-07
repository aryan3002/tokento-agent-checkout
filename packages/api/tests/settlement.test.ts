// Paying stores through PayPal Payouts. Real Postgres; only PayPal is faked.
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckoutStatus } from '@tokento/shared';
import { DbFixtures, prisma, type StoreFixture } from './helpers/db-fixtures';
import { createFakePayPal, type FakePayPal } from './helpers/fake-paypal-client';

const holder = vi.hoisted(() => ({ fake: undefined as unknown as FakePayPal }));
vi.mock('../src/checkout/paypal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/checkout/paypal')>();
  return { ...actual, getPayPal: () => holder.fake.client };
});

import merchantRoutes from '../src/routes/merchant.routes';
import { errorHandler } from '../src/middleware/error.middleware';
import { settlementService } from '../src/settlement/settlement.service';
import { receivePayPalWebhook, webhookHandlers } from '../src/checkout/webhook-handler';
import { listPayPalEventsForMerchant } from '../src/checkout/paypal-events';

const app = express();
app.use(express.json());
app.use('/api/v1/merchants', merchantRoutes);
app.use(errorHandler());

const db = new DbFixtures();
const tag = randomUUID().slice(0, 6);
const D = (v: string) => new Prisma.Decimal(v);

async function store(name: string, payoutEmail: string | null = `store-${randomUUID().slice(0, 8)}@business.example.com`): Promise<StoreFixture> {
  return db.store(`${name} ${tag}`, { products: [{ key: 'beans', name: `Beans ${name} ${tag}`, price: '28.00' }], ...(payoutEmail ? { payoutEmail } : {}) });
}

async function order(s: StoreFixture, status: CheckoutStatus, paid: string, fee: string, over: Partial<Prisma.CheckoutOrderUncheckedCreateInput> = {}) {
  const customerId = await db.shopper();
  return prisma.checkoutOrder.create({
    data: {
      customerId,
      merchantId: s.merchantId,
      productId: s.products.beans,
      subtotal: D(paid),
      amountToPay: D(paid),
      platformFee: D(fee),
      status,
      idempotencyKey: randomUUID(),
      redemptionSettlementRef: `stl_${randomUUID().slice(0, 12)}`,
      ...over,
    },
  });
}

beforeAll(() => {
  holder.fake = createFakePayPal();
});

afterAll(async () => {
  await db.cleanup();
});

beforeEach(() => {
  holder.fake.reset();
});

describe('settlement preview', () => {
  it('adds up what the store is owed to the cent: paid minus Tokento fees, completed and unsettled orders only', async () => {
    const s = await store('Preview');
    const other = await store('Other');
    await order(s, CheckoutStatus.COMPLETED, '23.00', '0.46');
    await order(s, CheckoutStatus.COMPLETED, '20.10', '0.40');
    await order(s, CheckoutStatus.COMPLETED, '0.20', '0.00');
    await order(s, CheckoutStatus.CREATED, '50.00', '0.00');
    await order(s, CheckoutStatus.CANCELLED, '50.00', '0.00');
    await order(s, CheckoutStatus.REFUNDED, '50.00', '1.00');
    await order(other, CheckoutStatus.COMPLETED, '99.00', '1.98');

    expect(await settlementService.preview(s.merchantId)).toMatchObject({ orders: 3, gross: 43.3, fees: 0.86, refundAdjustments: 0, net: 42.44, payable: true });
  });
});

describe('settle', () => {
  it('pays the store through one PayPal Payouts batch, claims its orders, and finds nothing new on a second run', async () => {
    const s = await store('Settle');
    const a = await order(s, CheckoutStatus.COMPLETED, '23.00', '0.46');
    const b = await order(s, CheckoutStatus.COMPLETED, '23.00', '0.46');

    const batch = await settlementService.settle(s.merchantId);

    expect(batch).toMatchObject({ status: 'PROCESSING', orders: 2, gross: 46, fees: 0.92, net: 45.08 });
    expect(batch.paypalPayoutBatchId).toBeTruthy();
    expect(batch.settlementRefs.sort()).toEqual([a.redemptionSettlementRef, b.redemptionSettlementRef].sort());
    const [input] = holder.fake.callsTo('createPayoutBatch')[0].args as [{ senderBatchId: string; items: Array<{ amount: string; receiverEmail: string }> }];
    expect(input.senderBatchId).toBe(batch.id);
    expect(input.items).toEqual([expect.objectContaining({ amount: '45.08', receiverEmail: expect.stringContaining('@business.example.com') })]);
    expect((await prisma.checkoutOrder.findUniqueOrThrow({ where: { id: a.id } })).settlementId).toBe(batch.id);

    await expect(settlementService.settle(s.merchantId)).rejects.toMatchObject({ statusCode: 409, code: 'nothing_to_settle' });
    expect(holder.fake.callsTo('createPayoutBatch')).toHaveLength(1);
  });

  it('nets a refund made after the store was paid against the next batch', async () => {
    const s = await store('Netting');
    const a = await order(s, CheckoutStatus.COMPLETED, '23.00', '0.46');
    await settlementService.settle(s.merchantId);
    await prisma.checkoutOrder.update({ where: { id: a.id }, data: { status: CheckoutStatus.REFUNDED } });

    // The store already got $22.54 for A; a new $23.00 order exactly covers it, so nothing is owed yet.
    await order(s, CheckoutStatus.COMPLETED, '23.00', '0.46');
    expect(await settlementService.preview(s.merchantId)).toMatchObject({ gross: 23, refundAdjustments: 22.54, net: 0, payable: false });
    await expect(settlementService.settle(s.merchantId)).rejects.toMatchObject({ code: 'nothing_to_settle' });

    await order(s, CheckoutStatus.COMPLETED, '10.00', '0.20');
    const second = await settlementService.settle(s.merchantId);
    expect(second).toMatchObject({ gross: 33, fees: 0.66, refundAdjustments: 22.54, net: 9.8 });
    expect((await prisma.checkoutOrder.findUniqueOrThrow({ where: { id: a.id } })).refundNettedSettlementId).toBe(second.id);
  });

  it('marks the batch failed and releases its orders when PayPal refuses the payout', async () => {
    const s = await store('Failure');
    const a = await order(s, CheckoutStatus.COMPLETED, '23.00', '0.46');
    holder.fake.failNext('createPayoutBatch');

    await expect(settlementService.settle(s.merchantId)).rejects.toMatchObject({ statusCode: 502, code: 'paypal_unavailable' });

    const failed = await prisma.settlementBatch.findFirstOrThrow({ where: { merchantId: s.merchantId } });
    expect(failed.status).toBe('FAILED');
    expect((await prisma.checkoutOrder.findUniqueOrThrow({ where: { id: a.id } })).settlementId).toBeNull();
    expect(await settlementService.settle(s.merchantId)).toMatchObject({ status: 'PROCESSING', orders: 1 });
  });

  it('refuses to pay a store with no PayPal payout email', async () => {
    const s = await store('NoEmail', null);
    await order(s, CheckoutStatus.COMPLETED, '23.00', '0.46');
    await expect(settlementService.settle(s.merchantId)).rejects.toMatchObject({ statusCode: 409, code: 'payout_email_missing' });
    expect(holder.fake.callsTo('createPayoutBatch')).toHaveLength(0);
  });
});

describe('payout webhooks', () => {
  const payoutEvent = (type: string, payoutBatchId: string) =>
    ({ id: `WH-${randomUUID()}`, event_type: type, resource: { batch_header: { payout_batch_id: payoutBatchId, batch_status: type.split('.').pop() } } }) as never;

  it('marks the batch paid on PAYMENT.PAYOUTSBATCH.SUCCESS', async () => {
    const s = await store('Webhook');
    const a = await order(s, CheckoutStatus.COMPLETED, '23.00', '0.46');
    const batch = await settlementService.settle(s.merchantId);

    const outcome = await webhookHandlers['PAYMENT.PAYOUTSBATCH.SUCCESS'](payoutEvent('PAYMENT.PAYOUTSBATCH.SUCCESS', batch.paypalPayoutBatchId!));

    expect(outcome).toMatchObject({ merchantId: s.merchantId });
    const stored = await prisma.settlementBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(stored.status).toBe('SUCCESS');
    expect(stored.completedAt).not.toBeNull();
    expect((await prisma.checkoutOrder.findUniqueOrThrow({ where: { id: a.id } })).settlementId).toBe(batch.id);
  });

  it('releases the orders when PayPal denies the payout, so the next run pays them', async () => {
    const s = await store('Denied');
    const a = await order(s, CheckoutStatus.COMPLETED, '23.00', '0.46');
    const batch = await settlementService.settle(s.merchantId);

    await webhookHandlers['PAYMENT.PAYOUTSBATCH.DENIED'](payoutEvent('PAYMENT.PAYOUTSBATCH.DENIED', batch.paypalPayoutBatchId!));

    expect((await prisma.settlementBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe('DENIED');
    expect((await prisma.checkoutOrder.findUniqueOrThrow({ where: { id: a.id } })).settlementId).toBeNull();
  });
});

describe('payout webhooks in the store feed', () => {
  it("stores a verified payout event under its payout batch id, so the store's feed shows it", async () => {
    const s = await store('Feed');
    await order(s, CheckoutStatus.COMPLETED, '23.00', '0.46');
    const batch = await settlementService.settle(s.merchantId);
    const eventId = `WH-${randomUUID()}`;

    const res = await receivePayPalWebhook({
      headers: {},
      body: { id: eventId, event_type: 'PAYMENT.PAYOUTSBATCH.SUCCESS', summary: 'Payouts batch completed successfully.', resource: { batch_header: { payout_batch_id: batch.paypalPayoutBatchId, batch_status: 'SUCCESS' } } },
    });

    expect(res.httpStatus).toBe(200);
    const feed = await listPayPalEventsForMerchant(s.merchantId);
    expect(feed).toContainEqual(expect.objectContaining({ id: eventId, eventType: 'PAYMENT.PAYOUTSBATCH.SUCCESS', verified: true, state: 'processed', checkoutId: null }));
    await prisma.paypalWebhookEvent.delete({ where: { id: eventId } });
  });
});

describe('settlement routes', () => {
  it('a store previews, settles and lists only its own payouts', async () => {
    const s = await store('Routes');
    const other = await store('RoutesOther');
    await order(s, CheckoutStatus.COMPLETED, '23.00', '0.46');
    const key = await db.apiKey(s.merchantId);
    const otherKey = await db.apiKey(other.merchantId);

    const preview = await request(app).get('/api/v1/merchants/me/settlements/preview').set('X-API-Key', key);
    expect(preview.body).toMatchObject({ orders: 1, net: 22.54, payable: true });

    const settled = await request(app).post('/api/v1/merchants/me/settlements').set('X-API-Key', key);
    expect(settled.status).toBe(201);

    const mine = await request(app).get('/api/v1/merchants/me/settlements').set('X-API-Key', key);
    const theirs = await request(app).get('/api/v1/merchants/me/settlements').set('X-API-Key', otherKey);
    expect(mine.body.settlements.map((b: { id: string }) => b.id)).toEqual([settled.body.id]);
    expect(theirs.body.settlements).toEqual([]);
  });
});
