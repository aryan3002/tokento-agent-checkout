// Shopper checkout, catalog and store order routes over HTTP, on a real Postgres.
import express from 'express';
import request from 'supertest';
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

import checkoutRoutes from '../src/routes/checkout.routes';
import catalogRoutes from '../src/routes/catalog.routes';
import merchantRoutes from '../src/routes/merchant.routes';
import { errorHandler } from '../src/middleware/error.middleware';

const app = express();
app.use(express.json());
app.use('/api/v1/checkout', checkoutRoutes);
app.use('/api/v1/catalog', catalogRoutes);
app.use('/api/v1/merchants', merchantRoutes);
app.use(errorHandler());

const db = new DbFixtures();
let coffee: StoreFixture;
let harbor: StoreFixture;
let coffeeKey: string;
let harborKey: string;
const tag = randomUUID().slice(0, 6);

const as = (customerId: string) => ({ Authorization: `Bearer b2c_dev_session::${customerId}` });

async function shopperWithReward() {
  const customerId = await db.shopper();
  await db.reward({ customerId, merchantId: coffee.merchantId, earnRuleId: coffee.ruleIds[0], denomination: 5, floor: 10 });
  return customerId;
}

beforeAll(async () => {
  holder.fake = createFakePayPal();
  coffee = await db.store('Coffee Co. (routes test)', {
    rules: [{ name: 'Spend $20, Get $5 Off', spendThreshold: 20, tokenDenomination: 5, minimumTransactionFloor: 10 }],
    products: [{ key: 'beans', name: `Morning Ridge Blend medium roast ${tag}`, price: '28.00' }],
  });
  harbor = await db.store('Harbor (routes test)', {
    products: [
      { key: 'beans', name: `Harbor House medium roast ${tag}`, price: '25.00' },
      { key: 'mug', name: `Travel mug ${tag}`, price: '18.00', category: 'gear' },
    ],
  });
  coffeeKey = await db.apiKey(coffee.merchantId);
  harborKey = await db.apiKey(harbor.merchantId);
});

afterAll(async () => {
  await db.cleanup();
});

beforeEach(() => {
  holder.fake.reset();
});

describe('shopper checkout routes', () => {
  it('prices the order on the server and ignores amounts the client sends', async () => {
    const customerId = await shopperWithReward();

    const res = await request(app).post('/api/v1/checkout/orders').set(as(customerId)).set('Idempotency-Key', randomUUID())
      .send({ productId: coffee.products.beans, amountToPay: 1, subtotal: 1, rewardAmount: 27 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: CheckoutStatus.CREATED, subtotal: 28, amountToPay: 23 });
    const [input] = holder.fake.callsTo('createOrder')[0].args as [{ amount: string }];
    expect(input.amount).toBe('23.00');
  });

  it('requires an idempotency key to create an order', async () => {
    const customerId = await shopperWithReward();
    const res = await request(app).post('/api/v1/checkout/orders').set(as(customerId)).send({ productId: coffee.products.beans });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('idempotency_key_required');
  });

  it('requires a shopper session', async () => {
    const res = await request(app).post('/api/v1/checkout/quote').send({ productIds: [coffee.products.beans] });
    expect(res.status).toBe(401);
  });

  it('a shopper cannot read or cancel another shopper\'s order', async () => {
    const owner = await shopperWithReward();
    const stranger = await db.shopper();
    const created = await request(app).post('/api/v1/checkout/orders').set(as(owner)).set('Idempotency-Key', randomUUID())
      .send({ productId: coffee.products.beans });

    const read = await request(app).get(`/api/v1/checkout/orders/${created.body.id}`).set(as(stranger));
    const cancel = await request(app).post(`/api/v1/checkout/orders/${created.body.id}/cancel`).set(as(stranger));
    const own = await request(app).get(`/api/v1/checkout/orders/${created.body.id}`).set(as(owner));

    expect(read.status).toBe(403);
    expect(cancel.status).toBe(403);
    expect(own.status).toBe(200);
  });

  it('quotes, then captures after approval, then lists the shopper\'s orders', async () => {
    const customerId = await shopperWithReward();
    const quote = await request(app).post('/api/v1/checkout/quote').set(as(customerId))
      .send({ productIds: [harbor.products.beans, coffee.products.beans] });
    expect(quote.status).toBe(200);
    expect(quote.body.recommendedProductId).toBe(coffee.products.beans);

    const created = await request(app).post('/api/v1/checkout/orders').set(as(customerId)).set('Idempotency-Key', randomUUID())
      .send({ productId: quote.body.recommendedProductId, agentReason: quote.body.comparison });
    holder.fake.approve(created.body.paypal.orderId);
    const captured = await request(app).post(`/api/v1/checkout/orders/${created.body.id}/capture`).set(as(customerId));
    expect(captured.status).toBe(200);
    expect(captured.body.status).toBe(CheckoutStatus.COMPLETED);

    const list = await request(app).get('/api/v1/checkout/orders').set(as(customerId));
    expect(list.body.orders.map((o: { id: string }) => o.id)).toEqual([created.body.id]);
  });
});

