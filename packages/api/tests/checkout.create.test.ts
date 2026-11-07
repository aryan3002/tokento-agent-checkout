// Quote and checkout creation against a real Postgres, with PayPal faked.
// The reward hold is a database unique constraint, so it is tested for real.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckoutStatus, EventType } from '@tokento/shared';
import { DbFixtures, prisma, type StoreFixture } from './helpers/db-fixtures';
import { createFakePayPal, type FakePayPal } from './helpers/fake-paypal-client';

const holder = vi.hoisted(() => ({ fake: undefined as unknown as FakePayPal }));
vi.mock('../src/checkout/paypal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/checkout/paypal')>();
  return { ...actual, getPayPal: () => holder.fake.client };
});

import { checkoutService } from '../src/checkout/checkout.service';
import { quoteService } from '../src/checkout/quote.service';
import { mandateService } from '../src/mandates/mandate.service';
import { eventBus } from '../src/events/emitter';

const db = new DbFixtures();
let coffee: StoreFixture;
let ridgeline: StoreFixture;
let harbor: StoreFixture;

/** A fresh shopper with Maya's starting rewards: $5 at Coffee Co., $3 at Ridgeline (needs a $30 order). */
async function newShopper() {
  const customerId = await db.shopper();
  const coffeeReward = await db.reward({ customerId, merchantId: coffee.merchantId, earnRuleId: coffee.ruleIds[0], denomination: 5, floor: 10 });
  const ridgelineReward = await db.reward({ customerId, merchantId: ridgeline.merchantId, earnRuleId: ridgeline.ruleIds[1], denomination: 3, floor: 30 });
  return { customerId, coffeeReward, ridgelineReward };
}

let keySeq = 0;
const key = () => `test-key-${Date.now()}-${keySeq++}`;

beforeAll(async () => {
  holder.fake = createFakePayPal();
  coffee = await db.store('Coffee Co. (test)', {
    rules: [{ name: 'Spend $20, Get $5 Off', spendThreshold: 20, tokenDenomination: 5, minimumTransactionFloor: 10 }],
    products: [
      { key: 'beans', name: 'Morning Ridge Blend, medium roast, whole bean, 2 lb', price: '28.00' },
      { key: 'filters', name: 'Paper filters #4, 100 pack', price: '6.00', category: 'supplies' },
    ],
  });
  ridgeline = await db.store('Ridgeline Roasters (test)', {
    rules: [
      { name: 'Spend $25, Get $2 Off', spendThreshold: 25, tokenDenomination: 2 },
      { name: 'Spend $40, Get $3 Off', spendThreshold: 40, tokenDenomination: 3, minimumTransactionFloor: 30 },
    ],
    products: [{ key: 'beans', name: 'Summit Medium Roast, whole bean, 2 lb', price: '26.50' }],
  });
  harbor = await db.store('Harbor Bean Supply (test)', {
    products: [{ key: 'beans', name: 'Harbor House Medium Roast, whole bean, 2 lb', price: '25.00' }],
  });
});

afterAll(async () => {
  await db.cleanup();
});

beforeEach(() => {
  holder.fake.reset();
  vi.restoreAllMocks();
});

describe('quote', () => {
  it('ranks the stores by total value and recommends Coffee Co. over the cheaper sticker price', async () => {
    const { customerId, coffeeReward } = await newShopper();

    const quote = await quoteService.quote(customerId, {
      productIds: [harbor.products.beans, ridgeline.products.beans, coffee.products.beans],
    }, true);

    expect(quote.offers.map((o) => o.merchantId)).toEqual([coffee.merchantId, ridgeline.merchantId, harbor.merchantId]);
    expect(quote.offers[0]).toMatchObject({
      subtotal: 28,
      reward: { tokenId: coffeeReward, amount: 5 },
      amountToPay: 23,
      earn: { amount: 5 },
      effectiveCost: 18,
      // No limits set: reported, so the agent knows each payment needs her PayPal approval.
      mandate: { within: false, code: 'no_mandate' },
    });
    expect(quote.offers[1]).toMatchObject({ amountToPay: 26.5, reward: null, earn: { amount: 2 }, effectiveCost: 24.5 });
    expect(quote.offers[2]).toMatchObject({ amountToPay: 25, reward: null, earn: null, effectiveCost: 25 });
    expect(quote.recommendedProductId).toBe(coffee.products.beans);
    expect(quote.comparison).toContain('Coffee Co. (test)');
    expect(quote.offers[0].reason).toContain('$23.00');
  });

  it('flags offers over the shopper budget', async () => {
    const { customerId } = await newShopper();

    const quote = await quoteService.quote(customerId, {
      productIds: [coffee.products.beans, ridgeline.products.beans, harbor.products.beans],
      maxAmountToPay: 24,
    }, true);

    const byStore = Object.fromEntries(quote.offers.map((o) => [o.merchantId, o.withinBudget]));
    expect(byStore).toEqual({ [coffee.merchantId]: true, [ridgeline.merchantId]: false, [harbor.merchantId]: false });
  });
});

