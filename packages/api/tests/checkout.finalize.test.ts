// Capture and finalize against a real Postgres, with PayPal faked.
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
import { finalizeCapture } from '../src/checkout/finalize';
import { redemptionService } from '../src/services/redemption.service';
import { eventBus } from '../src/events/emitter';

const db = new DbFixtures();
let coffee: StoreFixture;
let keySeq = 0;
const key = () => `finalize-key-${Date.now()}-${keySeq++}`;
const run = Date.now().toString(36);
const captureId = (name: string) => `CAPTURE-${name}-${run}`;

async function shopperWithReward(opts: { expiresInDays?: number } = {}) {
  const customerId = await db.shopper();
  const rewardId = await db.reward({
    customerId, merchantId: coffee.merchantId, earnRuleId: coffee.ruleIds[0], denomination: 5, floor: 10,
    expiresInDays: opts.expiresInDays,
  });
  return { customerId, rewardId };
}

async function openOrder(customerId: string, productKey = 'beans', useReward = true) {
  return checkoutService.create(customerId, {
    productId: coffee.products[productKey], quantity: 1, useReward, paymentMode: 'auto',
  }, { isSandbox: true, idempotencyKey: key(), agentId: 'test-agent' });
}

function completedEvents() {
  const seen: Array<Record<string, unknown>> = [];
  const listener = (payload: Record<string, unknown>) => seen.push(payload);
  eventBus.on(EventType.CHECKOUT_COMPLETED, listener);
  return { seen, stop: () => eventBus.off(EventType.CHECKOUT_COMPLETED, listener) };
}

beforeAll(async () => {
  holder.fake = createFakePayPal();
  coffee = await db.store('Coffee Co. (finalize test)', {
    rules: [{ name: 'Spend $20, Get $5 Off', spendThreshold: 20, tokenDenomination: 5, minimumTransactionFloor: 10 }],
    products: [
      { key: 'beans', name: 'Morning Ridge Blend, 2 lb', price: '28.00' },
      { key: 'filters', name: 'Paper filters #4, 100 pack', price: '6.00', category: 'supplies' },
    ],
  });
});

afterAll(async () => {
  await db.cleanup();
});

beforeEach(() => {
  holder.fake.reset();
});

