// The sweeper for abandoned checkouts, on a real Postgres and Redis.
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckoutStatus } from '@tokento/shared';
import { DbFixtures, prisma, type StoreFixture } from './helpers/db-fixtures';
import { createFakePayPal, type FakePayPal } from './helpers/fake-paypal-client';

const holder = vi.hoisted(() => ({ fake: undefined as unknown as FakePayPal }));
vi.mock('../src/checkout/paypal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/checkout/paypal')>();
  return { ...actual, getPayPal: () => holder.fake.client };
});

import { checkoutService } from '../src/checkout/checkout.service';
import { sweepCheckouts } from '../src/jobs/checkout-sweeper';

const db = new DbFixtures();
let coffee: StoreFixture;

async function abandonedOrder(minutesAgo: number) {
  const customerId = await db.shopper();
  const rewardId = await db.reward({ customerId, merchantId: coffee.merchantId, earnRuleId: coffee.ruleIds[0], denomination: 5, floor: 10 });
  const order = await checkoutService.create(customerId, {
    productId: coffee.products.beans, quantity: 1, useReward: true, paymentMode: 'auto',
  }, { isSandbox: true, idempotencyKey: randomUUID() });
  await prisma.checkoutOrder.update({ where: { id: order.id }, data: { createdAt: new Date(Date.now() - minutesAgo * 60_000) } });
  return { customerId, rewardId, order };
}

beforeAll(async () => {
  holder.fake = createFakePayPal();
  coffee = await db.store('Coffee Co. (sweeper test)', {
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

describe('checkout sweeper', () => {
  it('cancels an order nobody approved within 30 minutes and releases its reward', async () => {
    const { order } = await abandonedOrder(31);

    await sweepCheckouts({ merchantIds: [coffee.merchantId] });

    const row = await prisma.checkoutOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe(CheckoutStatus.CANCELLED);
    expect(row.rewardTokenId).toBeNull();
  });

  it('captures an order the shopper approved in PayPal but never came back to', async () => {
    const { order } = await abandonedOrder(31);
    holder.fake.approve(order.paypal.orderId!);

    await sweepCheckouts({ merchantIds: [coffee.merchantId] });

    expect((await prisma.checkoutOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(CheckoutStatus.COMPLETED);
  });

  it('leaves recent orders alone', async () => {
    const { order } = await abandonedOrder(5);

    await sweepCheckouts({ merchantIds: [coffee.merchantId] });

    expect((await prisma.checkoutOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(CheckoutStatus.CREATED);
    expect(holder.fake.callsTo('getOrder')).toHaveLength(0);
  });
});
