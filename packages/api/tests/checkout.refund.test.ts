// Refunds against a real Postgres, with PayPal faked.
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckoutStatus, EventType, TokenStatus } from '@tokento/shared';
import { DbFixtures, prisma, type StoreFixture } from './helpers/db-fixtures';
import { createFakePayPal, type FakePayPal } from './helpers/fake-paypal-client';

const holder = vi.hoisted(() => ({ fake: undefined as unknown as FakePayPal }));
vi.mock('../src/checkout/paypal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/checkout/paypal')>();
  return { ...actual, getPayPal: () => holder.fake.client };
});

import { checkoutService } from '../src/checkout/checkout.service';
import { applyRefund, refundOrder } from '../src/checkout/refund';
import { receivePayPalWebhook } from '../src/checkout/webhook-handler';
import { redemptionService } from '../src/services/redemption.service';
import { validationService } from '../src/services/validation.service';
import { eventBus } from '../src/events/emitter';

const db = new DbFixtures();
let coffee: StoreFixture;
let harbor: StoreFixture;

/** A shopper who bought the $28 beans with a $5 reward, paid $23 and earned a new $5 reward. */
async function completedOrder() {
  const customerId = await db.shopper();
  const rewardId = await db.reward({ customerId, merchantId: coffee.merchantId, earnRuleId: coffee.ruleIds[0], denomination: 5, floor: 10 });
  const open = await checkoutService.create(customerId, {
    productId: coffee.products.beans, quantity: 1, useReward: true, paymentMode: 'auto',
  }, { isSandbox: true, idempotencyKey: randomUUID() });
  holder.fake.approve(open.paypal.orderId!);
  const order = await checkoutService.capture(open.id, { kind: 'customer', customerId });
  expect(order.status).toBe(CheckoutStatus.COMPLETED);
  return { customerId, rewardId, order };
}

beforeAll(async () => {
  process.env.PAYPAL_WEBHOOK_ID = 'WH-ID-TEST';
  holder.fake = createFakePayPal();
  coffee = await db.store('Coffee Co. (refund test)', {
    rules: [{ name: 'Spend $20, Get $5 Off', spendThreshold: 20, tokenDenomination: 5, minimumTransactionFloor: 10 }],
    products: [{ key: 'beans', name: 'Morning Ridge Blend, 2 lb', price: '28.00' }],
  });
  harbor = await db.store('Harbor (refund test)', { products: [{ key: 'beans', name: 'House blend', price: '25.00' }] });
});

afterAll(async () => {
  await db.cleanup();
});

beforeEach(() => {
  holder.fake.reset();
});