describe('catalog search', () => {
  it('finds products across stores, with store names, filtered by price', async () => {
    const customerId = await db.shopper();

    const all = await request(app).get(`/api/v1/catalog/search?q=${encodeURIComponent(`medium roast ${tag}`)}`).set(as(customerId));
    expect(all.status).toBe(200);
    expect(all.body.products.map((p: { merchantName: string }) => p.merchantName).sort()).toEqual(['Coffee Co. (routes test)', 'Harbor (routes test)']);
    expect(all.body.products[0]).toEqual(expect.objectContaining({ productId: expect.any(String), price: expect.any(Number), category: 'coffee' }));

    const cheap = await request(app).get(`/api/v1/catalog/search?q=${tag}&maxPrice=26`).set(as(customerId));
    expect(cheap.body.products.map((p: { price: number }) => p.price).sort()).toEqual([18, 25]);
  });
});

describe('store order routes', () => {
  it('a store sees only its own agent orders', async () => {
    const customerId = await shopperWithReward();
    const created = await request(app).post('/api/v1/checkout/orders').set(as(customerId)).set('Idempotency-Key', randomUUID())
      .send({ productId: coffee.products.beans });

    const coffeeOrders = await request(app).get('/api/v1/merchants/me/orders').set('X-API-Key', coffeeKey);
    const harborOrders = await request(app).get('/api/v1/merchants/me/orders').set('X-API-Key', harborKey);

    expect(coffeeOrders.status).toBe(200);
    expect(coffeeOrders.body.orders.map((o: { id: string }) => o.id)).toContain(created.body.id);
    expect(harborOrders.body.orders.map((o: { id: string }) => o.id)).not.toContain(created.body.id);
  });

  it('only the store that was paid can refund an order', async () => {
    const customerId = await shopperWithReward();
    const created = await request(app).post('/api/v1/checkout/orders').set(as(customerId)).set('Idempotency-Key', randomUUID())
      .send({ productId: coffee.products.beans });
    holder.fake.approve(created.body.paypal.orderId);
    await request(app).post(`/api/v1/checkout/orders/${created.body.id}/capture`).set(as(customerId));

    const wrongStore = await request(app).post(`/api/v1/merchants/me/orders/${created.body.id}/refund`).set('X-API-Key', harborKey);
    const rightStore = await request(app).post(`/api/v1/merchants/me/orders/${created.body.id}/refund`).set('X-API-Key', coffeeKey);

    expect(wrongStore.status).toBe(404);
    expect(rightStore.status).toBe(200);
    expect(rightStore.body.status).toBe(CheckoutStatus.REFUNDED);
    expect((await prisma.checkoutOrder.findUniqueOrThrow({ where: { id: created.body.id } })).status).toBe(CheckoutStatus.REFUNDED);
  });
});