describe('capture', () => {
  it('captures an approved order, redeems the held reward once and issues the earned reward', async () => {
    const { customerId, rewardId } = await shopperWithReward();
    const events = completedEvents();
    try {
      const order = await openOrder(customerId);
      holder.fake.approve(order.paypal.orderId!);

      const done = await checkoutService.capture(order.id, { kind: 'customer', customerId });

      expect(done.status).toBe(CheckoutStatus.COMPLETED);
      expect(done.reward).toEqual({ tokenId: rewardId, amount: 5, state: 'redeemed' });
      expect(done.earned).toMatchObject({ amount: 5, state: 'issued' });
      expect(done.paypal.captureId).toMatch(/^CAPTURE-/);
      expect(done.platformFee).toBe(0.46); // 2% of $23.00

      const [, opts] = holder.fake.callsTo('captureOrder')[0].args as [string, { requestId: string }];
      expect(opts.requestId).toBe(`capture:${order.id}`);

      const redemption = await prisma.redemption.findUniqueOrThrow({ where: { tokenId: rewardId } });
      expect(redemption.transactionAmount.toFixed(2)).toBe('28.00');
      expect(redemption.netValue.toFixed(2)).toBe('23.00');
      expect((await prisma.token.findUniqueOrThrow({ where: { id: rewardId } })).status).toBe(TokenStatus.REDEEMED);

      const earned = await prisma.token.findUniqueOrThrow({ where: { id: done.earned!.tokenId! } });
      expect(earned).toMatchObject({ customerId, merchantId: coffee.merchantId, status: TokenStatus.ACTIVE, idempotencyKey: `earn:${order.id}` });
      expect(earned.denomination.toFixed(2)).toBe('5.00');

      expect(events.seen).toEqual([expect.objectContaining({ checkoutId: order.id, merchantId: coffee.merchantId })]);
    } finally {
      events.stop();
    }
  });

  it('a second capture call returns the finished order without capturing again', async () => {
    const { customerId } = await shopperWithReward();
    const order = await openOrder(customerId);
    holder.fake.approve(order.paypal.orderId!);

    await checkoutService.capture(order.id, { kind: 'customer', customerId });
    const again = await checkoutService.capture(order.id, { kind: 'customer', customerId });

    expect(again.status).toBe(CheckoutStatus.COMPLETED);
    expect(holder.fake.callsTo('captureOrder')).toHaveLength(1);
  });

  it('refuses to capture before the shopper approves in PayPal', async () => {
    const { customerId } = await shopperWithReward();
    const order = await openOrder(customerId);

    await expect(checkoutService.capture(order.id, { kind: 'customer', customerId }))
      .rejects.toMatchObject({ statusCode: 409, code: 'not_approved' });
    expect((await prisma.checkoutOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(CheckoutStatus.CREATED);
  });

  it('refuses to capture a cancelled order', async () => {
    const { customerId } = await shopperWithReward();
    const order = await openOrder(customerId);
    holder.fake.approve(order.paypal.orderId!);
    await checkoutService.cancel(customerId, order.id);

    await expect(checkoutService.capture(order.id, { kind: 'customer', customerId }))
      .rejects.toMatchObject({ statusCode: 409, code: 'not_capturable' });
    expect(holder.fake.callsTo('captureOrder')).toHaveLength(0);
  });

  it('treats ORDER_ALREADY_CAPTURED as success and reads the capture from PayPal', async () => {
    const { customerId } = await shopperWithReward();
    const order = await openOrder(customerId);
    holder.fake.approve(order.paypal.orderId!);
    // PayPal took the money but our first attempt never recorded it.
    await holder.fake.client.captureOrder(order.paypal.orderId!, { requestId: 'lost-response' });

    const done = await checkoutService.capture(order.id, { kind: 'customer', customerId });
    expect(done.status).toBe(CheckoutStatus.COMPLETED);
    expect(holder.fake.callsTo('getOrder')).toHaveLength(1);
  });
});

describe('finalizeCapture', () => {
  it('a webhook arriving after the capture changes nothing', async () => {
    const { customerId, rewardId } = await shopperWithReward();
    const order = await openOrder(customerId);
    holder.fake.approve(order.paypal.orderId!);
    const done = await checkoutService.capture(order.id, { kind: 'customer', customerId });

    const events = completedEvents();
    try {
      const again = await finalizeCapture(order.id, { captureId: done.paypal.captureId!, status: 'COMPLETED', amount: '23.00', currency: 'USD' }, 'webhook');
      expect(again).toMatchObject({ status: CheckoutStatus.COMPLETED, earned: { tokenId: done.earned!.tokenId } });
      expect(events.seen).toHaveLength(0);
      expect(await prisma.redemption.count({ where: { tokenId: rewardId } })).toBe(1);
      expect(await prisma.token.count({ where: { customerId, idempotencyKey: `earn:${order.id}` } })).toBe(1);
    } finally {
      events.stop();
    }
  });

  it('two finalizers racing (capture response and webhook) complete the order exactly once', async () => {
    const { customerId, rewardId } = await shopperWithReward();
    const order = await openOrder(customerId);
    const capture = { captureId: captureId('RACE'), status: 'COMPLETED' as const, amount: '23.00', currency: 'USD' };
    const events = completedEvents();
    try {
      const [a, b] = await Promise.all([
        finalizeCapture(order.id, capture, 'capture_response'),
        finalizeCapture(order.id, capture, 'webhook'),
      ]);
      expect(a.status).toBe(CheckoutStatus.COMPLETED);
      expect(b.status).toBe(CheckoutStatus.COMPLETED);
      expect(events.seen).toHaveLength(1);
      expect(await prisma.redemption.count({ where: { tokenId: rewardId } })).toBe(1);
      expect(await prisma.token.count({ where: { customerId, idempotencyKey: `earn:${order.id}` } })).toBe(1);
    } finally {
      events.stop();
    }
  });

  it('holds the order for review when PayPal captured a different amount, without redeeming or earning', async () => {
    const { customerId, rewardId } = await shopperWithReward();
    const order = await openOrder(customerId);

    const flagged = await finalizeCapture(order.id, { captureId: captureId('ODD'), status: 'COMPLETED', amount: '22.00', currency: 'USD' }, 'webhook');

    expect(flagged.status).toBe(CheckoutStatus.NEEDS_REVIEW);
    expect(flagged.note).toContain('22.00');
    expect(await prisma.redemption.count({ where: { tokenId: rewardId } })).toBe(0);
    expect(await prisma.token.count({ where: { customerId, idempotencyKey: `earn:${order.id}` } })).toBe(0);
    expect((await prisma.checkoutOrder.findUniqueOrThrow({ where: { id: order.id } })).rewardTokenId).toBe(rewardId);
  });

  it('waits when PayPal holds the capture as PENDING, then completes when it clears', async () => {
    const { customerId, rewardId } = await shopperWithReward();
    const order = await openOrder(customerId);

    const pending = await finalizeCapture(order.id, { captureId: captureId('PEND'), status: 'PENDING', amount: '23.00', currency: 'USD' }, 'capture_response');
    expect(pending.status).toBe(CheckoutStatus.CAPTURE_PENDING);
    expect(await prisma.redemption.count({ where: { tokenId: rewardId } })).toBe(0);

    const done = await finalizeCapture(order.id, { captureId: captureId('PEND'), status: 'COMPLETED', amount: '23.00', currency: 'USD' }, 'webhook');
    expect(done.status).toBe(CheckoutStatus.COMPLETED);
    expect(await prisma.redemption.count({ where: { tokenId: rewardId } })).toBe(1);
  });

  it('releases the hold when PayPal declines the capture', async () => {
    const { customerId } = await shopperWithReward();
    const order = await openOrder(customerId);

    const failed = await finalizeCapture(order.id, { captureId: captureId('DECL'), status: 'DECLINED', amount: '23.00', currency: 'USD' }, 'webhook');
    expect(failed.status).toBe(CheckoutStatus.FAILED);
    expect((await prisma.checkoutOrder.findUniqueOrThrow({ where: { id: order.id } })).rewardTokenId).toBeNull();
  });

  it('honours a held reward that expired while the shopper was approving', async () => {
    const { customerId, rewardId } = await shopperWithReward({ expiresInDays: 1.5 / 86_400 }); // 1.5 s
    const order = await openOrder(customerId);
    expect(order.reward?.tokenId).toBe(rewardId);
    await new Promise((resolve) => setTimeout(resolve, 1_700));

    const done = await finalizeCapture(order.id, { captureId: captureId('LATE'), status: 'COMPLETED', amount: '23.00', currency: 'USD' }, 'webhook');
    expect(done.status).toBe(CheckoutStatus.COMPLETED);
    expect(await prisma.redemption.count({ where: { tokenId: rewardId } })).toBe(1);
  });

  it('with no reward used, nothing is redeemed but the purchase still earns', async () => {
    const { customerId, rewardId } = await shopperWithReward();
    const order = await openOrder(customerId, 'beans', false);
    expect(order.amountToPay).toBe(28);

    const done = await finalizeCapture(order.id, { captureId: captureId('NR'), status: 'COMPLETED', amount: '28.00', currency: 'USD' }, 'webhook');
    expect(done.status).toBe(CheckoutStatus.COMPLETED);
    expect(done.reward).toBeNull();
    expect(done.earned).toMatchObject({ amount: 5, state: 'issued' });
    expect(await prisma.redemption.count({ where: { tokenId: rewardId } })).toBe(0);
  });

  it('issues nothing when the amount paid is under every earn threshold', async () => {
    const { customerId } = await shopperWithReward();
    const order = await openOrder(customerId, 'filters');
    expect(order).toMatchObject({ amountToPay: 6, reward: null, earned: null });

    const done = await finalizeCapture(order.id, { captureId: captureId('SMALL'), status: 'COMPLETED', amount: '6.00', currency: 'USD' }, 'webhook');
    expect(done).toMatchObject({ status: CheckoutStatus.COMPLETED, earned: null });
    expect(await prisma.token.count({ where: { customerId, idempotencyKey: `earn:${order.id}` } })).toBe(0);
  });
});

describe('held rewards and the Token Query Interface', () => {
  it('an agent cannot redeem a reward through the TQI while an order is holding it', async () => {
    const { customerId, rewardId } = await shopperWithReward();
    await openOrder(customerId);

    await expect(redemptionService.redeem(rewardId, {
      transactionAmount: 28, merchantId: coffee.merchantId, idempotencyKey: key(),
    }, { isSandbox: true, authenticatedCustomerId: customerId })).rejects.toMatchObject({ statusCode: 409, code: 'token_held' });
  });
});