describe('checkout create', () => {
  it('prices on the server, holds the reward and asks PayPal for the discounted amount', async () => {
    const { customerId, coffeeReward } = await newShopper();

    const order = await checkoutService.create(customerId, {
      productId: coffee.products.beans, quantity: 1, useReward: true, paymentMode: 'auto', agentReason: 'Best total value',
    }, { isSandbox: true, idempotencyKey: key(), agentId: 'test-agent' });

    expect(order.status).toBe(CheckoutStatus.CREATED);
    expect(order.amountToPay).toBe(23);
    expect(order.reward).toEqual({ tokenId: coffeeReward, amount: 5, state: 'held' });
    expect(order.earned).toMatchObject({ amount: 5, state: 'expected' });
    expect(order.paypal.approvalUrl).toContain('checkoutnow?token=');

    const row = await prisma.checkoutOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.rewardTokenId).toBe(coffeeReward);
    expect(row.paypalOrderId).toBe(order.paypal.orderId);

    const [input, opts] = holder.fake.callsTo('createOrder')[0].args as [any, any];
    expect(opts.requestId).toBe(order.id);
    expect(input).toMatchObject({
      customId: order.id,
      amount: '23.00',
      currency: 'USD',
      breakdown: { itemTotal: '28.00', discount: '5.00' },
      items: [{ quantity: 1, unitAmount: '28.00' }],
      payment: { kind: 'approval' },
    });
  });

  it('returns the same order for a repeated idempotency key and calls PayPal once', async () => {
    const { customerId } = await newShopper();
    const idempotencyKey = key();
    const input = { productId: coffee.products.beans, quantity: 1, useReward: true, paymentMode: 'auto' as const };

    const first = await checkoutService.create(customerId, input, { isSandbox: true, idempotencyKey });
    const second = await checkoutService.create(customerId, input, { isSandbox: true, idempotencyKey });

    expect(second.id).toBe(first.id);
    expect(holder.fake.callsTo('createOrder')).toHaveLength(1);
  });

  it('does not let a second order use a reward that an open order is holding', async () => {
    const { customerId } = await newShopper();
    await checkoutService.create(customerId, { productId: coffee.products.beans, quantity: 1, useReward: true, paymentMode: 'auto' }, { isSandbox: true, idempotencyKey: key() });

    const quote = await quoteService.quote(customerId, { productIds: [coffee.products.beans] }, true);
    expect(quote.offers[0]).toMatchObject({ reward: null, amountToPay: 28 });

    const second = await checkoutService.create(customerId, { productId: coffee.products.beans, quantity: 1, useReward: true, paymentMode: 'auto' }, { isSandbox: true, idempotencyKey: key() });
    expect(second.reward).toBeNull();
    expect(second.amountToPay).toBe(28);
  });

  it('marks the order FAILED, releases the hold and answers 502 when PayPal cannot create the order', async () => {
    const { customerId, coffeeReward } = await newShopper();
    holder.fake.failNext('createOrder');
    const idempotencyKey = key();

    await expect(checkoutService.create(customerId, {
      productId: coffee.products.beans, quantity: 1, useReward: true, paymentMode: 'auto',
    }, { isSandbox: true, idempotencyKey })).rejects.toMatchObject({ statusCode: 502, code: 'paypal_unavailable' });

    const row = await prisma.checkoutOrder.findFirstOrThrow({ where: { customerId, idempotencyKey } });
    expect(row.status).toBe(CheckoutStatus.FAILED);
    expect(row.rewardTokenId).toBeNull();

    const quote = await quoteService.quote(customerId, { productIds: [coffee.products.beans] }, true);
    expect(quote.offers[0].reward?.tokenId).toBe(coffeeReward);
  });

  it('refuses an order outside the mandate unless the shopper will approve it in PayPal', async () => {
    const { customerId } = await newShopper();
    vi.spyOn(mandateService, 'evaluate').mockResolvedValue({
      within: false, code: 'over_per_purchase_max', message: 'Over the $20.00 per-purchase limit.', mandate: null,
    });

    await expect(checkoutService.create(customerId, {
      productId: coffee.products.beans, quantity: 1, useReward: true, paymentMode: 'auto',
    }, { isSandbox: true, idempotencyKey: key() })).rejects.toMatchObject({
      statusCode: 403, code: 'mandate_violation', details: { mandateCode: 'over_per_purchase_max' },
    });
    expect(holder.fake.callsTo('createOrder')).toHaveLength(0);

    const approved = await checkoutService.create(customerId, {
      productId: coffee.products.beans, quantity: 1, useReward: true, paymentMode: 'approval',
    }, { isSandbox: true, idempotencyKey: key() });
    expect(approved.outsideMandate).toBe(true);
    expect(approved.paymentMode).toBe('approval');
    expect(approved.status).toBe(CheckoutStatus.CREATED);
  });

  it('rejects an unknown product with 404', async () => {
    const { customerId } = await newShopper();
    await expect(checkoutService.create(customerId, {
      productId: '99999999-9999-4999-8999-999999999999', quantity: 1, useReward: true, paymentMode: 'auto',
    }, { isSandbox: true, idempotencyKey: key() })).rejects.toMatchObject({ statusCode: 404, code: 'product_not_found' });
  });

  it('announces the new order on the event bus with its merchant id', async () => {
    const { customerId } = await newShopper();
    const seen: Array<Record<string, unknown>> = [];
    const listener = (payload: Record<string, unknown>) => seen.push(payload);
    eventBus.on(EventType.CHECKOUT_CREATED, listener);
    try {
      const order = await checkoutService.create(customerId, {
        productId: coffee.products.beans, quantity: 1, useReward: true, paymentMode: 'auto',
      }, { isSandbox: true, idempotencyKey: key() });
      expect(seen).toEqual([expect.objectContaining({ merchantId: coffee.merchantId, checkoutId: order.id, amountToPay: 23 })]);
    } finally {
      eventBus.off(EventType.CHECKOUT_CREATED, listener);
    }
  });
});