describe('refundOrder', () => {
  it('refunds through PayPal, gives the spent reward back as a valid new token, and voids the unused earned reward', async () => {
    const { customerId, rewardId, order } = await completedOrder();
    const seen: Array<Record<string, unknown>> = [];
    const listener = (payload: Record<string, unknown>) => seen.push(payload);
    eventBus.on(EventType.CHECKOUT_REFUNDED, listener);
    try {
      const refunded = await refundOrder(coffee.merchantId, order.id);

      expect(refunded.status).toBe(CheckoutStatus.REFUNDED);
      expect(refunded.reward?.state).toBe('reissued');
      expect(refunded.earned?.state).toBe('voided');
      expect(refunded.paypal.refundId).toMatch(/^REFUND-/);

      const [captureId, , opts] = holder.fake.callsTo('refundCapture')[0].args as [string, unknown, { requestId: string }];
      expect(captureId).toBe(order.paypal.captureId);
      expect(opts.requestId).toBe(`refund:${order.id}`);

      const row = await prisma.checkoutOrder.findUniqueOrThrow({ where: { id: order.id } });
      const reissued = await prisma.token.findUniqueOrThrow({ where: { id: row.reissuedTokenId! } });
      expect(reissued.id).not.toBe(rewardId);
      expect(reissued).toMatchObject({ customerId, merchantId: coffee.merchantId, status: TokenStatus.ACTIVE });
      expect(reissued.denomination.toFixed(2)).toBe('5.00');
      const check = await validationService.validate(reissued.id, { transactionAmount: 28, merchantId: coffee.merchantId }, true);
      expect(check).toMatchObject({ valid: true });

      expect((await prisma.token.findUniqueOrThrow({ where: { id: order.earned!.tokenId! } })).status).toBe(TokenStatus.VOIDED);
      expect(seen).toEqual([expect.objectContaining({ checkoutId: order.id, merchantId: coffee.merchantId })]);
    } finally {
      eventBus.off(EventType.CHECKOUT_REFUNDED, listener);
    }
  });

  it('still refunds when the earned reward was already spent, and keeps that reward', async () => {
    const { customerId, order } = await completedOrder();
    await redemptionService.redeem(order.earned!.tokenId!, {
      transactionAmount: 28, merchantId: coffee.merchantId, idempotencyKey: randomUUID(),
    }, { isSandbox: true, authenticatedCustomerId: customerId });

    const refunded = await refundOrder(coffee.merchantId, order.id);

    expect(refunded.status).toBe(CheckoutStatus.REFUNDED);
    expect(refunded.earned?.state).toBe('kept');
    expect(refunded.receipt).toContain('already used');
  });

  it('a PayPal webhook for the same refund does not give the reward back twice', async () => {
    const { order } = await completedOrder();
    const refunded = await refundOrder(coffee.merchantId, order.id);

    await applyRefund(order.id, { refundId: refunded.paypal.refundId!, status: 'COMPLETED', amount: '23.00' }, 'webhook');

    expect(await prisma.token.count({ where: { idempotencyKey: `reissue:${order.id}` } })).toBe(1);
  });

  it('a refund made in the PayPal dashboard arrives by webhook and refunds the order', async () => {
    const { order } = await completedOrder();

    const result = await receivePayPalWebhook({
      headers: {
        'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
        'paypal-transmission-id': randomUUID(), 'paypal-transmission-sig': 'c2ln', 'paypal-transmission-time': '2026-11-08T18:00:01Z',
      },
      body: {
        id: `WH-${randomUUID()}`,
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource_type: 'refund',
        summary: 'A $ 23.00 USD capture payment was refunded',
        resource: {
          id: `REFUND-DASH-${randomUUID().slice(0, 8)}`,
          status: 'COMPLETED',
          amount: { currency_code: 'USD', value: '23.00' },
          links: [
            { href: `https://api.sandbox.paypal.com/v2/payments/refunds/R1`, rel: 'self', method: 'GET' },
            { href: `https://api.sandbox.paypal.com/v2/payments/captures/${order.paypal.captureId}`, rel: 'up', method: 'GET' },
          ],
        },
      },
    });

    expect(result.httpStatus).toBe(200);
    expect(result.body.action).toBe('refunded');
    const row = await prisma.checkoutOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe(CheckoutStatus.REFUNDED);
    expect(row.reissuedTokenId).toBeTruthy();
  });

  it('waits for PayPal to finish a PENDING refund before giving the reward back', async () => {
    const { order } = await completedOrder();
    holder.fake.setRefundStatus('PENDING');

    const pending = await refundOrder(coffee.merchantId, order.id);
    expect(pending.status).toBe(CheckoutStatus.REFUND_PENDING);
    expect(await prisma.token.count({ where: { idempotencyKey: `reissue:${order.id}` } })).toBe(0);

    const done = await applyRefund(order.id, { refundId: pending.paypal.refundId!, status: 'COMPLETED', amount: '23.00' }, 'webhook');
    expect(done.status).toBe(CheckoutStatus.REFUNDED);
    expect(await prisma.token.count({ where: { idempotencyKey: `reissue:${order.id}` } })).toBe(1);
  });

  it('another store cannot refund the order', async () => {
    const { order } = await completedOrder();
    await expect(refundOrder(harbor.merchantId, order.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(holder.fake.callsTo('refundCapture')).toHaveLength(0);
  });

  it('only paid orders can be refunded', async () => {
    const customerId = await db.shopper();
    const open = await checkoutService.create(customerId, {
      productId: coffee.products.beans, quantity: 1, useReward: false, paymentMode: 'auto',
    }, { isSandbox: true, idempotencyKey: randomUUID() });

    await expect(refundOrder(coffee.merchantId, open.id)).rejects.toMatchObject({ statusCode: 409, code: 'not_refundable' });
  });

  it('refunding twice is harmless', async () => {
    const { order } = await completedOrder();
    await refundOrder(coffee.merchantId, order.id);
    const again = await refundOrder(coffee.merchantId, order.id);
    expect(again.status).toBe(CheckoutStatus.REFUNDED);
    expect(holder.fake.callsTo('refundCapture')).toHaveLength(1);
  });
});