describe('checkout cancel and access', () => {
  it('cancelling before capture frees the reward for the next quote, and cancelling twice is harmless', async () => {
    const { customerId, coffeeReward } = await newShopper();
    const order = await checkoutService.create(customerId, {
      productId: coffee.products.beans, quantity: 1, useReward: true, paymentMode: 'auto',
    }, { isSandbox: true, idempotencyKey: key() });

    const cancelled = await checkoutService.cancel(customerId, order.id);
    expect(cancelled.status).toBe(CheckoutStatus.CANCELLED);
    expect((await prisma.checkoutOrder.findUniqueOrThrow({ where: { id: order.id } })).rewardTokenId).toBeNull();

    const quote = await quoteService.quote(customerId, { productIds: [coffee.products.beans] }, true);
    expect(quote.offers[0].reward?.tokenId).toBe(coffeeReward);

    await expect(checkoutService.cancel(customerId, order.id)).resolves.toMatchObject({ status: CheckoutStatus.CANCELLED });
  });

  it('only the shopper and the store can read an order', async () => {
    const { customerId } = await newShopper();
    const stranger = await db.shopper();
    const order = await checkoutService.create(customerId, {
      productId: coffee.products.beans, quantity: 1, useReward: true, paymentMode: 'auto',
    }, { isSandbox: true, idempotencyKey: key() });

    await expect(checkoutService.get(order.id, { kind: 'customer', customerId: stranger })).rejects.toMatchObject({ statusCode: 403 });
    await expect(checkoutService.get(order.id, { kind: 'merchant', merchantId: harbor.merchantId })).rejects.toMatchObject({ statusCode: 403 });
    await expect(checkoutService.cancel(stranger, order.id)).rejects.toMatchObject({ statusCode: 403 });
    await expect(checkoutService.get(order.id, { kind: 'customer', customerId })).resolves.toMatchObject({ id: order.id });
    await expect(checkoutService.get(order.id, { kind: 'merchant', merchantId: coffee.merchantId })).resolves.toMatchObject({ id: order.id });
  });
});
